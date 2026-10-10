// agent 步任务卡渲染：缺 plan 时 prompt 模板对 flow context 渲染——参数化
// 进件的原文直读（{{.Input.body}}），压缩摘要不再是 agent 的唯一信息源。
// 老流不受影响：email-reply 的 agent 步由闸门播种 plan，不触发此路径。

import { describe, expect, it } from 'vitest';
import { makeEmail, makeEngine, until } from './helpers.ts';
import { parseTemplate } from '../src/business/templates/template.ts';
import { type StepKind } from '@juli-os/ledger';
import type { ArtifactPort } from '../src/contracts/ports.ts';

const V2_YAML = `key: email-intake-v2
name: 邮件进件v2（理解→对齐）
trigger: manual
zombie:
  timeout: 15m
  max_attempts: 2
steps:
  - id: understand
    kind: agent
    title: 理解turn
    prompt: |
      [邮件原文]
      发件人: {{.Input.from}}
      主题: {{.Input.subject}}
      正文: {{.Input.body}}
      只输出理解（意图/分类/分解提案/路由建议），不执行任何一步。
  - id: align_gate
    kind: gate
    title: 对齐闸门
`;

describe('agent 步任务卡渲染', () => {
  it('参数化启动 → prompt 渲染原文进派发文本 → 对齐闸门审批后收口', async () => {
    const w = makeEngine();
    w.engine.setTemplates({ 'email-intake-v2': parseTemplate(V2_YAML) });
    await w.engine.startFlow('email-intake-v2', '参数化进件', {
      from: 'casey@acme.de',
      subject: 'about acme',
      body: '请调整 about acme 板块方向，重点呈现集团背景。',
      session: 'agent-a',
    });
    await until(() => w.dispatched.length > 0);
    const d = w.dispatched[0]!;
    expect(d.session).toBe('agent-a');
    expect(d.text).toContain('casey@acme.de');
    expect(d.text).toContain('请调整 about acme 板块方向');
    expect(d.text).toContain('只输出理解');

    const wfId = w.store.listWorkflows()[0]!.id;
    await w.engine.onAgentStopped('agent-a', 'done');
    await until(() => w.store.stepsForWorkflow(wfId)[1]!.status === 'waiting_human');
    await w.engine.approve(w.store.stepsForWorkflow(wfId)[1]!.id, '理解正确', 'boss');
    await until(() => w.store.getWorkflow(wfId)?.status === 'completed');
  });

  it('plan 显式存在时 prompt 不掺和（老流语义不变）', async () => {
    const w = makeEngine();
    w.engine.setTemplates({ 'email-intake-v2': parseTemplate(V2_YAML) });
    await w.engine.startFlow('email-intake-v2', '显式计划', {
      from: 'a@b.c', subject: 's', body: '正文原文',
      session: 'agent-a', plan: '直接按这份计划执行：XXX',
    });
    await until(() => w.dispatched.length > 0);
    expect(w.dispatched[0]!.text).toContain('直接按这份计划执行');
    expect(w.dispatched[0]!.text).not.toContain('正文原文');
  });

  // wf_9658ce9225e0 回归（2026-10-05）：任务卡工件契约行对齐 makro-artifacts
  // 终版裁定——主交付物=单一 HTML，body.txt 仅发送语义。旧措辞把「body=纯文本
  // 正文」列首位，apply 类单被带偏成只交 txt。
  it('交付契约行：主交付物=一件自包含 HTML，txt 仅发送语义（不发信不产 txt）', async () => {
    const artifacts: ArtifactPort = {
      list: () => [],
      updateMeta: () => {},
      sweepCaseInbox: async () => ({ count: 0, entries: [], envelope: null, warnings: [], has_manifest: false }),
    };
    const w = makeEngine({ artifacts, caseInboxDir: (wf) => `/tmp/case-inbox/${wf}` });
    w.engine.setTemplates({ 'email-intake-v2': parseTemplate(V2_YAML) });
    await w.engine.startFlow('email-intake-v2', '契约行', {
      from: 'a@b.c', subject: 's', body: '正文', session: 'agent-a',
    });
    await until(() => w.dispatched.length > 0);
    const text = w.dispatched[0]!.text;
    expect(text).toContain('主交付物=一件自包含 HTML');
    expect(text).toContain('id="makro-meta"');
    expect(text).toContain('不发信不产 txt');
    expect(text).toContain('/tmp/case-inbox/');
    // 旧契约行（body 列首位的诱导源）不得再出现
    expect(text).not.toContain('body=将发出的纯文本正文');
  });
});

describe('干预重试 patch', () => {
  it('失败步 retry 携带 plan/session 补丁——覆写后重臂再派发', async () => {
    const seen: { session: string; text: string }[] = [];
    const w = makeEngine({
      dispatch: {
        async dispatch(_source, session, text) {
          seen.push({ session, text });
          return { ok: false as const, error: new Error('boom') };
        },
      },
    });
    w.engine.setTemplates({ 'email-intake-v2': parseTemplate(V2_YAML) });
    await w.engine.startFlow('email-intake-v2', '干预', { body: '原文', session: 'agent-a', plan: '原始计划' });
    const wfId = w.store.listWorkflows()[0]!.id;
    await until(() => w.store.stepsForWorkflow(wfId)[0]!.status === 'failed');
    await w.engine.retry(w.store.stepsForWorkflow(wfId)[0]!.id, { plan: '修正后的计划', session: 'agent-b' });
    await until(() => seen.length === 2);
    expect(seen[1]!.session).toBe('agent-b');
    expect(seen[1]!.text).toContain('修正后的计划');
    const st = w.store.getStep(w.store.stepsForWorkflow(wfId)[0]!.id);
    expect(st?.input['plan']).toBe('修正后的计划');
  });
});

const FULL_YAML = `key: intake-full
name: 全链
trigger: manual
steps:
  - id: understand
    kind: agent
    title: 理解
    prompt: "理解这封邮件: {{.Input.body}}"
  - id: align_gate
    kind: gate
    title: 对齐闸门
  - id: execute
    kind: agent
    title: 执行交付
    session: "{{.Steps.understand.output.session}}"
    prompt: |
      按对齐后的理解执行:
      {{.Steps.understand.output.output}}
      [交付契约] makro-artifacts 三件套;视觉 juli-brand;图标 juli-icons。
  - id: quality_gate
    kind: gate
    title: 质量闸门
  - id: reply
    kind: agent
    title: 答复草稿
    session: "{{.Steps.understand.output.session}}"
    prompt: |
      按 juli-reply skill 规范起草回信。
      [理解] {{.Steps.understand.output.output}}
      [执行产出] {{.Steps.execute.output.output}}
      只输出可直接发出的回信全文(纯文本)。
  - id: publish_gate
    kind: gate
    title: 发送决定
`;

describe('skill 接入管线', () => {

  it('对齐闸门批准后,执行步任务卡引用理解全文与 skill 契约', async () => {
    const w = makeEngine();
    w.engine.setTemplates({ 'intake-full': parseTemplate(FULL_YAML) });
    await w.engine.startFlow('intake-full', '全链', { body: '客户要一个案例模块', session: 'agent-a' });
    const wfId = w.store.listWorkflows()[0]!.id;
    await until(() => w.dispatched.length === 1);          // 理解 turn
    await w.engine.onAgentStopped('agent-a', 'done', '理解全文:客户要一个案例模块,建议分两阶段');
    await until(() => w.store.stepsForWorkflow(wfId)[1]!.status === 'waiting_human');
    await w.engine.approve(w.store.stepsForWorkflow(wfId)[1]!.id, '理解对齐', 'boss');
    await until(() => w.dispatched.length === 2);          // 执行 turn
    expect(w.dispatched[1]!.session).toBe('agent-a');       // session 跟随理解步
    expect(w.store.getWorkflow(wfId)?.session).toBe('agent-a'); // 回填导航字段
    const execText = w.dispatched[1]!.text;
    expect(execText).toContain('客户要一个案例模块');        // 理解全文流入执行卡
    expect(execText).toContain('makro-artifacts');          // skill 契约在卡上
    expect(execText).toContain('juli-brand');
  });
});

describe('juli-reply 接入 v2', () => {
  it('质量闸门后,答复步任务卡带 juli-reply 契约并引用理解与执行产出', async () => {
    const w = makeEngine();
    w.engine.setTemplates({ 'intake-full': parseTemplate(FULL_YAML) });
    await w.engine.startFlow('intake-full', '全链含答复', { body: '客户要一个案例模块', session: 'agent-a' });
    const wfId = w.store.listWorkflows()[0]!.id;
    await until(() => w.dispatched.length === 1);
    await w.engine.onAgentStopped('agent-a', 'done', '理解全文:客户要一个案例模块');
    await until(() => w.store.stepsForWorkflow(wfId)[1]!.status === 'waiting_human');
    await w.engine.approve(w.store.stepsForWorkflow(wfId)[1]!.id, '', 'boss');
    await until(() => w.dispatched.length === 2);
    await w.engine.onAgentStopped('agent-a', 'done', '执行汇报:页面已交付,链接见 artifact');
    await until(() => w.store.stepsForWorkflow(wfId)[3]!.status === 'waiting_human'); // quality_gate
    await w.engine.approve(w.store.stepsForWorkflow(wfId)[3]!.id, '', 'boss');
    await until(() => w.dispatched.length === 3);          // 答复 turn
    const replyText = w.dispatched[2]!.text;
    expect(replyText).toContain('juli-reply');              // 答复规范契约在卡上
    expect(replyText).toContain('客户要一个案例模块');        // 理解流入
    expect(replyText).toContain('页面已交付');               // 执行产出流入
    expect(w.dispatched[2]!.session).toBe('agent-a');
  });
});

describe('单步起流与 meta.from', () => {
  it('onlySteps 过滤阶梯:只跑选中的步,顺序保持;子集首步带完整 input', async () => {
    const w = makeEngine();
    w.engine.setTemplates({ 'intake-full': parseTemplate(FULL_YAML) });
    await w.engine.startFlow('intake-full', '只跑理解', { body: '原文来了', session: 'agent-a' }, ['understand']);
    const wfId = w.store.listWorkflows()[0]!.id;
    const steps = w.store.stepsForWorkflow(wfId);
    expect(steps.length).toBe(1);
    expect(steps[0]!.kind).toBe('agent');
    await until(() => w.dispatched.length === 1);
    expect(w.dispatched[0]!.text).toContain('原文来了');   // 子集首步合并完整 input
  });

  it('unknown step id 报错;input.from 进 meta(send 能力前提)', async () => {
    const w = makeEngine();
    w.engine.setTemplates({ 'intake-full': parseTemplate(FULL_YAML) });
    await expect(w.engine.startFlow('intake-full', 'x', {}, ['nope'])).rejects.toThrow('unknown step ids: nope');
    const w2 = makeEngine();
    w2.engine.setTemplates({ 'intake-full': parseTemplate(FULL_YAML) });
    const wf = await w2.engine.startFlow('intake-full', '带 from', { from: 'casey@acme.de', subject: 's', body: 'b', session: 'agent-a' }, ['understand']);
    expect(wf.meta['from']).toBe('casey@acme.de');
    expect(wf.meta['subject']).toBe('s');
  });
});

describe('批准即发送', () => {
  it('agent 答复 → 发送闸门批准 → SMTP 发出(meta.from 收件)', async () => {
    const w = makeEngine();
    w.engine.setTemplates({
      'reply-only': parseTemplate(`key: reply-only
name: r
trigger: manual
steps:
  - id: reply
    kind: agent
    title: 起草答复
    session: agent-a
    prompt: 按邮件起草答复
  - id: send_gate
    kind: gate
    title: 发送决定
  - id: send
    kind: send
    title: SMTP 发送
`),
    });
    await w.engine.startFlow('reply-only', '直发', { from: 'casey@acme.de', subject: 'Re: 需求', session: 'agent-a' });
    const wfId = w.store.listWorkflows()[0]!.id;
    await until(() => w.dispatched.length === 1);
    // 正文不宣称附件（无交付契约时宣称附件会撞 declared_attachments_missing 守卫）。
    await w.engine.onAgentStopped('agent-a', 'done', '您好，修订稿已交付，请查收。如有出入请回复本邮件。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。');
    await until(() => w.store.stepsForWorkflow(wfId)[1]!.status === 'waiting_human');
    await w.engine.approve(w.store.stepsForWorkflow(wfId)[1]!.id, '', 'boss');
    await until(() => w.sent.length === 1);
    expect(w.sent[0]!.to).toBe('casey@acme.de');
    expect(w.sent[0]!.body).toContain('修订稿已交付');
    await until(() => w.store.getWorkflow(wfId)?.status === 'completed');
  });
});

describe('回修环(HITL)', () => {
  it('交付审阅驳回 → feedback 注入 work 步重做 → 轮次+1 → 再审', async () => {
    const w = makeEngine();
    w.engine.setTemplates({ 'intake-full': parseTemplate(FULL_YAML) });
    await w.engine.startFlow('intake-full', '回修', { body: '客户原始诉求', session: 'agent-a' }, ['understand', 'align_gate']);
    const wfId = w.store.listWorkflows()[0]!.id;
    await until(() => w.dispatched.length === 1);
    w.agentOutputs.set('agent-a', '理解 v1:做案例模块');
    await w.engine.onAgentStopped('agent-a', 'done');
    await until(() => w.store.stepsForWorkflow(wfId)[1]!.status === 'waiting_human');
    await w.engine.rework(w.store.stepsForWorkflow(wfId)[1]!.id, '理解错了,重点是英文文案润色', 'boss');
    await until(() => w.dispatched.length === 2);
    expect(w.dispatched[1]!.text).toContain('英文文案润色');          // feedback 进入重做任务卡
    expect(w.store.getWorkflow(wfId)?.meta['round']).toBe(2);
    // 二版理解 → 闸门再开 → 批准 → 完成
    w.agentOutputs.set('agent-a', '理解 v2:英文文案润色为主');
    await w.engine.onAgentStopped('agent-a', 'done');
    await until(() => w.store.stepsForWorkflow(wfId)[1]!.status === 'waiting_human');
    await w.engine.approve(w.store.stepsForWorkflow(wfId)[1]!.id, 'v2 对齐', 'boss');
    await until(() => w.store.getWorkflow(wfId)?.status === 'completed');
  });
});

describe('线程链', () => {
  it('In-Reply-To 指向已知邮件 → 新流 parent 挂到原流,meta 记链', async () => {
    const w = makeEngine();
    await w.engine.onEmailReceived({ ...makeEmail(), subject: '首封' });
    const first = w.store.listWorkflows()[0]!.id;
    const mid = '<orig-1@example.com>';
    await w.engine.onEmailReceived({
      ...makeEmail(), subject: 'Re: 首封', messageId: '<reply-1@x>', uid: 2,
      inReplyTo: mid, references: mid,
    });
    const second = w.store.listWorkflows().find((x) => x.id !== first)!;
    expect(second.parentId).toBe(first);
    expect(second.meta['related_workflow']).toBe(first);
  });
});

describe('nodes 模式(动作生节点)', () => {
  const NODES_YAML = `key: task-nodes
name: 节点任务
trigger: manual
mode: nodes
steps: []
`;

  it('动作生节点:work→review→send 全链,send 前置校验生效', async () => {
    const w = makeEngine({
      // 断点九①铁律：nodes 模式正文只认 body_ref 契约工件——闸门带 body
      // 工件指针，appendNode 补种后 send 步按哈希取件。
      artifacts: {
        list: () => [],
        updateMeta: () => {},
        getContent: async (id) => id === 'art_body'
          ? { bytes: Buffer.from('交付物:banner-v3.html + 修订说明'), sha256: 'c02a82d624ac25f3a8fda6aa4ed48b39c5252ee4349aa4e18fa5c205e0a24ad5', name: 'b.txt', viewRole: 'body' }
          : null,
        sweepCaseInbox: async () => ({ count: 0, entries: [], envelope: null, warnings: [], has_manifest: false }),
      },
    });
    w.engine.setTemplates({ 'task-nodes': parseTemplate(NODES_YAML) });
    const wf = await w.engine.startFlow('task-nodes', '节点任务', { from: 'casey@acme.de', subject: 's' });
    expect(w.store.stepsForWorkflow(wf.id).length).toBe(0);      // 无预建阶梯
    expect(w.store.getWorkflow(wf.id)?.status).toBe('running');  // 空档≠完成

    // claim → work 节点(agent)派发
    await w.engine.appendNode(wf.id, { kind: 'agent', title: '执行交付', input: { session: 'agent-a', prompt: '按邮件原文交付' } });
    await until(() => w.dispatched.length === 1);
    await w.engine.onAgentStopped('agent-a', 'done', '交付物:banner-v3.html + 修订说明\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。');   // 结算 work 节点
    expect(w.dispatched[0]!.session).toBe('agent-a');

    // review 闸门节点 → 开启等人工
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '交付审阅' });
    await until(() => w.store.stepsForWorkflow(wf.id).some((s) => s.status === 'waiting_human'));
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.status === 'waiting_human')!;
    // 契约正文：批准前给闸门钉上 body 工件指针（人审的就是工件版本）。
    w.store.setStepInput(gate.id, {
      deliverables: [{ id: 'art_body', name: 'b.txt', view_role: 'body', sha256: 'c02a82d624ac25f3a8fda6aa4ed48b39c5252ee4349aa4e18fa5c205e0a24ad5' }],
    });
    await w.engine.approve(gate.id, '', 'boss');

    // send 前置校验:review 已批准,应放行
    await w.engine.appendNode(wf.id, { kind: 'send', title: '发送' });
    // P0 锁定：approve 播种发生在 send 节点存在之前，appendNode 必须从最近
    // 已批准闸门补种——body_ref 随补种到达、send completed、会话收尾后自动
    // 收口（auto-settle）。
    await until(() => w.sent.length === 1);
    expect(w.sent[0]!.to).toBe('casey@acme.de');
    expect(w.sent[0]!.body).toContain('banner-v3.html'); // 批准闸门携带的正文（工件哈希取件）
    expect(w.sent[0]!.subject).toBe('Re: s');
    const st = w.store.stepsForWorkflow(wf.id);
    const send = st.find((s) => s.kind === 'send')!;
    expect(send.status).toBe('completed');
    expect(String(send.output['body_via'])).toMatch(/^artifact:/); // 契约哈希取件路径
    // 发送≠完成：engine 发送后仍是 running，等会话收尾回合（skill 结束）落账。
    expect(w.store.getWorkflow(wf.id)?.status).toBe('running');
    await w.engine.assignSession(wf.id, 'agent-a', 'op');
    await w.engine.onAgentStopped('agent-a', 'done', '已发送 banner-v3，message_id=…');
    // 会话收尾回合落账 → 自动 settle（by=auto-send）。
    expect(w.store.getWorkflow(wf.id)?.status).toBe('completed');
  });

  it('send 前置校验:无已批准闸门 → 拒绝追加', async () => {
    const w = makeEngine();
    w.engine.setTemplates({ 'task-nodes': parseTemplate(NODES_YAML) });
    const wf = await w.engine.startFlow('task-nodes', '无审批', {});
    await expect(w.engine.appendNode(wf.id, { kind: 'send', title: '发送' })).rejects.toThrow();
  });

  it('kind 前置校验:非法 kind(HTTP 直通面) → 拒绝,绝不写入待冻节点', async () => {
    const w = makeEngine();
    w.engine.setTemplates({ 'task-nodes': parseTemplate(NODES_YAML) });
    const wf = await w.engine.startFlow('task-nodes', '坏节点', {});
    await expect(w.engine.appendNode(wf.id, { kind: 'bogus' as unknown as StepKind, title: 'x' }))
      .rejects.toThrow(/unknown step kind/);
    expect(w.store.stepsForWorkflow(wf.id).length).toBe(0); // 什么都没写进去
  });

  it('deliver(evidence):draft 节点的 LLM user prompt 含 evidence 文本', async () => {
    const w = makeEngine();
    w.engine.setTemplates({ 'task-nodes': parseTemplate(NODES_YAML) });
    const wf = await w.engine.startFlow('task-nodes', '证据', { from: 'casey@acme.de' });
    await w.engine.appendNode(wf.id, {
      kind: 'draft', title: '答复草稿',
      input: { evidence: 'banner v7 已交付并通过 QA，外链 https://cdn.example.com/banner.html' },
    });
    await until(() => w.store.stepsForWorkflow(wf.id).some((s) => s.kind === 'draft' && s.status === 'completed'));
    const call = w.llmCalls.find((c) => c.system.includes('商务邮件助理'));
    expect(call).toBeTruthy();
    expect(call!.user).toContain('banner v7 已交付并通过 QA'); // evidence 抵达 LLM
  });

  it('空档不完成:节点间 workflow 保持 running', async () => {
    const w = makeEngine();
    w.engine.setTemplates({ 'task-nodes': parseTemplate(NODES_YAML) });
    const wf = await w.engine.startFlow('task-nodes', '空档', {});
    await new Promise((r) => setTimeout(r, 100));
    expect(w.store.getWorkflow(wf.id)?.status).toBe('running');
  });
});

describe('宪法头（2026-09-21 深夜事故：契约文本分裂在域 skill 里）', () => {
  it('每张任务卡都带 juli-constitution 指针与最硬三条', async () => {
    const { planPrompt } = await import('../src/business/workflow/capabilities/common.ts');
    const prompt = planPrompt('【feedback 工单】record x');
    expect(prompt).toContain('juli-constitution');
    expect(prompt).toContain('收工前挂闸门节点');
    expect(prompt).toContain('对外发信只走引擎闸门');
    expect(prompt).toContain('域内 skill 与宪法冲突时以宪法为准');
    expect(prompt).toContain('【feedback 工单】record x'); // 原计划原样保留
  });
});
