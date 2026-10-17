// R5-FX 回归（wf_16454623bf49/wf_7c9c9eeb51e1 两代事故，B 点）：settle 播种
// 不得整包顶掉 agent 收工前挂闸申报的 envelope{to,subject}——sweep 剥离版
// envelope 经 setStepInput 浅合并整键替换，申报被冲，approve 播种 send.to=''
// 必撞 no_recipient。合并语义=申报键优先、sweep 线程提示只补缺（与 openGate
// 携带侧 steps.ts 按键合并对称）；本路径 settle 已喂 deliverables，openGate
// 携带分支因「已带 deliverables」恒不执行——两点正交，本用例专闭播种侧。
import { describe, expect, it } from 'vitest';
import { makeEngine, makeEmail } from './helpers.ts';
import type { ArtifactPort } from '../src/contracts/ports.ts';

describe('settle 播种 envelope：申报优先、sweep 补缺', () => {
  it('挂闸申报 to/subject → agent 收工 settle 播种后申报仍在，approve 播种 send.to=申报值', async () => {
    // sweep 桩返回真实收编形状：deliverables + parseEnvelope 剥离版 envelope
    // （只剩线程提示键，结构性无 to/subject）——与生产 sweepCaseInbox 一致。
    const artifacts: ArtifactPort = {
      list: () => [],
      updateMeta: () => {},
      getContent: async () => null,
      sweepCaseInbox: async () => ({
        count: 1,
        entries: [
          { id: 'art_rep', name: 'r.html', view_role: 'report', sha256: 'sha-rep', bytes: 5, summary: '' },
        ],
        envelope: { in_reply_to_hint: '<thread-1@example.com>', feedback_refs: ['fb-1'] },
        warnings: [],
        has_manifest: true,
      }),
    };
    const w = makeEngine({
      routing: { defaultSession: 'agent-a', defaultProject: 'proj-x' },
      availableSessions: ['agent-a'],
      artifacts,
      caseInboxDir: () => '/tmp/case-inbox',
    });
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    // 本用例考任务流申报链：startEmailWorkflow 自带 meta.from（回信流）会按
    // P0 防注入锁定原发件人、申报 to 被有意忽略——抹掉 from 转成任务流形态
    // （与生产任务流申报强制 lifecycle.ts 前置校验同一前提）。
    w.store.updateWorkflowMeta(wf.id, { from: null });
    await w.engine.advance(wf.id); // agent 步已派发 running
    // agent 收工前挂闸申报（任务流契约：无原始发件人必须申报 envelope.to）。
    await w.engine.appendNode(wf.id, {
      kind: 'gate', title: '发送答复',
      input: {
        envelope: { to: 'client@example.com', subject: '进展通报' },
        checks: [{ name: 'redline', status: 'pass', detail: '' }],
      },
    });
    await w.engine.onAgentStopped('agent-a', 'done', '做完了'); // settle 播种
    await w.engine.advance(wf.id); // 开闸：此时闸门已带 deliverables，携带分支不执行
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    expect(gate.status).toBe('waiting_human');
    // 申报 to/subject 不得被 sweep 剥离版顶掉；线程提示键补缺在位。
    expect(gate.input['envelope']).toMatchObject({
      to: 'client@example.com', subject: '进展通报',
      in_reply_to_hint: '<thread-1@example.com>', feedback_refs: ['fb-1'],
    });
    await w.engine.approve(gate.id, '批', 'user');
    const send = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'send')!;
    expect(send.input['to']).toBe('client@example.com');
    expect(send.input['subject']).toBe('进展通报');
  });
});
