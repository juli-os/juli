// 板 A「交付显式化」（2026-09-21）：闸门 delivery 一等字段——
// email=批准真发；apply/artifact=批准即生效/纯确认（无邮件语义）；
// 未申报回退旧判据（标题「发送」/envelope.to），存量行为零放松。
import { describe, expect, it } from 'vitest';
import { makeEngine } from './helpers.ts';
import { gateDelivery, isSendGateDecision } from '../src/business/send/sendSeed.ts';

describe('gateDelivery 判型', () => {
  it('三合法值', () => {
    expect(gateDelivery({ delivery: 'email' })).toBe('email');
    expect(gateDelivery({ delivery: 'apply' })).toBe('apply');
    expect(gateDelivery({ delivery: 'artifact' })).toBe('artifact');
  });
  it('空格容忍 + 非法/缺失 → 空串（回退旧判据）', () => {
    expect(gateDelivery({ delivery: ' apply ' })).toBe('apply');
    expect(gateDelivery({ delivery: 'send' })).toBe('');
    expect(gateDelivery({})).toBe('');
    expect(gateDelivery(undefined)).toBe('');
    expect(gateDelivery({ delivery: 42 })).toBe('');
  });
});

describe('isSendGateDecision 三态', () => {
  it('显式 delivery 优先：apply/artifact 压过「发送」标题与 envelope.to', () => {
    expect(isSendGateDecision('发送闸门', { delivery: 'apply' })).toBe(false);
    expect(isSendGateDecision('发送闸门', { delivery: 'artifact', envelope: { to: 'a@b.c' } })).toBe(false);
    expect(isSendGateDecision('方案确认', { delivery: 'email', envelope: { to: 'a@b.c' } })).toBe(true);
  });
  it('未申报回退旧判据（存量零放松）', () => {
    expect(isSendGateDecision('发送闸门', {})).toBe(true);
    expect(isSendGateDecision('方案确认', { envelope: { to: 'a@b.c' } })).toBe(true);
    expect(isSendGateDecision('方案确认', {})).toBe(false);
  });
});

describe('引擎级：apply 闸门批准', () => {
  const mkApplyRun = (w: ReturnType<typeof makeEngine>, title: string, extraInput: Record<string, unknown> = {}) => {
    const wf = w.store.createWorkflow({
      kind: 'adhoc', title: 'feedback-apply',
      meta: { mode: 'nodes', template_input: { brief: 'feedback 工单' } },
    });
    const gate = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'gate', title });
    w.store.setStepInput(gate.id, { delivery: 'apply', plan: '改 site/about.html', ...extraInput });
    w.store.setStepStatus(gate.id, 'waiting_human');
    w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'send', title: '发送答复' });
    return { wf, gate };
  };

  it('批准=生效：遗留配对 send 被取消留痕，不播种、不跑发送', async () => {
    const w = makeEngine();
    const { wf, gate } = mkApplyRun(w, '方案确认');
    await w.engine.approve(gate.id, '可以', 'user');
    const send = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'send')!;
    expect(send.status).toBe('cancelled');
    const events = w.store.listEvents(500).map((e) => e.type);
    expect(events).toContain('send_retracted_delivery');
    expect(events).not.toContain('step_failed');
  });

  it('「发送」标题 + delivery=apply：不再被当发送决定（settle 不拒埋葬）', async () => {
    const w = makeEngine();
    const { wf, gate } = mkApplyRun(w, '发送闸门');
    await w.engine.approve(gate.id, '直接生效', 'user');
    await w.engine.settle(wf.id, 'user');
    expect(w.store.getWorkflow(wf.id)?.status).toBe('completed');
  });

  it('fail 级检查（客户邮件红线）不拦 apply 闸门批准', async () => {
    const w = makeEngine();
    const { gate } = mkApplyRun(w, '方案确认', {
      checks: [{ name: 'redline', status: 'fail', detail: '正文含红线词「工单」' }],
    });
    await expect(w.engine.approve(gate.id, '内部工单不受红线约束', 'user')).resolves.toBeUndefined();
  });

  it('对照：未申报 delivery 的「发送闸门」fail 检查照旧拦批准', async () => {
    const w = makeEngine();
    const wf = w.store.createWorkflow({
      kind: 'adhoc', title: 'email-run',
      meta: { mode: 'nodes', template_input: { brief: 'x' } },
    });
    const gate = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'gate', title: '发送闸门' });
    w.store.setStepInput(gate.id, { checks: [{ name: 'redline', status: 'fail', detail: 'x' }] });
    w.store.setStepStatus(gate.id, 'waiting_human');
    await expect(w.engine.approve(gate.id, '', 'user')).rejects.toThrow(/发送前置检查 fail/);
  });
});

describe('引擎级：feedback 单链尾自愈补闸（2026-09-21 深夜事故）', () => {
  // 契约断档形态：agent 按 brief 干完五段工单就收工（没按 skill 契约 POST
  // 确认闸节点）——单停在链尾 completed，人审面永远没有卡可批。
  const FB_BRIEF = '【feedback 工单】record rec1\n■ 原文：按钮中文直出\n'
    + '■ 闸门申报：input.delivery="apply"（批准=生效，直接动 site/）';

  const mkFeedbackRun = (w: ReturnType<typeof makeEngine>, brief: string, recordId = 'rec1') => {
    const wf = w.store.createWorkflow({
      kind: 'adhoc', title: '[feedback] Products · Card',
      status: 'running',
      meta: { mode: 'nodes', template_input: { brief, feedback_record_id: recordId } },
    });
    const step = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '理解与接单' });
    w.store.setStepInput(step.id, { plan: brief, session: 'juli-reply' });
    w.store.setStepStatus(step.id, 'running');
    w.store.createRun(wf.id, 'juli-reply');
    w.store.setWorkflowSession(wf.id, 'juli-reply');
    return { wf, step };
  };

  it('agent 收工未挂闸 → settle 时自动补挂确认闸，播种齐全并推进到人审', async () => {
    const w = makeEngine();
    const { wf } = mkFeedbackRun(w, FB_BRIEF);
    await w.engine.onAgentStopped('juli-reply', 'ok', '五段工单已产出工件，等待批准');
    await w.engine.advance(wf.id); // 排空补闸后的推进（pending → waiting_human）
    const steps = w.store.stepsForWorkflow(wf.id);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.status).toBe('completed');
    const gate = steps[1]!;
    expect(gate.kind).toBe('gate');
    expect(gate.title).toBe('确认闸门');
    expect(gate.status).toBe('waiting_human');
    expect(gate.input['delivery']).toBe('apply');
    expect((gate.input['envelope'] as Record<string, unknown>)['feedback_refs']).toEqual(['rec1']);
    // 播种齐全：闸门卡能看见 brief 与 agent 汇报（与手挂后被播种同形）。
    expect(gate.input['plan']).toBe(FB_BRIEF);
    expect(gate.input['output']).toBe('五段工单已产出工件，等待批准');
    expect(w.store.listEvents(500).map((e) => e.type)).toContain('feedback_gate_auto_appended');
  });

  it('brief 未申报 delivery=apply（非 apply 契约单）不补闸', async () => {
    const w = makeEngine();
    const { wf } = mkFeedbackRun(w, '【feedback 工单】record rec1\n■ 任务：挂载缺失，进人工清单');
    await w.engine.onAgentStopped('juli-reply', 'ok', 'page 缺失，进人工清单');
    expect(w.store.stepsForWorkflow(wf.id)).toHaveLength(1);
  });

  it('非 feedback 进件单（无 record 锚）不补闸', async () => {
    const w = makeEngine();
    const wf = w.store.createWorkflow({
      kind: 'adhoc', title: '普通 adhoc', status: 'running',
      meta: { mode: 'nodes', template_input: { brief: FB_BRIEF } },
    });
    const step = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '理解与接单' });
    w.store.setStepInput(step.id, { plan: FB_BRIEF, session: 'juli-reply' });
    w.store.setStepStatus(step.id, 'running');
    w.store.createRun(wf.id, 'juli-reply');
    await w.engine.onAgentStopped('juli-reply', 'ok', '汇报');
    expect(w.store.stepsForWorkflow(wf.id)).toHaveLength(1);
  });

  it('链上已有存活闸门（含已批准）不重复补挂', async () => {
    const w = makeEngine();
    const { wf, step } = mkFeedbackRun(w, FB_BRIEF);
    w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'gate', title: '确认闸门' });
    w.store.setStepInput(w.store.stepsForWorkflow(wf.id)[1]!.id, { delivery: 'apply' });
    w.store.setStepStatus(w.store.stepsForWorkflow(wf.id)[1]!.id, 'completed');
    void step;
    await w.engine.onAgentStopped('juli-reply', 'ok', '汇报');
    expect(w.store.stepsForWorkflow(wf.id).filter((s) => s.kind === 'gate')).toHaveLength(1);
  });

  it('启动回填：契约断档期停在链尾的 feedback 单补挂确认闸', async () => {
    const w = makeEngine();
    const wf = w.store.createWorkflow({
      kind: 'adhoc', title: '[feedback] stuck', status: 'running',
      meta: { template_input: { brief: FB_BRIEF, feedback_record_id: 'rec2' } },
    });
    const step = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '理解与接单' });
    w.store.setStepInput(step.id, { plan: FB_BRIEF });
    w.store.setStepOutput(step.id, { session: 'juli-reply', output: '历史汇报' });
    w.store.setStepStatus(step.id, 'completed');
    await w.engine.reconcileStartup();
    await w.engine.advance(wf.id);
    const steps = w.store.stepsForWorkflow(wf.id);
    expect(steps).toHaveLength(2);
    const gate = steps[1]!;
    expect(gate.kind).toBe('gate');
    expect(gate.status).toBe('waiting_human');
    expect(gate.input['delivery']).toBe('apply');
    // settle 路径的播种已错过——回填手动把已结算步的产出搬进闸门。
    expect(gate.input['output']).toBe('历史汇报');
    expect(w.store.listEvents(500).map((e) => e.type)).toContain('feedback_gate_backfilled');
  });
});

describe('引擎级：apply 链自动收口（证据=Makro 工件 / feedback 回挂）', () => {
  const APPLY_BRIEF = '【feedback 工单】record rec9\n■ 闸门申报：input.delivery="apply"（批准=生效）';

  const mkCompletedApplyRun = (w: ReturnType<typeof makeEngine>, recordId = 'rec9') => {
    const wf = w.store.createWorkflow({
      kind: 'adhoc', title: '[feedback] done', status: 'running',
      meta: { mode: 'nodes', template_input: { brief: APPLY_BRIEF, feedback_record_id: recordId } },
    });
    const step = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '理解与接单' });
    w.store.setStepInput(step.id, { plan: APPLY_BRIEF });
    w.store.setStepOutput(step.id, { output: '修复已完成' });
    w.store.setStepStatus(step.id, 'completed');
    const gate = w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'gate', title: '确认闸门' });
    w.store.setStepInput(gate.id, { delivery: 'apply', envelope: { feedback_refs: [recordId] } });
    w.store.setStepStatus(gate.id, 'completed');
    return { wf, gate };
  };

  it('证据①回挂答复：镜像里有 reply_to=record 的记录 → 自动结算', async () => {
    const w = makeEngine();
    const { wf } = mkCompletedApplyRun(w);
    w.store.db.exec('CREATE TABLE IF NOT EXISTS feedback_mirror (id TEXT PRIMARY KEY, reply_to TEXT)');
    w.store.db.prepare("INSERT INTO feedback_mirror (id, reply_to) VALUES ('rep1', ?)").run('rec9');
    await w.engine.autoSettleFeedbackRuns();
    expect(w.store.getWorkflow(wf.id)?.status).toBe('completed');
  });

  it('证据②Makro 工件：闸门名下登记的执行工件 → 先补扫 case-inbox 再结算', async () => {
    const sweeps: [string, string | undefined][] = [];
    let gateId = '';
    const w = makeEngine({
      artifacts: {
        list: () => gateId === ''
          ? []
          : [{ id: 'a1', name: 'fix.html', key: 'k', stepId: gateId, deletedAt: null, meta: {} }],
        updateMeta: () => undefined,
        sweepCaseInbox: async (wf: string, stepId?: string) => {
          sweeps.push([wf, stepId]);
          return { count: 0, entries: [], envelope: null, warnings: [], has_manifest: false };
        },
      },
    });
    const { wf, gate } = mkCompletedApplyRun(w);
    gateId = gate.id; // mock 闭包在建单后才知道闸门 id
    await w.engine.autoSettleFeedbackRuns();
    expect(w.store.getWorkflow(wf.id)?.status).toBe('completed');
    expect(sweeps.some(([wf2, st2]) => wf2 === wf.id && st2 === gate.id)).toBe(true);
  });

  it('无证据不收：链终态+闸已批但没有工件也没有回挂 → 仍 running', async () => {
    const w = makeEngine();
    const { wf } = mkCompletedApplyRun(w);
    await w.engine.autoSettleFeedbackRuns();
    expect(w.store.getWorkflow(wf.id)?.status).toBe('running');
  });
});
