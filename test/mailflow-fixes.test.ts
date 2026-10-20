// wf_e4013364bc8d 断链事故五坑回归（2026-09-15）：
// ① onAgentStopped 摘除 capture-pane 产出兜底——空产出留痕（agent_output_missing），
//   绝不抓屏填空（capture-pane 只准喂 zombie 检测）；
// ② completeAgentStep 下游播种改工件优先：deliverables 有 body 工件 → body_ref
//   指针（哈希取件），screen 垃圾文本不再冒充正文；
// ③ sweep 拒绝不静默：sweep_failed 事件留痕，步骤照常结算；settle/close 收口
//   兜底再扫一次 case-inbox；
// ④ appendNode 建「发送」闸门自动配对 send 后继节点（结构性消灭「忘挂 send」）；
// ⑤ nodes 链尾悬空检测：全终态且无 send 步 → chain_dangling 事件 + 推送（一次）；
// ⑥ send 附件守卫解耦：正文宣称附件但一件可附工件都没有 → 拒发（契约缺位同拦）。
//
// 断言时序约定同 engine.test.ts：`await engine.advance(id)` 排到锁链尾。

import { describe, expect, it } from 'vitest';
import { makeEngine, makeEmail, until } from './helpers.ts';
import type { EngineDeps } from '../src/business/workflow/engine.ts';
import type { ArtifactPort, MailerPort, PusherPort } from '../src/contracts/ports.ts';
import { ok } from '@juli-os/artifacts';
import type { JsonValue } from '@juli-os/artifacts';

/** 动态进件（nodes 模式）+ 默认会话派发：agent 步 running 的最短路径。 */
const startIntake = async (
  over: Partial<EngineDeps> = {},
  email = makeEmail(),
) => {
  const w = makeEngine({
    routing: { defaultSession: 'agent-a', defaultProject: 'proj-x' },
    availableSessions: ['agent-a'],
    ...over,
  });
  const wf = await w.engine.startEmailWorkflow(email);
  await w.engine.advance(wf.id); // 排到触发推进之后：agent 步已派发 running
  return { w, wf };
};

describe('① onAgentStopped：capture-pane 产出兜底摘除', () => {
  it('finalMessage 空 → step output 空串 + agent_output_missing 事件，绝不抓屏', async () => {
    const captureCalls: string[] = [];
    const { w, wf } = await startIntake({
      captureOutput: async (session) => {
        captureCalls.push(session);
        return 'PANE-JUNK spinner… ⏵⏵ auto mode on';
      },
    });
    await w.engine.onAgentStopped('agent-a', 'ok'); // 无 finalMessage
    await w.engine.advance(wf.id);
    const st = w.store.stepsForWorkflow(wf.id)[0]!;
    expect(st.status).toBe('completed');
    expect(st.output['output']).toBe(''); // 空产出就是空产出
    expect(String(st.output['output'])).not.toContain('PANE-JUNK');
    expect(captureCalls).toHaveLength(0); // capture-pane 一次都不准抓
    const evs = w.store.listEvents(200).filter((e) => e.type === 'agent_output_missing');
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toMatchObject({ session: 'agent-a', raw_status: 'ok' });
  });

  it('finalMessage 非空 → 照常采用，不产生 agent_output_missing', async () => {
    const { w, wf } = await startIntake();
    await w.engine.onAgentStopped('agent-a', 'ok', '结构化理解完成');
    await w.engine.advance(wf.id);
    expect(w.store.stepsForWorkflow(wf.id)[0]!.output['output']).toBe('结构化理解完成');
    expect(w.store.listEvents(200).some((e) => e.type === 'agent_output_missing')).toBe(false);
  });
});

describe('② completeAgentStep 播种：工件优先（body_ref 取代 draft）', () => {
  it('deliverables 有 body 工件 → 下游 input 播 body_ref 指针，不再播 draft', async () => {
    const sweepCalls: string[] = [];
    const artifacts: ArtifactPort = {
      list: () => [],
      updateMeta: () => {},
      getContent: async (id) => id === 'art_body'
        ? { bytes: Buffer.from('正文字节'), sha256: 'sha-body', name: 'b.txt', viewRole: 'body' }
        : null,
      sweepCaseInbox: async (workflowId) => {
        sweepCalls.push(workflowId);
        return {
          count: 2,
          entries: [
            { id: 'art_body', name: 'b.txt', view_role: 'body', sha256: 'sha-body', bytes: 12, summary: '' },
            { id: 'art_rep', name: 'r.html', view_role: 'report', sha256: 'sha-rep', bytes: 5, summary: '' },
          ],
          envelope: null,
          warnings: [],
          has_manifest: true,
        };
      },
    };
    const { w, wf } = await startIntake({ artifacts, caseInboxDir: () => '/tmp/case-inbox' });
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '对齐闸门' });
    await w.engine.onAgentStopped('agent-a', 'done', '做完了');
    await w.engine.advance(wf.id);
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    // body_ref 形状与 sendSeed.deliverablesBody 一致（发送步按哈希取件）。
    expect(gate.input['body_ref']).toEqual({ id: 'art_body', sha256: 'sha-body', name: 'b.txt' });
    expect(gate.input['draft']).toBeUndefined(); // 垃圾文本不再冒充正文
    expect(Array.isArray(gate.input['deliverables'])).toBe(true);
    expect(gate.input['manifest']).toBe(true);
    expect(sweepCalls).toEqual([wf.id]);
  });

  it('无 body 工件 → 回落内联 draft（旧链路兼容）', async () => {
    const { w, wf } = await startIntake();
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '对齐闸门' });
    await w.engine.onAgentStopped('agent-a', 'done', '内联正文汇报');
    await w.engine.advance(wf.id);
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    expect(gate.input['draft']).toBe('内联正文汇报');
    expect(gate.input['body_ref']).toBeUndefined();
  });
});

describe('③ sweep 不再静默 + 收口兜底', () => {
  it('sweepCaseInbox 拒绝 → sweep_failed 事件留痕，步骤照常完成', async () => {
    const artifacts: ArtifactPort = {
      list: () => [],
      updateMeta: () => {},
      sweepCaseInbox: async () => { throw new Error('inbox kaboom'); },
    };
    const { w, wf } = await startIntake({ artifacts, caseInboxDir: () => '/tmp/case-inbox' });
    await w.engine.onAgentStopped('agent-a', 'ok', '照常汇报');
    await w.engine.advance(wf.id);
    const st = w.store.stepsForWorkflow(wf.id)[0]!;
    expect(st.status).toBe('completed'); // 收编失败不改步骤结算语义
    expect(st.output['output']).toBe('照常汇报');
    const evs = w.store.listEvents(200).filter((e) => e.type === 'sweep_failed');
    expect(evs).toHaveLength(1);
    expect(String(evs[0]!.payload['error'])).toContain('inbox kaboom');
  });

  it('settle 收口兜底：deps.artifacts 存在就再扫一次 case-inbox', async () => {
    const sweepArgs: string[] = [];
    const artifacts: ArtifactPort = {
      list: () => [],
      updateMeta: () => {},
      sweepCaseInbox: async (workflowId, stepId) => {
        sweepArgs.push(`${workflowId}:${stepId ?? '-'}`);
        return { count: 0, entries: [], envelope: null, warnings: [], has_manifest: false };
      },
    };
    const { w, wf } = await startIntake({ artifacts });
    await w.engine.onAgentStopped('agent-a', 'done', '理解完成');
    await w.engine.advance(wf.id);
    sweepArgs.length = 0; // 只看 settle 这一次
    await w.engine.settle(wf.id, 'boss');
    expect(sweepArgs).toEqual([`${wf.id}:-`]);
    expect(w.store.getWorkflow(wf.id)!.status).toBe('completed');
  });
});

describe('④ appendNode 发送闸门自动配对 send 节点', () => {
  it('meta.from 存在：建「发送闸门」→ 自动多出 pending 的 send 后继「发送答复」', async () => {
    const { w, wf } = await startIntake({ routing: { defaultSession: 'agent-a', defaultProject: 'proj-x' } });
    await w.engine.onAgentStopped('agent-a', 'done', '理解完成');
    await w.engine.advance(wf.id);
    const gate = await w.engine.appendNode(wf.id, { kind: 'gate', title: '发送闸门' });
    expect(gate.kind).toBe('gate'); // 返回的是调用方请求的节点，不是链尾 send
    const steps = w.store.stepsForWorkflow(wf.id);
    const sends = steps.filter((s) => s.kind === 'send');
    expect(sends).toHaveLength(1);
    expect(sends[0]!.title).toBe('发送答复');
    expect(sends[0]!.status).toBe('pending');
    expect(sends[0]!.seq).toBe(gate.seq + 1); // 紧随闸门的后继

    // 幂等：链上已有 pending 的 send 节点 → 再建发送闸门不重复配对。
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '复核发送闸门' });
    expect(w.store.stepsForWorkflow(wf.id).filter((s) => s.kind === 'send')).toHaveLength(1);
  });

  it('无 meta.from：不申报 envelope.to 的发送闸门被拒收；申报后照常自动配对（wf_505578377218）', async () => {
    // 本世界 defaultSession 为空会让播种的接单步解析不到会话而 failed——
    // 本测试只关心配对与拒收，给个可用会话。
    const w = makeEngine({ routing: { defaultSession: 'agent-a', defaultProject: 'proj-x' } });
    const wf = await w.engine.startTask('纯内部任务', {});
    await w.engine.advance(wf.id);
    // 第一道闸：无 from 不申报收件人 → 当场打回，闸门开不起来。
    await expect(w.engine.appendNode(wf.id, { kind: 'gate', title: '发送闸门', input: {} }))
      .rejects.toThrow(/须申报收件人/);
    expect(w.store.stepsForWorkflow(wf.id).filter((s) => s.kind === 'gate')).toHaveLength(0);
    // 申报 envelope.to → 闸门 + send 自动配对（不再以 from 为前提）。
    await w.engine.appendNode(wf.id, {
      kind: 'gate', title: '发送闸门',
      input: { envelope: { to: 'casey.li@acme.de' } },
    });
    const steps = w.store.stepsForWorkflow(wf.id);
    expect(steps.filter((s) => s.kind === 'gate')).toHaveLength(1);
    expect(steps.filter((s) => s.kind === 'send')).toHaveLength(1);
  });

  it('批准发送闸门 → 自动配对的 send 被播种并发信（approve 路径 seedSendFromGate）', async () => {
    const sent: { to: string; body: string }[] = [];
    const { w, wf } = await startIntake({
      mailer: {
        async send(cmd) {
          sent.push({ to: cmd.to, body: cmd.body });
          return ok({ messageId: '<auto-pair@juli.local>' });
        },
      } satisfies MailerPort,
      // 断点九①铁律：nodes 模式正文只认 body_ref 契约工件——闸门带 body
      // 工件指针，批准播种后 send 步按哈希取件。
      artifacts: {
        list: () => [],
        updateMeta: () => {},
        getContent: async (id) => id === 'art_body'
          ? { bytes: Buffer.from('自动配对的正文'), sha256: 'a7a2abed6f32b67b98eb1d341d71bea3250ca70e45085ba101227aa373c730c0', name: 'b.txt', viewRole: 'body' }
          : null,
        sweepCaseInbox: async () => ({ count: 0, entries: [], envelope: null, warnings: [], has_manifest: false }),
      },
    });
    await w.engine.onAgentStopped('agent-a', 'done', '理解完成');
    await w.engine.advance(wf.id);
    const gate = await w.engine.appendNode(wf.id, { kind: 'gate', title: '发送闸门' });
    // 闸门开启时 checks 按空正文计算（body fail）——测试注入放行 checks；
    // 正文走 deliverables body 工件（body_ref 契约路径）。
    // 09-20 P2-6：注入 envelope.to（原用例无 envelope，「只认 meta.from」注释
    // 宣称的保证此前没有任何鉴别力——本行让断言真正锁住回信流收件人）。
    w.store.setStepInput(gate.id, {
      checks: [{ name: 'redline', status: 'pass', detail: '' }, { name: 'body', status: 'pass', detail: '' }],
      deliverables: [{ id: 'art_body', name: 'b.txt', view_role: 'body', sha256: 'a7a2abed6f32b67b98eb1d341d71bea3250ca70e45085ba101227aa373c730c0' }],
      envelope: { to: 'attacker@evil.example' },
    });
    // 理解回合落定时链曾悬空（当时确无 send 步）→ 已发过一次 chain_dangling。
    const danglingBefore = w.store.listEvents(200).filter((e) => e.type === 'chain_dangling').length;
    await w.engine.approve(gate.id, '发', 'boss');
    await until(() => sent.length === 1);
    expect(sent[0]!.to).toBe('boss@example.com'); // 只认 meta.from——envelope.to 申报被忽略（P0）
    expect(sent[0]!.to).not.toBe('attacker@evil.example');
    expect(sent[0]!.body).toContain('自动配对的正文');
    // send 节点已在链上 → 发送完成后的推进不再产生新的悬空留痕。
    await w.engine.advance(wf.id);
    expect(w.store.listEvents(200).filter((e) => e.type === 'chain_dangling')).toHaveLength(danglingBefore);
  });
});

describe('⑤ nodes 链尾悬空检测（只在「批准了发送决定却无处可发」时报警）', () => {
  // 摆出事故形态（wf_e4013364bc8d seq4）：发送闸门已批准、链上无 send 步。
  const setupDangling = async (pusher?: PusherPort) => {
    const w = makeEngine(pusher ? { pusher } : {});
    const wf = w.store.createWorkflow({
      kind: 'email', title: '悬空单', status: 'running',
      meta: { from: 'boss@example.com', mode: 'nodes' },
    });
    const agent = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '理解（读原文）', input: {} });
    w.store.setStepStatus(agent.id, 'completed');
    const gate = w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'gate', title: '发送闸门', input: {} });
    w.store.setStepStatus(gate.id, 'completed');
    return { w, wf };
  };

  it('发送闸门已批准且无 send 步 → chain_dangling 事件 + 推送一次（轮询不重发）', async () => {
    const danglings: { workflowId: string; note: string }[] = [];
    const pusher: PusherPort = {
      async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {},
      async chainDangling(w, note) { danglings.push({ workflowId: w.id, note }); },
    };
    const { w, wf } = await setupDangling(pusher);
    await w.engine.advance(wf.id); // 排到结算推进之后：检测在锁内完成
    const evs = w.store.listEvents(200).filter((e) => e.type === 'chain_dangling');
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload['last']).toBe('gate/发送闸门');
    expect(danglings).toHaveLength(1);
    expect(danglings[0]!.workflowId).toBe(wf.id);
    expect(danglings[0]!.note).toContain('发送');
    expect(w.store.getWorkflow(wf.id)!.meta['chain_dangling_notified']).toBe(true);
    expect(w.store.getWorkflow(wf.id)!.status).toBe('running'); // 悬空≠完成
    // 幂等：4s 轮询式的重复 advance 不重发。
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    expect(w.store.listEvents(200).filter((e) => e.type === 'chain_dangling')).toHaveLength(1);
    expect(danglings).toHaveLength(1);
  });

  it('pusher 无 chainDangling（mock 缺省）→ 只留事件，不炸', async () => {
    const { w, wf } = await setupDangling();
    await w.engine.advance(wf.id);
    expect(w.store.listEvents(200).some((e) => e.type === 'chain_dangling')).toBe(true);
  });

  it('无 from 同样报警（wf_505578377218：任务流批了发送闸门没发不能静默）', async () => {
    const danglings: { workflowId: string; note: string }[] = [];
    const pusher: PusherPort = {
      async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {},
      async chainDangling(wf0, note) { danglings.push({ workflowId: wf0.id, note }); },
    };
    const w = makeEngine({ pusher, routing: { defaultSession: 'agent-a', defaultProject: 'proj-x' } });
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '任务流', status: 'running', meta: { mode: 'nodes' } });
    const g = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'gate', title: '发送闸门', input: {} });
    w.store.setStepStatus(g.id, 'completed');
    await w.engine.advance(wf.id);
    expect(w.store.listEvents(200).some((e) => e.type === 'chain_dangling')).toBe(true);
    expect(danglings).toHaveLength(1);
  });

  it('agent 步收尾的空档不算悬空（等下一节点是常态）；非发送 gate 收尾=等人 settle 也不报警', async () => {
    const { w, wf } = await startIntake();
    await w.engine.onAgentStopped('agent-a', 'done', '理解完成');
    await w.engine.advance(wf.id);
    expect(w.store.listEvents(200).some((e) => e.type === 'chain_dangling')).toBe(false);
    // 对齐类 gate 收尾（无发送语义）→ 正常等待，不报警。
    const wf2 = w.store.createWorkflow({
      kind: 'email', title: '正常收尾单', status: 'running',
      meta: { from: 'boss@example.com', mode: 'nodes' },
    });
    const a2 = w.store.createStep({ workflowId: wf2.id, seq: 1, kind: 'agent', title: '理解', input: {} });
    w.store.setStepStatus(a2.id, 'completed');
    const g2 = w.store.createStep({ workflowId: wf2.id, seq: 2, kind: 'gate', title: '交付审核闸门', input: {} });
    w.store.setStepStatus(g2.id, 'completed');
    await w.engine.advance(wf2.id);
    expect(w.store.listEvents(200).some((e) => e.type === 'chain_dangling')).toBe(false);
  });

  it('零步骤空容器不算悬空；有 send 步的链不算悬空', async () => {
    const w = makeEngine();
    // startTask 已改「发单即接手」（自动播种首节点）——真零步容器须直接建账本。
    const empty = w.store.createWorkflow({ kind: 'adhoc', title: '还没开始', status: 'running', meta: { mode: 'nodes', from: 'c@x.de' } });
    await w.engine.advance(empty.id);
    expect(w.store.listEvents(200).some((e) => e.type === 'chain_dangling')).toBe(false);
  });
});

describe('⑥ send 附件守卫解耦（宣称=实物，契约缺位同拦）', () => {
  const setupSend = async (body: string, deliverables?: JsonValue) => {
    const w = makeEngine();
    const wf = w.store.createWorkflow({ kind: 'email', title: '守卫单', status: 'running', meta: { from: 'boss@example.com' } });
    const gate = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'gate', title: '发送决定', input: {} });
    w.store.setStepStatus(gate.id, 'completed');
    w.store.createStep({
      workflowId: wf.id, seq: 2, kind: 'send', title: '发送',
      input: {
        body,
        in_reply_to: '<x@q>',
        ...(deliverables !== undefined ? { deliverables } : {}),
      },
    });
    await w.engine.advance(wf.id);
    return { w, send: w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'send')! };
  };

  it('正文宣称附件但 deliverables 为空 → 拒发（守卫移出条件块）', async () => {
    const { w, send } = await setupSend('成品见附件。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。');
    expect(send.status).toBe('failed');
    expect(send.output['guard']).toBe('declared_attachments_missing');
    expect(String(send.output['error'])).toContain('宣称与实物不一致');
    expect(w.sent).toHaveLength(0);
    const evs = w.store.listEvents(200).filter((e) => e.type === 'step_failed');
    expect(evs.some((e) => e.payload['guard'] === 'declared_attachments_missing')).toBe(true);
  });

  it('deliverables 声明了附件但取不到字节 → 同样拒发（原有语义保持）', async () => {
    const { w, send } = await setupSend('成品见附件。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。', [
      { id: 'art_ghost', name: 'g.pptx', view_role: 'report', sha256: 'h' },
    ]);
    expect(send.status).toBe('failed');
    expect(w.sent).toHaveLength(0);
  });

  it('正文不提附件 → 无附件照发（纯文本信兼容）', async () => {
    const { w, send } = await setupSend('内容都在正文里。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。');
    expect(send.status).toBe('completed');
    expect(w.sent).toHaveLength(1);
  });

  it('引用对方措辞的收执句（您…附上的…已收到）→ 不误伤，无附件照发（第 5 轮审查）', async () => {
    const { w, send } = await setupSend('您随信附上的合同已收到，我们正在推进后续流程。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。');
    expect(send.status).toBe('completed');
    expect(w.sent).toHaveLength(1);
  });

  it('同一正文既引收执又自宣称附件 → 仍拦（共现排除不扩洞）', async () => {
    const { w, send } = await setupSend('您附上的报价单已查收。另：修订版见附件。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。');
    expect(send.status).toBe('failed');
    expect(send.output['guard']).toBe('declared_attachments_missing');
    expect(w.sent).toHaveLength(0);
  });
});
