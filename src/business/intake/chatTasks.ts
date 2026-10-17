// chat 白名单工具的账本读模型实现（R8 批4 刀2，自 runtime.ts 下放）：chatTools.ts
// 只做工具薄封装（读函数经 ChatToolDeps 注入），这里给 list_tasks/get_task 两个
// 读函数的「真实现」——检索窗口规则（50/2000/100 魔数 + 用户裁定语境）与单子
// 全息聚合（usageAggOf 单一事实源）不再是组合根本体，可脱离 runtime 直测。
// 语义逐字保持（2026-10-14 用户裁定「找单子只能找 20 太少」语境原样保留）。

import { WORKFLOW_STATUSES } from '../../contracts/statuses.ts';
import { usageAggOf } from '../workflow/costContext.ts';
import type { ChatTaskDetail, ChatTaskRow } from './chatTools.ts';
import type { ArtifactLedger } from '@juli-os/artifacts';
import type { LifecycleStore, UsageStore } from '@juli-os/ledger';

/** 终态集合（contracts/statuses 唯一名单派生——与 runtime 装配侧同一来源）。 */
const TERMINAL_STATUSES = new Set(
  WORKFLOW_STATUSES.filter((s) => s.terminal).map((s) => s.key),
);

/** 账本读模型依赖（runtime 注入真 store/usage/artifactLedger；测试可字面量直构）。 */
export interface ChatTaskQueriesDeps {
  readonly store: Pick<LifecycleStore, 'listWorkflows' | 'getWorkflow' | 'stepsForWorkflow' | 'lastEventAt'>;
  readonly usage: Pick<UsageStore, 'perSessionWindows' | 'sessionWindowsPriced'>;
  readonly artifacts: Pick<ArtifactLedger, 'list'>;
}

/** list_tasks 读模型：检索窗口规则本体。
 * recent+关键词=深窗检索（窗 2000，对齐 feedbackIntake dedup 先例）：
 * 「找单子」的真实需求是跨历史（上周/上月的跟进单），最近一批罩不住
 * （2026-10-14 用户裁定「找单子只能找 20 太少」）；无关键词=常规窗。 */
export const listTasksOf = (deps: ChatTaskQueriesDeps) =>
  (scope: 'inflight' | 'recent', limit: number, q: string): readonly ChatTaskRow[] => {
    const win = scope === 'inflight' ? 50 : q !== '' ? 2000 : Math.max(limit, 100);
    const needle = q.toLowerCase();
    return deps.store.listWorkflows(win)
      .filter((w) => scope !== 'inflight' || !TERMINAL_STATUSES.has(w.status))
      .filter((w) => needle === '' || w.title.toLowerCase().includes(needle) || w.id.includes(needle))
      .slice(0, limit)
      .map((w) => ({ id: w.id, title: w.title, status: w.status, updatedAt: w.updatedAt }));
  };

/** get_task 读模型：单子全息（2026-10-07 白名单扩容）。usageAggOf 单一事实源
 * ——与详情 usageCost/cost-stats/统计归属率同口径（计费窗口含 approve 后回流
 * 执行段；无价物纪律出 null 不猜价）。 */
export const getTaskOf = (deps: ChatTaskQueriesDeps) =>
  async (wfId: string): Promise<ChatTaskDetail | null> => {
    const w = deps.store.getWorkflow(wfId);
    if (!w) return null;
    const steps = deps.store.stepsForWorkflow(w.id);
    const agg = usageAggOf(deps.store, deps.usage, w);
    const waiting = steps.find((st) => st.status === 'waiting_human');
    return {
      id: w.id, title: w.title, status: w.status, kind: w.kind,
      createdAt: w.createdAt, updatedAt: w.updatedAt, session: w.session ?? '',
      steps: steps.map((st) => ({ seq: st.seq, kind: st.kind, title: st.title, status: st.status, updatedAt: st.updatedAt })),
      waitingOn: waiting !== undefined ? waiting.title : '',
      deliverables: deps.artifacts.list(w.id).map((a) => ({ name: a.name, role: a.role })),
      prompts: agg.prompts, costCny: agg.costCny,
    };
  };
