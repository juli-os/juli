// draft：从已审定的执行产出起草回信（读案卷的累积上下文，非接力种子）。

import { asString, truncate } from '../../../platform/shared/json.ts'
import { asRecord } from '@juli-os/artifacts'
import { originalEmail } from '@juli-os/ledger';
import { parseLoose, type StepCtx } from './common.ts';

// 落款/人称/披露规则与 ~/.claude/skills/juli-reply/SKILL.md §0/§3/§4 对齐；改动须两处同步（skill §7）。
// 人格映射：ethan→Acme（落款副标「AI 助理 For Acme」）；新企业线=先改映射（两处）再上线。
const DRAFT_SYSTEM = `你是商务邮件助理。基于原始邮件和已经人工审核确认的执行产出，用中文起草一封简洁、礼貌、可直接发出的回信。
内容硬性要求：回信必须包含执行产出的关键事实——具体的进展、数据、结论或发现（例如"已完成 X，结果是 Y"）。严禁只写"已收到/正在整理中/稍后回复"这类没有任何实质内容的空话；如果产出确实还没有可用结果，必须明确说明原因和预计完成时间。
语言红线（严格遵守）：客户可见文本严禁出现内部账务与流程词汇——run 号、扣例、例、Care、triage、intake、feedback ID、workflow、闸门等；严禁出现价格、例数、计费承诺；讲结果与价值，不讲过程与工时。
交付红线：回信的读者是邮件外部的用户——严禁出现本地文件路径（/Users/…、~/.makro/…、/private/tmp/…）或内部系统、内部目录名；产出的文件以给定的外部链接交付。
护栏与线程：事实性陈述须能溯源到执行产出，拿不准的写「正在核实」并给时间，不猜测。
称呼规则（严格遵守）：只使用原始邮件 From 字段里的邮箱地址或其中显示的名称来称呼收件人；原文没有可靠姓名时用「你好」，严禁编造或推测任何中文姓名。全文人称统一用「你」，不用「您」。落款红线：不得使用原邮件正文里出现的任何人名、昵称或签名——那是对方的署名，不是我们的。落款由引擎统一拼装：你的草稿写到正文要点为止，严禁自己写落款/署名/此致敬礼/披露行——写了也会被引擎剥掉（「举例科技」漂移事故的教训）。
正文为纯文本：称呼+要点，不要 markdown。身份公开：AI 助理身份由引擎落款披露，不要解释"这是自动回复"，不要描述内部流程。只输出 JSON：
{"draft":"回信全文"}
只输出 JSON。`;

/** draft：从已审定的执行产出起草回信（读案卷的累积上下文，非接力种子）。 */
export const runDraft = async (ctx: StepCtx): Promise<void> => {
  const { store, step: st, workflow: w } = ctx;
  const cf = store.loadCaseFile(w.id);
  // 产出候选优先级：output（上游步直接携带）→ evidence（nodes 模式 deliver
  // 动作的交付证据——juli deliver --evidence 的落点）→ 案卷 executions。
  // evidence 缺位曾是死键：CLI 传了、draft 不读，LLM 输入为空。
  let execOut = asString(st.input['output']);
  if (execOut.trim() === '') execOut = asString(st.input['evidence']);
  if (execOut.trim() === '') {
    const outs: string[] = [];
    for (const ex of cf.executions) {
      const s = asString(asRecord(ex)['output']);
      if (s !== '') outs.push(s);
    }
    if (outs.length > 0) execOut = outs.join('\n\n---\n\n');
  }

  // 原始邮件：案卷优先（不可变），退回首步 input。
  let email: Record<string, string> = {};
  if (Object.keys(cf.original).length > 0) {
    const o = originalEmail(cf);
    email = { from: o.from, subject: o.subject, body: o.body };
  } else {
    const first = store.stepsForWorkflow(w.id)[0];
    if (first) {
      for (const k of ['from', 'subject', 'date', 'body'] as const) {
        const v = asString(first.input[k]);
        if (v !== '') email[k] = v;
      }
    }
  }

  const draftInput = `原始邮件:\n${JSON.stringify(email)}\n\n已审核的执行产出:\n${truncate(execOut, 4000)}`;
  const raw = await ctx.completeLlm(DRAFT_SYSTEM, draftInput, 4096, undefined, `wf:${w.id}/step:draft`); // GLM 推理模型会烧推理 token，1024 不够
  const out = parseLoose(raw);
  const draft = asString(out['draft']);
  if (draft.trim() === '') throw new Error('empty draft');
  store.setStepOutput(st.id, { draft });
  const steps = store.stepsForWorkflow(w.id);
  const next = steps[st.seq];
  if (next) store.setStepInput(next.id, { draft });
};

