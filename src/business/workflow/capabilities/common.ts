// 能力处理函数的公共接缝：StepCtx（引擎注入的上下文）+ StepHandler 签名 +
// 宽松 JSON 解析。分发表（engine.stepHandlers）指向各能力模块。

import { asString, truncate } from '../../../platform/shared/json.ts'
import { type JsonRecord } from '@juli-os/artifacts'
import { type Clock } from '@juli-os/artifacts';
import { type Step, type Workflow } from '@juli-os/ledger';
import type { LifecycleStore } from '@juli-os/ledger';
import type { ArtifactPort, LlmPort } from '../../../contracts/ports.ts';

// ---- 引擎提供给能力处理函数的接缝 ---------------------------------------------

export interface StepCtx {
  readonly workflow: Workflow;
  readonly step: Step;
  readonly store: LifecycleStore;
  readonly llm: LlmPort | null;
  readonly artifacts?: ArtifactPort | null;
  readonly externalLink?: ((a: { readonly id: string; readonly name: string; readonly key: string }) => Promise<string | null>) | null;
  readonly model: string;
  readonly clock: Clock;
  readonly log: (msg: string) => void;
  /** 带超时+429 退避的补全调用；失败抛错（runLlmStep 统一结算）。 */
  completeLlm(system: string, user: string, maxTokens?: number, model?: string, ref?: string): Promise<string>;
  /** 最近一个已完成 llm 步的 response 文本——模板流的自然工单。 */
  latestLLMResponse(workflowId: string): string;
  stepEvent(st: Step, type: string, payload?: JsonRecord): void;
  /** 持锁推进（调用方已持有工作流锁时用）。 */
  advanceLocked(workflowId: string): Promise<void>;
  /** 把本步结果追加进案卷（triage→extract、draft→draft）。 */
  appendStepToCaseFile(w: Workflow, st: Step): void;
}

export type StepHandler = (ctx: StepCtx) => Promise<void>;


// ---- 宽松 JSON 解析 -----------------------------------------------------------

/** 从 LLM 响应里提取第一个 JSON 对象：剥 ``` 围栏、取首尾大括号。 */
export const parseLoose = (raw: string): JsonRecord => {
  let s = raw.trim();
  const fence = s.indexOf('```');
  if (fence >= 0) {
    const nl = s.indexOf('\n', fence);
    if (nl >= 0) s = s.slice(nl + 1);
    const last = s.lastIndexOf('```');
    if (last >= 0) s = s.slice(0, last);
    s = s.trim();
  }
  const open = s.indexOf('{');
  const close = s.lastIndexOf('}');
  if (open >= 0 && close > open) s = s.slice(open, close + 1);
  const v = JSON.parse(s) as unknown;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`parse llm json: not an object (raw: ${truncate(raw, 500)})`);
  }
  return v as JsonRecord;
};


/** agent 派发任务卡的统一包装：宪法头随每张卡下发（托管 agent 一律受
 * juli 宪法约束）。宪法正文在 juli-constitution skill（单一事实源），这里只放
 * 指针与最硬三条——防契约文本分裂（2026-09-21 深夜事故：挂闸契约只在
 * 一个域 skill 里，被点名的域 skill 没有=单子停第一步、人审面无卡）。 */
export const planPrompt = (plan: string): string =>
  '【juli 宪法】本会话由 juli-service 托管：动手前先通读 juli-constitution skill 并全程遵循——'
  + '产出=工件、人审=闸门、收工前挂闸门节点（收尾三连）、对外发信只走引擎闸门；'
  + '域内 skill 与宪法冲突时以宪法为准。\n\n'
  + '以下是经过人工审批的执行计划，请执行。\n\n' + plan +
  '\n\n执行完成后，给出简要汇报：做了什么、结果如何、关键产出/文件。';

/** agent 步钉定的会话：input.session 优先，其次模板携带的 _session。 */
export const agentSessionOf = (st: Step): string =>
  asString(st.input['session']) || asString(st.input['_session']);

/** agent 步的实际落点会话：派发经 resolveSession 改道（渠道路由键悬空/
 * 复用优先落回）时，runAgentStep 把实际目标写进 resolved_session。盯活
 * 会话的地方（zombie 看门狗/干预/重启对账）必须读它——声明会话可能根本
 * 不存在（2026-09-21 /site→acme 事故：看门狗盯不存在会话永远「静默」
 * →误判僵尸→向在跑会话重复投递→submit_unconfirmed 判死）。 */
export const agentLiveSessionOf = (st: Step): string =>
  asString(st.input['resolved_session']) || asString(st.input['session'])
  || asString(st.input['_session']);
