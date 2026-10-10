// Go/iOS 线上形状映射（snake_case 逐字契约的唯一事实源）。
// 消费方：workflows2 列表、workflow 详情、闸门队列（/api/lifecycle/steps）。
// 形状错一个必填键，iOS Codable 解码即整体失败
// （"The data couldn't be read because it is missing"，见 527ce49）——
// 任何形状调整只改这里，并同步 ios-compat 契约测试。

const nonEmpty = (v: unknown): unknown =>
  v === null || v === undefined || v === '' ? undefined : v;

const nonEmptyObject = (v: unknown): unknown =>
  v !== null && typeof v === 'object' && Object.keys(v as object).length > 0 ? v : undefined;

/** Workflow → Go/iOS 列表与详情共用的 snake_case 形状。 */
export const workflowToGo = (
  w: {
    readonly id: string;
    readonly kind: string;
    readonly title: string;
    readonly status: string;
    readonly session?: string | null;
    readonly project?: string | null;
    readonly path?: string | null;
    /** 对话（Thread）归组键（2026-09-21 二期）；null/缺省 = 未建档历史行。 */
    readonly threadId?: string | null;
    readonly meta?: unknown;
    readonly createdAt: string;
    readonly updatedAt: string;
  },
  waitingSteps?: number,
): Record<string, unknown> => ({
  id: w.id,
  kind: w.kind,
  title: w.title,
  status: w.status,
  session: nonEmpty(w.session),
  project: nonEmpty(w.project),
  path: nonEmpty(w.path),
  thread_id: nonEmpty(w.threadId),
  meta: nonEmptyObject(w.meta),
  // 单子级免批（bool 一等字段——iOS meta 解码器不认布尔值，勿只塞 meta）
  auto_approve: (w.meta as Record<string, unknown> | null | undefined)?.['auto_approve'] === true,
  created_at: w.createdAt,
  updated_at: w.updatedAt,
  ...(waitingSteps !== undefined ? { waiting_steps: waitingSteps } : {}),
});

/** Step → Go/iOS 步骤形状。created_at 沿用旧口径（= updated_at，兼容
 * 既有客户端排序）；started_at/completed_at 是节点时序的真数据（离开
 * pending / 到达终态的首次时刻），iOS 端时间线用它而非事件流重放。
 * 入参结构化而非 Pick<Step>：账本对象与 SQL 行两种来源都可直接喂入。 */
export const stepToGo = (
  st: {
    readonly id: string;
    readonly workflowId: string;
    readonly seq: number;
    readonly kind: string;
    readonly title?: string;
    readonly status: string;
    readonly input?: unknown;
    readonly output?: unknown;
    readonly summary?: string;
    readonly updatedAt: string;
    readonly startedAt?: string;
    readonly completedAt?: string | null;
  },
): Record<string, unknown> => ({
  id: st.id,
  workflow_id: st.workflowId,
  seq: st.seq,
  kind: st.kind,
  title: st.title || undefined,
  status: st.status,
  input: nonEmptyObject(st.input),
  output: nonEmptyObject(st.output),
  created_at: st.updatedAt,
  updated_at: st.updatedAt,
  started_at: nonEmpty(st.startedAt ?? '') || undefined,
  completed_at: nonEmpty(st.completedAt ?? '') || undefined,
  summary: st.summary || undefined,
});
