// HTTP API（hono）装配面：中间件链（访问日志/鉴权）+ 各资源族路由模块注册 +
// SSE 与静态 SPA 兜底。路由实现见 routes/*.ts（按资源族拆分，2026-09-23）。
// 与 Go cmd/gui/routes.go 的核心面对齐；认证 Bearer 常量时间比较，SPA 回退
// 由静态托管层负责（本服务首版 API-only，前端壳见 PORTING 路线图）。

import { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeEqual } from '../platform/shared/secure.ts';
import type { Runtime } from '../runtime.ts';
import { bodyStr, makeShareAuth, readBody, type AppEnv } from './helpers.ts';
import { parseTenantScope } from '../business/workflow/tenantScope.ts';
import { registerLifecycleRoutes } from './routes/lifecycle.ts';
import { registerPipelinesRoutes } from './routes/pipelines.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerTenantsRoutes } from './routes/tenants.ts';
import { registerEmailRoutes } from './routes/email.ts';
import { registerAgentsRoutes } from './routes/agents.ts';
import { registerArtifactsRoutes } from './routes/artifacts.ts';
import { registerChatRoutes } from './routes/chat.ts';
import { registerEventsRoutes } from './routes/events.ts';
import { registerGatesRoutes } from './routes/gates.ts';
// 业务路由分册（反馈墙/客户/运维/统计——MVP 公开砍面聚合处，公开投影=空桩）
import { registerBusinessRoutes } from './businessRoutes.ts';
import { VERSION } from '../contracts/version.ts';

/** web/dist 解析：编译产物同级 → cwd → web/dist 兜底；找不到返回 null（API-only 模式）。 */
const resolveWebDist = (): { dir: string; candidate: number } | null => {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/http
  const candidates = [
    resolve(here, '..', 'web-dist'),
    resolve(process.cwd(), 'web-dist'),
    resolve(here, '..', '..', 'web', 'dist'),
  ];
  for (const [i, dir] of candidates.entries()) {
    if (existsSync(join(dir, 'index.html'))) return { dir, candidate: i + 1 };
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
    if (artMatch !== null) {
      // 畸形百分号编码 decode 会 throw URIError——按无分享签名处理走常规认证，
      // 绝不让客户端输入炸成 500。
      let artId = artMatch[1]!;
      try { artId = decodeURIComponent(artId); } catch { /* 畸形 id */ }
      if (share.shareVerify(artId, c.req.query('share'))) return next();
    }
    if (!rt.authenticator) return next(); // 未配置任何认证 = 开放模式（本机调试）
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : c.req.query('token') ?? '';
    if (token !== '') {
      const r = await rt.authenticator.verify(token);
      if (r.ok) {
        c.set('user', r.value.id);
        return next();
      }
      if (rt.config.password !== '' && safeEqual(token, rt.config.password)) {
        return next();
      }
    }
    return c.json({ error: 'unauthorized' }, 401);
  });

  // 读侧租户边界（2026-11-08 多租户提案 A2）：X-Juli-Tenant → TenantScope 挂
  // context。没有头 = all（operator 形态，iOS/CLI 既有行为零变化）；声明的
  // 租户 id = one（读 API 下推过滤）；未声明的 id = 400 点名。必须排在鉴权
  // 之后、资源路由之前——读面全按 context 的 scope 收口。
  // 取值 header 优先、同名 query（X-Juli-Tenant）兜底（2026-11-09 F1）：
  // EventSource 设不了自定义 header，SSE（/api/events/stream）的租户身份与
  // 重连只能靠 query 带——契约见 tenantScope.ts（「header 或同名 query」），
  // 与 WS 握手（url.searchParams 'X-Juli-Tenant'）同名同序。
  app.use('/api/*', async (c, next) => {
    try {
      c.set('tenantScope', parseTenantScope(
        c.req.header('x-juli-tenant') ?? c.req.query('X-Juli-Tenant') ?? undefined,
        rt.tenants.tenants.map((t) => t.id),
      ));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
    await next();
  });

  app.get('/api/version', (c) => c.json({ version: VERSION }));

  // iOS 设备推送 token 注册（幂等 upsert）。
  app.post('/api/device-token', async (c) => {
    const body = await readBody(c);
    const token = bodyStr(body, 'token');
    if (token === '') return c.json({ error: 'token required' }, 400);
    rt.registerDeviceToken(token);
    return c.json({ ok: true });
  });

  // ---- 资源族路由（注册顺序=原 app.ts 出现序；SSE/SPA 兜底必须垫底）----
  registerLifecycleRoutes(app, rt);
  registerGatesRoutes(app, rt);
  registerPipelinesRoutes(app, rt);
  registerSettingsRoutes(app, rt);
  registerTenantsRoutes(app, () => rt.tenants.tenants);
  registerEmailRoutes(app, rt);
  registerAgentsRoutes(app, rt);
  registerArtifactsRoutes(app, rt);
  registerChatRoutes(app, rt);
  registerEventsRoutes(app, rt);
  // 业务四族（反馈墙/客户/运维/统计）聚合注册——分册见 businessRoutes.ts。
  registerBusinessRoutes(app, rt);

  // ---- 静态托管（web/dist SPA 壳；/api 与 /healthz 之外 SPA 回退）------------
  const webRoot = resolveWebDist();
  // 启动留痕（b43 R1）：web-dist 两候选缺席时会静默兜底 web/dist（可能是过期旧壳），
  // 这正是 10-23 那类「无声 UI 回退」事故无日志可查的后门——命中面必须启动可见。
  console.log(
    `[web] 静态托管 ${webRoot === null ? '未命中（API-only 模式）' : `webRoot=${webRoot.dir}（候选 ${webRoot.candidate}/3）`}`,
  );
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
    '.json': 'application/json', '.woff2': 'font/woff2', '.map': 'application/json',
  };
  if (webRoot !== null) {
    app.get('*', (c) => {
      const path = c.req.path;
      // 铁律（262fe94 教训）：SPA 回退绝不吞掉 API 路径——未注册的 /api/*
      // 必须明明白白 404，否则前端拿到 200 HTML 会把 null 当数据。/__fb/*
      // 同待遇（2026-11-13 挂件口已摘除，免密路径族不吃 SPA 壳）。
      if (path.startsWith('/api/') || path.startsWith('/__fb/') || path === '/__fb' || path === '/healthz') return c.notFound();
      // 带 extension 的请求按静态文件解析（含路径穿越守卫）；其余回退 SPA 壳。
      const wantsFile = path !== '/' && /\.[a-z0-9]+$/i.test(path);
      const rel = wantsFile ? normalize(path).replace(/^([/\\])+/, '') : 'index.html';
      const abs = resolve(webRoot.dir, rel);
      // 分隔符边界：裸 startsWithout 会放行同名前缀兄弟目录（web-dist-x/…）。
      if (!abs.startsWith(webRoot.dir + sep)) return c.notFound();
      // 缺文件一律 404：非文件路径 rel 恒为 index.html，旧代码在此分支对刚判
      // 缺失的路径再 readFileSync（壳被换下的窗口期必 throw 变 500）；正常路径
      // 的壳禁缓存在下方主路径统一处理。
      if (!existsSync(abs)) return c.notFound();
      const ext = abs.slice(abs.lastIndexOf('.'));
      const body = readFileSync(abs);
      const headers: Record<string, string> = { 'content-type': MIME[ext] ?? 'application/octet-stream' };
      // HTML 壳一律禁缓存（web-dist 陷阱根治）：index/demo-live 与探路件原型页
      // 同为迭代频繁的壳页，强刷不再是门槛；bundle/静态资源照常缓存
      if (rel.endsWith('.html')) headers['cache-control'] = 'no-cache';
      return c.body(body, 200, headers);
    });
  }

  return app;
};
