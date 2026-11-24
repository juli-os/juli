// 被中止那张单的 Stop 回调，结算到了同会话下一张单头上（2026-11-23 全量审查）。
//
// 事故链：A 的任务卡送到会话 S → 人中止 A（步骤 cancelled，队位立刻放掉）→
// 队列把 B 派进同一个会话 S（B 的步 running，在等它自己的 Stop）→ A 的 agent
// 这时才干完，Stop 回调带着 A 的产出到了。onAgentStopped 用
// runningAgentStepForSession(S) 按「会话名」找在途步，找到的是 B。
//
// 修法（2026-11-24）：派发成功后在步骤 output 里留凭据 dispatched_prompt_id，
// 收工回调结算前核对——步骤上有凭据，并且它就是会话上最新的 submitted
// prompt，才结算（实现见 agentSettle.ts / steps.ts；边界用例见
// test/stop-settle-credential.test.ts）。
//
// 这里有两种时序，结果不同：
//   ① A 的 Stop 在 B 的卡确认送达【之前】到（B 还在等会话就绪）：B 没有凭据，
//      拦下。方案覆盖。
//   ② B 的卡已经送达（含软失败入队）【之后】A 的 Stop 才到：B 有凭据、且就是
//      会话上最新的 submitted prompt，核对通过，A 的 Stop 照样结算到 B 头上。
//      方案没覆盖——凭据只回答「B 的卡送到了没有」，回答不了「这个收工回调
//      是在回答哪张卡」。这条用 it.fails 钉住，等修法定了再去掉。

import { describe, expect, it } from 'vitest';
import { asString } from '../src/platform/shared/json.ts';
import { makeEngine, until, type MockWorld } from './helpers.ts';
import { ok, type Result } from '../src/platform/shared/result.ts';

const routing = { defaultSession: 'juli-reply', defaultProject: 'p' };

/** 让已经排上的 promise 链跑完（结算后的续推、开闸都在微任务里）。 */
const flush = async (ms = 30): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

const hasStepEvent = (w: MockWorld, stepId: string, type: string): boolean =>
  w.store.entityEvents('step', stepId, type).length > 0;

const stepOutput = (w: MockWorld, stepId: string): string =>
  asString(w.store.getStep(stepId)!.output['output']);

/** 可控的假派发器：每次调用都挂住，等测试按次序放行。 */
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
    release: (index: number): void => { gates[index]?.(ok(undefined)); },
  };
};

describe('被中止那张单的 Stop 回调，会不会结算到同会话下一张单头上', () => {
  it('时序① A 的 Stop 在 B 的卡送达之前到：拦下并留痕，B 之后照常结算自己的产出', async () => {
    const g = gatedDispatch();
    // 并发 1（产线缺省）：A 占着队位，B 排队等。
    const w = makeEngine({ routing, availableSessions: ['juli-reply'], dispatch: g.port });

    // 1. A 派发成功，步骤 running，任务卡已送到 juli-reply。
    const a = await w.engine.startTask('A 单', { brief: 'A 的卡独特标记' });
    const stepA = w.store.stepsForWorkflow(a.id)[0]!.id;
    await until(() => g.calls.length === 1);
    g.release(0);
    await until(() => hasStepEvent(w, stepA, 'step_dispatched'));

    // B 排在队里；给它挂一道闸门，用来看 B 的下游有没有被推进。
    const b = await w.engine.startTask('B 单', { brief: 'B 的卡独特标记' });
    const stepB = w.store.stepsForWorkflow(b.id)[0]!.id;
    expect(w.engine.queueStatus().waiting).toEqual([b.id]);
    const gateB = (await w.engine.appendNode(b.id, { kind: 'gate', title: '确认闸门', input: { delivery: 'apply' } })).id;

    // 2. 中止 A：A 的步骤置 cancelled，队位立刻放掉。
    await w.engine.forceClose(a.id, '不做了', 'web');
    expect(w.store.getStep(stepA)!.status).toBe('cancelled');

    // 3. 队列把 B 派进同一个会话。B 的步骤 running，但卡还在往终端送，没确认送达。
    await until(() => g.calls.length === 2);
    expect(g.calls[1]!.session).toBe('juli-reply');
    expect(w.store.getStep(stepB)!.status).toBe('running');
    expect(hasStepEvent(w, stepB, 'step_dispatched')).toBe(false);

    // 4. A 的 agent 这时才干完，Stop 回调到了（带的是 A 的产出）。
    //    不直接 await：万一回归成「去结算 B」，结算要拿 B 的锁，而锁正被 B 那次
    //    挂着的派发占着，直接 await 会卡到超时。放行之后再等它，回归照样能抓到。
    const stopOfA = w.engine.onAgentStopped('juli-reply', 'done', '这是 A 的产出');
    await flush();

    // 5. B 没被动过；收工回调被拦下，留了事件。
    expect(w.store.getStep(stepB)!.status).toBe('running');
    expect(stepOutput(w, stepB)).toBe('');
    expect(w.store.getStep(gateB)!.status).toBe('pending');
    const ignored = w.store.entityEvents('step', stepB, 'stop_ignored_card_not_delivered');
    expect(ignored).toHaveLength(1);
    expect(ignored[0]!.payload['session']).toBe('juli-reply');
    expect(w.store.getStep(stepA)!.status).toBe('cancelled'); // A 自己也没被结算
    expect(hasStepEvent(w, stepA, 'step_completed')).toBe(false);

    // 6. B 的卡送达，它自己的收工回调照常结算，闸门拿到的是 B 的产出。
    g.release(1);
    await until(() => hasStepEvent(w, stepB, 'step_dispatched'));
    await stopOfA;
    expect(w.store.getStep(stepB)!.status).toBe('running'); // A 的收工回调确实没结算 B
    expect(stepOutput(w, stepB)).toBe('');
    await w.engine.onAgentStopped('juli-reply', 'done', '这是 B 的产出');
    await flush();
    expect(w.store.getStep(stepB)!.status).toBe('completed');
    expect(stepOutput(w, stepB)).toBe('这是 B 的产出');
    expect(w.store.getStep(gateB)!.status).toBe('waiting_human');
    expect(asString(w.store.getStep(gateB)!.input['draft'])).toBe('这是 B 的产出');
  });

  it.fails('时序②【方案未覆盖】B 的卡已送达之后 A 的 Stop 才到：B 仍被结算成 completed，记的是 A 的产出', async () => {
    // 并发 1（产线缺省）：A 占着队位，B 排队等。
    const w = makeEngine({ routing, availableSessions: ['juli-reply'] });

    // 1. A 派发成功，步骤 running，任务卡已送到 juli-reply。
    const a = await w.engine.startTask('A 单', { brief: 'A 的卡独特标记' });
    const stepA = w.store.stepsForWorkflow(a.id)[0]!.id;
    await until(() => hasStepEvent(w, stepA, 'step_dispatched'));
    expect(w.dispatched.some((d) => d.session === 'juli-reply' && d.text.includes('A 的卡独特标记'))).toBe(true);

    // B 排在队里；给它挂一道闸门，用来看 B 的下游有没有被推进。
    const b = await w.engine.startTask('B 单', { brief: 'B 的卡独特标记' });
    const stepB = w.store.stepsForWorkflow(b.id)[0]!.id;
    expect(w.engine.queueStatus().waiting).toEqual([b.id]);
    const gateB = (await w.engine.appendNode(b.id, { kind: 'gate', title: '确认闸门', input: { delivery: 'apply' } })).id;

    // 2. 中止 A：A 的步骤置 cancelled，队位立刻放掉。
    await w.engine.forceClose(a.id, '不做了', 'web');
    expect(w.store.getStep(stepA)!.status).toBe('cancelled');

    // 3. 队列把 B 派进同一个会话，B 的卡已确认送达（假派发器立刻返回成功）。
    await until(() => hasStepEvent(w, stepB, 'step_dispatched'));
    expect(w.dispatched.some((d) => d.session === 'juli-reply' && d.text.includes('B 的卡独特标记'))).toBe(true);
    expect(w.store.getStep(stepB)!.status).toBe('running');

    // 4. A 的 agent 这时才干完，Stop 回调到了（带的是 A 的产出）。
    await w.engine.onAgentStopped('juli-reply', 'done', '这是 A 的产出');
    await flush();

    // 5. 正确的行为：B 没被动过，A 的 Stop 被当成没有对应的在途步骤，并留痕。
    expect(w.store.getStep(stepB)!.status).toBe('running');
    expect(stepOutput(w, stepB)).toBe('');
    expect(hasStepEvent(w, stepB, 'step_completed')).toBe(false);
    expect(w.store.getStep(gateB)!.status).toBe('pending');
    expect(asString(w.store.getStep(gateB)!.input['draft'])).toBe('');
    expect(w.store.getStep(stepA)!.status).toBe('cancelled');
    expect(hasStepEvent(w, stepA, 'step_completed')).toBe(false);
    expect(w.store.entityEvents('step', stepB, 'stop_ignored_card_not_delivered')).toHaveLength(1);
  });

  it('对照：会话上没有别的在途步时，被中止那张单的 Stop 被当成无主回合忽略', async () => {
    const w = makeEngine({ routing, availableSessions: ['juli-reply'] });
    const a = await w.engine.startTask('A 单', { brief: 'A 的卡独特标记' });
    const stepA = w.store.stepsForWorkflow(a.id)[0]!.id;
    await until(() => hasStepEvent(w, stepA, 'step_dispatched'));
    await w.engine.forceClose(a.id, '不做了', 'web');

    await w.engine.onAgentStopped('juli-reply', 'done', '这是 A 的产出');
    await flush();

    // 没有别的单在这个会话上：按会话名找不到在途步，这一下什么都不结算。
    expect(w.store.getStep(stepA)!.status).toBe('cancelled');
    expect(hasStepEvent(w, stepA, 'step_completed')).toBe(false);
    expect(stepOutput(w, stepA)).toBe('');
  });
});
