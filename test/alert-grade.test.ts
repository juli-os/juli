// withAlertGrade（alert_grade 挂点，2026-09-27 审查 P1 修复）：语义分级包装
// 挂在真实推送面（combinePushers 外层）——此前唯一挂点 pushAllWithDesktop 是
// 零调用方死函数，场景永不运行。这里钉：grade=false 静默跳过、true/抛错照推
// （fail-open）、fire-and-forget 语义（持锁路径零新增延迟）、可选方法透传。

import { describe, expect, it } from 'vitest';
import type { PusherPort } from '../src/contracts/ports.ts';
import { withAlertGrade } from '../src/platform/push/email.ts';

const stubW = { id: 'wf_1', title: '告警T' } as never;
const stubS = { id: 'st_1' } as never;

const recording = () => {
  const calls: string[] = [];
  const inner: PusherPort = {
    gateWaiting: async () => { calls.push('gateWaiting'); },
    workflowDone: async () => { calls.push('workflowDone'); },
    workflowFailed: async () => { calls.push('workflowFailed'); },
  };
  return { calls, inner };
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('withAlertGrade（alert_grade 真实挂点）', () => {
  it('grade=true → 照推', async () => {
    const { calls, inner } = recording();
    const p = withAlertGrade(inner, async () => true);
    await p.gateWaiting(stubW, stubS, 's');
    await tick();
    expect(calls).toEqual(['gateWaiting']);
  });

  it('grade=false（info 高置信降噪）→ 静默跳过推送', async () => {
    const { calls, inner } = recording();
    const p = withAlertGrade(inner, async () => false);
    await p.workflowFailed(stubW, '降级通知');
    await tick();
    expect(calls).toEqual([]);
  });

  it('grade 抛错 → 照推（分级挂了 fail-open，绝不吞通知）', async () => {
    const { calls, inner } = recording();
    const p = withAlertGrade(inner, async () => { throw new Error('provider down'); });
    await p.gateWaiting(stubW, stubS, 's');
    await tick();
    expect(calls).toEqual(['gateWaiting']);
  });

  it('fire-and-forget：方法立即 resolve，不等分级与发送（引擎持锁路径零新增延迟）', async () => {
    const { inner } = recording();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = withAlertGrade(inner, async () => { await gate; return true; });
    let settled = false;
    const pr = p.gateWaiting(stubW, stubS, 's').then(() => { settled = true; });
    await tick();
    expect(settled).toBe(true); // 调用方已放行，分级还挂在 gate 上
    release();
    await pr;
  });

  it('可选方法按内层有无透传（内层没有=包装层也不暴露，engine ?. 调用语义不变）', () => {
    const { inner } = recording();
    const p = withAlertGrade(inner, async () => true);
    expect(p.chainDangling).toBeUndefined();
    expect(p.stepFailed).toBeUndefined();
    expect(p.settleHint).toBeUndefined();
  });

  it('内层有可选方法 → 经分级透传（grade=false 同样静默）', async () => {
    const calls: string[] = [];
    const inner: PusherPort = {
      gateWaiting: async () => { calls.push('gateWaiting'); },
      workflowDone: async () => { calls.push('workflowDone'); },
      workflowFailed: async () => { calls.push('workflowFailed'); },
      stepFailed: async () => { calls.push('stepFailed'); },
    };
    const p = withAlertGrade(inner, async () => false);
    expect(p.stepFailed).toBeDefined();
    await p.stepFailed!(stubW, stubS, 'r');
    await tick();
    expect(calls).toEqual([]);
  });
});
