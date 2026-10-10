// 绑定会话（专用 agent 隔离，2026-09-19 裁决）契约锁定：
// ①白名单发件人的邮件 → 首步钉绑定会话（meta.session_bound 标记）；
// ②其余发件人零变化（默认路由不受影响）；
// ③未经 sender 路由标记的单给步钉绑定会话 → 显式 failed 守卫拒派；
// ④绑定会话豁免复用优先落回（点名不存在绝不流进 juli-reply）。

import { describe, expect, it } from 'vitest';
import { createLedgerStore } from '@juli-os/ledger';
import { createEngine, type EngineDeps } from '../src/business/workflow/engine.ts';
import { ok } from '@juli-os/artifacts';
import { makeClock, makeEmail, seqIds } from './helpers.ts';
import type { MailerPort, PusherPort } from '../src/contracts/ports.ts';

const BOUND = 'project-a';
const SENDER = 'alice.chen@example.com';

const makeWorld = (over: Partial<EngineDeps> = {}) => {
  const { clock, advance } = makeClock();
  const store = createLedgerStore(':memory:', { clock, ids: seqIds() });
  const dispatched: { session: string; text: string }[] = [];
  const engine = createEngine({
    store,
    llm: null, model: 't',
    routing: {
      defaultSession: 'juli-reply', defaultProject: 'p',
      boundAgents: [{ session: BOUND, cwd: '/srv/project-b', senders: [SENDER] }],
    },
    dispatch: {
      async dispatch(_s, session, text) { dispatched.push({ session, text }); return ok(undefined); },
    },
    syncDispatch: null,
    pusher: { async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {} } satisfies PusherPort,
    mailer: { async send() { return ok({ messageId: '<x@j>' }); } } satisfies MailerPort,
    captureOutput: async () => null,
    workspaceFor: null,
    availableSessions: ['juli-reply', BOUND],
    resolveSession: null,
    interruptSession: null, rebuildAgent: null, zombieFingerprint: null,
    clock, ids: seqIds(),
    templates: {},
    authz: { mode: 'allowlist', allow: ['*@example.com', SENDER], deny: [] },
    ...over,
  } satisfies EngineDeps);
  return { engine, store, dispatched, advanceClock: advance };
};

describe('绑定会话路由（只开邮件口）', () => {
  it('白名单发件人 → 首步钉绑定会话 + meta 标记 + 路由事件留痕', async () => {
    const w = makeWorld();
    const wf = await w.engine.startEmailWorkflow(makeEmail({ from: SENDER }));
    const steps = w.store.stepsForWorkflow(wf.id);
    expect(w.store.getWorkflow(wf.id)!.meta['session_bound']).toBe(BOUND);
    expect(steps[0]!.input['session']).toBe(BOUND);
    expect(w.dispatched[0]!.session).toBe(BOUND); // 派进绑定会话
    expect(w.store.listEvents(20).some((e) => e.type === 'session_bound_route')).toBe(true);
  });

  it('非白名单发件人 → 零变化走默认会话', async () => {
    const w = makeWorld();
    const wf = await w.engine.startEmailWorkflow(makeEmail()); // boss@example.com
    const steps = w.store.stepsForWorkflow(wf.id);
    expect(steps[0]!.input['session']).toBe('juli-reply'); // 0930：default 也显式钉（播种即锚定），落点不变
    expect(w.store.getWorkflow(wf.id)!.meta['session_bound']).toBeUndefined();
    expect(w.dispatched[0]!.session).toBe('juli-reply');
  });

  it('大小写不敏感匹配（邮件头 From 大小写不可控）', async () => {
    const w = makeWorld();
    const wf = await w.engine.startEmailWorkflow(makeEmail({ from: 'ALICE.CHEN@EXAMPLE.COM' }));
    expect(w.store.getWorkflow(wf.id)!.meta['session_bound']).toBe(BOUND);
  });
});

describe('绑定会话守卫（旁道拒派）', () => {
  it('未经 sender 路由的单钉绑定会话 → failed 留 session_bound 守卫，任务不出手', async () => {
    const w = makeWorld();
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '旁道', status: 'running', meta: { mode: 'nodes' } });
    w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'agent', title: '试探',
      input: { plan: '想借会计会话跑私活', session: BOUND },
    });
    await w.engine.advance(wf.id);
    const st = w.store.stepsForWorkflow(wf.id)[0]!;
    expect(st.status).toBe('failed');
    expect(st.output['guard']).toBe('session_bound');
    expect(w.dispatched).toHaveLength(0); // 任务文本绝不出手
  });

  it('标记过的单照常派进绑定会话', async () => {
    const w = makeWorld();
    const wf = w.store.createWorkflow({
      kind: 'adhoc', title: '正道', status: 'running',
      meta: { mode: 'nodes', session_bound: BOUND },
    });
    w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'agent', title: '入账',
      input: { plan: '录一笔', session: BOUND },
    });
    await w.engine.advance(wf.id);
    expect(w.store.stepsForWorkflow(wf.id)[0]!.status).toBe('running');
    expect(w.dispatched[0]!.session).toBe(BOUND);
  });

  it('绑定会话豁免复用优先落回：不存在时保持原名（绝不流进 juli-reply）', async () => {
    // resolveSession 模拟生产路由器：点名不存在 → 落回 juli-reply。
    const w = makeWorld({
      resolveSession: (s) => (s === 'juli-reply' ? s : 'juli-reply'),
      availableSessions: ['juli-reply'], // 绑定会话此刻不在活名单
    });
    const wf = w.store.createWorkflow({
      kind: 'adhoc', title: '豁免', status: 'running',
      meta: { mode: 'nodes', session_bound: BOUND },
    });
    w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'agent', title: '入账',
      input: { plan: '录一笔', session: BOUND },
    });
    await w.engine.advance(wf.id);
    expect(w.dispatched[0]!.session).toBe(BOUND); // 未被改写成 juli-reply
  });
});
