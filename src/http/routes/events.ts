// SSE 事件流（轮询账本 events 表，部署友好无粘性会话）。
// 分层重构（2026-09-23）：自 app.ts 按资源族拆出，路由注册体逐字保留。

import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Runtime } from '../../runtime.ts';
import { clampInt, tenantScopeOf, type AppEnv } from '../helpers.ts';
import { eventTenant, scopeSees } from '../../business/workflow/tenantScope.ts';

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
      // 租户收口（A2）：逐事件判租户再推——workflow/step 事件按 entity 查单子
      // 租户（一次查库，P3 实测每页开销 0.3ms 量级）；agent/judgment 事件无单子
      // 归属只进 all（tenant=null）。one 连到 onAbort 前 lastId 照常推进——被滤
      // 事件对 one 不可见但游标必须前进，否则每秒重复扫描同一段。
      const scope = tenantScopeOf(c);
      await new Promise<void>((resolve) => {
        let done = false; // 流已关（客户端断开，或出过错）
        // 关流收尾（幂等）：清定时器 + 结束内层 Promise → 上面的回调返回，hono 随即关流。
        const shutdown = (): void => {
          if (done) return;
          done = true;
          clearInterval(timer);
          resolve();
        };
        // 2026-11-23 全量审查修复：轮询回调此前没有 try/catch，store.eventsSince 一
        // 抛错就是未捕获异常，引擎整个进程退出（没有全局兜底）；void 掉的
        // writeSSE 也没人接 rejection。现在出错记一行日志，然后关掉这条流——
        // 断开的客户端重连即恢复，进程不退。try 包住整个回调：事件租户归属
        //（eventTenant）同样读库，与 eventsSince 是同一类故障。
        const fail = (e: unknown): void => {
          if (done) return; // 迟到的 rejection：流已关，只丢弃，不重复记日志
          console.error(`[sse] 事件流读取失败，本条流已关闭: ${e instanceof Error ? e.message : String(e)}`);
          shutdown();
        };
        const timer = setInterval(() => {
          try {
            const events = rt.store.eventsSince(lastId, 100);
            for (const ev of events) {
              lastId = Math.max(lastId, ev.id);
              if (!scopeSees(scope, eventTenant(rt.store, ev))) continue;
              void stream.writeSSE({ event: ev.type, data: JSON.stringify(ev), id: String(ev.id) }).catch(fail);
            }
          } catch (e) {
            fail(e);
          }
        }, 1000);
        stream.onAbort(shutdown);
      });
    });
  });

};
