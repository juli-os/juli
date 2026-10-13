// 业务流引擎（装配面）：一封入站邮件/一次手动触发生成带持久阶梯的 workflow，
// 由解释器推进。阶梯是数据（模板），引擎只拥有状态转变；agent 派发
// （tmux/ACP）、推送（APNs/Bark）、LLM、SMTP 全部是注入端口。
// 尽力而为：推送失败绝不阻塞闸门状态本身。
//
// 2026-09-23 分层重构：原 3256 行闭包拆为域模块，本文件只留装配与公开
// API（EngineDeps/Engine + 组合）。模块清单（各自声明所需依赖，可独立阅读）：
//   support.ts      纯助手（常量/任务卡模板/附件宣称/feedback 判据）
//   journal.ts      记账与 LLM 服务（stepEvent 失败镜像/案卷追加/completeLlm）
//   queue.ts        收单台（并发槽/FIFO/泵）
//   zombie.ts       僵尸看门狗（指纹心跳/中断重建重派）
//   steps.ts        步执行器（openGate/runAgentStep/runSendStep）
//   interpreter.ts  解释器（advanceLocked/makeCtx/kind 分派）
//   agentSettle.ts  agent 结算（completeAgentStep/有机回合/自愈补闸）
//   relay.ts        回流与定档扫描（外发箱补投/到点续推）
//   actions.ts      闸门动作（approve/deny/resolve/rework/align）
//   human.ts        人工动作（intervene/amend/reworkSend/handoff/retry）
//   lifecycle.ts    生命周期（起单族/收口族）
//   reconcile.ts    对账（重启清算/回填补闸/apply 自动收口）
//   intake.ts       进件（邮件/泛化渠道全链）
//   ../routing/decision.ts 路由判定纯函数（decideRoute/isInternalSender）
//
// 并发模型：每工作流一把 promise 链锁（withLock）——与 Go 的 per-workflow
// mutex 对应。所有状态转变都在锁内发生：推进（advance）、闸门动作
// （approve/deny/resolve/rework/align/retry）、nodes 追加（appendNode）、
// hook/僵尸对账（settle 路径），全部锁内重读后结算，配合 claimRunningStep
// 的 CAS 实现 settle-once。注意 withLock 是队列不是可重入锁：锁内 await 续推
// 一律 advanceLocked（await advance 会排队等自己——静默死锁）；唯一例外是
// 闸门动作壳尾的 void advance——不 await、排到本锁之后串行，下游长链
// （LLM 最长 180s/发送探活/SMTP）绝不串进 HTTP 请求等待。
//
// 环与晚绑（late）：事件驱动状态机的函数图天然有环（queue→advance→steps→
// completeAgentStep→settle→queue……）。装配期用一个 late 持有器破环——
// 各模块拿到的 late 引用最后统一回填真身，装配期调用即抛错（fail loud）。

import { type Clock, type IdGen, systemClock } from '@juli-os/artifacts';
import { holdVerdict, validHoldWindow, type HoldWindowConfig } from '../../platform/shared/windowHold.ts';
import type { JsonRecord, JsonValue } from '@juli-os/artifacts'
import { consoleLogger, type Logger } from '../../platform/events/bus.ts';
import type { LifecycleStore } from '@juli-os/ledger';
import { type Step, type StepKind, type Workflow } from '@juli-os/ledger';
import type { DispatcherPort, EmailMessage, LlmPort, MailerPort, PusherPort, SessionDelivery, ArtifactPort } from '../../contracts/ports.ts';
import { type SyncDispatcherPort } from '@juli-os/agents';
import { type JudgmentGateway } from '@juli-os/routing';
import type { InboundMessage } from '../../contracts/channels.ts';
import type { PartyDirectory } from '../party/party.ts';
import { type AuthzPolicy, defaultAuthzPolicy } from '../../contracts/authz.ts';
import type { Template } from '../templates/template.ts';
import type { Routing } from '@juli-os/routing';
import { makeJournal } from './journal.ts';
import { makeQueue } from './queue.ts';
import { makeZombie } from './zombie.ts';
import { makeSteps } from './steps.ts';
import { makeInterpreter } from './interpreter.ts';
import { makeAgentSettle } from './agentSettle.ts';
import { makeRelay } from './relay.ts';
import { makeGateActions } from './actions.ts';
import { makeHumanActions } from './human.ts';
import { makeLifecycle } from './lifecycle.ts';
import { makeReconcile } from './reconcile.ts';
import { makeIntake } from './intake.ts';

// ---- 端口与依赖 ---------------------------------------------------------------

export interface EngineDeps {
  readonly store: LifecycleStore;
  readonly llm: LlmPort | null;
  readonly model: string;
  readonly routing: Routing;
  readonly dispatch: DispatcherPort | null;
  readonly syncDispatch: SyncDispatcherPort | null;
  readonly pusher: PusherPort | null;
  readonly mailer: MailerPort | null;
  /** 抓取会话的最终答复（tmux capture / 结构化输出）。 */
  readonly captureOutput: ((session: string) => Promise<string | null>) | null;
  /** 会话工作区解析（注册项目目录优先，pane 实时 cwd 兜底）。 */
  readonly workspaceFor: ((session: string) => string) | null;
  /** 一等插话/回流通道：intervene 与 relay 外发箱的投递面（生产=tmux
   * bracketed paste 入队语义；测试注入 mock）。失败必须带原因。与
   * interruptSession 分职：那是打断，这是递话。 */
  readonly sendToSession?: ((session: string, text: string) => Promise<SessionDelivery>) | null;
  /** 回流送达验证：读回 pane（含历史）确认标记到达——外发箱防重复投递。 */
  readonly readPane?: ((session: string) => Promise<string | null>) | null;
  /** 可用会话白名单——triage 提示词只能从这里选。 */
  readonly availableSessions: readonly string[];
  /** LLM 路由名 → 实时会话的别名解析。 */
  readonly resolveSession: ((session: string) => string) | null;
  /** 语义判定网关（Jev，可选）：缺省=全场景 off，零行为零网络。 */
  readonly judgment?: JudgmentGateway;
  /** 执行时任务路由（2026-10-13 判定收敛执行层）：三无单（无显式 session/
   * 无挂靠/无显式档位）在派发时刻问一次落点（jev+忙闲实时），替代进件时
   * 判定（快照过期收口）。结构型 TaskLanding（session/via/note/diverted），
   * 免类型依赖穿透围栏。缺省=不判（default 兜底旧行为）。 */
  readonly taskRoute?: (title: string, brief: string) => Promise<{ session: string; via: string; note: string; diverted: boolean } | null>;
  /** 执行时档位判定（task_tier 场景）：判 high 才升档，缺省=不判。 */
  readonly taskTier?: (title: string, brief: string) => Promise<'high' | null>;
  /** 命名孪生查找（session+'-hi' 在声明表且 high 才算）：缺省=无孪生不升档。 */
  readonly highTwinFor?: (session: string) => string;
  /** 僵尸自愈接缝。 */
  readonly interruptSession: ((session: string) => Promise<boolean>) | null;
  readonly rebuildAgent: ((session: string) => Promise<boolean>) | null;
  readonly clock?: Clock;
  /** 工作时间窗 hold（2026-09-28，config.work_hours）：窗口内非 high 单在收单台
   * hold（pump 扫描跳过保队位），到点由 holdSweep 放行。缺省 off=旧行为。 */
  readonly workHours?: HoldWindowConfig;
  readonly ids?: IdGen;
  readonly log?: Logger;
  /** 429 退避基数（毫秒）：生产 3000，测试注入 1 免真实等待。 */
  readonly llmRetryDelayMs?: number;
  readonly usage?: (r: { source: string; note?: string; model?: string; inputTokens?: number; outputTokens?: number; durationMs?: number }) => void;
  /** 工件端口（字节侧 + case-inbox 收编）；null = 工件采集关闭。 */
  readonly artifacts?: ArtifactPort | null;
  /** 发送红线词表（正文硬守卫；命中即拒发）。 */
  readonly redlineWords?: readonly string[];
  /** 发送前置检查的 URL 探活接缝（默认真实 fetch HEAD，3s 超时 best-effort）；
   * 测试注入 mock 即可确定性断言 url_probe 检查，不碰真实网络。 */
  readonly probeUrl?: ((url: string) => Promise<boolean>) | null;
  /** 外链接缝（OSS/S3 presign）：share 步把工件换成可访问 URL。 */
  readonly externalLink?: ((a: { readonly id: string; readonly name: string; readonly key: string }) => Promise<string | null>) | null;
  /** agent 交付投递目录（case-inbox），null = 扫描关闭。 */
  readonly caseInboxDir?: ((workflowId: string) => string) | null;
  /** 僵尸看门狗引擎级默认（对齐 Go ZombieTimeout/MaxZombieAttempts 旋钮）。 */
  readonly zombieTimeoutMs?: number;
  readonly maxZombieAttempts?: number;
  /** pane 指纹接缝（与 captureOutput 分职：指纹只要可比较的字节面）。 */
  readonly zombieFingerprint: ((session: string) => Promise<string | null>) | null;
  /** 初始模板集（磁盘注册表加载结果）。 */
  readonly templates?: Readonly<Record<string, Template>>;
  readonly authz?: AuthzPolicy;
  /** 收单台并发上限（默认 1：一次只跑一张单的机器链；闸门等待不占位）。 */
  readonly queueConcurrency?: number;
  /** Party 目录（第三期：当事人=Twenty CRM 引用）。null = 未接 Twenty——
   * 进件不查 CRM，party 缺省。所有调用都被引擎侧 try+超时兜底包住，CRM
   * 故障绝不阻断邮件进件（安全底线，测试锁定）。 */
  readonly partyDirectory?: PartyDirectory | null;
  /** 陌生外部地址自动在 Twenty 建档（config party.auto_create，默认 false）。
   * 开了也必须先查再建（幂等由目录实现保证）。 */
  readonly partyAutoCreate?: boolean;
  /** Party 目录单次调用超时（毫秒，默认 2000；测试注入小值免真等）。 */
  readonly partyTimeoutMs?: number;
  /** 认领会话最近一行 claude_code 用量的 epoch ms（无行=0）——已批闸门
   * 静默收口的判据②（usage 库在 runtime 层创建，经此注入）。null/缺省 =
   * 只用事件链静默判据。 */
  readonly lastSessionActivity?: ((session: string) => number) | null;
}

export interface Engine {
  // 触发
  onEmailReceived(m: EmailMessage): Promise<void>;
  /** 泛化入站：按渠道名路由到 trigger 匹配的模板（email 渠道走专用路径）。 */
  onInbound(m: InboundMessage): Promise<void>;
  startEmailWorkflow(m: EmailMessage): Promise<Workflow>;
  startFlow(templateKey: string, title: string, input: JsonRecord, onlySteps?: readonly string[]): Promise<Workflow>;
  /** 人工中止 running 单（前端"中止"按钮的引擎面）。 */
  forceClose(workflowId: string, note: string, by: string): Promise<void>;
  /** 免模板起单（动态模型标准入口）。 */
  startTask(title: string, input: JsonRecord): Promise<Workflow>;
  /** nodes 模式:追加一个动作节点并立即推进(append-and-run)。 */
  appendNode(workflowId: string, def: { kind: StepKind; title: string; input?: JsonRecord }): Promise<Step>;
  /** nodes 模式:人工结算收口(run 完成落账)。 */
  settle(workflowId: string, by: string): Promise<void>;
  /** 单步取消（断点六③）：只许 pending/waiting_human 步——running/终态拒绝。
   * auto-pair 与手动 send 撞车后多余重复节点的合规取消通道。 */
  cancelStep(stepId: string, note: string, by: string): Promise<void>;
  // 推进
  advance(workflowId: string): Promise<void>;
  /** 收单台快照：并发上限 / 正占位 / 等待中（按队序）/ 窗口 hold 中。 */
  queueStatus(): { concurrency: number; active: readonly string[]; waiting: readonly string[]; held: readonly string[] };
  /** hold 放行泵（runtime 60s 心跳调）：窗口关后把 hold 中的单按原队序放行。
   * 窗口未关/无 hold 单时零操作（pump 幂等）。 */
  holdSweep(): void;
  /** agent 等输入（CC Notification hook）：僵尸豁免（粘性到心跳）+ 通知人。 */
  noteAwaiting(session: string, message: string): Promise<void>;
  /** 人工放行 hold 单（窗口内立即派发）：meta.hold_released 持久覆盖 +
   * hold_released 事件留痕 + 即刻泵队。人的动词优先于窗口策略。 */
  releaseHold(workflowId: string, by: string): void;
  /** 统一干预（四件套）：session（改派+钉住不被改道）/context（追加上下文，
   * 派发时拼进任务卡，one-shot）/priority（即时写）/时机（hold_until 压单
   * 或 dispatch_now 立即放行）。前两类存 meta.override 由派发点消费销账；
   * 后两类即时生效。任何状态可设——「状态迁移时人插得进手」的落点。 */
  setOverride(workflowId: string, patch: {
    readonly session?: string; readonly context?: string;
    readonly priority?: 'high' | 'normal';
    readonly hold_until?: string; readonly dispatch_now?: boolean;
  }, by: string): void;
  // 闸门动作
  approve(stepId: string, note: string, by: string, sendAt?: string): Promise<void>;
  deny(stepId: string, note: string, by: string): Promise<void>;
  resolve(stepId: string, note: string, by: string): Promise<void>;
  rework(stepId: string, feedback: string, by: string): Promise<void>;
  /** 对齐修正：审阅人就地改理解——修正文本成为新工件（actor=人），
   * 下游 agent 步的 input 锚定人定稿版本（修正优先级最高）。 */
  align(stepId: string, amendment: string, by: string): Promise<void>;
  /** 一等插话：向在途 agent 步递补充指示——投递成功才落账（step input
   * 干预史 + activity + 事件三处留痕），与裸 send-keys 的区别就在这层。 */
  intervene(stepId: string, text: string, by: string): Promise<void>;
  closeWorkflow(workflowId: string, note: string, by: string): Promise<void>;
  retry(stepId: string, patch?: { plan?: string; prompt?: string; session?: string }, by?: string): Promise<void>;
  /** 补料：给人开合法修正窗口——卡住/失败步骤的 input 缺 key 时，把字段补上
   * 重新渲染重跑。快照不解锁（原值在事件链里），补料本身记账（谁改了什么）。 */
  amendStep(stepId: string, patch: JsonRecord, by: string): Promise<void>;
  /** 补料候选值：从关联单 meta / 本单邮件桶推导预填（人的记忆不进防线）。 */
  amendSuggestions(workflowId: string): JsonRecord;
  /** 发送守卫拒发的打回补正：prev agent 步带 feedback 重做，send 步重臂。 */
  reworkSend(stepId: string, feedback: string, by: string): Promise<void>;
  /** 转派（task-handoff）：agent 提案 domain，引擎校验+追加执行步+留痕。 */
  handoff(workflowId: string, domain: string, reason: string, by: string): Promise<{ from: string; to: string }>;
  assignSession(workflowId: string, session: string, by: string): Promise<void>;
  // agent 结算
  onAgentStopped(session: string, status: string, finalMessage?: string): Promise<void>;
  /** 定档扫描：到点的定时发送续推（runtime 周期调用）。 */
  sweepSchedules(): Promise<void>;
  /** 回流外发箱扫描：欠款补投 + 卡死告警（runtime 周期调用）。 */
  sweepRelays(): Promise<void>;
  recordActivity(session: string, event: string, text: string): Promise<void>;
  touchSession(session: string): void;
  sweepZombies(): Promise<void>;
  // 对账
  reconcileStartup(): Promise<void>;
  /** feedback apply 链自动收口扫描（闸已批+证据齐→settle）。返回收口数。 */
  autoSettleFeedbackRuns(): Promise<number>;
  /** 已批闸门静默收口扫描（闸已批+全链终态+双静默超阈值→settle，
   * wf_be61c3a55842：agent 自 settle 被其会话权限层拦，引擎兜底）。返回收口数。 */
  autoSettleApprovedRuns(): Promise<number>;
  reconcileInflight(): Promise<void>;
  // 注册表与策略
  setTemplates(m: Readonly<Record<string, Template>>): void;
  currentTemplates(): Readonly<Record<string, Template>>;
  setAuthz(p: AuthzPolicy): void;
  currentAuthz(): AuthzPolicy;
}

// ---- 引擎工厂 -------------------------------------------------------------------

export const createEngine = (deps: EngineDeps): Engine => {
  const store = deps.store;
  const clock = deps.clock ?? systemClock;
  const log = deps.log ?? consoleLogger;
  const now = (): Date => clock.now();

  // 可变状态：模板注册表 / 授权策略 / 每工作流锁。
  let templates: Readonly<Record<string, Template>> = deps.templates ?? {};
  let authz: AuthzPolicy = deps.authz ?? defaultAuthzPolicy;
  const getTemplates = (): Readonly<Record<string, Template>> => templates;
  const getAuthz = (): AuthzPolicy => authz;

  // 注意：这是队列不是可重入锁——锁内若改用 await advance()（而非
  // advanceLocked）就会排队等自己、静默死锁；锁内续推一律走 advanceLocked。
  const locks = new Map<string, Promise<unknown>>();
  const withLock = async <T>(workflowId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(workflowId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(workflowId, tail);
    void tail.then(() => {
      if (locks.get(workflowId) === tail) locks.delete(workflowId); // 防累积
    });
    return run;
  };

  // 晚绑持有器：破函数图之环（见文件头「环与晚绑」）。装配期被调用即抛错。
  const late: {
    advance: (workflowId: string) => Promise<void>;
    advanceLocked: (workflowId: string) => Promise<void>;
    settle: (workflowId: string, by: string) => Promise<void>;
    completeAgentStep: (st: Step, session: string, status: string, output: string) => Promise<boolean>;
    autoSettleFeedbackRuns: () => Promise<number>;
  } = {
    advance: async () => { throw new Error('engine wiring incomplete: late.advance'); },
    advanceLocked: async () => { throw new Error('engine wiring incomplete: late.advanceLocked'); },
    settle: async () => { throw new Error('engine wiring incomplete: late.settle'); },
    completeAgentStep: async () => { throw new Error('engine wiring incomplete: late.completeAgentStep'); },
    autoSettleFeedbackRuns: async () => { throw new Error('engine wiring incomplete: late.autoSettleFeedbackRuns'); },
  };

  const queueConcurrency = deps.queueConcurrency && deps.queueConcurrency > 0
    ? deps.queueConcurrency : 1;

  const journal = makeJournal({ deps, store, now, log });
  // hold gate（2026-09-28 工作时间窗）：hold 判定在收单台 pump 出手前——
  // 「单已起、agent 未派」的等待态不烧 token；窗口/坏配置 fail-open（verdict
  // 已兜）+ scope=feedback 只圈 feedback 进件单 + priority=high 直通。
  const workflowPriority = (w: { meta?: Record<string, unknown> }): string => {
    const ti = w.meta?.['template_input'];
    const fromInput = ti !== null && typeof ti === 'object' && !Array.isArray(ti)
      ? (ti as Record<string, unknown>)['priority'] : undefined;
    const p = typeof fromInput === 'string' && fromInput !== '' ? fromInput : w.meta?.['priority'];
    return typeof p === 'string' ? p : 'normal';
  };
  // feedback 进件单谓词（与 feedbackIntake 的 isFeedbackWf 同构——engine 不准
  // import business/intake（arch 白名单），此处成对维护，改一处必查另一处）。
  const isFeedbackWorkflow = (w: { meta?: Record<string, unknown> }): boolean => {
    const ti = w.meta?.['template_input'];
    return ti !== null && typeof ti === 'object' && !Array.isArray(ti)
      && typeof (ti as Record<string, unknown>)['feedback_record_id'] === 'string';
  };
  const workHours = deps.workHours;
  // hold gate 常驻定义（2026-09-28 四件套修正）：人工 hold_until 独立于
  // work_hours 窗口存在——没配窗口也要能压单（人的时机决定不依赖窗口策略）。
  // 判序：已放行 > 人工 hold_until 未到期 > high 直通 > （有窗口配置才判）
  // 窗口内 on + scope 圈定。
  const holdGate = (workflowId: string): boolean => {
    const w = store.getWorkflow(workflowId);
    if (w === null) return false;
    // 忙会话腿（2026-10-13 双落点事故）：目标会话有未完单时不硬闯派发——
    // 钉住（人显式点名）/绑定/全忙（无空闲替代）压单等待；有空闲替代则
    // 放行由 steps 守卫改道。任何 settle/停放都会泵队，会话空出自然放行
    // （事件驱动，无定时器）。排在人工放行/窗口腿之前：一活单一会话的
    // 不变量高于时机策略（人放行的是「现在派」，不是「挤进去」）。
    // availableSessions 空=可用面未知，fail-open 放行（守卫兜底旧行为）。
    if (w.status === 'queued') {
      const st = store.currentStep(workflowId);
      const sess = st !== null && st.status === 'pending' && st.kind === 'agent'
        && typeof st.input['session'] === 'string' ? (st.input['session'] as string).trim() : '';
      const avail = deps.availableSessions ?? [];
      if (sess !== '' && avail.length > 0) {
        // 占用=已派发在跑的单（running）——同会话排队的兄弟单不算占（否则
        // 两个等待单互相视为忙=死锁）；0930「排队也是忙」口径保留给下面的
        // 改道候选判定（idleAlt 用 sessionHasOpenWork，queued 计忙防堆积）。
        const occupied = store.listWorkflows(500).some((x) => x.id !== workflowId && x.status === 'running'
          && (x.session === sess || (x.meta?.['assigned_session'] ?? '') === sess));
        if (occupied) {
        const pinV = st!.input['session_pinned'];
        const pinned = pinV === true || pinV === 'true';
        const boundNames = (deps.routing.boundAgents ?? []).map((b) => b.session);
        const idleAlt = (deps.routing.agents ?? []).some((a) =>
          a.session !== '' && a.session !== sess && !boundNames.includes(a.session)
          && a.model_tier !== 'high' && avail.includes(a.session)
          && !store.sessionHasOpenWork(a.session, workflowId));
        if (pinned || boundNames.includes(sess) || !idleAlt) return true;
        }
      }
    }
    if (w.meta['hold_released'] === true) return false;
    const hu = w.meta['hold_until'];
    if (typeof hu === 'string' && hu !== '' && !Number.isNaN(Date.parse(hu)) && now().getTime() < Date.parse(hu)) return true;
    if (workflowPriority(w) === 'high') return false;
    if (workHours === undefined) return false;
    const v = holdVerdict(now(), workHours);
    if (!v.inWindow || v.mode !== 'on') return false;
    if (workHours.scope === 'feedback' && !isFeedbackWorkflow(w)) return false;
    return true;
  };
  if (deps.workHours !== undefined && !validHoldWindow(deps.workHours)) {
    log.error(`[engine] work_hours 窗口配置不可执行（start/end 非法或重合）——hold 不生效，按 off 处理`);
  }
  const queue = makeQueue({ store, queueConcurrency, late, holdGate });
  const zombie = makeZombie({ deps, store, now, log, getTemplates, withLock, journal, queue });
  const steps = makeSteps({ deps, store, now, log, withLock, journal, queue, zombie, late });
  const interpreter = makeInterpreter({ deps, store, clock, now, log, journal, steps });
  const agentSettle = makeAgentSettle({ deps, store, now, log, journal, queue, steps, late, withLock });
  const relay = makeRelay({ deps, store, now, log, journal, late });
  const gateActions = makeGateActions({ deps, store, now, log, withLock, journal, queue, relay, steps });
  const lifecycle = makeLifecycle({ deps, store, now, log, withLock, journal, queue, zombie, getTemplates, advanceLocked: interpreter.advanceLocked });
  const human = makeHumanActions({ deps, store, now, log, withLock, journal, queue, agentSettle, zombie, late });
  const reconcile = makeReconcile({ deps, store, now, log, journal, queue, agentSettle, lifecycle, lastSessionActivity: deps.lastSessionActivity });
  const intake = makeIntake({ deps, store, clock, now, log, getAuthz, queue });

  // 对齐 Go 的"尽力而为"：store/端口异常记日志，绝不沿 fire-and-forget
  // 变成 unhandled rejection 打死进程。仍可 await（确定性测试的排空点）。
  const advance = async (workflowId: string): Promise<void> => {
    try {
      await withLock(workflowId, () => interpreter.advanceLocked(workflowId));
    } catch (e) {
      log.error(`advance ${workflowId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 晚绑回填：全部模块装配完毕，环闭合。
  late.advance = advance;
  late.advanceLocked = interpreter.advanceLocked;
  late.settle = lifecycle.settle;
  late.completeAgentStep = agentSettle.completeAgentStep;
  late.autoSettleFeedbackRuns = reconcile.autoSettleFeedbackRuns;

  // ---- 注册表与策略 -----------------------------------------------------------------

  const setTemplates = (m: Readonly<Record<string, Template>>): void => { templates = m ?? {}; };
  const currentTemplates = (): Readonly<Record<string, Template>> => templates;
  const setAuthz = (p: AuthzPolicy): void => { authz = p; };
  const currentAuthz = (): AuthzPolicy => authz;

  // 启动重排队（队列落库的另一面）：桌面应用重启是常态，queued 行按
  // created_at 升序回队——到达序不因重启洗牌。listWorkflows 是倒序，反转即入队序。
  // review F6：另一类孤儿同场救援——上一进程崩溃在「续走窗口」（闸门已批、
  // 下一步 pending、单 running、未及泵）的单：有 pending 步、无 running/
  // waiting_human 步（真实在飞 agent 与等人单绝不碰）→ 回队重派。nodes
  // 空档单（全终态等动作）不满足「有 pending」天然排除。
  for (const w of [...store.listWorkflows(2000)].reverse()) {
    if (w.status === 'queued') { queue.enqueueBack(w.id); continue; }
    if (w.status !== 'running') continue;
    const steps0 = store.stepsForWorkflow(w.id);
    if (steps0.length === 0) continue;
    if (steps0.some((s) => s.status === 'running' || s.status === 'waiting_human')) continue;
    if (steps0.some((s) => s.status === 'pending')) {
      log.info(`[queue] 启动救援:running 孤儿 ${w.id}（无在飞步、有 pending）回队`);
      queue.enqueueBack(w.id);
    }
  }

  return {
    onEmailReceived: intake.onEmailReceived,
    onInbound: intake.onInbound,
    startEmailWorkflow: intake.startEmailWorkflow,
    startFlow: lifecycle.startFlow,
    startTask: lifecycle.startTask,
    forceClose: lifecycle.forceClose,
    appendNode: lifecycle.appendNode,
    settle: lifecycle.settle,
    cancelStep: lifecycle.cancelStep,
    advance,
    queueStatus: queue.queueStatus,
    holdSweep: () => queue.pump(),
    noteAwaiting: (session, message) => zombie.noteAwaiting(session, message),
    setOverride: (workflowId, patch, by) => {
      const w = store.getWorkflow(workflowId);
      if (w === null || (w.status !== 'running' && w.status !== 'queued')) return;
      const ov = (w.meta['override'] !== null && typeof w.meta['override'] === 'object' && !Array.isArray(w.meta['override'])
        ? { ...(w.meta['override'] as Record<string, JsonValue>) } : {}) as Record<string, JsonValue>;
      const applied: Record<string, JsonValue> = { by };
      // ①派发点消费类：session/context 合并进 override（context 追加不覆盖）
      if (patch.session !== undefined && patch.session.trim() !== '') { ov['session'] = patch.session.trim(); applied['session'] = patch.session.trim(); }
      if (patch.context !== undefined && patch.context.trim() !== '') {
        const prev = typeof ov['context'] === 'string' ? ov['context'] : '';
        ov['context'] = (prev !== '' ? `${prev}
` : '') + patch.context.trim();
        applied['context_appended'] = patch.context.trim().slice(0, 80);
      }
      const metaPatch: Record<string, JsonValue> = {};
      if (Object.keys(ov).length > 0) metaPatch['override'] = ov;
      // ②即时类：priority 写 template_input（holdGate/继承同源读到）
      if (patch.priority === 'high' || patch.priority === 'normal') {
        const ti = (w.meta['template_input'] !== null && typeof w.meta['template_input'] === 'object' && !Array.isArray(w.meta['template_input'])
          ? { ...(w.meta['template_input'] as Record<string, JsonValue>) } : {}) as Record<string, JsonValue>;
        ti['priority'] = patch.priority;
        metaPatch['template_input'] = ti;
        metaPatch['hold_released'] = patch.priority === 'high'; // high=直通语义同步放行
        applied['priority'] = patch.priority;
      }
      // ③时机：hold_until 压单 / dispatch_now 立即放行
      if (patch.hold_until !== undefined) {
        if (patch.hold_until.trim() === '') { metaPatch['hold_until'] = ''; applied['hold_until_cleared'] = true; }
        else if (!Number.isNaN(Date.parse(patch.hold_until))) { metaPatch['hold_until'] = patch.hold_until.trim(); applied['hold_until'] = patch.hold_until.trim(); }
      }
      if (patch.dispatch_now === true) { metaPatch['hold_released'] = true; applied['dispatch_now'] = true; }
      if (Object.keys(metaPatch).length === 0) return;
      store.updateWorkflowMeta(workflowId, metaPatch);
      store.appendEvent('workflow', workflowId, 'override_set', applied);
      if (patch.dispatch_now === true || patch.priority === 'high') queue.pump();
    },
    releaseHold: (workflowId: string, by: string) => {
      const w = store.getWorkflow(workflowId);
      // held 单两种形态都放行：startTask 路径停在 queued（从未派发）；
      // retry/续走路径被置 running 后入队 hold——状态不是判据，在途才是。
      if (w === null || (w.status !== 'running' && w.status !== 'queued')) return;
      if (w.meta['hold_released'] === true) return; // 幂等
      store.updateWorkflowMeta(workflowId, { hold_released: true });
      store.appendEvent('workflow', workflowId, 'hold_released', { by, at: now().toISOString() });
      queue.pump();
    },
    approve: gateActions.approve,
    deny: gateActions.deny,
    resolve: gateActions.resolve,
    rework: gateActions.rework,
    align: gateActions.align,
    intervene: human.intervene,
    closeWorkflow: lifecycle.closeWorkflow,
    retry: human.retry,
    amendStep: human.amendStep,
    amendSuggestions: human.amendSuggestions,
    reworkSend: human.reworkSend,
    handoff: human.handoff,
    assignSession: human.assignSession,
    onAgentStopped: agentSettle.onAgentStopped,
    sweepSchedules: relay.sweepSchedules,
    sweepRelays: relay.sweepRelays,
    recordActivity: agentSettle.recordActivity,
    touchSession: zombie.touchSession,
    sweepZombies: zombie.sweepZombies,
    reconcileStartup: reconcile.reconcileStartup,
    autoSettleFeedbackRuns: reconcile.autoSettleFeedbackRuns,
    autoSettleApprovedRuns: reconcile.autoSettleApprovedRuns,
    reconcileInflight: () => reconcile.reconcileInflightMs(10 * 60_000),
    setTemplates,
    currentTemplates,
    setAuthz,
    currentAuthz,
  };
};
