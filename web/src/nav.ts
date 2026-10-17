// 公开投影桩：与私仓同形，双侧 typecheck 兜底防漂移。
// 私仓本文件是左栏导航分组表（五组全量）；公开投影未含看板/路由图/客户/
// 统计/编排台/治理/反馈墙/外部系统视图（MVP 砍面），桩为公开四组。

/** 导航分组：label + 平铺条目（label, route）；core=核心组置顶强化
 * （私仓 2026-10-14 用户裁决，公开投影暂无 core 组但接口同形）。 */
export interface NavGroup {
  readonly label: string;
  readonly core?: boolean;
  readonly items: ReadonlyArray<readonly [label: string, route: string]>;
}

export const NAV_GROUPS: ReadonlyArray<NavGroup> = [
  { label: '工作台', items: [['总览', '/dashboard'], ['流水', '/lifecycle']] },
  { label: '入口', items: [['发单', '/chat']] },
  { label: '运行', items: [['会话', '/sessions'], ['模板', '/flow']] },
  { label: '系统', items: [['设置', '/settings']] },
];
