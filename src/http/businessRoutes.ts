// 公开投影桩：与私仓同形，双侧 typecheck 兜底防漂移。
// 私仓本文件注册业务资源族路由（反馈墙/客户/运维巡检/统计四族）——公开投影
// 未含这些路由模块（MVP 砍面），桩为空注册。app.ts 单点调用零改动即可在
// 两侧编译。

import type { Hono } from 'hono';
import type { Runtime } from '../runtime.ts';
import type { AppEnv } from './helpers.ts';

/** 注册业务资源族路由（公开投影：空注册——四族路由均不在砍面内）。 */
export const registerBusinessRoutes = (_app: Hono<AppEnv>, _rt: Runtime): void => {
  // 公开投影未含反馈墙/客户/运维/统计路由族（MVP 砍面）。
};
