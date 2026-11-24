// 对账：重启在途清算、僵尸/队列自愈、feedback 单
// 存量回填补闸（backfillFeedbackGates）与 apply 链自动收口
// （autoSettleFeedbackRuns / settleOneFeedbackRun）。

import type { Logger } from '../../platform/events/bus.ts';
import { type LifecycleStore, type Step } from '@juli-os/ledger';
import { isActiveStepStatus, isSettledStepStatus } from '../../contracts/statuses.ts';
import { asString } from '../../platform/shared/json.ts';
import { type JsonRecord, type JsonValue } from '../../platform/shared/json.ts';
import { gateDelivery } from '../send/sendSeed.ts';
import { agentLiveSessionOf } from './capabilities/index.ts';
import { RUNNING_SCAN_LIMIT, briefDeclaresApply, feedbackRecordIdOf, hasLiveGate } from './support.ts';
import type { EngineDeps } from './engine.ts';
import type { Journal } from './journal.ts';
import type { Queue } from './queue.ts';
import type { AgentSettle } from './agentSettle.ts';
import type { Lifecycle } from './lifecycle.ts';

export interface Reconcile {
  reconcileStartup(): Promise<void>;
  /** 周期对账（runtime 60s 心跳，宽限 graceMs）。与重启对账共用一次扫描，区别是
   * 不做「查 submitted 账放行、查不到就杀」的在途判定：agent/verify 步绝不杀
   * （交 zombie 看门狗兜底），超宽限后只在其 prompt 已落定时回收结算。超宽限的
   * 模板能力步（triage/draft/send/llm/share）仍判死落 failed，running 态的闸门
   * 仍归位等人。先做队列自愈再扫描；工作流锁被占的步本轮跳过，不排锁等。
   * 上一轮没跑完时再调用，直接返回在途那一轮。 */
  reconcileIdle(graceMs: number): Promise<void>;
  autoSettleFeedbackRuns(): Promise<number>;
  autoSettleApprovedRuns(): Promise<number>;
}

/** 对账模式（2026-11-07 P3 拆显式入口）：同一扫描在两种语义下运行——
 * restart=重启对账（查 submitted 账放行、查不到才杀）；idle=周期对账
 * （宽限期内不动，agent/verify 步绝不杀）。曾靠 `graceMs === 0` 的魔法值
 * 分叉两种语义，P1 根因正藏在这个分叉里。 */
type ReconcileMode = 'restart' | 'idle';

export const makeReconcile = (o: {
  readonly deps: EngineDeps;
  readonly store: LifecycleStore;
  readonly now: () => Date;
  readonly log: Logger;
  readonly journal: Journal;
  readonly queue: Queue;
  /** 杀步段持锁（对齐 zombie.healZombie）：引擎并发模型要求所有
   * 状态转变在锁内发生。 */
  readonly withLock: <T>(workflowId: string, fn: () => Promise<T>) => Promise<T>;
  /** 工作流锁是否被占（非阻塞探测）：周期对账据此跳过有推进在途的单，不排锁等。 */
  readonly lockBusy: (workflowId: string) => boolean;
  readonly agentSettle: Pick<AgentSettle, 'completeAgentStep'>;
  /** feedback 域的回挂答复计数（2026-11-12 ledger 关门：feedback_mirror 已迁
   *  feedback 域库，workflow 域不摸别家的表——计数函数由装配注入，缺省恒 0）。 */
  readonly feedbackReplyCount?: (recordId: string) => number;
  readonly lifecycle: Pick<Lifecycle, 'settle'>;
  /** 认领会话最近一行 claude_code 用量的 epoch ms（无行=0）：回流执行静默
   * 判据②（usage 库在 runtime 层，经 engine deps 注入）。 */
  readonly lastSessionActivity?: ((session: string) => number) | null;
}): Reconcile => {
  const { deps, store, log } = o;
  const now = o.now;

  /** 存量 feedback 单回填（与 autoAppendFeedbackGate 同根，2026-09-21 深夜
   * 事故）：契约断档期间结算的单已停在「链尾 completed agent 步、全链无
   * 闸门」——启动扫一遍 running 的 feedback 单，命中即补挂确认闸并把
   * plan/output/deliverables 从已结算步搬进闸门（settle 路径的播种已经
   * 错过，这里手动补喂），推进入人审。幂等：链上已有存活闸门即跳过。 */
  const backfillFeedbackGates = async (): Promise<number> => {
    let n = 0;
    for (const w of store.listWorkflows(2000)) {
      if (w.status !== 'running') continue;
      const recordId = feedbackRecordIdOf(w);
      if (recordId === '') continue;
      const steps = store.stepsForWorkflow(w.id);
      if (steps.length === 0) continue;
      if (hasLiveGate(steps)) continue;
      if (steps.some((s) => isActiveStepStatus(s.status))) continue;
      const last = steps[steps.length - 1]!;
      if (last.kind !== 'agent' || last.status !== 'completed') continue;
      const brief = asString(last.input['plan']) || asString(last.input['prompt']);
      if (!briefDeclaresApply(brief)) continue;
      const seed: Record<string, JsonValue> = {
        delivery: 'apply',
        envelope: { feedback_refs: [recordId] },
        plan: brief,
        output: asString(last.output['output']),
      };
      for (const k of ['deliverables', 'manifest', 'body_ref', 'session'] as const) {
        const v = last.output[k];
        if (v !== undefined && v !== null) seed[k] = v;
      }
      // envelope 按键合并、回填锚优先（wf_16454623bf49/wf_7c9c9eeb51e1 同语义，
      // 与 agentSettle/steps 两处申报优先合并对齐）：循环若照搬 envelope 键，
      // swept 剥离版会整包顶掉上面声明的确定性锚——refs 是 agent 自报（缺键
      // 补空数组），approve 回流「拍板=状态翻转」（feedbackRefsOf）缺失或指
      // 错。锚键优先、swept 只补线程提示键；非 object（契约外形状）锚原样保留。
      const sweptEnvelope = last.output['envelope'];
      if (sweptEnvelope !== undefined && sweptEnvelope !== null
        && typeof sweptEnvelope === 'object' && !Array.isArray(sweptEnvelope)) {
        seed['envelope'] = { ...(sweptEnvelope as JsonRecord), feedback_refs: [recordId] };
      }
      // 逐单 try（2026-11-07 P3，与 settleOneFeedbackRun/settleOneApprovedRun
      // 同裁决）：一单插库被拒不炸整轮启动回填——for 循环中断后其余单永不回填。
      try {
        store.insertStepsAt(w.id, last.seq, [{ kind: 'gate', title: '确认闸门', input: seed }]);
        const gate = store.stepsForWorkflow(w.id)[steps.length] ?? null;
        if (gate) o.journal.stepEvent(gate, 'feedback_gate_backfilled', { record_id: recordId });
        log.info(`[engine] feedback 单 ${w.id} 存量回填确认闸（record ${recordId}）`);
        o.queue.continueWorkflow(w.id);
        n++;
      } catch (e) {
        log.warn(`[engine] feedback 单 ${w.id} 存量回填被拒（下轮启动再判）: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return n;
  };

  const reconcileStartup = async (): Promise<void> => {
    await reconcileRestart();
    const backfilled = await backfillFeedbackGates();
    if (backfilled > 0) log.info(`[engine] 启动回填：${backfilled} 张 feedback 单补挂确认闸`);
    const settled = await autoSettleFeedbackRuns();
    if (settled > 0) log.info(`[engine] 启动收口：${settled} 条 feedback apply 链结算落账`);
    const approvedSettled = await autoSettleApprovedRuns();
    if (approvedSettled > 0) log.info(`[engine] 启动收口：${approvedSettled} 条已批闸门链静默结算落账`);
  };

  /** 镜像里的回挂答复数（reply_to=本单 record）：apply 链收口的执行证据之二。
   * 镜像 60 分钟节奏——回挂答复最迟一小时内落地，落不了地的单留给人工收口。 */
  const replyCount = o.feedbackReplyCount ?? ((): number => 0);

  /** feedback apply 链自动收口（2026-09-21 深夜 e2e 收敛，用户裁定证据面）：
   * apply 链到确认闸为止、没有 send 步——autoSettleAfterSend 的「有已完成
   * 发送步」条件永不满足，单子执行完毕后永远停在 running。收口条件：链上
   * 全部步骤终态 + 有已完成的 apply 确认闸 + 执行证据（二者其一）——
   * ①Makro 工件：闸门名下登记的执行工件（有机回合不经过步结算，先补扫
   * case-inbox 把执行产出收编进闸门名下，扫出的即是交付工件面的一部分）；
   * ②feedback 回挂答复（镜像 reply_to=本单 record）。事实层的最终口径仍在
   * 镜像面板状态流转（skill 纪律：状态等用户拍板）——账本 completed 只代表
   * 本 run 流程走完。 */
  const settleOneFeedbackRun = async (workflowId: string): Promise<boolean> => {
    const w = store.getWorkflow(workflowId);
    if (!w || w.status !== 'running') return false;
    const recordId = feedbackRecordIdOf(w);
    if (recordId === '') return false;
    const steps = store.stepsForWorkflow(workflowId);
    if (steps.length === 0) return false;
    if (!steps.every((s) => isSettledStepStatus(s.status))) return false;
    const gate = steps.find((s) => s.kind === 'gate' && s.status === 'completed'
      && gateDelivery(s.input) === 'apply');
    if (gate === undefined) return false;
    if (deps.artifacts) {
      // 执行工件补扫（幂等，同哈希不重登记）：agent 执行回合的产出收编进
      // 闸门名下——既做证据，也进 run 的交付工件面。
      try { await deps.artifacts.sweepCaseInbox(workflowId, gate.id); }
      catch { /* 扫描失败不拦收口判定，走回挂证据 */ }
    }
    const executed = (deps.artifacts?.list(workflowId) ?? [])
      .some((a) => a.stepId === gate.id && a.deletedAt === null)
      || replyCount(recordId) > 0;
    if (!executed) return false;
    // 逐单 try（与 settleOneApprovedRun 同裁决）：守卫与 settle 取锁之间
    // appendNode 可插队，settleLocked 会打回——一单被拒不炸整轮启动收口。
    try {
      await o.lifecycle.settle(workflowId, 'auto-apply');
    } catch (e) {
      log.warn(`[engine] feedback apply 链收口被拒 (${workflowId}，下轮再判): ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    log.info(`[engine] feedback apply 链自动收口 ${workflowId}（record ${recordId}）`);
    return true;
  };

  const autoSettleFeedbackRuns = async (): Promise<number> => {
    let n = 0;
    for (const w of store.listWorkflows(2000)) {
      if (await settleOneFeedbackRun(w.id)) n++;
    }
    return n;
  };

  /** 已批闸门静默收口的静默阈值：回流执行回合（organic）无 step 载体，
   * CC 长任务一 turn 可达数十分钟——收口必须等「真停了」，5 分钟双静默
   * （事件链 + 会话用量行）是执行中/已停的分界线。 */
  const AUTO_SETTLE_IDLE_MS = 5 * 60_000;

  /** 已批闸门静默收口（wf_be61c3a55842 缺陷二，2026-10-09）：adhoc/nodes
   * 单「闸门已批 + 全链终态」后，回流执行回合跑完即应收口——此前唯一路径
   * 是 agent 自己 POST settle（宪法 2026-10-07 回流即结），实测被 agent 会话
   * 权限层拦截（wf_e62eff8ddba1「by=operator 属冒用操作员身份」），单子
   * 永远挂 running 等人手点。引擎侧把同一裁定落成自动收口，不再依赖 agent
   * 的 Bash 权限。收口条件（全满足才动，逐条守卫）：
   *  1. running + mode=nodes + 有步骤；
   *  2. 全部步骤终态（等待中的闸门/在跑步不收——执行链未走完）；
   *  3. 存在已批准的非问询闸门（delivery != 'answer'：问询闸批准只是回答
   *     了问题，agent 还有后续动作）；
   *  4. 无未送达回流（pendingRelays）——批准的回流指令还没到 agent 手里；
   *  5. 静默双判据（防「回流执行还在跑就被收口」）：①本单事件链最后事件
   *     距今超阈值（有机回合每 turn 落 session_turn）；②认领会话最近
   *     claude_code 用量行距今超阈值（事件静默但行还在涨 = agent 仍在干活）。
   * settleLocked 全部守卫照走（发送承诺未兑现即拒）；逐单 try——一单被拒
   * 不炸整轮。 */
  const settleOneApprovedRun = async (workflowId: string): Promise<boolean> => {
    const w = store.getWorkflow(workflowId);
    if (!w || w.status !== 'running') return false;
    if (w.meta['mode'] !== 'nodes') return false;
    const steps = store.stepsForWorkflow(workflowId);
    if (steps.length === 0) return false;
    if (!steps.every((s) => isSettledStepStatus(s.status))) return false;
    const approved = steps.some((s) => s.kind === 'gate' && s.status === 'completed'
      && asString(s.input['delivery']) !== 'answer');
    if (!approved) return false;
    if (store.pendingRelays().some((r) => r.workflowId === workflowId)) return false;
    const lastAt = store.lastEventAt('workflow', workflowId);
    if (lastAt === '' || Number.isNaN(Date.parse(lastAt))) return false;
    if (now().getTime() - Date.parse(lastAt) < AUTO_SETTLE_IDLE_MS) return false;
    const sess = w.session !== '' ? w.session : asString(w.meta['assigned_session']);
    if (o.lastSessionActivity && sess !== '') {
      const t = o.lastSessionActivity(sess);
      if (t > 0 && now().getTime() - t < AUTO_SETTLE_IDLE_MS) return false;
    }
    try {
      await o.lifecycle.settle(workflowId, 'auto-approve');
    } catch (e) {
      log.warn(`[engine] 已批闸门收口被拒 (${workflowId}，下轮再判): ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    log.info(`[engine] 已批闸门静默收口 ${workflowId}（回流执行完毕，最后事件 ${lastAt}）`);
    return true;
  };

  const autoSettleApprovedRuns = async (): Promise<number> => {
    let n = 0;
    for (const w of store.listWorkflows(2000)) {
      if (await settleOneApprovedRun(w.id)) n++;
    }
    return n;
  };

  /** 杀步段（对齐 zombie.healZombie 先例）：持工作流锁 + 锁内
   * 重读 status==='running' 再落账——引擎并发模型（engine.ts 头注）要求
   * 所有状态转变都在锁内发生；守卫的账本查询与杀写之间，dispatch/hook 的
   * withLock 推进可插队（重派/settle），重读不过=判定作废，绝不凭过期
   * 快照杀步。注意 withLock 不可重入：settle-once 的 completeAgentStep
   * 自带 CAS+锁（agentSettle.ts:224-234 明证调用方不持锁），保持锁外调用。 */
  const killStep = async (st0: Step, error: string): Promise<void> => {
    await o.withLock(st0.workflowId, async () => {
      const cur = store.getStep(st0.id);
      if (!cur || cur.status !== 'running') return;
      store.setStepOutput(cur.id, { error });
      store.setStepStatus(cur.id, 'failed');
      o.journal.stepEvent(cur, 'step_failed', {});
    });
  };

  // 队列自愈（2026-09-21 死槽实测）：占位的定义就是「当前步 running」——
  // 重启守卫判死/漏放行的占位单（如 wf_944164165b24 幽灵槽）会把并发 1
  // 的队列饿死全队。终态/非机器忙的占位一律放位并泵队；evaluateSlot/pump
  // 幂等，60s 一扫对活链零影响。
  const healQueueSlots = (): void => {
    for (const id of [...o.queue.activeIds]) {
      const w = store.getWorkflow(id);
      if (!w || w.status !== 'running' || !o.queue.machineBusy(id)) {
        o.queue.activeIds.delete(id);
        o.queue.pump();
      }
    }
  };

  const reconcileInflight = async (graceMs: number, mode: ReconcileMode): Promise<void> => {
    // 周期对账先自愈再扫描：扫描里的杀步要排工作流锁，自愈只是同步查账放位，
    // 不该陪着等。本轮扫描判死的单，占位由下一轮自愈放掉（60s 内）。重启对账
    // 不提前：启动时 boot 刚泵出的链要等微任务才开始推进，当前步此刻还是
    // pending，自愈若排在扫描之前，必定在同一同步段内把它们当死槽放掉。
    if (mode === 'idle') healQueueSlots();
    const running = store.listSteps('running', RUNNING_SCAN_LIMIT);
    if (running.length >= RUNNING_SCAN_LIMIT) {
      log.warn(`[engine] running 步扫描触顶 ${RUNNING_SCAN_LIMIT}——尾部步本轮未扫（并发堆积请排查）`);
    }
    const cutoff = now().getTime() - graceMs;
    for (const st of running) {
      // 周期对账不排锁：锁被占 = 本进程有推进在途（模板能力步的 LLM/SMTP 调用
      // 就在自己的 advance 里攥着锁），它不是孤儿，本轮跳过、下一轮再看——
      // 排锁等会让整轮扫描卡到那次慢调用结束。重启对账照常排锁：启动时锁的
      // 持有者只会是本进程刚起的短动作（hook 结算、HTTP 动作），killStep 锁内
      // 重读兜得住；重启对账只跑一次，跳过就会漏掉上一进程留下的孤儿。
      if (mode === 'idle' && o.lockBusy(st.workflowId)) continue;
      const updatedAt = new Date(st.updatedAt).getTime();
      switch (st.kind) {
        case 'agent': case 'verify': {
          // verify 并入 agent 语义（2026-11-08 审查 P2）：同一执行器
          // （interpreter runAgentStep）、同一 prompt 账（ledger
          // AGENT_STEP_KINDS=["agent","verify"]）、同一看门狗（zombie.ts）——
          // 曾按模板能力步处理，重启/周期即杀 = agent 照常完成、结果孤儿化。
          if (mode === 'idle' && updatedAt > cutoff) continue; // 宽限期内，hook 说不定还会来
          // 重启对账问「agent 是否活过了重启」——查实际落点会话的 prompt 账
          //（resolved 兜底改道的单在声明会话名下查不到记录=误杀）。
          const session = agentLiveSessionOf(st);
          if (mode === 'restart' && session !== '') {
            const p = store.latestPromptForSession(session, ['submitted']);
            if (p) {
              // 补凭据（2026-11-23 全量审查；2026-11-24 复审 P1-① 收窄）：收工回调
              // 只结算「卡已经交出去」的步（agentSettle 看步骤 output 里的凭据
              // dispatched_prompt_id）。升级前派出的在途步 output 里没有凭据，不补
              // 的话它的收工回调会被拦下、这一步永远结算不了。
              // 只在凭据为空时补，已有的凭据绝不覆盖。同一个会话里可以排着几张
              // 卡，会话上最新的 submitted prompt 未必是这一步的卡：拿它去覆盖，
              // A 的凭据会被改成 B 的卡号。凭据非空就说明这一步自己那一回的卡
              // 已经交出去了（steps.ts 每次派发前会先清空凭据，交出去之后才写）。
              // 只补卡号、不补 dispatched_at：收工回调把没有 dispatched_at 的步
              // 当成最早交出去的，升级前的卡确实最早。
              if (asString(st.output['dispatched_prompt_id']) === '') {
                store.setStepOutput(st.id, { dispatched_prompt_id: p.id });
              }
              continue; // tmux agent 活过了重启——fail 掉会孤儿化它的完成
            }
          }
          const settledPrompt = session === ''
            ? null : store.latestPromptForSession(session, ['completed', 'failed']);
          if (settledPrompt) {
            // 在途 prompt 在我们失明期间已落定。产出回收不抓屏（第 5 轮审查，
            // 与 onAgentStopped 同一结构裁决：capture-pane 只准喂 zombie 检测）
            // ——pane 是终端缓冲，混着 spinner/HUD 的文本经 completeAgentStep
            // 播种会污染闸门/发送链。真实产出走 Stop hook 文件通道（cli/hook.ts
            // 从 transcript 提取 final_message 上报）；失明窗口错过的置空 +
            // agent_output_missing 留痕，晚到的最终答复由 journalSessionTurn
            // 落容器账本。
            o.journal.stepEvent(st, 'agent_output_missing', { session, via: 'reconcile', raw_status: settledPrompt.status });
            await o.agentSettle.completeAgentStep(st, session, settledPrompt.status === 'failed' ? 'error' : 'ok', '');
            continue;
          }
          if (mode === 'restart') await killStep(st, 'restart: no in-flight prompt');
          break;
        }
        case 'triage': case 'draft': case 'send': case 'llm': case 'share': {
          // 模板能力类与 draft 同策略：重启打断供应商调用的，留成 failed
          // 可重试——绝不是幻影 pending 阶梯。
          if (mode === 'idle' && updatedAt > cutoff) continue;
          await killStep(st, 'interrupted by restart');
          break;
        }
        case 'gate': {
          // 不可能的中间态 → 它当时在等人。
          store.setStepStatus(st.id, 'waiting_human');
          o.journal.stepEvent(st, 'step_waiting_human', {});
          break;
        }
      }
    }
    if (mode === 'restart') healQueueSlots();
  };

  // 两个显式入口：restart=重启对账（graceMs 恒 0，杀在途 + submitted
  // 查账放行）；idle=周期对账（宽限 graceMs，绝不杀 agent/verify 步）。
  const reconcileRestart = (): Promise<void> => reconcileInflight(0, 'restart');
  // 周期对账在途闩：runtime 的 60s 定时器不等上一轮结束就再触发；上一轮还没
  // 跑完时，新的调用直接拿到在途那一轮，不叠第二轮去重复排同一批锁。
  let idleRun: Promise<void> | null = null;
  const reconcileIdle = (graceMs: number): Promise<void> => {
    if (idleRun !== null) return idleRun;
    const run = reconcileInflight(graceMs, 'idle').finally(() => { idleRun = null; });
    idleRun = run;
    return run;
  };

  return { reconcileStartup, reconcileIdle, autoSettleFeedbackRuns, autoSettleApprovedRuns };
};

