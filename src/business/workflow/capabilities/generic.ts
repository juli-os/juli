// 模板流通用能力：flow 上下文渲染 + 通用 llm 步。
// 灵活性模型：结构=模板，per-step 逻辑=prompt/system，数据流=步骤 id 键控输出。

import { asRecord, asString, truncate, type JsonRecord } from '../../../platform/shared/json.ts';
import { rfc3339, type Clock } from '../../../platform/shared/clock.ts';
import type { Step, Workflow } from '../../../contracts/entities.ts';
import { originalEmail } from '../../../platform/ledger/casefile.ts';
import type { LifecycleStore } from '../../../platform/ledger/store.ts';
import type { LlmPort } from '../../../contracts/ports.ts';
import { parseLoose, type StepCtx } from './common.ts';

/** 流上下文：meta + 已结算步骤（按模板 id 与 stepN 双键）+ Now。 */
export const flowContext = (store: LifecycleStore, workflowId: string, now: Date): Record<string, unknown> => {
  const w = store.getWorkflow(workflowId);
  const env: Record<string, unknown> = {
    Meta: w?.meta ?? {},
    Title: w?.title ?? '',
    Now: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    Steps: {},
  };
  const stepsOut: Record<string, unknown> = {};
  for (const st of store.stepsForWorkflow(workflowId)) {
    const entry = {
      seq: st.seq, kind: st.kind, title: st.title,
      status: st.status, output: st.output, input: st.input,
    };
    stepsOut[`step${st.seq}`] = entry;
    const ref = asString(st.input['_ref']);
    if (ref !== '') stepsOut[ref] = entry;
  }
  env['Steps'] = stepsOut;
  return env;
};

/**
 * 渲染 {{.A.b.c}} 点路径模板。missing-key = error（对齐 Go missingkey=error）：
 * 拼错的变量必须炸出来，绝不静默渲染 <no value> 进提示词。
 * （分歧说明：不支持 Go text/template 的控制结构；现有模板只用点路径。）
 */
export const renderFlowTemplate = (text: string, env: Record<string, unknown>): string =>
  text.replace(/\{\{([^}]+)\}\}/g, (_m, rawPath: string) => {
    const path = String(rawPath).trim();
    if (!path.startsWith('.')) {
      throw new Error(`template exec: unsupported directive "${path}"`);
    }
    let cur: unknown = env;
    for (const seg of path.slice(1).split('.')) {
      if (cur === null || cur === undefined || typeof cur !== 'object') {
        throw new Error(`template exec: missing key "${path}"`);
      }
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (cur === undefined) throw new Error(`template exec: missing key "${path}"`);
    return typeof cur === 'string' ? cur : JSON.stringify(cur);
  });


/** 通用 llm 步：渲染模板提示词 → 调供应商 → 存响应（JSON 则逐键合并）。 */
export const runGenericLlm = async (ctx: StepCtx): Promise<void> => {
  const { store, step: st, workflow: w, clock } = ctx;
  const env = flowContext(store, w.id, clock.now());
  env['Input'] = st.input;
  const promptTpl = asString(st.input['prompt']);
  if (promptTpl.trim() === '') throw new Error('llm step has no prompt');
  const rendered = renderFlowTemplate(promptTpl, env);
  const maxTokensRaw = st.input['max_tokens'];
  const maxTokens = typeof maxTokensRaw === 'number' && maxTokensRaw > 0 ? maxTokensRaw : 1024;
  const raw = await ctx.completeLlm(asString(st.input['system']), rendered, maxTokens, undefined, `wf:${w.id}/step:llm`);

  const out: Record<string, unknown> = { response: raw, completed_at: rfc3339(clock.now()) };
  try {
    const parsed = parseLoose(raw);
    for (const [k, v] of Object.entries(parsed)) out[k] = v;
    out['is_json'] = true;
  } catch { /* 非 JSON 响应合法——只存原文 */ }
  store.setStepOutput(st.id, out as JsonRecord);
  // 给紧随的 gate 播种截断摘要，审批推送才有内容（否则只剩裸标题）。
  const steps = store.stepsForWorkflow(w.id);
  const next = steps[st.seq];
  if (next && next.kind === 'gate') {
    store.setStepInput(next.id, { plan: truncate(raw, 500) });
  }
};

