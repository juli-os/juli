// settle 守卫测试（第 3 轮审查问题 4）：收口动作锁内重读 + waiting_human/pending
// 拒绝 + 已终态幂等。空容器与全 completed 单的正常收口不回归。
import { describe, expect, it } from 'vitest';
import { makeEngine } from './helpers.ts';
import type { StepKind, StepStatus, WorkflowStatus } from '../src/contracts/entities.ts';

type World = ReturnType<typeof makeEngine>;

const mkWf = (
  w: World,
  steps: readonly { kind: StepKind; status: StepStatus }[],
  wfStatus?: WorkflowStatus,
): string => {
  const wf = w.store.createWorkflow({ kind: 'adhoc', title: 'settle-guard', ...(wfStatus ? { status: wfStatus } : {}) });
  steps.forEach((s, i) => {
    const st = w.store.createStep({ workflowId: wf.id, seq: i, kind: s.kind, title: `step-${i}-${s.kind}` });
    w.store.setStepStatus(st.id, s.status);
  });
  return wf.id;
};

const settledEvents = (w: World, wfId: string): number =>
  w.store.listEvents(500).filter((e) => e.type === 'run_settled' && e.entityId === wfId).length;

describe('settle 守卫（锁内重读 · 拒绝未了结单 · 终态幂等）', () => {
  it('waiting_human 闸门:拒绝收口,工作流保持 running,零 run_settled', async () => {
    const w = makeEngine();
    const wfId = mkWf(w, [{ kind: 'gate', status: 'waiting_human' }]);
    await expect(w.engine.settle(wfId, 'boss')).rejects.toThrow(/waiting_human/);
    expect(w.store.getWorkflow(wfId)!.status).toBe('running');
    expect(settledEvents(w, wfId)).toBe(0);
  });

  it('pending 步:拒绝收口(锁外读-写窗口不再能孤儿化 pending)', async () => {
    const w = makeEngine();
    const wfId = mkWf(w, [{ kind: 'send', status: 'completed' }, { kind: 'agent', status: 'pending' }]);
    await expect(w.engine.settle(wfId, 'boss')).rejects.toThrow(/pending/);
    expect(w.store.getWorkflow(wfId)!.status).toBe('running');
    expect(settledEvents(w, wfId)).toBe(0);
  });

  it('running 步:既有拒绝语义保留', async () => {
    const w = makeEngine();
    const wfId = mkWf(w, [{ kind: 'agent', status: 'running' }]);
    await expect(w.engine.settle(wfId, 'boss')).rejects.toThrow('running node exists — settle it first');
    expect(w.store.getWorkflow(wfId)!.status).toBe('running');
  });

  it('正常收口:全 completed 单 settle → completed,恰 1 条 run_settled;重复 settle 幂等', async () => {
    const w = makeEngine();
    const wfId = mkWf(w, [{ kind: 'send', status: 'completed' }]);
    await w.engine.settle(wfId, 'boss');
    expect(w.store.getWorkflow(wfId)!.status).toBe('completed');
    expect(settledEvents(w, wfId)).toBe(1);
    await w.engine.settle(wfId, 'boss'); // 已 completed:静默幂等,不重复追加
    await w.engine.settle(wfId, 'boss');
    expect(settledEvents(w, wfId)).toBe(1);
    expect(w.store.getWorkflow(wfId)!.status).toBe('completed');
  });

  it('并发 settle 串行进锁:合计只落 1 条 run_settled(锁序列化 + 幂等)', async () => {
    const w = makeEngine();
    const wfId = mkWf(w, [{ kind: 'send', status: 'completed' }]);
    await Promise.all([
      w.engine.settle(wfId, 'a'),
      w.engine.settle(wfId, 'b'),
      w.engine.settle(wfId, 'c'),
    ]);
    expect(settledEvents(w, wfId)).toBe(1);
    expect(w.store.getWorkflow(wfId)!.status).toBe('completed');
  });

  it('cancelled/failed 单:settle 幂等返回,不翻状态不落事件', async () => {
    const w = makeEngine();
    const wfC = mkWf(w, [{ kind: 'send', status: 'completed' }], 'cancelled');
    await w.engine.settle(wfC, 'boss');
    expect(w.store.getWorkflow(wfC)!.status).toBe('cancelled');
    expect(settledEvents(w, wfC)).toBe(0);
    const wfF = mkWf(w, [{ kind: 'agent', status: 'failed' }], 'failed');
    await w.engine.settle(wfF, 'boss');
    expect(w.store.getWorkflow(wfF)!.status).toBe('failed');
    expect(settledEvents(w, wfF)).toBe(0);
  });

  it('空容器(nodes 模式)收口不回归:零步 settle → completed', async () => {
    const w = makeEngine();
    const wfId = mkWf(w, []);
    await w.engine.settle(wfId, 'boss');
    expect(w.store.getWorkflow(wfId)!.status).toBe('completed');
    expect(settledEvents(w, wfId)).toBe(1);
  });
});
