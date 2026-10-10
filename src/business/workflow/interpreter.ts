// 解释器：advanceLocked 推进当前步（重入守卫/_when 语义跳过/零步骤禁完成/
// 链尾悬空检测），按 kind 分派到步执行器。StepCtx 的构造（makeCtx）也在这
// 里——能力模块只认 ctx，不认引擎内部。

import type { Logger } from '../../platform/events/bus.ts';
import type { Clock } from '@juli-os/artifacts';
import type { LifecycleStore } from '@juli-os/ledger';
import { type Step, type StepKind, type Workflow } from '@juli-os/ledger';
import { isActiveStepStatus } from '../../contracts/statuses.ts';
import { asString } from '../../platform/shared/json.ts'
import {
  runTriage, runDraft, runGenericLlm, runShare, type StepCtx, type StepHandler,
} from './capabilities/index.ts';
import { renderFlowTemplate, flowContext } from './capabilities/index.ts';
import { isSendGateDecision } from '../send/sendSeed.ts';
import type { EngineDeps } from './engine.ts';
import type { Journal } from './journal.ts';
import type { Steps } from './steps.ts';

export interface Interpreter {
  advanceLocked(workflowId: string): Promise<void>;
  stepHandlers(): Readonly<Record<StepKind, StepHandler>>;
  makeCtx(w: Workflow, st: Step): StepCtx;
}

export const makeInterpreter = (o: {
  readonly deps: EngineDeps;
  readonly store: LifecycleStore;
  readonly clock: Clock;
  readonly now: () => Date;
  readonly log: Logger;
  readonly journal: Journal;
  readonly steps: Steps;
}): Interpreter => {
  const { deps, store, log } = o;
  const now = o.now;

  /** 链尾悬空检测（wf_e4013364bc8d 断链事故）：nodes 链全部终态、本单有
   * 原始发件人、却从未有过 send 步——用户批准了「发送闸门」之后永远没人
   * 告诉他没发。静默等待改为一次性留痕（chain_dangling 事件 + meta 标记防
   * 4s 轮询重发）+ 尽力而为推送（PusherPort.chainDangling 可选，mock 缺省
   * 不炸）。零步骤的空容器不算悬空——那只是还没开始。 */
  const detectChainDangling = async (workflowId: string): Promise<void> => {
    const w = store.getWorkflow(workflowId);
    if (!w || w.meta['chain_dangling_notified'] === true) return;
    const steps = store.stepsForWorkflow(workflowId);
    if (steps.length === 0) return;
    const active = steps.some((s) => isActiveStepStatus(s.status));
    if (active) return;
    // wf_505578377218：from 为空不再豁免——任务流「批了发送闸门却没发」
    // 与回信流同罪，一样要响。send 收件人已不依赖 from（envelope.to）。
    if (steps.some((s) => s.kind === 'send')) return;
    const last = steps[steps.length - 1]!;
    // 只在「批准了发送决定却无处可发」时报警——非发送 gate 收尾 = 正常等人
    // settle；agent 步收尾后的空档 = 正常等下一节点（不撤回的误报会杀死注意力）。
    // 发送语义判据与标题解耦（P2）：isSendGateDecision = 标题「发送」或申报
    // envelope.to——agent 起的标题文案不再决定守卫口径。
    if (last.kind !== 'gate' || !isSendGateDecision(last.title, last.input)) return;
    store.appendEvent('workflow', workflowId, 'chain_dangling', {
      last: `${last.kind}/${last.title}`,
    });
    store.updateWorkflowMeta(workflowId, { chain_dangling_notified: true });
    log.error(`[engine] workflow ${workflowId} 链尾悬空：全节点终态且无 send 步（last=${last.kind}/${last.title}）——需人工处置`);
    const cd = deps.pusher?.chainDangling;
    await o.journal.pushBestEffort('chainDangling', cd && (() => cd(w,
      '链尾悬空：全部节点已终态但从未有发送节点——批准的发送闸门不会发出任何邮件，需人工处置')));
  };

  /** 链尾可结算提示（2026-09-23 断点③）：nodes 链全终态、无悬空报警、无人
   * settle——run 停在链尾等人催的静默形态（实测 wf_fa36282cdf63：收口全靠
   * 人想起点了。一次性留痕（run_settleable 事件 + meta 防重，4s 轮询重放
   * 不重响）+ 尽力而为推送（PusherPort.settleHint 可选，mock 缺省不炸）。
   * 回流未送达时不提示——agent 还没看到批准，谈不上可结算。 */
  const hintSettleable = async (workflowId: string): Promise<void> => {
    const w = store.getWorkflow(workflowId);
    if (!w || w.status !== 'running') return;
    if (w.meta['settle_hint_notified'] === true) return;
    if (w.meta['chain_dangling_notified'] === true) return; // 悬空有更强的报警语义，不双响
    const steps = store.stepsForWorkflow(workflowId);
    if (steps.length === 0) return;
    if (steps.some((s) => isActiveStepStatus(s.status))) return;
    if (store.pendingRelays().some((r) => r.workflowId === workflowId)) return;
    store.appendEvent('workflow', workflowId, 'run_settleable', {
      steps: steps.length, last: `${steps[steps.length - 1]!.kind}/${steps[steps.length - 1]!.title}`,
    });
    store.updateWorkflowMeta(workflowId, { settle_hint_notified: true });
    log.info(`[engine] workflow ${workflowId} 链尾无未决节点——run 可 settle（juli settle ${workflowId}）`);
    const sh = deps.pusher?.settleHint;
    await o.journal.pushBestEffort('settleHint', sh && (() => sh(w,
      `全部 ${steps.length} 个节点已终态、链尾无未决——run 可结算落账：juli settle ${workflowId}`)));
  };

  const advanceLocked = async (workflowId: string): Promise<void> => {
    // 已结算（cancelled/failed/completed）的流水不许再走阶梯：迟到补结算的
    // 步骤仍可落定自身，但什么都不许越过它。
    const w0 = store.getWorkflow(workflowId);
    if (!w0 || w0.status !== 'running') return;
    let st = store.currentStep(workflowId);
    if (!st) {
      // nodes 模式:节点间空档 = 等下一次动作追加,不是完成。但链尾悬空
      // （全终态且无 send 步）必须留痕——静默等待正是 wf_e4013364bc8d 的
      // 「批准了发送闸门却永远没发」事故形态。
      if (store.getWorkflow(workflowId)?.meta['mode'] === 'nodes') {
        await detectChainDangling(workflowId);
        await hintSettleable(workflowId);
        return;
      }
      // 零步骤禁完成（2026-09-13 假完成案贰守卫）：从未有过任何步骤的流水
      // 走到 advance = 建单路径有 bug，「currentStep 空」绝不允许在此翻译成
      // completed——那是静默成功。显式 failed 留痕，等人工核实处置。
      if (store.stepsForWorkflow(workflowId).length === 0) {
        store.setWorkflowStatus(workflowId, 'failed');
        store.appendEvent('workflow', workflowId, 'workflow_failed', {
          reason: 'zero_steps: 流水无任何步骤，禁止假完成（人工核实后可 close）',
        });
        log.error(`[engine] workflow ${workflowId} 零步骤 → failed（零步骤禁完成守卫）`);
        // 守卫的全部意图是人工处置——通知缺位处置闭环就迟迟不启动。与
        // workflowDone 推送同构：尽力而为，推送失败绝不阻塞守卫本身。
        const wFailed = store.getWorkflow(workflowId);
        if (wFailed) {
          await o.journal.pushBestEffort('workflowFailed', deps.pusher &&
            (() => deps.pusher!.workflowFailed(wFailed, '零步骤守卫：流水无任何步骤即推进——需人工核实后 close')));
        }
        return;
      }
      // 阶梯全部落定 = 工作流完成（Go：CurrentStep 的 ErrNoRows 就是完成）。
      store.setWorkflowStatus(workflowId, 'completed');
      store.appendEvent('workflow', workflowId, 'completed', {});
      // 结案流程图：2026-10-04 用户裁定彻底删除（wf_00a2a1339b3a）。
      const w = store.getWorkflow(workflowId);
      if (w) {
        await o.journal.pushBestEffort('workflowDone', deps.pusher &&
          (() => deps.pusher!.workflowDone(w, '业务流完成，回信已发出')));
      }
      return;
    }
    const w = store.getWorkflow(workflowId);
    if (!w) return;
    // 重入守卫：已被认领的步（LLM 在飞、agent 已派发、SMTP 发送中）不许重复
    // 执行——双击的 Approve 或对账器与 hook 的竞态否则会重复派发。等待人工
    // 的闸门豁免：重入即重新推送，是设计行为。
    if (st.status === 'running') return;

    // 语义跳过：步骤携带 _when 表达式时对 flow context 求值——假值 → 该步
    // skipped（终态，事件留痕，绝不静默消失），直接推进下一步。
    const whenExpr = asString(st.input['_when']);
    if (st.status === 'pending' && whenExpr !== '') {
      let rendered = '';
      try {
        rendered = renderFlowTemplate(whenExpr, flowContext(store, workflowId, now()));
      } catch (e) {
        // 条件本身坏了 = 配置 bug，按失败处理（可重试），不静默跳过。
        const msg = `when 求值失败: ${e instanceof Error ? e.message : String(e)}`;
        store.setStepOutput(st.id, { error: msg });
        store.setStepStatus(st.id, 'failed');
        o.journal.stepEvent(st, 'step_failed', { error: msg });
        return;
      }
      const truthy = rendered.trim() !== '' && rendered.toLowerCase() !== 'false' && rendered !== '0';
      if (!truthy) {
        store.setStepOutput(st.id, { skipped: true, when: whenExpr, reason: `条件为假（${rendered || '空'}）` });
        store.setStepStatus(st.id, 'skipped');
        o.journal.stepEvent(st, 'step_skipped', { when: whenExpr, rendered });
        log.info(`[engine] step ${st.id} (${st.kind}) skipped: ${whenExpr} → ${rendered}`);
        await advanceLocked(workflowId);
        return;
      }
    }

    const handler = stepHandlers()[st.kind];
    if (!handler) {
      log.error(`unknown step kind "${st.kind}" (${st.id})`);
      return;
    }
    await handler(makeCtx(w, st));
  };

  const makeCtx = (w: Workflow, st: Step): StepCtx => ({
    workflow: w,
    step: st,
    store,
    llm: deps.llm,
    artifacts: deps.artifacts,
    externalLink: deps.externalLink,
    model: deps.model,
    clock: o.clock,
    log: (m) => log.info(m),
    completeLlm: o.journal.completeLlm,
    latestLLMResponse: o.journal.latestLLMResponse,
    stepEvent: o.journal.stepEvent,
    advanceLocked,
    appendStepToCaseFile: o.journal.appendStepToCaseFile,
  });

  /** 能力注册表 = 解释器的分发表：kind → handler。 */
  const stepHandlers = (): Readonly<Record<StepKind, StepHandler>> => ({
    triage: (ctx) => runWrappedLlm(ctx, () => runTriage(ctx, deps.routing, deps.availableSessions, deps.judgment), true),
    gate: o.steps.openGate,
    agent: o.steps.runAgentStep,
    verify: o.steps.runAgentStep,
    draft: (ctx) => runWrappedLlm(ctx, () => runDraft(ctx), true),
    send: o.steps.runSendStep,
    llm: (ctx) => runWrappedLlm(ctx, () => runGenericLlm(ctx), false),
    share: (ctx) => runWrappedLlm(ctx, () => runShare(ctx), false),
  });

  /** LLM 类步的统一结算壳：先认领（running）再长调用，崩在半路留下的是
   * 可重试的 failed，不是永远看不见的 pending。 */
  const runWrappedLlm = async (
    ctx: StepCtx, fn: () => Promise<void>, dropStaleError: boolean,
  ): Promise<void> => {
    const { store: st0, step: st } = ctx;
    st0.setStepStatus(st.id, 'running');
    try {
      await fn();
      if (dropStaleError) st0.setStepOutput(st.id, { error: null }); // 清掉上次尝试的陈旧失败
      st0.setStepStatus(st.id, 'completed');
      // 重读：fn 直接写库，st 引用还是跑前的空 output。
      const fresh = st0.getStep(st.id);
      if (fresh) {
        ctx.appendStepToCaseFile(ctx.workflow, fresh);
        o.journal.stepEvent(fresh, 'step_completed', {});
      }
      await advanceLocked(st.workflowId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      st0.setStepOutput(st.id, { error: msg });
      st0.setStepStatus(st.id, 'failed');
      o.journal.stepEvent(st, 'step_failed', { error: msg });
      log.error(`step ${st.id} (${st.kind}) failed: ${msg}`);
    }
  };

  return { advanceLocked, stepHandlers, makeCtx };
};
