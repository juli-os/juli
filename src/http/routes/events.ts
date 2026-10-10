// SSE 事件流（轮询账本 events 表，部署友好无粘性会话）。
// 分层重构（2026-09-23）：自 app.ts 按资源族拆出，路由注册体逐字保留。

import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { resolve } from 'node:path';
import type { Runtime } from '../../runtime.ts';
import { clampInt, type AppEnv } from '../helpers.ts';

export const registerEventsRoutes = (app: Hono<AppEnv>, rt: Runtime): void => {
  // ---- SSE 事件流（轮询账本 events 表，部署友好无粘性会话）------------------------
  // 注册顺序铁律：必须在静态 SPA 兜底（app.get('*')）之前——兜底守卫对 /api/*
  // 一律 404（262fe94 教训），路由排在它后面就永远轮不到，SSE 会静默断流。
  app.get('/api/events/stream', (c) => {
    return streamSSE(c, async (stream) => {
      let lastId = clampInt(c.req.query('since'), 0, 0, Number.MAX_SAFE_INTEGER);
      if (lastId === 0) {
        const all = rt.store.listEvents(1);
        lastId = all[0]?.id ?? 0;
      }
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ since: lastId }) });
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const events = rt.store.eventsSince(lastId, 100);
          for (const ev of events) {
            lastId = Math.max(lastId, ev.id);
            void stream.writeSSE({ event: ev.type, data: JSON.stringify(ev), id: String(ev.id) });
          }
        }, 1000);
        stream.onAbort(() => {
          clearInterval(timer);
          resolve();
        });
      });
    });
  });

};
