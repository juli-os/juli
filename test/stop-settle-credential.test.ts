// 收工回调只结算「任务卡已经交出去了」的那一步（2026-11-23 全量审查；
// 2026-11-24 两轮复审定稿）。
//
// 背景：步骤一被标成 running，runningAgentStepForSession 就把它当成「在这个
// 会话上在跑的步」，可它的任务卡可能还没交出去。
//
// 现在的做法：
//   · 凭据 = 这一步本次派发尝试的卡已经交出去了。每次派发前先清空；派发成功或
//     提交未确认（软失败）之后写 dispatched_prompt_id 和 dispatched_at。
//   · 按会话名找到在途步（最近更新的那一步）：凭据非空就结算它（既有行为）；
//     凭据为空说明它的卡还没交出去，这个回调不是在回答它——同会话里有更早
//     交出去、还在等收工的卡就结算那一张，没有就不结算。
//
// 已知没修的（收工回调不带「我在回答哪张卡」的信息，只能按会话名猜）：同会话
// 两张卡都交出去了、前一张的收工回调先到，产出会记到后一张头上（下面 it.fails
// 钉住）；卡排进忙会话、软失败之后别的回合的收工回调把它结算掉
// （test/stop-hook-misattribution.test.ts 钉住）。要分清楚得让任务卡自带标记，
// 另案。

import { describe, expect, it } from 'vitest';
import { asString } from '../src/platform/shared/json.ts';
import { makeEngine, until, type MockWorld } from './helpers.ts';
import { ok, type Result } from '../src/platform/shared/result.ts';

const routing = { defaultSession: 'juli-reply', defaultProject: 'p' };

/** 等某步第 n 次 step_dispatched 落账。 */
const waitDispatched = async (w: MockWorld, stepId: string, n = 1): Promise<void> => {
  await until(() => w.store.entityEvents('step', stepId, 'step_dispatched').length >= n);
};

/** 步骤上的凭据：'' = 没有（还没交出去，或者已经清空）。 */
const cardOf = (w: MockWorld, stepId: string): string =>
  asString(w.store.getStep(stepId)!.output['dispatched_prompt_id']);

const handedAt = (w: MockWorld, stepId: string): string =>
  asString(w.store.getStep(stepId)!.output['dispatched_at']);

const outputOf = (w: MockWorld, stepId: string): string =>
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

describe('凭据：卡交出去了才写，重新派发先清空', () => {
  it('任务卡确认送达 → 步骤 output 里记下这张卡的 prompt id 和交出去的时刻', async () => {
    const w = makeEngine({ routing });
    const wf = await w.engine.startTask('凭据单', { brief: 'x' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await waitDispatched(w, stepId);
    expect(cardOf(w, stepId)).toBe(w.store.latestPromptForSession('juli-reply', ['submitted'])!.id);
    expect(handedAt(w, stepId)).not.toBe('');
  });

  it('硬失败（卡没交出去）→ 不写凭据', async () => {
    const w = makeEngine({
      routing,
      dispatch: { async dispatch() { return { ok: false as const, error: new Error('tmux: paste 落地失败') }; } },
    });
    const wf = await w.engine.startTask('硬失败单', { brief: 'x' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await until(() => w.store.getStep(stepId)!.status === 'failed');
    expect(cardOf(w, stepId)).toBe('');
    expect(handedAt(w, stepId)).toBe('');
  });

  it('后面的写入不会冲掉凭据（output 是合并写）', async () => {
    const w = makeEngine({ routing });
    const wf = await w.engine.startTask('合并写单', { brief: 'x' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await waitDispatched(w, stepId);
    const card = cardOf(w, stepId);
    w.store.setStepOutput(stepId, { error: null });
    w.store.setStepOutput(stepId, { note: '别的写入' });
    expect(cardOf(w, stepId)).toBe(card);
  });
});

describe('同一会话里排着两张卡（复审 P1-①：收工回调不能再误拦）', () => {
  // 线上并发是 10，并且有绑定会话（如 project-a）——绑定会话不改道，
  // 同一个会话里排两张卡是真实场景。这里用绑定会话把两张卡放进同一个终端。
  const boundRouting = {
    defaultSession: 'juli-reply', defaultProject: 'p',
    boundAgents: [{ session: 'project-a', cwd: '/w', senders: ['alisa@x.cn'] }],
  };
  const SESSION = 'project-a';

  /** 造一张派进绑定会话的单。 */
  const mkTask = (w: MockWorld, name: string) => {
    const wf = w.store.createWorkflow({
      kind: 'adhoc', title: `会计单 ${name}`, status: 'running',
      meta: { mode: 'nodes', session_bound: SESSION },
    });
    const st = w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'agent', title: '理解与接单',
      input: { plan: `${name} 的卡独特标记`, session: SESSION },
    });
    return { wfId: wf.id, stepId: st.id };
  };

  const setup = async () => {
    const g = gatedDispatch();
    const w = makeEngine({ routing: boundRouting, dispatch: g.port });
    const a = mkTask(w, 'A');
    void w.engine.advance(a.wfId);
    await until(() => g.calls.length === 1);
    g.release(0); // A 的卡交出去了
    await waitDispatched(w, a.stepId);
    w.advanceClock(1000); // 两张卡不是同一秒交出去的，dispatched_at 能分先后
    const b = mkTask(w, 'B');
    void w.engine.advance(b.wfId); // B 的卡在往终端送，还没返回
    await until(() => g.calls.length === 2);
    return { w, g, a, b };
  };

  it('B 还没确认送达：A 的收工回调结算 A，产出是 A 的；之后 B 的收工回调结算 B', async () => {
    const { w, g, a, b } = await setup();
    expect(w.store.getStep(b.stepId)!.status).toBe('running');
    expect(cardOf(w, b.stepId)).toBe(''); // B 的卡还没交出去

    await w.engine.onAgentStopped(SESSION, 'done', 'A 的产出');
    // 结算的是 A，不是按会话名最先找到的 B。
    expect(w.store.getStep(a.stepId)!.status).toBe('completed');
    expect(outputOf(w, a.stepId)).toBe('A 的产出');
    expect(w.store.getStep(b.stepId)!.status).toBe('running');
    expect(outputOf(w, b.stepId)).toBe('');
    // A 没有被拦下；多留了一条事件，写明结算了哪一步、为什么。
    expect(w.store.entityEvents('step', a.stepId, 'stop_ignored_card_not_delivered')).toHaveLength(0);
    expect(w.store.entityEvents('step', b.stepId, 'stop_ignored_card_not_delivered')).toHaveLength(0);
    const byOrder = w.store.entityEvents('step', a.stepId, 'stop_settled_earliest_card');
    expect(byOrder).toHaveLength(1);
    expect(byOrder[0]!.payload['settled_step']).toBe(a.stepId);
    expect(byOrder[0]!.payload['found_step']).toBe(b.stepId);
    expect(String(byOrder[0]!.payload['reason'])).toContain('凭据为空');

    g.release(1); // B 的卡交出去了
    await waitDispatched(w, b.stepId);
    await w.engine.onAgentStopped(SESSION, 'done', 'B 的产出');
    expect(w.store.getStep(b.stepId)!.status).toBe('completed');
    expect(outputOf(w, b.stepId)).toBe('B 的产出');
    expect(outputOf(w, a.stepId)).toBe('A 的产出'); // 第二次收工回调没动 A
  });

  it.fails('【已知未修】B 已确认送达后 A 的收工回调先到：各记各的产出', async () => {
    // 现在的结果是产出记到后一张卡头上（见下一条用例）。回调不带「我在回答
    // 哪张卡」的信息，按会话名只能找到最近更新的那一步。任务卡自带标记之后
    // 这一条应该变绿。
    const { w, g, a, b } = await setup();
    g.release(1);
    await waitDispatched(w, b.stepId);
    expect(handedAt(w, a.stepId) < handedAt(w, b.stepId)).toBe(true); // A 先交出去

    await w.engine.onAgentStopped(SESSION, 'done', 'A 的产出');
    expect(w.store.getStep(a.stepId)!.status).toBe('completed');
    expect(outputOf(w, a.stepId)).toBe('A 的产出');
    expect(w.store.getStep(b.stepId)!.status).toBe('running');
    expect(outputOf(w, b.stepId)).toBe('');

    await w.engine.onAgentStopped(SESSION, 'done', 'B 的产出');
    expect(w.store.getStep(b.stepId)!.status).toBe('completed');
    expect(outputOf(w, b.stepId)).toBe('B 的产出');
    expect(outputOf(w, a.stepId)).toBe('A 的产出');
  });

  it('B 已确认送达后 A 的收工回调先到（产出会记错，见上一条）：两张卡最后都结算了，没有人卡死', async () => {
    const { w, g, a, b } = await setup();
    g.release(1);
    await waitDispatched(w, b.stepId);

    await w.engine.onAgentStopped(SESSION, 'done', 'A 的产出');
    await w.engine.onAgentStopped(SESSION, 'done', 'B 的产出');
    expect(w.store.getStep(a.stepId)!.status).toBe('completed');
    expect(w.store.getStep(b.stepId)!.status).toBe('completed');
    expect([outputOf(w, a.stepId), outputOf(w, b.stepId)].sort()).toEqual(['A 的产出', 'B 的产出']);
  });

  it('A 的回合被人打断（没有收工回调），或者 A 的卡其实丢了：B 干完后结算的是 B，产出是 B 的，A 不被连累', async () => {
    // R2 复审 P1-B：「一律结算最早的那张」在这种情形下会把 B 的产出记到 A 头上。
    const { w, g, a, b } = await setup();
    g.release(1);
    await waitDispatched(w, b.stepId);

    // A 的收工回调永远不会来。B 的收工回调到了。
    await w.engine.onAgentStopped(SESSION, 'done', 'B 的产出');
    expect(w.store.getStep(b.stepId)!.status).toBe('completed');
    expect(outputOf(w, b.stepId)).toBe('B 的产出');
    expect(w.store.getStep(a.stepId)!.status).toBe('running'); // 留给看门狗
    expect(outputOf(w, a.stepId)).toBe('');
  });

  it('重启对账不改写已有的凭据：A 的凭据还是 A 的卡号', async () => {
    const { w, g, a, b } = await setup();
    g.release(1);
    await waitDispatched(w, b.stepId);
    const cardA = cardOf(w, a.stepId);
    const cardB = cardOf(w, b.stepId);
    expect(cardA).not.toBe(cardB);
    // 会话上最新的 submitted prompt 是 B 的卡——重启对账不能拿它覆盖 A 的凭据。
    expect(w.store.latestPromptForSession(SESSION, ['submitted'])!.id).toBe(cardB);

    await w.engine.reconcileStartup();
    expect(cardOf(w, a.stepId)).toBe(cardA);
    expect(cardOf(w, b.stepId)).toBe(cardB);
    expect(w.store.getStep(a.stepId)!.status).toBe('running');
    expect(w.store.getStep(b.stepId)!.status).toBe('running');
  });
});

describe('结算前选步：必须守住的边界', () => {
  it('提交未确认（软失败）：卡可能已被消费，收工回调照常能结算', async () => {
    const w = makeEngine({
      routing,
      dispatch: {
        async dispatch() {
          return { ok: false as const, error: new Error('submit_unconfirmed: prompt 已入框但连续补 Enter 未被消费——任务未确认提交') };
        },
      },
    });
    const wf = await w.engine.startTask('软失败单', { brief: 'x' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await until(() => w.store.entityEvents('step', stepId, 'submit_unverified').length === 1);
    expect(w.store.getStep(stepId)!.status).toBe('running');
    expect(cardOf(w, stepId)).toBe(w.store.latestPromptForSession('juli-reply', ['submitted'])!.id);
    expect(handedAt(w, stepId)).not.toBe('');

    await w.engine.onAgentStopped('juli-reply', 'done', '软失败那张卡的产出');
    expect(w.store.getStep(stepId)!.status).toBe('completed');
    expect(outputOf(w, stepId)).toBe('软失败那张卡的产出');
  });

  it('同一张单先后两个 agent 步骤：两步都正常结算，各记各的产出', async () => {
    const w = makeEngine({ routing });
    const wf = await w.engine.startTask('两步单', { brief: 'x' });
    const step1 = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await waitDispatched(w, step1);
    const step2 = (await w.engine.appendNode(wf.id, { kind: 'agent', title: '第二步', input: { plan: '第二步独特标记' } })).id;

    await w.engine.onAgentStopped('juli-reply', 'done', '第一步的产出');
    expect(w.store.getStep(step1)!.status).toBe('completed');
    expect(outputOf(w, step1)).toBe('第一步的产出');
    await waitDispatched(w, step2);
    expect(cardOf(w, step2)).not.toBe(cardOf(w, step1)); // 第二张卡是新的 prompt

    await w.engine.onAgentStopped('juli-reply', 'done', '第二步的产出');
    expect(w.store.getStep(step2)!.status).toBe('completed');
    expect(outputOf(w, step2)).toBe('第二步的产出');
    expect(outputOf(w, step1)).toBe('第一步的产出'); // 第一步没被第二次收工回调改动
  });

  it('重试重新派发时凭据被清空；派发途中来的旧收工回调不结算这一步', async () => {
    const warns: string[] = [];
    const g = gatedDispatch();
    const w = makeEngine({
      routing,
      dispatch: g.port,
      log: { info: () => {}, warn: (m) => { warns.push(m); }, error: () => {} },
    });
    const wf = await w.engine.startTask('重试单', { brief: 'x' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await until(() => g.calls.length === 1);
    g.release(0); // 第一张卡交出去了
    await waitDispatched(w, stepId);
    const firstCard = cardOf(w, stepId);
    expect(firstCard).not.toBe('');

    // 这一步失败，人重试：重新派发，第二张卡卡在派发里，还没交出去。
    w.store.setStepStatus(stepId, 'failed');
    await w.engine.retry(stepId, undefined, 'web');
    await until(() => g.calls.length === 2);
    expect(cardOf(w, stepId)).toBe(''); // 上一张卡的凭据清空了
    expect(handedAt(w, stepId)).toBe('');
    const newCard = w.store.latestPromptForSession('juli-reply', ['submitted'])!.id;
    expect(newCard).not.toBe(firstCard);

    // 旧卡的收工回调这时到了：不该结算。不直接 await（回归成「去结算」时要等
    // 这把被派发占着的锁，直接 await 会卡到超时）。
    const staleStop = w.engine.onAgentStopped('juli-reply', 'done', '旧卡的产出');
    await new Promise((r) => setTimeout(r, 30));
    const mid = w.store.getStep(stepId)!;
    expect(mid.status).toBe('running');
    expect(asString(mid.output['output'])).toBe('');
    const ignored = w.store.entityEvents('step', stepId, 'stop_ignored_card_not_delivered');
    expect(ignored).toHaveLength(1);
    expect(ignored[0]!.payload['session']).toBe('juli-reply');
    expect(ignored[0]!.payload['step_prompt_id']).toBe(''); // 步骤上没有凭据
    expect(warns.some((m) => m.includes(stepId) && m.includes('juli-reply'))).toBe(true); // 不悄悄吞掉

    // 新卡交出去，它自己的收工回调照常结算。
    g.release(1);
    await waitDispatched(w, stepId, 2);
    await staleStop;
    expect(asString(w.store.getStep(stepId)!.output['output'])).toBe(''); // 旧卡的收工回调确实没结算
    expect(cardOf(w, stepId)).toBe(newCard);
    expect(handedAt(w, stepId)).not.toBe('');
    await w.engine.onAgentStopped('juli-reply', 'done', '新卡的产出');
    const done = w.store.getStep(stepId)!;
    expect(done.status).toBe('completed');
    expect(asString(done.output['output'])).toBe('新卡的产出');
  });

  it('升级前的在途步（有 submitted 的 prompt、没有凭据）：重启对账补上凭据，收工回调照常结算', async () => {
    const w = makeEngine({ routing });
    const wf = await w.engine.startTask('升级前派出的单', { brief: 'x' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await waitDispatched(w, stepId);
    const card = w.store.latestPromptForSession('juli-reply', ['submitted'])!.id;
    w.store.setStepOutput(stepId, { dispatched_prompt_id: null, dispatched_at: null }); // 模拟升级前派出的步：没有凭据
    expect(cardOf(w, stepId)).toBe('');

    await w.engine.reconcileStartup(); // 重启对账：agent 活过了重启，顺手补凭据
    expect(w.store.getStep(stepId)!.status).toBe('running');
    expect(cardOf(w, stepId)).toBe(card);

    await w.engine.onAgentStopped('juli-reply', 'done', '重启后 agent 的产出');
    expect(w.store.getStep(stepId)!.status).toBe('completed');
    expect(outputOf(w, stepId)).toBe('重启后 agent 的产出');
  });
});
