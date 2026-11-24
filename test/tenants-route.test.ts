import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerTenantsRoutes } from '../src/http/routes/tenants.ts';
import type { AppEnv } from '../src/http/helpers.ts';

const entry = (id: string, name: string, herdrSession: string) => ({
  id, name, herdrSession,
  agents: [`${id}-agent`],
  defaultSession: `${id}-default`,
  senderDomains: [`${id}.example`],
});

const mkApp = (list: () => readonly ReturnType<typeof entry>[]): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();
  registerTenantsRoutes(app, list);
  return app;
};

describe('GET /api/tenants（B7 租户切换器清单）', () => {
  it('按声明序只出 id/name/herdr_session，判定表字段不出门', async () => {
    const app = mkApp(() => [entry('internal', 'juli Labs', ''), entry('acme', 'Meridian', 'team-ws')]);
    const res = await app.request('/api/tenants');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tenants: [
        { id: 'internal', name: 'juli Labs', herdr_session: '' },
        { id: 'acme', name: 'Meridian', herdr_session: 'team-ws' },
      ],
    });
  });

  it('每次请求现读声明（配置热改后清单跟着变）', async () => {
    let declared = [entry('internal', 'internal', '')];
    const app = mkApp(() => declared);
    expect(((await (await app.request('/api/tenants')).json()) as { tenants: unknown[] }).tenants).toHaveLength(1);
    declared = [entry('internal', 'internal', ''), entry('acme', 'Meridian', '')];
    const after = (await (await app.request('/api/tenants')).json()) as { tenants: { id: string }[] };
    expect(after.tenants.map((t) => t.id)).toEqual(['internal', 'acme']);
  });
});
