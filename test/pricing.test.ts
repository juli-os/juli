// API 等效计价（wf_535149a174fe）：bigmodel 价目数据面 + priceUsage 计价口径。
// 核心断言：cache/input/output 三价拆分、行级档位落档、免费档、不在价目
// 不出价（不猜价）、匹配边界（前后缀不吃错价）。

import { describe, expect, it } from 'vitest';
import { findPrice, priceUsage, type UsageRow } from '../src/platform/ledger/pricing.ts';

const row = (model: string, inputTokens: number, outputTokens: number, cachedTokens = 0): UsageRow =>
  ({ model, inputTokens, outputTokens, cachedTokens });

describe('findPrice（价目匹配）', () => {
  it('小写归一：大写账本名命中价目', () => {
    expect(findPrice('GLM-5.3-Flash')?.id).toBe('glm-5.3-flash');
  });
  it('前缀边界：glm-4.7-flashx 不吃 glm-4.7-flash 的价', () => {
    expect(findPrice('glm-4.7-flashx')?.id).toBe('glm-4.7-flashx');
  });
  it('无日期后缀走同价别名（glm-4-flash）', () => {
    expect(findPrice('glm-4-flash')?.id).toBe('glm-4-flash');
    expect(findPrice('glm-4-flash-250414')?.id).toBe('glm-4-flash-250414');
  });
  it('不在价目：jev/claude 系/已下架档返回 null', () => {
    expect(findPrice('jev-1.13.0')).toBeNull();
    expect(findPrice('claude-opus-5')).toBeNull();
    expect(findPrice('glm-4.6')).toBeNull();
    expect(findPrice('')).toBeNull();
  });
});

describe('priceUsage（三价计价）', () => {
  it('cached 是 input 子集：cache 价×cached + input 价×差额 + output 价', () => {
    const r = priceUsage([row('glm-5.3', 2_000_000, 1_000_000, 1_500_000)]);
    const m = r.byModel[0]!;
    expect(m.priced).toBe(true);
    expect(m.costCny).toEqual({ cache: 3, input: 4, output: 28, total: 35 });
    expect(m.inputTokensChargeable).toBe(500_000);
    expect(r.totalCny.total).toBe(35);
  });

  it('行级落档：glm-5.1 同单跨 <32K/≥32K 两档分别计价', () => {
    const r = priceUsage([
      row('glm-5.1', 31_000, 5_000, 10_000),
      row('glm-5.1', 50_000, 5_000),
    ]);
    const m = r.byModel[0]!;
    expect(m.tiersHit).toEqual(['入<32K', '入≥32K']);
    // 行1：0.01×1.3 + 0.021×6 + 0.005×24 = 0.013+0.126+0.12 = 0.259
    // 行2：0.05×8 + 0.005×28 = 0.4+0.14 = 0.54
    expect(m.costCny.total).toBe(0.799);
  });

  it('glm-4.7 二维档（入长×出长）：三档各自命中', () => {
    const r = priceUsage([
      row('glm-4.7', 10_000, 100),
      row('glm-4.7', 10_000, 500),
      row('glm-4.7', 40_000, 500),
    ]);
    const m = r.byModel[0]!;
    expect(m.tiersHit).toEqual(['入<32K·出<0.2K', '入<32K·出≥0.2K', '入32K–200K']);
    // 0.02+0.0008 + 0.03+0.007 + 0.16+0.008 = 0.2258
    expect(m.costCny.total).toBe(0.2258);
  });

  it('免费档（glm-4.7-flash）：用量照记、价格为零', () => {
    const r = priceUsage([row('glm-4.7-flash', 999_999, 123_456, 555_555)]);
    const m = r.byModel[0]!;
    expect(m.free).toBe(true);
    expect(m.costCny.total).toBe(0);
    expect(m.inputTokens).toBe(999_999);
    expect(r.unpricedModels).toEqual([]);
  });

  it('cache 不支持的模型：cached 按普通 input 价（glm-4-airx）', () => {
    const r = priceUsage([row('glm-4-airx', 1_000_000, 200_000, 400_000)]);
    // cache 0.4×10 + input 0.6×10 + output 0.2×10（无缓存折价，等效不虚构）
    expect(r.byModel[0]!.costCny).toEqual({ cache: 4, input: 6, output: 2, total: 12 });
  });

  it('不在价目的模型：只显用量不出价，进 unpricedModels', () => {
    const r = priceUsage([row('jev-1.13.0', 100_000, 5_000), row('glm-5.3', 1_000_000, 0)]);
    const unpriced = r.byModel.find((m) => m.model === 'jev-1.13.0')!;
    expect(unpriced.priced).toBe(false);
    expect(unpriced.costCny.total).toBe(0);
    expect(unpriced.calls).toBe(1);
    expect(r.unpricedModels).toEqual(['jev-1.13.0']);
    expect(r.totalCny.total).toBe(8); // 只有 glm-5.3 计价
  });

  it('异常行 clamp：cached>input 不出负价', () => {
    const r = priceUsage([row('glm-5.3', 100, 0, 500)]);
    expect(r.byModel[0]!.costCny.input).toBeGreaterThanOrEqual(0);
    expect(r.byModel[0]!.costCny.cache).toBe(0.0002); // clamp 到 100 → 0.0001×2
  });

  it('超顶档兜底：glm-4.7 入 250K 并入最后一档', () => {
    const r = priceUsage([row('glm-4.7', 250_000, 100)]);
    expect(r.byModel[0]!.tiersHit).toEqual(['入32K–200K']);
  });

  it('空输入与零用量行', () => {
    expect(priceUsage([]).byModel).toEqual([]);
    expect(priceUsage([row('glm-5.3', 0, 0)]).byModel).toEqual([]);
  });
});
