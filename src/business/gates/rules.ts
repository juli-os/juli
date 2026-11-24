// 自动批准规则（gates 域）：显式规则表 + 匹配器 + 配置投影。
// 2026-11-12 第 5 步从 business/workflow/autoApprove.ts 搬入——审批路径是
// 宪法级（juli-constitution §1.4/§4），规则与红线随域走。
//
// ─── 三条红线（权威注释；规则配置覆盖不了，测试反注明按哪条）─────────────
// ① 问询闸门（input.question_options 非空）永不自动批——「自动回答问题」
//    语义不成立，问询要的答案只有人有。测试：auto-approve.test
//    「问询闸门与外发闸门在 sweep 层同样被硬边界拦住」。
// ② 自动批准只放行显式申报为 apply / artifact 的审批（2026-11-24 审查修复中由协调者裁定）。
//    申报 email 的、没申报 delivery 的，一律按发送审批处理：默认不在自动面
//    内，须命中的规则显式 include_send=true——对外发信只有一个出口（宪法
//    §4），自动面不得稀释这个出口的人的在场。
//    判据只有一条（ctxOf 算好放进 ctx.isSend）：申报值不是 apply 也不是
//    artifact。标题、收件人、后面的步骤都不参与。
//    为什么没申报的也不批，而不是只看它后面有没有发信步骤：
//    · 回信流的审批收件人就是来信人（meta.from），常常既没申报收件人、标题
//      也不含「发送」，但批准后下一步就是发信——线上 222 个审批后面跟着发信
//      步，138 个是这形态。引擎自己的 isSendGateDecision（send/sendSeed.ts）
//      认不出它们，所以这条红线故意比它严。
//    · 只看当下的结构会漏：nodes 模式下 agent 可以在任何一个已批准的闸门后面
//      追加发信节点（引擎只查「本单有已批准的闸门」，见 lifecycle.ts appendNode
//      的先审后发校验），而扫描的那一刻后面还没有发信步骤。
//    · 代价为零：10 月起新建的审批全部申报了交付类型，没申报的只有 9 月的
//      存量（203 个）和 10 月初的 1 个。
//    测试：auto-approve.test「红线②（2026-11-24）」一组。
//    沿革：2026-11-23 之前这条只认 delivery==='email'，没申报的发送审批被当成
//    普通审批批掉；先补成「认 isSendGateDecision + 看后面有没有发信步」，次日
//    收成现在这一条。
// ③ by='juli-auto' 全审计——自动批准一律复用 approve 正门（by 恒
//    'juli-auto'），决策/步事件/回流吃既有审计链，另落 gate_auto_approved
//    事件。测试：auto-approve.test「on：命中即走 approve 正门
//    （by=juli-auto）+ 账本留 gate_auto_approved」。
// ─────────────────────────────────────────────────────────────────────

import { gateDelivery } from '../send/sendSeed.ts';
import { type Workflow, type Step } from '@juli-os/ledger';

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

/**
 * 内置显式规则表（每条一行为什么）。用户配置的规则在装配时由
 * projectAutoApprove 投影后与本表合并（用户规则在前，内置殿后）。
 */
export const BUILTIN_RULES: readonly AutoApproveRule[] = [
  // 单子级免批：人在某单上勾过「这单不用再问我」（meta.auto_approve=true）
  // 即视为该单的显式批准意志——任何 kind/session 放行，但两条内容红线
  // （问询①/发送②）依然在匹配器层钉死，人的「不用问」不能替人答问、
  // 也不能替人发信。
  { id: '本单免批', includeSend: false },
];

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
  /** 闸门申报的交付方式（gateDelivery 归一后：没申报、或申报了别的值 → 空串）。 */
  readonly delivery: string;
  /** 发送审批：申报值不是 apply 也不是 artifact——申报 email 的、没申报的
   *  都是（红线②，2026-11-24 审查修复中由协调者裁定，为什么见文件头）。 */
  readonly isSend: boolean;
  /** 问询闸门（input.question_options 非空）。 */
  readonly isQuestion: boolean;
}

/** 匹配器（纯函数）：返回命中的规则或 null。硬排除（红线①②）优先于规则。 */
export const matchAutoApprove = (cfg: AutoApproveConfig, ctx: AutoApproveCtx): AutoApproveRule | null => {
  if (cfg.mode === 'off' || cfg.rules.length === 0) return null;
  if (ctx.isQuestion) return null; // 红线①：问询闸门永不自动批
  for (const r of cfg.rules) {
    if (r.kind !== undefined && r.kind !== ctx.kind) continue;
    if (r.session !== undefined && r.session !== ctx.session) continue;
    if (r.internal === true && ctx.sender !== '') continue;
    if (r.titleContains !== undefined && !ctx.title.toLowerCase().includes(r.titleContains.toLowerCase())) continue;
    if (ctx.isSend && !r.includeSend) continue; // 红线②：发送审批须显式授权
    return r;
  }
  return null;
};

/** 单子级免批的等价规则（显式表形态；sweep 里 meta.auto_approve=true 时启用）。 */
export const PER_ORDER_RULE: AutoApproveRule = BUILTIN_RULES[0]!;

/** 从工作流+闸门步构造匹配上下文。 */
export const ctxOf = (w: Workflow, gate: Step): AutoApproveCtx => {
  const input = gate.input;
  const assigned = typeof w.meta['assigned_session'] === 'string' ? w.meta['assigned_session'] : '';
  const q = input['question_options'];
  const session = w.session !== '' ? w.session : assigned;
  // 红线②：只有显式申报 apply / artifact 才不是发送审批。gateDelivery 把没申报
  // 的、申报了别的值的都归成空串，所以不用再分情况。
  const delivery = gateDelivery(input);
  return {
    kind: w.kind,
    title: w.title,
    session,
    sender: typeof w.meta['from'] === 'string' ? w.meta['from'] : '',
    delivery,
    isSend: delivery !== 'apply' && delivery !== 'artifact',
    isQuestion: Array.isArray(q) && q.length > 0,
  };
};

/** 单步 sweep 的说明文案（approve note 与事件共用）。 */
export const ruleNote = (r: AutoApproveRule): string => {
  const parts: string[] = [];
  if (r.kind !== undefined) parts.push(`kind=${r.kind}`);
  if (r.session !== undefined) parts.push(`session=${r.session}`);
  if (r.internal === true) parts.push('内部单');
  if (r.titleContains !== undefined) parts.push(`标题含「${r.titleContains}」`);
  if (r.includeSend) parts.push('含发送闸门');
  return `规则 ${r.id}${parts.length > 0 ? `（${parts.join(' · ')}）` : ''}`;
};
