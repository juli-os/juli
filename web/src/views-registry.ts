// 公开投影桩：与私仓同形，双侧 typecheck 兜底防漂移。
// 私仓本文件是 main.ts hash 路由表单一事实源（全量视图 + 默认页 /route）
// ——公开投影未含看板/路由图/客户/统计/编排台/治理/反馈墙/外部系统视图
// （MVP 砍面），桩为公开子集 + /dashboard 默认页。main.ts 组合零改动即可
// 在两侧编译；web build 过=桩与 main.ts 的契约对上的硬证据。

import { dashboardView } from './views/dashboard.ts';
import { lifecycleView } from './views/lifecycle.ts';
import { flowView } from './views/flow.ts';
import { sessionsView } from './views/sessions.ts';
import { settingsView } from './views/settings.ts';
import { chatView } from './views/chat.ts';

/** 视图函数形态：挂载到容器，返回可选清理回调（SSE/定时器的关闭口）。 */
export type ViewFn = (el: HTMLElement) => (() => void) | void | Promise<(() => void) | void>;

/** hash 路由表：route → 视图（或旧深链重定向）。 */
export const ROUTES: Record<string, ViewFn> = {
  '/dashboard': dashboardView,
  '/chat': chatView,
  // trigger 表单已退役（2026-09-29 用户裁决：发单=对话）；旧深链重定向不死链
  '/trigger': () => { location.replace('#/chat'); },
  '/lifecycle': lifecycleView,
  // 单子聚焦视图（2026-10-07 驾驶舱二期）：#/order?w=ID = 流水详情的 solo
  // 形态（ordersolo 隐左目录/费用面板，详情吃满）；无 w 参数退化为整页流水。
  '/order': lifecycleView,
  '/flow': flowView,
  '/sessions': sessionsView,
  '/settings': settingsView,
};

/** 默认首页（无 hash 时）：公开投影=总览。 */
export const DEFAULT_ROUTE = '/dashboard';

/** 未知路由兜底视图：与默认首页同视图。 */
export const FALLBACK_VIEW: ViewFn = dashboardView;
