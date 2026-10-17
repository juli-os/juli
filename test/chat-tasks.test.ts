// chat 账本读模型直测（R8 批4 刀2 随下放补齐）：list_tasks 检索窗口规则
// （50/2000/100 魔数——2026-10-14 用户裁定「找单子只能找 20 太少」）与
// get_task 单子全息聚合（usageAggOf 口径）此前长在 runtime 组合根内零直测
// ——下放 business/intake/chatTasks 后用真 in-memory 账本直钉。

import { describe, expect, it } from 'vitest';
import { createLedgerStore, type LifecycleStore } from '@juli-os/ledger';
import type { ArtifactLedger, ArtifactRow } from '@juli-os/artifacts';
import { getTaskOf, listTasksOf, type ChatTaskQueriesDeps } from '../src/business/intake/chatTasks.ts';

const pricedUsage = (total: number, unpriced: readonly string[] = []) => ({
  perSessionWindows: () => ({ count: 2, inputTokens: 111, outputTokens: 22 }),
  sessionWindowsPriced: () => ({
    currency: 'CNY' as const, unit: 'per_1m_tokens' as const, pricingSource: 'test', pricingRetrievedAt: '',
    byModel: [], totalCny: { cache: 0, input: 0, output: 0, total }, unpricedModels: unpriced,
  }),
});

const artifactsOf = (rows: readonly { name: string; role: string }[]): Pick<ArtifactLedger, 'list'> => ({
  // 测试行只喂 getTask 消费的 name/role 两字段——ArtifactRow 其余字段零消费，窄桩。
  list: () => rows as unknown as readonly ArtifactRow[],
});

const depsOf = (
  usage: ChatTaskQueriesDeps['usage'],
  artifacts: Pick<ArtifactLedger, 'list'> = artifactsOf([]),
): ChatTaskQueriesDeps & { store: LifecycleStore } => {
  const store = createLedgerStore(':memory:');
  return { store, usage, artifacts };
};

describe('listTasksOf（检索窗口规则）', () => {
  it('scope=inflight：窗 50——60 条在办只见面 50；终态单被滤掉', () => {
    const d = depsOf(pricedUsage(0));
    d.store.createWorkflow({ kind: 'task', title: '已完', status: 'completed' }); // 最老（窗内不可见）
    for (let i = 0; i < 60; i++) d.store.createWorkflow({ kind: 'task', title: `在办${i}`, status: 'running' });
    const rows = listTasksOf(d)('inflight', 100, '');
    expect(rows).toHaveLength(50); // 窗口 50 先裁（新→旧全 running）、终态滤除在后
    expect(rows.every((r) => r.status === 'running')).toBe(true);
  });

  it('recent+关键词：窗 2000 深窗——最老的单也能按标题/单号搜到', () => {
    const d = depsOf(pricedUsage(0));
    const needle = d.store.createWorkflow({ kind: 'task', title: '跟进Meridian合同 RFQ' }); // 最老（listWorkflows 新→旧）
    for (let i = 0; i < 120; i++) d.store.createWorkflow({ kind: 'task', title: `噪声${i}`, status: 'completed' });
    const byTitle = listTasksOf(d)('recent', 10, 'Meridian');
    expect(byTitle.map((r) => r.id)).toEqual([needle.id]);
    const byId = listTasksOf(d)('recent', 10, needle.id.slice(0, 8)); // wf_ 片段搜索单号
    expect(byId.map((r) => r.id)).toEqual([needle.id]);
    // 大小写不敏感（用中性 ASCII 词断言——投影 global_replaces 换词后两侧
    // 大小写仍须同构，中文词 toUpperCase 会在公开仓变成大小写不匹配陷阱）。
    expect(listTasksOf(d)('recent', 10, 'rfq').map((r) => r.id)).toEqual([needle.id]);
    expect(listTasksOf(d)('recent', 10, 'RFQ').map((r) => r.id)).toEqual([needle.id]);
  });

  it('recent 无关键词：常规窗 floor 100 + slice limit', () => {
    const d = depsOf(pricedUsage(0));
    for (let i = 0; i < 150; i++) d.store.createWorkflow({ kind: 'task', title: `单${i}` });
    expect(listTasksOf(d)('recent', 100, '')).toHaveLength(100); // 窗 max(100,100)=100：150 条只见 100
    expect(listTasksOf(d)('recent', 20, '')).toHaveLength(20); // limit 收敛
    expect(listTasksOf(d)('recent', 20, '')[0]!.title).toBe('单149'); // 新→旧
  });
});

describe('getTaskOf（单子全息）', () => {
  it('全息形状：steps 阶梯/waitingOn/deliverables/usageAggOf 口径（prompts+costCny）', async () => {
    const d = depsOf(pricedUsage(2.34), artifactsOf([{ name: '季报.xlsx', role: 'report' }]));
    const w = d.store.createWorkflow({ kind: 'task', title: '查单' });
    d.store.setWorkflowSession(w.id, 'sess-x');
    const s1 = d.store.createStep({ workflowId: w.id, seq: 1, kind: 'agent', title: '执行' });
    const s2 = d.store.createStep({ workflowId: w.id, seq: 2, kind: 'gate', title: '人审闸' });
    d.store.setStepStatus(s2.id, 'waiting_human');
    const t = await getTaskOf(d)(w.id);
    expect(t).not.toBeNull();
    expect(t!.id).toBe(w.id);
    expect(t!.session).toBe('sess-x');
    expect(t!.steps.map((s) => s.kind)).toEqual(['agent', 'gate']);
    expect(t!.waitingOn).toBe('人审闸');
    expect(t!.deliverables).toEqual([{ name: '季报.xlsx', role: 'report' }]);
    expect(t!.prompts).toBe(2); // 归属会话 perSessionWindows.count
    expect(t!.costCny).toBe(2.34); // 四舍五入到分
    expect(s1.status).toBe('pending'); // 夹具自检：另一步非等人
  });

  it('无价物纪律：纯无价目模型不出价（costCny=null 不猜价）', async () => {
    const d = depsOf(pricedUsage(0, ['mystery-model']));
    const w = d.store.createWorkflow({ kind: 'task', title: '无价单' });
    d.store.setWorkflowSession(w.id, 's');
    const t = await getTaskOf(d)(w.id);
    expect(t!.costCny).toBeNull();
  });

  it('单子不存在 → null', async () => {
    const d = depsOf(pricedUsage(0));
    await expect(getTaskOf(d)('wf_nope0000000')).resolves.toBeNull();
  });
});
