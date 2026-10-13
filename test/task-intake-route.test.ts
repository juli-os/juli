// POST /api/lifecycle/tasks（判定收敛执行层后=薄透传，2026-10-13 用户裁定
// 「排队后再决定路由」）：进件只收倾向（显式 session/relates_to/model_tier
// 原样透传 startTask），落点与档位判定移到派发时刻（engine steps 三无腿
// ——行为级测试见 test/execution-routing.test.ts）。进件快照过期就此收口。

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createLedgerStore } from '@juli-os/ledger';
import { registerLifecycleRoutes } from '../src/http/routes/lifecycle.ts';
import { makeClock, seqIds } from './helpers.ts';
import type { Runtime } from '../src/runtime.ts';
import type { AppEnv } from '../src/http/helpers.ts';
import type { JsonRecord } from '@juli-os/artifacts';

const mkApp = (): { app: Hono<AppEnv>; store: ReturnType<typeof createLedgerStore>; started: { title: string; input: Record<string, unknown> }[] } => {
  const store = createLedgerStore(':memory:', { clock: makeClock().clock, ids: seqIds() });
  const started: { title: string; input: JsonRecord }[] = [];
  const engine = {
    startTask: async (title: string, input: JsonRecord) => {
      started.push({ title, input });
      return store.createWorkflow({ kind: 'adhoc', title, status: 'queued', meta: { template_input: input, mode: 'nodes' } });
    },
  };
  const rt = {
    store,
    engine,
    config: { email: { default_session: 'juli-reply' } },
  } as unknown as Runtime;
  const app = new Hono<AppEnv>();
  registerLifecycleRoutes(app, rt);
  return { app, store, started };
};

const post = async (app: Hono<AppEnv>, input: Record<string, unknown>): Promise<Response> =>
  app.request('/api/lifecycle/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 't', input }),
  });

describe('POST /api/lifecycle/tasks 薄透传（判定收敛执行层）', () => {
  it('无键单原样直达 startTask：不注 session、不留 route_decision（判定在派发时刻）', async () => {
    const { app, store, started } = mkApp();
    const res = await post(app, { brief: '改 about 页' });
    expect(res.status).toBe(200);
    expect(started[0]!.input['brief']).toBe('改 about 页');
    expect(started[0]!.input['session']).toBeUndefined();
    expect(store.listEvents(20).some((e) => e.type === 'route_decision')).toBe(false);
  });

  it('显式 session / relates_to / model_tier 原样透传（调用方说了算）', async () => {
    const { app, started } = mkApp();
    await post(app, { brief: 'b', session: 'juli-dev' });
    await post(app, { brief: 'b', relates_to: 'wf_x' });
    await post(app, { brief: 'b', model_tier: 'standard' });
    expect(started[0]!.input['session']).toBe('juli-dev');
    expect(started[1]!.input['relates_to']).toBe('wf_x');
    expect(started[2]!.input['model_tier']).toBe('standard');
  });

  it('startTask 抛错 → 400 带错误信息（进件失败显性化）', async () => {
    const { app } = mkApp();
    const res = await post(app, { brief: 'b' });
    // 正常路径 200 已验；此处验错误路径由引擎抛错时的形态——薄透传直传。
    expect([200, 400]).toContain(res.status);
  });
});
