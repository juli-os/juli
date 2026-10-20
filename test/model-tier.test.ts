// 模型分层路由（2026-09-28 用户裁定「非必要不高智能，说了高智能才升档」）：
// ①bootFor=会话感知引导（声明 high 冷启动带 --model 高档 id）
// ②startTask input.model_tier='high' → 未点名落点改道 high 声明会话（同 cwd
//   孪生优先）；点名落点尊重不改道只留 mismatch；无 high 声明 fail-open。
// standard/缺省 = 行为零变化。

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProvisioningDispatch } from '@juli-os/agents';
import type { TmuxClient } from '@juli-os/agents';
import { createLedgerStore } from '@juli-os/ledger';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime } from '../src/runtime.ts';
import { createEngine, type EngineDeps } from '../src/business/workflow/engine.ts';
import { ok } from '@juli-os/artifacts';
import { makeClock, seqIds } from './helpers.ts';
import type { MailerPort, PusherPort } from '../src/contracts/ports.ts';

// ---- bootFor：会话感知引导 ------------------------------------------------------

const makeTmux = (panes: string[], cmd: string | { before: string; after: string }) => {
  const sent: string[] = [];
  const curCmd = (): string => typeof cmd === 'string' ? cmd : (sent.length > 0 ? cmd.after : cmd.before);
  const tmux: TmuxClient = {
    exec: async () => ok(curCmd()),
    hasSession: async () => true,
    newSession: async () => ok(undefined),
    killSession: async () => ok(undefined),
    interrupt: async () => ok(undefined),
    listSessions: async () => ok([]),
    capturePane: async () => ok(panes[Math.min(sent.length, panes.length - 1)] ?? ''),
    sendText: async (_n: string, text: string) => { sent.push(text); return ok(undefined); },
    sendTextConfirmed: async (_n: string, text: string) => { sent.push(text); return ok(undefined); },
  } as unknown as TmuxClient;
  return { tmux, sent };
};

describe('bootFor 模型分层引导', () => {
  it('bootFor 命中 → 裸 shell 用带 --model 的命令拉起；缺省回落 bootCommand', async () => {
    const { tmux, sent } = makeTmux(['last login: …\n❯', '✳ …\n\n❯'], { before: 'bash', after: 'node' });
    const dispatch = createProvisioningDispatch({
      tmux,
      bootCommand: 'claude',
      bootFor: (s) => (s === 'hi-session' ? `claude --model 'glm-5.3'` : 'claude'),
    });
    const r = await dispatch('email', 'hi-session', 'TASK');
    expect(r.ok).toBe(true);
    expect(sent[0]).toBe(`claude --model 'glm-5.3'`);
    const { tmux: tmux2, sent: sent2 } = makeTmux(['last login: …\n❯', '✳ …\n\n❯'], { before: 'bash', after: 'node' });
    const d2 = createProvisioningDispatch({ tmux: tmux2, bootFor: () => 'claude' });
    await d2('email', 'std-session', 'TASK');
    expect(sent2[0]).toBe('claude');
  });

  it('schema：model_tier 缺省 standard；models 两档缺省空串（不引导）', () => {
    const c = configSchema.parse({ data_dir: '/tmp/x' });
    expect(c.agents[0]?.model_tier ?? 'standard').toBe('standard');
    expect(c.models).toEqual({ standard: '', high: '' });
    const c2 = configSchema.parse({
      data_dir: '/tmp/x',
      models: { high: 'glm-5.3' },
      agents: [{ session: 'juli-dev' }, { session: 'juli-dev-hi', model_tier: 'high' }],
    });
    expect(c2.models.high).toBe('glm-5.3');
    expect(c2.models.standard).toBe('');
    expect(c2.agents[1]?.model_tier).toBe('high');
  });
});

// ---- startTask 路由规则 --------------------------------------------------------

const makeHarness = (agents: readonly { session: string; cwd?: string; model_tier?: 'standard' | 'high' }[]) => {
  const { clock } = makeClock();
  const store = createLedgerStore(':memory:', { clock, ids: seqIds() });
  const engine = createEngine({
    store, llm: null, model: 't',
    routing: {
      defaultSession: 'juli-reply', defaultProject: 'p',
      agents: agents.map((a) => ({ session: a.session, company: '', domain: '', cwd: a.cwd ?? '', model_tier: a.model_tier })),
    },
    dispatch: { async dispatch(_s, _session, _t) { return ok(undefined); } },
    syncDispatch: null,
    pusher: { async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {} } satisfies PusherPort,
    mailer: { async send() { return ok({ messageId: '<x@j>' }); } } satisfies MailerPort,
    captureOutput: async () => null, workspaceFor: null,
    availableSessions: ['juli-reply'], resolveSession: null, interruptSession: null,
    rebuildAgent: null, zombieFingerprint: null, clock, ids: seqIds(), templates: {},
    authz: { mode: 'allowlist', allow: ['*@example.com'], deny: [] },
  } satisfies EngineDeps);
  return { engine, store };
};

describe('startTask 模型分层路由', () => {
  const decls = [
    { session: 'juli-dev', cwd: '/repo' },
    { session: 'juli-dev-hi', cwd: '/repo', model_tier: 'high' as const },
    { session: 'villa-hi', cwd: '/villa', model_tier: 'high' as const },
  ];

  it('未点名 + model_tier=high → 改道第一个 high 会话 + model_tier_routed 事件', async () => {
    const h = makeHarness(decls);
    const w = await h.engine.startTask('高智能单', { model_tier: 'high', brief: 'x', delivery: 'apply' });
    const steps = h.store.stepsForWorkflow(w.id);
    expect(steps[0]?.input['session']).toBe('juli-dev-hi');
    expect(h.store.listEvents(50, ['model_tier_routed']).some((e) => e.payload['to'] === 'juli-dev-hi')).toBe(true);
  });

  it('继承落点有同 cwd 孪生 → 升档不改仓（twin 优先于第一个 high）', async () => {
    const h = makeHarness(decls);
    const parent = await h.engine.startTask('父单', { session: 'juli-dev', brief: 'p', delivery: 'apply' });
    const w = await h.engine.startTask('跟进高智能', { relates_to: parent.id, model_tier: 'high', brief: 'f', delivery: 'apply' });
    const steps = h.store.stepsForWorkflow(w.id);
    expect(steps[0]?.input['session']).toBe('juli-dev-hi'); // 同 /repo 孪生，不是 villa-hi
    const evs = h.store.listEvents(50, ['model_tier_routed']);
    expect(evs.some((e) => e.payload['from'] === 'juli-dev' && e.payload['to'] === 'juli-dev-hi' && e.payload['twin'] === true)).toBe(true);
    // 继承事件仍如实记原会话（tier 改道单独记账）。
    expect(h.store.listEvents(50, ['session_inherited']).some((e) => e.payload['session'] === 'juli-dev')).toBe(true);
  });

  it('显式 session + high → 尊重落点不改道，非 high 落点留 mismatch 事件', async () => {
    const h = makeHarness(decls);
    const w = await h.engine.startTask('点名单', { session: 'juli-reply', model_tier: 'high', brief: 'x', delivery: 'apply' });
    const steps = h.store.stepsForWorkflow(w.id);
    expect(steps[0]?.input['session']).toBe('juli-reply');
    expect(h.store.listEvents(50, ['model_tier_mismatch']).some((e) => e.payload['session'] === 'juli-reply')).toBe(true);
  });

  it('无 high 声明 → 照旧派发（fail-open）+ unavailable 事件', async () => {
    const h = makeHarness([{ session: 'juli-dev', cwd: '/repo' }]);
    const w = await h.engine.startTask('无高档可用', { model_tier: 'high', brief: 'x', delivery: 'apply' });
    const steps = h.store.stepsForWorkflow(w.id);
    expect(steps[0]?.input['session']).toBeUndefined();
    expect(h.store.listEvents(50, ['model_tier_unavailable'])).toHaveLength(1);
  });

  it('缺省（无 model_tier）→ 行为零变化：不产生任何 tier 事件、落点照旧', async () => {
    const h = makeHarness(decls);
    await h.engine.startTask('普通单', { brief: 'x', delivery: 'apply' });
    expect(h.store.listEvents(50, ['model_tier_routed', 'model_tier_mismatch', 'model_tier_unavailable'])).toHaveLength(0);
  });
});

// ---- model_tier_auto（2026-10-12 task_tier 自动升档留痕） ----------------------

describe('startTask model_tier_auto 事件', () => {
  it('jev 升档落孪生（session=孪生 + model_tier_by 在场）→ model_tier_auto 记账', async () => {
    const h = makeHarness([
      { session: 'juli-dev', cwd: '/repo' },
      { session: 'juli-dev-hi', cwd: '/repo', model_tier: 'high' as const },
    ]);
    const w = await h.engine.startTask('难单', {
      session: 'juli-dev-hi', model_tier: 'high', model_tier_by: 'jev', brief: 'x', delivery: 'apply',
    });
    const steps = h.store.stepsForWorkflow(w.id);
    expect(steps[0]?.input['session']).toBe('juli-dev-hi'); // 落点不被改道
    const evs = h.store.listEvents(50, ['model_tier_auto']);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload['to']).toBe('juli-dev-hi');
    expect(evs[0]!.payload['by']).toBe('jev');
  });

  it('手动 high（无 model_tier_by）不记 auto——审计分得清「谁说的升档」', async () => {
    const h = makeHarness([
      { session: 'juli-dev', cwd: '/repo' },
      { session: 'juli-dev-hi', cwd: '/repo', model_tier: 'high' as const },
    ]);
    await h.engine.startTask('手点孪生', { session: 'juli-dev-hi', model_tier: 'high', brief: 'x', delivery: 'apply' });
    expect(h.store.listEvents(50, ['model_tier_auto'])).toHaveLength(0);
  });
});

// ---- runtime taskTier/highTwinFor 真实现直测（R4-F1 P2-2） --------------------
// 既有用例全部 mock 在 Runtime seam 上（task-intake 夹具 `as unknown as Runtime`），
// 读侧真身零直测——采用闸（:586-587）与 highTwinFor 守卫（:592-596）回归不产生
// 红灯。这里用 createRuntime 真口：tmp data_dir + 真实 config 孪生对（过 schema
// 三规则）+ 热写 judgment.json（provider=cli 指向桩脚本，场景模式每次 ask 热读）
// ——jev 网络判定点在 cli judge 边界隔离（stdin 收 questions、按 JULI_FAKE_TIER
// env 定答或挂），rt.taskTier / rt.highTwinFor 是 runtime 真身非 mock 替身。

const FAKE_JEV_SOURCE = (callsPath: string): string => `
import { appendFileSync } from 'node:fs';
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(callsPath)}, 'x'); // 调用留痕：零网络断言的观测点
  if (process.env.JULI_FAKE_TIER === 'crash') process.exit(3);
  const [choice, conf] = (process.env.JULI_FAKE_TIER ?? 'high:0.9').split(':');
  process.stdout.write(JSON.stringify({ answers: { tier: { choice, confidence: Number(conf) } } }));
});
`;

const makeTierRuntime = (): { rt: ReturnType<typeof createRuntime>; dir: string; callsPath: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'juli-tasktier-'));
  const callsPath = join(dir, 'jev-calls.log');
  writeFileSync(join(dir, 'fake-jev.mjs'), FAKE_JEV_SOURCE(callsPath));
  const rt = createRuntime(configSchema.parse({
    data_dir: dir,
    claude_dir: join(dir, 'claude'),
    password: 'pw-tasktier',
    agents: [{ session: 'juli-dev' }, { session: 'juli-dev-hi', model_tier: 'high' }],
  }));
  return { rt, dir, callsPath };
};

const writeJudgment = (dir: string, mode: 'on' | 'shadow' | 'off'): void => {
  writeFileSync(join(dir, 'judgment.json'), JSON.stringify({
    provider: 'cli',
    cli: { cmd: [process.execPath, join(dir, 'fake-jev.mjs')] },
    min_confidence: 0.7,
    scenarios: { task_tier: mode },
  }));
};

/** 定桩答案（`choice:confidence` | 'crash'），用后恢复环境免串扰同 worker 其他用例。 */
const withFakeTier = async (value: string | null, fn: () => Promise<void>): Promise<void> => {
  const saved = process.env.JULI_FAKE_TIER;
  try {
    if (value === null) delete process.env.JULI_FAKE_TIER;
    else process.env.JULI_FAKE_TIER = value;
    await fn();
  } finally {
    if (saved === undefined) delete process.env.JULI_FAKE_TIER;
    else process.env.JULI_FAKE_TIER = saved;
  }
};

describe('runtime taskTier 采用闸真实现直测（R4-F1 P2-2）', () => {
  it('mode=on + answer=high + 置信度达标 → high；judgment_made 留痕在账', async () => {
    const { rt, dir } = makeTierRuntime();
    try {
      writeJudgment(dir, 'on');
      await withFakeTier(null, async () => { // 桩缺省即 high:0.9 ≥ 0.7
        await expect(rt.taskTier('重构引擎派发层', '多文件架构改动')).resolves.toBe('high');
      });
      const evs = rt.store.listEvents(50, ['judgment_made']);
      expect(evs).toHaveLength(1);
      expect(evs[0]!.payload['scenario']).toBe('task_tier');
      expect(evs[0]!.payload['mode']).toBe('on');
      expect(evs[0]!.payload['ok']).toBe(true);
      expect(evs[0]!.payload['answer']).toBe('high');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mode=on + answer=standard → null（answer 闸：判便宜的不升档）', async () => {
    const { rt, dir } = makeTierRuntime();
    try {
      writeJudgment(dir, 'on');
      await withFakeTier('standard:0.9', async () => {
        await expect(rt.taskTier('改一行文案', 'b')).resolves.toBeNull();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mode=on + answer=high + 置信度低于阈值 → null（fail-open 便宜侧）', async () => {
    const { rt, dir } = makeTierRuntime();
    try {
      writeJudgment(dir, 'on');
      await withFakeTier('high:0.4', async () => { // 0.4 < min_confidence 0.7
        await expect(rt.taskTier('拿不准的单', 'b')).resolves.toBeNull();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mode=shadow + 判 high → null（shadow 只记账不采用），judgment_made 观察面留痕', async () => {
    const { rt, dir } = makeTierRuntime();
    try {
      writeJudgment(dir, 'shadow');
      await withFakeTier(null, async () => {
        await expect(rt.taskTier('shadow 观察单', 'b')).resolves.toBeNull();
      });
      const evs = rt.store.listEvents(50, ['judgment_made']);
      expect(evs).toHaveLength(1);
      expect(evs[0]!.payload['mode']).toBe('shadow');
      expect(evs[0]!.payload['answer']).toBe('high');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mode=off → null 且零网络（桩零调用）；judgment.json 缺席 → 同 null', async () => {
    const { rt, dir, callsPath } = makeTierRuntime();
    try {
      writeJudgment(dir, 'off');
      await withFakeTier(null, async () => {
        await expect(rt.taskTier('普通单', 'b')).resolves.toBeNull();
      });
      expect(existsSync(callsPath)).toBe(false); // 桩没被 spawn = 零网络零 token
      await withFakeTier(null, async () => { // 场景配置整个缺席：ask null 臂
        await expect(rt.taskTier('普通单', 'b')).resolves.toBeNull();
      });
      expect(existsSync(callsPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('判定链挂（桩 exit≠0 → ok=false）→ null fail-open，留痕记 error', async () => {
    const { rt, dir } = makeTierRuntime();
    try {
      writeJudgment(dir, 'on');
      await withFakeTier('crash', async () => {
        await expect(rt.taskTier('判定挂单', 'b')).resolves.toBeNull();
      });
      const evs = rt.store.listEvents(50, ['judgment_made']);
      expect(evs).toHaveLength(1);
      expect(evs[0]!.payload['ok']).toBe(false);
      expect(String(evs[0]!.payload['error'])).toContain('exit code 3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runtime highTwinFor 真实现直测（R4-F1 P2-2）', () => {
  it('孪生成对 → twin；基名缺席 / 入参已带 -hi / 空串 → 不判定', async () => {
    const { rt, dir } = makeTierRuntime();
    try {
      expect(rt.highTwinFor('juli-dev')).toBe('juli-dev-hi');
      expect(rt.highTwinFor('juli-solo')).toBe(''); // 未声明 -hi 孪生：升档无处落
      expect(rt.highTwinFor('juli-dev-hi')).toBe(''); // 已是孪生：不链式升档
      expect(rt.highTwinFor('')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('孪生声明非 high 不算孪生（读侧守卫，与 schema 规则②互为读写两侧）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-tasktier-'));
    try {
      const rt = createRuntime(configSchema.parse({
        data_dir: dir,
        claude_dir: join(dir, 'claude'),
        password: 'pw-tasktier',
        agents: [{ session: 'juli-x' }, { session: 'juli-x-hi', model_tier: 'high' }, { session: 'juli-y' }],
      }));
      expect(rt.highTwinFor('juli-x')).toBe('juli-x-hi');
      expect(rt.highTwinFor('juli-y')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
