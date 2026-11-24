// 声明租户的只读投影（2026-11-08 多租户提案 B7）：desktop 顶栏租户切换器的
// 清单来源。只出 id/name/herdr_session，agents、default_session、发件规则等
// 判定表不出这道门。one 身份同样可读：清单是系统级声明，与 settings 同属
// A2 的 operator 豁免面，不按 X-Juli-Tenant 收口。
//
// 入参是取数函数而非 Runtime：每次请求现读（配置热改后清单跟着变），且本
// 文件不依赖 A1 的 runtime 字段。装配在 app.ts 的 A2 租户中间件之后：
//   registerTenantsRoutes(app, () => rt.tenants.tenants);

import type { Hono } from 'hono';
import type { AppEnv } from '../helpers.ts';

/** A1 TenantEntry 的投影所需字段（结构兼容 TenantTable.tenants 的元素）。 */
export interface DeclaredTenant {
  readonly id: string;
  readonly name: string;
  readonly herdrSession: string;
}

export const registerTenantsRoutes = (app: Hono<AppEnv>, listTenants: () => readonly DeclaredTenant[]): void => {
  app.get('/api/tenants', (c) => c.json({
    tenants: listTenants().map((t) => ({ id: t.id, name: t.name, herdr_session: t.herdrSession })),
  }));
};
