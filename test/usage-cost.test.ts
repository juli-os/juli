// 详情页 usageCost（wf_535149a174fe）：store 行级聚合 + 详情端点挂载。
// 口径与 promptStats 同源（sessions × agent 步窗口并集）——同窗口同会话
// 两套数字必须对得上；不在价目的模型显式 unpriced。

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime } from '../src/runtime.ts';
import { createHttpApp } from '../src/http/app.ts';
import { costContextOf } from '../src/business/workflow/costContext.ts';

describe('costContextOf 计费时点窗口延伸（wf_be61c3a55842）', () => {
  const agent = (a: string, b: string) => ({ kind: 'agent', status: 'completed', startedAt: a, updatedAt: b, completedAt: b });
  const gateDone = (at: string, delivery = 'apply') =>
    ({ kind: 'gate', status: 'completed', startedAt: at, updatedAt: at, completedAt: at, input: { delivery } });

  it('已终态单：[首个已批闸门完成, 终态时刻] 并入窗口——approve 后回流执行段计入', () => {
    const w = { status: 'completed', session: 'acme', meta: {}, createdAt: '2026-10-09T00:35:00Z', updatedAt: '2026-10-09T01:22:35Z' };
    const { effWindows } = costContextOf(w, [
      agent('2026-10-09T00:35:34Z', '2026-10-09T00:57:02Z'),
      gateDone('2026-10-09T01:04:05Z'),
    ]);
    expect(effWindows).toContainEqual(['2026-10-09T01:04:05Z', '2026-10-09T01:22:35Z']);
    expect(effWindows).toHaveLength(2); // 步窗口 + 延伸段
  });

  it('在途单：延伸终点 = max(最后活动, updated_at)——回流执行中实时覆盖', () => {
    const w = { status: 'running', session: 'acme', meta: {}, createdAt: '2026-10-09T00:35:00Z', updatedAt: '2026-10-09T01:04:10Z' };
    const { effWindows } = costContextOf(w, [
      agent('2026-10-09T00:35:34Z', '2026-10-09T00:57:02Z'),
      gateDone('2026-10-09T01:04:05Z'),
    ], '2026-10-09T01:30:00Z');
    expect(effWindows).toContainEqual(['2026-10-09T01:04:05Z', '2026-10-09T01:30:00Z']);
  });

  it('无已批闸门不延伸（闸门等待期的行不计）；问询闸（answer）批准后的回流消耗同样计入', () => {
    const w = { status: 'running', session: 'acme', meta: {}, createdAt: '2026-10-09T00:35:00Z', updatedAt: '2026-10-09T01:00:00Z' };
    const waiting = { kind: 'gate', status: 'waiting_human', startedAt: '2026-10-09T00:57:02Z', updatedAt: '2026-10-09T00:57:02Z' };
    expect(costContextOf(w, [agent('2026-10-09T00:35:34Z', '2026-10-09T00:57:02Z'), waiting], '2026-10-09T09:00:00Z').effWindows)
      .toHaveLength(1);
    // 问询闸批准 = 回答回流，agent 继续原任务的消耗属于本单（与收口资格
    // 语义不同：autoSettleApprovedRuns 排除 answer 是「链未走完」判定）。
    expect(costContextOf(w, [agent('2026-10-09T00:35:34Z', '2026-10-09T00:57:02Z'), gateDone('2026-10-09T00:57:10Z', 'answer')], '2026-10-09T09:00:00Z').effWindows)
      .toContainEqual(['2026-10-09T00:57:10Z', '2026-10-09T09:00:00Z']);
  });

  it('多轮已批闸门取首个（中途等待期无行不虚增，各轮执行段全覆盖）', () => {
    const w = { status: 'completed', session: 'acme', meta: {}, createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T05:00:00Z' };
    const { effWindows } = costContextOf(w, [
      agent('2026-10-09T00:00:00Z', '2026-10-09T01:00:00Z'),
      gateDone('2026-10-09T01:10:00Z'),
      gateDone('2026-10-09T03:00:00Z'),
    ]);
    expect(effWindows).toContainEqual(['2026-10-09T01:10:00Z', '2026-10-09T05:00:00Z']);
  });

  it('无 agent 步区间退化行为不变（[created, updated] 全窗兜底）', () => {
    const w = { status: 'completed', session: 'acme', meta: {}, createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T01:00:00Z' };
    expect(costContextOf(w, [gateDone('2026-10-09T00:30:00Z')]).effWindows)
      .toEqual([['2026-10-09T00:00:00Z', '2026-10-09T01:00:00Z']]);
  });
});

// glm-5.3-flash 价目（2026-10-06 抓取）：input 0.8 / cache 0.23 / output 2.8。
const insertTurn = (
  db: DatabaseSync, session: string, model: string,
  input: number, output: number, cached: number, at: string,
): void => {
  db.prepare(`INSERT INTO prompt_usage (source, note, model, input_tokens, output_tokens, cached_tokens, duration_ms, error, created_at, tmux_session)
    VALUES ('claude_code', '', ?, ?, ?, ?, 0, '', ?, ?)`).run(model, input, output, cached, at, session);
};

describe('GET /api/lifecycle/workflows/:id usageCost', () => {
  it('窗内行代入价目：cache/input/output 三价加总，与 promptStats 同口径', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-ucost-'));
    try {
      const rt = createRuntime(configSchema.parse({
        data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-uc',
      }));
      const app = createHttpApp(rt);
      const w = rt.store.createWorkflow({ kind: 'adhoc', title: '计价单' });
      rt.store.db.prepare('UPDATE workflows SET session=? WHERE id=?').run('juli-a', w.id);
      const st = rt.store.createStep({ workflowId: w.id, seq: 1, kind: 'agent', title: '执行' });
      rt.store.db.prepare('UPDATE workflow_steps SET started_at=?, updated_at=? WHERE id=?')
        .run('2026-10-06T01:00:00Z', '2026-10-06T02:00:00Z', st.id);
      const udb = new DatabaseSync(join(dir, 'prompt_usage.db'));
      insertTurn(udb, 'juli-a', 'glm-5.3-flash', 1_000_000, 100_000, 800_000, '2026-10-06T01:10:00.000Z'); // 窗内
      insertTurn(udb, 'juli-a', 'glm-5.3-flash', 999_999, 0, 0, '2026-10-06T03:30:00.000Z'); // 窗外：不计
      const res = await app.request(`/api/lifecycle/workflows/${w.id}`, {
        headers: { authorization: 'Bearer pw-uc' },
      });
      expect(res.status).toBe(200);
      const d = await res.json() as {
        promptStats: { count: number; inputTokens: number };
        usageCost: {
          byModel: { model: string; priced: boolean; calls: number; costCny: { cache: number; input: number; output: number; total: number } }[];
          totalCny: { total: number };
          pricingRetrievedAt: string;
        };
      };
      // 同口径：窗外行两边都不计
      expect(d.promptStats.count).toBe(1);
      const m = d.usageCost.byModel[0]!;
      expect(m.model).toBe('glm-5.3-flash');
      expect(m.priced).toBe(true);
      // cache 0.8×0.23 + input 0.2×0.8 + output 0.1×2.8 = 0.184+0.16+0.28
      expect(m.costCny).toEqual({ cache: 0.184, input: 0.16, output: 0.28, total: 0.624 });
      expect(d.usageCost.totalCny.total).toBe(0.624);
      expect(d.usageCost.pricingRetrievedAt).toBe('2026-10-06');
      udb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('双会话（转派单）行集不相交分别计价；不在价目的模型进 unpricedModels', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-ucost2-'));
    try {
      const rt = createRuntime(configSchema.parse({
        data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-uc',
      }));
      const app = createHttpApp(rt);
      const w = rt.store.createWorkflow({
        kind: 'adhoc', title: '转派计价单', meta: { assigned_session: 'juli-b' },
      });
      rt.store.db.prepare('UPDATE workflows SET session=? WHERE id=?').run('juli-a', w.id);
      const st = rt.store.createStep({ workflowId: w.id, seq: 1, kind: 'agent', title: '执行' });
      rt.store.db.prepare('UPDATE workflow_steps SET started_at=?, updated_at=? WHERE id=?')
        .run('2026-10-06T01:00:00Z', '2026-10-06T02:00:00Z', st.id);
      const udb = new DatabaseSync(join(dir, 'prompt_usage.db'));
      insertTurn(udb, 'juli-a', 'glm-5.3', 1_000_000, 0, 0, '2026-10-06T01:10:00.000Z');   // 8 元
      insertTurn(udb, 'juli-b', 'claude-opus-5', 500_000, 50_000, 0, '2026-10-06T01:20:00.000Z'); // 无价目
      const res = await app.request(`/api/lifecycle/workflows/${w.id}`, {
        headers: { authorization: 'Bearer pw-uc' },
      });
      const d = await res.json() as {
        usageCost: {
          byModel: { model: string; priced: boolean; costCny: { total: number } }[];
          totalCny: { total: number };
          unpricedModels: string[];
        };
      };
      expect(d.usageCost.byModel.map((m) => m.model).sort()).toEqual(['claude-opus-5', 'glm-5.3']);
      expect(d.usageCost.unpricedModels).toEqual(['claude-opus-5']);
      expect(d.usageCost.totalCny.total).toBe(8); // 无价目行不计入合计
      udb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('无用量单：byModel 空、合计零（详情页静默不渲染）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-ucost3-'));
    try {
      const rt = createRuntime(configSchema.parse({
        data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-uc',
      }));
      const app = createHttpApp(rt);
      const w = rt.store.createWorkflow({ kind: 'adhoc', title: '空单' });
      const res = await app.request(`/api/lifecycle/workflows/${w.id}`, {
        headers: { authorization: 'Bearer pw-uc' },
      });
      const d = await res.json() as { usageCost: { byModel: unknown[]; totalCny: { total: number } } };
      expect(d.usageCost.byModel).toEqual([]);
      expect(d.usageCost.totalCny.total).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('已终态单：approve 后回流执行段的行计入（wf_56ee12d27e1f 缺陷回归）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-ucost5-'));
    try {
      const rt = createRuntime(configSchema.parse({
        data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-uc',
      }));
      const app = createHttpApp(rt);
      const w = rt.store.createWorkflow({ kind: 'adhoc', title: '回流计价单', meta: { mode: 'nodes' } });
      rt.store.db.prepare('UPDATE workflows SET session=?, updated_at=? WHERE id=?')
        .run('juli-a', '2026-10-09T03:00:00Z', w.id);
      const st = rt.store.createStep({ workflowId: w.id, seq: 1, kind: 'agent', title: '执行' });
      rt.store.db.prepare('UPDATE workflow_steps SET started_at=?, updated_at=?, status=? WHERE id=?')
        .run('2026-10-09T01:00:00Z', '2026-10-09T02:00:00Z', 'completed', st.id);
      const g = rt.store.createStep({
        workflowId: w.id, seq: 2, kind: 'gate', title: '确认闸门',
        input: { delivery: 'apply' },
      });
      // 闸门 completed 于 02:30（approve 时刻）；run 终态（completed）于 03:00。
      rt.store.db.prepare('UPDATE workflow_steps SET updated_at=?, status=? WHERE id=?')
        .run('2026-10-09T02:30:00Z', 'completed', g.id);
      rt.store.db.prepare('UPDATE workflows SET status=? WHERE id=?').run('completed', w.id);
      const udb = new DatabaseSync(join(dir, 'prompt_usage.db'));
      insertTurn(udb, 'juli-a', 'glm-5.3', 1_000_000, 0, 0, '2026-10-09T01:10:00.000Z'); // 步窗内：8 元
      insertTurn(udb, 'juli-a', 'glm-5.3', 1_000_000, 0, 0, '2026-10-09T02:45:00.000Z'); // 延伸段（回流执行）：8 元
      insertTurn(udb, 'juli-a', 'glm-5.3', 999_999, 0, 0, '2026-10-09T03:30:00.000Z'); // 终态后：不计
      const res = await app.request(`/api/lifecycle/workflows/${w.id}`, {
        headers: { authorization: 'Bearer pw-uc' },
      });
      const d = await res.json() as {
        promptStats: { count: number };
        usageCost: { byModel: { calls: number }[]; totalCny: { total: number } };
      };
      expect(d.promptStats.count).toBe(2);
      expect(d.usageCost.byModel[0]!.calls).toBe(2);
      expect(d.usageCost.totalCny.total).toBe(16);
      udb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('UsageStore.sessionWindowsPriced（store 直查）', () => {
  it('多会话并集聚合：两会话行集不相交，无窗口返回空价', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-ucost4-'));
    try {
      const rt = createRuntime(configSchema.parse({
        data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-uc',
      }));
      const dbPath = join(dir, 'prompt_usage.db');
      const udb = new DatabaseSync(dbPath);
      insertTurn(udb, 'juli-a', 'glm-5.3', 1_000_000, 0, 0, '2026-10-06T01:10:00.000Z');
      insertTurn(udb, 'juli-b', 'glm-5.3', 1_000_000, 1_000_000, 500_000, '2026-10-06T01:20:00.000Z');
      udb.close();
      const win: readonly (readonly [string, string])[] = [['2026-10-06T01:00:00.000Z', '2026-10-06T02:00:00.000Z']];
      // a: input 8；b: cache 0.5×2 + input 0.5×8 + out 1×28 = 1+4+28=33 → 合计 41
      const r = rt.usage.sessionWindowsPriced(['juli-a', 'juli-b'], win);
      expect(r.byModel[0]!.calls).toBe(2);
      expect(r.totalCny).toEqual({ cache: 1, input: 12, output: 28, total: 41 });
      expect(rt.usage.sessionWindowsPriced(['juli-a'], []).byModel).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
