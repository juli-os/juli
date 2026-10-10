// 引擎纯助手（零闭包依赖）：常量 / 任务卡模板 / 附件宣称判据 / feedback 单
// 判据。可被任意引擎子模块与测试直接引用。

import { asString } from '../../platform/shared/json.ts'
import { type Step, type Workflow } from '@juli-os/ledger';
import { isLiveNodeStatus } from '../../contracts/statuses.ts';
import type { JsonRecord } from '@juli-os/artifacts'

export const DEFAULT_ZOMBIE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_MAX_ZOMBIE_ATTEMPTS = 3;
export const LLM_TIMEOUT_MS = 180_000;

/** 进件首节点任务卡（理解 Stage）：manifest 时代由模板阶梯承担的"读原文"
 * 一步，动态模型里是唯一的静态入口——之后每步都由 agent/skill/人追加。
 * 完成后按 juli-reply 契约请求对齐（agent 只提案，闸门原语在引擎）。 */
export const INTAKE_PROMPT = `[任务] 阅读下面这封来信，输出结构化理解：诉求清单 / 已核实事实 / 疑点 / 计划建议。
完成后按 juli-reply 契约处理：需要人先对齐理解的，追加对齐闸门（POST /api/lifecycle/workflows/<本流>/nodes，kind=gate，title=对齐闸门）再收工；判断无需对齐的，说明理由后直接进入执行/答复准备。
若判断这封信的业务不归属本会话（对照 GET /api/agents/graph 里声明的 domain），用 task-handoff 转派：npx tsx cli/juli.ts（仓根相对） handoff <domain> --reason 一句话——转派后本步收工即可，后续由专科会话接手。

[来信]
主题：{{.Input.subject}}
发件：{{.Input.from}}
发件人姓名：{{.Input.from_name}}

称呼纪律（陈莉君事故 2026-10-01，用户裁定）：回信称呼只用这封信自带的名字——上面的发件人姓名；没有就直接用邮箱地址（用英文没有关系）。绝不搜索、绝不猜测、绝不音译——拿不准宁可称呼邮箱地址，错的称呼比生疏的称呼严重得多。

{{.Input.body}}`;

export const gateSummary = (st: Step): string =>
  asString(st.input['draft']) || asString(st.input['plan']) || st.title;

/** 工作区锚定：任务卡头部钉上项目名与绝对路径——agent 的相对路径有了唯一
 * 解释基准（ACP 同步与 tmux 异步两条派发路径共用同一措辞）。ws 空 = 不锚。 */
export const anchorPlan = (session: string, ws: string, plan: string): string =>
  ws === '' ? plan : `[工作区] 项目: ${session} ｜ 路径: ${ws} ｜ 所有相对路径均基于此目录。\n\n${plan}`;

// 附件存在性宣称（wf_e4013364bc8d）：只认「存在性宣称」句式——裸「附件」
// 会误伤「无附件/没有附件」表述。
const ATTACHMENT_CLAIM = /见附件|随信附上|附[上下]|附件(?:为|是|包含|包括|共)|attachment|attached/i;
// 引用对方措辞的收执句（第 5 轮审查）：「您随信附上的合同已收到」是引用对方
// 附来的东西，不是自己要发附件。窄共现排除：只豁免「你/您（随信）附上的 +
// ≤30 字 + 已收到/已查收/收悉」这一种句式；剥掉收执句后再判宣称——同正文
// 还自宣称附件（如「详见附件」）时剥完仍命中、照样拦（错拦不错发不变）。
const QUOTED_RECEIPT = /(您|你)(随信)?附[上下]的[^。\n]{0,30}(已收到|已查收|收悉)/g;
export const claimsAttachment = (body: string): boolean =>
  ATTACHMENT_CLAIM.test(body) && ATTACHMENT_CLAIM.test(body.replace(QUOTED_RECEIPT, ''));

/** feedback 单锚（template_input.feedback_record_id）：进件单的身份键。 */
export const feedbackRecordIdOf = (w: Workflow): string => {
  const ti = w.meta['template_input'];
  return ti !== null && typeof ti === 'object' && !Array.isArray(ti)
    ? asString((ti as JsonRecord)['feedback_record_id']) : '';
};

/** 闸门信封申报的 feedback 记录 id 列表（agent 自挂与自愈补挂的确认闸都写
 * envelope.feedback_refs）。approve 回流的「拍板=状态翻转」指令以此判定
 * 本闸是否 feedback 闸——非 feedback 闸零影响。 */
export const feedbackRefsOf = (input: JsonRecord): readonly string[] => {
  const env = input['envelope'];
  const refs = env !== null && typeof env === 'object' && !Array.isArray(env)
    ? (env as JsonRecord)['feedback_refs'] : null;
  return Array.isArray(refs) ? refs.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
};

/** 任务卡文本里的交付申报（skill 契约句式 input.delivery="apply"）：自愈
 * 补闸与存量回填判「apply 单」的共用判据——此时闸门尚不存在，delivery
 * 只活在任务卡文本里（宪法 §2 由 skill 写进 brief）；闸门在位后以
 * gateDelivery 判型衔接。 */
export const briefDeclaresApply = (brief: string): boolean => brief.includes('input.delivery="apply"');

/** 链上有存活闸门（未 failed/cancelled 的 gate）：自愈补闸与存量回填的
 * 幂等守卫同口径——已有活闸就不补。 */
export const hasLiveGate = (steps: readonly Step[]): boolean =>
  steps.some((s) => s.kind === 'gate' && isLiveNodeStatus(s.status));
