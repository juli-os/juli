// 对齐锁定（gates.test.ts 同款纪律，R6-R1 P2-2）：envelope「申报优先按键
// 合并」在两处生产实现里逐字复制——agentSettle.ts completeAgentStep 的 settle
// 播种侧与 steps.ts openGate 的携带侧，而第三通道 reconcile.ts 曾实际漂移
// （R6-R1 P2-1：后写胜整包顶掉锚，即复制无锁定的漂移实证）。本文件对同一
// 输入形状驱动两条真实引擎路径各跑一遍，断言合并产物逐键一致——任一侧未来
// 单侧改动（整包顶掉回潮 / 展开序翻转）即红，漂移不再可能静默。
// 三形状各锁一类漂移：①键不相交（申报 to/subject + swept 线程两键）锁
// 「整包顶掉」事故类（wf_16454623bf49/wf_7c9c9eeb51e1）；②锚键重叠
// （feedback_refs 双方都有）锁展开序漂移——序一翻锚即被自报顶掉；③无申报
// 锁「swept 整包原样」存量不变量（回信流行为零变）。
// 与 settle-envelope-declared / gate-envelope-carry 两文件互补：那两处锁各
// 自路径的绝对行为（含 approve 播种链），本文件只锁两路径的相对一致。
import { describe, expect, it } from 'vitest';
import { makeEngine, makeEmail } from './helpers.ts';
import type { JsonRecord } from '@juli-os/artifacts';
import type { ArtifactPort } from '../src/contracts/ports.ts';

/** 三形状输入面：declared=闸门定义时申报（gate.input.envelope，undefined=
 * 未申报）；swept=sweep 剥离版（parseEnvelope 恒两键收编形状）；merged=
 * 两侧都必须产出的合并结果。 */
const SHAPES: ReadonlyArray<readonly [string, {
  title: string;
  declared?: JsonRecord;
  merged: JsonRecord;
}]> = [
  ['①键不相交：申报 to/subject + swept 线程两键', {
    title: '发送答复',
    declared: { to: 'client@example.com', subject: '进展通报' },
    merged: {
      to: 'client@example.com', subject: '进展通报',
      in_reply_to_hint: '<thread-1@example.com>', feedback_refs: ['fb-1'],
    },
  }],
  ['②锚键重叠：申报仅 feedback_refs 锚 + swept 自报同键', {
    title: '确认闸门',
    declared: { feedback_refs: ['rec-anchor'] },
    merged: { in_reply_to_hint: '<thread-1@example.com>', feedback_refs: ['rec-anchor'] },
  }],
  ['③无申报：维持 swept 整包原样', {
    title: '确认闸门',
    merged: { in_reply_to_hint: '<thread-1@example.com>', feedback_refs: ['fb-1'] },
  }],
];

/** 路径甲（settle 播种侧，agentSettle.ts）：真引擎 + sweep 桩返回剥离版；
 * agent 收工前挂闸申报 → onAgentStopped settle 合并进闸门 input（本路径
 * settle 已喂 deliverables，openGate 携带分支因「已带 deliverables」恒不
 * 执行——合并产物纯出自 settle 侧）。 */
const settleSideEnvelope = async (
  title: string, declared?: JsonRecord,
): Promise<unknown> => {
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
  // 抹 from 转任务流形态（与 lifecycle 定义时强制申报同一前提，两代事故的
  // 申报链前提）；申报面由 declared 参数给出。
  w.store.updateWorkflowMeta(wf.id, { from: null });
  await w.engine.advance(wf.id); // agent 步已派发 running
  await w.engine.appendNode(wf.id, {
    kind: 'gate', title,
    input: { ...(declared === undefined ? {} : { envelope: declared }) },
  });
  await w.engine.onAgentStopped('agent-a', 'done', '做完了'); // settle 播种合并
  await w.engine.advance(wf.id); // 开闸
  const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
  return gate.input['envelope'];
};

/** 路径乙（openGate 携带侧，steps.ts）：迟到闸门流——settle 已错过该闸，
 * 前步 output 载同一剥离版，advance 开闸时携带合并（同形状同值）。 */
const carrySideEnvelope = async (
  title: string, declared?: JsonRecord,
): Promise<unknown> => {
  const w = makeEngine();
  const wf = w.store.createWorkflow({
    kind: 'adhoc', title: 'alignment-carry',
    meta: { mode: 'nodes', template_input: { brief: '对齐' } },
  });
  const prev = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '执行' });
  w.store.setStepOutput(prev.id, {
    output: '已完成',
    deliverables: [{ file: 'review.html', role: 'report', summary: '对照表' }],
    envelope: { in_reply_to_hint: '<thread-1@example.com>', feedback_refs: ['fb-1'] },
  });
  w.store.setStepStatus(prev.id, 'completed');
  const gate = w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'gate', title });
  w.store.setStepInput(gate.id, {
    ...(declared === undefined ? {} : { envelope: declared }),
    plan: '发送对照表',
    checks: [{ name: 'redline', status: 'pass', detail: '' }],
  });
  w.store.createStep({ workflowId: wf.id, seq: 3, kind: 'send', title: '发送答复' });
  w.store.setWorkflowStatus(wf.id, 'running');
  await w.engine.advance(wf.id); // openGate：deliverables + envelope 携带
  return w.store.getStep(gate.id)!.input['envelope'];
};

describe('envelope 申报优先合并：settle 播种侧与 openGate 携带侧对齐锁定', () => {
  for (const [name, { title, declared, merged }] of SHAPES) {
    it(`${name}：两路径同输入 → 同合并产物`, async () => {
      const fromSettle = await settleSideEnvelope(title, declared);
      const fromCarry = await carrySideEnvelope(title, declared);
      expect(fromSettle).toEqual(merged);
      expect(fromCarry).toEqual(merged);
    });
  }
});
