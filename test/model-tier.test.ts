// 模型分层路由（2026-09-28 用户裁定「非必要不高智能，说了高智能才升档」）：
// ①bootFor=会话感知引导（声明 high 冷启动带 --model 高档 id）
// ②startTask input.model_tier='high' → 未点名落点改道 high 声明会话（同 cwd
//   孪生优先）；点名落点尊重不改道只留 mismatch；无 high 声明 fail-open。
// standard/缺省 = 行为零变化。

import { describe, expect, it } from 'vitest';
import { createProvisioningDispatch } from '@juli-os/agents';
import type { TmuxClient } from '@juli-os/agents';
import { createLedgerStore } from '@juli-os/ledger';
import { configSchema } from '../src/platform/config/schema.ts';
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
      agents: [{ session: 'hi', model_tier: 'high' }],
    });
    expect(c2.models.high).toBe('glm-5.3');
    expect(c2.models.standard).toBe('');
    expect(c2.agents[0]?.model_tier).toBe('high');
  });
});

// ---- startTask 路由规则 --------------------------------------------------------

const makeHarness = (agents: readonly { session: string; cwd?: string; model_tier?: 'standard' | 'high' }[]) => {
  const { clock, advance } = makeClock();
  const store = createLedgerStore(':memory:', { clock, ids: seqIds() });
  const dispatched: { session: string }[] = [];
  const engine = createEngine({
    store, llm: null, model: 't',
    routing: {
      defaultSession: 'juli-reply', defaultProject: 'p',
      agents: agents.map((a) => ({ session: a.session, company: '', domain: '', cwd: a.cwd ?? '', model_tier: a.model_tier })),
    },
    dispatch: { async dispatch(_s, session, _t) { dispatched.push({ session }); return ok(undefined); } },
    syncDispatch: null,
    pusher: { async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {} } satisfies PusherPort,
    mailer: { async send() { return ok({ messageId: '<x@j>' }); } } satisfies MailerPort,
    captureOutput: async () => null, workspaceFor: null,
    availableSessions: ['juli-reply'], resolveSession: null, interruptSession: null,
    rebuildAgent: null, zombieFingerprint: null, clock, ids: seqIds(), templates: {},
    authz: { mode: 'allowlist', allow: ['*@example.com'], deny: [] },
  } satisfies EngineDeps);
  return { engine, store, dispatched, advanceClock: advance };
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
