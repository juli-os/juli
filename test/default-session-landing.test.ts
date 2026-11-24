// 默认会话落点记在步骤上（2026-11-23 全量审查）。
// 事故形态：步骤没写明会话时，runAgentStep 把会话兜底成默认会话，但只把落点
// 写到 workflow.session，没写到步骤 input.resolved_session。下游三处都按
// agentLiveSessionOf(st) 读步骤，读不到就当「这步没有会话」：
//   · 重启对账（reconcile.ts）直接判失败 restart: no in-flight prompt，agent 其实还在干活；
//   · 卡死巡检（zombie.ts）跳过这类步；
//   · 插话（human.ts）报 step has no session to intervene。
// 现网 452 个 agent 步里 147 个属于这类。

import { describe, expect, it } from 'vitest';
import { makeEngine, until, type MockWorld } from './helpers.ts';
import { ok } from '../src/platform/shared/result.ts';

const routing = { defaultSession: 'juli-reply', defaultProject: 'p' };

/** 等某步的 step_dispatched 事件落账。步先转 running、后登记 prompt、再派发，
 * step_dispatched 在派发返回之后才记——等它比等「步 running」稳。 */
const waitDispatched = async (w: MockWorld, stepId: string): Promise<void> => {
  await until(() => w.store.entityEvents('step', stepId, 'step_dispatched').length > 0);
};

  /** 首派必败、之后成功的假派发器：用来造一张「派出过一次、后来失败」的单。
   * seen 记每次派发的会话与任务卡（引擎自带的 w.dispatched 只认它自己的假派发器）。 */
const flakyDispatch = () => {
  const seen: { session: string; text: string }[] = [];
  let failFirst = true;
  return {
    seen,
    port: {
      async dispatch(_source: string, session: string, text: string) {
        seen.push({ session, text });
        if (failFirst) {
          failFirst = false;
          return { ok: false as const, error: new Error('boom') };
        }
        return ok(undefined);
      },
    },
  };
};

describe('默认会话落点记在步骤上（resolved_session）', () => {
  it('不带会话的任务派到默认会话：步骤 input.resolved_session = 默认会话', async () => {
    const w = makeEngine({ routing, availableSessions: ['juli-reply'] });
    const wf = await w.engine.startTask('裸起单', { brief: '裸起单独特标记' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await waitDispatched(w, stepId);
    expect(w.dispatched[0]!.session).toBe('juli-reply');
    expect(w.store.getStep(stepId)!.input['resolved_session']).toBe('juli-reply');
    expect(w.store.getStep(stepId)!.input['resolved_by_default']).toBe(true); // 纯兜底：带标记
  });

  it('步骤自己写明了会话时不多写 resolved_session（既有分支行为不变）', async () => {
    const w = makeEngine({ routing, availableSessions: ['juli-reply', 'agent-a'] });
    const wf = await w.engine.startTask('点名单', { brief: 'x', session: 'agent-a' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await waitDispatched(w, stepId);
    const input = w.store.getStep(stepId)!.input;
    expect(input['session']).toBe('agent-a');
    expect(input['resolved_session']).toBeUndefined();
  });

  it('重启对账按默认会话查 prompt 账：账上有 submitted 就放行，不直接判失败', async () => {
    const w = makeEngine({ routing, availableSessions: ['juli-reply'] });
    const wf = await w.engine.startTask('重启幸存单', { brief: 'x' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await waitDispatched(w, stepId);
    // 派发时 write-ahead 已登记 submitted prompt——agent 活过了「重启」。
    expect(w.store.latestPromptForSession('juli-reply', ['submitted'])).not.toBeNull();
    await w.engine.reconcileStartup();
    const cur = w.store.getStep(stepId)!;
    expect(cur.status).toBe('running');
    expect(cur.output['error']).toBeUndefined();
  });

  it('重启对账确实去查了默认会话的 prompt 账：账上没有 submitted 照样判失败', async () => {
    const w = makeEngine({ routing, availableSessions: ['juli-reply'] });
    // 手摆一张「落在默认会话、在跑、但账上没有在途 prompt」的步。
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '无账在途单', status: 'running' });
    const st = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '执行' });
    w.store.setStepInput(st.id, { plan: '做单', resolved_session: 'juli-reply' });
    w.store.setStepStatus(st.id, 'running');
    expect(w.store.latestPromptForSession('juli-reply', ['submitted'])).toBeNull();
    await w.engine.reconcileStartup();
    const cur = w.store.getStep(st.id)!;
    expect(cur.status).toBe('failed');
    expect(cur.output['error']).toBe('restart: no in-flight prompt');
  });

  it('插话：派到默认会话的步不再报 step has no session to intervene', async () => {
    const relays: { session: string; text: string }[] = [];
    const w = makeEngine({
      routing, availableSessions: ['juli-reply'],
      sendToSession: async (session, text) => {
        relays.push({ session, text });
        return { delivered: true, reason: '' };
      },
    });
    const wf = await w.engine.startTask('插话单', { brief: 'x' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await waitDispatched(w, stepId);
    await w.engine.intervene(stepId, '补充：只改首页', 'web');
    expect(relays).toEqual([{ session: 'juli-reply', text: '补充：只改首页' }]);
  });

  it('卡死巡检盯上默认会话的步：静默超时后在默认会话上重派，落点不变', async () => {
    const w = makeEngine({ routing, availableSessions: ['juli-reply'] });
    const wf = await w.engine.startTask('静默单', { brief: '静默单独特标记' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await waitDispatched(w, stepId);
    w.advanceClock(6 * 60_000); // 超过 5 分钟静默阈值
    await w.engine.sweepZombies(); // 首扫：设指纹基线
    await w.engine.sweepZombies(); // 次扫：判静默 → 中断 → 重派
    await until(() => w.dispatched.filter((d) => d.text.includes('静默单独特标记')).length === 2, 500);
    expect(w.store.getStep(stepId)!.input['zombie_attempts']).toBe(1);
    const landings = w.dispatched.filter((d) => d.text.includes('静默单独特标记')).map((d) => d.session);
    expect(landings).toEqual(['juli-reply', 'juli-reply']); // 重派跟随落点，不换会话
  });
});

describe('默认兜底落点与重派', () => {
  it('已派出去过的步，重派跟随上次落点、不再重新判定（三无判定在首次派发问一次）', async () => {
    let routeAsks = 0;
    const flaky = flakyDispatch();
    const w = makeEngine({
      routing, availableSessions: ['juli-reply'],
      taskRoute: async () => { routeAsks++; return null; }, // 判不出落点 → 走默认
      dispatch: flaky.port,
    });
    const wf = await w.engine.startTask('三无单', { brief: 'x' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await until(() => w.store.getStep(stepId)!.status === 'failed');
    expect(routeAsks).toBe(1);
    await w.engine.retry(stepId, undefined, 'web');
    await waitDispatched(w, stepId);
    expect(flaky.seen.map((s) => s.session)).toEqual(['juli-reply', 'juli-reply']);
    expect(routeAsks).toBe(1);
  });

  it('人后来点名的会话盖过默认兜底落点：retry 带 session 补丁落到人点名的会话', async () => {
    const flaky = flakyDispatch();
    const w = makeEngine({
      routing, availableSessions: ['juli-reply', 'agent-b'],
      dispatch: flaky.port,
    });
    const wf = await w.engine.startTask('改派重试单', { brief: 'x' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await until(() => w.store.getStep(stepId)!.status === 'failed');
    expect(flaky.seen[0]!.session).toBe('juli-reply'); // 首派落默认会话，步骤上已记下落点
    await w.engine.retry(stepId, { session: 'agent-b' }, 'web');
    await waitDispatched(w, stepId);
    expect(flaky.seen[1]!.session).toBe('agent-b');
    // 人点名的会话就是这一步的声明会话：旧落点和默认兜底标记都撤掉（与改派同一套）。
    const input = w.store.getStep(stepId)!.input;
    expect(input['session']).toBe('agent-b');
    expect(input['resolved_session']).toBeNull();
    expect(input['resolved_by_default']).toBeNull();
    expect(input['session_pinned']).toBe(true);
  });

  it('派发点自己也认这条规矩：带默认兜底标记的步，后来出现声明会话时按声明走', async () => {
    // 直接摆步 input，不经 retry / amend（它们现在会顺手清掉旧落点）：模拟「只写了
    // input.session，旧落点和标记都还在」的步。
    const w = makeEngine({ routing, availableSessions: ['juli-reply', 'agent-b'] });
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '只改了声明会话', status: 'running', meta: { mode: 'nodes' } });
    const st = w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'agent', title: '执行',
      input: { plan: '只改了声明会话独特标记', resolved_session: 'juli-reply', resolved_by_default: true, session: 'agent-b' },
    });
    await w.engine.advance(wf.id);
    await waitDispatched(w, st.id);
    expect(w.dispatched[0]!.session).toBe('agent-b');
    const input = w.store.getStep(st.id)!.input;
    expect(input['resolved_session']).toBe('agent-b'); // 落点跟着人走
    expect(input['resolved_by_default']).toBeNull(); // 标记撤掉
  });

  it('运行中人工改派（setOverride）：下次派发落到人点名的会话，落点快照同步改掉', async () => {
    const w = makeEngine({ routing, availableSessions: ['juli-reply', 'agent-b'] });
    const wf = await w.engine.startTask('干预改派单', { brief: '干预改派单独特标记' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await waitDispatched(w, stepId);
    w.engine.setOverride(wf.id, { session: 'agent-b' }, 'web'); // 派发点消费：下次派发生效
    w.advanceClock(6 * 60_000); // 静默超时 → 卡死巡检重派（这次派发消费改派）
    await w.engine.sweepZombies();
    await w.engine.sweepZombies();
    await until(() => w.dispatched.filter((d) => d.text.includes('干预改派单独特标记')).length === 2, 500);
    expect(w.dispatched.at(-1)!.session).toBe('agent-b');
    const input = w.store.getStep(stepId)!.input;
    expect(input['resolved_session']).toBe('agent-b'); // 盯活会话的三处读它——不能还停在默认会话
    expect(input['resolved_by_default']).toBeNull();
  });

  it('默认兜底落点的步重派时遇忙改道：落点改记改道目标，标记撤掉', async () => {
    const flaky = flakyDispatch();
    const w = makeEngine({
      queueConcurrency: 2,
      routing: {
        defaultSession: 'juli-reply', defaultProject: 'p',
        agents: [
          { session: 'juli-reply', company: 'juli', domain: 'reply' },
          { session: 'juli-dev', company: 'juli', domain: 'dev' },
        ],
      },
      availableSessions: ['juli-reply', 'juli-dev'],
      dispatch: flaky.port,
    });
    const wf = await w.engine.startTask('改道重派单', { brief: 'x' }); // 首派失败：落默认会话
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await until(() => w.store.getStep(stepId)!.status === 'failed');
    // 首派失败之后，默认会话被别的单占住。
    const busy = await w.engine.startTask('占位', { brief: 'busy', session: 'juli-reply' });
    await until(() => w.store.getWorkflow(busy.id)!.status === 'running'
      && flaky.seen.some((s) => s.text.includes('busy')));
    await w.engine.retry(stepId, undefined, 'web');
    await waitDispatched(w, stepId);
    expect(flaky.seen.at(-1)!.session).toBe('juli-dev'); // 忙时改道空闲 agent 的裁定不变
    const input = w.store.getStep(stepId)!.input;
    expect(input['resolved_session']).toBe('juli-dev');
    expect(input['busy_diverted_from']).toBe('juli-reply');
    expect(input['resolved_by_default']).toBeNull(); // 现在是改道落点，按改道落点的规矩重派
  });

  // R2 复审 P2-E（2026-11-24）：人工改派（干预）之后，步骤上记的会话要跟着改。
  // 此前只写了 input.session，resolved_session 还停在改道目标——插话、卡死巡检、
  // 收工回调选步都按 resolved_session 读，读到的还是旧会话。
  it('改道落点的步被人工改派：resolved_session 跟着改到人点名的会话，改道痕迹清掉', async () => {
    const flaky = flakyDispatch();
    const w = makeEngine({
      queueConcurrency: 2,
      routing: {
        defaultSession: 'juli-reply', defaultProject: 'p',
        agents: [
          { session: 'juli-reply', company: 'juli', domain: 'reply' },
          { session: 'juli-dev', company: 'juli', domain: 'dev' },
        ],
      },
      availableSessions: ['juli-reply', 'juli-dev', 'agent-b'],
      dispatch: flaky.port,
    });
    const wf = await w.engine.startTask('改派改道单', { brief: '改派改道单独特标记' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await until(() => w.store.getStep(stepId)!.status === 'failed');
    const busy = await w.engine.startTask('占位二', { brief: 'busy2', session: 'juli-reply' });
    await until(() => w.store.getWorkflow(busy.id)!.status === 'running'
      && flaky.seen.some((s) => s.text.includes('busy2')));
    await w.engine.retry(stepId, undefined, 'web');
    await waitDispatched(w, stepId);
    expect(flaky.seen.at(-1)!.session).toBe('juli-dev'); // 先落到改道目标
    expect(w.store.getStep(stepId)!.input['busy_diverted_from']).toBe('juli-reply');

    w.engine.setOverride(wf.id, { session: 'agent-b' }, 'web'); // 人改派
    w.advanceClock(6 * 60_000); // 静默超时 → 卡死巡检重派（这次派发消费改派）
    await w.engine.sweepZombies();
    await w.engine.sweepZombies();
    // 这张单的卡一共派了三次：首派（失败）、重试（改道）、改派后的重派。
    const ours = (): { session: string; text: string }[] => flaky.seen.filter((s) => s.text.includes('改派改道单独特标记'));
    await until(() => ours().length === 3, 500);
    expect(ours().at(-1)!.session).toBe('agent-b');
    const input = w.store.getStep(stepId)!.input;
    expect(input['resolved_session']).toBe('agent-b'); // 盯活会话的几处读它——不能还停在改道目标
    expect(input['busy_diverted_from']).toBeNull();
    expect(input['session_pinned']).toBe(true);
  });
});

describe('resolved_by_default 标记只给纯兜底的落点（2026-11-24 复审 P3-⑧）', () => {
  // 「落点回写」那段原先拿函数开头的旧局部变量判断「这一步没人点名会话」。可是
  // 别名解析、route_fallback 判定、三无判定、档位孪生、忙闲改道这五条路改过的
  // 落点，起点同样没人点名会话——于是也被标成了「默认兜底」。这些路各自已经
  // 写了 resolved_session，不是兜底，不该带标记。

  it('忙闲改道的落点不带标记', async () => {
    const w = makeEngine({
      queueConcurrency: 2,
      routing: {
        defaultSession: 'juli-reply', defaultProject: 'p',
        agents: [
          { session: 'juli-reply', company: 'juli', domain: 'reply' },
          { session: 'juli-dev', company: 'juli', domain: 'dev' },
        ],
      },
      availableSessions: ['juli-reply', 'juli-dev'],
    });
    // 默认会话先被一张在跑的单占住。
    const holder = await w.engine.startTask('占位', { brief: '占位标记', session: 'juli-reply' });
    await until(() => w.dispatched.some((d) => d.text.includes('占位标记')));
    const wf = await w.engine.startTask('裸起单', { brief: 'x' }); // 不带会话：兜底到默认会话，忙 → 改道
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await waitDispatched(w, stepId);
    expect(w.dispatched.at(-1)!.session).toBe('juli-dev');
    const input = w.store.getStep(stepId)!.input;
    expect(input['resolved_session']).toBe('juli-dev');
    expect(input['busy_diverted_from']).toBe('juli-reply');
    expect(input['resolved_by_default']).toBeUndefined(); // 改道的落点不是「默认兜底」
    void holder;
  });

  it('三无判定的落点不带标记', async () => {
    const w = makeEngine({
      routing, availableSessions: ['juli-reply', 'acme'],
      taskRoute: async () => ({ session: 'acme', via: 'jev', note: '官网单', diverted: false }),
      highTwinFor: () => '',
    });
    const wf = await w.engine.startTask('判定单', { brief: 'x' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await waitDispatched(w, stepId);
    expect(w.dispatched.at(-1)!.session).toBe('acme');
    const input = w.store.getStep(stepId)!.input;
    expect(input['resolved_session']).toBe('acme');
    expect(input['resolved_by_default']).toBeUndefined(); // 判定选的落点不是「默认兜底」
  });

  it('别名解析的落点不带标记', async () => {
    const w = makeEngine({
      routing, availableSessions: ['juli-reply', 'agent-b'],
      resolveSession: (s) => (s === 'juli-reply' ? 'agent-b' : s),
    });
    const wf = await w.engine.startTask('别名单', { brief: 'x' });
    const stepId = w.store.stepsForWorkflow(wf.id)[0]!.id;
    await waitDispatched(w, stepId);
    expect(w.dispatched.at(-1)!.session).toBe('agent-b');
    const input = w.store.getStep(stepId)!.input;
    expect(input['resolved_session']).toBe('agent-b');
    expect(input['resolved_by_default']).toBeUndefined(); // 别名落回的落点不是「默认兜底」
  });
});
