// task-handoff 转派（2026-09-20 裁决）：agent 提案 domain，引擎四道校验
// （domain 存在/非绑定/不回访/忙闲选枝）+ 同案卷追加执行步 + route_content_
// handoff 留痕。物理动作=同一案卷追加一枚执行步，案卷不分裂。

import { describe, expect, it } from 'vitest';
import { createLedgerStore } from '@juli-os/ledger';
import { createEngine } from '../src/business/workflow/engine.ts';
import type { EngineDeps } from '../src/business/workflow/engine.ts';
import type { MailerPort, PusherPort } from '../src/contracts/ports.ts';
import { makeClock, seqIds } from './helpers.ts';

const AGENTS = [
  { session: 'juli-reply', company: 'juli', domain: 'reply', senders: [], cwd: '' },
  { session: 'juli-dev', company: 'juli', domain: 'dev', senders: [], cwd: '' },
  { session: 'makro-video', company: 'juli', domain: 'video', senders: [], cwd: '' },
  { session: 'project-a', company: 'juli', domain: 'accounting', senders: [], cwd: '' },
];

const makeWorld = (over: Partial<EngineDeps> = {}) => {
  const { clock } = makeClock();
  const store = createLedgerStore(':memory:', { clock, ids: seqIds() });
  const dispatchedTo: string[] = [];
  const engine = createEngine({
    store,
    llm: null, model: 't',
    routing: {
      defaultSession: 'juli-reply', defaultProject: 'p',
      boundAgents: [{ session: 'project-a', cwd: '~/x', senders: ['alisa@example.com'] }],
      agents: AGENTS,
    },
    dispatch: { async dispatch(_t, session) { dispatchedTo.push(session); return { ok: true, value: undefined } as const; } },
    syncDispatch: null,
    pusher: { async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {} } satisfies PusherPort,
    mailer: { async send() { return { ok: true, value: { messageId: '<h@j>' } } as const; } } satisfies MailerPort,
    captureOutput: async () => null, workspaceFor: null,
    availableSessions: ['juli-reply', 'juli-dev', 'juli-dev-2', 'project-a', 'makro-video'],
    resolveSession: null, interruptSession: null,
    rebuildAgent: null, zombieFingerprint: null, clock, ids: seqIds(), templates: {},
    authz: { mode: 'allowlist', allow: ['*@example.com'], deny: [] },
    ...over,
  } satisfies EngineDeps);
  return { engine, store, dispatchedTo };
};

/** 造一单停在「理解完成、无后续步」的形态：completed 理解步 + 摘要。 */
const parkedCase = (w: ReturnType<typeof makeWorld>, session = 'juli-reply') => {
  const wf = w.store.createWorkflow({ kind: 'adhoc', title: '帮改引擎代码', status: 'running', meta: { mode: 'nodes' } });
  const st = w.store.createStep({
    workflowId: wf.id, seq: 1, kind: 'agent', title: '理解与接单',
    input: { session, plan: '读一下' },
  });
  w.store.setStepStatus(st.id, 'running');
  w.store.createRun(wf.id, session);
  w.store.setStepStatus(st.id, 'completed');
  w.store.setStepOutput(st.id, { output: '要求：修 engine 的路由函数，加测试' });
  w.store.setWorkflowSession(wf.id, session);
  return { wf, st };
};

describe('task-handoff 转派', () => {
  it('happy path：转派 dev → 同案卷追加执行步钉 juli-dev + 事件留痕 + workflow.session 回填', async () => {
    const w = makeWorld();
    const { wf } = parkedCase(w);
    const r = await w.engine.handoff(wf.id, 'dev', '是要改引擎代码，不是回信', 'agent:juli-reply');
    expect(r).toEqual({ from: 'juli-reply', to: 'juli-dev' });
    const steps = w.store.stepsForWorkflow(wf.id);
    const next = steps.find((s) => s.seq === 2);
    expect(next).toBeDefined();
    expect(next!.input['session']).toBe('juli-dev');
    expect(String(next!.input['plan'])).toContain('改引擎代码');
    expect(String(next!.input['plan'])).toContain('修 engine 的路由函数'); // 前站摘要随单
    expect(w.store.getWorkflow(wf.id)!.session).toBe('juli-dev');
    const ev = w.store.listEvents(50).find((e) => e.type === 'route_content_handoff');
    expect(ev).toBeDefined();
    expect(ev!.payload['to']).toBe('juli-dev');
  });

  it('未知 domain → 显式拒绝并列出可用面，不追加步', async () => {
    const w = makeWorld();
    const { wf } = parkedCase(w);
    await expect(w.engine.handoff(wf.id, 'invest', '想投资', 'x'))
      .rejects.toThrow(/mesh 里没有 domain=invest/);
    expect(w.store.stepsForWorkflow(wf.id).some((s) => s.seq === 2)).toBe(false);
  });

  it('目标只由绑定会话承担 → 隔离纪律拒（accounting 不接受转派）', async () => {
    const w = makeWorld();
    const { wf } = parkedCase(w);
    await expect(w.engine.handoff(wf.id, 'accounting', '顺手录个账', 'x'))
      .rejects.toThrow(/绑定会话/);
  });

  it('乒乓守卫：转回 chain 里去过的会话 → 拒', async () => {
    const w = makeWorld();
    const { wf } = parkedCase(w, 'juli-dev'); // 停在 juli-dev（曾从 reply 转来）
    // route_session=进门落点 juli-reply；再转回 reply 即回访。
    w.store.updateWorkflowMeta(wf.id, { route_session: 'juli-reply' });
    await expect(w.engine.handoff(wf.id, 'reply', '好像还是该回信', 'agent:juli-dev'))
      .rejects.toThrow(/乒乓守卫/);
  });

  it('绑定会话无转出权（专线只进不出）', async () => {
    const w = makeWorld();
    const { wf } = parkedCase(w, 'project-a');
    await expect(w.engine.handoff(wf.id, 'dev', '想转出去', 'agent:project-a'))
      .rejects.toThrow(/无转出权/);
  });

  it('目标忙 → runAgentStep 选枝接管：改道其他声明 agent（2026-09-27 裁决：不克隆）', async () => {
    const w = makeWorld();
    const { wf } = parkedCase(w);
    // 占住 juli-dev 与 juli-reply（busy 反查走 runs JOIN，占坑必须建 run）。
    for (const sess of ['juli-dev', 'juli-reply']) {
      const other = w.store.createWorkflow({ kind: 'adhoc', title: `占坑${sess}`, status: 'running', meta: { mode: 'nodes' } });
      const occ = w.store.createStep({ workflowId: other.id, seq: 1, kind: 'agent', title: '在跑', input: { session: sess } });
      w.store.setStepStatus(occ.id, 'running');
      w.store.createRun(other.id, sess);
    }
    await w.engine.handoff(wf.id, 'dev', 'busy 也该转', 'agent:juli-reply');
    await Promise.resolve(); // advance 是 void fire，派发同步走完
    // 新语义：不再落同基名克隆 juli-dev-2——负载摊给其他声明 agent，
    // 同公司（juli）的 makro-video 空闲即接管。
    expect(w.dispatchedTo).toContain('makro-video');
    expect(w.dispatchedTo).not.toContain('juli-dev-2');
  });

  it('running 步中转派 → 收工结算不覆盖转派卡（P1-2：plan 仍是转派卡、钉定会话不踏）', async () => {
    const w = makeWorld();
    // 真实时序：intake 步 running 中调 handoff（prompt 注入、无 plan/session 钉
    // ——parkedCase 预置 completed 恰好绕开了这条路径）。
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '帮改引擎代码', status: 'running', meta: { mode: 'nodes' } });
    const intake = w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'agent', title: '理解与接单',
      input: { prompt: '阅读来信 {{.Input.subject}}' },
    });
    w.store.setStepStatus(intake.id, 'running');
    w.store.createRun(wf.id, 'juli-reply');
    w.store.setWorkflowSession(wf.id, 'juli-reply');
    await w.engine.handoff(wf.id, 'dev', '是要改引擎代码，不是回信', 'agent:juli-reply');
    await Promise.resolve(); // handoff 里 void advance 的派发同步走完
    // 原步收工 → onAgentStopped 结算：修前播种会以渲染后的上游任务整体覆盖转派卡。
    await w.engine.onAgentStopped('juli-reply', 'stop', '已转派给专科会话');
    const hs = w.store.stepsForWorkflow(wf.id).find((s) => s.seq === 2)!;
    expect(String(hs.input['plan'])).toContain('[转派自');
    expect(String(hs.input['plan'])).toContain('是要改引擎代码');
    expect(String(hs.input['plan'])).not.toContain('阅读来信'); // 结算播种没写进来
    expect(hs.input['session']).toBe('juli-dev'); // 钉定会话不被踏
    expect(w.store.getStep(intake.id)!.status).toBe('completed'); // 结算本身照常
  });
});
