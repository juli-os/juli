// triage：邮件结构化抽取 + 会话路由。输出停在闸门 1——人审先于一切 agent。
// 判定分工（triage_classify，2026-09-27 用户口令，jev 第三场景）：category/
// needs_reply 是纯判断字段（choice/noul）交类型化判定；summary 是生成字段
// 留在 LLM。shadow=并排判定+对账留痕（LLM 调用原样）；on=高置信采纳判定
// 答案+LLM 瘦身只写 summary/session；判定失败/低置信=原 LLM 全量抽取
// （fail-open 平凡——jev 挂了不许挂进件）。

import { asRecord, asString, truncate, type JsonRecord } from '../../../platform/shared/json.ts';
import { rfc3339, type Clock } from '../../../platform/shared/clock.ts';
import type { Step, Workflow } from '../../../contracts/entities.ts';
import { originalEmail } from '../../../platform/ledger/casefile.ts';
import type { LifecycleStore } from '../../../platform/ledger/store.ts';
import type { JudgmentGateway, LlmPort } from '../../../contracts/ports.ts';
import { parseLoose, type StepCtx } from './common.ts';

const TRIAGE_SYSTEM = `你是邮件信息抽取助手。阅读下面的邮件，输出一个 JSON 对象：
{"category":"任务|咨询|信息同步|其他","summary":"给审批人看的抽取结果与建议执行内容，不超过200字，中文，说清楚这封邮件要什么、建议做什么、在哪个项目/目录做、产出是什么。提到发件人时只使用邮箱地址，严禁猜测或编造姓名","session":"从可用 session 列表中选择最合适的一个（只能从列表里选，严禁编造）","needs_reply":true}
只输出 JSON，不要解释。`;

/** on 采纳后的瘦身提示词：分类/是否需回复已由判定给出，LLM 只写摘要与
 * 路由——省的是推理模型的输出 token（glm-5.3-flash 推理烧 maxTokens）。 */
const TRIAGE_SYSTEM_JEV = `你是邮件摘要助手。分类与是否需回复已由判定系统给出，你只负责摘要与会话路由。阅读下面的邮件，输出一个 JSON 对象：
{"summary":"给审批人看的抽取结果与建议执行内容，不超过200字，中文，说清楚这封邮件要什么、建议做什么、在哪个项目/目录做、产出是什么。提到发件人时只使用邮箱地址，严禁猜测或编造姓名","session":"从可用 session 列表中选择最合适的一个（只能从列表里选，严禁编造）"}
只输出 JSON，不要解释。`;

/** 与 TRIAGE_SYSTEM 的分类集钉死同构（判定答案的引擎侧校验基准）。 */
const CATEGORIES = ['任务', '咨询', '信息同步', '其他'] as const;

const legacySessionOf = (w: Workflow): string => asString(w.meta['session']);
const legacyProjectOf = (w: Workflow): string => asString(w.meta['project']);

/** triage：邮件结构化抽取 + 会话路由。输出停在闸门 1——人审先于一切 agent。 */
export const runTriage = async (ctx: StepCtx, routing: {
  defaultSession: string; defaultProject: string;
}, availableSessions: readonly string[], judgment?: JudgmentGateway): Promise<void> => {
  const { store, step: st, workflow: w } = ctx;
  // 原始邮件以案卷为事实源（不可变）；案卷为空则退回步种子（历史数据）。
  const cf = store.loadCaseFile(w.id);
  let from = '', subject = '', body = '';
  if (Object.keys(cf.original).length > 0) {
    ({ from, subject, body } = originalEmail(cf));
  } else {
    from = asString(st.input['from']);
    subject = asString(st.input['subject']);
    body = asString(st.input['body']);
  }
  const date = asString(st.input['date']);

  // ---- 判定腿（triage_classify）：先问后抽——shadow 的对账事件要带 LLM 侧
  // 答案，得等抽取完成才落账。判定 await 在步内（无 per-workflow 锁外的并发
  // 面），timeout 已被网关夹紧 [1s,30s]。off（ask→null）零网络零留痕。
  // 本步共两问（triage_classify + 尾部 align_needed）——不能合并成一次调用：
  // align_needed 消费的是两次判定之间 LLM 才生成的 summary（顺序依赖）。
  // provider 黑洞的最坏代价=单步 +60s（2×clamp 上界），影子期成本记账见
  // PROBLEMS-20260927-jev-batch2.md P2-7。
  let outcome = null as Awaited<ReturnType<JudgmentGateway['ask']>>;
  if (judgment !== undefined) {
    outcome = await judgment.ask('triage_classify',
      { from, subject, date, body: body.slice(0, 2000) },
      {
        category: {
          type: 'choice',
          instructions: 'Classify this inbound email for a work-management system.',
          criteria: {
            '任务': 'Requests work to be done (produce/modify a deliverable, run a process).',
            '咨询': 'Asks a question or requests information; answering it is the work.',
            '信息同步': 'Informs or updates without requesting action or an answer.',
            '其他': 'None of the above (greetings, notifications, spam).',
          },
        },
        needs_reply: {
          type: 'noul',
          instructions: 'Does this email ask for or expect a response from the recipient?',
        },
      });
  }
  const jCat = outcome?.answers?.['category'];
  const jRep = outcome?.answers?.['needs_reply'];
  const usageOf = (o: NonNullable<typeof outcome>): JsonRecord => ({
    model: o.model ?? '', input_tokens: o.inputTokens ?? 0, output_tokens: o.outputTokens ?? 0, duration_ms: o.durationMs ?? 0,
  });
  // 采纳条件（on 模式）：两题都 ok、答案过引擎侧校验（类别在集合内、回复是
  // 布尔极性）且置信 ≥ 阈值——「typed judgment 只做输入，决定留引擎」。
  const applied = outcome !== null && outcome.ok && outcome.mode === 'on'
    && jCat?.answer !== undefined && (CATEGORIES as readonly string[]).includes(jCat.answer)
    && (jCat.confidence ?? 0) >= outcome.threshold
    && (jRep?.answer === 'true' || jRep?.answer === 'false')
    && (jRep?.confidence ?? 0) >= outcome.threshold;
  if (outcome !== null && !outcome.ok) {
    ctx.stepEvent(st, 'triage_judgment', { mode: outcome.mode, scenario: 'triage_classify', error: outcome.error ?? '', ...usageOf(outcome) });
  } else if (outcome !== null && outcome.mode === 'on') {
    if (applied) {
      ctx.stepEvent(st, 'triage_judgment_applied', {
        category: jCat!.answer ?? '', category_confidence: jCat!.confidence ?? 0,
        needs_reply: jRep!.answer ?? '', needs_reply_confidence: jRep!.confidence ?? 0,
        provider: outcome.provider, ...usageOf(outcome),
      });
    } else {
      ctx.stepEvent(st, 'triage_judgment_rejected', {
        category: jCat?.answer ?? '', category_confidence: jCat?.confidence ?? 0,
        needs_reply: jRep?.answer ?? '', needs_reply_confidence: jRep?.confidence ?? 0,
        provider: outcome.provider, ...usageOf(outcome),
      });
    }
  }

  let userPrompt = `发件人: ${from}\n主题: ${subject}\n时间: ${date}\n\n正文:\n${body}`;
  if (availableSessions.length > 0) {
    userPrompt += '\n\n可用 session 列表（session 字段必须从这里选）：\n'
      + availableSessions.map((a) => `- ${a}`).join('\n') + '\n';
  }
  // 4096：glm-5.3-flash 是推理模型，长邮件正文下 1024 会被推理 token 烧光
  // → content 空（"openai: empty response"）。与 draft 同一教训（见 runDraft）。
  const raw = await ctx.completeLlm(applied ? TRIAGE_SYSTEM_JEV : TRIAGE_SYSTEM, userPrompt, 4096, undefined, `wf:${w.id}/step:triage`);
  const out = parseLoose(raw);
  const llmSession = asString(out['session']).trim();

  // 路由是程序的决策：配置默认值优先，LLM 只做兜底（它会编造看似合理但
  // 不存在的会话名，派发容不得猜）。
  let session = routing.defaultSession.trim();
  if (session === '') session = llmSession;
  if (session === '') session = legacySessionOf(w);
  if (session === '') throw new Error(`no target session (default empty, llm="${llmSession}")`);
  const project = routing.defaultProject || legacyProjectOf(w);

  // 分类/回复：on 采纳时取判定答案（引擎已校验），否则取 LLM 抽取。
  const category = applied ? jCat!.answer! : asString(out['category']);
  const needsReplyRaw = out['needs_reply'];
  const llmNeedsReply = needsReplyRaw === null || needsReplyRaw === undefined
    ? true : needsReplyRaw !== false;
  const needsReply = applied ? jRep!.answer === 'true' : llmNeedsReply;

  // shadow 对账（判定完成后落账）：jev×LLM 同题对答案+一致旗——影子期的
  // 核心产出。LLM 抛错时本事件不落（步已 failed，判定侧证据在 applied/
  // rejected/error 分支——shadow 无这三类，属已知取舍）。
  if (outcome !== null && outcome.ok && outcome.mode === 'shadow') {
    ctx.stepEvent(st, 'triage_judgment', {
      mode: 'shadow', scenario: 'triage_classify', provider: outcome.provider,
      jev_category: jCat?.answer ?? '', jev_category_confidence: jCat?.confidence ?? 0,
      jev_needs_reply: jRep?.answer ?? '', jev_needs_reply_confidence: jRep?.confidence ?? 0,
      llm_category: asString(out['category']), llm_needs_reply: llmNeedsReply,
      agree_category: jCat?.answer === asString(out['category']),
      agree_needs_reply: jRep?.answer === String(llmNeedsReply),
      ...usageOf(outcome),
    });
  }

  store.setStepOutput(st.id, {
    category, summary: asString(out['summary']),
    session, needs_reply: needsReply,
  });
  store.setWorkflowRouting(w.id, session, project);
  // 给下一步（闸门 1）播种待审内容。
  const steps = store.stepsForWorkflow(w.id);
  const next = steps[st.seq];
  if (next) store.setStepInput(next.id, {
    plan: asString(out['summary']), category, session,
  });

  // 理解保真度判定（align_needed，2026-09-27，影子先行）：triage 摘要是否
  // 忠实反映邮件意图（无添加/遗漏/扭曲）——给闸门审批人的并行信号。on+高
  // 置信不忠实=闸门 input 打 align_flag 提示重点核对（只标注，人审照常）。
  if (judgment !== undefined) {
    const outcome = await judgment.ask('align_needed',
      { subject, body: body.slice(0, 1200), summary: asString(out['summary']).slice(0, 500) },
      {
        fidelity: {
          type: 'noul',
          instructions: "Does the summary faithfully reflect what the email asks for, without adding, omitting, or distorting the sender's intent?",
        },
      });
    if (outcome !== null && outcome.ok) {
      const p = { mode: outcome.mode, scenario: 'align_needed', answer: outcome.answer ?? '', confidence: outcome.confidence ?? 0, provider: outcome.provider, model: outcome.model ?? '', input_tokens: outcome.inputTokens ?? 0, output_tokens: outcome.outputTokens ?? 0, duration_ms: outcome.durationMs ?? 0 };
      if (outcome.mode === 'on' && outcome.answer === 'false' && (outcome.confidence ?? 0) >= outcome.threshold) {
        ctx.stepEvent(st, 'align_flagged', p);
        if (next) store.setStepInput(next.id, { align_flag: true, align_confidence: outcome.confidence ?? 0 });
      } else {
        ctx.stepEvent(st, 'align_judgment', p);
      }
    } else if (outcome !== null) {
      ctx.stepEvent(st, 'align_judgment', { mode: outcome.mode, scenario: 'align_needed', error: outcome.error ?? '' });
    }
  }
};
