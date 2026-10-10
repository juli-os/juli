// 引擎记账与 LLM 服务：事件落账（stepEvent 的失败镜像/推送收口）、案卷追加、
// LLM 补全（180s 超时 + 429 退避重试 ×2）。全部子模块共用的底座服务。

import { asString, type JsonRecord } from '../../platform/shared/json.ts';
import type { Logger } from '../../platform/events/bus.ts';
import type { LifecycleStore } from '../../platform/ledger/store.ts';
import type { Step, Workflow } from '../../contracts/entities.ts';
import { appendDecision, appendSection } from '../../platform/ledger/casefile.ts';
import type { EngineDeps } from './engine.ts';
import { LLM_TIMEOUT_MS } from './support.ts';

export interface Journal {
  /** 尽力而为推送（六处样板收口）：可选方法缺省不炸，失败只记日志——推送
   * 是加速器不是账本，绝不阻塞调用方语义。保留 await（确定性测试的排空点），
   * 同步上下文由调用方 void。fn 收 null/undefined（deps.pusher 可为 null）。 */
  pushBestEffort(label: string, fn: (() => Promise<unknown>) | null | undefined): Promise<void>;
  stepEvent(st: Step, type: string, payload?: JsonRecord): void;
  latestLLMResponse(workflowId: string): string;
  recordDecision(workflowId: string, gateSeq: number, action: string, note: string, by: string): void;
  appendStepToCaseFile(w: Workflow, st: Step): void;
  completeLlm(system: string, user: string, maxTokens?: number, model?: string, ref?: string): Promise<string>;
}

export const makeJournal = (o: {
  readonly deps: EngineDeps;
  readonly store: LifecycleStore;
  readonly now: () => Date;
  readonly log: Logger;
}): Journal => {
  const { deps, store, log } = o;
  const now = o.now;

  const pushBestEffort = async (label: string, fn: (() => Promise<unknown>) | null | undefined): Promise<void> => {
    if (fn === null || fn === undefined) return;
    try {
      await fn();
    } catch (e) {
      log.error(`pusher ${label}: ${String(e)}`);
    }
  };

  const stepEvent = (st: Step, type: string, payload: JsonRecord = {}): void => {
    store.appendEvent('step', st.id, type, {
      ...payload,
      workflow_id: st.workflowId,
      kind: st.kind,
      seq: st.seq,
    });
    // 步失败镜像进工作流状态：停滞的阶梯不许在 UI 上继续"运行中"。
    // retry 会把它翻回来。
    if (type !== 'step_failed') return;
    const w = store.getWorkflow(st.workflowId);
    if (w && w.status === 'running') {
      store.setWorkflowStatus(st.workflowId, 'failed');
      store.appendEvent('workflow', st.workflowId, 'workflow_failed', {
        at_step: st.seq, kind: st.kind, error: payload['error'] ?? null,
      });
    }
    // 失败即推（2026-09-15 断点十一①）：step_failed 只落账不通知 = 单子死在
    // 半路没人知道，等人进会话喊「继续」。所有 step_failed 收口在这一个点上
    // 尽力而为推送（PusherPort.stepFailed 可选，mock 缺省不炸；失败只记日志，
    // 绝不阻塞结算本身）。事件+log 留痕为准，推送是加速器不是账本。
    if (w) {
      const reason = typeof payload['error'] === 'string' && payload['error'] !== ''
        ? payload['error']
        : `step ${st.kind}/${st.title} failed`;
      const pf = deps.pusher?.stepFailed;
      if (pf) void pushBestEffort('stepFailed', () => pf(w, st, reason));
    }
  };

  const latestLLMResponse = (workflowId: string): string => {
    const steps = store.stepsForWorkflow(workflowId);
    for (let i = steps.length - 1; i >= 0; i--) {
      const st = steps[i];
      if (!st || st.kind !== 'llm' || st.status !== 'completed') continue;
      const v = asString(st.output['response']).trim();
      if (v !== '') return v;
    }
    return '';
  };

  const recordDecision = (workflowId: string, gateSeq: number, action: string, note: string, by: string): void => {
    const cf = store.loadCaseFile(workflowId);
    store.saveCaseFile(workflowId, appendDecision(cf, { seq: gateSeq, action, by, note }, now()));
  };

  const appendStepToCaseFile = (w: import('../../contracts/entities.ts').Workflow, st: Step): void => {
    if (Object.keys(st.output).length === 0) return;
    let cf = store.loadCaseFile(w.id);
    if (st.kind === 'triage') {
      cf = appendSection(cf, 'extract', {
        category: st.output['category'] ?? null,
        summary: st.output['summary'] ?? null,
        session: st.output['session'] ?? null,
        needs_reply: st.output['needs_reply'] ?? null,
      }, now());
    } else if (st.kind === 'draft') {
      cf = appendSection(cf, 'draft', { draft: st.output['draft'] ?? null }, now());
    }
    store.saveCaseFile(w.id, cf);
  };

  // ---- LLM 补全（180s 超时 + 429 退避重试 ×2）-----------------------------------

  const completeLlm = async (system: string, user: string, maxTokens = 1024, model?: string, ref?: string): Promise<string> => {
    if (!deps.llm) throw new Error('no LLM provider');
    const budget = maxTokens > 0 ? maxTokens : 1024;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), LLM_TIMEOUT_MS);
    try {
      let lastErr: Error = new Error('llm unavailable');
      const retryDelayMs = deps.llmRetryDelayMs ?? 3000;
      const t0 = Date.now();
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, attempt * retryDelayMs);
            ac.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(ac.signal.reason);
            }, { once: true });
          });
        }
        const res = await deps.llm.complete({ system, user, maxTokens: budget, model, signal: ac.signal });
        if (res.ok) {
          deps.usage?.({
            source: 'engine', note: ref, model: model || undefined,
            inputTokens: res.value.inputTokens, outputTokens: res.value.outputTokens,
            durationMs: Date.now() - t0,
          });
          return res.value.text;
        }
        lastErr = res.error;
        const low = res.error.message.toLowerCase();
        if (!res.error.message.includes('429') && !low.includes('rate limit')) throw res.error;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  };

  return { pushBestEffort, stepEvent, latestLLMResponse, recordDecision, appendStepToCaseFile, completeLlm };
};
