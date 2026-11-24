// 读侧租户边界（2026-11-08 多租户提案 A2）：请求租户两态 + 引擎按单子租户
// 收口的守卫。设计口径：
//   · HTTP/WS/SSE 的租户上下文来自 X-Juli-Tenant（header 或同名 query，HTTP
//     面 header 优先——EventSource 设不了 header，SSE 重连靠 query 兜底）——
//     没有头 = all（operator 形态，iOS/CLI 既有行为零变化）；
//   · 引擎是无请求上下文的后台，它的租户上下文来自「这张单子属于哪个租户」
//     （workflow.tenant，A1 回填后存量有值）——绝不把请求头语义带进引擎；
//   · 类型在入口校验一次（parseTenantScope），内部信任 TenantScope。
// 本文件不 import platform/config（arch 白名单 business/workflow 未登记该
// 边）：声明表以结构接口（TenantTableShape）注入，runtime 装配侧把 A1
// 的 TenantTable 适配进来，判定口径零分叉。
//
// ---- one 身份的可达面清单（2026-11-09 定，2026-11-11 A-P1-5 按实测重写；
// 新增端点评审对照）---------------------------------------------------------
// 旧版头注说豁免端点「不泄露逐租户业务数据」，实测不成立（按 id 取得到别家
// 工件、能给别家工件铸分享链、/__fb/state 回juli反馈正文、settings 回全量
// tenants 声明）。现行事实分四类：
//
// 1. one 身份 404 的运营面（http/helpers.ts 的 operatorFaceBlocked，all 原样）：
//    stats/dashboard、villa leads 与 deploy-requests、customers 全读面、
//    parties、feedback-mirror status/log、settings 读写（含 judgment）、ops
//    全族（/api/ops/*）、chat 主线程编排器（/api/chat 与语音 call/confirm/
//    deny）、租户认领。
// 2. 按属主收口的面（one 只见/只动本租户；他租户与不存在同响应）：
//    读面全体（A2）、单子/步骤/会话的写动词与建单口（A-P1-4，见
//    http/routes/lifecycle.ts 的 ownerBlocked）、工件取件与分享铸链
//    （artifacts.workflow_id → 单子租户；带有效签名的分享链接照旧放行）。
// 3. 带租户身份即拒的公开口：曾为 /__fb/*（官网挂件免密口）——2026-11-13
//    已整体摘除（零使用方：新 webapp 未迁反馈抽屉、villa 走自家服务器、
//    juli-site/iOS 不调），该类现无成员；恢复时按「挂 /api 鉴权 + 带令牌」
//    重做，不得复活免密公开口。
// 4. 仍对 one 身份开放、且没有按租户过滤的面：ai/status、ai/check、channels、
//    email/status、pipelines（含 pipeline/authz）、skills、snapshot/recover、
//    feedback-self 写面、反馈墙写面、feedback-mirror sync/ingest、villa/sync。
//    这一类不是「没有逐租户数据」：skills 的用量按会话名聚合（看得到别家
//    会话名），snapshot/recover 面向全部会话，pipeline/authz 是全局收件授权
//    名单。眼下租户头是客户端自报、系统里只有操作员一人，所以先留着；租户
//    账号接入前必须逐个过一遍（归到第 1 类或第 2 类）。
//
// 新增端点评审：默认进第 2 类（按属主收口）或第 1 类（404）；要进第 4 类必须
// 写明它回的数据里没有任何一家租户的业务内容。
// 编排器（第 1 类里的 chat 主线程）没有做「按租户过滤的工具集」，只是对 one
// 身份整体不开放；它的文件工具以数据目录为根，同理。
//
// ---- 账面租户与执行会话可分叉的残留面（2026-11-09 A3 评审 F3/F4）-----------
// tenant 列是账面归属，执行会话由路由与引擎守卫另行决定。下列五种形状里两者
// 可以不一致：
//   1. 改道不补 stamp。stamp 只在建单时判一次（basis=default 的邮件单路由后另
//      有一次 session 兜底）。之后的落点判定（邮件进件路由、派发时刻 routeTask、
//      忙闲改道、jev 兜底改道、resolveSession 别名落回）只改执行会话，不回写
//      tenant。其中邮件进件路由与 resolveSession 落回不经守卫，能落到别租户的
//      会话。
//   2. pinned / resolved_session 不复查。守卫只约束空会话兜底与各条改道的候选，
//      步上已有的会话（播种的 session、人钉的 session_pinned、上次落点
//      resolved_session）派发时不再对单子租户复查。
//   3. 认领不改 pinned。认领端点只改 tenant 列与 meta.tenant_basis，已钉进步里
//      的会话原样保留，认领改的是账面，不改执行落点。
//   4. 未声明租户 guard=null。单子租户查不到 defaultSessionFor 时
//      tenantGuardFor 返回 null，引擎对这张单不收口。
//   5. 缺省模式全体。无 tenants 声明时 runtime 不接 deps.tenants，守卫恒为
//      null，A3 写侧却仍按内置存量信号打 acme 标。
// 这些缺口靠认领端点（POST /api/lifecycle/workflows/:id/tenant）与 A1 回填兜底。
// 缺省模式另有一处可见性落差。parseTenantScope 只认声明表里的租户，缺省模式
// 只有 internal，所以打了 acme 标的行只在 all 视图（无头 operator）可见，
// X-Juli-Tenant: acme 回 400。

import type { LifecycleStore } from '@juli-os/ledger';

/** 请求租户两态：one=只见该租户；all=全视角（operator / 旧客户端缺省）。 */
export type TenantScope =
  | { readonly kind: 'one'; readonly tenant: string }
  | { readonly kind: 'all' };

/** A1 登记表的最小结构投影（runtime 从 platform/config/tenants.ts 适配）。 */
export interface TenantTableShape {
  /** 会话名 → 租户 id（byAgent/bySession）；未声明的会话 = undefined。 */
  readonly tenantOfSession: (session: string) => string | undefined;
  /** 租户 → 该租户 default_session（internal = 全局 default_session）。 */
  readonly defaultSessionFor: (tenant: string) => string | undefined;
}

/** 解析请求租户：缺省或 'all' → all；声明的租户 id → one；未声明的 id →
 * 抛错（HTTP 层回 400 点名，WS 层拒连）。纯函数，边界校验的唯一入口。 */
export const parseTenantScope = (
  headerValue: string | undefined,
  declaredTenants: readonly string[],
): TenantScope => {
  const v = (headerValue ?? '').trim();
  if (v === '' || v === 'all') return { kind: 'all' };
  if (declaredTenants.includes(v)) return { kind: 'one', tenant: v };
  throw new Error(`未知租户 "${v}"——X-Juli-Tenant 须为声明租户之一（${declaredTenants.join('、')}）或 all`);
};

/** one/all 的统一判谓：tenant=null 表示「无租户归属」的内容，只进 all。 */
export const scopeSees = (scope: TenantScope, tenant: string | null): boolean =>
  scope.kind === 'all' || (tenant !== null && tenant === scope.tenant);

// ---- 引擎侧（按单子租户，无请求上下文）---------------------------------------

/** 引擎租户守卫：把一张单子的 tenant 变成会话候选/落点的边界谓词。
 * guard=null = 不收口（引擎未接登记表，或单子租户不是声明租户——缺省
 * 模式回填 stamp 的存量行），行为与 A2 之前完全一致。 */
export interface TenantGuard {
  readonly tenant: string;
  /** 会话属于本单租户（bySession 反查）。 */
  readonly covers: (session: string) => boolean;
  /** 本租户 default_session（A1 表；internal = 全局 default_session）。 */
  readonly defaultSession: () => string;
}

export const tenantGuardFor = (
  table: TenantTableShape | undefined,
  wfTenant: string,
): TenantGuard | null => {
  if (table === undefined) return null;
  const ds = table.defaultSessionFor(wfTenant);
  if (ds === undefined) return null; // 未声明租户：缺省模式存量 stamp 行不收口
  return {
    tenant: wfTenant,
    covers: (s) => table.tenantOfSession(s) === wfTenant,
    defaultSession: () => ds,
  };
};

/** 候选会话按租户收口（guard=null 原样透传——全视角零行为变化）。 */
export const candidatesInTenant = <T extends { readonly session: string }>(
  guard: TenantGuard | null,
  candidates: readonly T[],
): readonly T[] => (guard === null ? candidates : candidates.filter((a) => guard.covers(a.session)));

// ---- 事件侧（SSE / 账本 events 列表共用同一谓词）-----------------------------

export interface EventTenantDeps {
  readonly getWorkflow: (id: string) => { readonly tenant: string } | null;
  readonly getStep: (id: string) => { readonly workflowId: string } | null;
}

/** 账本事件的租户归属：workflow/step 事件按 entity 查租户（一次查库，P3
 * 实测每页开销 0.3ms 量级）；agent/judgment 事件无单子归属，只进 all
 * （返回 null）。查无实体（已修剪/孤儿）同样只进 all——宁可少推不外泄。 */
export const eventTenant = (
  deps: EventTenantDeps,
  ev: { readonly entityType: string; readonly entityId: string },
): string | null => {
  if (ev.entityType === 'workflow') return deps.getWorkflow(ev.entityId)?.tenant ?? null;
  if (ev.entityType === 'step') {
    const st = deps.getStep(ev.entityId);
    return st === null ? null : (deps.getWorkflow(st.workflowId)?.tenant ?? null);
  }
  return null;
};

// ---- 账本读视图（开单助手只读工具的取数面）-----------------------------------

export type TenantReadStore = Pick<LifecycleStore, 'listWorkflows' | 'getWorkflow' | 'stepsForWorkflow' | 'lastEventAt'>;

/** 租户收口的账本读视图：listWorkflows 下推 tenant 参数（store 0.2.0 已支
 * 持）；getWorkflow 越租户回 null（工具层转 found:false）。tenant=null =
 * 全视角，原样返回 store。stepsForWorkflow 不另收口——调用方只在单子可见
 * 之后才取步（getTask 先过 getWorkflow）。 */
export const tenantReadView = (store: TenantReadStore, tenant: string | null): TenantReadStore =>
  tenant === null ? store : {
    listWorkflows: (limit, status) => store.listWorkflows(limit, status, tenant),
    getWorkflow: (id) => {
      const w = store.getWorkflow(id);
      return w !== null && w.tenant === tenant ? w : null;
    },
    stepsForWorkflow: (id) => store.stepsForWorkflow(id),
    lastEventAt: (t, id) => store.lastEventAt(t, id),
  };
