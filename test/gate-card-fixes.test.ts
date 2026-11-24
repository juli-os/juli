// 闸门卡修复全链测试（wf_f9abb08092cc 死循环修复，2026-11-03）：诊断单
// wf_7c0ed9d2a34d 五条建议的引擎半边——①gateSummary 兜底链读 note ②rework
// 沿链找可回修步/无可回修步显式拒驳 ③有机回合补扫 case-inbox merge 进等待
// 闸门 ⑤appendNode 空摘要闸门留痕告警。nodes 模式世界（startEmailWorkflow）
// + artifacts 接线（取 review-chain makeWorld 之长）。

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLedgerStore, type Step } from '@juli-os/ledger';
import { createEngine, type EngineDeps } from '../src/business/workflow/engine.ts';
import { ok } from '../src/platform/shared/result.ts';
import { createArtifactLedger, createDiskBackend, sweepCaseInbox } from '@juli-os/artifacts';
import { gateSummary } from '../src/business/workflow/support.ts';
import { fixedClock, makeEmail, seqIds, until } from './helpers.ts';
import type { MailerPort, PusherPort } from '../src/contracts/ports.ts';

interface World {
  readonly engine: ReturnType<typeof createEngine>;
  readonly store: ReturnType<typeof createLedgerStore>;
  readonly ledger: ReturnType<typeof createArtifactLedger>;
  readonly dispatched: { readonly source: string; readonly session: string; readonly text: string }[];
  readonly inbox: string;
  readonly dir: string;
}

const makeWorld = (over: Partial<EngineDeps> = {}): World => {
  const dir = mkdtempSync(join(tmpdir(), 'juli-gatecard-'));
  const store = createLedgerStore(':memory:', { clock: fixedClock, ids: seqIds() });
  const ledger = createArtifactLedger(new DatabaseSync(':memory:'), createDiskBackend(join(dir, 'store')));
  const dispatched: { source: string; session: string; text: string }[] = [];
  const inbox = join(dir, 'case-inbox');
  const engine = createEngine({
    store,
    llm: null,
    model: 't',
    routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
    dispatch: {
      async dispatch(_source, session, text) {
        dispatched.push({ source: _source, session, text });
        return ok(undefined);
      },
    },
    pusher: { async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {} } satisfies PusherPort,
    mailer: { async send() { return ok({ messageId: '<x@j>' }); } } satisfies MailerPort,
    captureOutput: async () => null,
    workspaceFor: null,
    availableSessions: ['juli-reply'],
    resolveSession: null,
    interruptSession: null,
    rebuildAgent: null,
    zombieFingerprint: null,
    clock: fixedClock,
    ids: seqIds(),
    templates: {}, // ★ 空注册表：动态进件（nodes 模式）
    authz: { mode: 'allowlist', allow: ['*@example.com'], deny: [] },
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
    ...over,
  } satisfies EngineDeps);
  return { engine, store, ledger, dispatched, inbox, dir };
};

const deliverInbox = (inbox: string, files: Record<string, string>): void => {
  mkdirSync(inbox, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(inbox, name), content);
};

/** 第一回合收工：先等首步的任务卡确认送达（step_dispatched 落账），再收工。
 * 2026-11-23 起收工回调只结算「卡已确认送达」的步（agentSettle 核对步骤上的
 * 凭据）。startEmailWorkflow 入队即返，紧接着就收工的话，卡还没确认送达，
 * 回调会被拦下——以前能过是因为结算会排队等派发那把锁。 */
const settleFirstTurn = async (w: World, wfId: string, output: string): Promise<void> => {
  const first = w.store.stepsForWorkflow(wfId)[0]!;
  await until(() => w.store.entityEvents('step', first.id, 'step_dispatched').length > 0);
  await w.engine.onAgentStopped('juli-reply', 'done', output);
};

describe('修复①：gateSummary 兜底链 draft‖plan‖note‖title', () => {
  const st = (input: Record<string, unknown>, title = '确认闸门'): Step =>
    ({ id: 'st_x', seq: 2, kind: 'gate', status: 'waiting_human', title, input, output: {} } as unknown as Step);

  it('note 兜底生效：无 draft/plan 时读 note，不再裸标题', () => {
    expect(gateSummary(st({ note: '方案摘要 200 字' }))).toBe('方案摘要 200 字');
  });
  it('优先序不变：draft > plan > note > title', () => {
    expect(gateSummary(st({ draft: 'D', plan: 'P', note: 'N' }))).toBe('D');
    expect(gateSummary(st({ plan: 'P', note: 'N' }))).toBe('P');
    expect(gateSummary(st({}))).toBe('确认闸门');
  });
});

describe('修复②：rework 沿链找可回修步', () => {
  it('agent→gate→gate 链：确认闸驳回 → 意见落到 agent 步并重派（不再同卡空转）', async () => {
    const w = makeWorld();
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await settleFirstTurn(w, wf.id, '理解完成');
    const agent = w.store.stepsForWorkflow(wf.id)[0]!;
    expect(agent.status).toBe('completed');
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '对齐闸门' });
    const gate1 = w.store.stepsForWorkflow(wf.id).find((s) => s.title === '对齐闸门')!;
    await w.engine.approve(gate1.id, '', 'boss');
    await w.engine.appendNode(wf.id, {
      kind: 'gate', title: '确认闸门',
      input: { delivery: 'apply', draft: '方案段收工，diff 见工件' },
    });
    const gate2 = w.store.stepsForWorkflow(wf.id).find((s) => s.title === '确认闸门')!;
    expect(gate2.status).toBe('waiting_human');
    const dispatchedBefore = w.dispatched.length;

    await w.engine.rework(gate2.id, '交付物没挂上，重交', 'iphone');

    const agentAfter = w.store.getStep(agent.id)!;
    // 重置后由链尾 continueWorkflow 即刻重派（同步 fake dispatch）——pending
    // 或已回 running 都算重置成功；意见与来源闸门必在 input。
    expect(['pending', 'running']).toContain(agentAfter.status);
    expect(agentAfter.input['feedback']).toBe('交付物没挂上，重交');
    expect(agentAfter.input['rework_from_gate']).toBe(gate2.seq);
    expect(w.store.getStep(gate2.id)!.status).toBe('pending');
    expect(Number(w.store.getWorkflow(wf.id)!.meta['round'])).toBe(2);
    expect(w.dispatched.length).toBeGreaterThan(dispatchedBefore); // 真的重派了
    const ev = w.store.listEvents(50).find((e) => e.type === 'gate_rework');
    expect(ev).toBeDefined();
    expect(ev!.payload['target_seq']).toBe(agent.seq);
  });

  it('非相邻链（agent→gate→gate）：中间步回置 pending，重做产物上得了等待闸门的卡（R1 P1-1，2026-11-04）', async () => {
    const w = makeWorld();
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await settleFirstTurn(w, wf.id, '理解完成');
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '对齐闸门' });
    const gate1 = w.store.stepsForWorkflow(wf.id).find((s) => s.title === '对齐闸门')!;
    await w.engine.approve(gate1.id, '', 'boss');
    await w.engine.appendNode(wf.id, {
      kind: 'gate', title: '确认闸门',
      input: { delivery: 'apply', draft: '方案段收工，diff 见工件' },
    });
    const gate2 = w.store.stepsForWorkflow(wf.id).find((s) => s.title === '确认闸门')!;
    expect(gate2.status).toBe('waiting_human');
    expect(w.store.getStep(gate1.id)!.status).toBe('completed'); // 中间闸门已批（修复前的病灶前提）

    await w.engine.rework(gate2.id, '交付物没挂上，重交', 'iphone');

    // (a) 中间步回置 pending（同 reworkSend human.ts 中间步回置先例口径）
    expect(w.store.getStep(gate1.id)!.status).toBe('pending');
    // agent 重做 → 播种落中间闸门 → 中间闸门重开等人审（先例语义：人审不可跳过）。
    // 重做的那张卡先确认送达（第二张卡登记了、还没送达时到的收工回调会被拦下）。
    const agent = w.store.stepsForWorkflow(wf.id)[0]!;
    await until(() => w.store.entityEvents('step', agent.id, 'step_dispatched').length >= 2);
    await w.engine.onAgentStopped('juli-reply', 'done', '新方案 V2：交付物已挂上');
    await w.engine.advance(wf.id); // 排空 continueWorkflow 的 void advance
    const gate1Reopened = w.store.getStep(gate1.id)!;
    expect(gate1Reopened.status).toBe('waiting_human');
    expect(gate1Reopened.input['draft']).toBe('新方案 V2：交付物已挂上');
    await w.engine.approve(gate1Reopened.id, '', 'boss');
    await w.engine.advance(wf.id); // 排空：等待闸门重开
    // (b) 重做产物可达：等待闸门 input 带上一轮驳回意见（web/iOS 卡按 P2-6
    // 渲染为独立条目）——不再与上一轮逐字节同卡
    const gate2Reopened = w.store.getStep(gate2.id)!;
    expect(gate2Reopened.status).toBe('waiting_human');
    expect(gate2Reopened.input['feedback']).toBe('交付物没挂上，重交');
    expect(Number(w.store.getWorkflow(wf.id)!.meta['round'])).toBe(2);
  });

  it('无可回修步：驳回零状态变更显式拒驳（杀死空转重推）', async () => {
    const w = makeWorld();
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    const agent = w.store.stepsForWorkflow(wf.id)[0]!;
    // 构造「人弃」前置：唯一 instructable 步被置 cancelled（cancelStep 只收
    // pending/waiting_human，这里直用 store API 造边角状态——守卫测的就是它）。
    w.store.setStepStatus(agent.id, 'cancelled');
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '确认闸门', input: { delivery: 'apply' } });
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    expect(gate.status).toBe('waiting_human');

    await expect(w.engine.rework(gate.id, '改一下', 'iphone')).rejects.toThrow(/无可回修步/);

    expect(w.store.getStep(gate.id)!.status).toBe('waiting_human'); // 闸门没被动过
    expect(w.store.listEvents(50).some((e) => e.type === 'gate_rework')).toBe(false);
    expect(w.store.getWorkflow(wf.id)!.meta['round']).toBeUndefined();
  });
});

describe('修复③：有机回合补扫 case-inbox → 等待闸门', () => {
  it('无在飞 agent 步的回合收尾：交付物收编进等待闸门 input + 文件消费', async () => {
    const w = makeWorld();
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await settleFirstTurn(w, wf.id, '理解完成'); // 回合1：有步，正常结算
    await w.engine.appendNode(wf.id, {
      kind: 'gate', title: '确认闸门',
      input: { delivery: 'apply', envelope: { feedback_refs: ['v4h6fq87019dm5y'] } },
    });
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    expect(gate.status).toBe('waiting_human');

    // 回合2（organic，闸门回流唤醒）：方案工件 + 申报单落盘后收工。
    deliverInbox(join(w.inbox, wf.id), {
      'fix-plan-1103.html': '<!doctype html><html><body>方案</body></html>',
      'reply.json': JSON.stringify({ deliverables: [{ file: 'fix-plan-1103.html', role: 'report', summary: '方案段五段工单' }] }),
    });
    await w.engine.onAgentStopped('juli-reply', 'done', '方案段收工，等批');

    const gateAfter = w.store.getStep(gate.id)!;
    const dl = gateAfter.input['deliverables'] as { name: string; view_role: string; summary: string }[];
    expect(Array.isArray(dl)).toBe(true);
    expect(dl).toHaveLength(1);
    expect(dl[0]!.name).toBe('fix-plan-1103.html');
    expect(dl[0]!.view_role).toBe('report');
    expect(dl[0]!.summary).toBe('方案段五段工单');
    expect(gateAfter.input['manifest']).toBe(true);
    // 工件落闸门名下（与 reconcile 补扫同型）
    expect(w.ledger.list(wf.id).some((a) => a.stepId === gate.id && a.name === 'fix-plan-1103.html')).toBe(true);
    // sweep 消费文件：inbox 已空
    expect(readdirSync(join(w.inbox, wf.id))).toHaveLength(0);
    // 事件留痕
    expect(w.store.listEvents(50).some((e) => e.type === 'gate_deliverables_swept')).toBe(true);
    // 申报 envelope 的 feedback_refs 不被 swept envelope 冲掉（申报键优先）
    const env = gateAfter.input['envelope'] as Record<string, unknown>;
    expect(Array.isArray(env['feedback_refs']) && (env['feedback_refs'] as string[])[0] === 'v4h6fq87019dm5y').toBe(true);

    // 幂等：同回合 Stop hook 重入 → 0 件 no-op，不重复登记。
    await w.engine.onAgentStopped('juli-reply', 'done', '重复信号');
    expect(((w.store.getStep(gate.id)!.input['deliverables']) as unknown[])).toHaveLength(1);
  });

  it('sweep 补料进已开发送闸门后 checks 重算（R1 P2-5，2026-11-04）——不沿用陈旧绿灯', async () => {
    const w = makeWorld();
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await settleFirstTurn(w, wf.id, '理解完成');
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '发送闸门', input: { draft: '第一版正文' } });
    const gate = w.store.stepsForWorkflow(wf.id).find((s) => s.kind === 'gate')!;
    expect(gate.status).toBe('waiting_human');
    // 开闸转变沿已按「第一版正文」跑过 checks（appendNode 自动配对 send 步）
    const stale = w.store.getStep(gate.id)!.input['checks'] as { name: string; status: string }[];
    expect(stale.find((c) => c.name === 'redline')?.status).toBe('pass'); // 陈旧绿灯

    // 有机回合补扫：新正文（含红线词「run号」）经申报单收编进闸门 input
    deliverInbox(join(w.inbox, wf.id), {
      'reply-v2.txt': '内部 run号 修正后的正文',
      'reply.json': JSON.stringify({ deliverables: [{ file: 'reply-v2.txt', role: 'body', summary: '修订正文' }] }),
    });
    await w.engine.onAgentStopped('juli-reply', 'done', '修订版正文已写好');

    const gateAfter = w.store.getStep(gate.id)!;
    const checks = gateAfter.input['checks'] as { name: string; status: string }[];
    expect(checks.find((c) => c.name === 'redline')?.status).toBe('fail'); // 新正文实测值，非沿用陈旧绿灯
    expect(checks.find((c) => c.name === 'body')?.status).toBe('pass');
    expect(w.store.listEvents(50).some((e) => e.type === 'send_checks_ran')).toBe(true);
  });

  it('无等待闸门：有机回合不扫（产出不错记到无人认领的步）', async () => {
    const w = makeWorld();
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await settleFirstTurn(w, wf.id, '理解完成');
    deliverInbox(join(w.inbox, wf.id), { 'stray.txt': '无主文件' });
    await w.engine.onAgentStopped('juli-reply', 'done', '又一回合');
    expect(w.store.listEvents(50).some((e) => e.type === 'gate_deliverables_swept')).toBe(false);
    // 文件原地保留（收口兜底 finalSweepInbox 另有归宿）
    expect(readdirSync(join(w.inbox, wf.id))).toContain('stray.txt');
  });
});

describe('修复⑤：appendNode 空摘要闸门留痕告警', () => {
  it('无 draft/plan/note/deliverables 的闸门 → gate_missing_summary 事件；带 draft → 无', async () => {
    const w = makeWorld();
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    await settleFirstTurn(w, wf.id, '理解完成');
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '空卡闸' });
    expect(w.store.listEvents(50).some((e) => e.type === 'gate_missing_summary')).toBe(true);

    const eventsBefore = w.store.listEvents(200).filter((e) => e.type === 'gate_missing_summary').length;
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '带摘要闸', input: { draft: '批准=生效授权' } });
    const eventsAfter = w.store.listEvents(200).filter((e) => e.type === 'gate_missing_summary').length;
    expect(eventsAfter).toBe(eventsBefore);
  });
});

// mkdtemp 目录交给 OS tmpdir 清理（review-chain 同口径），不入 git 不留盘。
