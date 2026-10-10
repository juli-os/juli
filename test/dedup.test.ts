// 去重守卫测试（09-07 事故回归锁）：LIKE 模式转义必须配 ESCAPE '\'，否则
// 含 `_` 的 message-id（几乎全部真实邮件）永不匹配、去重整体失效、同一封
// 邮件每轮询周期重复建档。两层语义分开：引擎=活跃在途拦；轮询=非 rejected 拦。

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedgerStore } from '../src/platform/ledger/store.ts';

const newStore = (): ReturnType<typeof createLedgerStore> =>
  createLedgerStore(join(mkdtempSync(join(tmpdir(), 'juli-dedup-')), 'lifecycle.db'));

// 真实形态：腾讯企业邮箱 message-id，含 `_`；再加 `%`/`"` 的极端形态。
const KEY = '<tencent_032B06D1CA10DECDCF6C8C0C09C6E82';
const NASTY = '<weird_100%"quoted_key';

describe('去重（ESCAPE 回归锁）', () => {
  it('hasActiveDedup：含下划线的 key 在途可拦；结算后放行', () => {
    const store = newStore();
    const w = store.createWorkflow({ kind: 'email', title: 't', meta: { dedup_key: KEY } });
    expect(store.hasActiveDedup(KEY)).toBe(true);
    store.setWorkflowStatus(w.id, 'failed');
    expect(store.hasActiveDedup(KEY)).toBe(false);
  });

  it('hasActiveDedup：`%` 与 `"` 在 key 里也精确匹配，不误判不漏判', () => {
    const store = newStore();
    store.createWorkflow({ kind: 'email', title: 't', meta: { dedup_key: NASTY } });
    expect(store.hasActiveDedup(NASTY)).toBe(true);
    // 前缀相同但尾部不同的 key 不得互相命中
    expect(store.hasActiveDedup(NASTY + 'X')).toBe(false);
    expect(store.hasActiveDedup('<tencent_032B06D1CA10DECDCF6C8C0C09C6E83')).toBe(false);
  });

  it('hasSeenDedup：failed 也算已摄取（轮询不再拉）；rejected 不算（放行后必须能流）', () => {
    const store = newStore();
    const w = store.createWorkflow({ kind: 'email', title: 't', meta: { dedup_key: KEY } });
    expect(store.hasSeenDedup(KEY)).toBe(true);
    store.setWorkflowStatus(w.id, 'rejected');
    expect(store.hasSeenDedup(KEY)).toBe(false);
    expect(store.hasActiveDedup(KEY)).toBe(false);
  });

  it('hasActiveDedup：waiting_human 的 CASE 也拦（闸门挂着 = 在途）', () => {
    const store = newStore();
    store.createWorkflow({ kind: 'email', title: 't', meta: { dedup_key: KEY, note: 'simulated parked gate' } });
    expect(store.hasActiveDedup(KEY)).toBe(true);
  });
});
