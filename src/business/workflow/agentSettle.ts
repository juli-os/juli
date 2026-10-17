// agent 结算：Stop hook 收工（completeAgentStep：认领-收编-播种-续推）、
// 有机回合容器（claimedContainerFor/journalSessionTurn/recordActivity）、
// feedback 单链尾自愈补闸（autoAppendFeedbackGate）与发送后自动收口
// （autoSettleAfterSend）。

import { rfc3339 } from '@juli-os/artifacts';
import { asString, truncate } from '../../platform/shared/json.ts'
import type { JsonRecord, JsonValue } from '@juli-os/artifacts'
import type { Logger } from '../../platform/events/bus.ts';
import type { LifecycleStore } from '@juli-os/ledger';
import { type Step, type Workflow } from '@juli-os/ledger';
import { isSettledStepStatus } from '../../contracts/statuses.ts';
import { appendExecution } from '@juli-os/ledger';
import type { DeliverableRef } from '@juli-os/artifacts';
import { isDeliverableRef } from '@juli-os/artifacts';
import { briefDeclaresApply, feedbackRecordIdOf, hasLiveGate } from './support.ts';
import type { EngineDeps } from './engine.ts';
import type { Journal } from './journal.ts';
import type { Queue } from './queue.ts';
import type { Steps } from './steps.ts';

export interface AgentSettle {
  onAgentStopped(session: string, status: string, finalMessage?: string): Promise<void>;
  /** 返回是否赢得 settle-once 认领（并发收工时败者 false——判定留痕只由
   * 赢家付一次；reconcile 僵尸收编等调用方不消费返回值，行为零变化）。 */
  completeAgentStep(st: Step, session: string, status: string, output: string): Promise<boolean>;
  claimedContainerFor(session: string): Workflow | null;
  journalSessionTurn(session: string, event: string, text: string): boolean;
  recordActivity(session: string, event: string, text: string): Promise<void>;
}

export const makeAgentSettle = (o: {
  readonly deps: EngineDeps;
  readonly store: LifecycleStore;
  readonly now: () => Date;
  readonly log: Logger;
  readonly journal: Journal;
  readonly queue: Pick<Queue, 'continueWorkflow'>;
  readonly steps: Pick<Steps, 'renderSeedPlan'>;
  /** 工作流锁（九跑 P2）：结算体读-播种段持锁，与闸门动作等锁内转变串行。
   * 认领 CAS 锁外先行；withLock 不可重入——锁体内严禁嵌套（continueWorkflow
   * 的 advance 是 void 排队，锁释后才执行）。 */
  readonly withLock: <T>(workflowId: string, fn: () => Promise<T>) => Promise<T>;
  /** 晚绑：settle（lifecycle）与 autoSettleFeedbackRuns（reconcile）装配后指向真身。 */
  readonly late: {
    settle: (workflowId: string, by: string) => Promise<void>;
    autoSettleFeedbackRuns: () => Promise<number>;
  };
}): AgentSettle => {
  const { deps, store, log } = o;
  const now = o.now;

  /** 自动结算（2026-09-14 裁决）：发送已完成且全单节点皆终态的 nodes 单，
   * 等会话收尾回合（确认发送→简要汇报）落账后收口——settle 点在 skill 结束，
   * 不在 engine 发送瞬间；无收尾回合的单不自动收口，人工 settle 仍是兜底。 */
  const autoSettleAfterSend = async (session: string): Promise<void> => {
    const w = claimedContainerFor(session);
    if (w === null) return;
    const steps = store.stepsForWorkflow(w.id);
    if (!steps.some((s) => s.kind === 'send' && s.status === 'completed')) return;
    if (!steps.every((s) => isSettledStepStatus(s.status))) return;
    await o.late.settle(w.id, 'auto-send');
  };

  const onAgentStopped = async (session: string, status: string, finalMessage?: string): Promise<void> => {
    const st = store.runningAgentStepForSession(session);
    if (!st) {
      // 有机回合收尾：Stop hook 的最终答复进容器账本（审计/时间线素材）。
      if (typeof finalMessage === 'string' && finalMessage.trim() !== '') {
        journalSessionTurn(session, 'turn_done', finalMessage);
      }
      await autoSettleAfterSend(session);
      // apply 链收口：闸门已批、执行回合收工——工件/回挂证据齐则落账。
      await o.late.autoSettleFeedbackRuns().catch(() => undefined);
      return;
    }
    // 结构化输出唯一（既定裁决）：Stop hook 从 transcript 提取的最终答复
    // （干净文本）是产出的唯一来源。capture-pane 的产出兜底就此摘除——它是
    // 终端缓冲，混着 spinner/状态栏/HUD 报错，垃圾文本曾被当作正文播种进
    // 发送链（2026-09-11 pane 污染事故）；capture-pane 只准喂 zombie 检测。
    // 空产出绝不抓屏填空：agent_output_missing 事件留痕，等结构化上报。
    const output = typeof finalMessage === 'string' && finalMessage.trim() !== '' ? finalMessage : '';
    if (output === '') {
      o.journal.stepEvent(st, 'agent_output_missing', { session, raw_status: status });
    }
    // 产出合格性预检（output_quality，2026-09-27，影子先行）：agent 自报最终
    // 答复是否像一次合格交付（非致歉/反问/空转总结）。shadow=留痕；on+高置信
    // 不合格=output_quality_flagged 事件供闸门与复盘参考——不改结算语义，
    // 收货与否本就有人审闸门在。
    // 先认领再判定（2026-09-27 审查 P2-6）：判定 RTT 不再插在步查找与
    // claimRunningStep 的 CAS 之间——并发停止信号（Stop hook 重试/双源）下
    // 只有认领赢家付一次判定、落一份留痕；且判定转后台执行（本场景纯留痕
    // 不改结算），provider 黑洞最坏 30s 不阻塞 Stop hook 响应与结算主链。
    const won = await completeAgentStep(st, session, status, output);
    if (won && output !== '' && deps.judgment !== undefined) {
      const judgment = deps.judgment;
      void (async () => {
        const outcome = await judgment.ask('output_quality',
          { session, status, final_message: output.slice(0, 2000), plan: asString(st.input['plan']).slice(0, 400) },
          {
            quality: {
              type: 'noul',
              instructions: 'Does this agent final report look like a completed, substantive delivery of the task it was given (not an apology, a refusal, a question asking what to do, or an empty summary)?',
            },
          });
        if (outcome !== null && outcome.ok) {
          const p = { mode: outcome.mode, scenario: 'output_quality', answer: outcome.answer ?? '', confidence: outcome.confidence ?? 0, provider: outcome.provider, model: outcome.model ?? '', input_tokens: outcome.inputTokens ?? 0, output_tokens: outcome.outputTokens ?? 0, duration_ms: outcome.durationMs ?? 0 };
          if (outcome.mode === 'on' && outcome.answer === 'false' && (outcome.confidence ?? 0) >= outcome.threshold) {
            o.journal.stepEvent(st, 'output_quality_flagged', p);
          } else {
            o.journal.stepEvent(st, 'output_judgment', p);
          }
        } else if (outcome !== null) {
          o.journal.stepEvent(st, 'output_judgment', { mode: outcome.mode, scenario: 'output_quality', error: outcome.error ?? '' });
        }
      })().catch(() => undefined); // 留痕尽力而为，绝不反噬已完成的结算
    }
  };

  /** feedback 单链尾自愈补闸（板A收口，2026-09-21 深夜事故）：确认闸是
   * agent 收工前自己 POST 的节点，契约漏执行时单子永远停在第一步、人审面
   * 无卡可批。agent 步结算时自检：feedback 进件单（template_input 锚）+
   * brief 申报 delivery="apply" + 本步之后无后继 + 全链无存活闸门 → 补挂
   * 确认闸。与 agent 手挂同形：标题不带「发送」、不申报 envelope.to——
   * 不触发发送信封校验，也不配对 send 步。返回是否补挂。 */
  const autoAppendFeedbackGate = async (st: Step): Promise<boolean> => {
    const w = store.getWorkflow(st.workflowId);
    if (!w || w.status !== 'running') return false;
    const recordId = feedbackRecordIdOf(w);
    if (recordId === '') return false;
    const brief = asString(st.input['plan']) || asString(st.input['prompt']);
    if (!briefDeclaresApply(brief)) return false;
    const steps = store.stepsForWorkflow(st.workflowId);
    if (steps.some((s) => s.seq > st.seq)) return false; // 有后继（含转派/执行跳），交给既有链
    if (hasLiveGate(steps)) return false;
    const lastSeq = steps.length > 0 ? steps[steps.length - 1]!.seq : st.seq;
    store.insertStepsAt(st.workflowId, lastSeq, [{
      kind: 'gate', title: '确认闸门',
      input: { delivery: 'apply', envelope: { feedback_refs: [recordId] } },
    }]);
    o.journal.stepEvent(st, 'feedback_gate_auto_appended', { record_id: recordId });
    log.info(`[engine] feedback 单 ${st.workflowId} 链尾无闸门——自动补挂确认闸（record ${recordId}）`);
    return true;
  };

  const completeAgentStep = async (st: Step, session: string, status: string, output: string): Promise<boolean> => {
    // 原子认领让 hook/对账/同步派发的竞态 settle-once。认领锁外先行（CAS 即
    // settle-once，输家在此返回，绝不排队抢锁）；结算体（读-收编-案卷-播种）
    // 持工作流锁（九跑 P2）：否则可与持锁闸门动作同键 merge 互踩（后写胜），
    // 与 engine.ts 并发模型声明不符。withLock 不可重入——审计过锁体内无嵌套
    // withLock（sweepCaseInbox 是 fs 口，continueWorkflow 是 void 排队，锁释
    // 后才真正 advance）；调用方 onAgentStopped/reconcile 均不持锁。
    if (st.status === 'running' && !store.claimRunningStep(st.id)) return false;
    await o.withLock(st.workflowId, async () => {
      // 锁内重读兜底：等锁期间步可能已被清理（极端路径）。
      if (store.getStep(st.id) === null) return;
      store.setStepOutput(st.id, { session, output, raw_status: status });
      // case-inbox 收编：agent 的交付文件经申报单核验后成为不可变工件版本，
      // step output 只留指针（id+哈希+渲染角色）——大段正文不再内联流转。
      let deliverables: JsonValue[] = [];
      let envelope: JsonValue | null = null;
      let hasManifest = false;
      if (deps.artifacts && deps.caseInboxDir) {
        const dir = deps.caseInboxDir(st.workflowId);
        // sweep 拒绝不再静默（wf_e4013364bc8d）：收编失败必须留痕——否则
        // 交付物凭空消失，下游闸门/发送永远等不到工件。失败不改变步骤结算
        // 语义（照常完成，可事后补救），但事件链上必须有案可查。
        const res = await deps.artifacts.sweepCaseInbox(st.workflowId, st.id).catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          log.error(`case-inbox sweep failed (workflow ${st.workflowId} step ${st.id}): ${msg}`);
          o.journal.stepEvent(st, 'sweep_failed', { error: msg });
          return null;
        });
        if (res && res.count > 0) {
          log.info(`case-inbox: ${dir} 收编 ${res.count} 件`);
          deliverables = res.entries as unknown as JsonValue[];
          envelope = res.envelope as unknown as JsonValue;
          hasManifest = res.has_manifest;
          const patch: Record<string, JsonValue> = { deliverables };
          if (res.envelope !== null) patch['envelope'] = res.envelope as unknown as JsonValue;
          if (res.warnings.length > 0) patch['contract_warnings'] = res.warnings;
          store.setStepOutput(st.id, patch);
        }
      }
      // 执行结果追加进案卷（持久上下文）。
      const cf0 = store.loadCaseFile(st.workflowId);
      store.saveCaseFile(st.workflowId, appendExecution(cf0, {
        session, output, status, at: rfc3339(now()),
      }, now()));
      // 板A收口（2026-09-21 深夜事故）：确认闸节点本该由 agent 收工前 POST
      // 出来（挂闸契约在 skill）；模型没执行就收工时，单停在链尾、人审面
      // 永远没有卡可批。feedback 进件单链尾结算时引擎自愈补挂——插库即返，
      // 让下方播种块把 plan/output/deliverables 喂进闸门（与 agent 手挂后
      // 被播种同形），推进由本函数尾部的 continueWorkflow 统一走。
      try {
        await autoAppendFeedbackGate(st);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(`[engine] feedback 确认闸自动补挂失败 (${st.workflowId}): ${msg}`);
        o.journal.stepEvent(st, 'feedback_gate_auto_append_failed', { error: msg });
      }
      // 给下一步播种 agent 汇报：闸门能看见工作产物，后续 agent 跳也要继承会话。
      const steps = store.stepsForWorkflow(st.workflowId);
      const next = steps[st.seq];
      // 转派步不被结算播种（P1-2，2026-09-20 审查）：agent 在原步 running 中调
      // handoff 追加的执行步自带完整任务卡（转派理由+前站理解摘要+钉定会话），
      // 上游收工结算的播种若照常 merge 会以同键覆盖转派卡——接手方拿到的又是
      // 上游的原始任务（「接手不重读原文」承诺失效）。带 handoff_domain 标记的
      // 步整体跳过播种，普通链路播种行为零变化。
      if (next && asString(next.input['handoff_domain']) === '') {
        // 断点七（wf_8c9b98942786）：intake 理解步的任务卡用 prompt 键
        // （INTAKE_PROMPT 注入），下游播种却只读 plan——键位不一致让「紧跟
        // 理解步的 agent 节点」必拿空 plan。播种侧统一兼容两个键位；回退
        // prompt 须经 renderSeedPlan 渲染——它是未渲染模板，原样复制会把
        // {{.Input.*}} 占位符当计划派发（第 5 轮审查 P1）。
        const seed: Record<string, JsonValue> = {
          plan: asString(st.input['plan']) || o.steps.renderSeedPlan(st, asString(st.input['prompt'])), output,
        };
        // 答复正文（工件优先，wf_e4013364bc8d）：deliverables 里有 body 角色
        // 工件时播 body_ref 指针（{id,sha256,name}，与 sendSeed.deliverablesBody
        // 同形状，发送步按哈希取件核验）——screen 抓来的垃圾文本不再冒充正文
        // 流进发送链。gate/share 无 body 工件回落内联 draft（旧链路兼容）；
        // send 后继（nodes 模式邻接）不播 draft——断点九①铁律，会话汇报文本
        // 一律不得作正文，缺契约由 send 步 body_contract_missing 拒发。
        let bodyArt: DeliverableRef | null = null;
        for (const x of deliverables) {
          if (isDeliverableRef(x) && x.view_role === 'body') { bodyArt = x; break; }
        }
        if (next.kind === 'gate' || next.kind === 'send' || next.kind === 'share') {
          if (bodyArt !== null) {
            seed['body_ref'] = { id: bodyArt.id, sha256: bodyArt.sha256, name: bodyArt.name };
          } else if (next.kind !== 'send') {
            seed['draft'] = output;
          }
        }
        if (deliverables.length > 0) {
          seed['deliverables'] = deliverables;
          seed['manifest'] = hasManifest;
          // envelope 按键合并、申报优先（wf_16454623bf49/wf_7c9c9eeb51e1 两代
          // 事故，与 openGate 携带侧 steps.ts 的合并对称）：agent 收工前 POST
          // 挂闸时已申报 envelope{to,subject}（挂闸契约，lifecycle 前置校验对
          // 任务流强制），落在 next.input；而 sweep 扫出的 envelope 经
          // parseEnvelope 只剩线程提示键——整包顶掉会把申报冲掉，approve 播
          // 种 to='' 必撞 no_recipient。申报在位（JSON object）时申报键优先、
          // sweep 只补缺；无申报（回信流）维持 swept 整包原样。且本路径 settle
          // 已把 deliverables 喂进 next.input，openGate 携带分支因「已带
          // deliverables」恒不执行——两点正交，修一不闭二。
          const declared = next.input['envelope'];
          const declaredIsRecord =
            declared !== null && typeof declared === 'object' && !Array.isArray(declared);
          if (envelope !== null) {
            seed['envelope'] = declaredIsRecord
              ? { ...(envelope as JsonRecord), ...(declared as JsonRecord) }
              : envelope;
          }
        }
        const s = asString(st.output['session']) || asString(st.input['session']);
        if (s !== '') seed['session'] = s;
        store.setStepInput(next.id, seed);
      }
      const settled = store.getStep(st.id); // claimRunningStep 已把它置 completed
      if (status === 'error') {
        store.setStepStatus(st.id, 'failed');
        o.journal.stepEvent(settled ?? st, 'step_failed', { error: 'agent turn ended with error' });
        return;
      }
      o.journal.stepEvent(settled ?? st, 'step_completed', {});
      o.queue.continueWorkflow(st.workflowId);
    });
    return true;
  };

  /** 有机回合容器：无 running step 时，会话若被某条在途 nodes 流认领
   * （session 或 assigned_session 指向它），回合事件落进那条流——人肉
   * 驱动的 turn 也是 run 的一部分（human-in-the-loop 的高级 run）。 */
  const claimedContainerFor = (session: string): Workflow | null => {
    for (const w of store.listWorkflows(200)) {
      if (w.status !== 'running') continue;
      if (w.meta['mode'] !== 'nodes') continue;
      const claimed = w.session === session || asString(w.meta['assigned_session']) === session;
      if (claimed) return w;
    }
    return null;
  };

  const journalSessionTurn = (session: string, event: string, text: string): boolean => {
    const w = claimedContainerFor(session);
    if (w === null) return false;
    store.appendEvent('workflow', w.id, 'session_turn', {
      session, event, text: truncate(text, 400), at: rfc3339(now()),
    });
    return true;
  };

  const recordActivity = async (session: string, event: string, text: string): Promise<void> => {
    const st = store.runningAgentStepForSession(session);
    if (!st) {
      journalSessionTurn(session, event, text); // 无人派发 ≠ 不记账
      return;
    }
    const entry = { event, text: truncate(text, 300), at: rfc3339(now()) };
    // 原子追加：st 是调用时点的快照，读-合并-写会把并发 hook 事件互相覆盖
    // 丢条——appendStepOutputItem 在同一条语句序列内完成读-append-裁剪-写。
    store.appendStepOutputItem(st.id, 'activity', entry, 50);
    o.journal.stepEvent(st, 'step_activity', { event, text: truncate(text, 300) });
  };

  return { onAgentStopped, completeAgentStep, claimedContainerFor, journalSessionTurn, recordActivity };
};
