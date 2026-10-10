// 邮件流二轮修复回归（2026-09-15 断点六/七/八/九/十/十一）：
// ① send 无 body_ref → body_contract_missing 拒发（断点九①铁律：nodes 模式
//   正文只认 manifest body 工件，会话汇报文本一律不得作正文）；
// ② send 有 body_ref → 哈希取件照发（契约路径不回归）；
// ③ 同单第二封 send → duplicate_send 拒发（断点六②最后一道闸，双发事故）；
// ④ appendNode 建 send 按 kind 去重——不同 title 也拦（断点六①）；
// ⑤ cancelStep：pending/waiting_human 可取消，running/终态拒绝（断点六③）；
// ⑥ completeAgentStep 播种 plan 键位回填 prompt（断点七）；
// ⑦ 附件只随 attachment/data——report 人审视图绝不附上（断点八）；
// ⑧ 红线词表 skill §2 全集机器化 + 英文词 \b 词边界（断点九②）；
// ⑨ envelope.cc → 种子 → mailer（断点十）；
// ⑩ step_failed 失败即推 pusher.stepFailed（断点十一①）；
// ⑪ 播种断链确定性自愈一次 + 失败诊断带 input.keys（断点十一②/七）。
//
// 断言时序约定同 engine.test.ts：`await engine.advance(id)` 排到锁链尾。

import { describe, expect, it } from 'vitest';
import { makeEngine, makeEmail, until } from './helpers.ts';
import type { EngineDeps } from '../src/business/workflow/engine.ts';
import type { ArtifactPort, MailerPort, PusherPort } from '../src/contracts/ports.ts';
import { DEFAULT_REDLINE_WORDS, redlineHit } from '../src/business/send/sendChecks.ts';
import { ok } from '@juli-os/artifacts';

const BODY_TEXT = '契约正文：上月销量表已发出，请查收。';
const BODY_SHA = 'aa87b223ef100a38803f1c362ad3007562ec247aa90f86fafa8c190c84cb921d';

const contractArtifacts = (extra: Record<string, { bytes: Buffer; sha256: string; name: string; viewRole: string }> = {}): ArtifactPort => ({
  list: () => [],
  updateMeta: () => {},
  getContent: async (id) => {
    if (id === 'art_body') return { bytes: Buffer.from(BODY_TEXT), sha256: BODY_SHA, name: 'b.txt', viewRole: 'body' };
    return extra[id] ?? null;
  },
  sweepCaseInbox: async () => ({ count: 0, entries: [], envelope: null, warnings: [], has_manifest: false }),
});

/** 动态进件（nodes 模式）+ 默认会话派发：agent 步 running 的最短路径。 */
const startIntake = async (over: Partial<EngineDeps> = {}) => {
  const w = makeEngine({
    routing: { defaultSession: 'agent-a', defaultProject: 'proj-x' },
    availableSessions: ['agent-a'],
    ...over,
  });
  const wf = await w.engine.startEmailWorkflow(makeEmail());
  await w.engine.advance(wf.id);
  return { w, wf };
};

/** nodes 模式最小发送链：已批准闸门 + pending send 步（input 由调用方钉）。 */
const nodesSendWorld = (over: Partial<EngineDeps> = {}) => {
  const w = makeEngine(over);
  const wf = w.store.createWorkflow({
    kind: 'email', title: '二轮修复单', status: 'running',
    meta: { from: 'boss@example.com', mode: 'nodes' },
  });
  const gate = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'gate', title: '发送闸门', input: {} });
  w.store.setStepStatus(gate.id, 'completed');
  return { w, wf };
};

describe('① 断点九①铁律：nodes 模式 send 无 body_ref → 拒发', () => {
  it('input.body 内联文本不再被采用：body_contract_missing 拒发 + 盲重试被拒', async () => {
    const { w, wf } = nodesSendWorld();
    const send = w.store.createStep({
      workflowId: wf.id, seq: 2, kind: 'send', title: '发送',
      input: { body: '这是 agent 的会话汇报文本，不是正文。', in_reply_to: '<x@q>' },
    });
    await w.engine.advance(wf.id);
    const st = w.store.getStep(send.id)!;
    expect(st.status).toBe('failed');
    expect(st.output['guard']).toBe('body_contract_missing');
    expect(String(st.output['error'])).toContain('正文无契约工件');
    expect(w.sent).toHaveLength(0);
    const evs = w.store.listEvents(200).filter((e) => e.type === 'step_failed');
    expect(evs.some((e) => e.payload['guard'] === 'body_contract_missing')).toBe(true);
    await expect(w.engine.retry(send.id)).rejects.toThrow(/盲重试不会变好/);
  });
});

describe('② 契约路径不回归：send 有 body_ref → 哈希取件照发', () => {
  it('body_ref 指向 body 工件 → 按哈希取字节发出，body_via 记账', async () => {
    const { w, wf } = nodesSendWorld({ artifacts: contractArtifacts() });
    w.store.createStep({
      workflowId: wf.id, seq: 2, kind: 'send', title: '发送',
      input: {
        body_ref: { id: 'art_body', sha256: BODY_SHA, name: 'b.txt' },
        deliverables: [{ id: 'art_body', name: 'b.txt', view_role: 'body', sha256: BODY_SHA }],
        in_reply_to: '<x@q>',
      },
    });
    await w.engine.advance(wf.id);
    const send = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'send')!;
    expect(send.status).toBe('completed');
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.body).toContain('上月销量表已发出');
    expect(String(send.output['body_via'])).toBe('artifact:art_body');
  });
});

describe('③ 断点六②：同单第二封 send → duplicate_send 拒发', () => {
  it('另一 send 已 completed → 第二封在闸口被打掉（即便种子/正文齐全）', async () => {
    const { w, wf } = nodesSendWorld({ artifacts: contractArtifacts() });
    const first = w.store.createStep({
      workflowId: wf.id, seq: 2, kind: 'send', title: '发送答复',
      input: { body_ref: { id: 'art_body', sha256: BODY_SHA, name: 'b.txt' } },
    });
    w.store.setStepStatus(first.id, 'completed');
    const second = w.store.createStep({
      workflowId: wf.id, seq: 3, kind: 'send', title: '发送',
      input: { body_ref: { id: 'art_body', sha256: BODY_SHA, name: 'b.txt' } },
    });
    await w.engine.advance(wf.id);
    const st = w.store.getStep(second.id)!;
    // 第 5 轮审查：多余节点直接置 cancelled（拒发是正确守卫动作而非失败）——
    // 不再翻整单 failed，也不误推 step_failed。
    expect(st.status).toBe('cancelled');
    expect(st.output['guard']).toBe('duplicate_send');
    expect(String(st.output['cancel_note'])).toContain('本单已有一封发出');
    const evs = w.store.listEvents(200).filter((e) => e.type === 'step_cancelled' && e.entityId === second.id);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload['guard']).toBe('duplicate_send');
    expect(w.sent).toHaveLength(0);
    // 整单不被翻成 failed（cancelled 是终态而非错误）。
    expect(w.store.getWorkflow(wf.id)!.status).toBe('running');
  });
});

describe('④ 断点六①：appendNode 建 send 按 kind 去重（不看 title）', () => {
  it('已有 pending「发送答复」→ 再 POST「发送」返回既有节点，不新建', async () => {
    const w = makeEngine();
    const wf = w.store.createWorkflow({
      kind: 'email', title: '去重单', status: 'running',
      meta: { from: 'boss@example.com', mode: 'nodes' },
    });
    const gate = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'gate', title: '发送闸门', input: {} });
    w.store.setStepStatus(gate.id, 'completed');
    const existing = w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'send', title: '发送答复', input: {} });
    const ret = await w.engine.appendNode(wf.id, { kind: 'send', title: '发送' });
    expect(ret.id).toBe(existing.id); // title 不同也拦——撞车的正是历史事故形状
    expect(w.store.stepsForWorkflow(wf.id).filter((s) => s.kind === 'send')).toHaveLength(1);
  });

  it('已有 completed 的 send → 同样返回既有节点，绝不出现第二封', async () => {
    const w = makeEngine();
    const wf = w.store.createWorkflow({
      kind: 'email', title: '去重单二', status: 'running',
      meta: { from: 'boss@example.com', mode: 'nodes' },
    });
    const gate = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'gate', title: '发送闸门', input: {} });
    w.store.setStepStatus(gate.id, 'completed');
    const done = w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'send', title: '发送答复', input: {} });
    w.store.setStepStatus(done.id, 'completed');
    const ret = await w.engine.appendNode(wf.id, { kind: 'send', title: '补发' });
    expect(ret.id).toBe(done.id);
    expect(w.store.stepsForWorkflow(wf.id).filter((s) => s.kind === 'send')).toHaveLength(1);
  });
});

describe('⑤ 断点六③：cancelStep 单步合规取消', () => {
  it('pending send 取消 → cancelled + step_cancelled 事件 + output 标记', async () => {
    const { w, wf } = nodesSendWorld();
    const send = w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'send', title: '多余的重复发送', input: {} });
    await w.engine.cancelStep(send.id, 'auto-pair 撞车产生的重复节点', 'boss');
    const st = w.store.getStep(send.id)!;
    expect(st.status).toBe('cancelled');
    expect(st.output['cancelled_by']).toBe('boss');
    expect(st.output['cancel_note']).toContain('重复节点');
    const evs = w.store.listEvents(200).filter((e) => e.type === 'step_cancelled' && e.entityId === send.id);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toMatchObject({ by: 'boss', workflow_id: wf.id });
  });

  it('waiting_human 闸门可取消；running 与终态拒绝', async () => {
    const { w, wf } = nodesSendWorld();
    const gate2 = w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'gate', title: '复核闸门', input: {} });
    w.store.setStepStatus(gate2.id, 'waiting_human');
    await w.engine.cancelStep(gate2.id, '不审了', 'boss');
    expect(w.store.getStep(gate2.id)!.status).toBe('cancelled');

    const agent = w.store.createStep({ workflowId: wf.id, seq: 3, kind: 'agent', title: '在跑步', input: {} });
    w.store.setStepStatus(agent.id, 'running');
    await expect(w.engine.cancelStep(agent.id, '', 'boss')).rejects.toThrow(/only pending\/waiting_human/);

    const done = w.store.createStep({ workflowId: wf.id, seq: 4, kind: 'send', title: '已发', input: {} });
    w.store.setStepStatus(done.id, 'completed');
    await expect(w.engine.cancelStep(done.id, '', 'boss')).rejects.toThrow(/cancelled/);
    expect(w.store.getStep(done.id)!.status).toBe('completed'); // 终态不可翻
  });
});

describe('⑥ 断点七：completeAgentStep 播种 plan 键位回填 prompt', () => {
  it('理解步只有 prompt 键 → 播种 plan 是渲染后的具体文本（不派发 {{…}} 占位符）', async () => {
    const { w, wf } = await startIntake();
    // 收编步不带 plan/prompt——全靠上游播种。
    await w.engine.appendNode(wf.id, { kind: 'agent', title: '交付收编', input: { session: 'agent-a' } });
    await w.engine.onAgentStopped('agent-a', 'done', '结构化理解完成');
    await w.engine.advance(wf.id);
    const s2 = w.store.stepsForWorkflow(wf.id)[1]!;
    // 第 5 轮审查 P1：回退的 prompt 是未渲染模板（INTAKE_PROMPT），播种前必须
    // 渲染成具体文本——下游拿到原文，不是字面 {{.Input.*}} 占位符。
    expect(String(s2.input['plan'])).toContain('阅读下面这封来信'); // 模板骨架在
    expect(String(s2.input['plan'])).not.toContain('{{');           // 占位符已代入
    expect(String(s2.input['plan'])).toContain('帮忙统计上月销量'); // Input.subject
    expect(String(s2.input['plan'])).toContain('请把上月的销量数据整理成表格发我。'); // Input.body
    await until(() => w.dispatched.length >= 2);
    expect(w.dispatched[1]!.text).toContain('阅读下面这封来信'); // 已带着 plan 派发
    expect(w.dispatched[1]!.text).not.toContain('{{');
  });
});

describe('⑦ 断点八：附件只随 attachment/data，report 绝不附上', () => {
  it('deliverables 混合四角色 → 只附 data/attachment，report 留在闸门', async () => {
    const attached: { name: string }[][] = [];
    const w = makeEngine({
      mailer: {
        async send(cmd) {
          attached.push((cmd.attachments ?? []).map((a) => ({ name: a.name })));
          return ok({ messageId: '<mix@juli.local>' });
        },
      } satisfies MailerPort,
      artifacts: contractArtifacts({
        art_rep: { bytes: Buffer.from('<html>人审视图</html>'), sha256: 'sha-rep', name: 'r.html', viewRole: 'report' },
        art_data: { bytes: Buffer.from('csv,bytes'), sha256: 'sha-data', name: 'd.csv', viewRole: 'data' },
        art_att: { bytes: Buffer.from('%PDF'), sha256: 'sha-att', name: 'a.pdf', viewRole: 'attachment' },
      }),
    });
    const wf = w.store.createWorkflow({
      kind: 'email', title: '附件角色单', status: 'running',
      meta: { from: 'boss@example.com', mode: 'nodes' },
    });
    const gate = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'gate', title: '发送闸门', input: {} });
    w.store.setStepStatus(gate.id, 'completed');
    w.store.createStep({
      workflowId: wf.id, seq: 2, kind: 'send', title: '发送',
      input: {
        body_ref: { id: 'art_body', sha256: BODY_SHA, name: 'b.txt' },
        deliverables: [
          { id: 'art_body', name: 'b.txt', view_role: 'body', sha256: BODY_SHA },
          { id: 'art_rep', name: 'r.html', view_role: 'report', sha256: 'sha-rep' },
          { id: 'art_data', name: 'd.csv', view_role: 'data', sha256: 'sha-data' },
          { id: 'art_att', name: 'a.pdf', view_role: 'attachment', sha256: 'sha-att' },
        ],
        in_reply_to: '<x@q>',
      },
    });
    await w.engine.advance(wf.id);
    const send = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'send')!;
    expect(send.status).toBe('completed');
    expect(attached).toHaveLength(1);
    expect(attached[0]!.map((a) => a.name).sort()).toEqual(['a.pdf', 'd.csv']); // report 不在
  });
});

describe('⑧ 断点九②：红线词表 skill §2 全集', () => {
  it('正文含「闸门」→ 拒发（guard redline）', async () => {
    const w = makeEngine();
    const wf = w.store.createWorkflow({
      kind: 'email', title: '红线单', status: 'running', meta: { from: 'boss@example.com' },
    });
    const gate = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'gate', title: '发送决定', input: {} });
    w.store.setStepStatus(gate.id, 'completed');
    w.store.createStep({
      workflowId: wf.id, seq: 2, kind: 'send', title: '发送',
      input: { body: '详见内部闸门安排。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。', in_reply_to: '<x@q>' },
    });
    await w.engine.advance(wf.id);
    const send = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'send')!;
    expect(send.status).toBe('failed');
    expect(send.output['guard']).toBe('redline');
    expect(w.sent).toHaveLength(0);
  });

  it('redlineHit：英文词 \b 词边界 + 大小写不敏感；不误伤子串；send 不入表', () => {
    const words = DEFAULT_REDLINE_WORDS;
    expect(redlineHit('已收编到 case-inbox，等待 intake。', words)).toBe('收编');
    expect(redlineHit('用 Workflow 管理这个需求', words)).toBe('workflow'); // 大写也拦
    expect(redlineHit('我在用 workflowy 记笔记', words)).toBeUndefined(); // 词边界不误伤
    expect(redlineHit('feedback_id 见附页', words)).toBe('feedback_id');
    expect(redlineHit('这条 needs_reply 的邮件请处理', words)).toBe('needs_reply');
    expect(redlineHit('请把回执 send 给我', words)).toBeUndefined(); // send 太常见，刻意不入表
    expect(redlineHit('正文干净。', words)).toBeUndefined();
  });
});

describe('⑨ 断点十：envelope.cc → 种子 → mailer', () => {
  it('闸门申报单 envelope 声明 cc → 批准播种 → 发送带上抄送并落账（任务流 nodes+契约正文）', async () => {
    const sent: { to: string; cc?: readonly string[] }[] = [];
    // 09-20 P3 翻转：envelope 申报（to/subject/cc）统一只在 nodes 模式生效；
    // 09-20 P1 再翻转（PROBLEMS-R2 回信流收口）：meta.from 在位=回信流，
    // 申报 cc/subject 全锁（不进实发，envelope_cc_override_ignored 留痕）。
    // cc 链路覆盖因此锚定任务流（from 空、收件人=申报 envelope.to），
    // 回信流锁定语义由 weekly-fixes「P1 回信流信封收口」三例钉住。
    const BODY = '答复正文如下。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。';
    const BODY_SHA = '14d9de43dadda3e66b9aac2bd4c4629af4619c869362af42ea6a2b637cceebd5';
    const w = makeEngine({
      mailer: {
        async send(cmd) {
          sent.push({ to: cmd.to, cc: cmd.cc });
          return ok({ messageId: '<cc@juli.local>' });
        },
      } satisfies MailerPort,
      artifacts: {
        list: () => [], updateMeta: () => {},
        getContent: async (id) => id === 'art_body'
          ? { bytes: Buffer.from(BODY), sha256: BODY_SHA, name: 'b.txt', viewRole: 'body' }
          : null,
        sweepCaseInbox: async () => ({ count: 0, entries: [], envelope: null, warnings: [], has_manifest: false }),
      },
    });
    const wf = w.store.createWorkflow({
      kind: 'adhoc', title: '抄送单', status: 'running',
      meta: { mode: 'nodes' }, // 任务流：from 空（回信流不认申报 cc）
    });
    const gate = w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'gate', title: '发送决定',
      input: {
        deliverables: [{ id: 'art_body', name: 'b.txt', view_role: 'body', sha256: BODY_SHA }],
        body_ref: { id: 'art_body', sha256: BODY_SHA, name: 'b.txt' },
        envelope: { to: 'casey@example.com', cc: ['lead@example.com', '   ', 42] }, // 异形项被过滤
      },
    });
    w.store.setStepStatus(gate.id, 'waiting_human');
    w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'send', title: '发送', input: {} });
    await w.engine.approve(gate.id, '抄送一份', 'boss');
    await w.engine.advance(wf.id);
    const send = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'send')!;
    expect(send.status).toBe('completed');
    expect(sent[0]!.to).toBe('casey@example.com');          // 任务流收件人=申报 to
    expect(send.input['cc']).toEqual(['lead@example.com']); // 种子侧落键
    expect(sent[0]!.cc).toEqual(['lead@example.com']);      // mailer 侧收到
    const ev = w.store.listEvents(200).find((e) => e.type === 'email_sent');
    expect(ev!.payload['cc']).toEqual(['lead@example.com']); // 落账留痕
  });
});

describe('⑩ 断点十一①：step_failed 失败即推', () => {
  it('派发失败 → pusher.stepFailed 收到（workflowId + 原因）', async () => {
    const failures: { workflowId: string; stepId: string; reason: string }[] = [];
    const pusher: PusherPort = {
      async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {},
      async stepFailed(wf, st, reason) { failures.push({ workflowId: wf.id, stepId: st.id, reason }); },
    };
    const w = makeEngine({
      routing: { defaultSession: 'agent-a', defaultProject: 'proj-x' },
      availableSessions: ['agent-a'],
      dispatch: { async dispatch() { return { ok: false as const, error: new Error('tmux down') }; } },
      pusher,
    });
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await w.engine.advance(wf.id);
    await until(() => failures.length === 1);
    expect(failures[0]!.workflowId).toBe(wf.id);
    expect(failures[0]!.reason).toContain('tmux down');
    const st = w.store.stepsForWorkflow(wf.id)[0]!;
    expect(st.status).toBe('failed');
    expect(w.store.getWorkflow(wf.id)!.status).toBe('failed');
  });

  it('pusher 无 stepFailed（mock 缺省）→ 失败照常结算，不炸', async () => {
    const { w, wf } = await startIntake({
      dispatch: { async dispatch() { return { ok: false as const, error: new Error('tmux down') }; } },
    });
    await w.engine.advance(wf.id);
    expect(w.store.stepsForWorkflow(wf.id)[0]!.status).toBe('failed');
  });
});

describe('⑪ 断点十一②：播种断链确定性自愈（一次）', () => {
  it('session 有着落而 plan 空、无 prompt 兜底 → 从上游步取值重臂，留 step_self_heal', async () => {
    const { w, wf } = await startIntake();
    const up = w.store.stepsForWorkflow(wf.id)[0]!; // 理解步
    w.store.setStepInput(up.id, { plan: '上游计划：整理销量表' });
    // 收编节点在结算【之后】才追加——断点七的现实形态：播种没赶上（旧账本
    // 存量流/后补节点），本步 input 既无 plan 也无 prompt。
    await w.engine.onAgentStopped('agent-a', 'done', '理解完成');
    await w.engine.advance(wf.id);
    const heal = await w.engine.appendNode(wf.id, { kind: 'agent', title: '交付收编', input: { session: 'agent-a' } });
    // 自愈：plan 从上游步 input.plan 回填（不靠人裁），重臂派发。
    const st = w.store.getStep(heal.id)!;
    expect(st.output['self_healed']).toBe(true);
    expect(st.input['plan']).toBe('上游计划：整理销量表');
    const evs = w.store.listEvents(200).filter((e) => e.type === 'step_self_heal' && e.entityId === heal.id);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload['from_seq']).toBe(1);
    await until(() => w.dispatched.length >= 2);
    expect(w.dispatched[1]!.text).toContain('上游计划：整理销量表');
  });

  it('上游也断链（plan/prompt 全空）→ 不自愈直接 failed，诊断带上本步 input.keys', async () => {
    const w = makeEngine({
      routing: { defaultSession: 'agent-a', defaultProject: 'proj-x' },
      availableSessions: ['agent-a'],
    });
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '断链单', status: 'running', meta: { mode: 'nodes' } });
    const up = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '上游', input: { session: 'agent-a', mark: 'x' } });
    w.store.setStepStatus(up.id, 'completed');
    const s2 = w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'agent', title: '交付收编', input: { session: 'agent-a' } });
    await w.engine.advance(wf.id);
    expect(w.store.getStep(s2.id)!.status).toBe('failed');
    const err = String(w.store.getStep(s2.id)!.output['error']);
    expect(err).toContain('上游播种检查');
    expect(err).toContain('input.keys=[');
    expect(err).toContain('session'); // 键位列表可定位上游播种断链
  });

  it('自愈回退上游未渲染 prompt 模板 → 渲染成具体文本再落 plan（第 5 轮 P1）', async () => {
    const { w, wf } = await startIntake();
    // 理解步只有 prompt 键（INTAKE_PROMPT 未渲染模板）；收编节点在结算【之后】
    // 才追加——播种没赶上，自愈从上游 prompt 回退，必须渲染后落 plan。
    await w.engine.onAgentStopped('agent-a', 'done', '理解完成');
    await w.engine.advance(wf.id);
    const heal = await w.engine.appendNode(wf.id, { kind: 'agent', title: '交付收编', input: { session: 'agent-a' } });
    const st = w.store.getStep(heal.id)!;
    expect(st.output['self_healed']).toBe(true);
    expect(String(st.input['plan'])).toContain('阅读下面这封来信');
    expect(String(st.input['plan'])).not.toContain('{{');
    expect(String(st.input['plan'])).toContain('帮忙统计上月销量'); // Input.subject 已代入
    const evs = w.store.listEvents(200).filter((e) => e.type === 'step_self_heal' && e.entityId === heal.id);
    expect(evs).toHaveLength(1);
  });
});
