// 缺料恢复三件套回归（2026-09-14 wf_994b0eb399ab / wf_7e8c73973b61 两事故）：
// ① 任务卡渲染失败必须显性 failed（不许 pending 永冻零痕迹）；
// ② 模板 requires 起流校验（缺参当场退回）；
// ③ amend 补料动词（快照不解锁，修正记账后重臂）；
// ④ Stop hook 反查兜底（无 runs 行也能找到在跑步骤）；
// ⑤ send 内容守卫拒发：盲重试被拒 + reworkSend 打回闭环。
//
// 断言时序约定同 engine.test.ts：`await engine.advance(id)` 排到锁链尾。

import { describe, expect, it } from 'vitest';
import { makeEngine, until } from './helpers.ts';
import { parseTemplate } from '../src/business/templates/template.ts';
import { createLedgerStore } from '@juli-os/ledger';

const REQUIRES_YAML = `key: t-requires
name: 需要料的模板
trigger: manual
requires:
  - draft
steps:
  - id: a
    kind: agent
    session: agent-a
    title: A
    prompt: "处理这封：{{.Input.draft}}"
  - id: g
    kind: gate
    title: G
`;

// 无 requires 声明但 prompt 引用缺 key——正是 wf_994b0eb399ab 的事故形态。
const FROZEN_YAML = `key: t-frozen
name: 缺料冻死模板
trigger: manual
steps:
  - id: a
    kind: agent
    session: agent-a
    title: A
    prompt: "处理这封：{{.Input.draft}}"
  - id: g
    kind: gate
    title: G
`;

describe('起流校验（requires）', () => {
  it('缺必需 input 当场退回，不建工作流', async () => {
    const w = makeEngine({ templates: { 't-requires': parseTemplate(REQUIRES_YAML) } });
    await expect(w.engine.startFlow('t-requires', 'x', {}))
      .rejects.toThrow(/missing: draft/);
    expect(w.store.listWorkflows()).toHaveLength(0);
  });

  it('补齐后正常起流并渲染任务卡', async () => {
    const w = makeEngine({ templates: { 't-requires': parseTemplate(REQUIRES_YAML) } });
    await w.engine.startFlow('t-requires', 'x', { draft: '正式正文' });
    await w.engine.advance(w.store.listWorkflows()[0]!.id);
    expect(w.dispatched[0]?.text).toContain('处理这封：正式正文');
  });
});

describe('渲染失败显性化 + amend 补料', () => {
  it('缺模板 key：步骤 failed + 事件留痕（不再 pending 永冻）', async () => {
    const w = makeEngine({ templates: { 't-frozen': parseTemplate(FROZEN_YAML) } });
    await w.engine.startFlow('t-frozen', 'x', {});
    const wfId = w.store.listWorkflows()[0]!.id;
    await w.engine.advance(wfId);
    const st = w.store.stepsForWorkflow(wfId)[0]!;
    expect(st.status).toBe('failed');
    expect(String(st.output['error'])).toContain('任务卡渲染失败');
    const evs = w.store.listEvents(200).filter((e) => e.type === 'step_failed');
    expect(evs.some((e) => JSON.stringify(e.payload).includes('渲染失败'))).toBe(true);
  });

  it('amend 补齐缺失 key 后重臂派发，修正记账', async () => {
    const w = makeEngine({ templates: { 't-frozen': parseTemplate(FROZEN_YAML) } });
    await w.engine.startFlow('t-frozen', 'x', {});
    const wfId = w.store.listWorkflows()[0]!.id;
    await w.engine.advance(wfId);
    const st = w.store.stepsForWorkflow(wfId)[0]!;

    await w.engine.amendStep(st.id, { draft: '补上的正文', _ref: 'hack' }, 'tester');
    await until(() => w.dispatched.some((d) => d.text.includes('处理这封：补上的正文')));
    const evs = w.store.listEvents(200).filter((e) => e.type === 'step_input_amended');
    expect(evs).toHaveLength(1);
    const payload = evs[0]!.payload as { keys: string[]; before: Record<string, unknown>; by: string };
    expect(payload.keys).toEqual(['draft']); // _ref 前缀键被拒（模板血统不可改）
    expect(payload.before['draft']).toBeNull();
    expect(payload.by).toBe('tester');
  });

  it('在飞步骤不许补料', async () => {
    const w = makeEngine({ templates: { 't-frozen': parseTemplate(FROZEN_YAML) } });
    await w.engine.startFlow('t-frozen', 'x', { draft: 'ok' });
    const wfId = w.store.listWorkflows()[0]!.id;
    const st = w.store.stepsForWorkflow(wfId)[0]!;
    await until(() => st.status === 'running');
    await expect(w.engine.amendStep(st.id, { draft: 'x' }, 'tester'))
      .rejects.toThrow(/running/);
  });

  it('候选值：关联单 meta 里的 message_id 能被推导出来', async () => {
    const w = makeEngine({ templates: { 't-frozen': parseTemplate(FROZEN_YAML) } });
    const parent = w.store.createWorkflow({ kind: 'email', title: '原邮件单', status: 'running', meta: { from: 'casey@acme.de', message_id: '<orig@acme.de>' } });
    const wf = await w.engine.startFlow('t-frozen', 'x', { draft: 'd', relates_to: parent.id });
    const s = w.engine.amendSuggestions(wf.id);
    expect((s['message_id'] as { value: string }).value).toBe('<orig@acme.de>');
    expect((s['message_id'] as { source: string }).source).toContain('关联单');
  });
});

describe('Stop hook 反查兜底', () => {
  it('无 runs 行时按 workflow.session 找到在跑 agent 步', () => {
    const store = createLedgerStore(':memory:');
    const w = store.createWorkflow({ kind: 'adhoc', title: '绕过派发的单', status: 'running', meta: {} });
    store.setWorkflowSession(w.id, 'agent-a');
    const st = store.createStep({ workflowId: w.id, seq: 1, kind: 'agent', title: '答复落盘', input: {} });
    store.setStepStatus(st.id, 'running');
    // 主路（runs JOIN）找不到——本单没有任何 runs 行，兜底按 session 字段命中。
    expect(store.runningAgentStepForSession('agent-a')?.id).toBe(st.id);
    // assigned_session（meta）同样命中。
    const w2 = store.createWorkflow({ kind: 'adhoc', title: '指派单', status: 'running', meta: { assigned_session: 'agent-b' } });
    const st2 = store.createStep({ workflowId: w2.id, seq: 1, kind: 'agent', title: 'X', input: {} });
    store.setStepStatus(st2.id, 'running');
    expect(store.runningAgentStepForSession('agent-b')?.id).toBe(st2.id);
  });
});

describe('send 内容守卫：盲重试被拒 + reworkSend 打回闭环', () => {
  const setupGuardFailure = async () => {
    const w = makeEngine();
    const wf = w.store.createWorkflow({ kind: 'email', title: '守卫拒发单', status: 'running', meta: { from: 'casey@acme.de' } });
    const agent = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '答复', input: { plan: '写答复', session: 'agent-a' } });
    w.store.setStepStatus(agent.id, 'completed');
    const gate = w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'gate', title: '发送决定', input: { draft: '没有披露的正文' } });
    w.store.setStepStatus(gate.id, 'completed');
    const send = w.store.createStep({
      workflowId: wf.id, seq: 3, kind: 'send', title: '发送',
      input: { body: '没有披露的正文', in_reply_to: '<x@q>' },
    });
    w.store.setStepOutput(send.id, { error: 'disclosure missing', guard: 'disclosure' });
    w.store.setStepStatus(send.id, 'failed');
    w.store.setWorkflowStatus(wf.id, 'failed');
    return { w, wf, agent, gate, send };
  };

  it('守卫打标的 send 步盲重试直接被拒', async () => {
    const { w, send } = await setupGuardFailure();
    await expect(w.engine.retry(send.id)).rejects.toThrow(/盲重试不会变好/);
    expect(w.sent).toHaveLength(0);
  });

  it('reworkSend：agent 带 feedback 重做 → 闸门重开人审 → 批准后新正文发出', async () => {
    const { w, wf, agent, gate, send } = await setupGuardFailure();
    // 产出走 Stop hook 结构化上报（capture-pane 兜底已摘除）。
    await w.engine.reworkSend(send.id, '补上披露落款', 'tester');
    const evs = w.store.listEvents(200).filter((e) => e.type === 'send_rework' && e.entityType === 'workflow');
    expect(evs).toHaveLength(1);
    expect(w.store.getStep(agent.id)!.input['feedback']).toBe('补上披露落款');
    // agent 重跑 → 回合结束（Stop hook）→ 闸门重开等人（修正内容必须重新过人审）。
    await until(() => w.dispatched.length > 0);
    await w.engine.onAgentStopped('agent-a', 'ok', '补了披露的正文\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。');
    await until(() => w.store.getStep(gate.id)!.status === 'waiting_human');
    await w.engine.approve(gate.id, '这次可以', 'tester');
    await until(() => w.sent.length === 1);
    expect(w.store.getWorkflow(wf.id)!.status).toBe('completed');
    expect(w.sent[0]!.body).toContain('本邮件由 AI 助理答复');
  });
});
