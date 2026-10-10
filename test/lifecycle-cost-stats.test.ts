// Flow Dashboard 费用聚合（wf_6a74fc4a23e4）：GET /api/lifecycle/cost-stats——
// 逐单复用详情 usageCost 口径（sessions × agent 步窗口）聚合分桶/分位/明细。
// 边界纪律：分桶右开（5 落 [5,20) 不落 [0,5)）；已取消计入；无归属/无用量单
// 显式计数；纯无价目单不入桶只列名；模型序固定（id 升序，配色跟实体）。

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime } from '../src/runtime.ts';
import { createHttpApp } from '../src/http/app.ts';

// 价目 output 价（2026-10-06 快照）：纯 output 行成本 = tokens/1e6 × price——
// 按模型出价折 tokens，得到想要的整/半元成本，边界可控。
// glm-4-air-250414: 0.5；glm-5.3: 28；jev-1 不在价目（成本恒 0，价只用来
// 控 token 量级）。
const PRICE_OF: Record<string, number> = { 'glm-4-air-250414': 0.5, 'glm-5.3': 28, 'jev-1': 1 };
const tokOf = (model: string, yuan: number): number => Math.round((yuan / (PRICE_OF[model] ?? 1)) * 1e6);
// 时间全部相对 Date.now()——days 过滤对真实时钟敏感，写死日期会随跑期漂移变红。
const H = 3_600_000;
const ago = (h: number): string => new Date(Date.now() - h * H).toISOString();

const insertTurn = (
  db: DatabaseSync, session: string, model: string,
  output: number, at: string,
): void => {
  db.prepare(`INSERT INTO prompt_usage (source, note, model, input_tokens, output_tokens, cached_tokens, duration_ms, error, created_at, tmux_session)
    VALUES ('claude_code', '', ?, 0, ?, 0, 0, '', ?, ?)`).run(model, output, at, session);
};

interface CostStatsResp {
  overall: {
    workflows: number; ordersWithCost: number; zeroCostOrders: number;
    totalCny: number; meanCny: number; medianCny: number; p90Cny: number; maxCny: number;
  };
  buckets: { label: string; edges: [number, number | null]; count: number; totalCny: number; byModel: { model: string; count: number }[] }[];
  perOrder: { id: string; status: string; totalCny: number; models: string[] }[];
  models: { model: string; label: string }[];
  unpricedOrders: string[];
}

const setup = (dir: string) => {
  const rt = createRuntime(configSchema.parse({
    data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-cs',
  }));
  return { rt, app: createHttpApp(rt), udb: new DatabaseSync(join(dir, 'prompt_usage.db')) };
};

/** 建一单：会话 + agent 步窗口 + 窗内一条纯 output 回合（成本=yuan——
 * tokens 按该模型 output 价折算，见 PRICE_OF）。 */
const makeOrder = (
  rt: ReturnType<typeof createRuntime>, udb: DatabaseSync,
  opts: { session: string; model?: string; yuan: number; status?: string; window: [string, string] },
): string => {
  const model = opts.model ?? 'glm-4-air-250414';
  const w = rt.store.createWorkflow({ kind: 'adhoc', title: `单-${opts.yuan}` });
  rt.store.db.prepare('UPDATE workflows SET session=?, status=? WHERE id=?')
    .run(opts.session, opts.status ?? 'completed', w.id);
  const st = rt.store.createStep({ workflowId: w.id, seq: 1, kind: 'agent', title: '执行' });
  rt.store.db.prepare('UPDATE workflow_steps SET started_at=?, updated_at=? WHERE id=?')
    .run(opts.window[0], opts.window[1], st.id);
  insertTurn(udb, opts.session, model, tokOf(model, opts.yuan), opts.window[0]);
  return w.id;
};

// 近 1 小时窗口（days=30 恒覆盖）
const WIN: [string, string] = [ago(1), ago(0.5)];

describe('GET /api/lifecycle/cost-stats', () => {
  it('分桶右开边界（5/20/50/100/200）+ 模型固定序 + 分位', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-cstats-'));
    try {
      const { rt, app, udb } = setup(dir);
      // 六档各踩边界：4.9995 / 5 / 20 / 50 / 100 / 200——右开
      for (const yuan of [4.9995, 5, 20, 50, 100, 200]) {
        makeOrder(rt, udb, { session: `s-${yuan}`, yuan, window: WIN });
      }
      // 分位样本：4 单成本 1/2/3/10
      for (const yuan of [1, 2, 3, 10]) {
        makeOrder(rt, udb, { session: `q-${yuan}`, yuan, window: WIN });
      }
      // 第二模型进堆叠 + 模型序（id 升序：glm-4-air-250414 < glm-5.3）
      makeOrder(rt, udb, { session: 's-mix', model: 'glm-5.3', yuan: 7, window: WIN });

      const res = await app.request('/api/lifecycle/cost-stats?days=30', {
        headers: { authorization: 'Bearer pw-cs' },
      });
      expect(res.status).toBe(200);
      const d = await res.json() as CostStatsResp;
      // 右开：4.9995 落 [0,5)，5 落 [5,20)，20 落 [20,50)，50/100/200 同理
      expect(d.buckets.map((b) => b.label)).toEqual(['¥0–5', '¥5–20', '¥20–50', '¥50–100', '¥100–200', '¥200+']);
      expect(d.buckets.map((b) => b.count)).toEqual([4, 3, 1, 1, 1, 1]);
      // ¥5–20 桶按模型堆叠：air（5、10）+ glm-5.3（7）
      const b5 = d.buckets[1]!;
      expect(b5.byModel.map((m) => m.model).sort()).toEqual(['glm-4-air-250414', 'glm-5.3']);
      // 分位：11 单成本升序 1,2,3,4.9995,5,7,10,20,50,100,200
      // median=costs[5]=7，p90=costs[9]=100，max=200
      expect(d.overall.ordersWithCost).toBe(11);
      expect(d.overall.medianCny).toBe(7);
      expect(d.overall.p90Cny).toBe(100);
      expect(d.overall.maxCny).toBe(200);
      // 模型序固定（id 升序）——前端配色跟实体
      expect(d.models.map((m) => m.model)).toEqual(['glm-4-air-250414', 'glm-5.3']);
      expect(d.models[1]!.label).toBe('GLM-5.3');
      udb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('已取消单计入；无步区间退化全窗；days=0 全量 vs days 窗口排除旧单', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-cstats2-'));
    try {
      const { rt, app, udb } = setup(dir);
      makeOrder(rt, udb, { session: 's-cancel', yuan: 5, status: 'cancelled', window: WIN });
      // 无 agent 步 → 退化 [created, updated] 全窗：把 created 拉早 2h，窗内用量仍计价
      //（注意 updated_at 只随状态变更推进——首建即终态的单全窗零宽，是既有口径）
      const w2 = rt.store.createWorkflow({ kind: 'adhoc', title: '无步单' });
      rt.store.db.prepare('UPDATE workflows SET session=?, created_at=?, updated_at=? WHERE id=?')
        .run('s-nostep', ago(2), ago(0.5), w2.id);
      insertTurn(udb, 's-nostep', 'glm-4-air-250414', tokOf('glm-4-air-250414', 20), ago(1));
      // 40 天前的旧单：days=30 排除、days=0 计入
      const wOld = rt.store.createWorkflow({ kind: 'adhoc', title: '旧单' });
      rt.store.db.prepare('UPDATE workflows SET session=?, created_at=?, updated_at=? WHERE id=?')
        .run('s-old', ago(40 * 24), ago(40 * 24 - 1), wOld.id);
      const stOld = rt.store.createStep({ workflowId: wOld.id, seq: 1, kind: 'agent', title: '执行' });
      rt.store.db.prepare('UPDATE workflow_steps SET started_at=?, updated_at=? WHERE id=?')
        .run(ago(40 * 24), ago(40 * 24 - 1), stOld.id);
      insertTurn(udb, 's-old', 'glm-4-air-250414', tokOf('glm-4-air-250414', 100), ago(40 * 24));

      const get = async (days: number): Promise<CostStatsResp> => {
        const r = await app.request(`/api/lifecycle/cost-stats?days=${days}`, {
          headers: { authorization: 'Bearer pw-cs' },
        });
        return await r.json() as CostStatsResp;
      };
      // 近 30 天：取消 5 + 无步全窗 20；旧单（40 天前）排除
      const d30 = await get(30);
      expect(d30.overall.ordersWithCost).toBe(2);
      expect(d30.overall.totalCny).toBe(25);
      expect(d30.perOrder.some((o) => o.status === 'cancelled' && o.totalCny === 5)).toBe(true);
      expect(d30.perOrder.some((o) => o.totalCny === 20)).toBe(true); // 无步全窗退化
      expect(d30.perOrder.some((o) => o.totalCny === 100)).toBe(false);
      // days=0：全量含旧单
      const d0 = await get(0);
      expect(d0.overall.ordersWithCost).toBe(3);
      expect(d0.overall.totalCny).toBe(125);
      udb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('无计价单显式计数（无归属/无用量）；纯无价目单不入桶只列名', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-cstats3-'));
    try {
      const { rt, app, udb } = setup(dir);
      // 无归属会话的单
      rt.store.createWorkflow({ kind: 'adhoc', title: '无归属' });
      // 有会话无用量
      const w2 = rt.store.createWorkflow({ kind: 'adhoc', title: '无用量' });
      rt.store.db.prepare('UPDATE workflows SET session=? WHERE id=?').run('s-empty', w2.id);
      // 纯无价目模型单（jev 系不在 bigmodel 价目）
      makeOrder(rt, udb, { session: 's-jev', model: 'jev-1', yuan: 30, window: WIN });
      // 一条正常计价单对照
      makeOrder(rt, udb, { session: 's-ok', yuan: 10, window: WIN });

      const res = await app.request('/api/lifecycle/cost-stats?days=30', {
        headers: { authorization: 'Bearer pw-cs' },
      });
      const d = await res.json() as CostStatsResp;
      expect(d.overall.workflows).toBe(4);
      expect(d.overall.ordersWithCost).toBe(1);
      expect(d.overall.zeroCostOrders).toBe(2); // 无归属 + 无用量
      expect(d.buckets.reduce((a, b) => a + b.count, 0)).toBe(1); // 无价目单不占桶
      expect(d.unpricedOrders.length).toBe(1);
      udb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
