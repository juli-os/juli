// HTTP API（hono）装配面：中间件链（访问日志/鉴权）+ 各资源族路由模块注册 +
// SSE 与静态 SPA 兜底。路由实现见 routes/*.ts（按资源族拆分，2026-09-23）。
// 与 Go cmd/gui/routes.go 的核心面对齐；认证 Bearer 常量时间比较，SPA 回退
// 由静态托管层负责（本服务首版 API-only，前端壳见 PORTING 路线图）。

import { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeEqual } from '../platform/shared/secure.ts';
import type { Runtime } from '../runtime.ts';
import { makeShareAuth, readBody, type AppEnv } from './helpers.ts';
import { registerLifecycleRoutes } from './routes/lifecycle.ts';
import { registerPipelinesRoutes } from './routes/pipelines.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerEmailRoutes } from './routes/email.ts';
import { registerAgentsRoutes } from './routes/agents.ts';
import { registerArtifactsRoutes } from './routes/artifacts.ts';
import { registerChatRoutes } from './routes/chat.ts';
import { registerEventsRoutes } from './routes/events.ts';
import { VERSION } from '../contracts/version.ts';

export { VERSION };

/** web/dist 解析：编译产物同级 → cwd；找不到返回 null（API-only 模式）。 */
const resolveWebDist = (): string | null => {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/http
  const candidates = [
    resolve(here, '..', 'web-dist'),
    resolve(process.cwd(), 'web-dist'),
    resolve(here, '..', '..', 'web', 'dist'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
};

export const createHttpApp = (rt: Runtime): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();
  const share = makeShareAuth(rt);

  // 无认证面：健康检查（负载均衡/存活探针）。
  app.get('/healthz', (c) => c.json({ ok: true }));

  // HTTP 访问日志（注册在鉴权之前——401 也必须留痕，公网爆破可见性）。
  // 只记 method/path/status/耗时，不含 header/query（token 不落日志）。
  app.use('/api/*', async (c, next) => {
    const start = Date.now();
    await next();
    const line = `${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - start}ms`;
    if (c.res.status >= 500) console.error(`[http-err] ${line}`);
    else if (c.res.status >= 400) console.warn(`[http-warn] ${line}`);
    else console.log(`[http] ${line}`);
  });

  // 认证链：本地密码（常量时间）优先；配置 PB 后追加 PB token 校验。
  // ?token= 是 WS/SSE 客户端（iOS）的兼容面——会进访问日志，生产建议反代遮蔽。
  app.use('/api/*', async (c, next) => {
    // 工件内容分享链接：签名+限时即可（收件人没有 Bearer）。
    const artMatch = c.req.path.match(/^\/api\/artifacts\/([^/]+)\/content$/);
    if (artMatch !== null && share.shareVerify(decodeURIComponent(artMatch[1]!), c.req.query('share'))) {
      return next();
    }
    if (!rt.authenticator) return next(); // 未配置任何认证 = 开放模式（本机调试）
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : c.req.query('token') ?? '';
    if (token !== '') {
      if (rt.authenticator) {
        const r = await rt.authenticator.verify(token);
        if (r.ok) {
          c.set('user', r.value.id);
          return next();
        }
      }
      if (rt.config.password !== '' && safeEqual(token, rt.config.password)) {
        return next();
      }
    }
    return c.json({ error: 'unauthorized' }, 401);
  });

  app.get('/api/version', (c) => c.json({ version: VERSION }));

  // iOS 设备推送 token 注册（幂等 upsert）。
  app.post('/api/device-token', async (c) => {
    const body = await readBody(c);
    const token = typeof body['token'] === 'string' ? body['token'] : '';
    if (token === '') return c.json({ error: 'token required' }, 400);
    rt.registerDeviceToken(token);
    return c.json({ ok: true });
  });

  // ---- 资源族路由（注册顺序=原 app.ts 出现序；SSE/SPA 兜底必须垫底）----
  registerLifecycleRoutes(app, rt);
  registerPipelinesRoutes(app, rt);
  registerSettingsRoutes(app, rt);
  registerEmailRoutes(app, rt);
  registerAgentsRoutes(app, rt);
  registerArtifactsRoutes(app, rt);
  registerChatRoutes(app, rt);
  registerEventsRoutes(app, rt);

  // ---- 静态托管（web/dist SPA 壳；/api 与 /healthz 之外 SPA 回退）------------
  const webRoot = resolveWebDist();
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
    '.json': 'application/json', '.woff2': 'font/woff2', '.map': 'application/json',
  };
  if (webRoot !== null) {
    app.get('*', (c) => {
      const path = c.req.path;
      // 铁律（262fe94 教训）：SPA 回退绝不吞掉 API 路径——未注册的 /api/*
      // 必须明明白白 404，否则前端拿到 200 HTML 会把 null 当数据。
      if (path.startsWith('/api/') || path === '/healthz') return c.notFound();
      // 带 extension 的请求按静态文件解析（含路径穿越守卫）；其余回退 SPA 壳。
      const wantsFile = path !== '/' && /\.[a-z0-9]+$/i.test(path);
      const rel = wantsFile ? normalize(path).replace(/^([/\\])+/, '') : 'index.html';
      const abs = resolve(webRoot, rel);
      if (!abs.startsWith(webRoot)) return c.notFound();
      if (!existsSync(abs)) {
        // 入口 HTML 禁缓存（web-dist 陷阱根治）：bundle 文件名带哈希可长缓存，
        // 壳本身必须每次回源——否则发新版后浏览器还在跑旧壳引用旧 bundle。
        return wantsFile ? c.notFound() : new Response(readFileSync(join(webRoot, 'index.html'), 'utf8'), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
        });
      }
      const ext = abs.slice(abs.lastIndexOf('.'));
      const body = readFileSync(abs);
      // 入口 HTML 禁缓存（web-dist 陷阱根治）：bundle 带哈希可长缓存，壳必须
      // 每次回源——否则发新版后浏览器还在跑旧壳引用旧 bundle。
      const headers: Record<string, string> = { 'content-type': MIME[ext] ?? 'application/octet-stream' };
      // HTML 壳一律禁缓存（web-dist 陷阱根治）：index/demo-live 与探路件原型页
      // 同为迭代频繁的壳页，强刷不再是门槛；bundle/静态资源照常缓存
      if (rel.endsWith('.html')) headers['cache-control'] = 'no-cache';
      return c.body(body, 200, headers);
    });
  }

  return app;
};
