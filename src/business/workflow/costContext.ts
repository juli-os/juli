// 每单计价/归属上下文（wf_6a74fc4a23e4 抽出为公共件）：详情 usageCost、
// cost-stats、stats dashboard 的归属率三方共用，单一实现防口径漂移。
// R8 批3 再收敛：四方调用形（getTask/详情/cost-stats/统计归属率）原先各自
// 手写「costContextOf 三参 + 逐会话累加 + 计价 + 无价物纪律」，靠注释
// 「四方同源」维系——现统一走 usageAggOf 单一事实源。
//
// 窗口口径（wf_be61c3a55842 计费时点缺陷修复，2026-10-09）：计费是查询时
// 口径（无落账动作），「记账时点」= 窗口终点选择。原口径只取 agent 步
// [started, updated] 并集——闸门 approve 后的回流执行回合（organic，无 step
// 载体）落在所有步窗口之外，实测 wf_56ee12d27e1f 漏计 140 行 / 21.6M input
// tokens（比已计的还多）。修复：窗口 = agent 步并集 ∪ [最后已批闸门完成
// 时刻, run 终点]——「approve 后至 run 真正结束」的消耗（回流执行、收尾
// 汇报）并入本单。run 终点：已终态单 = updated_at（setWorkflowStatus touch，
// 即终态时刻）；在途单 = lastActivityAt（本单事件链 MAX(ts)，调用方注入）。
// 双计权衡：延伸段会把「run 终态前认领会话跑的别单行」一并计入（该会话
// 被 nodes 单认领期间的 organic 回合本就记本单，审计/成本同口径）；现实
// 中会话串行跑单，低频可接受。

import { type LifecycleStore, type UsageCost, type UsageStore } from '@juli-os/ledger';

export interface CostContextStep {
  readonly kind: string;
  readonly status: string;
  readonly startedAt?: string | null;
  readonly updatedAt?: string | null;
  readonly completedAt?: string | null;
}

/** costContextOf 的单子入参面（结构子集：ledger Workflow 满足；测试可字面量
 *  直构，不强求完整 Workflow）。 */
export interface CostWorkflow {
  readonly session?: string | null;
  readonly status?: string;
  readonly meta: Record<string, unknown>;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

/** 归属会话双键（w.session + meta.assigned_session，转派单回合落在实际执行
 * 会话名下）× 窗口并集（tmux 会话串行跑任务卡：步窗口内该会话的回合即本
 * 单）；无步区间（异常/极老单）退化为 [created, updated] 全窗。 */
export const costContextOf = (
  w: CostWorkflow,
  steps: readonly CostContextStep[],
  lastActivityAt = '',
): { sessions: string[]; effWindows: readonly (readonly [string, string])[] } => {
  const assigned = typeof w.meta['assigned_session'] === 'string' ? w.meta['assigned_session'] : '';
  const sessions = [...new Set([w.session ?? '', assigned].filter((s) => s !== ''))];
  const agentSteps = steps.filter((st) => st.kind === 'agent');
  const windows: (readonly [string, string])[] = [];
  for (const st of agentSteps) {
    const a = st.startedAt ?? '';
    const b = st.updatedAt ?? st.completedAt ?? ''; // completedAt 可空，updatedAt 兜底
    if (a !== '' && b !== '') windows.push([a, b]);
  }
  const since = w.createdAt ?? '';
  const until = w.updatedAt ?? since;
  // 无 agent 步区间（异常/极老单）退化为 [created, updated] 全窗——先判退化，
  // 延伸段只在有步窗口的单上并入（退化行为零变化）。
  if (windows.length === 0) {
    return { sessions, effWindows: since !== '' ? [[since, until]] as const : [] };
  }
  // 延伸段（计费时点修复）：首个已批闸门完成 → run 终点。已终态单的终点 =
  // updated_at（终态时刻）；在途单 = lastActivityAt（本单事件链前沿）。
  // 等待期仍不计——闸门批准前的人犹豫期在延伸段之前，天然排除；多轮闸门
  // （rework）中途的等待期无 usage 行，不虚增——取首个而非最后一个，保证
  // 各轮 approve 后的执行段全覆盖。
  const approvedGateAt = steps
    .filter((st) => st.kind === 'gate' && st.status === 'completed')
    .reduce((m, st) => {
      const t = st.updatedAt ?? '';
      return m === '' || (t !== '' && t < m) ? t : m;
    }, '');
  if (approvedGateAt !== '') {
    const active = w.status === 'running' || w.status === 'queued';
    const runEnd = active
      ? (lastActivityAt > (w.updatedAt ?? '') ? lastActivityAt : (w.updatedAt ?? ''))
      : (w.updatedAt ?? '');
    if (runEnd !== '' && runEnd > approvedGateAt) windows.push([approvedGateAt, runEnd]);
  }
  return { sessions, effWindows: windows };
};

/** 单子用量/计价聚合（R8 批3 单一事实源）：窗口（costContextOf）× 归属会话
 * 逐会话 perSessionWindows 累加 × sessionWindowsPriced 计价 × 无价物纪律
 * （b5148a9：纯无价目单成本未知≠0 → costCny 出 null 不猜价），一个函数供
 * runtime getTask / 详情 usageCost / cost-stats / stats 归属率四方调用。 */
export interface WorkflowUsageAgg {
  /** 窗口内归属会话的 claude_code 回合数（Prompt 数）。 */
  readonly prompts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** API 等效计价（同窗口同会话；不在价目的模型只显用量不出价）。 */
  readonly priced: UsageCost;
  /** 无价物纪律：纯无价目单 → null；否则四舍五入到分。 */
  readonly costCny: number | null;
}

export const usageAggOf = (
  store: Pick<LifecycleStore, 'stepsForWorkflow' | 'lastEventAt'>,
  usage: Pick<UsageStore, 'perSessionWindows' | 'sessionWindowsPriced'>,
  w: CostWorkflow & { readonly id: string },
): WorkflowUsageAgg => {
  const { sessions, effWindows } = costContextOf(w, store.stepsForWorkflow(w.id), store.lastEventAt('workflow', w.id));
  let prompts = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const s of sessions) {
    const r = usage.perSessionWindows(s, effWindows);
    prompts += r.count;
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
  }
  const priced = usage.sessionWindowsPriced(sessions, effWindows);
  const costCny = priced.unpricedModels.length > 0 && priced.totalCny.total <= 0
    ? null : Math.round(priced.totalCny.total * 100) / 100;
  return { prompts, inputTokens, outputTokens, priced, costCny };
};
