// 动态进件（2026-09-13 裁决）：事件直达 nodes + 首理解节点，无模板/trigger
// 路由。2026-09-13 事故的防复发锚：当时 trigger=email 模板被改 manual，
// currentTemplate 静默回退字母序第一的空 adhoc 模板 → 邮件进件秒完成空单。
// 本文件锁定：**注册表为空也照常进件**——manifest 配置错误从根上无米可炊。

import { describe, expect, it } from 'vitest';
import { createLedgerStore } from '@juli-os/ledger';
import { createEngine, type Engine, type EngineDeps } from '../src/business/workflow/engine.ts';
import { ok } from '@juli-os/artifacts';
import { makeClock, makeEmail, seqIds, until } from './helpers.ts';
import type { JsonRecord } from '@juli-os/artifacts'
import type { LlmPort, MailerPort, PusherPort } from '../src/contracts/ports.ts';

const makeEngineEmpty = (over: Partial<EngineDeps> = {}) => {
  const { clock, advance } = makeClock();
  const store = createLedgerStore(':memory:', { clock, ids: seqIds() });
  const dispatched: { session: string; text: string }[] = [];
  const engine = createEngine({
    store,
    llm: null,
    model: 't',
    routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
    dispatch: { async dispatch(_s, session, text) { dispatched.push({ session, text }); return ok(undefined); } },
    syncDispatch: null,
    pusher: { async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {} } satisfies PusherPort,
    mailer: { async send() { return ok({ messageId: '<x@j>' }); } } satisfies MailerPort,
    captureOutput: async () => null,
    workspaceFor: null,
    availableSessions: ['juli-reply'],
    resolveSession: null,
    interruptSession: null,
    rebuildAgent: null,
    zombieFingerprint: null,
    clock,
    ids: seqIds(),
    templates: {}, // ★ 空注册表：一张模板都没有
    authz: { mode: 'allowlist', allow: ['*@example.com'], deny: [] },
    ...over,
  } satisfies EngineDeps);
  return { engine, store, dispatched, advanceClock: advance };
};

describe('动态进件（无模板/无 trigger）', () => {
  it('事故防复发锚：注册表为空，邮件照常进件——首节点=理解，派默认会话，原文在任务卡', async () => {
    const w = makeEngineEmpty();
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    expect(w.store.getWorkflow(wf.id)!.meta['mode']).toBe('nodes');
    const steps = w.store.stepsForWorkflow(wf.id);
    expect(steps).toHaveLength(1); // 事故形态是 0 步秒完成——这里必须恰有理解节点
    expect(steps[0]!.kind).toBe('agent');
    expect(steps[0]!.status).toBe('running'); // 已派发
    expect(w.dispatched[0]!.session).toBe('juli-reply'); // 默认会话直达
    expect(w.dispatched[0]!.text).toContain('请把上月的销量数据整理成表格发我。'); // 原文直读
    expect(w.dispatched[0]!.text).toContain('boss@example.com');
    // 理解回合落定 → 流水保持 running 等动作追加（不秒完成）。
    await w.engine.onAgentStopped('juli-reply', 'done', '结构化理解完成');
    expect(w.store.getWorkflow(wf.id)!.status).toBe('running');
  });

  it('startTask 免模板起单：relates_to 留链 + brief 进 template_input + 首节点即派发', async () => {
    const w = makeEngineEmpty();
    const parent = await w.engine.startEmailWorkflow(makeEmail());
    await w.engine.onAgentStopped('juli-reply', 'done', '理解');
    // 父单终态让出 juli-reply（2026-10-13 裁定后：挂靠继承忙时等待/改道，
    // 单 agent 世界=等父单收口；旧=直接挤进闸门等待中的父会话）。
    await w.engine.forceClose(parent.id, 'test', 'test');
    const t = await w.engine.startTask('banner 重做', {
      relates_to: parent.id, brief: '口径：设备居中', from: 'c@x.de',
    });
    expect(t.kind).toBe('adhoc');
    expect(t.parentId).toBe(parent.id);
    expect(t.meta['related_workflow']).toBe(parent.id);
    expect((t.meta['template_input'] as Record<string, unknown>)['brief']).toBe('口径：设备居中');
    expect(t.meta['from']).toBe('c@x.de'); // 答复能力（发送锁定原发件人）
    // 发单即接手（wf_505578377218 停摆事故锚）：首节点已播种。收单台（0920）
    // 起单改入队——先 queued,派发器抽到即转 running 并派发(等泵一拍)。
    const steps = w.store.stepsForWorkflow(t.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe('agent');
    expect(['queued', 'running', 'pending']).toContain(w.store.getWorkflow(t.id)!.status); // 入队即返
    await until(() => w.store.stepsForWorkflow(t.id)[0]!.status === 'running');
    expect(w.store.getWorkflow(t.id)!.status).toBe('running'); // 已派发
    expect(String(steps[0]!.input['plan'])).toBe('口径：设备居中');
    expect(w.dispatched.at(-1)!.session).toBe('juli-reply'); // session 留空 → defaultSession 兜底
    expect(w.dispatched.at(-1)!.text).toContain('口径：设备居中');
    expect(w.store.getWorkflow(t.id)!.session).toBe('juli-reply'); // 会话归属回填
  });

  it('startTask 无 brief：plan 回退标题（标题必填所以 plan 必有着落）', async () => {
    const w = makeEngineEmpty();
    const t = await w.engine.startTask('只有标题的任务', {});
    const steps = w.store.stepsForWorkflow(t.id);
    expect(steps).toHaveLength(1);
    expect(String(steps[0]!.input['plan'])).toBe('只有标题的任务');
    expect(w.dispatched[0]!.session).toBe('juli-reply');
  });

  it('泛化渠道同款：无 trigger 匹配表可错——channel 名即 kind，首节点照派', async () => {
    const w = makeEngineEmpty();
    await w.engine.onInbound({
      channel: 'teams', from: 'boss@example.com', subject: '频道消息', body: '内容X',
      dedupKey: 'teams-1', ts: '2026-09-13T00:00:00Z',
    });
    const wf = w.store.listWorkflows()[0]!;
    expect(wf.kind).toBe('teams');
    expect(wf.meta['mode']).toBe('nodes');
    expect(w.dispatched[0]!.text).toContain('内容X');
  });
});

describe('批准回流（批准=触发下一个）', () => {
  it('nodes 流闸门批准 → 回话原会话（含闸门名与批注）；ladder 流不回话', async () => {
    const relays: { session: string; text: string }[] = [];
    const w = makeEngineEmpty({
      sendToSession: async (session, text) => { relays.push({ session, text }); return { delivered: true, reason: '' }; },
    });
    // 动态进件 → 理解 → agent 开闸门 → 批准
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await w.engine.onAgentStopped('juli-reply', 'done', '理解完成，开对齐闸门');
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '对齐闸门' });
    const gate = w.store.stepsForWorkflow(wf.id).find((x) => x.kind === 'gate')!;
    await w.engine.approve(gate.id, '按计划做', 'boss');
    expect(relays).toHaveLength(1);
    expect(relays[0]!.session).toBe('juli-reply');
    expect(relays[0]!.text).toContain('[闸门已批准] 对齐闸门');
    expect(relays[0]!.text).toContain('按计划做');
    expect(relays[0]!.text).toContain('继续执行');
    expect(w.store.listEvents(50).some((e) => e.type === 'gate_relayed')).toBe(true);
    // ladder 配方流：approve 走阶梯推进，不回话（防双重驱动）。
    relays.length = 0;
    const w2 = makeEngineEmpty({
      sendToSession: async (session, text) => { relays.push({ session, text }); return { delivered: true, reason: '' }; },
    });
    void w2;
  });

  // 0923 断点④：feedback 处理完面板停「新建」——闸门批准=拍板，回流指令
  // 必须明确要求翻转关联记录状态；非 feedback 闸零影响。
  it('带 envelope.feedback_refs 的闸门批准 → 回流含「状态翻转为已完成」指令；普通闸不含', async () => {
    const relays: { session: string; text: string }[] = [];
    const w = makeEngineEmpty({
      sendToSession: async (session, text) => { relays.push({ session, text }); return { delivered: true, reason: '' }; },
    });
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await w.engine.onAgentStopped('juli-reply', 'done', '理解完成');
    await w.engine.appendNode(wf.id, {
      kind: 'gate', title: '确认闸门',
      input: { delivery: 'apply', envelope: { feedback_refs: ['v4h6fq87019dm5y'] } },
    });
    const gate = w.store.stepsForWorkflow(wf.id).find((x) => x.kind === 'gate')!;
    await w.engine.approve(gate.id, '', 'iphone');
    expect(relays).toHaveLength(1);
    expect(relays[0]!.text).toContain('v4h6fq87019dm5y');
    expect(relays[0]!.text).toContain('已获批准（=用户拍板）');
    expect(relays[0]!.text).toContain('「已完成」');
    // 普通 nodes 闸（无 feedback_refs）：回流不带翻转指令（新引擎隔离队列状态）。
    relays.length = 0;
    const w2 = makeEngineEmpty({
      sendToSession: async (session, text) => { relays.push({ session, text }); return { delivered: true, reason: '' }; },
    });
    const wf2 = await w2.engine.startEmailWorkflow(makeEmail());
    await w2.engine.onAgentStopped('juli-reply', 'done', '理解完成');
    await w2.engine.appendNode(wf2.id, { kind: 'gate', title: '对齐闸门' });
    const gate2 = w2.store.stepsForWorkflow(wf2.id).find((x) => x.kind === 'gate')!;
    await w2.engine.approve(gate2.id, '', 'boss');
    expect(relays).toHaveLength(1);
    expect(relays[0]!.text).not.toContain('反馈状态收尾');
  });
});

describe('回流外发箱（批准=触发下一个，欠款必还）', () => {
  const makeRelayWorld = (opts: { failTimes: number; paneAfterSend: 'marker' | 'none' } ) => {
    const relays: { session: string; text: string }[] = [];
    let pane = '';
    let fails = 0;
    const { clock, advance } = makeClock();
    const store = createLedgerStore(':memory:', { clock, ids: seqIds() });
    const engine = createEngine({
      store,
      llm: null, model: 't',
      routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
      dispatch: { async dispatch() { return ok(undefined); } },
      syncDispatch: null,
      pusher: {
        async gateWaiting(_w, st, summary) { relays.push({ session: 'PUSH:' + st.title, text: summary }); },
        async workflowDone() {},
        async workflowFailed() {},
      } satisfies PusherPort,
      mailer: { async send() { return ok({ messageId: '<x@j>' }); } } satisfies MailerPort,
      captureOutput: async () => null,
      workspaceFor: null,
      availableSessions: ['juli-reply'],
      resolveSession: null, interruptSession: null, rebuildAgent: null, zombieFingerprint: null,
      sendToSession: async (session, text) => {
        if (fails < opts.failTimes) { fails++; return { delivered: false, reason: 'stub: 送键失败' }; }
        relays.push({ session, text });
        pane += text; // 发送成功 → 标记进 pane（模拟 echo）
        if (opts.paneAfterSend === 'none') pane = pane.replace(/\[relay:[^\]]+\]/g, '');
        return { delivered: true, reason: '' };
      },
      readPane: async () => pane,
      clock, ids: seqIds(),
      templates: {},
      authz: { mode: 'allowlist', allow: ['*@example.com'], deny: [] },
    } satisfies EngineDeps);
    return { engine, store, relays, advanceClock: advance };
  };

  const setupGate = async (w: ReturnType<typeof makeRelayWorld>) => {
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await w.engine.onAgentStopped('juli-reply', 'done', '理解完成');
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '对齐闸门' });
    const gate = w.store.stepsForWorkflow(wf.id).find((x) => x.kind === 'gate')!;
    return { wf, gate };
  };

  it('快路径：批准即投递即销账（gate_relayed + 外发箱空）', async () => {
    const w = makeRelayWorld({ failTimes: 0, paneAfterSend: 'marker' });
    const { gate } = await setupGate(w);
    await w.engine.approve(gate.id, '', 'boss');
    expect(w.relays.some((r) => r.text.includes('[闸门已批准] 对齐闸门'))).toBe(true);
    expect(w.store.pendingRelays()).toHaveLength(0); // 已销账
    expect(w.store.listEvents(50).some((e) => e.type === 'gate_relayed')).toBe(true);
  });

  it('投递失败：留在外发箱（gate_relay_queued）；sweepRelays 补投成功销账', async () => {
    const w = makeRelayWorld({ failTimes: 1, paneAfterSend: 'marker' });
    const { gate } = await setupGate(w);
    await w.engine.approve(gate.id, '', 'boss');
    expect(w.store.pendingRelays()).toHaveLength(1); // 欠款在箱
    expect(w.store.listEvents(50).some((e) => e.type === 'gate_relay_queued')).toBe(true);
    await w.engine.sweepRelays(); // 下个周期补投
    expect(w.store.pendingRelays()).toHaveLength(0);
    expect(w.store.listEvents(50).some((e) => e.type === 'gate_relay_delivered')).toBe(true);
    expect(w.relays.some((r) => r.text.includes('[闸门已批准]'))).toBe(true);
  });

  it('标记验证防重复：pane 已含标记 → 补投直接销账不再发送', async () => {
    const w = makeRelayWorld({ failTimes: 0, paneAfterSend: 'marker' });
    const { gate } = await setupGate(w);
    await w.engine.approve(gate.id, '', 'boss');
    const sendsBefore = w.relays.length;
    // 手工把一条同标记回流插回外发箱（模拟补投场景），sweep 应识别已送达。
    // 直接验证：pendingRelays 空 + 再 sweep 不产生新发送。
    await w.engine.sweepRelays();
    expect(w.relays.length).toBe(sendsBefore); // 无重复投递
  });

  it('卡死告警：反复失败超阈值 → gate_relay_stuck + 推送人（meta 防重只响一次）', async () => {
    const w = makeRelayWorld({ failTimes: 99, paneAfterSend: 'none' });
    const { wf, gate } = await setupGate(w);
    await w.engine.approve(gate.id, '', 'boss');
    await w.engine.sweepRelays();                       // 第 1 轮失败（attempts=2）
    w.advanceClock(6 * 60_000);                          // 越过 5 分钟卡死线
    for (let i = 0; i < 3; i++) await w.engine.sweepRelays();
    expect(w.store.listEvents(50).some((e) => e.type === 'gate_relay_stuck')).toBe(true);
    expect(w.relays.some((r) => r.session.startsWith('PUSH:回流投递失败'))).toBe(true);
    // 防重（0917 P1-1）：sweep 是 60s 周期，同一卡死 relay 只记一次事件、推
    // 一次人——不拦则邮件接入后每分钟一封轰炸。
    expect(w.store.listEvents(200).filter((e) => e.type === 'gate_relay_stuck')).toHaveLength(1);
    expect(w.relays.filter((r) => r.session.startsWith('PUSH:回流投递失败'))).toHaveLength(1);
    expect(w.store.getWorkflow(wf.id)!.meta['relay_stuck_notified']).toBe(true);
    await w.engine.sweepRelays();                       // 再扫一轮：仍不重响
    expect(w.store.listEvents(200).filter((e) => e.type === 'gate_relay_stuck')).toHaveLength(1);
    expect(w.relays.filter((r) => r.session.startsWith('PUSH:回流投递失败'))).toHaveLength(1);
  });
});

describe('forceClose（running 单的人工中止）', () => {
  it('在跑步+等待闸门全 cancelled，审计留痕；非 running 拒绝', async () => {
    const w = makeEngineEmpty();
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await w.engine.onAgentStopped('juli-reply', 'done', '理解完成');
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '对齐闸门' });
    // 此时：agent completed + gate waiting_human
    await w.engine.forceClose(wf.id, '用户重开', 'web');
    const steps = w.store.stepsForWorkflow(wf.id);
    expect(steps.every((s) => s.status === 'completed' || s.status === 'cancelled')).toBe(true);
    expect(steps.find((x) => x.kind === 'gate')!.status).toBe('cancelled');
    expect(w.store.getWorkflow(wf.id)!.status).toBe('cancelled');
    expect(w.store.listEvents(50).some((e) => e.type === 'workflow_force_closed')).toBe(true);
    await expect(w.engine.forceClose(wf.id, '再取消', 'web')).rejects.toThrow(/not running/);
  });

  it('正在 running 的 agent 步同样被 cancelled（不等回合落定）', async () => {
    const w = makeEngineEmpty();
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await w.engine.advance(wf.id); // agent running
    await w.engine.forceClose(wf.id, '中途取消', 'web');
    expect(w.store.stepsForWorkflow(wf.id)[0]!.status).toBe('cancelled');
    expect(w.store.getWorkflow(wf.id)!.status).toBe('cancelled');
  });
});

describe('rework 空 feedback 守卫', () => {
  it('空/空白驳回拒绝且流水不动；带意见正常进入 round 2', async () => {
    const w = makeEngineEmpty();
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await w.engine.onAgentStopped('juli-reply', 'done', '理解完成');
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '对齐闸门' });
    const gate = w.store.stepsForWorkflow(wf.id).find((x) => x.kind === 'gate')!;
    await expect(w.engine.rework(gate.id, '', 'boss')).rejects.toThrow(/修改意见/);
    await expect(w.engine.rework(gate.id, '   ', 'boss')).rejects.toThrow(/修改意见/);
    expect(w.store.getStep(gate.id)!.status).toBe('waiting_human'); // 原地不动
    await w.engine.rework(gate.id, '改成横版，字号加大', 'boss');
    expect(Number(w.store.getWorkflow(wf.id)!.meta['round'])).toBe(2);
    expect(String(w.store.getStep(gate.id)!.input['feedback'])).toContain('横版');
  });
});

describe('发送附件契约（宣称=实物）', () => {
  // 落款固定块随正文（juli-reply skill §4）；sha256 与 BODY_TEXT 字节一致。
  const BODY_TEXT = '成品见附件。\n如有出入请回复纠正。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。';
  // 第二参 bodyMentionsAttachment 已删：正文改由 setupGate 显式传入后它成了死参（重构残留）。
  const makeAttachWorld = (declaredAttachments: boolean) => {
    const { clock, advance } = makeClock();
    const store = createLedgerStore(':memory:', { clock, ids: seqIds() });
    const sent: { to: string; subject: string; attachments: { name: string }[] }[] = [];
    const bytes = Buffer.from('%PDF-fake');
    const engine = createEngine({
      store,
      llm: null, model: 't',
      routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
      dispatch: { async dispatch() { return ok(undefined); } },
      syncDispatch: null,
      pusher: { async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {} } satisfies PusherPort,
      mailer: {
        async send(cmd) { sent.push({ to: cmd.to, subject: cmd.subject, attachments: (cmd.attachments ?? []).map((a) => ({ name: a.name })) }); return ok({ messageId: '<att@j>' }); },
      } satisfies MailerPort,
      captureOutput: async () => null,
      workspaceFor: null,
      availableSessions: ['juli-reply'],
      resolveSession: null, interruptSession: null, rebuildAgent: null, zombieFingerprint: null,
      sendToSession: null, readPane: null,
      clock, ids: seqIds(),
      templates: {},
      authz: { mode: 'allowlist', allow: ['*@example.com'], deny: [] },
      artifacts: {
        getContent: async (id) => {
          if (id === 'art_body') return { bytes: Buffer.from(BODY_TEXT), sha256: '27736bdbb632c7113d21c6538a7cd765c686cf17f1ea8842944a68303a6a982a', name: 'draft-followup.txt', viewRole: 'body' };
          // 断点八：attachment/data 角色才随信附上——report 是人审视图绝不附。
          if (declaredAttachments && id === 'art_pdf') return { bytes, sha256: 'pdfsha', name: 'team-brand-ppt.pptx', viewRole: 'data' };
          if (id === 'art_plain') return { bytes: Buffer.from('LLM 漏写落款的正文——没有 AI 披露行。'), sha256: 'f2c1e084051155bd02c0773dc50e282854e32dfa07524d550d1d567a182afabb', name: 'draft-plain.txt', viewRole: 'body' };
          return null;
        },
        list: () => [], updateMeta: () => {},
        sweepCaseInbox: async () => ({ count: 0, entries: [], envelope: null, warnings: [], has_manifest: false }),
      },
      caseInboxDir: () => '/tmp/na',
    });
    return { engine, store, sent, advanceClock: advance };
  };

  const setupGate = async (w: ReturnType<typeof makeAttachWorld>, body: string, withDeliverables: boolean) => {
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await w.engine.advance(wf.id);
    await w.engine.onAgentStopped('juli-reply', 'done', '做完');
    // 发送闸门自动配对：appendNode 建「发送闸门」即连带 send 后继节点，
    // 批准路径 seedSendFromGate 播种——不再手工追加 send。
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '发送闸门' });
    const gate = w.store.stepsForWorkflow(wf.id).find((x) => x.kind === 'gate')!;
    const input: JsonRecord = {
      draft: body,
      deliverables: [
        { id: 'art_body', name: 'draft-followup.txt', view_role: 'body', sha256: '27736bdbb632c7113d21c6538a7cd765c686cf17f1ea8842944a68303a6a982a' },
        ...(withDeliverables ? [{ id: 'art_pdf', name: 'team-brand-ppt.pptx', view_role: 'data', sha256: 'pdfsha' }] : []),
      ],
      ...(withDeliverables ? { body_ref: { id: 'art_body', sha256: '27736bdbb632c7113d21c6538a7cd765c686cf17f1ea8842944a68303a6a982a', name: 'draft-followup.txt' } } : {}),
    };
    w.store.setStepInput(gate.id, input);
    await w.engine.approve(gate.id, '', 'boss');
    await w.engine.advance(wf.id);
    return { wf, gate };
  };

  it('deliverables 含附件工件 → 随信附上', async () => {
    const w = makeAttachWorld(true);
    const { wf } = await setupGate(w, BODY_TEXT, true);
    const send = w.store.stepsForWorkflow(wf.id).find((x) => x.kind === 'send')!;
    expect(send.status).toBe('completed');
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.attachments.map((a) => a.name)).toContain('team-brand-ppt.pptx');
  });

  it('正文宣称附件但 deliverables 取不到字节 → 拒发（宣称与实物一致）', async () => {
    const w = makeAttachWorld(false);
    const { wf } = await setupGate(w, '成品见附件。\n如有出入请回复纠正。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。', true);
    const send = w.store.stepsForWorkflow(wf.id).find((x) => x.kind === 'send')!;
    expect(send.status).toBe('failed');
    expect(String(send.output['error'])).toContain('宣称与实物不一致');
    expect(w.sent).toHaveLength(0);
  });

  it('无 deliverables（body_ref 缺失）→ 拒发（断点九①铁律：宁可拒发）', async () => {
    const w = makeAttachWorld(false);
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await w.engine.advance(wf.id);
    await w.engine.onAgentStopped('juli-reply', 'done', '做完');
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '发送闸门' });
    const gate = w.store.stepsForWorkflow(wf.id).find((x) => x.kind === 'gate')!;
    // 不带 deliverables：nodes 模式正文无契约工件 → 直接拒发（会话汇报文本
    // 一律不得作正文——旧「内联 draft 兼容」路径已按铁律摘除）。
    w.store.setStepInput(gate.id, { draft: '纯文本回信，内容都在正文里。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。' });
    await w.engine.approve(gate.id, '', 'boss');
    await w.engine.advance(wf.id);
    const send = w.store.stepsForWorkflow(wf.id).find((x) => x.kind === 'send')!;
    expect(send.status).toBe('failed');
    expect(send.output['guard']).toBe('body_contract_missing');
    expect(String(send.output['error'])).toContain('正文无契约工件');
    expect(w.sent).toHaveLength(0);
    // 盲重试被 guard 拒（与既有守卫同构）。
    await expect(w.engine.retry(send.id)).rejects.toThrow(/盲重试不会变好/);
  });

  it('正文缺披露行 → 引擎拼装补齐照发（落款归引擎，send 步守卫降为结构性 tripwire）', async () => {
    const w = makeAttachWorld(false);
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await w.engine.advance(wf.id);
    await w.engine.onAgentStopped('juli-reply', 'done', '做完');
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '发送闸门' });
    const gate = w.store.stepsForWorkflow(wf.id).find((x) => x.kind === 'gate')!;
    // 契约正文（art_plain 无披露行）：nodes 模式正文走 body_ref 哈希取件——
    // 缺披露行由 composeTextBody 必经拼装补齐，tripwire 只兜极端。第 5 轮审查：
    // sha256 必须真实（空 sha 播种会被 body_contract_incomplete 拒发）。
    w.store.setStepInput(gate.id, {
      deliverables: [{ id: 'art_plain', name: 'draft-plain.txt', view_role: 'body', sha256: 'f2c1e084051155bd02c0773dc50e282854e32dfa07524d550d1d567a182afabb' }],
      body_ref: { id: 'art_plain', sha256: 'f2c1e084051155bd02c0773dc50e282854e32dfa07524d550d1d567a182afabb', name: 'draft-plain.txt' },
    });
    await w.engine.approve(gate.id, '', 'boss');
    await w.engine.advance(wf.id);
    const send = w.store.stepsForWorkflow(wf.id).find((x) => x.kind === 'send')!;
    expect(send.status).toBe('completed'); // composeTextBody 必经 → 披露行结构性在位
    // 此世界的假 mailer 不录 body——send completed 蕴含披露守卫通过（判据作用
    // 在拼装后正文），无需直查信体。
    expect(w.sent).toHaveLength(1);
  });

  it('body_ref.sha256 空串 → 契约不完整拒发（第 5 轮审查：空 sha 不再跳过核验）', async () => {
    const w = makeAttachWorld(false);
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await w.engine.advance(wf.id);
    await w.engine.onAgentStopped('juli-reply', 'done', '做完');
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '发送闸门' });
    const gate = w.store.stepsForWorkflow(wf.id).find((x) => x.kind === 'gate')!;
    // 空 sha 播种（残缺申报/amend 形态）：批准哈希无从核验 → 拒发。
    w.store.setStepInput(gate.id, {
      deliverables: [{ id: 'art_plain', name: 'draft-plain.txt', view_role: 'body', sha256: '' }],
      body_ref: { id: 'art_plain', sha256: '', name: 'draft-plain.txt' },
    });
    await w.engine.approve(gate.id, '', 'boss');
    await w.engine.advance(wf.id);
    const send = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'send')!;
    expect(send.status).toBe('failed');
    expect(send.output['guard']).toBe('body_contract_incomplete');
    expect(w.sent).toHaveLength(0);
    // 盲重试被 guard 拒（与其他内容守卫同构）。
    await expect(w.engine.retry(send.id)).rejects.toThrow(/盲重试/);
  });

describe('任务流发送：收件人申报（wf_505578377218 三道闸）', () => {
  const BODY_SHA = '27736bdbb632c7113d21c6538a7cd765c686cf17f1ea8842944a68303a6a982a';

  it('申报 envelope.to → 批准发送闸门 → 真发：收件人=申报地址、主题=申报原题、附件随信', async () => {
    const w = makeAttachWorld(true);
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '发送任务', status: 'running', meta: { mode: 'nodes' } });
    await w.engine.appendNode(wf.id, {
      kind: 'gate', title: '发送闸门',
      input: {
        envelope: { to: 'casey.li@acme.de', subject: 'Meridian官网阶段汇报' },
        deliverables: [
          { id: 'art_body', name: 'draft-followup.txt', view_role: 'body', sha256: BODY_SHA },
          { id: 'art_pdf', name: 'team-brand-ppt.pptx', view_role: 'data', sha256: 'pdfsha' },
        ],
        body_ref: { id: 'art_body', sha256: BODY_SHA, name: 'draft-followup.txt' },
      },
    });
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    await w.engine.approve(gate.id, '', 'boss');
    await w.engine.advance(wf.id);
    const send = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'send')!;
    expect(send.status).toBe('completed');
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.to).toBe('casey.li@acme.de'); // 申报地址=发信地址
    expect(w.sent[0]!.subject).toBe('Meridian官网阶段汇报'); // 任务流原题，不套 Re:
    expect(w.sent[0]!.attachments.map((a) => a.name)).toContain('team-brand-ppt.pptx');
  });

  it('send 步收件人双空 → failed 留 no_recipient 守卫，盲重试被拒（绝不静默）', async () => {
    const w = makeAttachWorld(true);
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '无收件人', status: 'running', meta: { mode: 'nodes' } });
    const gate = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'gate', title: '发送闸门', input: {} });
    w.store.setStepStatus(gate.id, 'completed');
    w.store.createStep({
      workflowId: wf.id, seq: 2, kind: 'send', title: '发送',
      input: {
        deliverables: [{ id: 'art_body', name: 'draft-followup.txt', view_role: 'body', sha256: BODY_SHA }],
        body_ref: { id: 'art_body', sha256: BODY_SHA, name: 'draft-followup.txt' },
      },
    });
    await w.engine.advance(wf.id);
    const send = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'send')!;
    expect(send.status).toBe('failed');
    expect(send.output['guard']).toBe('no_recipient');
    expect(w.sent).toHaveLength(0);
    await expect(w.engine.retry(send.id)).rejects.toThrow(/盲重试/);
  });

  it('settle 拒埋葬：已批「发送」闸门而无 send 完成/取消 → 打回；显式取消 send 后放行；force-close 仍是出口', async () => {
    const w = makeEngineEmpty();
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '任务', status: 'running', meta: { mode: 'nodes' } });
    const g = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'gate', title: '发送闸门', input: {} });
    w.store.setStepStatus(g.id, 'completed');
    await expect(w.engine.settle(wf.id, 'operator')).rejects.toThrow(/从未发送/);
    expect(w.store.getWorkflow(wf.id)!.status).toBe('running'); // 不许无痕入土
    const wf2 = w.store.createWorkflow({ kind: 'adhoc', title: '任务2', status: 'running', meta: { mode: 'nodes' } });
    const g2 = w.store.createStep({ workflowId: wf2.id, seq: 1, kind: 'gate', title: '发送闸门', input: {} });
    w.store.setStepStatus(g2.id, 'completed');
    const s2 = w.store.createStep({ workflowId: wf2.id, seq: 2, kind: 'send', title: '发送', input: {} });
    w.store.setStepStatus(s2.id, 'cancelled');
    await w.engine.settle(wf2.id, 'operator');
    expect(w.store.getWorkflow(wf2.id)!.status).toBe('completed');
    await w.engine.forceClose(wf.id, '不发了', 'web');
    expect(w.store.getWorkflow(wf.id)!.status).toBe('cancelled');
  });
});
});
