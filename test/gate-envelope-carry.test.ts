// R5 回归（wf_16454623bf49 两代事故，生产两次靠 amend 自愈）：openGate 携带
// deliverables 时 envelope 不得整包顶掉闸门定义时申报的 to/subject——否则
// approve 播种 send.to='' 必撞 no_recipient。合并语义=申报键优先、sweep 线程
// 提示只补缺；无申报（回信流）维持整包原样。
import { describe, expect, it } from 'vitest';
import { makeEngine } from './helpers.ts';

describe('openGate envelope 携带：申报优先、sweep 补缺', () => {
  it('任务流：sweep envelope 不冲掉申报 to/subject，approve 播种 send.to=申报值', async () => {
    const w = makeEngine();
    const wf = w.store.createWorkflow({
      kind: 'adhoc', title: 'task-flow-carry',
      meta: { mode: 'nodes', template_input: { brief: '任务流回归' } },
    });
    // seq1 前步：已完成，产出=真实 sweep 形状（deliverables + 线程提示
    // envelope——parseEnvelope 判型只收窄这两键，结构性无 to/subject）。
    const prev = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '执行' });
    w.store.setStepOutput(prev.id, {
      output: '已完成',
      deliverables: [{ file: 'review.html', role: 'report', summary: '对照表' }],
      envelope: { in_reply_to_hint: '<thread-1@example.com>', feedback_refs: ['fb-1'] },
    });
    w.store.setStepStatus(prev.id, 'completed');
    // seq2 闸门：任务流申报形态（无原始发件人时定义时强制申报 envelope.to）；
    // checks 预置全绿——前置对账面非本条被测对象。
    const gate = w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'gate', title: '发送答复' });
    w.store.setStepInput(gate.id, {
      envelope: { to: 'client@example.com', subject: '进展通报' },
      plan: '发送对照表',
      checks: [{ name: 'redline', status: 'pass', detail: '' }],
    });
    // seq3 发送步（生产由 appendNode 自动配对，这里按同形状手工落地）。
    w.store.createStep({ workflowId: wf.id, seq: 3, kind: 'send', title: '发送答复' });
    w.store.setWorkflowStatus(wf.id, 'running');
    await w.engine.advance(wf.id); // openGate：deliverables + envelope 携带
    const opened = w.store.getStep(gate.id)!;
    expect(opened.status).toBe('waiting_human');
    expect(opened.input['envelope']).toMatchObject({
      to: 'client@example.com', subject: '进展通报',
      in_reply_to_hint: '<thread-1@example.com>', feedback_refs: ['fb-1'],
    });
    await w.engine.approve(gate.id, '批', 'user');
    const send = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'send')!;
    expect(send.input['to']).toBe('client@example.com');
    expect(send.input['subject']).toBe('进展通报');
  });

  it('无申报（回信流形状）：携带维持 sweep 整包原样（存量行为零变）', async () => {
    const w = makeEngine();
    const wf = w.store.createWorkflow({
      kind: 'adhoc', title: 'reply-flow-carry',
      meta: { mode: 'nodes', template_input: { brief: 'x' } },
    });
    const prev = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '执行' });
    w.store.setStepOutput(prev.id, {
      deliverables: [{ file: 'a.html', role: 'report' }],
      envelope: { in_reply_to_hint: '<t@x>', feedback_refs: ['fb-9'] },
    });
    w.store.setStepStatus(prev.id, 'completed');
    const gate = w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'gate', title: '请批' });
    w.store.setStepInput(gate.id, { plan: 'x', checks: [{ name: 'redline', status: 'pass', detail: '' }] });
    w.store.createStep({ workflowId: wf.id, seq: 3, kind: 'send', title: '发送答复' });
    w.store.setWorkflowStatus(wf.id, 'running');
    await w.engine.advance(wf.id);
    expect(w.store.getStep(gate.id)!.input['envelope']).toEqual({
      in_reply_to_hint: '<t@x>', feedback_refs: ['fb-9'],
    });
  });
});
