// POST /api/lifecycle/tasks 无键兜底（0930「所有的都走路由」）：无显式
// session/relates_to/tier 时过 routeTask 判定并随 input.session 钉死 + 落
// route_decision 留痕；三键任一在位=调用方说了算，判定不越权。

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createLedgerStore } from '@juli-os/ledger';
import { registerLifecycleRoutes } from '../src/http/routes/lifecycle.ts';
import { makeClock, seqIds } from './helpers.ts';
import type { Runtime } from '../src/runtime.ts';
import type { TaskLanding } from '@juli-os/routing';
import type { AppEnv } from '../src/http/helpers.ts';
import type { JsonRecord } from '@juli-os/artifacts'

const mkApp = (over: Partial<Runtime> = {}): { app: Hono<AppEnv>; store: ReturnType<typeof createLedgerStore>; started: { title: string; input: Record<string, unknown> }[] } => {
  const store = createLedgerStore(':memory:', { clock: makeClock().clock, ids: seqIds() });
  const started: { title: string; input: JsonRecord }[] = [];
  const engine = {
    startTask: async (title: string, input: JsonRecord) => {
      started.push({ title, input });
      return store.createWorkflow({ kind: 'adhoc', title, status: 'queued', meta: { template_input: input, mode: 'nodes' } });
    },
  };
  const land = (session: string): TaskLanding => ({ session, note: session, via: 'jev', ideal: session, diverted: false });
  const rt = {
    store,
    engine,
    taskRoute: async (_t: string, _b: string) => land('acme'),
    ...over,
  } as unknown as Runtime;
  const app = new Hono<AppEnv>();
  registerLifecycleRoutes(app, rt);
  return { app, store, started };
};

describe('POST /api/lifecycle/tasks 无键兜底', () => {
  it('无任何路由键 → taskRoute 判定，session 钉进 input + route_decision 留痕', async () => {
    const { app, store, started } = mkApp();
    const res = await app.request('/api/lifecycle/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '官网文案修复', input: { brief: '改 about 页' } }),
    });
    expect(res.status).toBe(200);
    expect(started[0]!.input['session']).toBe('acme');
    const ev = store.listEvents(20).find((e) => e.type === 'route_decision');
    expect(ev).toBeDefined();
    expect(ev!.payload['session']).toBe('acme');
    expect(ev!.payload['from']).toBe('task-intake');
  });

  it('显式 session / relates_to / tier high → 判定不越权（三键任一在位）', async () => {
    const { app, started } = mkApp();
    const post = async (input: Record<string, unknown>): Promise<void> => {
      const res = await app.request('/api/lifecycle/tasks', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 't', input }),
      });
      expect(res.status).toBe(200);
    };
    await post({ brief: 'b', session: 'juli-dev' }); // 显式钉住赢
    await post({ brief: 'b', relates_to: 'wf_x' }); // 挂靠继承处理，不预判
    await post({ brief: 'b', model_tier: 'high' }); // tier 改道处理
    expect(started.map((s) => s.input['session'] ?? '(空)')).toEqual(['juli-dev', '(空)', '(空)']);
  });

  it('判定 fail-open（空落点或 via=default 非改道）→ 原样进件不注 session，不留 route_decision', async () => {
    // via=default 且未改道 = 判定没给出真决定——注 session 会把 default 当
    // 显式钉住（播种即 session_pinned），忙时只排队挤死既有改道。两类都测。
    const { app, store, started } = mkApp({
      taskRoute: async () => ({ session: '', note: '', via: 'default', ideal: '', diverted: false }),
    } as Partial<Runtime>);
    const res = await app.request('/api/lifecycle/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', input: { brief: 'b' } }),
    });
    expect(res.status).toBe(200);
    expect(started[0]!.input['session']).toBeUndefined();
    expect(store.listEvents(20).some((e) => e.type === 'route_decision')).toBe(false);
    // 非空 default 同样不注入。
    const { app: app2, store: st2, started: s2 } = mkApp({
      taskRoute: async () => ({ session: 'juli-reply', note: 'juli-reply', via: 'default', ideal: 'juli-reply', diverted: false }),
    } as Partial<Runtime>);
    const res2 = await app2.request('/api/lifecycle/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', input: { brief: 'b' } }),
    });
    expect(res2.status).toBe(200);
    expect(s2[0]!.input['session']).toBeUndefined();
    expect(st2.listEvents(20).some((e) => e.type === 'route_decision')).toBe(false);
  });

  it('忙闲改道的判定也算真决定 → 注入 session（排队语义交给钉住）', async () => {
    const { app, started } = mkApp({
      taskRoute: async () => ({ session: 'juli-dev', note: 'juli-reply 忙 → 改道 juli-dev', via: 'default', ideal: 'juli-reply', diverted: true }),
    } as Partial<Runtime>);
    const res = await app.request('/api/lifecycle/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', input: { brief: 'b' } }),
    });
    expect(res.status).toBe(200);
    expect(started[0]!.input['session']).toBe('juli-dev');
  });

  it('taskRoute 抛错 → fail-open 原样进件（判定挂了不许挂起单正门）', async () => {
    const { app, started } = mkApp({
      taskRoute: async () => { throw new Error('网关炸了'); },
    } as Partial<Runtime>);
    const res = await app.request('/api/lifecycle/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', input: { brief: 'b' } }),
    });
    expect(res.status).toBe(200);
    expect(started[0]!.input['session']).toBeUndefined();
  });

  it('开单成功后的留痕 appendEvent 抛错 → 不推翻已成功的开单（200，十一跑 P2-2）', async () => {
    // 修复前：route_decision 留痕在外层 try 内、位于 startTask 之后——抛错把
    // 已建的单报成 400，本端点无幂等键，重试=重复单。
    const { app, store, started } = mkApp();
    const boom = (): never => { throw new Error('账本炸了'); };
    (store as unknown as { appendEvent: typeof boom }).appendEvent = boom;
    const res = await app.request('/api/lifecycle/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '留痕炸单', input: { brief: 'b' } }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { workflow: { title: string } };
    expect(data.workflow.title).toBe('留痕炸单');
    expect(started).toHaveLength(1); // 单已开出，留痕失败只记日志
  });
});
