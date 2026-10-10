// cockpit 集成补课的锁定测试（makro 集成 juli cockpit 会话遗留的后端欠账）：
// ① intervene 一等插话——投递+三处留痕，非 running/投递失败拒落账；
// ② 节点时序——started_at/completed_at 随状态转变落列，goShape 真数据外送。

import { describe, expect, it } from 'vitest';
import { createLedgerStore } from '@juli-os/ledger';
import { stepToGo } from '../src/platform/shared/goShape.ts';
import { fixedClock, makeClock, makeEmail, seqIds } from './helpers.ts';
import { createEngine, type Engine, type EngineDeps } from '../src/business/workflow/engine.ts';
import { parseTemplate } from '../src/business/templates/template.ts';
import { ok, type Result } from '@juli-os/artifacts';
import type { LlmPort, MailerPort, PusherPort } from '../src/contracts/ports.ts';

const NODES_YAML = `key: adhoc-nodes
name: 人肉单容器
trigger: manual
mode: nodes
steps: []
`;
const FLOW_YAML = `key: intervene-flow
name: 插话测试流
trigger: email
steps:
  - id: work
    kind: agent
    session: agent-a
    title: 执行
    prompt: 干活。
  - id: gate1
    kind: gate
    title: 闸门
  - id: send1
    kind: send
    title: 发送
`;

interface W {
  readonly engine: Engine;
  readonly store: ReturnType<typeof createLedgerStore>;
  readonly sent: { to: string; subject: string; body: string; inReplyTo: string }[];
  readonly delivered: { session: string; text: string }[];
  deliver: (ok: boolean) => void;
  advanceClock: (ms: number) => void;
  clockNow: () => Date;
}

const makeW = (): W => {
  const { clock, advance } = makeClock();
  const store = createLedgerStore(':memory:', { clock, ids: seqIds() });
  const sent: { to: string; subject: string; body: string; inReplyTo: string }[] = [];
  const delivered: { session: string; text: string }[] = [];
  const gate = { ok: true };
  const engine = createEngine({
    store,
    llm: { async complete() { return ok({ text: '{}', inputTokens: 1, outputTokens: 1 }); } } as unknown as LlmPort,
    model: 't',
    routing: { defaultSession: '', defaultProject: 'p' },
    dispatch: { async dispatch() { return ok(undefined); } },
    syncDispatch: null,
    pusher: { async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {} } satisfies PusherPort,
    mailer: {
      async send(cmd) { sent.push({ to: cmd.to, subject: cmd.subject, body: cmd.body, inReplyTo: cmd.inReplyTo }); return ok({ messageId: '<m@x>' }); },
    } satisfies MailerPort,
    captureOutput: async () => 'PANE',
    workspaceFor: null,
    sendToSession: async (session, text) => {
      delivered.push({ session, text });
      return gate.ok
        ? { delivered: true, reason: '', finalState: 'cleared' as const }
        : { delivered: false, reason: 'stub: 会话不可达' };
    },
    availableSessions: ['agent-a'],
    resolveSession: null,
    interruptSession: null,
    rebuildAgent: null,
    zombieFingerprint: null,
    clock,
    ids: seqIds(),
    templates: { f: parseTemplate(FLOW_YAML), n: parseTemplate(NODES_YAML) },
    authz: { mode: 'allowlist', allow: ['*@example.com'], deny: [] },
  } satisfies EngineDeps);
  return { engine, store, sent, delivered, deliver: (v) => { gate.ok = v; }, advanceClock: advance, clockNow: clock.now };
};

describe('intervene 一等插话', () => {
  it('投递成功 → input 干预史 + activity + step_intervened 事件三处留痕', async () => {
    const w = makeW();
    const wf = await w.engine.startFlow('f', '', { from: 'boss@example.com', subject: 's', body: '请把上月的销量数据整理成表格发我。', in_reply_to: '<orig-1@example.com>' });
    await w.engine.advance(wf.id); // agent 步 running
    const st = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'agent')!;
    expect(st.status).toBe('running');

    await w.engine.intervene(st.id, '注意别动 ZZ 文件', 'web');

    expect(w.delivered).toEqual([{ session: 'agent-a', text: '注意别动 ZZ 文件' }]);
    const after = w.store.getStep(st.id)!;
    const iv = after.input['interventions'] as { text: string; by: string }[];
    expect(iv).toHaveLength(1);
    expect(iv[0]).toMatchObject({ text: '注意别动 ZZ 文件', by: 'web' });
    const activity = after.output['activity'] as { event: string; text: string }[];
    expect(activity.some((a) => a.event === 'intervene' && a.text.includes('别动 ZZ'))).toBe(true);
    const events = w.store.listEvents(50).filter((e) => e.type === 'step_intervened');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload['by']).toBe('web');

    // 幂等语义：二次插话追加（历史累积，不覆盖）。
    await w.engine.intervene(st.id, '补充：只做 YY', 'web');
    expect((w.store.getStep(st.id)!.input['interventions'] as unknown[])).toHaveLength(2);
  });

  it('非 running 步 / 空文本 / 投递失败 → 拒绝且不落成功账；失败插话转外发箱补投+留痕', async () => {
    const w = makeW();
    const wf = await w.engine.startFlow('f', '', { from: 'boss@example.com', subject: 's', body: '请把上月的销量数据整理成表格发我。', in_reply_to: '<orig-1@example.com>' });
    await w.engine.advance(wf.id);
    const st = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'agent')!;

    await expect(w.engine.intervene(st.id, '   ', 'web')).rejects.toThrow(/required/);
    w.deliver(false);
    // 投递失败（0923 插话 400 事故兜底）：拒绝 + 原因 + 外发箱补投 + deferred 事件。
    await expect(w.engine.intervene(st.id, '发不过去的话', 'web')).rejects.toThrow(/delivery failed.*stub: 会话不可达.*外发箱/);
    expect(w.store.getStep(st.id)!.input['interventions']).toBeUndefined(); // 成功账只记发生过的事
    const deferred = w.store.listEvents(50).filter((e) => e.type === 'step_intervention_deferred');
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.payload['reason']).toBe('stub: 会话不可达');
    const pending = w.store.pendingRelays();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.text).toContain('发不过去的话');
    expect(pending[0]!.text).toMatch(/\[intervene:[^\]]+\]/); // marker 随文本走（补投验证锚）

    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    await expect(w.engine.intervene(gate.id, '闸门不能插话', 'web')).rejects.toThrow(/not a running agent step/);
  });
});

describe('节点时序（started_at / completed_at）', () => {
  it('pending→running 记 started；终态记 completed；闸门 waiting 也算开跑', async () => {
    const w = makeW();
    const wf = await w.engine.startFlow('f', '', { from: 'boss@example.com', subject: 's', body: '请把上月的销量数据整理成表格发我。', in_reply_to: '<orig-1@example.com>' });
    await w.engine.advance(wf.id); // agent → running（startEmailWorkflow 内部已推进，这里排空锁链）
    const steps0 = w.store.stepsForWorkflow(wf.id);
    // 未开跑的下游步（gate/send 仍 pending）：无时序。
    expect(steps0.filter((s) => s.status === 'pending').every((s) => s.startedAt === '' && s.completedAt === null)).toBe(true);

    const agent1 = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'agent')!;
    expect(agent1.startedAt).not.toBe('');
    expect(agent1.completedAt).toBeNull();

    await w.engine.onAgentStopped('agent-a', 'done', '汇报');
    await w.engine.advance(wf.id); // 闸门 → waiting_human
    const agent2 = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'agent')!;
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    expect(agent2.completedAt).not.toBe(null);
    expect(agent2.completedAt).not.toBe('');
    expect(gate.startedAt).not.toBe(''); // 闸门开启 = 开跑
    expect(gate.completedAt).toBeNull();
  });

  it('存量库补列迁移 + goShape 外送真时序（created_at 兼容口径不变）', () => {
    const store = createLedgerStore(':memory:', { clock: fixedClock, ids: seqIds() });
    const wf = store.createWorkflow({ kind: 'k', title: 't' });
    store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: 'a' });
    store.setStepStatus(store.stepsForWorkflow(wf.id)[0]!.id, 'running');
    store.setStepStatus(store.stepsForWorkflow(wf.id)[0]!.id, 'completed');
    const st = store.stepsForWorkflow(wf.id)[0]!;
    const go = stepToGo(st);
    expect(go['started_at']).toBe(st.startedAt);
    expect(go['completed_at']).toBe(st.completedAt);
    expect(go['created_at']).toBe(st.updatedAt); // 旧客户端排序口径不动
    // 未开跑的步：时序字段缺席（iOS Codable 可选），不送空串。
    store.createStep({ workflowId: wf.id, seq: 2, kind: 'gate', title: 'g' });
    const go2 = stepToGo(store.stepsForWorkflow(wf.id)[1]!);
    expect(go2['started_at']).toBeUndefined();
    expect(go2['completed_at']).toBeUndefined();
  });
});

describe('手动起流挂靠 + 有机回合入账', () => {
  it('input.in_reply_to 透传——手动答复跟帖不断线', async () => {
    const w = makeW();
    const wf = await w.engine.startFlow('f', '手动答复', {
      from: 'casey@acme.de', subject: '回复: banner',
      in_reply_to: '<casey-0910-orig@acme.de>',
      draft: '您好，全家福已完成，请过目定稿。如有出入请回复纠正。',
    });
    await w.engine.advance(wf.id);                 // agent 派发
    await w.engine.onAgentStopped('agent-a', 'done', '汇报：已办结。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。');
    await w.engine.advance(wf.id);                 // 闸门开
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    await w.engine.approve(gate.id, '', 'test');
    await w.engine.advance(wf.id);                 // 发送
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.inReplyTo).toBe('<casey-0910-orig@acme.de>');
    expect(w.sent[0]!.to).toBe('casey@acme.de');
  });

  it('input.relates_to → parent_id/related_workflow；未知 id 只记 meta 不炸', async () => {
    const w = makeW();
    const parent = await w.engine.startFlow('f', '父流水', {});
    const child = await w.engine.startFlow('f', 'Banner 重做', { relates_to: parent.id });
    expect(child.parentId).toBe(parent.id);
    expect(child.meta['related_workflow']).toBe(parent.id);
    const stray = await w.engine.startFlow('f', '野单', { relates_to: 'wf_404' });
    expect(stray.parentId).toBeNull();
    expect(stray.meta['relates_to_unknown']).toBe('wf_404');
  });

  it('认领会话的有机回合落进 nodes 容器；未认领会话保持静默', async () => {
    const w = makeW();
    const wf = await w.engine.startFlow('n', '人肉单', {});
    await w.engine.assignSession(wf.id, 'my-hand', 'human');
    // 无 running step：活动事件与 Stop 最终答复都该进容器账本。
    await w.engine.recordActivity('my-hand', 'capture', '我插了一句话');
    await w.engine.onAgentStopped('my-hand', 'done', '回合产出：banner v1 已渲');
    const turns = w.store.listEvents(50).filter((e) => e.type === 'session_turn');
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns.some((e) => String(e.payload['text']).includes('插了一句话'))).toBe(true);
    expect(turns.some((e) => String(e.payload['text']).includes('banner v1'))).toBe(true);
    // 未认领会话：静默（不产生孤儿事件）。
    const before = w.store.listEvents(200).filter((e) => e.type === 'session_turn').length;
    await w.engine.recordActivity('nobody-claims-me', 'capture', '路人');
    expect(w.store.listEvents(200).filter((e) => e.type === 'session_turn').length).toBe(before);
  });
});

describe('定时发（批准=决定，执行等钟）', () => {
  it('approve --at 未来 → send 挂 pending 留痕；到点 sweepSchedules 续推发出', async () => {
    const w = makeW();
    const wf = await w.engine.startFlow('f', '定时答复', {
      from: 'c@x.de', subject: 's', draft: '正文',
    });
    await w.engine.advance(wf.id);
    await w.engine.onAgentStopped('agent-a', 'done', '汇报：已办结。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。');
    await w.engine.advance(wf.id);
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    const at = new Date(w.clockNow().getTime() + 60_000).toISOString();
    await w.engine.approve(gate.id, '', 't', at);
    await w.engine.advance(wf.id);
    // 未到点：不发送，send pending 且留痕
    expect(w.sent).toHaveLength(0);
    const send = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'send')!;
    expect(send.status).toBe('pending');
    expect(send.output['scheduled_until']).toBe(at);
    expect(w.store.getStep(gate.id)!.output['send_at']).toBe(at);
    // 到点（伪造时钟越过）→ sweep 续推发出
    w.advanceClock(61_000);
    await w.engine.sweepSchedules();
    await new Promise((r) => setTimeout(r, 50));
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.to).toBe('c@x.de');
  });

  it('过去时刻拒绝；不带 send_at 即批即发（兼容）', async () => {
    const w = makeW();
    const wf = await w.engine.startFlow('f', '即发', { from: 'c@x.de', subject: 's', draft: '正文' });
    await w.engine.advance(wf.id);
    await w.engine.onAgentStopped('agent-a', 'done', '汇报：已办结。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。');
    await w.engine.advance(wf.id);
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    await expect(w.engine.approve(gate.id, '', 't', '2000-01-01T00:00:00Z')).rejects.toThrow('未来');
    await w.engine.approve(gate.id, '', 't');
    await w.engine.advance(wf.id);
    expect(w.sent).toHaveLength(1); // 即批即发
  });
});

describe('多轮线程链（客户的回信接得上线）', () => {
  it('我们发出的回信 ID 在 references 里——她的下一封引用它 → parentId 正确挂线', async () => {
    const w = makeW();
    // 第一轮：进件 → 走完 → 发出回信（messageId 落 references）
    const wf1 = await w.engine.startFlow('f', '', { from: 'boss@example.com', subject: 's', body: '请把上月的销量数据整理成表格发我。', in_reply_to: '<orig-1@example.com>' });
    await w.engine.advance(wf1.id);
    await w.engine.onAgentStopped('agent-a', 'done', '汇报：已办结。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。');
    await w.engine.advance(wf1.id);
    const gate = w.store.stepsForWorkflow(wf1.id).find((s) => s.kind === 'gate')!;
    await w.engine.approve(gate.id, '', 't');
    await w.engine.advance(wf1.id);
    expect(w.sent).toHaveLength(1);
    // 第二轮：Casey 回我们的信（inReplyTo = 我们刚发出的 ID）
    await w.engine.onEmailReceived(makeEmail({
      from: 'boss@example.com',
      messageId: '<her-reply-2@x>',
      inReplyTo: '<m@x>',
    }));
    const wf2 = w.store.listWorkflows(5).find((x) => x.meta['message_id'] === '<her-reply-2@x>');
    expect(wf2).toBeDefined();
    expect(wf2!.parentId).toBe(wf1.id); // 接上线，不再是无主新邮件
  });
});
