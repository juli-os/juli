// 自动批准 sweep（gates 域）：周期扫 waiting_human 的 gate 步 → 规则匹配 →
// 复用 approve 正门（by='juli-auto'，红线③）。2026-11-12 第 5 步从
// business/workflow/autoApprove.ts 搬入，行为逐字保留。
// 周期 sweep 而非挂 step 播种点：一条代码路径同时兜住「新到闸门」与
// 「开规则时的存量在等闸门」。

import { WORKFLOW_STATUSES } from '../../contracts/statuses.ts';
import type { LifecycleStore } from '@juli-os/ledger';
import type { Logger } from '../../platform/events/bus.ts';
import { matchAutoApprove, ctxOf, ruleNote, PER_ORDER_RULE, type AutoApproveConfig } from './rules.ts';

const TERMINAL = new Set(WORKFLOW_STATUSES.filter((s) => s.terminal).map((s) => s.key));

export interface AutoApproveSweepDeps {
  readonly store: Pick<LifecycleStore, 'listWorkflows' | 'stepsForWorkflow' | 'appendEvent'>;
  /** approve 正门（engine gateActions.approve——by='juli-auto' 全审计，红线③）。 */
  readonly approve: (stepId: string, note: string, by: string) => Promise<void>;
  readonly config: () => AutoApproveConfig;
  readonly log: Logger;
}

/** 扫一遍全部在等闸门：匹配即批（on）或留痕（shadow）。返回处理的闸门数。 */
export const autoApproveSweep = async (deps: AutoApproveSweepDeps): Promise<number> => {
  // 注意：off 早退不能有——单子级免批（meta.auto_approve）无视全局 mode；
  // config 路径的 off 由 matchAutoApprove 自身判空。
  const cfg = deps.config();
  let acted = 0;
  for (const w of deps.store.listWorkflows(2000)) {
    if (TERMINAL.has(w.status)) continue;
    // 单子级免批标记（2026-10-07 用户裁定：前端按单开关，不走全局配置）：
    // meta.auto_approve===true 时无视 config mode 直接进自动面（人在这单上
    // 明确说过「不用问我」）；硬边界（问询①/外发②）仍然钉死——同 config 路径。
    const perOrder = w.meta['auto_approve'] === true;
    for (const st of deps.store.stepsForWorkflow(w.id)) {
      if (st.kind !== 'gate' || st.status !== 'waiting_human') continue;
      const ctx = ctxOf(w, st);
      const rule = perOrder ? PER_ORDER_RULE : matchAutoApprove(cfg, ctx);
      if (rule === null) continue;
      if (ctx.isQuestion) continue; // 红线①双保险（per-order 路径必须重判）
      // 红线②双保险（per-order 路径必须重判）：没显式申报 apply / artifact 的
      // 审批一律不批（2026-11-24 审查修复中由协调者裁定，为什么见 rules.ts 文件头）。此前只认
      // delivery==='email'，「本单免批」能把没申报的发送审批直接批出去。
      if (ctx.isSend && !rule.includeSend) continue;
      const note = `自动批准：${ruleNote(rule)}`;
      // shadow 只拦规则路径：per-order 是人在这单上的明确指令（「不用问我」），
      // 人的意志即批准——观察模式不拦截（2026-10-28 R&R 对齐注释声明）。
      if (!perOrder && cfg.mode === 'shadow') {
        deps.store.appendEvent('workflow', w.id, 'gate_auto_approve_shadow', { gate: st.title, step_id: st.id, note });
        deps.log.info(`[auto-approve][shadow] ${w.id}「${st.title}」将被自动批准——${ruleNote(rule)}`);
        acted++;
        continue;
      }
      try {
        await deps.approve(st.id, note, 'juli-auto');
        deps.store.appendEvent('workflow', w.id, 'gate_auto_approved', { gate: st.title, step_id: st.id, rule: rule.id, by: 'juli-auto' });
        deps.log.info(`[auto-approve] ${w.id}「${st.title}」已自动批准——${ruleNote(rule)}`);
        acted++;
      } catch (e) {
        // 竞态（人刚批过/步已推进）或 approve 守卫拒——逐步隔离，不炸整轮。
        deps.log.warn(`[auto-approve] ${w.id}「${st.title}」批准失败（下轮再判）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return acted;
};
