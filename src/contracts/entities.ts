// 生命周期账本的领域类型。全部 readonly：状态转变 = 显式函数写库（store 是
// 唯一可变边界），内存里的对象从不被就地修改。与 Go internal/ledger/lifecycle
// 的表结构逐列对齐（迁移 V1），在途数据可双读。

import type { JsonRecord } from '../platform/shared/json.ts';

export type WorkflowStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'rejected';
/** 终态集合：进入即级联收口在飞 run（queued/running 均为非终态，不收口）。 */
export const TERMINAL_WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
  'completed', 'failed', 'cancelled', 'rejected',
];
export type StepStatus = 'pending' | 'running' | 'waiting_human' | 'completed' | 'failed' | 'cancelled' | 'skipped';
export type StepKind = 'triage' | 'gate' | 'agent' | 'verify' | 'draft' | 'send' | 'llm' | 'share';

export const STEP_KINDS: readonly StepKind[] = [
  'triage', 'gate', 'agent', 'verify', 'draft', 'send', 'llm', 'share',
];

// ---- step kind 能力集（2026-09-22 收口）----------------------------------
// 动词面（intervene/rework/retry-patch/reworkSend）此前各自手写 kind 集合，
// 口径靠巧合一致。集合是语义不是 bug：干预/回修只认真正跑 agent 的步；
// 指令承载面更宽（llm/draft 也吃 plan/prompt）。新增 kind 时在这里归队一次。

/** 跑 agent 的步（可干预/可回修/计入「干活」）：engine intervene/align/
 * reworkSend/assignSession 五处 + store.runningAgentStepForSession 两路 SQL
 * 同口径（SQL 经 sqlInList 消费）。 */
export const AGENT_STEP_KINDS: readonly StepKind[] = ['agent', 'verify'];

/** 能承载指令补丁的步（plan/prompt/session）：engine rework 回扫与 retry
 * patch 两处同口径（llm/draft 也吃指令，但不可插话干预）。 */
export const INSTRUCTABLE_STEP_KINDS: readonly StepKind[] = ['agent', 'verify', 'llm', 'draft'];

export interface Workflow {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: string;
  readonly title: string;
  readonly status: WorkflowStatus;
  readonly session: string;
  readonly project: string;
  readonly path: string;
  /** 对话（Thread）一等建模：同一线邮件往来共享的线程 id。null = 建档前
   * 的历史行或非邮件单。线程根 = 首封邮件自己的 workflow id。 */
  readonly threadId: string | null;
  readonly meta: JsonRecord;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Step {
  readonly id: string;
  readonly workflowId: string;
  readonly seq: number; // 1-based
  readonly kind: StepKind;
  readonly title: string;
  readonly status: StepStatus;
  readonly input: JsonRecord;
  readonly output: JsonRecord;
  readonly summary: string;
  readonly updatedAt: string;
  /** 节点时序：离开 pending 的第一次转变（闸门 waiting_human 也算开跑）。
   * 空串 = 历史行（补列迁移前）或尚未开跑。 */
  readonly startedAt: string;
  /** 终态首次到达时刻；null = 未终结或历史行。 */
  readonly completedAt: string | null;
}

export interface LedgerEvent {
  readonly id: number;
  /** 'agent'=会话运行时遥测（skill_used 等，entityId=会话名）——与
   * judgment 同为「无工作流实体的留痕」，2026-10-02 skill 追溯首用。 */
  readonly entityType: 'workflow' | 'step' | 'judgment' | 'agent';
  readonly entityId: string;
  readonly type: string;
  readonly payload: JsonRecord;
  readonly ts: string;
}

export interface Run {
  readonly id: string;
  readonly workflowId: string;
  readonly session: string;
  readonly status: 'running' | 'idle' | 'completed' | 'failed';
  readonly createdAt: string;
}

export interface Prompt {
  readonly id: string;
  readonly runId: string;
  readonly content: string;
  readonly status: 'submitted' | 'completed' | 'failed';
  readonly createdAt: string;
}

/** Task 投影（第四期最小转正 2026-09-22）：Task 不建新表——「任务卡」=
 * meta.mode='nodes' 的 adhoc 单（engine.startTask 建），挂单经
 * meta.related_workflow（兜底 parent_id）链接。一个 Task = 任务卡 + 链上
 * 归到它的全部流水（含邮件单/跟进执行单）。 */
export interface TaskView {
  /** 任务卡 workflow id（= Task id）。 */
  readonly taskId: string;
  readonly title: string;
  /** 任务卡自身状态（WorkflowStatus）。 */
  readonly status: WorkflowStatus;
  /** 归属本 Task 的全部流水 id（含任务卡自身），新→旧。 */
  readonly workflowIds: readonly string[];
}
