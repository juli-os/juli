// listEvents 类型过滤回放（2026-09-22 路由图数据面）：稀有事件深埋大窗口之外时，
// 过滤后 limit 全部花在该类型上——真实历史可达，不需要模拟。

import { describe, expect, it } from 'vitest';
import { createLedgerStore } from '../src/platform/ledger/store.ts';

const store = createLedgerStore(':memory:');

for (let i = 0; i < 50; i++) store.appendEvent('workflow', `wf_${i}`, 'noise', {});
store.appendEvent('workflow', 'wf_a', 'route_decision', { session: 'acme' });
store.appendEvent('workflow', 'wf_b', 'route_fallback', { requested: 'acme', resolved: 'juli-reply' });
store.appendEvent('workflow', 'wf_c', 'route_decision', { session: 'juli-reply' });
for (let i = 50; i < 100; i++) store.appendEvent('workflow', `wf_${i}`, 'noise', {});

describe('store.listEvents 类型过滤', () => {
  it('过滤后 limit 全花在该类型上：深埋窗口外的稀有事件可达', () => {
    const unfiltered = store.listEvents(10).map((e) => e.type);
    expect(unfiltered).not.toContain('route_decision'); // 窗口内全是 noise
    const hits = store.listEvents(10, ['route_decision', 'route_fallback']);
    expect(hits.map((e) => e.type)).toEqual(['route_decision', 'route_fallback', 'route_decision']); // id 倒序
    expect(hits[0]?.entityId).toBe('wf_c'); // 最新在前
  });

  it('无过滤/空数组=原行为', () => {
    expect(store.listEvents(5)).toHaveLength(5);
    expect(store.listEvents(5, [])).toHaveLength(5);
  });
});
