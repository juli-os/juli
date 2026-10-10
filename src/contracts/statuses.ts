// 状态唯一名单（第四期 2026-09-22）：全部状态在这里登记一次——key（账本
// 英文 mono 原文）/ 中文标签（走查语言规约：状态=中文名）/ 语义分组（进行中
// /等决定/终态）/ 是否终态。三个消费面（总览统计卡、看板列、流水过滤）从
// 这份名单长出来，不再各自手写清单——走查实证「总览失败 1、看板找不到失败
// 列」的根因就是三处手工清单漂移。
//
// 名单以真实数据为准（2026-09-21 生产库只读取证）：
//   workflows:  cancelled 89 / completed 45 / failed 4
//   workflow_steps DISTINCT: pending / completed / failed / cancelled
// 加上引擎写入路径声明的全集（types.ts 的 WorkflowStatus / StepStatus，其中
// queued/running/rejected、步态 waiting_human/skipped 当前库中为 0 行，但
// 是引擎真实会写的状态——不是发明）。名单外的未知状态：视图显示原文字符串
// 并归入「其他」分组，绝不隐藏。

import type { StepStatus, WorkflowStatus } from './entities.ts';

/** 语义分组：进行中（账上在走）/ 等决定（卡在人）/ 终态（收口）。 */
export type StatusGroup = '进行中' | '等决定' | '终态';

export interface StatusDef {
  /** 账本原文（英文 mono）。 */
  readonly key: string;
  /** 中文名（走查语言规约：状态=中文名）。 */
  readonly label: string;
  /** 语义分组；名单外一律归「其他」（STATUS_GROUP_OTHER）。 */
  readonly group: StatusGroup;
  /** 终态 = 进入即收口（对齐 types.ts TERMINAL_WORKFLOW_STATUSES）。 */
  readonly terminal: boolean;
}

/** 名单外状态的分组名：未知状态显示原文并归入「其他」，不隐藏。 */
export const STATUS_GROUP_OTHER = '其他';

/** key 收窄到账本类型的名单项（satisfies 用：key 对齐 WorkflowStatus 联合，
 * label/group/terminal 对齐 StatusDef——两边都由类型系统锁）。 */
export type WorkflowStatusDef = StatusDef & { readonly key: WorkflowStatus };
export type StepStatusDef = StatusDef & { readonly key: StepStatus };

/** 流水（workflow）状态名单，序 = 看板列序/过滤序。 */
export const WORKFLOW_STATUSES: readonly StatusDef[] = [
  { key: 'queued', label: '排队中', group: '进行中', terminal: false },
  { key: 'running', label: '进行中', group: '进行中', terminal: false },
  { key: 'completed', label: '已完成', group: '终态', terminal: true },
  { key: 'failed', label: '失败', group: '终态', terminal: true },
  { key: 'cancelled', label: '已取消', group: '终态', terminal: true },
  { key: 'rejected', label: '已拒绝', group: '终态', terminal: true },
] satisfies readonly WorkflowStatusDef[];

/** 步骤（workflow_steps）状态名单。waiting_human（等你决定）是【步态】——
 * 账本里 workflow.status 永远不会是它（看板的「等你决定」列是 running 单
 * + waiting 步数的投影，见 web/src/statuses.ts）；名单只收账本真实存在的。 */
export const STEP_STATUSES: readonly StatusDef[] = [
  { key: 'pending', label: '待排', group: '进行中', terminal: false },
  { key: 'running', label: '进行中', group: '进行中', terminal: false },
  { key: 'waiting_human', label: '等你决定', group: '等决定', terminal: false },
  { key: 'completed', label: '已完成', group: '终态', terminal: true },
  { key: 'failed', label: '失败', group: '终态', terminal: true },
  { key: 'cancelled', label: '已取消', group: '终态', terminal: true },
  { key: 'skipped', label: '已跳过', group: '终态', terminal: true },
] satisfies readonly StepStatusDef[];

/** 查名单：命中返回定义，名单外返回 undefined（调用方兜「其他」）。 */
export const workflowStatusDef = (key: string): StatusDef | undefined =>
  WORKFLOW_STATUSES.find((s) => s.key === key);

export const stepStatusDef = (key: string): StatusDef | undefined =>
  STEP_STATUSES.find((s) => s.key === key);

/** 状态 → 中文标签：名单外原样返回 key（显示原文，不猜不译）。 */
export const statusLabelOf = (key: string): string => workflowStatusDef(key)?.label ?? key;

// ---- 状态谓词（从名单派生的单一事实源，2026-09-22 收口）------------------
// 背景：名单第四期收口了「标签/分组」，但「在途/收口/存活」三个语义集合在
// engine（10+ 处）与 store SQL（7+ 处）里仍是手写字面量——历史上已两次事后
// 追补（queued 补进在途、failed 从事故排除中保留），全是手写清单漂移的实证。
// 谓词语义三档，绝不混用：
//   terminal = 状态机终态（进入即不再转变，含 failed——failed 仍可 retry 翻回，
//              但那是动作不是自发转变）；
//   settled  = 收口语义（completed/cancelled，无失败遗留——settle/收口判据，
//              failed 在外因为它是可重试的未决失败，rejected 是人工否决）；
//   active   = 在途（账上还可能自己动）。

/** 在途步集合：pending/running/waiting_human（推进/取消/对账的守卫口径）。 */
export const ACTIVE_STEP_STATUSES: readonly string[] =
  STEP_STATUSES.filter((s) => !s.terminal).map((s) => s.key);
/** 在途单集合：queued/running。 */
export const ACTIVE_WORKFLOW_STATUSES: readonly string[] =
  WORKFLOW_STATUSES.filter((s) => !s.terminal).map((s) => s.key);
/** 收口步集合：completed/cancelled（settle 判据——failed 在外：可重试的未决失败）。 */
export const SETTLED_STEP_STATUSES: readonly string[] =
  STEP_STATUSES.filter((s) => s.key === 'completed' || s.key === 'cancelled').map((s) => s.key);
/** 收口单集合：completed/cancelled。 */
export const SETTLED_WORKFLOW_STATUSES: readonly string[] =
  WORKFLOW_STATUSES.filter((s) => s.key === 'completed' || s.key === 'cancelled').map((s) => s.key);
/** 终态步集合：名单 terminal 标记（completed/failed/cancelled/skipped）。 */
export const TERMINAL_STEP_STATUSES: readonly string[] =
  STEP_STATUSES.filter((s) => s.terminal).map((s) => s.key);
/** dedup 窗口单集合：queued/running + waiting_human（防御值——账本
 * workflow.status 不产生它，历史 SQL 携带；保持原样零语义变化）。 */
export const DEDUP_WINDOW_STATUSES: readonly string[] = ['queued', 'running', 'waiting_human'];
/** prune 单集合：completed/cancelled/rejected——failed 保留（事故取证语义，
 * 2026-09-15 裁决），与 settle 收口集不同档：rejected 人工否决可清，failed 留人查。 */
export const PRUNE_WORKFLOW_STATUSES: readonly string[] = ['completed', 'cancelled', 'rejected'];

export const isActiveStepStatus = (s: string): boolean => ACTIVE_STEP_STATUSES.includes(s);
export const isActiveWorkflowStatus = (s: string): boolean => ACTIVE_WORKFLOW_STATUSES.includes(s);
export const isSettledStepStatus = (s: string): boolean => SETTLED_STEP_STATUSES.includes(s);
export const isSettledWorkflowStatus = (s: string): boolean => SETTLED_WORKFLOW_STATUSES.includes(s);
export const isTerminalStepStatus = (s: string): boolean => TERMINAL_STEP_STATUSES.includes(s);

/** 存活节点（appendNode send/gate 判重口径）：未 failed 且未 cancelled——
 * completed 也算（判重语义：同单已有非失败 send 不建第二封，哪怕首封已发完）。 */
export const isLiveNodeStatus = (s: string): boolean => s !== 'failed' && s !== 'cancelled';

/** 谓词集合 → SQL IN 列表（值全部来自本文件名单常量，无注入面）。 */
export const sqlInList = (keys: readonly string[]): string => keys.map((k) => `'${k}'`).join(',');
