// 任务读模型（2026-09-29 ontology 落地最小切片）：任务是认知单元——账本
// 里的 runs 按「任务卡挂链 > Thread > 孤单」聚成一张任务卡，状态是任务
// 相位（从成员执行派生），路由/看板/客户等视图都是它的投影。
//
// 这是纯读法：数据全部来自既有端点（workflows2 + task-map），引擎零改动、
// 零新表。规则集中在此一处，看板是第一个消费方（手机卡后续同一投影）。
//
// 状态判定不是「从事件推导」——是任务相位的显式规则：在跑 > 排队；
// 全终态后「办成 > 被否 > 失败 > 取消」。failed 可 retry 翻回、deny 回修
// 只是相位，这些语义留在 run 层，任务层只认最终结局。
//
// 本模块零 DOM 依赖（statuses.ts 同款纪律），vitest 直接可测。

import {
  kanbanColumnOf, workflowStatusDef,
} from './statuses.ts';

/** 任务成员（run）最小形状：workflows2 行的子集——分组/锚点/相位只吃这些。 */
export interface TaskRunLike {
  readonly id: string;
  readonly status: string;
  readonly kind?: string;
  readonly title?: string;
  readonly session?: string;
  readonly thread_id?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly waiting_steps?: number;
  readonly created_at: string;
  readonly updated_at?: string;
}

/** task-map 端点最小形状（kanban/lifecycle 共用端点，此处只依赖归属面）。 */
export interface TaskMapLike {
  readonly tasks: readonly { readonly id: string; readonly title: string }[];
  readonly map: Readonly<Record<string, string>>;
}

/** 任务卡读模型：看板卡的唯一主语。 */
export interface TaskCardModel {
  /** 分组键：t:<任务卡id> / th:<thread_id> / w:<runId>（孤立单自成一事）。 */
  readonly key: string;
  /** 身份来源：任务卡挂链 / 邮件线程 / 孤单。 */
  readonly kind: 'task' | 'thread' | 'solo';
  /** 任务卡 workflow id；'' = 无任务卡（thread/solo 组）。 */
  readonly taskId: string;
  /** 展示主语（已剥回复/转发前缀）。 */
  readonly title: string;
  /** 成员执行，新→旧（账本序）。 */
  readonly runs: readonly TaskRunLike[];
  /** 执行链锚点：成员会话名去重（新→旧）。 */
  readonly sessions: readonly string[];
  /** 来源链锚点：最新非空 meta.from（发件人邮箱）；'' = 无。 */
  readonly customer: string;
}

/** 展示侧主题去噪：剥回复/转发前缀（「回复：Re: PPT 需求」→「PPT 需求」）。
 * 与引擎进件匹配的归一化对齐（engine.ts normalizeThreadSubject），但展示
 * 保留原大小写——小写是匹配键，不是人话。web 不引 src，持对齐副本。 */
const THREAD_SUBJECT_PREFIX = /^(?:回复|答复|回覆|转发|re|fw|fwd|aw|sv)\s*[:：]\s*/i;
export const displayTitleOf = (title: string): string => {
  let cur = title.trim();
  for (;;) {
    const next = cur.replace(THREAD_SUBJECT_PREFIX, '').trim();
    if (next === cur || next === '') break;
    cur = next;
  }
  return cur;
};

/** run → 任务分组键：任务卡挂链优先（人建的事最大），Thread 次之（邮件
 * 事的容器），都不是 = 孤单自成一事。 */
export const taskKeyOf = (w: TaskRunLike, taskMap: TaskMapLike): string => {
  const t = taskMap.map[w.id] ?? '';
  if (t !== '') return `t:${t}`;
  return w.thread_id !== undefined && w.thread_id !== '' ? `th:${w.thread_id}` : `w:${w.id}`;
};

/** 排序键：成员最新一封的 meta.date（缺省 created_at）——与看板既有口径
 * 一致（邮件世界的时间是发信时间，不是入库时间）。输入需新→旧。 */
export const taskSortKeyOf = (task: TaskCardModel): string => {
  for (const r of task.runs) {
    const d = r.meta?.['date'];
    if (typeof d === 'string' && d !== '') return d;
  }
  return task.runs[0]?.created_at ?? '';
};

/** 任务相位（从成员执行派生）：优先级在跑 > 排队；全终态后办成 > 被否 >
 * 失败 > 取消；名单外状态兜原样（视图归「其他」不隐藏）。 */
export const taskStatusOf = (
  runs: readonly TaskRunLike[],
): { readonly status: string; readonly waitingSteps: number } => {
  const waitingSteps = runs.reduce((n, r) => n + (r.waiting_steps ?? 0), 0);
  const has = (s: string): boolean => runs.some((r) => r.status === s);
  if (has('running')) return { status: 'running', waitingSteps };
  if (has('queued')) return { status: 'queued', waitingSteps };
  if (has('completed')) return { status: 'completed', waitingSteps };
  if (has('rejected')) return { status: 'rejected', waitingSteps };
  if (has('failed')) return { status: 'failed', waitingSteps };
  if (has('cancelled')) return { status: 'cancelled', waitingSteps };
  return { status: runs[0]?.status ?? '', waitingSteps };
};

/** 任务 → 看板列键：相位经 kanbanColumnOf（单一列源）——waiting 步数让
 * 进行中任务落「等你决定」列，cancelled 落归档区，未知态落「其他」。 */
export const taskColumnOf = (task: TaskCardModel): string => {
  const { status, waitingSteps } = taskStatusOf(task.runs);
  return kanbanColumnOf({ status, waiting_steps: waitingSteps });
};

/** 任务列计数（总览统计卡与看板分桶的唯一计数器——任务口径）：
 * 同一份任务卡列表，总览的数字 = 看板各列的卡数，物理同源（同一函数）。
 * 注：窗口语义——计数只反映传入的任务卡（dashboard/kanban 同为 limit=100
 * 窗口）；窗口外的老成员不参与相位，窗口滑动可能让同任务换列，这是视图
 * 窗口的既定语义（与旧 thread 归组一致），非缺陷。 */
export const countByColumn = (tasks: readonly TaskCardModel[]): Readonly<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (const t of tasks) {
    const k = taskColumnOf(t);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

/** 是否已知名单态（名单外状态归「其他」列，标题显原文）。 */
export const isKnownStatus = (s: string): boolean => workflowStatusDef(s) !== undefined;

/** runs → 任务卡列表（新→旧）。同键成员按传入序收拢；任务标题取任务卡
 * 自身，thread/solo 取最新成员主题（剥前缀）。 */
export const buildTaskCards = (
  wfs: readonly TaskRunLike[],
  taskMap: TaskMapLike,
): TaskCardModel[] => {
  const groups = new Map<string, TaskRunLike[]>();
  const order: string[] = [];
  for (const w of wfs) {
    const k = taskKeyOf(w, taskMap);
    const g = groups.get(k);
    if (g === undefined) { groups.set(k, [w]); order.push(k); }
    else g.push(w);
  }
  const taskTitle = (taskId: string): string =>
    taskMap.tasks.find((t) => t.id === taskId)?.title ?? '';
  return order.map((k) => {
    const runs = groups.get(k)!;
    const kind: TaskCardModel['kind'] = k.startsWith('t:') ? 'task' : k.startsWith('th:') ? 'thread' : 'solo';
    const taskId = kind === 'task' ? k.slice(2) : '';
    const title = displayTitleOf(
      (kind === 'task' ? taskTitle(taskId) : '') || (runs[0]?.title ?? ''),
    );
    const sessions: string[] = [];
    for (const r of runs) {
      if (r.session !== undefined && r.session !== '' && !sessions.includes(r.session)) sessions.push(r.session);
    }
    let customer = '';
    for (const r of runs) {
      const f = r.meta?.['from'];
      if (typeof f === 'string' && f !== '') { customer = f; break; }
    }
    return { key: k, kind, taskId, title, runs, sessions, customer };
  }).sort((a, b) => taskSortKeyOf(b).localeCompare(taskSortKeyOf(a)));
};
