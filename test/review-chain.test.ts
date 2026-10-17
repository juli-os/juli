// 交付物契约全链测试（2026-09-12）：结构化输出（去屏幕化）→ sweep 收编 →
// 闸门携带 deliverables + 前置对账 → 批准绑定哈希 → 发送按哈希取件 →
// 对齐修正（align）→ 红线/哈希守卫。

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLedgerStore } from '@juli-os/ledger';
import { createEngine } from '../src/business/workflow/engine.ts';
import { parseTemplate } from '../src/business/templates/template.ts';
import { createArtifactLedger, sweepCaseInbox } from '@juli-os/artifacts';
import { createDiskBackend } from '@juli-os/artifacts';
import { extractFinalMessage, parseHookStdin } from '@juli-os/agents';
import { fixedClock, seqIds } from './helpers.ts';
import { ok } from '@juli-os/artifacts';
import type { MailerPort, PusherPort } from '../src/contracts/ports.ts';

/** agent → 发送闸门 → send 的最小答复阶梯（trigger=email 让邮件进件直接命中）。 */
const REPLY_YAML = `key: reply-artifact
name: 工件答复流
trigger: email
steps:
  - id: draft_step
    kind: agent
    session: agent-a
    title: 答复起草
    prompt: 按 juli-reply 规范起草答复并交付三件套。
  - id: send_gate
    kind: gate
    title: 发送决定
  - id: send
    kind: send
    title: SMTP 发送
`;

const ALIGN_YAML = `key: align-flow
name: 对齐流
trigger: manual
steps:
  - id: understand
    kind: agent
    session: agent-a
    title: 理解 turn
    prompt: 读原文出结构化理解。
  - id: align_gate
    kind: gate
    title: 对齐闸门
  - id: exec
    kind: agent
    session: agent-a
    title: 执行交付
`;

interface World {
  readonly engine: ReturnType<typeof createEngine>;
  readonly store: ReturnType<typeof createLedgerStore>;
  readonly ledger: ReturnType<typeof createArtifactLedger>;
  readonly sent: { to: string; subject: string; body: string; inReplyTo: string }[];
  readonly dispatched: { readonly source: string; readonly session: string; readonly text: string }[];
  readonly inbox: string;
  readonly storeDir: string;
  readonly dir: string;
}

const makeWorld = (over: { yaml?: string; redlineWords?: readonly string[] } = {}): World => {
  const dir = mkdtempSync(join(tmpdir(), 'juli-chain-'));
  const store = createLedgerStore(':memory:', { clock: fixedClock, ids: seqIds() });
  const ledger = createArtifactLedger(new DatabaseSync(':memory:'), createDiskBackend(join(dir, 'store')));
  const sent: { to: string; subject: string; body: string; inReplyTo: string }[] = [];
  const dispatched: { source: string; session: string; text: string }[] = [];
  const inbox = join(dir, 'case-inbox');
  const engine = createEngine({
    store,
    llm: {
      async complete() { return ok({ text: '{}', inputTokens: 1, outputTokens: 1 }); },
    },
    model: 'test',
    routing: { defaultSession: '', defaultProject: 'p' },
    dispatch: {
      async dispatch(source, session, text) {
        dispatched.push({ source, session, text });
        return ok(undefined);
      },
    },
    syncDispatch: null,
    pusher: { async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {} } satisfies PusherPort,
    mailer: {
      async send(cmd) {
        sent.push(cmd);
        return ok({ messageId: `<out-${sent.length}@juli.local>` });
      },
    } satisfies MailerPort,
    captureOutput: async (s) => `PANE-NOISE spinner… ⏵⏵ auto mode on (${s})`,
    workspaceFor: null,
    availableSessions: ['agent-a'],
    resolveSession: null,
    interruptSession: null,
    rebuildAgent: null,
    zombieFingerprint: null,
    clock: fixedClock,
    ids: seqIds(),
    templates: { flow: parseTemplate(over.yaml ?? REPLY_YAML) },
    authz: { mode: 'allowlist', allow: ['*@example.com'], deny: [] },
    redlineWords: over.redlineWords ?? ['run号', '扣例'],
    artifacts: {
      putAndRegister: (r) => ledger.putAndRegister({ ...r, role: r.role as never }),
      list: (wf) => ledger.list(wf).map((a) => ({ id: a.id, name: a.name, key: a.key, stepId: a.stepId, deletedAt: a.deletedAt, meta: a.meta })),
      updateMeta: (id, patch) => ledger.updateMeta(id, patch),
      getContent: async (id) => {
        const row = ledger.get(id);
        if (!row || row.key === '') return null;
        const bytes = await createDiskBackend(join(dir, 'store')).get(row.key);
        return bytes.ok ? { bytes: bytes.value, sha256: row.sha256, name: row.name, viewRole: String(row.meta['view_role'] ?? 'report') } : null;
      },
      sweepCaseInbox: (wf, stepId) => sweepCaseInbox({ inboxDir: join(inbox, wf), workflowId: wf, stepId, ledger }),
    },
    caseInboxDir: (wf) => join(inbox, wf),
  });
  return { engine, store, ledger, sent, dispatched, inbox, storeDir: join(dir, 'store'), dir };
};

const deliverInbox = (inbox: string, files: Record<string, string>): void => {
  mkdirSync(inbox, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(inbox, name), content);
};

describe('结构化输出（PORTING#3）', () => {
  it('extractFinalMessage：取最后一条 assistant 文本；tool_use/thinking 不算', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-tr-'));
    try {
      const p = join(dir, 't.jsonl');
      writeFileSync(p, [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '第一段' }] } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '最终答复文本' }] } }),
      ].join('\n') + '\n');
      expect(extractFinalMessage(p)).toBe('最终答复文本');
      expect(extractFinalMessage(join(dir, 'nope.jsonl'))).toBeNull();
      expect(parseHookStdin('')).toBeNull();
      expect(parseHookStdin('not json')).toBeNull();
      expect(parseHookStdin(JSON.stringify({ transcript_path: p }))).toMatchObject({ transcript_path: p });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('onAgentStopped：hook 的 final_message 胜出，pane 抓取只是兜底', async () => {
    const w = makeWorld();
    const wf = await w.engine.startFlow('flow', '', { from: 'boss@example.com', subject: 's', body: '请把上月的销量数据整理成表格发我。', in_reply_to: '<orig-1@example.com>' });
    await w.engine.advance(wf.id); // 派发落定（agent step running）
    // Stop hook 携带干净最终答复。
    await w.engine.onAgentStopped('agent-a', 'done', '干净汇报：v7 三件套已交付。');
    await w.engine.advance(wf.id);
    const st = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'agent')!;
    expect(st.output['output']).toBe('干净汇报：v7 三件套已交付。');
    expect(String(st.output['output'])).not.toContain('PANE-NOISE');
  });
});

describe('交付物契约链（sweep → 闸门 → 批准哈希 → 发送取件）', () => {
  it('全链：申报单收编 → 闸门携带 deliverables+checks → 批准绑定哈希 → 发的就是文件字节', async () => {
    const w = makeWorld();
    const wf = await w.engine.startFlow('flow', '', { from: 'boss@example.com', subject: 's', body: '请把上月的销量数据整理成表格发我。', in_reply_to: '<orig-1@example.com>' });
    deliverInbox(join(w.inbox, wf.id), {
      'draft-followup.txt': '您好，全家福已单独推进，两处已上线。如有出入请回复纠正。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。',
      'review.html': '<html><body>对照表</body></html>',
      'reply.json': JSON.stringify({
        envelope: { in_reply_to_hint: '<orig-1@example.com>', feedback_refs: ['fb-1', 'fb-2'] },
        deliverables: [
          { file: 'draft-followup.txt', role: 'body', summary: 'v7 正文' },
          { file: 'review.html', role: 'report', summary: '对照表' },
        ],
      }),
    });
    await w.engine.advance(wf.id);
    await w.engine.onAgentStopped('agent-a', 'done', '简要汇报');
    await w.engine.advance(wf.id);
    // agent 步 output：干净文本 + 交付物指针（哈希 64hex）。
    const agent = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'agent')!;
    const dl = agent.output['deliverables'] as { view_role: string; sha256: string }[];
    expect(dl).toHaveLength(2);
    const body = dl.find((d) => d.view_role === 'body')!;
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    // 发送闸门：携带 deliverables + 前置对账（redline/body/disclosure/contract 全过，无 fail）。
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    expect(gate.status).toBe('waiting_human');
    expect(Array.isArray(gate.input['deliverables'])).toBe(true);
    // 09-20 P3（维度6 存留缺口）：envelope 从 reply.json 经【真实 sweep】解析
    // 进 gate input 的链路此前无断言（envelope 全靠各测试手工注入）——此处锚定
    // sweep→envelope→闸门携带 的组合：提示/引用在位，且结构性无 to 字段
    // （SweepEnvelope 判型只收窄 in_reply_to_hint/feedback_refs——申报地址
    // 类字段引擎不认，收件人只走 meta.from/闸门 envelope.to 申报）。
    expect(gate.input['envelope']).toMatchObject({
      in_reply_to_hint: '<orig-1@example.com>', feedback_refs: ['fb-1', 'fb-2'],
    });
    expect(gate.input['envelope']).not.toHaveProperty('to');
    const checks = gate.input['checks'] as { name: string; status: string }[];
    expect(checks.find((c) => c.name === 'redline')!.status).toBe('pass');
    expect(checks.find((c) => c.name === 'contract')!.status).toBe('pass');
    expect(checks.find((c) => c.name === 'disclosure')!.status).toBe('pass');
    expect(checks.every((c) => c.status !== 'fail')).toBe(true);
    // 批准 → 绑定哈希 → 发送按哈希取件：发出的 body 逐字等于文件字节。
    await w.engine.approve(gate.id, '', 'test');
    expect(w.store.getStep(gate.id)!.output['body_sha256']).toBe(body.sha256);
    await w.engine.advance(wf.id);
    expect(w.sent).toHaveLength(1);
    // 落款由引擎拼装（2026-09-14 二轮）：残留披露行被剥，正文后接引擎版固定块。
    expect(w.sent[0]!.body).toBe('您好，全家福已单独推进，两处已上线。如有出入请回复纠正。\n\n此致\n敬礼\n\njuli Labs\nAI 助理\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。');
    expect(w.sent[0]!.body).toContain('本邮件由 AI 助理答复'); // 发出的信必有 AI 披露行（P1 机械强制）
    expect(w.sent[0]!.to).toBe('boss@example.com'); // 结构守卫：只认 meta.from
    expect(w.sent[0]!.inReplyTo).toBe('<orig-1@example.com>');
    const send = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'send')!;
    expect(send.output['body_via']).toMatch(/^artifact:/);
    expect(w.store.getWorkflow(wf.id)!.status).toBe('completed');
  });

  it('哈希守卫：批准后工件字节被改 → 发送拒发（审 A 发 B 不可能）', async () => {
    const w = makeWorld();
    const wf = await w.engine.startFlow('flow', '', { from: 'boss@example.com', subject: '二单', body: '请把上月的销量数据整理成表格发我。', in_reply_to: '<orig-2@example.com>' });
    deliverInbox(join(w.inbox, wf.id), {
      'draft-followup.txt': '原始批准版本\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。',
      'reply.json': JSON.stringify({ deliverables: [{ file: 'draft-followup.txt', role: 'body' }] }),
    });
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    await w.engine.onAgentStopped('agent-a', 'done', '汇报');
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    // 批准前篡改磁盘字节（key 直写——模拟"登记后被改，闸门 checks 未再跑"）。
    const bodyRow = w.ledger.list(wf.id).find((r) => r.name === 'draft-followup.txt')!;
    const disk = createDiskBackend(w.storeDir);
    await disk.put(bodyRow.key, Buffer.from('篡改后的正文'));
    await w.engine.approve(gate.id, '', 'test');
    await w.engine.advance(wf.id);
    expect(w.sent).toHaveLength(0);
    const send = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'send')!;
    expect(send.status).toBe('failed');
    expect(String(send.output['error'])).toContain('hash mismatch');
  });

  it('红线守卫：正文含内部词汇 → 闸门 checks fail 拦批准，send 侧复跑拒发', async () => {
    const w = makeWorld();
    const wf = await w.engine.startFlow('flow', '', { from: 'boss@example.com', subject: '三单', body: '请把上月的销量数据整理成表格发我。', in_reply_to: '<orig-3@example.com>' });
    deliverInbox(join(w.inbox, wf.id), {
      'draft-followup.txt': '该单已扣例并记录 run号，稍后回复。',
      'reply.json': JSON.stringify({ deliverables: [{ file: 'draft-followup.txt', role: 'body' }] }),
    });
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    await w.engine.onAgentStopped('agent-a', 'done', '汇报');
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    const checks = gate.input['checks'] as { name: string; status: string }[];
    expect(checks.find((c) => c.name === 'redline')!.status).toBe('fail');
    await expect(w.engine.approve(gate.id, '', 'test')).rejects.toThrow(/前置检查 fail/);
    // 正路：驳回回修。
    await w.engine.rework(gate.id, '去掉内部词汇', 'test');
    expect(w.store.getStep(gate.id)!.status).toBe('pending');
  });

  it('披露行结构性在位：草稿漏写落款 → 引擎拼装补齐照发（2026-09-14 二轮）', async () => {
    const w = makeWorld();
    const wf = await w.engine.startFlow('flow', '', { from: 'boss@example.com', subject: '六单', body: '请把上月的销量数据整理成表格发我。', in_reply_to: '<orig-6@example.com>' });
    deliverInbox(join(w.inbox, wf.id), {
      'draft-followup.txt': 'LLM 漏写落款的正文——没有 AI 披露行。',
      'reply.json': JSON.stringify({ deliverables: [{ file: 'draft-followup.txt', role: 'body' }] }),
    });
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    await w.engine.onAgentStopped('agent-a', 'done', '汇报');
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    await w.engine.advance(wf.id);
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    const checks = gate.input['checks'] as { name: string; status: string }[];
    expect(checks.find((c) => c.name === 'disclosure')!.status).toBe('pass'); // 结构性保证
    await w.engine.approve(gate.id, '', 'test');
    await w.engine.advance(wf.id);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.body).toContain('本邮件由 AI 助理答复'); // 引擎落款随信出门
  });

  it('回修重开：新正文含红线 → checks 强制重算为 fail → approve 被拦', async () => {
    const w = makeWorld();
    const wf = await w.engine.startFlow('flow', '', { from: 'boss@example.com', subject: '五单', body: '请把上月的销量数据整理成表格发我。', in_reply_to: '<orig-5@example.com>' });
    deliverInbox(join(w.inbox, wf.id), {
      'draft-followup.txt': '干净的第一版正文，无内部词汇。',
      'reply.json': JSON.stringify({ deliverables: [{ file: 'draft-followup.txt', role: 'body' }] }),
    });
    await w.engine.advance(wf.id);
    await w.engine.onAgentStopped('agent-a', 'done', '第一版');
    await w.engine.advance(wf.id);
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    const checks1 = gate.input['checks'] as { name: string; status: string }[];
    expect(checks1.find((c) => c.name === 'redline')!.status).toBe('pass'); // 第一版绿灯

    // 回修：agent 交付了含红线词的第二版。
    await w.engine.rework(gate.id, '补上扣例状态', 'test');
    deliverInbox(join(w.inbox, wf.id), {
      'draft-followup.txt': '该单已扣例并记录 run号，稍后回复。',
      'reply.json': JSON.stringify({ deliverables: [{ file: 'draft-followup.txt', role: 'body' }] }),
    });
    await w.engine.advance(wf.id); // 重做步重派
    await w.engine.onAgentStopped('agent-a', 'done', '第二版');
    await w.engine.advance(wf.id); // 结算 + 闸门重开（checks 重算）
    const gate2 = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    expect(gate2.status).toBe('waiting_human');
    const checks2 = gate2.input['checks'] as { name: string; status: string }[];
    expect(checks2.find((c) => c.name === 'redline')!.status).toBe('fail'); // 陈旧绿灯被覆盖
    await expect(w.engine.approve(gate2.id, '', 'test')).rejects.toThrow(/前置检查 fail/);
  });

  it('无契约回退：无申报单 → contract 警示 + 内联 draft 发送仍可用', async () => {
    const w = makeWorld();
    const wf = await w.engine.startFlow('flow', '', { from: 'boss@example.com', subject: '四单', body: '请把上月的销量数据整理成表格发我。', in_reply_to: '<orig-4@example.com>' });
    deliverInbox(join(w.inbox, wf.id), { 'draft-followup.txt': '旧式交付，无申报单' });
    await w.engine.advance(wf.id);
    await w.engine.onAgentStopped('agent-a', 'done', '内联草稿正文（干净文本）\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。');
    await w.engine.advance(wf.id);
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    const checks = gate.input['checks'] as { name: string; status: string; detail: string }[];
    expect(checks.find((c) => c.name === 'contract')!.status).toBe('warn');
    expect(checks.find((c) => c.name === 'contract')!.detail).toContain('无申报单');
    await w.engine.approve(gate.id, '', 'test');
    await w.engine.advance(wf.id);
    expect(w.sent).toHaveLength(1);
    // 落款由引擎拼装（2026-09-14 二轮）：旧式残留披露行被剥，换成引擎版固定块。
    expect(w.sent[0]!.body).toBe('内联草稿正文（干净文本）\n\n此致\n敬礼\n\njuli Labs\nAI 助理\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。');
    const send = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'send')!;
    expect(send.output['body_source'] ?? send.input['body_source']).toBe('inline');
  });
});

describe('对齐修正（align）', () => {
  it('人修成为工件 + 下游 agent 任务卡以人定稿版本为最高优先级', async () => {
    const w = makeWorld({ yaml: ALIGN_YAML });
    const wf = await w.engine.startFlow('flow', '对齐测试', {});
    await w.engine.advance(wf.id); // 理解步派发
    await w.engine.onAgentStopped('agent-a', 'done', '理解：三条诉求，全家福留在本轮');
    await w.engine.advance(wf.id);
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    expect(gate.status).toBe('waiting_human');
    await w.engine.align(gate.id, '全家福移出本轮，单独开 task', 'web');
    // align 的推进是 fire-and-forget（长链不进 HTTP 等待）——排空锁链再断言下游。
    await w.engine.advance(wf.id);
    // 闸门：aligned 落账 + 修正工件登记（actor=human）。
    expect(w.store.getStep(gate.id)!.output['aligned']).toBe(true);
    const amend = w.ledger.list(wf.id).find((r) => r.role === 'amendment')!;
    expect(amend.meta['actor']).toBe('web');
    // 下游：执行步 input.plan 携带人修正（最高优先级）。
    const exec = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'agent' && s.seq === 3)!;
    expect(String(exec.input['plan'])).toContain('[对齐修正（人定稿，最高优先执行）]');
    expect(String(exec.input['plan'])).toContain('全家福移出本轮');
    expect(w.dispatched.some((d) => d.text.includes('全家福移出本轮'))).toBe(true); // 已派发到会话
  });
});
