// 派发途中点「中止」（2026-11-23 全量审查，问题 2）。
// 事故形态：runAgentStep 里 `await deps.dispatch.dispatch(...)` 要等 agent 就绪
// （忙时约 20 秒，冷启动最长 240 秒），这期间工作流锁被派发路径持有。forceClose
// 不持锁、立刻把在途步置 cancelled——派发返回后却不看状态，照常记
// step_dispatched、续心跳。账本里 step_cancelled 早于 step_dispatched：单子已
// 取消，任务卡照样送到，agent 照着已取消的单子开工（现网 40 张被中止的单里
// 有 2 张）。

import { describe, expect, it } from 'vitest';
import { makeEngine, until, type MockWorld } from './helpers.ts';
import { err, ok, type Result } from '../src/platform/shared/result.ts';

const routing = { defaultSession: 'juli-reply', defaultProject: 'p' };

/** 可控的假派发器：每次调用都挂住，等测试按次序放行（放行时给成功或失败）。 */
const gatedDispatch = () => {
  const calls: { session: string; text: string }[] = [];
  const gates: ((r: Result<void, Error>) => void)[] = [];
  return {
    calls,
    port: {
      dispatch(_source: string, session: string, text: string): Promise<Result<void, Error>> {
        calls.push({ session, text });
        return new Promise<Result<void, Error>>((resolve) => { gates.push(resolve); });
      },
    },
    release: (index: number, r: Result<void, Error> = ok(undefined)): void => {
      gates[index]?.(r);
    },
  };
};

/** 让已经放行的 promise 链跑完（派发返回后的收尾、打断回执都是微任务）。 */
const flush = async (ms = 30): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

/** 某一步的事件类型，按发生先后排（listEvents 是倒序，这里翻回来）。 */
const stepEventTypes = (w: MockWorld, stepId: string): string[] =>
  [...w.store.listEvents(500)].reverse()
    .filter((e) => e.entityType === 'step' && e.entityId === stepId).map((e) => e.type);

/** 派发返回后的两种结局，等哪一种出现都行：正常记了 step_dispatched，或记了
 * 「任务卡落在已取消的步骤上」。 */
const waitDispatchReturned = (w: MockWorld, stepId: string): Promise<void> => {
  const landed = () => ['step_dispatched', 'step_dispatched_after_cancel']
    .some((t) => w.store.entityEvents('step', stepId, t).length > 0);
  return until(landed);
};

describe('派发途中中止', () => {
  it('派发返回后不记 step_dispatched，单独留痕，并打断 agent', async () => {
    const interrupts: string[] = [];
    const g = gatedDispatch();
    const w = makeEngine({
      routing, availableSessions: ['juli-reply'], dispatch: g.port,
      interruptSession: async (session) => { interrupts.push(session); return true; },
    });
    const wf = await w.engine.startTask('派发途中被中止', { brief: '中止竞态单独特标记' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await until(() => g.calls.length === 1);
    expect(w.store.getStep(stepId)!.status).toBe('running'); // 任务卡正在往终端送

    await w.engine.forceClose(wf.id, '不做了', 'web'); // 派发还挂着，中止照样立刻返回
    expect(w.store.getStep(stepId)!.status).toBe('cancelled');

    g.release(0); // 放行派发：任务卡这时才真正送到
    await waitDispatchReturned(w, stepId);
    await flush();

    const types = stepEventTypes(w, stepId);
    expect(types).not.toContain('step_dispatched'); // 已取消的步不记「已派发」
    const cancelledAt = types.indexOf('step_cancelled');
    const landedAt = types.indexOf('step_dispatched_after_cancel');
    expect(cancelledAt).toBeGreaterThanOrEqual(0);
    expect(landedAt).toBeGreaterThan(cancelledAt); // 留痕排在取消之后，次序自洽
    const landed = w.store.entityEvents('step', stepId, 'step_dispatched_after_cancel')[0]!;
    expect(landed.payload['session']).toBe('juli-reply');
    expect(landed.payload['status']).toBe('cancelled');
    expect(landed.payload['interrupt']).toBe('sent');
    expect(interrupts).toEqual(['juli-reply']); // 用现成的打断能力让 agent 停下来
    expect(stepEventTypes(w, stepId)).toContain('agent_interrupted');
    // 取消时的标记原样保留，没有被派发收尾覆盖。
    const step = w.store.getStep(stepId)!;
    expect(step.status).toBe('cancelled');
    expect(step.output['cancel_note']).toBe('不做了');
    expect(w.store.getWorkflow(wf.id)!.status).toBe('cancelled');
  });

  it('不续心跳：被中止那张单晚到的派发，不掩盖同会话下一张单的卡死', async () => {
    const g = gatedDispatch();
    const w = makeEngine({ routing, availableSessions: ['juli-reply'], dispatch: g.port });
    const w1 = await w.engine.startTask('被中止的单', { brief: 'w1 独特标记' });
    const step1 = w.store.stepsForWorkflow(w1.id)[0]!.id;
    await until(() => g.calls.length === 1);
    await w.engine.forceClose(w1.id, '不做了', 'web');
    // 中止放出的队位立刻被下一张单接走：同会话，正常派发（此刻给会话续了心跳）。
    const w2 = await w.engine.startTask('下一张单', { brief: 'w2 独特标记', session: 'juli-reply' });
    const step2 = w.store.stepsForWorkflow(w2.id)[0]!.id;
    await until(() => g.calls.length === 2);
    g.release(1);
    await until(() => w.store.entityEvents('step', step2, 'step_dispatched').length === 1);

    w.advanceClock(60_000);
    g.release(0); // 一分钟后，被中止那张单的派发才返回
    await waitDispatchReturned(w, step1);
    await flush();
    w.advanceClock(4.5 * 60_000); // 离下一张单的心跳已 5.5 分钟；离晚到的「心跳」只有 4.5 分钟

    await w.engine.sweepZombies(); // 首扫：设指纹基线
    await w.engine.sweepZombies(); // 次扫：下一张单静默超时，该判卡死
    expect(w.store.getStep(step2)!.input['zombie_attempts']).toBe(1);
  });

  it('会话已经被别的步占用时不打断（不碰别的单正在用的终端）', async () => {
    const interrupts: string[] = [];
    const g = gatedDispatch();
    const w = makeEngine({
      routing, availableSessions: ['juli-reply'], dispatch: g.port,
      interruptSession: async (session) => { interrupts.push(session); return true; },
    });
    const w1 = await w.engine.startTask('被中止的单', { brief: 'w1 独特标记' });
    const step1 = w.store.stepsForWorkflow(w1.id)[0]!.id;
    await until(() => g.calls.length === 1);
    await w.engine.forceClose(w1.id, '不做了', 'web');
    const w2 = await w.engine.startTask('下一张单', { brief: 'w2 独特标记', session: 'juli-reply' });
    await until(() => g.calls.length === 2);
    g.release(1); // 下一张单先派完，占住会话
    await until(() => w.store.entityEvents('step', w.store.stepsForWorkflow(w2.id)[0]!.id, 'step_dispatched').length === 1);
    g.release(0); // 被中止那张单的派发才返回
    await until(() => w.store.entityEvents('step', step1, 'step_dispatched_after_cancel').length === 1);
    await flush();
    expect(stepEventTypes(w, step1)).not.toContain('step_dispatched');
    const landed = w.store.entityEvents('step', step1, 'step_dispatched_after_cancel')[0]!;
    expect(landed.payload['interrupt']).toBe('skipped_session_in_use');
    expect(interrupts).toEqual([]);
  });

  it('路由判定途中中止：任务卡不再发出，步骤不会被盖回 running', async () => {
    const seen: { session: string; text: string }[] = [];
    let finishRoute: (() => void) | null = null;
    const w = makeEngine({
      routing, availableSessions: ['juli-reply'],
      taskRoute: () => new Promise<null>((resolve) => { finishRoute = () => resolve(null); }),
      dispatch: {
        async dispatch(_source, session, text) {
          seen.push({ session, text });
          return ok(undefined);
        },
      },
    });
    const wf = await w.engine.startTask('判定途中被中止', { brief: 'x' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await until(() => finishRoute !== null);
    expect(w.store.getStep(stepId)!.status).toBe('pending'); // 判定还没回来，任务卡还没发

    await w.engine.forceClose(wf.id, '不做了', 'web');
    finishRoute!();
    await flush();

    expect(seen).toEqual([]); // 任务卡没发出
    expect(w.store.getStep(stepId)!.status).toBe('cancelled');
    expect(w.store.getWorkflow(wf.id)!.status).toBe('cancelled');
  });

  it('路由判定途中中止，且默认会话正忙：单子不会被全忙兜底复活成 queued', async () => {
    const seen: { session: string; text: string }[] = [];
    let finishRoute: (() => void) | null = null;
    const w = makeEngine({
      queueConcurrency: 2,
      routing, availableSessions: ['juli-reply'],
      taskRoute: () => new Promise<null>((resolve) => { finishRoute = () => resolve(null); }),
      dispatch: {
        async dispatch(_source, session, text) {
          seen.push({ session, text });
          return ok(undefined);
        },
      },
    });
    // 默认会话先被一张在跑的单占住——受害单判定回来时会撞上「全忙兜底」。
    const busy = await w.engine.startTask('占位', { brief: 'busy 独特标记', session: 'juli-reply' });
    await until(() => w.store.entityEvents('step', w.store.stepsForWorkflow(busy.id)[0]!.id, 'step_dispatched').length === 1);
    const wf = await w.engine.startTask('判定途中被中止且会话忙', { brief: 'x' }); // 不带会话：派发时要等判定
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await until(() => finishRoute !== null);

    await w.engine.forceClose(wf.id, '不做了', 'web');
    finishRoute!();
    await flush();

    expect(w.store.getWorkflow(wf.id)!.status).toBe('cancelled'); // 没被置回 queued
    expect(w.store.getStep(stepId)!.status).toBe('cancelled');
    expect(stepEventTypes(w, stepId)).not.toContain('route_busy_wait');
    expect(seen.filter((s) => s.text.includes('busy 独特标记'))).toHaveLength(1); // 只有占位单那一次派发
    expect(seen).toHaveLength(1);
  });

  it('派发失败后才返回、单已中止：步骤保持 cancelled，不落 step_failed', async () => {
    const interrupts: string[] = [];
    const g = gatedDispatch();
    const w = makeEngine({
      routing, availableSessions: ['juli-reply'], dispatch: g.port,
      interruptSession: async (session) => { interrupts.push(session); return true; },
    });
    const wf = await w.engine.startTask('派发失败前被中止', { brief: 'x' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await until(() => g.calls.length === 1);
    await w.engine.forceClose(wf.id, '不做了', 'web');
    g.release(0, err(new Error('tmux: paste 落地失败')));
    await flush();

    const types = stepEventTypes(w, stepId);
    expect(types).not.toContain('step_failed');
    expect(types).not.toContain('step_dispatched_after_cancel'); // 任务卡没送到，不算「落在已取消的步上」
    expect(w.store.getStep(stepId)!.status).toBe('cancelled');
    expect(w.store.getStep(stepId)!.output['cancel_note']).toBe('不做了');
    expect(interrupts).toEqual([]);
  });

  it('任务卡送到之后才中止（取消在跑的步）：行为不变——不打断 agent', async () => {
    const interrupts: string[] = [];
    const w = makeEngine({
      routing, availableSessions: ['juli-reply'],
      interruptSession: async (session) => { interrupts.push(session); return true; },
    });
    const wf = await w.engine.startTask('在跑时被中止', { brief: 'x' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await until(() => w.store.entityEvents('step', stepId, 'step_dispatched').length === 1);
    await w.engine.forceClose(wf.id, '不做了', 'web');

    const types = stepEventTypes(w, stepId);
    expect(types.indexOf('step_dispatched')).toBeLessThan(types.indexOf('step_cancelled'));
    expect(types).not.toContain('step_dispatched_after_cancel');
    expect(interrupts).toEqual([]);
  });
});
