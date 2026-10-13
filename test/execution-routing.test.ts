// 执行层判定（2026-10-13 用户裁定「排队后再决定路由」）：三无单（无显式
// session=无挂靠继承、无挂靠、无显式档位）的落点与档位判定收敛到派发时刻
// （steps 三无腿，jev 对实时忙闲）——进件层只收倾向，快照过期收口。
// 与 PR#20（挂靠不钉+holdGate 忙会话腿+守卫全忙兜底）衔接成完整链路。

import { describe, expect, it } from 'vitest';
import { makeEngine, until } from './helpers.ts';

const decl = {
  defaultSession: 'juli-reply', defaultProject: 'p',
  agents: [
    { session: 'juli-reply', company: 'juli', domain: 'reply' },
    { session: 'acme', company: 'acme', domain: 'site' },
    { session: 'juli-dev', company: 'juli', domain: 'dev' },
  ],
};
const AVAIL = ['juli-reply', 'acme', 'juli-dev'];

describe('执行层判定（三无腿）', () => {
  it('三无单派发时刻判落点：taskRoute 判中 → 落判定点 + route_decision 留痕', async () => {
    const w = makeEngine({
      routing: decl, availableSessions: AVAIL, queueConcurrency: 3,
      taskRoute: async () => ({ session: 'acme', via: 'jev', note: '官网单', diverted: false }),
      highTwinFor: () => '', taskTier: async () => null,
    });
    await w.engine.startTask('官网文案修复', { brief: '改 about 页' });
    await until(() => w.dispatched.some((d) => d.text.includes('改 about 页')));
    expect(w.dispatched.find((d) => d.text.includes('改 about 页'))!.session).toBe('acme');
    const step = w.store.stepsForWorkflow(w.store.listWorkflows(1)[0]!.id)[0]!;
    expect(step.input['session']).toBeUndefined(); // 未播种（非钉住）
    expect(step.input['resolved_session']).toBe('acme');
    const ev = w.store.listEvents(20).find((e) => e.type === 'route_decision');
    expect(ev).toBeDefined();
    expect(ev!.payload['session']).toBe('acme');
    expect(ev!.payload['from']).toBe('engine-dispatch');
  });

  it('判定落点忙 → 守卫改道空闲 agent（执行层判定+忙闲守卫衔接）', async () => {
    const w = makeEngine({
      routing: decl, availableSessions: AVAIL, queueConcurrency: 3,
      taskRoute: async () => ({ session: 'acme', via: 'jev', note: '官网单', diverted: false }),
      highTwinFor: () => '', taskTier: async () => null,
    });
    const busy = await w.engine.startTask('占位', { brief: 'busy', session: 'acme' });
    await until(() => w.store.getWorkflow(busy.id)!.status === 'running');
    await w.engine.startTask('官网文案修复', { brief: '衔接标记' });
    await until(() => w.dispatched.some((d) => d.text.includes('衔接标记')));
    const step = w.store.stepsForWorkflow(w.store.listWorkflows(1)[0]!.id)[0]!;
    expect(step.input['busy_diverted_from']).toBe('acme'); // 判定落 acme，守卫改道
    expect(w.dispatched.find((d) => d.text.includes('衔接标记'))!.session).toBe('juli-reply');
  });

  it('判 high → 升孪生：taskTier 判 high → 落 -hi + reasons.model_tier + model_tier_by 入步', async () => {
    const w = makeEngine({
      routing: decl, availableSessions: AVAIL, queueConcurrency: 3,
      taskRoute: async () => ({ session: 'juli-dev', via: 'jev', note: '开发单', diverted: false }),
      highTwinFor: (s) => (s === 'juli-dev' ? 'juli-dev-hi' : ''),
      taskTier: async () => 'high',
    });
    await w.engine.startTask('重构引擎派发层', { brief: '多文件架构改动' });
    await until(() => w.dispatched.some((d) => d.text.includes('多文件架构改动')));
    expect(w.dispatched.find((d) => d.text.includes('多文件架构改动'))!.session).toBe('juli-dev-hi');
    const step = w.store.stepsForWorkflow(w.store.listWorkflows(1)[0]!.id)[0]!;
    expect(step.input['model_tier']).toBe('high');
    expect(step.input['model_tier_by']).toBe('jev');
    const ev = w.store.listEvents(20).find((e) => e.type === 'route_decision');
    expect(String((ev!.payload['reasons'] as Record<string, unknown>)['model_tier'])).toContain('juli-dev-hi');
  });

  it('落点无孪生 → 不判档零网络（taskTier 不被调用）', async () => {
    let tierAsked = 0;
    const w = makeEngine({
      routing: decl, availableSessions: AVAIL, queueConcurrency: 3,
      taskRoute: async () => ({ session: 'acme', via: 'jev', note: '官网单', diverted: false }),
      highTwinFor: () => '',
      taskTier: async () => { tierAsked += 1; return null; },
    });
    await w.engine.startTask('t', { brief: '无孪生标记' });
    await until(() => w.dispatched.some((d) => d.text.includes('无孪生标记')));
    expect(tierAsked).toBe(0);
  });

  it('判 standard（null）→ 维持落点不升档；taskTier 抛错 → fail-open 维持', async () => {
    for (const tier of [async () => null, async (): Promise<'high' | null> => { throw new Error('jev 炸了'); }]) {
      const w = makeEngine({
        routing: decl, availableSessions: AVAIL, queueConcurrency: 3,
        taskRoute: async () => ({ session: 'juli-dev', via: 'jev', note: '开发单', diverted: false }),
        highTwinFor: (s) => (s === 'juli-dev' ? 'juli-dev-hi' : ''),
        taskTier: tier,
      });
      await w.engine.startTask('改一行文案', { brief: '维持标记' });
      await until(() => w.dispatched.some((d) => d.text.includes('维持标记')));
      expect(w.dispatched.find((d) => d.text.includes('维持标记'))!.session).toBe('juli-dev');
    }
  });

  it('taskRoute 抛错 → fail-open 走 default，零留痕', async () => {
    const w = makeEngine({
      routing: decl, availableSessions: AVAIL, queueConcurrency: 3,
      taskRoute: async () => { throw new Error('网关炸了'); },
      highTwinFor: () => '', taskTier: async () => null,
    });
    await w.engine.startTask('t', { brief: 'failopen 标记' });
    await until(() => w.dispatched.some((d) => d.text.includes('failopen 标记')));
    expect(w.dispatched.find((d) => d.text.includes('failopen 标记'))!.session).toBe('juli-reply');
    expect(w.store.listEvents(20).some((e) => e.type === 'route_decision')).toBe(false);
  });

  it('三键任一在位 → 判定不越权（显式 session/挂靠/显式档位都不问 taskRoute）', async () => {
    let routeAsked = 0;
    let tierAsked = 0;
    const mk = () => makeEngine({
      routing: decl, availableSessions: AVAIL, queueConcurrency: 3,
      taskRoute: async () => { routeAsked += 1; return { session: 'acme', via: 'jev', note: '', diverted: false }; },
      highTwinFor: () => 'juli-reply-hi',
      taskTier: async () => { tierAsked += 1; return 'high'; },
    });
    // 显式 session
    let w = mk();
    await w.engine.startTask('t', { brief: '显式钉标记', session: 'juli-dev' });
    await until(() => w.dispatched.some((d) => d.text.includes('显式钉标记')));
    expect(w.dispatched.find((d) => d.text.includes('显式钉标记'))!.session).toBe('juli-dev');
    // 挂靠继承
    w = mk();
    const parent = await w.engine.startTask('父单', { brief: 'p', session: 'acme' });
    await until(() => w.store.getWorkflow(parent.id)!.status === 'running');
    await w.engine.forceClose(parent.id, 'test', 'test');
    await w.engine.startTask('跟进', { brief: '挂靠标记', relates_to: parent.id });
    await until(() => w.dispatched.some((d) => d.text.includes('挂靠标记')));
    expect(w.dispatched.find((d) => d.text.includes('挂靠标记'))!.session).toBe('acme');
    // 显式档位（standard 同样算调用方说了算，R4-F1 P2-1）
    w = mk();
    await w.engine.startTask('t', { brief: '显式档标记', model_tier: 'standard' });
    await until(() => w.dispatched.some((d) => d.text.includes('显式档标记')));
    expect(routeAsked).toBe(0); // 三键任一在位：落点判定一次都没问
    expect(tierAsked).toBe(0); // 判档同样不越权
  });
});
