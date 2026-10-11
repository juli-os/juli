// 步动作矩阵测试（web/src/step-actions.ts，0922 收口）：kind×status → 可用
// 动词的判定变数据后，矩阵本身就是契约——加动作/改口径先改这里的断言。
// 覆盖 lifecycle actions() 原 if-else 梯的全部分支（渲染字节不变由视图层
// ios-compat/web 测试兜底，这里锁判定语义）。

import { describe, expect, it } from 'vitest';
import { decideStepActions, FAILED_INTERVENABLE_KINDS } from '../web/src/step-actions.ts';
import { AGENT_STEP_KINDS } from '@juli-os/ledger';

const step = (kind: string, status: string, extra: Record<string, unknown> = {}):
  { id: string; kind: string; status: string; output?: Record<string, unknown> } =>
  ({ id: 'st_test', kind, status, ...extra });

const noSession = (): string => '';

describe('步动作矩阵：闸门分支', () => {
  it('gate + waiting_human + sendGate=true → 批准并发送/定时/补料组', () => {
    const d = decideStepActions(step('gate', 'waiting_human'), noSession, { sendGate: true });
    expect(d.branch).toBe('gate');
    expect(d.send).toBe(true);
    expect(d.actions).toEqual(['approve-send', 'deny', 'resolve', 'schedule', 'amend', 'rework']);
  });
  it('gate + waiting_human + sendGate=false → 批准/修正并确认组', () => {
    const d = decideStepActions(step('gate', 'waiting_human'), noSession, { sendGate: false });
    expect(d.send).toBe(false);
    expect(d.actions).toEqual(['approve', 'deny', 'resolve', 'align', 'rework']);
  });
});

describe('步动作矩阵：失败分支', () => {
  it('send + guard（守卫拒发）→ 打回补正/补料修正，无盲重试', () => {
    const d = decideStepActions(step('send', 'failed', { output: { guard: 'disclosure_missing' } }), noSession);
    expect(d.branch).toBe('failed');
    expect(d.guard).toBe('disclosure_missing');
    expect(d.actions).toEqual(['rework-send', 'amend']);
    expect(d.actions).not.toContain('retry');
  });
  it('agent 失败 → 重试/补料/干预重试（可干预集含 llm）', () => {
    for (const kind of ['agent', 'verify', 'llm']) {
      const d = decideStepActions(step(kind, 'failed'), noSession);
      expect(d.actions, `kind=${kind}`).toEqual(['retry', 'amend', 'intervene']);
    }
  });
  it('draft/triage/send(无守卫) 失败 → 只重试/补料', () => {
    for (const kind of ['draft', 'triage', 'share', 'send']) {
      const d = decideStepActions(step(kind, 'failed'), noSession);
      expect(d.actions, `kind=${kind}`).toEqual(['retry', 'amend']);
    }
  });
});

describe('步动作矩阵：在跑/取消/空档', () => {
  it('running agent/verify → 插话纠偏（携带会话名）', () => {
    const d = decideStepActions(step('agent', 'running'), () => 'juli-reply');
    expect(d.branch).toBe('running-agent');
    expect(d.interveneSession).toBe('juli-reply');
    expect(d.actions).toEqual(['intervene2']);
  });
  it('running agent 无会话 → 动词集空', () => {
    const d = decideStepActions(step('agent', 'running'), noSession);
    expect(d.interveneSession).toBe('');
  });
  it('pending / waiting_human(非 gate) → 取消此步', () => {
    for (const status of ['pending', 'waiting_human']) {
      const d = decideStepActions(step('agent', status), noSession);
      expect(d.branch).toBe('cancellable');
      expect(d.actions).toEqual(['cancel']);
    }
  });
  it('终态步 → 无动作', () => {
    for (const status of ['completed', 'cancelled', 'skipped']) {
      expect(decideStepActions(step('agent', status), noSession).branch).toBe('none');
    }
  });
});

describe('口径与引擎能力集对齐', () => {
  it('FAILED_INTERVENABLE_KINDS = agent/verify/llm（引擎 AGENT_STEP_KINDS + llm）', () => {
    expect(FAILED_INTERVENABLE_KINDS).toEqual([...AGENT_STEP_KINDS, 'llm']);
  });
});
