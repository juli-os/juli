// 僵尸看门狗：pane 指纹心跳 + 静默超时判僵尸 + 中断重建重派 + 转人工。
// 心跳表（lastBeat/lastFp）按引用共享——runAgentStep 派发时点种心跳、hook
// 事件续命，全部走 touchSession 同一入口。

import type { Logger } from '../../platform/events/bus.ts';
import type { LifecycleStore } from '@juli-os/ledger';
import { type Step } from '@juli-os/ledger';
import { agentLiveSessionOf } from './capabilities/index.ts';
import { paneAwaitingInput } from '@juli-os/agents';
import { parsePaneQuestion } from '@juli-os/agents';
import { asString } from '../../platform/shared/json.ts';
import type { JsonValue } from '@juli-os/artifacts';
import { parseDur, type Template, type ZombiePolicy } from '../templates/template.ts';
import type { EngineDeps } from './engine.ts';
import type { Journal } from './journal.ts';
import type { Queue } from './queue.ts';
import { DEFAULT_MAX_ZOMBIE_ATTEMPTS, DEFAULT_ZOMBIE_TIMEOUT_MS } from './support.ts';

export interface Zombie {
  readonly lastBeat: Map<string, Date>;
  readonly lastFp: Map<string, string>;
  touchSession(session: string): void;
  heartbeatOf(session: string, dispatched: Date): Date;
  zombiePolicyMeta(tpl: Template | null): Record<string, JsonValue>;
  zombiePolicyFor(st: Step): { timeoutMs: number; maxAttempts: number };
  sweepZombies(): Promise<void>;
  /** CC Notification hook 入口：标记该会话等输入（粘性豁免+一次性通知）。 */
  noteAwaiting(session: string, message: string): Promise<void>;
}

export const makeZombie = (o: {
  readonly deps: EngineDeps;
  readonly store: LifecycleStore;
  readonly now: () => Date;
  readonly log: Logger;
  readonly getTemplates: () => Readonly<Record<string, Template>>;
  readonly withLock: <T>(workflowId: string, fn: () => Promise<T>) => Promise<T>;
  readonly journal: Journal;
  readonly queue: Pick<Queue, 'continueWorkflow'>;
}): Zombie => {
  const { deps, store } = o;
  const now = o.now;
  const lastBeat = new Map<string, Date>();
  const lastFp = new Map<string, string>();
  // 等输入通知去重（2026-09-28 提问卡单）：每个「静默等待期」只通知一次；
  // pane 恢复变化（人已回答/agent 继续）即清——下轮再等再通知。
  const awaitingNotified = new Map<string, string>(); // stepId → 通知时的指纹
  // hook 等输入标记（CC Notification，2026-09-28 用户裁定「cli hook 更稳妥」）：
  // CLI 结构化信号——粘性豁免直到任何心跳（=agent 已继续/人已回答）。比 pane
  // 正则稳：输出文本含 "Do you want" 不再误判；hook 未注入的老会话由 pane 兜底。
  const awaitingByHook = new Set<string>(); // session 名

  const touchSession = (session: string): void => {
    if (session === '') return;
    lastBeat.set(session, now());
    // 心跳 = agent 活着在干活（人已回答/已继续）——hook 等输入豁免解除。
    awaitingByHook.delete(session);
  };

  const heartbeatOf = (session: string, dispatched: Date): Date =>
    lastBeat.get(session) ?? dispatched;

  const templateForWorkflow = (workflowId: string): Template | null => {
    const w = store.getWorkflow(workflowId);
    // 动态流（无 template_key）→ null：僵尸策略走引擎默认，绝不猜模板。
    const key = w ? asString(w.meta['template_key']) : '';
    if (key !== '') return o.getTemplates()[key] ?? null;
    return null;
  };

  /** meta 快照宽容判型：zombie_policy={timeoutMs,maxAttempts}，非正数判缺。 */
  const parseZombieSnapshot = (v: JsonValue | undefined): { timeoutMs: number; maxAttempts: number } | null => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const t = (v as { timeoutMs?: unknown }).timeoutMs;
    const m = (v as { maxAttempts?: unknown }).maxAttempts;
    return typeof t === 'number' && t > 0 && typeof m === 'number' && m > 0
      ? { timeoutMs: t, maxAttempts: m }
      : null;
  };

  /** 步 input 的 _zombie 快照宽容判型：{timeout,max_attempts} 存模板声明
   * 原文（timeout 字符串 + 次数），形状不对判缺（回落活注册表）。 */
  const parseStepZombie = (v: JsonValue | undefined): ZombiePolicy | null => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const t = (v as { timeout?: unknown }).timeout;
    const m = (v as { max_attempts?: unknown }).max_attempts;
    return typeof t === 'string' && typeof m === 'number'
      ? { timeout: t, maxAttempts: m }
      : null;
  };

  /** 模板（可空）解析成具体的流级策略：非法/缺省回落引擎默认。 */
  const zombiePolicyOfTemplate = (tpl: Template | null): { timeoutMs: number; maxAttempts: number } => {
    let timeoutMs = deps.zombieTimeoutMs ?? DEFAULT_ZOMBIE_TIMEOUT_MS;
    let maxAttempts = deps.maxZombieAttempts ?? DEFAULT_MAX_ZOMBIE_ATTEMPTS;
    if (tpl?.zombie) {
      const d = parseDur(tpl.zombie.timeout);
      if (d > 0) timeoutMs = d;
      if (tpl.zombie.maxAttempts > 0) maxAttempts = tpl.zombie.maxAttempts;
    }
    return { timeoutMs, maxAttempts };
  };

  /** 建流时把流级僵尸策略物化进 meta——模板快照语义的补全：zombie 策略与
   * 阶梯一样是"创建时钉死"的数据，之后的模板编辑绝不改在途流。 */
  const zombiePolicyMeta = (tpl: Template | null): Record<string, JsonValue> =>
    tpl !== null ? { zombie_policy: zombiePolicyOfTemplate(tpl) } : {};

  /** 策略优先级：步级声明 > 流级 > 引擎默认。流级 = meta 快照优先（建流时
   * 物化）；步级 = 步 input 的 _zombie 快照优先（建流随 carryStepConfig 物
   * 化）——两级策略都钉死在建流时点，模板热更绝不改在途流。快照缺失（物化
   * 之前建的存量流/步）才走活注册表——绝不连存量 run 的语义一起改，也绝不
   * 让邮件流的 5m/3 悄悄套在享有 20 分钟安静 ffmpeg 的视频渲染上。 */
  const zombiePolicyFor = (st: Step): { timeoutMs: number; maxAttempts: number } => {
    const snap = parseZombieSnapshot(store.getWorkflow(st.workflowId)?.meta['zombie_policy']);
    const tpl = templateForWorkflow(st.workflowId);
    const base = snap ?? zombiePolicyOfTemplate(tpl);
    let { timeoutMs, maxAttempts } = base;
    // 步级声明 > 流级：_zombie 快照优先；缺失（存量步）才回落活注册表。
    const zs = parseStepZombie(st.input['_zombie']);
    if (zs) {
      const d = parseDur(zs.timeout);
      if (d > 0) timeoutMs = d;
      if (zs.maxAttempts > 0) maxAttempts = zs.maxAttempts;
    } else if (tpl) {
      const ref = asString(st.input['_ref']);
      if (ref !== '') {
        const ts = tpl.steps.find((x) => x.id === ref);
        if (ts?.zombie) {
          const d = parseDur(ts.zombie.timeout);
          if (d > 0) timeoutMs = d;
          if (ts.zombie.maxAttempts > 0) maxAttempts = ts.zombie.maxAttempts;
        }
      }
    }
    return { timeoutMs, maxAttempts };
  };

  /** hook 等输入入口（CC Notification → /api/agents/:s/awaiting，2026-09-28
   * 用户裁定「升格为 step+审核」）：挂**问询闸门**（waiting_human 上审批面，
   * 选择题按钮点选即回答）+ 豁免标记 + 一次性通知。答案由批准回流机关送回
   * 会话（approve 分支认 delivery='answer'）。无 running 步的 idle 通知 no-op。
   * 全程持工作流锁（九跑 P2 边角①）：pane 采集在锁内 await（原实现 String(Promise)
   * 恒得 "[object Promise]"——问询闸菜单选项永丢，选择题闸退化为 yes/no）；
   * 锁内重读步/工作流/既有闸，与 Stop hook 结算、闸门动作串行化。 */
  const noteAwaiting = async (session: string, message: string): Promise<void> => {
    if (session === '') return;
    const st0 = store.runningAgentStepForSession(session);
    if (st0 === null) return; // 无在途步：idle 通知不标记（Stop 已结算）
    await o.withLock(st0.workflowId, async () => {
      // 锁内重读：等锁期间 stop hook 可能已把步结算掉。
      const st = store.runningAgentStepForSession(session);
      if (st === null) return;
      const w = store.getWorkflow(st.workflowId);
      if (w === null || w.status !== 'running') return;
      // 去重：本单已有等人的问询闸 → 不重复挂（CC 每权限请求一发）。
      const steps = store.stepsForWorkflow(w.id);
      const existing = steps.find((g) => g.kind === 'gate' && g.status === 'waiting_human'
        && asString(g.input['question_session']) === session);
      if (existing !== undefined) return;
      if (!awaitingByHook.has(session)) awaitingByHook.add(session);
      // 采集问题+选项：pane（菜单编号行=选择题）+ hook message（问题人话）。
      const fpFn = deps.zombieFingerprint ?? deps.captureOutput;
      let pane = '';
      if (fpFn) {
        const p = await fpFn(session).catch(() => null);
        if (p !== null) pane = String(p);
      }
      const q = parsePaneQuestion(pane, message);
      // 挂闸：链尾追加 waiting_human 问询闸（当前步仍 running 挡着 advance，
      // 闸直接置等人在审批面可见；人回答后闸 completed，agent 续跑结算原步）。
      const lastSeq = steps.at(-1)?.seq ?? st.seq;
      store.insertStepsAt(w.id, lastSeq, [{
        kind: 'gate', title: `问询：${q.question.slice(0, 40)}`,
        input: {
          delivery: 'answer', question: q.question,
          question_options: q.options as unknown as JsonValue[],
          question_session: session, question_step: st.id,
        },
      }]);
      const g = store.stepsForWorkflow(w.id).at(-1);
      if (g !== undefined) {
        store.setStepStatus(g.id, 'waiting_human');
        o.journal.stepEvent(g, 'question_gate_opened', {
          session, question: q.question.slice(0, 160), options: q.options.length,
          ...(message !== '' ? { message: message.slice(0, 120) } : {}),
        });
      }
      o.journal.stepEvent(st, 'agent_awaiting_input', {
        session, source: 'hook', gate: true,
        ...(message !== '' ? { message: message.slice(0, 160) } : {}),
      });
      const ai = deps.pusher?.awaitingInput;
      if (ai) void o.journal.pushBestEffort('awaitingInput', () =>
        ai(w, st, `会话 ${session} 的 agent 在等你回答——已生成问询闸门，到流水审批面点选答案即续跑`));
    });
  };

  const sweepZombies = async (): Promise<void> => {
    const running = store.listSteps('running', 200);
    for (const st of running) {
      if (st.kind !== 'agent' && st.kind !== 'verify') continue;
      const { timeoutMs, maxAttempts } = zombiePolicyFor(st);
      // 盯实际落点会话（resolved）：声明会话可能不存在（渠道路由键悬空被
      // 兜底改道）——盯错对象 = 永远「静默」= 对在跑会话误判僵尸重复投递
      //（2026-09-21 深夜事故，3 单 submit_unconfirmed 判死于此）。
      const session = agentLiveSessionOf(st);
      if (session === '') continue;
      // pane 指纹心跳：干活的 agent 不断重绘 pane（转圈/工具输出）——任何
      // 变化都算活着。首次见到某会话设基线并给一轮宽限（也覆盖重启在途）。
      let firstSeen = false;
      let paneText: string | null = null;
      const fingerprintFn = deps.zombieFingerprint ?? deps.captureOutput;
      if (fingerprintFn) {
        const pane = await fingerprintFn(session).catch(() => null);
        if (pane !== null) {
          paneText = String(pane);
          const fp = String(pane.length) + ':' + hashFingerprint(pane);
          const prev = lastFp.get(session);
          lastFp.set(session, fp);
          if (prev === undefined) firstSeen = true;
          else if (fp !== prev) touchSession(session);
          // 指纹变了 = 人已回答或 agent 已继续 → 清等待通知去重。
          if (prev !== undefined && fp !== prev) awaitingNotified.delete(st.id);
        }
      }
      // 等输入豁免（2026-09-28 提问卡单修复）：agent 在等人在终端回答（权限/
      // 选择/提问）是健康等待不是僵尸——打断+重派会把一次将成的交付拍死。
      // 两级信号：hook 标记（CC Notification 自报，粘性到心跳）优先；
      // pane 指纹（编号菜单/权限问句）兜底——hook 未注入的老会话靠它。
      if (awaitingByHook.has(session)) continue;
      if (paneText !== null && paneAwaitingInput(paneText)) {
        const fpKey = lastFp.get(session) ?? '';
        if (awaitingNotified.get(st.id) !== fpKey) {
          awaitingNotified.set(st.id, fpKey);
          o.journal.stepEvent(st, 'agent_awaiting_input', { session, silent_for: `${Math.round(silentMsOf(st, session) / 1000)}s` });
          const w0 = store.getWorkflow(st.workflowId);
          const ai = deps.pusher?.awaitingInput;
          if (w0 && ai) void o.journal.pushBestEffort('awaitingInput', () => ai(w0, st, `会话 ${session} 的 agent 在等你回答（权限/选择/提问）——进终端回复即续跑`));
        }
        continue; // 绝不判死等输入态
      }
      const silentMs = silentMsOf(st, session);
      if (silentMs < timeoutMs || firstSeen) continue;
      await healZombie(st, session, silentMs, maxAttempts);
    }
  };

  const silentMsOf = (st: Step, session: string): number =>
    now().getTime() - heartbeatOf(session, new Date(st.updatedAt)).getTime();

  const hashFingerprint = (s: string): string => {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return String(h);
  };

  const healZombie = async (st0: Step, session: string, silentMs: number, maxTries: number): Promise<void> => {
    const wfID = st0.workflowId;
    await o.withLock(wfID, async () => {
      // 锁内重读：等锁期间 stop hook 可能已把步结算掉。
      const cur = store.getStep(st0.id);
      if (!cur || cur.status !== 'running') return;
      // 落点守卫（2026-09-28 双投事故②）：等锁期间步的实际落点已变（改道/
      // 重派/结算竞态）→ 本次判定作废——绝不向非落点会话发 C-c，也绝不按
      // 旧地址重派。静默判定与处置必须对准同一个活会话。
      if (agentLiveSessionOf(cur) !== session) return;
      const st = cur;
      const attempts = typeof st.input['zombie_attempts'] === 'number'
        ? st.input['zombie_attempts'] : 0;

      o.journal.stepEvent(st, 'agent_zombie', {
        session, silent_for: `${Math.round(silentMs / 1000)}s`,
        attempt: attempts + 1, max: maxTries,
      });
      if (deps.interruptSession && !(await deps.interruptSession(session).catch(() => false))) {
        o.journal.stepEvent(st, 'agent_interrupt_failed', {});
      } else if (deps.interruptSession) {
        o.journal.stepEvent(st, 'agent_interrupted', { session });
      }
      if (deps.rebuildAgent && !(await deps.rebuildAgent(session).catch(() => false))) {
        o.journal.stepEvent(st, 'agent_rebuild_failed', {});
      } else if (deps.rebuildAgent) {
        o.journal.stepEvent(st, 'agent_thread_rebuilt', { session });
      }

      if (attempts + 1 >= maxTries) {
        store.setStepOutput(st.id, {
          error: `zombie: ${attempts + 1} 次中断重建重派后仍无心跳，转人工`,
        });
        store.setStepStatus(st.id, 'failed');
        o.journal.stepEvent(st, 'step_failed', { error: 'zombie: attempts exhausted' });
        o.journal.recordDecision(wfID, st.seq, 'zombie_failed', `attempt ${attempts + 1}/${maxTries}`, 'watchdog');
        return;
      }
      // 重派：pending + 计数器；Advance 用原 input（plan/session/种子全在）
      // 重跑这一跳。
      store.setStepInput(st.id, { zombie_attempts: attempts + 1 });
      store.setStepStatus(st.id, 'pending');
      o.journal.stepEvent(st, 'step_redispatched', { session, attempt: attempts + 1, max: maxTries });
      o.queue.continueWorkflow(wfID);
    });
  };

  return {
    lastBeat, lastFp, touchSession, heartbeatOf,
    zombiePolicyMeta, zombiePolicyFor, sweepZombies, noteAwaiting,
  };
};

