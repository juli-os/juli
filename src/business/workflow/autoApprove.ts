// 闸门自动批准（2026-10-07 用户裁定「有的 workflow 不需要我干预/批准」）：
// 周期 sweep 扫 waiting_human 的 gate 步 → 规则匹配 → 复用 approve 正门
// （by='juli-auto'，决策/步事件/回流全链路既有审计原样吃到）。
//
// 安全边界三条（本文件钉死，规则配置覆盖不了）：
//  1. 问询闸门（input.question_options 非空）永不自动批——「自动回答问题」
//     语义不成立，问询要的答案只有人有；
//  2. 发送闸门（gateDelivery==='email'，真实外发）默认不在自动面内，须
//     命中的规则显式 include_send=true；
//  3. mode=shadow 只留痕（gate_auto_approve_shadow 事件 + 日志）不动作——
//     照 hold/alert_grade 影子先行惯例，先看规则咬得对不对再开 on。
// 周期 sweep 而非挂 step 播种点：一条代码路径同时兜住「新到闸门」与
// 「开规则时的存量在等闸门」（用户现在排队的那些就是存量）。

import { gateDelivery } from '../send/sendSeed.ts';
import { WORKFLOW_STATUSES } from '../../contracts/statuses.ts';
import type { JsonRecord } from '../../platform/shared/json.ts';
import type { LifecycleStore } from '../../platform/ledger/store.ts';
import type { Logger } from '../../platform/events/bus.ts';
import type { Workflow } from '../../contracts/entities.ts';
import type { Step } from '../../contracts/entities.ts';

export interface AutoApproveRule {
  readonly id: string;
  readonly kind?: string;
  readonly session?: string;
  readonly internal?: boolean;
  readonly titleContains?: string;
  readonly includeSend: boolean;
}

export interface AutoApproveConfig {
  readonly mode: 'off' | 'shadow' | 'on';
  readonly rules: readonly AutoApproveRule[];
}

/** 从 config 的 auto_approve 原始对象安全投影（settings 热改入口共用）。 */
export const projectAutoApprove = (v: unknown): AutoApproveConfig => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return { mode: 'off', rules: [] };
  const o = v as Record<string, unknown>;
  const mode = o['mode'] === 'on' || o['mode'] === 'shadow' ? o['mode'] : 'off';
  const rules: AutoApproveRule[] = [];
  if (Array.isArray(o['rules'])) {
    for (const r of o['rules']) {
      if (r === null || typeof r !== 'object' || Array.isArray(r)) continue;
      const rr = r as Record<string, unknown>;
      rules.push({
        id: typeof rr['id'] === 'string' ? rr['id'] : `rule-${rules.length + 1}`,
        ...(typeof rr['kind'] === 'string' && rr['kind'] !== '' ? { kind: rr['kind'] } : {}),
        ...(typeof rr['session'] === 'string' && rr['session'] !== '' ? { session: rr['session'] } : {}),
        ...(rr['internal'] === true ? { internal: true } : {}),
        ...(typeof rr['title_contains'] === 'string' && rr['title_contains'] !== '' ? { titleContains: rr['title_contains'] } : {}),
        includeSend: rr['include_send'] === true,
      });
    }
  }
  return { mode, rules };
};

export interface AutoApproveCtx {
  readonly kind: string;
  readonly title: string;
  /** 落点会话（session/assigned_session 双键并集取第一个非空）。 */
  readonly session: string;
  /** 外部发件人（meta.from；空=内部单）。 */
  readonly sender: string;
  /** 闸门交付方式（email=真实外发）。 */
  readonly delivery: string;
  /** 问询闸门（input.question_options 非空）。 */
  readonly isQuestion: boolean;
}

/** 匹配器（纯函数）：返回命中的规则或 null。硬排除优先于规则。 */
export const matchAutoApprove = (cfg: AutoApproveConfig, ctx: AutoApproveCtx): AutoApproveRule | null => {
  if (cfg.mode === 'off' || cfg.rules.length === 0) return null;
  if (ctx.isQuestion) return null; // 硬边界①：问询闸门永不自动批
  for (const r of cfg.rules) {
    if (r.kind !== undefined && r.kind !== ctx.kind) continue;
    if (r.session !== undefined && r.session !== ctx.session) continue;
    if (r.internal === true && ctx.sender !== '') continue;
    if (r.titleContains !== undefined && !ctx.title.toLowerCase().includes(r.titleContains.toLowerCase())) continue;
    if (ctx.delivery === 'email' && !r.includeSend) continue; // 硬边界②：发送闸门须显式授权
    return r;
  }
  return null;
};

const TERMINAL = new Set(WORKFLOW_STATUSES.filter((s) => s.terminal).map((s) => s.key as string));

/** 单子级免批的等价规则（include_send=false——外发邮件仍等人）。 */
const PER_ORDER_RULE: AutoApproveRule = { id: '本单免批', includeSend: false };

const ctxOf = (w: Workflow, gate: Step): AutoApproveCtx => {
  const input = (gate.input ?? {}) as JsonRecord;
  const assigned = typeof w.meta?.['assigned_session'] === 'string' ? (w.meta['assigned_session'] as string) : '';
  const q = input['question_options'];
  const session = (w.session ?? '') !== '' ? (w.session ?? '') : assigned;
  return {
    kind: w.kind,
    title: w.title,
    session,
    sender: typeof w.meta?.['from'] === 'string' ? (w.meta['from'] as string) : '',
    delivery: gateDelivery(input),
    isQuestion: Array.isArray(q) && q.length > 0,
  };
};

/** 单步 sweep 的说明文案（approve note 与事件共用）。 */
const ruleNote = (r: AutoApproveRule): string => {
  const parts: string[] = [];
  if (r.kind !== undefined) parts.push(`kind=${r.kind}`);
  if (r.session !== undefined) parts.push(`session=${r.session}`);
  if (r.internal === true) parts.push('内部单');
  if (r.titleContains !== undefined) parts.push(`标题含「${r.titleContains}」`);
  if (r.includeSend) parts.push('含发送闸门');
  return `规则 ${r.id}${parts.length > 0 ? `（${parts.join(' · ')}）` : ''}`;
};

export interface AutoApproveSweepDeps {
  readonly store: Pick<LifecycleStore, 'listWorkflows' | 'stepsForWorkflow' | 'appendEvent'>;
  /** approve 正门（engine gateActions.approve——by='juli-auto' 全审计）。 */
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
    // 明确说过「不用问我」）；硬边界（问询/外发）仍然钉死——同 config 路径。
    const perOrder = (w.meta?.['auto_approve'] ?? null) === true;
    for (const st of deps.store.stepsForWorkflow(w.id)) {
      if (st.kind !== 'gate' || st.status !== 'waiting_human') continue;
      const ctx = ctxOf(w, st);
      const rule = perOrder ? PER_ORDER_RULE : matchAutoApprove(cfg, ctx);
      if (rule === null) continue;
      if (ctx.isQuestion) continue; // 硬边界①双保险（per-order 路径必须重判）
      if (ctx.delivery === 'email' && !rule.includeSend) continue; // 硬边界②
      const note = `自动批准：${ruleNote(rule)}`;
      if (cfg.mode === 'shadow') {
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
