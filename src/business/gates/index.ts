// gates 域（2026-11-12 第 5 步独立成域）：一切需要人拍板的事的统一登记面。
//
// 管什么：拍板卡的登记与审计（gate_items）、统一待决列表的投影、自动批准
// 规则引擎（显式表+匹配器+sweep，三条红线钉死在 rules.ts 权威注释）、六动词
// （approve/deny/resolve/rework/align/amend——amend 归 rework 族=补料）。
// 三种 kind：workflow_gate（工作流审批闸）、chat_confirm（开单对话计划确认
// 卡）、agent_ask（agent 问询卡=delivery:'answer' 的问询闸）。
// 依赖谁：@juli-os/basin（gates.db）、账本只读投影（waiting_human 步）；
// 动词的执行不复刻审批逻辑——转发既有 engine 正门（宪法级路径不动）。
// 数据主权：gate_items 是登记与审计面，不是第二事实源——步级闸真身在
// workflow_steps（waiting_human），列表读侧实时投影 + 本表 open 的
// chat_confirm 叠加；决策动作落审计行。
// start()/stop() 约定：sweep 定时器（30s 心跳 + boot 即扫）已归域 gates/timers.ts
// （2026-11-12 第 7 步）——runtime 只递初值与热改句柄，不再自己驱动。
import { openGatesStore, type GatesStore, type GateKind, type GateVerb, type GateItem, GATE_VERBS } from './store.ts';
export { openGatesStore, GATE_VERBS };
export type { GatesStore, GateKind, GateVerb, GateItem };

export {
  projectAutoApprove, matchAutoApprove, ctxOf, ruleNote, PER_ORDER_RULE, BUILTIN_RULES,
  type AutoApproveRule, type AutoApproveConfig, type AutoApproveCtx,
} from './rules.ts';
export { autoApproveSweep, type AutoApproveSweepDeps } from './sweep.ts';

import type { LifecycleStore, Workflow } from '@juli-os/ledger';

/** 统一待决列表的一行（投影形状——前端与角标的数据源）。 */
export interface GateView {
  readonly id: string;
  readonly kind: GateKind;
  readonly workflowId: string;
  readonly workflowTitle: string;
  readonly stepId: string;
  readonly title: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly tenant: string;
}

/** 统一待决列表：实时投影账本 waiting_human 闸步（workflow_gate/agent_ask），
 * 叠加 gates 库 open 的 chat_confirm。步级闸不落库即所见——登记表只补
 * 账本没有的 kind 与决策审计。 */
export const listGates = (
  store: Pick<LifecycleStore, 'listWorkflows' | 'stepsForWorkflow'>,
  gates: GatesStore,
): readonly GateView[] => {
  const out: GateView[] = [];
  const byWf = new Map<string, Workflow>();
  for (const w of store.listWorkflows(2000)) {
    byWf.set(w.id, w);
    for (const st of store.stepsForWorkflow(w.id)) {
      if (st.kind !== 'gate' || st.status !== 'waiting_human') continue;
      const isAsk = Array.isArray(st.input['question_options']) && (st.input['question_options'] as unknown[]).length > 0;
      out.push({
        id: st.id,
        kind: isAsk ? 'agent_ask' : 'workflow_gate',
        workflowId: w.id,
        workflowTitle: w.title,
        stepId: st.id,
        title: st.title,
        payload: st.input,
        createdAt: st.updatedAt,
        tenant: w.tenant,
      });
    }
  }
  for (const item of gates.list('open', 200)) {
    if (item.kind !== 'chat_confirm') continue; // 步级闸走投影，不重复叠
    out.push({
      id: item.id,
      kind: item.kind,
      workflowId: item.workflowId,
      workflowTitle: '',
      stepId: item.stepId,
      title: item.title,
      payload: item.payload,
      createdAt: item.createdAt,
      tenant: typeof item.payload['tenant'] === 'string' ? item.payload['tenant'] : '',
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};
