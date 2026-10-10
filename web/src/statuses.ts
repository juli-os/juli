// 状态唯一名单（web 对齐副本）+ 视图派生纯函数。单一事实源在
// src/contracts/statuses.ts——web 不引 src（结构宪法），此处持字面副本，
// test/statuses.test.ts 强制两份逐字对齐 + 消费端只用这里派生的列/计数。
//
// 本模块零 DOM 依赖（routing-dag/layout.ts 同款纪律），vitest 直接可测：
// - kanbanColumnOf：卡片 → 列（未知状态进「其他」，不隐藏——走查实证的
//   「总览失败 1、看板找不到失败单」就是各自手写清单漂移的产物）。
// - 总览统计同源：2026-09-29 起统计卡吃【任务口径】（task-model.ts
//   countByColumn + taskColumnOf），run 级 countByStatus 已随之退役删除——
//   同源断言移驻 test/task-model.test.ts。

/** 语义分组：进行中（账上在走）/ 等决定（卡在人）/ 终态（收口）。 */
export type StatusGroup = '进行中' | '等决定' | '终态';

export interface StatusDef {
  /** 账本原文（英文 mono）。 */
  readonly key: string;
  /** 中文名（走查语言规约：状态=中文名）。 */
  readonly label: string;
  /** 语义分组；名单外一律归「其他」（STATUS_GROUP_OTHER）。 */
  readonly group: StatusGroup;
  /** 终态 = 进入即收口。 */
  readonly terminal: boolean;
}

/** 名单外状态的分组名：未知状态显示原文并归入「其他」，不隐藏。 */
export const STATUS_GROUP_OTHER = '其他';

/** 流水（workflow）状态名单，序 = 看板列序/过滤序。与 src/contracts/statuses.ts
 * 对齐（测试强制）；与 src/contracts/entities.ts 的 WorkflowStatus 一一对应。 */
export const WORKFLOW_STATUSES: readonly StatusDef[] = [
  { key: 'queued', label: '排队中', group: '进行中', terminal: false },
  { key: 'running', label: '进行中', group: '进行中', terminal: false },
  { key: 'completed', label: '已完成', group: '终态', terminal: true },
  { key: 'failed', label: '失败', group: '终态', terminal: true },
  { key: 'cancelled', label: '已取消', group: '终态', terminal: true },
  { key: 'rejected', label: '已拒绝', group: '终态', terminal: true },
];

/** 步骤（workflow_steps）状态名单。waiting_human（等你决定）是【步态】——
 * 账本里 workflow.status 永远不会是它，看板「等你决定」列是投影列。 */
export const STEP_STATUSES: readonly StatusDef[] = [
  { key: 'pending', label: '待排', group: '进行中', terminal: false },
  { key: 'running', label: '进行中', group: '进行中', terminal: false },
  { key: 'waiting_human', label: '等你决定', group: '等决定', terminal: false },
  { key: 'completed', label: '已完成', group: '终态', terminal: true },
  { key: 'failed', label: '失败', group: '终态', terminal: true },
  { key: 'cancelled', label: '已取消', group: '终态', terminal: true },
  { key: 'skipped', label: '已跳过', group: '终态', terminal: true },
];

/** 查名单：命中返回定义，名单外返回 undefined（调用方兜「其他」）。 */
export const workflowStatusDef = (key: string): StatusDef | undefined =>
  WORKFLOW_STATUSES.find((s) => s.key === key);

export const stepStatusDef = (key: string): StatusDef | undefined =>
  STEP_STATUSES.find((s) => s.key === key);

/** 状态 → 中文标签：名单外原样返回 key（显示原文，不猜不译）。 */
export const statusLabelOf = (key: string): string => workflowStatusDef(key)?.label ?? key;

/** 状态 → 语义分组：名单外归「其他」。 */
export const statusGroupOf = (key: string): string => workflowStatusDef(key)?.group ?? STATUS_GROUP_OTHER;

/** 全状态中文释义表（workflow ∪ step；ui.ts STATUS_LABEL 由它派生——
 * 徽标/chip/图例不再有第二份手写清单）。 */
export const ALL_STATUS_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  [...WORKFLOW_STATUSES, ...STEP_STATUSES].map((s) => [s.key, s.label]),
);

// ---- 看板列生成（纯函数）------------------------------------------------

export interface KanbanColumn {
  /** 列键（buckets key）：名单态用原文，投影/兜底列用合成键。 */
  readonly key: string;
  /** 列头中文名。 */
  readonly label: string;
  /** 列头状态点着色用的状态 key；'' = 中性点（其他列）。 */
  readonly status: string;
  /** CSS 列类（.kb-col-*）。 */
  readonly cls: string;
}

/** 合成列键：等你决定（步态投影）/ 其他（名单外）/ 归档（已取消折叠区）。 */
export const KANBAN_WAITING_KEY = 'waiting';
export const KANBAN_OTHER_KEY = 'other';
export const KANBAN_ARCHIVE_KEY = 'archived';

/** 名单 → 看板列（纯函数，看板唯一列源）：
 * - 非终态名单序在前：排队中 → 【等你决定（投影列：running 单含 waiting 步，
 *   板面第一视觉，走查语言）】→ ……非终态名单态各成一列；
 * - 终态名单序在后：已完成 → 失败（走查痛点列，从此结构性存在）→ 已拒绝；
 * - 已取消 = 归档折叠区（产品裁决：默认收起，不占列）；
 * - 名单外未知状态 → 「其他」列（显示原文，不隐藏）。 */
export const kanbanColumnsFromStatuses = (statuses: readonly StatusDef[]): readonly KanbanColumn[] => {
  const active = statuses.filter((s) => !s.terminal).map((s) => ({
    key: s.key, label: s.label, status: s.key, cls: `kb-col-${s.key}`,
  }));
  const terminal = statuses.filter((s) => s.terminal && s.key !== 'cancelled').map((s) => ({
    key: s.key, label: s.label, status: s.key, cls: `kb-col-${s.key}`,
  }));
  // 「等你决定」投影列插在排队中之后（板 03 第一视觉位）；名单无排队态时
  // 退到最前——投影列的存在不依赖名单顺序细节。
  const waitingCol: KanbanColumn = {
    key: KANBAN_WAITING_KEY, label: '等你决定', status: 'waiting_human', cls: `kb-col-${KANBAN_WAITING_KEY}`,
  };
  const queuedIdx = active.findIndex((c) => c.key === 'queued');
  const at = queuedIdx < 0 ? 0 : queuedIdx + 1;
  const withWaiting = [...active.slice(0, at), waitingCol, ...active.slice(at)];
  return [
    ...withWaiting,
    ...terminal,
    { key: KANBAN_OTHER_KEY, label: '其他', status: '', cls: `kb-col-${KANBAN_OTHER_KEY}` },
  ];
};

/** 看板列（名单现行值）：kanban.ts 只消费这份，不再手写。 */
export const KANBAN_COLUMNS: readonly KanbanColumn[] = kanbanColumnsFromStatuses(WORKFLOW_STATUSES);

/** 卡片 → 列键（纯函数）：
 * - queued → 排队中；running → 有 waiting 步 = 等你决定（投影），否则进行中；
 *   workflow.status=waiting_human（防御分支，账本不产生）同归等你决定；
 * - 名单终态各归同名列；cancelled → 归档折叠区；
 * - 名单外未知状态 → 「其他」（不隐藏）。 */
export const kanbanColumnOf = (w: { readonly status: string; readonly waiting_steps?: number }): string => {
  if (w.status === 'queued') return 'queued';
  if (w.status === 'waiting_human') return KANBAN_WAITING_KEY;
  if (w.status === 'running') return (w.waiting_steps ?? 0) > 0 ? KANBAN_WAITING_KEY : 'running';
  const def = workflowStatusDef(w.status);
  if (def === undefined) return KANBAN_OTHER_KEY;
  if (def.terminal) return w.status === 'cancelled' ? KANBAN_ARCHIVE_KEY : w.status;
  return w.status;
};

// ---- 计数 ---------------------------------------------------------------
// 总览统计同源已上收任务口径（2026-09-29）：dashboard 统计卡与 kanban 分桶
// 共吃 task-model.ts 的 countByColumn/taskColumnOf（run 级 countByStatus
// 退役删除，同源断言在 test/task-model.test.ts）。

// ---- 流水目录过滤（lifecycle）-------------------------------------------

/** 流水目录筛选 chips（全部 + 名单序）。已取消不占格（产品裁决：归档语义
 * 走看板折叠区，总览/流水目录同步隐藏）；waiting_human 是步态投影、账本
 * workflow.status 永不为它——旧手写清单里的这颗 chip 永远筛出空集，按名单
 * 移除（漂移实证之一）。 */
export const LIFECYCLE_FILTERS: ReadonlyArray<readonly [key: string, label: string]> = [
  ['', '全部'],
  ...WORKFLOW_STATUSES.filter((s) => s.key !== 'cancelled').map((s) => [s.key, s.label] as const),
  // 已取消（2026-09-28）：终止单必须可寻回——用户在流水页点「中止」后单子
  // 从所有默认视图消失（「全部」折叠取消 + 看板归档默认收起），「找不到了」
  // 实录。取消是终态不是蒸发：这里给显式入口，审计/回看有路。
  ['cancelled', '已取消'],
];

// ---- 当前步推导（dashboard/kanban 共用，2026-09-22 收口）----------------
// 此前两视图各持一份逐字双副本（连注释都一样）——优先级是产品裁决（等人
// 的单最扎眼），名单化后改优先级只动这里。

/** 当前步优先级：等人 > 在跑 > 失败 > 待排；全终态则取末步。 */
export const CURRENT_PRIORITY: readonly string[] = ['waiting_human', 'running', 'failed', 'pending'];

/** 一条流水的「当前步」：按优先级取第一档里 seq 最小的；全部不在档取
 * seq 最大（末步）。steps 需按该流水全步骤喂入。 */
export const currentStepOf = <T extends { readonly step: { readonly status: string; readonly seq?: number } }>(
  steps: readonly T[],
): T | undefined => {
  for (const st of CURRENT_PRIORITY) {
    const hit = steps.filter((r) => r.step.status === st).sort((a, b) => (a.step.seq ?? 0) - (b.step.seq ?? 0))[0];
    if (hit !== undefined) return hit;
  }
  return [...steps].sort((a, b) => (b.step.seq ?? 0) - (a.step.seq ?? 0))[0];
};
