// 每单计价/归属上下文（wf_6a74fc4a23e4 抽出为公共件）：详情 usageCost、
// cost-stats、stats dashboard 的归属率三方共用，单一实现防口径漂移。
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

export interface CostContextStep {
  readonly kind: string;
  readonly status: string;
  readonly startedAt?: string | null;
  readonly updatedAt?: string | null;
  readonly completedAt?: string | null;
}

/** 归属会话双键（w.session + meta.assigned_session，转派单回合落在实际执行
 * 会话名下）× 窗口并集（tmux 会话串行跑任务卡：步窗口内该会话的回合即本
 * 单）；无步区间（异常/极老单）退化为 [created, updated] 全窗。 */
export const costContextOf = (
  w: { session?: string | null; status?: string; meta: Record<string, unknown>; createdAt?: string; updatedAt?: string },
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
