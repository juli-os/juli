// 周度审查修复回归锁（PROBLEMS-20260920-week.md，2026-09-20）：
// P0  收件人劫持：回信流 envelope.to 不得覆盖 meta.from（seed/mailer/审计事件三面）
// P1  回信流信封收口（PROBLEMS-R2）：envelope.cc/subject 与 to 同一 meta.from
//     判据——回信流申报 cc/subject 不进实发 + envelope_cc_override_ignored 审计
// P1  self-echo：已发送 message_id 回灌进件 → 不建单 + self_echo_ignored 事件
// P1  HTTP 旁道：/api/sessions/:name/send 绑定会话拒；/api/email/simulate 默认关
// P2  发送语义判据与标题解耦：auto-pair / settle 拒埋葬 / 悬空检测认 envelope.to
// P2  startTask 播种后推进 fire-and-forget：冷会话 240s 不串进起单等待
// P2  财务备份告警通道缺失：醒目日志（启动 + 发不出时）
// P3  近匹配绑定会话守卫：大小写变体显式 failed，不落回默认会话
// P3  ladder 回信流不认申报主题（envelope.subject 模式门）
// P3  parseOssLs 时区宽容（+00:00 UTC 等固定偏移可解析）

import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedgerStore } from '@juli-os/ledger';
import { createEngine, type EngineDeps } from '../src/business/workflow/engine.ts';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime, type RuntimeSeams } from '../src/runtime.ts';
import { createHttpApp } from '../src/http/app.ts';
import { ok } from '@juli-os/artifacts';
import { makeClock, makeEmail, seqIds, until } from './helpers.ts';
import type { ArtifactPort, MailerPort, PusherPort } from '../src/contracts/ports.ts';

const BODY = '回信正文如约定。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。';
const BODY_SHA = '40eabe02c026a84872c59362cf0124713e687840a5f391f0b4acf5fd36c8649d';

const makeWorld = (over: Partial<EngineDeps> = {}) => {
  const { clock } = makeClock();
  const store = createLedgerStore(':memory:', { clock, ids: seqIds() });
  const dispatched: { session: string; text: string }[] = [];
  const sent: { to: string; subject: string; cc?: readonly string[] }[] = [];
  const engine = createEngine({
    store,
    llm: null, model: 't',
    routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
    dispatch: { async dispatch(_s, session, text) { dispatched.push({ session, text }); return ok(undefined); } },
    syncDispatch: null,
    pusher: { async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {} } satisfies PusherPort,
    mailer: {
      async send(cmd) { sent.push({ to: cmd.to, subject: cmd.subject, cc: cmd.cc }); return ok({ messageId: '<out-1@juli.local>' }); },
    } satisfies MailerPort,
    captureOutput: async () => null, workspaceFor: null,
    availableSessions: ['juli-reply'], resolveSession: null, interruptSession: null,
    rebuildAgent: null, zombieFingerprint: null, clock, ids: seqIds(), templates: {},
    authz: { mode: 'allowlist', allow: ['*@example.com'], deny: [] },
    artifacts: {
      list: () => [], updateMeta: () => {},
      getContent: async (id) => id === 'art_body'
        ? { bytes: Buffer.from(BODY), sha256: BODY_SHA, name: 'b.txt', viewRole: 'body' }
        : null,
      sweepCaseInbox: async () => ({ count: 0, entries: [], envelope: null, warnings: [], has_manifest: false }),
    } satisfies ArtifactPort,
    caseInboxDir: () => '/tmp/na',
    ...over,
  } satisfies EngineDeps);
  return { engine, store, dispatched, sent };
};

describe('P0 收件人劫持：回信流 envelope.to 不得覆盖 meta.from', () => {
  it('reviewer 复现路径：闸门申报 envelope.to=attacker → 批准 → 实发仍锁原发件人 + 审计事件留痕', async () => {
    const w = makeWorld();
    const wf = await w.engine.startEmailWorkflow(makeEmail()); // from=boss@example.com, mode=nodes
    await w.engine.advance(wf.id);
    await w.engine.onAgentStopped('juli-reply', 'done', '理解完成');
    await w.engine.appendNode(wf.id, {
      kind: 'gate', title: '发送闸门',
      // 被提示注入的 agent 申报劫持收件人（reviewer 复现脚本原值）
      input: { envelope: { to: 'attacker@evil.example', subject: '正常主题' } },
    });
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    w.store.setStepInput(gate.id, {
      checks: [{ name: 'redline', status: 'pass', detail: '' }, { name: 'body', status: 'pass', detail: '' }],
      deliverables: [{ id: 'art_body', name: 'b.txt', view_role: 'body', sha256: BODY_SHA }],
    });
    await w.engine.approve(gate.id, '发', 'boss');
    await until(() => w.sent.length === 1);
    // 所见（卡上 meta.from）= 所发（mailer 实收）——申报地址被忽略。
    expect(w.sent[0]!.to).toBe('boss@example.com');
    expect(w.sent[0]!.to).not.toBe('attacker@evil.example');
    const send = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'send')!;
    expect(send.input['to']).toBe('boss@example.com'); // 种子侧同序
    // 审计：被忽略的申报值留 envelope_override_ignored 事件。
    const ev = w.store.listEvents(200).find((e) => e.type === 'envelope_override_ignored');
    expect(ev).toBeDefined();
    expect(ev!.payload['declared_to']).toBe('attacker@evil.example');
    expect(ev!.payload['locked_to']).toBe('boss@example.com');
  });

  it('任务流（from 空）对照：申报 envelope.to 仍是发信地址（既有契约不回退）', async () => {
    const w = makeWorld();
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '任务流', status: 'running', meta: { mode: 'nodes' } });
    w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'gate', title: '发送闸门',
      input: {
        envelope: { to: 'casey.li@acme.de' },
        deliverables: [{ id: 'art_body', name: 'b.txt', view_role: 'body', sha256: BODY_SHA }],
      },
    });
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    w.store.setStepStatus(gate.id, 'waiting_human');
    w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'send', title: '发送', input: {} });
    await w.engine.approve(gate.id, '', 'boss');
    await until(() => w.sent.length === 1);
    expect(w.sent[0]!.to).toBe('casey.li@acme.de');
    expect(w.store.listEvents(200).some((e) => e.type === 'envelope_override_ignored')).toBe(false);
  });

  it('send 步 input.to 直改也改不动回信收件人（runSendStep 同一优先级）', async () => {
    const w = makeWorld();
    const wf = w.store.createWorkflow({
      kind: 'email', title: '直改单', status: 'running',
      meta: { from: 'boss@example.com', subject: '原题', mode: 'nodes' },
    });
    const gate = w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'gate', title: '发送决定',
      input: { deliverables: [{ id: 'art_body', name: 'b.txt', view_role: 'body', sha256: BODY_SHA }] },
    });
    w.store.setStepStatus(gate.id, 'completed');
    w.store.createStep({
      workflowId: wf.id, seq: 2, kind: 'send', title: '发送',
      input: { to: 'attacker@evil.example', body_ref: { id: 'art_body', sha256: BODY_SHA, name: 'b.txt' } },
    });
    await w.engine.advance(wf.id);
    await until(() => w.sent.length === 1);
    expect(w.sent[0]!.to).toBe('boss@example.com'); // from 在位 → 锁定，input.to 不作数
  });
});

describe('P1 回信流信封收口（PROBLEMS-R2）：cc/subject 与 to 同一 meta.from 判据', () => {
  it('reviewer 复现路径：回信流闸门申报 envelope.cc=attacker + 劫持主题 → 批准 → 实发无 cc + Re: 原题 + 审计留痕', async () => {
    const w = makeWorld();
    const wf = await w.engine.startEmailWorkflow(makeEmail()); // from=boss@example.com, mode=nodes
    await w.engine.advance(wf.id);
    await w.engine.onAgentStopped('juli-reply', 'done', '理解完成');
    await w.engine.appendNode(wf.id, {
      kind: 'gate', title: '发送闸门',
      // 被提示注入的 agent 借抄送外泄 + 改题（reviewer 复现脚本形态）
      input: { envelope: { to: 'boss@example.com', subject: '请立即点击…', cc: ['attacker@evil.example'] } },
    });
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    w.store.setStepInput(gate.id, {
      checks: [{ name: 'redline', status: 'pass', detail: '' }, { name: 'body', status: 'pass', detail: '' }],
      deliverables: [{ id: 'art_body', name: 'b.txt', view_role: 'body', sha256: BODY_SHA }],
    });
    await w.engine.approve(gate.id, '发', 'boss');
    await until(() => w.sent.length === 1);
    expect(w.sent[0]!.to).toBe('boss@example.com'); // 收件人锁不回退
    expect(w.sent[0]!.subject).toBe('Re: 帮忙统计上月销量'); // 申报主题不盖 Re: 原题
    expect(w.sent[0]!.cc).toBeUndefined(); // 申报 cc 不进实发
    const send = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'send')!;
    expect(send.input['cc']).toBeUndefined(); // 种子侧同序：不播 cc
    // 审计：申报 cc/subject 留痕（envelope_cc_override_ignored）。
    const ev = w.store.listEvents(200).find((e) => e.type === 'envelope_cc_override_ignored');
    expect(ev).toBeDefined();
    expect(ev!.payload['declared_cc']).toEqual(['attacker@evil.example']);
    expect(ev!.payload['declared_subject']).toBe('请立即点击…');
  });

  it('任务流（from 空、nodes）对照：申报 envelope.cc 照常生效（既有契约不回退）', async () => {
    const w = makeWorld();
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '任务流', status: 'running', meta: { mode: 'nodes' } });
    w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'gate', title: '发送闸门',
      input: {
        envelope: { to: 'casey.li@acme.de', cc: ['lead@acme.de'] },
        deliverables: [{ id: 'art_body', name: 'b.txt', view_role: 'body', sha256: BODY_SHA }],
      },
    });
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    w.store.setStepStatus(gate.id, 'waiting_human');
    w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'send', title: '发送', input: {} });
    await w.engine.approve(gate.id, '', 'boss');
    await until(() => w.sent.length === 1);
    expect(w.sent[0]!.cc).toEqual(['lead@acme.de']);
    expect(w.store.listEvents(200).some((e) => e.type === 'envelope_cc_override_ignored')).toBe(false);
  });

  it('send 步 input.cc 直改也改不动回信流抄送（runSendStep 同一优先级锁）', async () => {
    const w = makeWorld();
    const wf = w.store.createWorkflow({
      kind: 'email', title: '直改单', status: 'running',
      meta: { from: 'boss@example.com', subject: '原题', mode: 'nodes' },
    });
    const gate = w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'gate', title: '发送决定',
      input: { deliverables: [{ id: 'art_body', name: 'b.txt', view_role: 'body', sha256: BODY_SHA }] },
    });
    w.store.setStepStatus(gate.id, 'completed');
    w.store.createStep({
      workflowId: wf.id, seq: 2, kind: 'send', title: '发送',
      input: {
        to: 'boss@example.com', cc: ['attacker@evil.example'],
        body_ref: { id: 'art_body', sha256: BODY_SHA, name: 'b.txt' },
      },
    });
    await w.engine.advance(wf.id);
    await until(() => w.sent.length === 1);
    expect(w.sent[0]!.to).toBe('boss@example.com');
    expect(w.sent[0]!.cc).toBeUndefined(); // 直写通道同锁
  });
});

describe('P1 self-echo（断点十三）：已发送 message_id 回灌不建单', () => {
  it('发信完成 → 同 message_id 邮件进件 → 不建单 + self_echo_ignored 事件；直接 startEmailWorkflow 抛错', async () => {
    const w = makeWorld();
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await w.engine.advance(wf.id);
    await w.engine.onAgentStopped('juli-reply', 'done', '理解完成');
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '发送闸门' });
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    w.store.setStepInput(gate.id, {
      checks: [{ name: 'redline', status: 'pass', detail: '' }, { name: 'body', status: 'pass', detail: '' }],
      deliverables: [{ id: 'art_body', name: 'b.txt', view_role: 'body', sha256: BODY_SHA }],
    });
    await w.engine.approve(gate.id, '发', 'boss');
    await until(() => w.sent.length === 1);
    const before = w.store.listWorkflows(100).length;
    // 投递副本回灌：新 uid、同 message_id（mailer 返回 <out-1@juli.local>）。
    await w.engine.onEmailReceived(makeEmail({
      from: 'boss@example.com', messageId: '<out-1@juli.local>', uid: 99, subject: 'Re: 帮忙统计上月销量',
    }));
    expect(w.store.listWorkflows(100).length).toBe(before); // 不建单
    const ev = w.store.listEvents(200).find((e) => e.type === 'self_echo_ignored');
    expect(ev).toBeDefined();
    expect(ev!.payload['message_id']).toBe('<out-1@juli.local>');
    // 直接调用方（无 onEmailReceived 前置）同被守卫盖住：显式抛错。
    await expect(w.engine.startEmailWorkflow(makeEmail({ messageId: '<out-1@juli.local>', uid: 100 })))
      .rejects.toThrow(/self-echo/);
  });

  it('幽灵单缺口（2026-09-20 实录）：通知邮件不经过 send 步——recordSentMessageId 登记后回灌同被拒', async () => {
    const w = makeWorld();
    // 通知邮件路径：mailer 直发，message_id 只进全量出站登记（events）。
    w.store.recordSentMessageId('<notify-1@juli.local>', { to: 'ops.admin@example.com', subject: '待审批：发送闸门' });
    expect(w.store.sentMessageIdExists('<notify-1@juli.local>')).toBe(true);
    const before = w.store.listWorkflows(100).length;
    // 告警信落回轮询邮箱被 IMAP 再收：同 message_id 进件。
    await w.engine.onEmailReceived(makeEmail({
      from: 'ops.admin@example.com', messageId: '<notify-1@juli.local>', uid: 98,
      subject: '[juli] 待审批：发送闸门',
    }));
    expect(w.store.listWorkflows(100).length).toBe(before); // 不建幽灵单
    expect(w.store.listEvents(50).some((e) => e.type === 'self_echo_ignored')).toBe(true);
    // 无关 message_id 不受影响（正常来信照常建单）。
    await w.engine.onEmailReceived(makeEmail({ messageId: '<fresh-1@example.com>', uid: 97, subject: '新来信' }));
    expect(w.store.listWorkflows(100).length).toBe(before + 1);
  });
});

describe('P2 发送语义判据与标题解耦（isSendGateDecision 四处统一）', () => {
  it('非「发送」标题但申报 envelope.to 的闸门 → auto-pair 照样挂 send 后继', async () => {
    const w = makeWorld();
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '任务流', status: 'running', meta: { mode: 'nodes' } });
    await w.engine.appendNode(wf.id, {
      kind: 'gate', title: '答复确认', // 不含「发送」
      input: { envelope: { to: 'casey.li@acme.de' } },
    });
    const steps = w.store.stepsForWorkflow(wf.id);
    expect(steps.filter((s) => s.kind === 'send')).toHaveLength(1); // 配对成功
  });

  it('非「发送」标题 + envelope.to 的已批闸门 → settle 拒埋葬（reviewer 复现形态的守卫面）', async () => {
    const w = makeWorld();
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '事故形态', status: 'running', meta: { mode: 'nodes' } });
    const gate = w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'gate', title: '答复确认', // 不含「发送」——修复前拒埋葬查不到它
      input: { envelope: { to: 'casey.li@acme.de' } },
    });
    w.store.setStepStatus(gate.id, 'completed');
    await expect(w.engine.settle(wf.id, 'operator')).rejects.toThrow(/从未发送/);
    expect(w.store.getWorkflow(wf.id)!.status).toBe('running'); // 不许无痕入土
  });

  it('链尾悬空检测：非「发送」标题 + envelope.to 的已批闸门收尾 → chain_dangling', async () => {
    const w = makeWorld();
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '悬空', status: 'running', meta: { mode: 'nodes' } });
    const gate = w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'gate', title: '答复确认',
      input: { envelope: { to: 'c@x.de' } },
    });
    w.store.setStepStatus(gate.id, 'completed');
    await w.engine.advance(wf.id);
    expect(w.store.listEvents(100).some((e) => e.type === 'chain_dangling')).toBe(true);
    // 对照：无 envelope 且标题不含「发送」的对齐类闸门收尾 → 不报警。
    const wf2 = w.store.createWorkflow({ kind: 'adhoc', title: '正常', status: 'running', meta: { mode: 'nodes' } });
    const g2 = w.store.createStep({ workflowId: wf2.id, seq: 1, kind: 'gate', title: '对齐闸门', input: {} });
    w.store.setStepStatus(g2.id, 'completed');
    await w.engine.advance(wf2.id);
    const evs2 = w.store.listEvents(100).filter((e) => e.type === 'chain_dangling' && e.entityId === wf2.id);
    expect(evs2).toHaveLength(0);
  });
});

describe('P2 startTask 播种后推进 fire-and-forget', () => {
  it('派发挂起（模拟冷会话 provisioning 240s）时 startTask 照常返回——只等插库不等派发', async () => {
    let release: () => void = () => undefined;
    const gatePromise = new Promise<void>((r) => { release = r; });
    const w = makeWorld({
      dispatch: {
        async dispatch(_s, session, text) {
          w.dispatched.push({ session, text }); // 记录后挂起——修复前 startTask 会等到这里
          await gatePromise;
          return ok(undefined);
        },
      },
    });
    const t = await w.engine.startTask('慢派发任务', { brief: '任务内容' }); // 修复前这里会挂到派发完成
    const steps = w.store.stepsForWorkflow(t.id);
    expect(steps).toHaveLength(1); // 节点已插库
    expect(w.store.getWorkflow(t.id)!.status).toBe('running');
    release();
    await w.engine.advance(t.id); // 排空锁链
    expect(w.dispatched.length).toBe(1); // 派发随后发生
  });

  it('brief 超长被截断对齐邮件进件（8000 上限）', async () => {
    const w = makeWorld();
    const long = '长'.repeat(9000);
    const t = await w.engine.startTask('超长任务', { brief: long });
    const plan = String(w.store.stepsForWorkflow(t.id)[0]!.input['plan']);
    expect(plan.length).toBeLessThanOrEqual(8000 + '…'.length);
    expect(plan.startsWith('长')).toBe(true);
  });
});

describe('P3 近匹配绑定会话守卫（大小写变体不落回默认会话）', () => {
  const BOUND = 'project-a';
  const SENDER = 'alice.chen@example.com';
  const makeBoundWorld = (over: Partial<EngineDeps> = {}) => {
    const { clock } = makeClock();
    const store = createLedgerStore(':memory:', { clock, ids: seqIds() });
    const dispatched: { session: string; text: string }[] = [];
    const engine = createEngine({
      store, llm: null, model: 't',
      routing: {
        defaultSession: 'juli-reply', defaultProject: 'p',
        boundAgents: [{ session: BOUND, cwd: '/srv/project-b', senders: [SENDER] }],
      },
      dispatch: { async dispatch(_s, session, text) { dispatched.push({ session, text }); return ok(undefined); } },
      syncDispatch: null,
      pusher: { async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {} } satisfies PusherPort,
      mailer: { async send() { return ok({ messageId: '<x@j>' }); } } satisfies MailerPort,
      captureOutput: async () => null, workspaceFor: null,
      availableSessions: ['juli-reply'], resolveSession: null, interruptSession: null,
      rebuildAgent: null, zombieFingerprint: null, clock, ids: seqIds(), templates: {},
      authz: { mode: 'allowlist', allow: ['*@example.com', SENDER], deny: [] },
      ...over,
    } satisfies EngineDeps);
    return { engine, store, dispatched };
  };

  it('session_bound 标记单钉 Project-A（大小写差）→ 显式 failed，绝不流进 juli-reply', async () => {
    const w = makeBoundWorld({
      // 模拟生产路由器：点名不存在 → 落回 juli-reply（正是事故形态的下游）。
      resolveSession: (s) => (s === 'juli-reply' ? s : 'juli-reply'),
    });
    const wf = w.store.createWorkflow({
      kind: 'adhoc', title: '变体钉名', status: 'running',
      meta: { mode: 'nodes', session_bound: BOUND },
    });
    w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'agent', title: '入账',
      input: { plan: '录一笔', session: 'Project-A' },
    });
    await w.engine.advance(wf.id);
    const st = w.store.stepsForWorkflow(wf.id)[0]!;
    expect(st.status).toBe('failed');
    expect(st.output['guard']).toBe('session_bound_near');
    expect(w.dispatched).toHaveLength(0); // 任务文本绝不出手
  });

  it('非变体的普通不存在会话不受影响（照常走 resolveSession）', async () => {
    const w = makeBoundWorld({
      resolveSession: (_s) => 'juli-reply',
    });
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '普通', status: 'running', meta: { mode: 'nodes' } });
    w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'agent', title: '跑',
      input: { plan: '做点事', session: 'some-random-session' },
    });
    await w.engine.advance(wf.id);
    expect(w.dispatched[0]!.session).toBe('juli-reply');
  });
});

describe('P3 ladder 回信流不认申报主题/抄送（envelope 模式门）', () => {
  it('gate input 携带 envelope.subject → 发出主题仍是 Re: 原题（nodes 才认申报）', async () => {
    const w = makeWorld();
    const wf = w.store.createWorkflow({
      kind: 'email', title: 'ladder 单', status: 'running',
      meta: { from: 'boss@example.com', subject: '原题' }, // 无 mode = ladder
    });
    const gate = w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'gate', title: '发送决定',
      input: {
        draft: BODY,
        envelope: { subject: '劫持主题', cc: ['x@evil.example'] },
      },
    });
    w.store.setStepStatus(gate.id, 'waiting_human');
    w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'send', title: '发送', input: {} });
    await w.engine.approve(gate.id, '', 'boss');
    await until(() => w.sent.length === 1);
    expect(w.sent[0]!.subject).toBe('Re: 原题'); // 线程语义不漂移
    expect(w.sent[0]!.cc).toBeUndefined(); // 抄送同门
  });
});

// ---- HTTP 旁道（P1）：真实 runtime + hono app，不经网络 ---------------------------

// 每个临时 socket 一个 tmux server（真实 tmux 调用孵化后无人清）——文件级
// 收尾统一击杀，防宿主进程泄漏。注意派发是 fire-and-forget：simulate 测试
// 触发的 provision（default_session=agent-a）可能在测试体结束后才落地
// new-session——先给沉降窗口再 kill-server，pkill 兜底迟到孵化者。
const spawnedTmuxSocks: string[] = [];
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 500));
  for (const s of spawnedTmuxSocks) {
    try { execFileSync('tmux', ['-S', s, 'kill-server'], { stdio: 'ignore' }); } catch { /* 已不在 */ }
  }
  try { execFileSync('pkill', ['-f', 'juli-week-fix-.*tmux\\.sock']); } catch { /* 无迟到者 */ }
}, 20_000);

const mkApp = (emailCfg: Record<string, unknown>, seams: RuntimeSeams = {}, extraCfg: Record<string, unknown> = {}) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'juli-week-fix-'));
  // 隔离 socket（2026-10-09 幽灵会话事故锚，http.e2e.test.ts 同模式）：
  // 此前裸跑落宿主 default socket——POST /api/sessions 的真实 tmux 调用
  // 在用户面真建 normal-session 并孵化 server。指向 tmpdir 专属 socket，
  // 会话与 server 都圈在沙箱里，afterAll 统一 kill-server。
  const tmuxSock = join(dataDir, 'tmux.sock');
  spawnedTmuxSocks.push(tmuxSock);
  const rt = createRuntime(configSchema.parse({
    data_dir: dataDir,
    tmux_socket_path: tmuxSock,
    email: { default_session: 'agent-a', default_project: 'demo', ...emailCfg },
    ...extraCfg,
  }), seams);
  const app = createHttpApp(rt);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试 JSON 探针：data=JSON.parse 动态形态，下游数十处临时断言消费，精确建型需给全部 expect 补窄化（零安全增益 churn）。
  const j = async (method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { rt, j };
};

describe('P1 HTTP 旁道：绑定会话裸 send + simulate 收紧', () => {
  const BOUND = 'project-a';

  it('POST /api/sessions/:name/send 命中绑定会话 → 403 拒（先于 tmux 可用性判断）', async () => {
    const { j } = mkApp({ bound_agents: [{ session: BOUND, cwd: '/srv/x', senders: ['a@example.com'] }] });
    const r = await j('POST', `/api/sessions/${BOUND}/send`, { text: '跑私活指令' });
    expect(r.status).toBe(403);
    expect(String(r.data.error)).toContain('绑定会话');
    // 非绑定会话不受影响：无 tmux → 503；有 tmux → 会话不存在的 400（都非 403）。
    const r2 = await j('POST', '/api/sessions/other-session/send', { text: 'x' });
    expect([400, 503]).toContain(r2.status);
  });

  it('POST /api/sessions 预建绑定名会话 → 403 拒（PROBLEMS-R2 P2 预建旁路，先于 tmux 判断）', async () => {
    const { j } = mkApp({ bound_agents: [{ session: BOUND, cwd: '/srv/x', senders: ['a@example.com'] }] });
    const r = await j('POST', '/api/sessions', { name: BOUND, cwd: '/tmp' });
    expect(r.status).toBe(403);
    expect(String(r.data.error)).toContain('绑定会话');
    // 非绑定名不受守卫影响：不走 403（tmux 面真实调用——落在隔离临时
    // socket，宿主零污染）。
    const r2 = await j('POST', '/api/sessions', { name: 'normal-session', cwd: '/tmp' });
    expect(r2.status).not.toBe(403);
  });

  it('POST /api/email/simulate 默认关（403）；显式 simulate_enabled 才开', async () => {
    const closed = mkApp({}, {}, { email_authz_allow: ['*@example.com'] });
    const r1 = await closed.j('POST', '/api/email/simulate', { from: 'boss@example.com', subject: 'x', body: 'y' });
    expect(r1.status).toBe(403);
    expect(String(r1.data.error)).toContain('simulate_enabled');

    const open = mkApp({ simulate_enabled: true }, {}, { email_authz_allow: ['*@example.com'] });
    const r2 = await open.j('POST', '/api/email/simulate', { from: 'boss@example.com', subject: 'x', body: 'y' });
    expect(r2.status).toBe(200);
    expect(open.rt.store.listWorkflows().length).toBeGreaterThan(0);
  });

  it('simulate 开启时伪造绑定白名单发件人 → 走 bound 路由（暴露面收敛为显式配置）', async () => {
    const { rt, j } = mkApp(
      { simulate_enabled: true, bound_agents: [{ session: BOUND, cwd: '/srv/x', senders: ['alice.chen@example.com'] }] },
      { dispatch: { async dispatch() { return ok(undefined); } } },
      { email_authz_allow: ['*@example.com', 'alice.chen@example.com'] },
    );
    const r = await j('POST', '/api/email/simulate', { from: 'alice.chen@example.com', subject: 'x', body: 'y' });
    expect(r.status).toBe(200);
    const wf = rt.store.listWorkflows()[0]!;
    expect(wf.meta['session_bound']).toBe(BOUND); // 引擎正门路由照常——旁道关在「默认不开」
  });
});
