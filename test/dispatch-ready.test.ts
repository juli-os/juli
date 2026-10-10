// 就绪派发契约测试：任务只在 agent 就绪后发出——裸 shell 拉起并等 REPL、
// 信任对话框安全接受、选择菜单按默认项同意（0921 裁定：审核面在 juli 闸门）、超时拒派；任何失败任务文本都不出手。

import { describe, expect, it } from 'vitest';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createProvisioningDispatch } from '../src/platform/agents/dispatch.ts';
import type { TmuxClient } from '../src/platform/agents/tmux.ts';
import { ok } from '../src/platform/shared/result.ts';

/** 脚本化假 tmux：pane 快照与前台命令都随【按键】推进（发 boot 后才变
 * node/就绪画面），probe 只读不推进——与真实 pane 语义一致。
 * hasSession 是布尔语义（与 TmuxClient 接口一致，非 Result）。 */
const makeTmux = (
  panes: string[],
  cmd: string | { before: string; after: string },
) => {
  const sent: string[] = [];
  const curCmd = (): string => typeof cmd === 'string'
    ? cmd
    : (sent.length > 0 ? cmd.after : cmd.before);
  const tmux: TmuxClient = {
    exec: async () => ok(curCmd()),
    hasSession: async () => true,
    newSession: async () => ok(undefined),
    killSession: async () => ok(undefined),
    interrupt: async () => ok(undefined),
    listSessions: async () => ok([]),
    capturePane: async () => ok(panes[Math.min(sent.length, panes.length - 1)] ?? ''),
    sendText: async (_name: string, text: string) => {
      sent.push(text);
      return ok(undefined);
    },
    // 确认式发送：测试桩按「发出即确认」语义推进（capturePane 随 sent 推进）。
    sendTextConfirmed: async (_name: string, text: string) => {
      sent.push(text);
      return ok(undefined);
    },
  } as unknown as TmuxClient;
  return { tmux, sent };
};

const READY = ['✳ Nesting… (stop hooks…)\n\n❯'];
const SHELL = ['last login: …\nuser@mac ~ %'];

describe('createProvisioningDispatch（就绪派发）', () => {
  it('agent 已就绪 → 直接派发，零额外动作', async () => {
    const { tmux, sent } = makeTmux(READY, 'node');
    const dispatch = createProvisioningDispatch({ tmux });
    const r = await dispatch('email', 's1', 'TASK');
    expect(r.ok).toBe(true);
    expect(sent).toEqual(['TASK']); // 没有 boot、没有多余按键
  });

  it('裸 shell → 拉起 claude 并等到就绪后才发任务', async () => {
    // 前台命令 zsh（裸 shell）；发 boot 后切 node、pane 变就绪画面。
    const { tmux, sent } = makeTmux(READY, { before: 'zsh', after: 'node' });
    const dispatch = createProvisioningDispatch({
      tmux, bootCommand: 'claude', pollMs: 1, sleep: async () => undefined,
    });
    const r = await dispatch('email', 's1', 'TASK');
    expect(r.ok).toBe(true);
    expect(sent[0]).toBe('claude'); // 先拉起
    expect(sent[sent.length - 1]).toBe('TASK'); // 任务最后才发
  });

  it('选择菜单（权限/模型/部署确认）→ 按默认项 Enter 同意后派发（juli 闸门已审，0921 裁定）', async () => {
    const menu = '1. 批准部署（推荐）\n  2. 暂不部署\nEnter to select · ❯ 1';
    const { tmux, sent } = makeTmux([menu, READY[0]!], 'node');
    const dispatch = createProvisioningDispatch({ tmux, pollMs: 1, sleep: async () => undefined });
    const r = await dispatch('email', 's1', 'TASK');
    expect(r.ok).toBe(true);
    expect(sent[0]).toBe('');           // 先 Enter 同意默认高亮项
    expect(sent[sent.length - 1]).toBe('TASK'); // 任务随后才发
  });

  it('迟迟未就绪 → 超时拒派并带原因', async () => {
    const { tmux, sent } = makeTmux(['✳ Working…长输出'.repeat(20)], 'node');
    const dispatch = createProvisioningDispatch({
      tmux, waitReadyMs: 5, pollMs: 1, sleep: async () => undefined,
    });
    const r = await dispatch('email', 's1', 'TASK');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('未就绪');
    expect(sent).toEqual([]);
  });

  it('信任对话框 → Down+Enter 选「Yes」后派发（默认高亮是 No, exit）', async () => {
    const keys: string[] = [];
    const base = makeTmux(
      ['Is this a project you trust? ❯ No, exit / Yes, I trust this folder', '✳ ❯'],
      'node',
    );
    const tmux = {
      ...base.tmux,
      exec: async (args: readonly string[]) => {
        if (args[0] === 'send-keys') keys.push(args.join(' '));
        return base.tmux.exec(args);
      },
    } as unknown as TmuxClient;
    const dispatch = createProvisioningDispatch({
      tmux, pollMs: 1, sleep: async () => undefined,
    });
    const r = await dispatch('email', 's1', 'TASK');
    expect(r.ok).toBe(true);
    // 按下方向键 Down（把光标从 No 移到 Yes）——裸 Enter 会选 No 退出。
    expect(keys.some((k) => k.includes('Down'))).toBe(true);
    expect(base.sent).toEqual(['', 'TASK']); // Enter(接受) + 任务
  });

  it('会话缺失 → 先建会话再走就绪流程', async () => {
    const created: string[] = [];
    const tmuxBase = makeTmux(READY, 'node');
    const tmux = {
      ...tmuxBase.tmux,
      hasSession: async () => false,
      newSession: async (name: string) => { created.push(name); return ok(undefined); },
    } as unknown as TmuxClient;
    const dispatch = createProvisioningDispatch({ tmux });
    const r = await dispatch('email', 'fresh', 'TASK');
    expect(r.ok).toBe(true);
    expect(created).toEqual(['fresh']);
  });

  it('绑定会话自建带配置 cwd（专用 agent 必须在指定目录启动才见项目级 skill）', async () => {
    const created: Array<{ name: string; cwd?: string }> = [];
    const tmuxBase = makeTmux(READY, 'node');
    const tmux = {
      ...tmuxBase.tmux,
      hasSession: async () => false,
      newSession: async (name: string, cwd?: string) => { created.push({ name, cwd }); return ok(undefined); },
    } as unknown as TmuxClient;
    const dispatch = createProvisioningDispatch({
      tmux,
      cwdFor: (s) => (s === 'project-a' ? '/srv/project-b' : undefined),
    });
    await dispatch('email', 'project-a', 'TASK');
    await dispatch('email', 'other', 'TASK');
    expect(created).toEqual([
      { name: 'project-a', cwd: '/srv/project-b' }, // 绑定会话带 cwd
      { name: 'other', cwd: undefined }, // 普通会话默认 cwd
    ]);
  });

  it('绑定会话复用校验（PROBLEMS-R2 P2 预建旁路兜底）：现存 path 与配置 cwd 不符 → 显性 failed，任务不出手', async () => {
    const tmuxBase = makeTmux(READY, 'node');
    const tmux = {
      ...tmuxBase.tmux,
      listSessionsDetailed: async () =>
        ok([{ name: 'project-a', attached: false, path: '/tmp', cmd: 'claude' }]),
    } as unknown as TmuxClient;
    const dispatch = createProvisioningDispatch({
      tmux,
      cwdFor: (s) => (s === 'project-a' ? '/srv/project-b' : undefined),
    });
    const r = await dispatch('email', 'project-a', 'TASK');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('与配置 cwd');
    expect(tmuxBase.sent).toEqual([]); // 任务文本绝不出手
  });

  it('绑定会话复用校验：path 符号链接归一后一致（/tmp ↔ /private/tmp）→ 照常派发', async () => {
    const tmuxBase = makeTmux(READY, 'node');
    const realTmp = realpathSync(tmpdir());
    const tmux = {
      ...tmuxBase.tmux,
      listSessionsDetailed: async () =>
        ok([{ name: 'project-a', attached: false, path: realTmp, cmd: 'claude' }]),
    } as unknown as TmuxClient;
    const dispatch = createProvisioningDispatch({
      tmux,
      cwdFor: () => tmpdir(),
    });
    const r = await dispatch('email', 'project-a', 'TASK');
    expect(r.ok).toBe(true); // macOS tmux 报 /private/tmp 不误判
    expect(tmuxBase.sent).toContain('TASK');
  });
});

describe('createProvisioningDispatch（context 门，十四跑 R1 P2-4）', () => {
  it('compact 冷却：同单连续派发读到同一 stale 膨胀值，/compact 至多发一次', async () => {
    const { tmux, sent } = makeTmux(READY, 'node');
    const dispatch = createProvisioningDispatch({
      tmux,
      sleep: async () => undefined, // /compact 后的就绪轮询不真等
      contextGate: {
        workflowFor: async () => 'wf_aaa',
        // latestInputTokens 靠 60s 摄取——多次派发读到同一膨胀值是真实滞后形态
        contextTokensFor: async () => 900_000,
        threshold: 600_000,
      },
    });
    // 首见派发不动（宁少 clear）；第二次派发首次判 compact；第三次在冷却窗内被压住
    const r1 = await dispatch('email', 's1', 'TASK1');
    expect(r1.ok).toBe(true);
    const r2 = await dispatch('email', 's1', 'TASK2');
    expect(r2.ok).toBe(true);
    const r3 = await dispatch('email', 's1', 'TASK3');
    expect(r3.ok).toBe(true);
    expect(sent).toEqual(['TASK1', '/compact', 'TASK2', 'TASK3']); // /compact 只出现一次
  });

  it('切单 clear 不受 compact 冷却影响：compact 后窗内切单，clear 照发', async () => {
    const { tmux, sent } = makeTmux(READY, 'node');
    let wf = 'wf_aaa';
    const dispatch = createProvisioningDispatch({
      tmux,
      sleep: async () => undefined,
      contextGate: {
        workflowFor: async () => wf,
        contextTokensFor: async () => 900_000,
        threshold: 600_000,
      },
    });
    await dispatch('email', 's1', 'TASK1'); // 首见不动
    await dispatch('email', 's1', 'TASK2'); // → /compact（gateState 记 compactAt）
    wf = 'wf_bbb'; // 切单：冷却只作用于 compact，clear 照发
    const r3 = await dispatch('email', 's1', 'TASK3');
    expect(r3.ok).toBe(true);
    expect(sent).toEqual(['TASK1', '/compact', 'TASK2', '/clear', 'TASK3']);
  });
});
