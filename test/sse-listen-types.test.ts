// SSE 命名帧监听全集派生契约（R1 P1#2）：sse.ts 的监听表 = events-meta.ts
// 的 SSE_LISTEN_TYPES 派生。此前的手写 16 名清单与元数据表四度漂移——3 个
// urgent 警报帧（step_waiting_human/workflow_failed/agent_zombie）、STATE_
// CHANGING 缺 7 名、email_sent 全没监听，「闸门等待你的决定」红警报在 live
// 通路永不出现。本测试钉死三件事：现有名一个不丢（丢 = 回归）、缺失名全部
// 在（缺 = 回归）、集合恰等于四源并集（手写旁路 = 回归）。

import { describe, expect, it } from 'vitest';
import { SSE_LISTEN_TYPES, HUMAN_EVENT_TYPES, STATE_CHANGING_EVENTS, TOAST_LEVELS } from '../web/src/events-meta.ts';

// 手写 16 名（2026-09-28 时点的 sse.ts 清单原样）——一个都不能丢。
const LEGACY_16: readonly string[] = [
  'email_received', 'step_completed', 'completed',
  // 路由 DAG（apply 2026-09-20）
  'route_decision', 'route_fallback', 'session_bound_route',
  // jev 判定三态（九跑 P1 补监听）
  'route_judgment', 'route_judgment_applied', 'route_judgment_rejected',
  // feedback 页自动刷新（2026-09-28）
  'task_started', 'workflow_denied', 'feedback_flushed', 'feedback_gate_backfilled',
  'feedback_gate_auto_appended', 'feedback_gate_auto_append_failed', 'feedback_anchor_inherited',
];

// R1 P1#2 点名的曾缺失帧：3 urgent + 5 状态/结算/邮件帧（STATE_CHANGING
// 其余成员与 16 名有交集，单列无意义，由第二组断言全量覆盖）。
const R1_MISSING: readonly string[] = [
  'step_waiting_human', 'workflow_failed', 'agent_zombie',
  'step_failed', 'gate_approved', 'gate_aligned', 'run_settled', 'email_sent',
];

describe('SSE 监听全集派生契约（R1 P1#2）', () => {
  it('⊇ 手写 16 名一个不丢（丢任何一名 = 回归）', () => {
    for (const t of LEGACY_16) expect(SSE_LISTEN_TYPES.has(t), `缺 ${t}`).toBe(true);
  });

  it('⊇ 3 个 urgent + STATE_CHANGING 全部 + R1 点名 5 帧', () => {
    for (const t of STATE_CHANGING_EVENTS) expect(SSE_LISTEN_TYPES.has(t), `缺 STATE_CHANGING ${t}`).toBe(true);
    for (const t of R1_MISSING) expect(SSE_LISTEN_TYPES.has(t), `缺 ${t}`).toBe(true);
  });

  it('恰等于四源并集（HUMAN ∪ STATE_CHANGING ∪ TOAST 键 ∪ 表外）——手写旁路即红', () => {
    const expected = new Set([
      ...HUMAN_EVENT_TYPES,
      ...STATE_CHANGING_EVENTS,
      ...Object.keys(TOAST_LEVELS),
      // SSE_EXTRA_TYPES 是模块私有——表外名单若被移出派生，这里会多出差异，
      // 逼着改动者把新名字显式落回本测试或元数据表，不能静默绕开。
      'route_judgment', 'route_judgment_applied', 'route_judgment_rejected',
      'feedback_flushed', 'feedback_gate_backfilled', 'feedback_gate_auto_appended',
      'feedback_gate_auto_append_failed', 'feedback_anchor_inherited',
    ]);
    expect([...SSE_LISTEN_TYPES].sort()).toEqual([...expected].sort());
  });

  it('监听全集确实补上了 R1 缺口（16 → 覆盖 urgent/重载/邮件帧）', () => {
    expect(SSE_LISTEN_TYPES.size).toBeGreaterThan(LEGACY_16.length);
    expect(LEGACY_16.every((t) => SSE_LISTEN_TYPES.has(t))).toBe(true);
  });
});
