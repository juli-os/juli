// 闸门自动批准（2026-10-07 用户裁定）：匹配器硬边界（问询/发送闸门）+
// 规则四维匹配 + sweep 行为（on 真批走 approve 正门带 by=juli-auto、
// shadow 只留痕、off 零动作、竞态逐步隔离）。

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime } from '../src/runtime.ts';
import { createHttpApp } from '../src/http/app.ts';
import { matchAutoApprove, projectAutoApprove, autoApproveSweep, type AutoApproveCtx, type AutoApproveConfig } from '../src/business/workflow/autoApprove.ts';

const ctx = (over: Partial<AutoApproveCtx> = {}): AutoApproveCtx => ({
  kind: 'adhoc', title: '跟进单', session: 'juli-dev', sender: '', delivery: 'apply', isQuestion: false, ...over,
});

const cfg = (mode: AutoApproveConfig['mode'], rules: Record<string, unknown>[]): AutoApproveConfig =>
  projectAutoApprove({ mode, rules: rules.map((r, i) => ({ id: `r${i + 1}`, include_send: false, ...r })) });

describe('matchAutoApprove 硬边界', () => {
  it('问询闸门永不自动批（规则全匹配也不行）', () => {
    const r = matchAutoApprove(cfg('on', [{}]), ctx({ isQuestion: true }));
    expect(r).toBeNull();
  });

  it('发送闸门（delivery=email）默认不批；规则显式 include_send 才进自动面', () => {
    expect(matchAutoApprove(cfg('on', [{}]), ctx({ delivery: 'email' }))).toBeNull();
    expect(matchAutoApprove(cfg('on', [{ include_send: true }]), ctx({ delivery: 'email' }))?.id).toBe('r1');
    // 非发送闸门不受 include_send 影响
    expect(matchAutoApprove(cfg('on', [{}]), ctx({ delivery: 'artifact' }))?.id).toBe('r1');
  });

  it('off 模式与空规则零动作', () => {
    expect(matchAutoApprove(cfg('off', [{}]), ctx())).toBeNull();
    expect(matchAutoApprove(cfg('on', []), ctx())).toBeNull();
  });
});

describe('matchAutoApprove 规则四维', () => {
  it('kind/session/internal/title_contains 各维独立咬合，不匹配让位下一条', () => {
    const c = cfg('on', [
      { kind: 'email' },
      { session: 'project-a' },
      { internal: true },
      { title_contains: '试卷' },
    ]);
    expect(matchAutoApprove(c, ctx())?.id).toBe('r3');            // 内部单命中 r3
    expect(matchAutoApprove(c, ctx({ sender: 'casey@x.de' }))).toBeNull(); // 外部单全落空
    expect(matchAutoApprove(c, ctx({ title: '语文试卷优化' }))?.id).toBe('r3'); // r3 仍先命中（顺序优先）
    expect(matchAutoApprove(cfg('on', [{ session: 'project-a' }, { kind: 'adhoc' }]), ctx({ kind: 'feedback' }))).toBeNull();
    expect(matchAutoApprove(cfg('on', [{ title_contains: '试卷' }]), ctx({ title: '跟进单' }))).toBeNull();
  });

  it('title_contains 大小写不敏感', () => {
    expect(matchAutoApprove(cfg('on', [{ title_contains: 'PPT' }]), ctx({ title: '给客户出 ppt 介绍' }))?.id).toBe('r1');
  });
});

describe('projectAutoApprove 安全投影', () => {
  it('畸形输入回落 off+空规则；字段逐个收窄', () => {
    expect(projectAutoApprove(null).mode).toBe('off');
    expect(projectAutoApprove('x').rules).toEqual([]);
    expect(projectAutoApprove({ mode: 'bogus' }).mode).toBe('off');
    const p = projectAutoApprove({ mode: 'shadow', rules: [{}, { id: 'a', kind: 'adhoc', internal: true, include_send: true }, 'junk'] });
    expect(p.mode).toBe('shadow');
    expect(p.rules).toHaveLength(2);
    expect(p.rules[0]!.id).toBe('rule-1'); // 缺 id 自动补
    expect(p.rules[1]!.includeSend).toBe(true);
  });
});

describe('autoApproveSweep 行为（真实 store + 注入 approve）', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-autoap-'));
    const rt = createRuntime(configSchema.parse({ data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-ap' }));
    return rt;
  };
  /** 建一张带 waiting gate 的单：内部 adhoc 单落 juli-dev。 */
  const makeWaitingGate = (rt: ReturnType<typeof createRuntime>, input: Record<string, unknown> = {}): string => {
    const w = rt.store.createWorkflow({ kind: 'adhoc', title: '跟进单：迭代优化' });
    rt.store.db.prepare('UPDATE workflows SET session=? WHERE id=?').run('juli-dev', w.id);
    const st = rt.store.createStep({ workflowId: w.id, seq: 1, kind: 'gate', title: '确认' });
    rt.store.db.prepare('UPDATE workflow_steps SET status=?, input=? WHERE id=?')
      .run('waiting_human', JSON.stringify(input), st.id);
    return w.id;
  };

  it('on：命中即走 approve 正门（by=juli-auto）+ 账本留 gate_auto_approved', async () => {
    const rt = setup();
    const wId = makeWaitingGate(rt);
    const calls: { id: string; note: string; by: string }[] = [];
    const n = await autoApproveSweep({
      store: rt.store, config: () => cfg('on', [{ session: 'juli-dev' }]),
      approve: async (id, note, by) => { calls.push({ id, note, by }); },
      log: console,
    });
    expect(n).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.by).toBe('juli-auto');
    expect(calls[0]!.note).toContain('规则 r1');
    const evts = rt.store.db.prepare("SELECT type FROM events WHERE entity_id=? AND type LIKE 'gate_auto%'").all(wId) as { type: string }[];
    expect(evts.map((e) => e.type)).toContain('gate_auto_approved');
    rt.stop();
  });

  it('shadow：只留痕不批；off：零动作', async () => {
    const rt = setup();
    makeWaitingGate(rt);
    const calls: string[] = [];
    const ns = await autoApproveSweep({ store: rt.store, config: () => cfg('shadow', [{}]), approve: async (id) => { calls.push(id); }, log: console });
    expect(ns).toBe(1);
    expect(calls).toHaveLength(0);
    const no = await autoApproveSweep({ store: rt.store, config: () => cfg('off', [{}]), approve: async (id) => { calls.push(id); }, log: console });
    expect(no).toBe(0);
    expect(calls).toHaveLength(0);
    rt.stop();
  });

  it('问询闸门与外发闸门在 sweep 层同样被硬边界拦住', async () => {
    const rt = setup();
    makeWaitingGate(rt, { question_options: ['A', 'B'] });
    makeWaitingGate(rt, { delivery: 'email' });
    const calls: string[] = [];
    const n = await autoApproveSweep({ store: rt.store, config: () => cfg('on', [{}]), approve: async (id) => { calls.push(id); }, log: console });
    expect(n).toBe(0); // 两个都被硬边界排除
    expect(calls).toHaveLength(0);
    rt.stop();
  });

  it('approve 抛错逐步隔离不炸整轮（后面的闸门照批）', async () => {
    const rt = setup();
    const w1 = makeWaitingGate(rt);
    makeWaitingGate(rt);
    const gates = rt.store.db.prepare("SELECT id FROM workflow_steps WHERE kind='gate' AND status='waiting_human'").all() as { id: string }[];
    const n = await autoApproveSweep({
      store: rt.store, config: () => cfg('on', [{}]),
      approve: async (id) => { if (id === gates[0]!.id) throw new Error('already handled'); },
      log: console,
    });
    expect(n).toBe(1); // 第二个照批
    expect(w1).toBeTruthy();
    rt.stop();
  });
});

describe('单子级免批（meta.auto_approve，前端按单开关）', () => {
  const setupFlag = () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-autoap2-'));
    return createRuntime(configSchema.parse({ data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-ap2' }));
  };
  const makeGate = (rt: ReturnType<typeof createRuntime>, input: Record<string, unknown> = {}): string => {
    const w = rt.store.createWorkflow({ kind: 'adhoc', title: '跟进单' });
    rt.store.db.prepare('UPDATE workflows SET session=? WHERE id=?').run('juli-dev', w.id);
    const st = rt.store.createStep({ workflowId: w.id, seq: 1, kind: 'gate', title: '确认' });
    rt.store.db.prepare('UPDATE workflow_steps SET status=?, input=? WHERE id=?')
      .run('waiting_human', JSON.stringify(input), st.id);
    return w.id;
  };

  it('meta 标记无视 config off 直达自动面（by=juli-auto，note 含「本单免批」）', async () => {
    const rt = setupFlag();
    const wId = makeGate(rt);
    rt.store.updateWorkflowMeta(wId, { auto_approve: true });
    const calls: { by: string; note: string }[] = [];
    const n = await autoApproveSweep({
      store: rt.store, config: () => cfg('off', []), // 全局配置关着
      approve: async (_id, note, by) => { calls.push({ by, note }); }, log: console,
    });
    expect(n).toBe(1);
    expect(calls[0]!.by).toBe('juli-auto');
    expect(calls[0]!.note).toContain('本单免批');
    rt.stop();
  });

  it('硬边界对单子级标记同样钉死：外发与问询闸门不自动批', async () => {
    const rt = setupFlag();
    const w1 = makeGate(rt, { delivery: 'email' });
    const w2 = makeGate(rt, { question_options: ['A'] });
    rt.store.updateWorkflowMeta(w1, { auto_approve: true });
    rt.store.updateWorkflowMeta(w2, { auto_approve: true });
    const calls: string[] = [];
    const n = await autoApproveSweep({ store: rt.store, config: () => cfg('off', []), approve: async (id) => { calls.push(id); }, log: console });
    expect(n).toBe(0);
    expect(calls).toHaveLength(0);
    rt.stop();
  });

  it('切换路由：POST auto-approve 落 meta+事件，on 时立即 sweep（在等闸门当轮清）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-autoap3-'));
    const rt = createRuntime(configSchema.parse({ data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-ap3' }));
    const app = createHttpApp(rt);
    const auth = { 'content-type': 'application/json', authorization: 'Bearer pw-ap3' };
    const wId = makeGate(rt);
    const r1 = await app.request(`/api/lifecycle/workflows/${wId}/auto-approve`, { method: 'POST', headers: auth, body: JSON.stringify({ on: true }) });
    expect(r1.status).toBe(200);
    const d1 = await r1.json() as { on: boolean; gates_acted: number };
    expect(d1.on).toBe(true);
    expect(d1.gates_acted).toBeGreaterThanOrEqual(1);
    const step = rt.store.db.prepare('SELECT status FROM workflow_steps WHERE workflow_id=?').get(wId) as { status: string };
    expect(step.status).toBe('completed');
    const r2 = await app.request(`/api/lifecycle/workflows/${wId}/auto-approve`, { method: 'POST', headers: auth, body: JSON.stringify({ on: false }) });
    expect((await r2.json() as { on: boolean }).on).toBe(false);
    const w2 = rt.store.getWorkflow(wId);
    expect((w2?.meta?.['auto_approve'] ?? null) === true).toBe(false);
    const evts = rt.store.db.prepare("SELECT type FROM events WHERE entity_id=? AND type='auto_approve_set' ORDER BY id").all(wId) as { type: string }[];
    expect(evts).toHaveLength(2);
    rt.stop();
  });
});
