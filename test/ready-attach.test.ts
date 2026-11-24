// web 终端 attach 探测（2026-11-10 P1 起；A-P2-3，R2-F 改 fail-closed）。
// 背景：herdr 的 `agent attach <pane>` 只认 pane 上有被识别的 agent——裸 shell
// 会话 attach 时 PTY 秒死。R1-F 曾在 attach 路径上「预热自愈」（裸 shell 先走
// 就绪派发拉起 agent 再附着），但包内 agentAtPaneOf 把「pane.list 查询失败」与
// 「pane 上无 agent」合并成同一个空串（dist/index.js 三连 return ""，签名
// Promise<string> 无错误通道），单次瞬时失败就会对在跑 agent 敲启动键
// （R2-X3-D 实证）。R2-F 起 fail-closed：只有确认 agent 在位才附着，其余一律
// 透传 attach 首闸报错（真裸 shell 收「pane 未就绪——派发链路会自愈拉起」），
// attach 路径不再产生任何按键。本文件钉住：预热按键在 herdr attach 路径上
// 彻底绝迹。

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok, type Result } from '../src/platform/shared/result.ts';
import type { PtySession, TmuxClient, TmuxSessionInfo } from '@juli-os/agents';
import { configSchema, type Config } from '../src/platform/config/schema.ts';
import { parseTenantDecls } from '../src/platform/config/tenants.ts';
import { createReadyAttach, createTenantTerminalRouter, serializeProvision } from '../src/runtime.ts';

type FakeCall = { readonly method: string; readonly args: unknown[] };
type FakeTerminal = TmuxClient & { readonly calls: readonly FakeCall[] };

/** 假终端的 agent 在位探测面（A-P2-3 判据：包内 herdr client 的 paneIdOf /
 * agentAtPaneOf）。缺省按 foreground 推：会话在 = pane 可解析；前台是 claude/
 * codex = herdr 认得出 agent，其余（zsh 等）= pane 上没有 agent。
 *   paneLost       这些会话的 paneIdOf 回空串（探测失败）；
 *   agentAt        按会话覆写 agentAtPaneOf（含显式空串——模拟 pane.list 瞬时失败）；
 *   agentAtThrows  这些会话的 agentAtPaneOf 抛错（探测异常）；
 *   omitProbe      终端上根本没有探测方法（结构外的终端）。 */
interface FakeProbe {
  readonly paneLost?: readonly string[];
  readonly agentAt?: Readonly<Record<string, string>>;
  readonly agentAtThrows?: readonly string[];
  readonly omitProbe?: boolean;
}

/** 录调假终端：foreground 给出各会话的前台进程名（缺省=会话不存在）。
 * 'zsh' = 裸 shell（agent 未在位），'claude' = agent 在位。 */
const makeFakeTerminal = (foreground: Readonly<Record<string, string>> = {}, probe: FakeProbe = {}): FakeTerminal => {
  const calls: FakeCall[] = [];
  const rec = (method: string, args: unknown[]): void => { calls.push({ method, args }); };
  const has = (n: string): boolean => n in foreground;
  const detail = (name: string): TmuxSessionInfo => ({ name, attached: false, path: `/w/${name}`, cmd: foreground[name] ?? '' });
  const probeFace = probe.omitProbe === true ? {} : {
    paneIdOf: async (n: string): Promise<string> => {
      rec('paneIdOf', [n]);
      return has(n) && !(probe.paneLost ?? []).includes(n) ? `pane-of-${n}` : '';
    },
    agentAtPaneOf: async (n: string): Promise<string> => {
      rec('agentAtPaneOf', [n]);
      if ((probe.agentAtThrows ?? []).includes(n)) throw new Error('pane.list blew up');
      const override = probe.agentAt?.[n];
      if (override !== undefined) return override;
      const fg = foreground[n] ?? '';
      return fg === 'claude' || fg === 'codex' ? fg : '';
    },
  };
  const terminal: TmuxClient = {
    hasSession: async (n) => { rec('hasSession', [n]); return has(n); },
    sendKey: async (n, key) => { rec('sendKey', [n, key]); return ok(undefined); },
    foregroundCommandOf: async (n) => { rec('foregroundCommandOf', [n]); return foreground[n] ?? ''; },
    panePathOf: async (n) => { rec('panePathOf', [n]); return has(n) ? `/w/${n}` : ''; },
    sessionBirthsOf: async () => { rec('sessionBirthsOf', []); return new Map(); },
    setEnv: async (vars) => { rec('setEnv', [vars]); return ok(undefined); },
    listSessions: async () => { rec('listSessions', []); return Object.keys(foreground); },
    listSessionsDetailed: async () => { rec('listSessionsDetailed', []); return ok(Object.keys(foreground).map(detail)); },
    newSession: async (n) => { rec('newSession', [n]); return ok(undefined); },
    sendText: async (n, text) => { rec('sendText', [n, text]); return ok(undefined); },
    sendTextConfirmed: async (n, text) => { rec('sendTextConfirmed', [n, text]); return ok({ enters: 1, repasted: false, elapsedMs: 1 }); },
    sendTextQueued: async (n, text) => { rec('sendTextQueued', [n, text]); return ok({ enters: 1, repasted: false, finalState: 'in_box', elapsedMs: 1 }); },
    capturePane: async (n, lines) => {
      rec('capturePane', [n, lines]);
      return has(n) ? ok(`pane of ${n}\n❯ `) : err(new Error(`会话 ${n} 不存在`));
    },
    killSession: async (n) => { rec('killSession', [n]); return ok(undefined); },
    interrupt: async (n) => { rec('interrupt', [n]); return ok(undefined); },
  };
  return { ...terminal, ...probeFace, calls };
};

const callsOf = (fake: FakeTerminal, method: string): readonly FakeCall[] =>
  fake.calls.filter((c) => c.method === method);

const fakePty = (): PtySession => ({ write: () => undefined, kill: () => undefined, exit: new Promise<number>(() => undefined) });

/** 录调 attach（fail-closed 下 ready-attach 不再持有 provision——预热按键在该
 * 路径上无入口，本组用例以「attach 透传 + 终端零按键」为准绳）。 */
const makeHarness = () => {
  const trace: string[] = [];
  const attach = async (session: string): Promise<Result<PtySession, Error>> => {
    trace.push(`attach:${session}`);
    return ok(fakePty());
  };
  return { trace, attach };
};

describe('createReadyAttach：fail-closed——只有确认 agent 在位才附着，绝不预热按键', () => {
  it('agent 已在位：直接附着（探测非空串才放行）', async () => {
    const h = makeHarness();
    const terminal = makeFakeTerminal({ 'team-web': 'claude' });
    const attach = createReadyAttach({ kind: 'herdr', terminal, attach: h.attach });
    const r = await attach('team-web', {}, undefined);
    expect(r.ok).toBe(true);
    expect(h.trace).toEqual(['attach:team-web']);
    expect(callsOf(terminal, 'sendText')).toEqual([]);
    expect(callsOf(terminal, 'sendTextConfirmed')).toEqual([]);
  });

  it('裸 shell（agentAt 空串）：不预热——R1-F 的自愈预热已关，透传 attach 由首闸报错', async () => {
    const h = makeHarness();
    const logs: string[] = [];
    const terminal = makeFakeTerminal({ 'team-research-cases': 'zsh' });
    const attach = createReadyAttach({ kind: 'herdr', terminal, attach: h.attach, log: (m) => logs.push(m) });
    const r = await attach('team-research-cases', {}, undefined);
    expect(r.ok).toBe(true);
    expect(h.trace).toEqual(['attach:team-research-cases']);
    // 终端零按键：启动命令/回车绝不从这个路径落进 pane。
    expect(callsOf(terminal, 'sendText')).toEqual([]);
    expect(callsOf(terminal, 'sendTextConfirmed')).toEqual([]);
    expect(callsOf(terminal, 'sendKey')).toEqual([]);
    expect(callsOf(terminal, 'newSession')).toEqual([]);
    expect(logs.join('\n')).toContain('fail-closed');
  });

  it('R2 残留洞形态：paneIdOf 命中、agentAtPaneOf 空串（在跑 agent 遇单次 pane.list 失败）——不预热，终端零按键', async () => {
    // 前台是 claude（agent 在跑），但 agentAtPaneOf 回空串=查询失败——R1-F
    // 三态判据会把这当「裸 shell」预热；fail-closed 下与真裸 shell 同判。
    const h = makeHarness();
    const terminal = makeFakeTerminal(
      { 'team-research-cases': 'claude' },
      { agentAt: { 'team-research-cases': '' } },
    );
    const attach = createReadyAttach({ kind: 'herdr', terminal, attach: h.attach });
    const r = await attach('team-research-cases', {}, undefined);
    expect(r.ok).toBe(true);
    expect(h.trace).toEqual(['attach:team-research-cases']);
    expect(callsOf(terminal, 'sendText')).toEqual([]);
    expect(callsOf(terminal, 'sendTextConfirmed')).toEqual([]);
    expect(callsOf(terminal, 'sendKey')).toEqual([]);
  });

  it('探测抛错（agentAtPaneOf rejection）同样不预热——空串按未知处理', async () => {
    const h = makeHarness();
    const terminal = makeFakeTerminal(
      { 'team-research-cases': 'claude' },
      { agentAtThrows: ['team-research-cases'] },
    );
    const attach = createReadyAttach({ kind: 'herdr', terminal, attach: h.attach });
    const r = await attach('team-research-cases', {}, undefined);
    expect(r.ok).toBe(true);
    expect(h.trace).toEqual(['attach:team-research-cases']);
    expect(callsOf(terminal, 'sendText')).toEqual([]);
    expect(callsOf(terminal, 'sendKey')).toEqual([]);
  });

  it('pane 探测失败（paneIdOf 空串）不预热——按键会落到 pane 上真实的东西', async () => {
    const h = makeHarness();
    const terminal = makeFakeTerminal({ 'team-research-cases': 'zsh' }, { paneLost: ['team-research-cases'] });
    const attach = createReadyAttach({ kind: 'herdr', terminal, attach: h.attach });
    const r = await attach('team-research-cases', {}, undefined);
    expect(r.ok).toBe(true);
    expect(h.trace).toEqual(['attach:team-research-cases']);
    expect(callsOf(terminal, 'sendText')).toEqual([]);
    expect(callsOf(terminal, 'sendTextConfirmed')).toEqual([]);
  });

  it('终端没有探测面（方法缺位，如 tmux 形态的结构外终端）同样不预热', async () => {
    const h = makeHarness();
    const terminal = makeFakeTerminal({ 'team-research-cases': 'zsh' }, { omitProbe: true });
    const attach = createReadyAttach({ kind: 'herdr', terminal, attach: h.attach });
    const r = await attach('team-research-cases', {}, undefined);
    expect(r.ok).toBe(true);
    expect(h.trace).toEqual(['attach:team-research-cases']);
  });

  it('agent 在位但前台是子 shell（agent 正跑 Bash）直接附着——判据不受前台进程名影响', async () => {
    const h = makeHarness();
    const terminal = makeFakeTerminal(
      { 'team-research-cases': 'zsh' },
      { agentAt: { 'team-research-cases': 'claude' } },
    );
    const attach = createReadyAttach({ kind: 'herdr', terminal, attach: h.attach });
    const r = await attach('team-research-cases', {}, undefined);
    expect(r.ok).toBe(true);
    expect(h.trace).toEqual(['attach:team-research-cases']);
    expect(callsOf(terminal, 'sendText')).toEqual([]);
  });

  it('会话不存在：原样透传，attach 首闸报「不存在」', async () => {
    const h = makeHarness();
    const terminal = makeFakeTerminal({});
    const attach = createReadyAttach({ kind: 'herdr', terminal, attach: h.attach });
    await attach('ghost', {}, undefined);
    expect(h.trace).toEqual(['attach:ghost']);
    expect(callsOf(terminal, 'newSession')).toEqual([]);
  });

  it('tmux 后端：原样透传（tmux attach 不依赖 agent 在位，行为零变化）', async () => {
    const h = makeHarness();
    const attach = createReadyAttach({
      kind: 'tmux', terminal: makeFakeTerminal({ 'juli-dev': 'zsh' }),
      attach: h.attach,
    });
    await attach('juli-dev', {}, undefined);
    expect(h.trace).toEqual(['attach:juli-dev']);
  });
});

describe('serializeProvision（A-P2-2：任务派发与启动预热共用一层启动互斥）', () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('同会话并发：后到的等先到的落地才进包内逻辑（boot 不会敲两遍）', async () => {
    const trace: string[] = [];
    const raw = async (source: string, session: string): Promise<Result<void, Error>> => {
      trace.push(`start:${session}:${source}`);
      await sleep(30);
      trace.push(`end:${session}`);
      return ok(undefined);
    };
    const p = serializeProvision(raw);
    await Promise.all([p('dispatch', 's1', 't1'), p('attach-warmup', 's1', '')]);
    expect(trace).toEqual([
      'start:s1:dispatch', 'end:s1',
      'start:s1:attach-warmup', 'end:s1',
    ]);
  });

  it('不同会话并行（互斥只按会话），在途登记收尾清空', async () => {
    const trace: string[] = [];
    const raw = async (source: string, session: string): Promise<Result<void, Error>> => {
      trace.push(`start:${session}:${source}`);
      await sleep(30);
      trace.push(`end:${session}`);
      return ok(undefined);
    };
    const p = serializeProvision(raw);
    const a = p('dispatch', 's1', 't1');
    await sleep(5);
    const b = p('dispatch', 's2', 't2');
    await Promise.all([a, b]);
    expect(trace[0]).toBe('start:s1:dispatch');
    expect(trace[1]).toBe('start:s2:dispatch');
    expect(trace.filter((t) => t.startsWith('start:'))).toHaveLength(2);
    // 串行链不滞留：清空后再来一轮，不排队在已经结束的 promise 后面。
    await p('attach-warmup', 's3', '');
    expect(trace.at(-1)).toBe('end:s3');
  });

  it('前一个失败不阻塞后一个（链上归零）', async () => {
    const trace: string[] = [];
    let fail = true;
    const p = serializeProvision(async (source, _session): Promise<Result<void, Error>> => {
      trace.push(`run:${source}`);
      if (fail) throw new Error('first blew up');
      return ok(undefined);
    });
    const a = p('dispatch', 's1', '');
    await expect(a).rejects.toThrow('first blew up');
    fail = false;
    const b = p('attach-warmup', 's1', '');
    expect((await b).ok).toBe(true);
    expect(trace).toEqual(['run:dispatch', 'run:attach-warmup']);
  });
});

describe('createReadyAttach × 租户路由：agent 在位探测不越租户，且不预热', () => {
  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });
  const twoTenantCfg = (): Config => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-ready-attach-'));
    tmpDirs.push(dir);
    return configSchema.parse({
      data_dir: dir,
      agent_backend: 'herdr',
      default_session: 'juli-reply',
      agents: [
        { session: 'juli-reply', company: 'juli', domain: 'reply' },
        { session: 'team-research-cases', company: 'acme', domain: 'cases' },
      ],
      tenants: [
        { id: 'internal', name: 'juli Labs', agents: ['juli-reply'], default_session: 'juli-reply', herdr_session: 'juli' },
        { id: 'acme', name: 'Meridian', agents: ['team-research-cases'], default_session: 'team-research-cases', herdr_session: '' },
      ],
    });
  };

  it('acme 会话的存在性/裸 shell 探测只落 acme 租户终端，internal 零触达；不预热', async () => {
    const cfg = twoTenantCfg();
    const decls = parseTenantDecls(cfg);
    if (!decls.ok) throw new Error(decls.error);
    const internal = makeFakeTerminal({ 'juli-reply': 'claude' });
    const acme = makeFakeTerminal({ 'team-research-cases': 'zsh' });
    const { terminal } = createTenantTerminalRouter({
      table: decls.table, dataDir: cfg.data_dir, terminals: { internal, acme },
    });
    const h = makeHarness();
    const attach = createReadyAttach({ kind: 'herdr', terminal, attach: h.attach });

    const r = await attach('team-research-cases', {}, undefined);
    expect(r.ok).toBe(true);
    // fail-closed：agentAt 空串 → 无预热，透传 attach。
    expect(h.trace).toEqual(['attach:team-research-cases']);
    expect(callsOf(acme, 'hasSession').map((c) => c.args[0])).toEqual(['team-research-cases']);
    // A-P2-3 判据：存在性与 agent 在位探测都只到属主租户（此前是 foregroundCommandOf）。
    expect(callsOf(acme, 'paneIdOf').map((c) => c.args[0])).toEqual(['team-research-cases']);
    expect(callsOf(acme, 'agentAtPaneOf').map((c) => c.args[0])).toEqual(['team-research-cases']);
    expect(internal.calls).toEqual([]);
  });
});
