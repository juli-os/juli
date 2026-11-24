// 组合根：把配置、账本、模板注册表、能力端口（LLM/派发/发信/推送）与引擎
// 装配成一个冻结的 Runtime——依赖只从这里注入（对齐 Go 的 chat_wiring 组合
// 根；Go 的 init() 注入化债务在这里从第一天就不存在）。
//
// ─── 装配总图（谁接谁，2026-11-12 第 7 步定稿）────────────────────────────
// 仓库与域库：lifecycle.db/usage.db→@juli-os/ledger（句柄私有）；mirror.db/
// feedback.db→business/feedback；gates.db→business/gates；artifacts.db→
// ArtifactLedger（@juli-os/artifacts，字节侧 @juli-os/silo）；customers.db→
// business/party。schema 全部走 @juli-os/basin 版本化迁移。
// 端口注入：LLM→platform/llm；tmux/herdr/PTY→@juli-os/agents（遥控底座
// @juli-os/baton）；邮件→platform/email；推送→platform/push；工件字节→
// dual backend（disk 兜底 + S3 尽力）。
// 引擎：createEngine 吃上面全部端口；feedback 进件 wireFeedbackIntake 在
// 引擎在位后二段装配（镜像新记录→startTask 正门）。
// 周期任务（start() 时聚合启动，各域自带）：workflow 域（对账/定档/回流/
// 已批收口/僵尸/修剪）、gates 域（自动批准 sweep+热改盒）、usage 摄取
// （business/workflow/usageIngest）、feedback 域（镜像 sweep→进件→villa→
// apply 收口）、platform/ops（财务备份巡检）。runtime 本体零 setInterval。
// 热改：Settings 键的内存落点在 start() 闭包（retentionDays/notify 等），
// auto_approve 在 gates 域句柄——域读 getter，不拷贝。
// ─────────────────────────────────────────────────────────────────────

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';
import type { Config } from './platform/config/schema.ts';
import { resolveAiConfig, resolveSecret, danglingFeedbackRoutes, loadConfig, effectiveDefaultSession, type AiResolved } from './platform/config/schema.ts';
import { effectiveHerdrSession, INTERNAL_TENANT, parseTenantDecls, type TenantTable } from './platform/config/tenants.ts';
import type { TenantSignalTable } from './business/workflow/tenantResolve.ts';
import { parseTenantScope, tenantReadView, type TenantTableShape } from './business/workflow/tenantScope.ts';
import { consoleLogger, createBus, type Logger } from './platform/events/bus.ts';
import { createLedgerStore, createUsageStore, type LifecycleStore, type UsageStore } from '@juli-os/ledger';
import { createAnthropicChat, createOpenAiChat } from './platform/llm/chat.ts';
import { type ChatLlmPort } from '@juli-os/agents';
import { createOrchestrator, registerDefaultCommands, registerSkillCommands, type Orchestrator } from '@juli-os/agents';
import { makeAllTools } from '@juli-os/agents';
import type { InboundChannel } from './contracts/channels.ts';
import { createChatHub, type ChatHub } from './platform/ws/chathub.ts';
import { createSkillRegistry } from '@juli-os/agents';
import { createVoiceCall, voiceGateHook, type VoiceCall, type CallMode, type VoiceEvent } from '@juli-os/agents';
import { recoverFromSnapshot, takeSnapshot } from '@juli-os/agents';
import { attachPtyHub } from './platform/ws/ptyhub.ts';
import { attachChatWireWs, attachSnapshotWireWs } from './platform/ws/wirehubs.ts';
import { createCompositeAuthenticator, createLocalAuthenticator, createPbAuthenticator, type Authenticator } from './platform/auth/authenticator.ts';
import { createEngine, type Engine } from './business/workflow/engine.ts';
import { compileChannelPolicy, type AuthzPolicy } from './contracts/authz.ts';
import { loadTemplates, pipelinesDir, saveTemplateFile, deleteTemplateFile, readTemplateFile } from './business/templates/registry.ts';
import { type ChatIntake, type ChatIntakeDeps } from './business/intake/chatIntake.ts';
import { createChatIntakeRegistry, type ChatIntakeRegistry } from './business/intake/chatIntakeRegistry.ts';
import { makeChatTools } from './business/intake/chatTools.ts';
import { getTaskOf, listTasksOf } from './business/intake/chatTasks.ts';
import { openGatesStore, autoApproveSweep, projectAutoApprove, type GatesStore, type AutoApproveConfig } from './business/gates/index.ts';
import { startGatesTimers, type GatesTimers } from './business/gates/timers.ts';
import { startWorkflowTimers, type WorkflowTimers } from './business/workflow/timers.ts';
import { startUsageIngestTimers } from './business/workflow/usageIngest.ts';
import { startFeedbackTimers } from './business/feedback/timers.ts';
import { startFinanceBackupTimers } from './platform/ops/timers.ts';
import { deviceTokensOf, saveDeviceTokensTo } from './platform/push/deviceTokens.ts';
import { makeGradeAlert, makeTaskTier } from './business/workflow/judgmentScenarios.ts';
import { VERSION } from './contracts/version.ts';
import { err, ok, type Result } from './platform/shared/result.ts';
import type { JsonRecord } from './platform/shared/json.ts';
import { WORKFLOW_STATUSES } from './contracts/statuses.ts';
import { createJudgmentGateway, createJudgeFromConfig, loadJudgmentConfig } from '@juli-os/routing';
import { routeTask, routeTaskMenu, type TaskLanding } from '@juli-os/routing';
import type { Template } from './business/templates/template.ts';
import type { PusherPort } from './contracts/ports.ts';
import { createAnthropicProvider, createOpenAiProvider } from './platform/llm/providers.ts';
import { createSmtpMailer } from './platform/email/smtp.ts';
import { createMailSource, type MailSource } from './platform/email/source.ts';
import { resolveEmailPassword } from './platform/email/passwords.ts';
import type { TmuxClient, TmuxSessionInfo, AgentBackend } from '@juli-os/agents';
import { createAgentBackend, createProvisioningDispatch } from '@juli-os/agents';
import { createSessionRouter } from '@juli-os/agents';
import { installClaudeHooks } from '@juli-os/agents';
import { createArtifactLedger, sweepCaseInbox, type ArtifactLedger, type ArtifactRole } from '@juli-os/artifacts';
import { createDiskBackend, createS3Backend, createDualBackend, type ArtifactBackend } from '@juli-os/artifacts';
import { createDevicePusher, createEmailNotifier, combinePushers, withAlertGrade } from './platform/push/email.ts';
// 业务装配分册（反馈墙/客户库/CRM/Party/推送真实现/feedback 进件/巡检定时器）
// ——私仓扩展位单一入口；开源投影以同形桩替换（export/overlay/）。
import { wireBusiness, wireFeedbackIntake, type BusinessParts, type BusinessIntake } from './runtime.business.ts';
import * as feedbackMirror from './business/feedback/mirror.ts';
import { openDatabase } from '@juli-os/basin';
import type { PartyDirectory } from './business/party/party.ts';
import { fileURLToPath } from 'node:url';

/** 进程起点（service_info 的 startedAt / uptime 近似——模块加载即记）。 */
const BOOT_MS = Date.now();

/** 运行时自身所在的 dist（hook.js 与它同源——dev 用 tsx 也能解析到 ts）。 */
const distDirOf = (meta: { url: string }): string => {
  // dist/runtime.js → dist；src/runtime.ts → src（hook 有 .js/.ts 两个入口）。
  return fileURLToPath(meta.url).replace(/\/[^/]*$/, '');
};

export type EngineDeps = Parameters<typeof createEngine>[0];

export interface RuntimeSeams {
  /** 测试/嵌入接缝：覆盖组合根自动装配的端口。 */
  readonly llm?: EngineDeps['llm'];
  readonly mailer?: EngineDeps['mailer'];
  readonly dispatch?: EngineDeps['dispatch'];
  readonly tmux?: TmuxClient;
  /** 声明 herdr 模式的租户终端测试接缝（A4）：租户 id → 假 TmuxClient。
   * 注入后该租户的名单/分发/attach 就绪闸全走假件，spawn 与 herdr CLI
   * 名单一律不发生——单测密闭，绝不触真 herdr socket。 */
  readonly tenantTerminals?: Readonly<Record<string, TmuxClient>>;
  readonly pusher?: PusherPort;
  /** 邮件源注入缝：给了就顶替组合根自建的轮询源（邮件进件要开着才装配）。
   *  测试用它观察「授权热改有没有把新策略送到渠道闸」——真源在运行时内部
   *  自建，从外面看不到它的策略。 */
  readonly mailSource?: MailSource;
  /** config.json 所在 home（Settings 写回落点）；测试注入 tmpdir 用。 */
  readonly home?: string;
}

export interface Runtime {
  readonly config: Config;
  readonly store: LifecycleStore;
  /** feedback 域库连接（mirror.db——四张镜像表宿主，2026-11-11 第 3 步起
   *  镜像表不再住 lifecycle.db）。 */
  readonly feedbackMirrorDb: import('@juli-os/basin').BasinDb;
  /** gates 域登记库（gate_items——拍板卡登记与审计，2026-11-12 第 5 步）。 */
  readonly gates: GatesStore;
  readonly engine: Engine;
  readonly bus: ReturnType<typeof createBus>;
  readonly tmux: TmuxClient | null;
  readonly artifactLedger: ArtifactLedger;
  readonly artifactBackend: import('@juli-os/artifacts').ArtifactBackend;
  readonly artifactSharing: boolean;
  readonly usage: UsageStore;
  readonly orchestrator: Orchestrator | null;
  readonly channels: readonly InboundChannel[];
  readonly authenticator: Authenticator | null;
  readonly chatHub: ChatHub;
  emitChat(type: string, data: string, conv?: string): void;
  chat(input: string): Promise<{ events: { type: string; data?: string }[]; reply: string }>;
  /** 业务装配分册产物（类型透传 BusinessParts/BusinessIntake——公开桩全 null）。 */
  readonly feedback: BusinessParts['feedback'];
  /** feedback 进件：镜像新记录/手动点名 → startTask 起单（09-19）。 */
  readonly feedbackIntake: BusinessIntake;
  readonly customers: BusinessParts['customers'];
  readonly crm: BusinessParts['crm'];
  /** Party 目录（Twenty）：null = 未接入（进件不查 CRM，客户页显降级）。 */
  readonly party: PartyDirectory | null;
  /** 内部判定域（自家域，推导一次的单一事实）。 */
  readonly internalDomains: readonly string[];
  /** 租户登记表（2026-11-08 提案 A1）：读侧（A2）HTTP/WS/引擎同源消费。 */
  readonly tenants: TenantTable;
  readonly voiceCall: VoiceCall | null;
  openVoiceCall(mode: CallMode): VoiceCall | null;
  /** 挂断（P0，2026-10-27）：voiceState.call 唯一置空口——此前有进无出，
   * 通话一开 /api/chat 的 turn/confirm/deny 永久 409 直到进程重启。幂等：
   * 无在途通话为无害 no-op。包内 VoiceCall 是纯状态机（无计时器/连接等
   * 持有资源），置空即收口。 */
  closeVoiceCall(): void;
  confirmVoicePlan(): Promise<VoiceEvent[]>;
  denyVoicePlan(): Promise<VoiceEvent[]>;
  /** 开单对话（09-29）：clarify loop + 白名单只读工具 + 确认开单走 startTask
   * 正门（与 #/trigger 表单同契约）。null = LLM 未配置。此处=main 桶兼容面。 */
  readonly chatIntake: ChatIntake | null;
  /** conv 分线程（2026-10-17 分用户第一步）：按 conv id 取隔离的 intake
   * 实例（独立 LLM 上下文）；清洗与容量纪律见 chatIntakeRegistry。tenant =
   * 发起方租户（A2 读侧边界）——首次创建时登记 conv→tenant，之后锁死。 */
  chatIntakeFor(conv: string, tenant?: string): ChatIntake | null;
  /** conv → 租户登记（A2）：注册表里记过的 conv 返回其租户；未登记（含
   * A2 之前创建的存量 conv）返回 null——未登记 conv 只进 all。 */
  chatConvTenant(conv: string): string | null;
  /** 任务路由（0930「所有的都走路由」）：无键起单兜底判定（chat 计划暂存与
   * HTTP /api/lifecycle/tasks 共用）——jev 判定 + 忙闲感知落点，判定在
   * routing 层，本面只做装配。 */
  taskRoute(title: string, brief: string): Promise<TaskLanding>;
  /** 任务档位判定（2026-10-12「按任务类型选模型」）：task_tier 场景判 title+
   * brief 配不配高智能。只在 mode=on 且置信度过阈值时返回 'high'，其余
   * （shadow/off/失败/低置信）一律 null——fail-open 落 standard。 */
  taskTier(title: string, brief: string): Promise<'high' | null>;
  /** 命名孪生查找（agents 命名 schema 硬规则③的读侧）：session 的 -hi 孪生
   * 已声明且 high 才返回孪生名；无孪生业务线返回空串（升档无处落）。 */
  highTwinFor(session: string): string;
  takeSnapshotNow(): Promise<number>;
  recoverNow(): Promise<number>;
  /** xterm PTY WebSocket 桥挂载（须在 HTTP server 建立后调用）。 */
  attachWs(server: import('node:http').Server): void;
  readonly templateErrors: readonly string[];
  readonly lastImapPoll: string | null;
  readonly mailSource: MailSource | null;
  registerDeviceToken(token: string): void;
  saveTemplate(fileName: string, yaml: string): string | null;
  readTemplate(fileName: string): string | null;
  readonly templateFiles: Readonly<Record<string, string>>;
  deleteTemplate(fileName: string): void;
  reloadTemplates(): void;
  /** Settings 热改键落点：可即时生效的键就地应用，返回已应用键名。 */
  applySettings(patch: JsonRecord): { applied: readonly string[] };
  /** 发件人授权热改的唯一入口（2026-11-23 全量审查修复）：引擎全局策略与
   *  邮件渠道闸同时换成同一份策略。授权面板 POST 与设置页 PUT 都走这里。 */
  setSenderAuthz(policy: AuthzPolicy): void;
  /** 热改后的现行值（嵌套视图）：GET 投影用——冻结 config 读不到内存里已生效的新值。 */
  liveOverrides(): JsonRecord;
  /** 立即跑一轮闸门自动批准 sweep（单子级免批切换路由即时生效用）。 */
  runAutoApproveSweep(): Promise<number>;
  readonly home: string;
  start(): void;
  stop(): void;
}

const isLoopbackHost = (h: string): boolean =>
  h === '127.0.0.1' || h === 'localhost' || h === '::1';

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** 声明会话预热计划（2026-09-28）：config.agents → 顺序/去重/空名剔除后的
 * 会话名清单。纯函数可测——预热行为面=对每个名字跑一次幂等 provision。 */
export const warmupPlan = (agents: readonly { session: string }[]): readonly string[] =>
  [...new Set(agents.map((a) => a.session.trim()).filter((n) => n !== ''))];

/** 配置 → 引擎全局发件人策略。mode 缺省 allowlist（schema 不给它补默认值，
 * 「没写」和「写 allowlist」一个意思）。装配与授权热改重读配置都走这里。 */
const senderAuthzOf = (
  cfg: Pick<Config, 'email_authz_mode' | 'email_authz_allow' | 'email_authz_deny'>,
): AuthzPolicy => ({
  mode: cfg.email_authz_mode ?? 'allowlist', allow: cfg.email_authz_allow, deny: cfg.email_authz_deny,
});

/** 发件人授权的三个配置键：PUT /api/settings 的 patch 带了其中任何一个，
 *  applySettings 就把两层策略一起热改。 */
const SENDER_AUTHZ_KEYS = ['email_authz_mode', 'email_authz_allow', 'email_authz_deny'] as const;

// ---- 租户终端路由（2026-11-08 多租户提案 A4）----
// 声明模式（config.tenants 非空）+ herdr 后端 = 每租户一个独立 herdr server
//（P2 实证：单 server 双 workspace 时 capturePane 跨租户可读，隔离不成立；
// 证据 overnight-service-docs/docs/plans/proto-20261108/p2/herdr-iso-output.txt）。
// 每租户一个 createAgentBackend({backend:'herdr', herdrSession: 有效 ns})
//（session 决定 socket 路径，包内 client 的 workspace 名随 session 走——
// internal 声明 herdr_session='juli' 即绑现有 juli server 现有 workspace，
// 存量会话零迁移；acme 缺省回落 id），外包一层按会话名分发的 TmuxClient
// facade 与 AgentBackend 分发壳——runtime 消费端零改动。tmux 后端与缺省
// 模式（无 tenants 声明）不进此路径，原单实例原样透传（tmux 是回退路径，
// 租户分流只在 herdr 模式生效）。

interface TenantBackendEntry {
  readonly id: string;
  readonly ns: string;
  readonly backend: AgentBackend;
  /** 测试缝租户：名单/分发走假件，CLI 名单与 attach spawn 一律不发生。 */
  readonly seamed: boolean;
}

export interface TenantTerminalRouterDeps {
  readonly table: TenantTable;
  readonly dataDir: string;
  /** 测试接缝：租户 id → 假 TmuxClient（createRuntime 从 seams 透传）。 */
  readonly terminals?: Readonly<Record<string, TmuxClient>>;
  readonly log?: (m: string) => void;
}

export interface TenantTerminalRouter {
  readonly backend: AgentBackend;
  readonly terminal: TmuxClient;
}

export const createTenantTerminalRouter = (deps: TenantTerminalRouterDeps): TenantTerminalRouter => {
  // 名单合并的失败留痕（A-P2-10）：按失败签名变化记日志。
  let lastListFailure = '';
  const entries: TenantBackendEntry[] = deps.table.tenants.map((t) => {
    const ns = effectiveHerdrSession(t);
    const fake = deps.terminals?.[t.id];
    return {
      id: t.id,
      ns,
      seamed: fake !== undefined,
      backend: createAgentBackend({
        backend: 'herdr', herdrSession: ns, dataDir: deps.dataDir,
        terminal: fake, log: deps.log,
      }),
    };
  });
  const byTenant = new Map(entries.map((e) => [e.id, e]));
  // 会话 → 所属租户的 backend。表外会话（未声明的克隆/临时会话）与内置老
  // 别名（可能指向没声明的租户，如只声明 internal 的部署里的 team-*）兜底
  // internal——与引擎判租户的 default 口径一致；声明表必有 internal
  //（parseTenantDecls 启动校验），回退先点 internal，entries[0] 只是类型层面
  // 的最后防线（A-P2-6：原来回退声明序第一个，internal 不排第一时错家）。
  const backendOf = (session: string): TenantBackendEntry => {
    const t = deps.table.bySession[session] ?? INTERNAL_TENANT;
    return byTenant.get(t) ?? byTenant.get(INTERNAL_TENANT) ?? entries[0]!;
  };
  const terminal: TmuxClient & AgentProbeTerminal = {
    // 会话级方法：按会话名查租户表分发——跨租户方法隔离由「每会话只到
    // 属主租户的 socket」保证（facade 不做任何跨租户广播）。
    hasSession: (s) => backendOf(s).backend.terminal.hasSession(s),
    sendKey: (s, key) => backendOf(s).backend.terminal.sendKey(s, key),
    foregroundCommandOf: (s) => backendOf(s).backend.terminal.foregroundCommandOf(s),
    panePathOf: (s) => backendOf(s).backend.terminal.panePathOf(s),
    // agent 在位探测（A-P2-3，ready-attach 的预热判据）：透传到属主租户的终端。
    // 包内 herdr client 才有这两个方法；测试假件缺位时回空串 = 探测失败。
    paneIdOf: (s) => {
      const t = backendOf(s).backend.terminal as TmuxClient & AgentProbeTerminal;
      return typeof t.paneIdOf === 'function' ? t.paneIdOf(s) : Promise.resolve('');
    },
    agentAtPaneOf: (s) => {
      const t = backendOf(s).backend.terminal as TmuxClient & AgentProbeTerminal;
      return typeof t.agentAtPaneOf === 'function' ? t.agentAtPaneOf(s) : Promise.resolve('');
    },
    newSession: (s, cwd) => backendOf(s).backend.terminal.newSession(s, cwd),
    sendText: (s, text) => backendOf(s).backend.terminal.sendText(s, text),
    sendTextConfirmed: (s, text) => backendOf(s).backend.terminal.sendTextConfirmed(s, text),
    sendTextQueued: (s, text) => backendOf(s).backend.terminal.sendTextQueued(s, text),
    capturePane: (s, lines) => backendOf(s).backend.terminal.capturePane(s, lines),
    killSession: (s) => backendOf(s).backend.terminal.killSession(s),
    interrupt: (s) => backendOf(s).backend.terminal.interrupt(s),
    // env 是全局注入面（ANTHROPIC keys 对所有租户同值）：逐租户 backend
    // 各自注入（herdr=同一 envFile 幂等重写 + 各 client 内存 extraEnv），
    // 任一失败带出第一个错误。
    setEnv: async (vars) => {
      let firstFail: { ok: false; error: Error } | null = null;
      for (const e of entries) {
        const r = await e.backend.terminal.setEnv(vars);
        if (!r.ok && firstFail === null) firstFail = r;
      }
      return firstFail ?? ok(undefined);
    },
    // 名单：合并各租户（声明表序），去重保序。单端 server 缺席不 blank
    // 另一端的名单（A4 Lane 5/6 口径），全部缺席才报错。
    listSessions: async () => {
      const out: string[] = [];
      for (const e of entries) {
        for (const s of await e.backend.terminal.listSessions()) {
          if (!out.includes(s)) out.push(s);
        }
      }
      return out;
    },
    listSessionsDetailed: async () => {
      const rows: (TmuxSessionInfo & { readonly tenant?: string })[] = [];
      const failures: string[] = [];
      for (const e of entries) {
        const r = await e.backend.terminal.listSessionsDetailed();
        if (r.ok) {
          for (const row of r.value) rows.push({ ...row, tenant: e.id });
        } else {
          failures.push(`${e.id}: ${r.error.message}`);
        }
      }
      // 单侧失败不静默（A-P2-10）：这个方法每几秒被轮询一次，按「失败状态
      // 变化」记——同一组失败只记一次，恢复时记一行，不刷屏。
      const sig = failures.join('；');
      if (sig !== lastListFailure) {
        lastListFailure = sig;
        if (sig !== '') deps.log?.(`[tenant] 会话名单合并：部分租户查询失败（${sig}）——其余租户的名单照常返回`);
        else deps.log?.('[tenant] 会话名单合并：全部租户恢复');
      }
      return rows.length === 0 && failures.length > 0
        ? err(new Error(failures.join('；')))
        : ok(rows);
    },
    // 出生点表：herdr 后端恒空表，合并只为形状完整（tmux 单实例不进 facade）。
    sessionBirthsOf: async () => {
      const merged = new Map<string, number>();
      for (const e of entries) {
        for (const [k, v] of await e.backend.terminal.sessionBirthsOf()) {
          if (!merged.has(k)) merged.set(k, v);
        }
      }
      return merged;
    },
  };
  const backend: AgentBackend = {
    kind: 'herdr',
    describe: `herdr 按租户（${entries.map((e) => `${e.id}@${e.ns}`).join('、')}）`,
    terminal,
    hookSpecs: entries[0]!.backend.hookSpecs,
    // 名单源（路由 availableSessions）：真租户各自 CLI 名单合并；seamed 租户
    // 跳过——测试缝下不 spawn herdr CLI。
    listSync: () => {
      const out: string[] = [];
      for (const e of entries) {
        if (e.seamed) continue;
        for (const s of e.backend.listSync()) {
          if (!out.includes(s)) out.push(s);
        }
      }
      return out;
    },
    // attach 前置就绪闸（会话须真实存在，终端不代建）：闸口问的是会话所属
    // 租户自己的终端面——生产上是该租户 socket 的真就绪检查，与包内
    // herdrAttach 首闸同序（双闸幂等）；测试缝下假件 hasSession=false 即在
    // 闸口被拦，spawn 永不发生。
    attach: async (session, opts, onData) => {
      const e = backendOf(session);
      if (!(await e.backend.terminal.hasSession(session))) {
        return err(new Error(`会话 ${session} 不存在——终端不代建（创建是显式动作：POST /api/sessions 或由引擎派发）`));
      }
      return e.backend.attach(session, opts, onData);
    },
    // boot 包装与 hook 命令组各租户同形（herdrBootCommand 只依赖共享 envFile
    // 与会话名；JULI_HERDR_SESSION=agent 会话名，与租户无关）——取首个即可。
    bootCommand: (base, session) => entries[0]!.backend.bootCommand(base, session),
    applyEnv: (vars) => {
      for (const e of entries) {
        // seamed 租户：env 注入走假件的 setEnv——包内 applyEnv 会写共享
        // envFile 并注入包内 client 内存，假件世界两处都不该发生。
        if (e.seamed) void e.backend.terminal.setEnv(Object.fromEntries(vars));
        else e.backend.applyEnv(vars);
      }
    },
  };
  return { backend, terminal };
};

// ---- web 终端 attach 探测（2026-11-10 P1；A-P2-3，R2-F 改 fail-closed）----
// herdr 的 `agent attach <pane>` 只认 pane 上有被识别的 agent：会话在但 pane
// 是裸 shell 时回 agent_not_found、PTY 秒死（live 实测 acme server 的
// w1:p2）。R1 之前 attach 在此自愈（预热拉起 agent 再附着），R2-F 起
// **fail-closed 整条关闭 attach 预热**，理由见 createReadyAttach 注释——预热的
// 启动按键可能落进在跑的 agent，宁可不预热。tmux attach 不依赖 agent 在位，
// 不进此路径。

/** herdr client 的 agent 在位探测面（A-P2-3）：包内 HerdrClient 的结构投影——
 * 真实 herdr 终端有这两个方法，tmux 终端与测试假件没有（缺位=探测失败）。 */
interface AgentProbeTerminal {
  readonly paneIdOf?: (session: string) => Promise<string>;
  readonly agentAtPaneOf?: (session: string) => Promise<string>;
}

export interface ReadyAttachDeps {
  readonly kind: AgentBackend['kind'];
  /** 存在性与 agent 在位探测面——声明模式下是租户 facade，探测只到属主租户。 */
  readonly terminal: TmuxClient;
  readonly attach: AgentBackend['attach'];
  readonly log?: (m: string) => void;
}

export const createReadyAttach = (deps: ReadyAttachDeps): AgentBackend['attach'] => {
  if (deps.kind !== 'herdr') return deps.attach;
  return async (session, opts, onData) => {
    // 不存在的会话原样透传——attach 首闸报「不存在」（终端不代建）。
    if (!(await deps.terminal.hasSession(session))) return deps.attach(session, opts, onData);
    // fail-closed 两态（A-P2-3 残留洞，R2-F 订正）：只有「确认 agent 在位」
    // 才直接附着，其余一律不预热。不可区分的依据（包内 0.4.3 实读）：
    // agentAtPaneOf 签名 Promise<string> 无错误通道（herdr.d.ts），实现里
    // resolve() 失败、pane.list RPC 失败、pane 上无 agent 三种情况全部返回
    // 空串（dist/index.js 三连 return ""）——「裸 shell」与「瞬时查询失败」
    // 在调用方是同一个值。R1-F 的三态把空串当裸 shell 预热，paneIdOf 命中
    // 包内缓存后单次 pane.list 失败就会对在跑 agent 敲启动键（R2-X3-D
    // 实证）；「读两次一致才预热」也堵不死（连续两次失败仍误判）。故空串
    // 一律按未知处理：启动键绝不落在没确认过的 pane 上，交 attach 首闸——
    // 真裸 shell 得到「pane 未就绪（agent 未在位）——终端不代建，派发链路
    // 会自愈拉起」，瞬时失败重试 attach 即可。有意的行为代价：裸 shell 的
    // attach 不再自愈预热（任务派发与启动预热两条链路照旧自愈）。
    const probe = deps.terminal as AgentProbeTerminal;
    const paneId = typeof probe.paneIdOf === 'function' ? await probe.paneIdOf(session).catch(() => '') : '';
    const agentAt = typeof probe.agentAtPaneOf === 'function' ? await probe.agentAtPaneOf(session).catch(() => '') : '';
    if (agentAt !== '') return deps.attach(session, opts, onData);
    // paneId 只用来把日志分成两档（pane 未知 vs agent 探测为空），不参与判定。
    deps.log?.(paneId === ''
      ? `[ws] xterm ${session}：agent 在位探测失败（pane 未知）——fail-closed 不预热，交 attach 首闸报错`
      : `[ws] xterm ${session}：pane ${paneId} 上 agent 探测为空（裸 shell 与查询失败不可区分）——fail-closed 不预热，交 attach 首闸报错`);
    return deps.attach(session, opts, onData);
  };
};

// ---- 同会话启动互斥（2026-11-11 A-P2-2）--------------------------------------
// 就绪派发（provision）是「任务派发」与「启动预热」共用的入口：两条路对同一
// 会话并发进 provision，都会在裸 shell 分支敲启动命令——第二条会当成输入打进
// 刚起来的 REPL（包内 dispatch 注释自述）。互斥在 provision 包装层：同会话串行
// （后到者等先到者落地才进包内逻辑，此时会话多半已就绪，包内循环直接跳过
// boot），跨会话并行；前一个失败不阻塞后一个（链上 catch 归零）。
//（第三个消费方「attach 预热」在 R2-F 随 fail-closed 关闭，不再进 provision。）
export const serializeProvision = (
  provision: (source: string, session: string, text: string) => Promise<Result<void, Error>>,
): (source: string, session: string, text: string) => Promise<Result<void, Error>> => {
  const inflight = new Map<string, Promise<Result<void, Error>>>();
  return (source, session, text) => {
    const prev = inflight.get(session) ?? Promise.resolve(ok(undefined));
    const next = prev.catch(() => undefined).then(() => provision(source, session, text));
    inflight.set(session, next);
    // 清理挂在 next 的一个已处理副本上：直接 next.finally() 会派生一个没人
    // 处理的 rejected promise（void 只是不等它，不等于处理了它）。
    void next
      .then(() => undefined, () => undefined)
      .then(() => { if (inflight.get(session) === next) inflight.delete(session); });
    return next;
  };
};

export const createRuntime = (config: Config, seams: RuntimeSeams = {}, log: Logger = consoleLogger): Runtime => {
  // 部署红线：绑非回环地址必须配密码（对齐 Go 版启动守卫）。
  if (!isLoopbackHost(config.listen_host) && config.password === '') {
    throw new Error('非回环地址监听必须配置密码（JULI_PASSWORD / config.password）');
  }
  // 租户登记（2026-11-08 多租户提案 A1）：声明跨项校验不过 = 启动失败并
  // 点名——错配的租户表会让存量单子静默改姓，宁可拒启。解析出的登记表
  // 供读侧（A2）与回填 CLI 同源消费。
  const tenantTable = parseTenantDecls(config);
  if (!tenantTable.ok) {
    throw new Error(`租户声明非法：${tenantTable.error}`);
  }
  const dataDir = config.data_dir;
  const home = seams.home ?? homedir();
  mkdirSync(dataDir, { recursive: true });
  // 技能（markdown 目录 + /skills /skill 命令）——orchestrator 组合前就绪。
  const skillsDir = join(dataDir, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const skillRegistry = createSkillRegistry(skillsDir);

  const store = createLedgerStore(join(dataDir, 'lifecycle.db'));

  // ---- LLM（统一 ai 段，2026-10-10）：env（JULI_AI_*）> ai 段 > 旧散键，
  // 五处构造（engine/orchestrator/chat-intake/voice）全部吃同一解析——
  // 一处配置两处用（引擎自身 + agent 执行环境注入，见 syncTmuxAiEnv）。----
  const ai: AiResolved = resolveAiConfig(config, process.env);
  const llmKey = ai.apiKey;
  const llm = seams.llm ?? (llmKey === '' ? null : ai.provider === 'openai'
    ? createOpenAiProvider({ apiKey: llmKey, baseUrl: ai.baseUrl, model: ai.model })
    : createAnthropicProvider({ apiKey: llmKey, baseUrl: ai.baseUrl, model: ai.model }));
  /** 对话式 LLM（orchestrator/chat-intake/voice 同一形状）——统一 ai 段工厂。 */
  const makeChatLlm = (): ChatLlmPort => ai.provider === 'openai'
    ? createOpenAiChat({ apiKey: llmKey, baseUrl: ai.baseUrl, model: ai.model })
    : createAnthropicChat({ apiKey: llmKey, baseUrl: ai.baseUrl, model: ai.model });

  // ---- 发信 / 派发 ----
  const smtpPassword = resolveSecret({
    envValue: process.env['JULI_SMTP_PASSWORD'] ?? process.env['MAKRO_SMTP_PASSWORD'],
    configured: config.secrets.smtp_password,
  });
  const baseMailer = seams.mailer ?? createSmtpMailer({
    host: config.smtp.host, port: config.smtp.port,
    username: config.smtp.username, password: smtpPassword, from: config.smtp.from,
  });
  // 全量出站登记（2026-09-20 幽灵单缺口）：任何出站信成功即记 message_id
  // ——send 步与通知邮件同一 seam 覆盖，进件层 selfEchoHit 据此丢弃回灌。
  const mailer = baseMailer === null ? null : {
    send: async (cmd: Parameters<typeof baseMailer.send>[0]) => {
      const r = await baseMailer.send(cmd);
      if (r.ok && r.value.messageId !== '') store.recordSentMessageId(r.value.messageId, { to: cmd.to, subject: cmd.subject });
      return r;
    },
  };
  // agent 终端基底（2026-11-04 herdr 下沉）：正交后端工厂——config.agent_backend
  // 选 tmux|herdr（默认 herdr，2026-11-12 裁定；tmux 为显式选项完整保留），随基底变化的六件事（终端
  // 契约/hook 命令组/名单源/PTY attach/boot 包装/env 注入）全在包内 backend
  // 对象上，本组合根零 backend 分枝。terminal 覆盖位 = seams.tmux 测试接缝
  // （tmux 分支：注入假终端时 applyEnv/attach 全走假件，绝不触真 tmux；
  // herdr 分支的 attach/applyEnv 仍走包内内部 client——0.2.2 工厂自证该
  // 组合「仅测试出现，不同时配 herdr」，硬化留观见 FIXES）。
  const baseBackend = createAgentBackend({
    backend: config.agent_backend,
    socketPath: config.tmux_socket_path || undefined,
    herdrSession: config.herdr_session,
    dataDir,
    terminal: seams.tmux,
    log: (m) => log.info(m),
  });
  // 租户终端路由（A4）：声明模式 + herdr 后端才分流——每租户独立 herdr
  // server，按会话名分发的 facade 顶替单实例（缺省模式与 tmux 后端不进
  // 此路径，baseBackend 原样透传，逐字节不变）。
  const tenantRouter = config.agent_backend === 'herdr' && config.tenants.length > 0
    ? createTenantTerminalRouter({
      table: tenantTable.table, dataDir,
      terminals: seams.tenantTerminals, log: (m) => log.info(m),
    })
    : null;
  // 启动留痕（A-P2-6）：每个租户连的是哪个 herdr server，一行打出来——
  // herdr_session 写错或漏写时现象是「会话全不见了」，这行是第一眼能对上的证据。
  if (tenantRouter !== null) log.info(`[tenant] 终端后端：${tenantRouter.backend.describe}`);
  const agentBackend = tenantRouter !== null ? tenantRouter.backend : baseBackend;
  const tmux: TmuxClient = agentBackend.terminal;
  /** ANTHROPIC_BASE_URL 在本进程里的去向（2026-11-23 全量审查修复）：
   *  never = 本进程没注入过；set = 现行有值；cleared = 注入过又清空。
   *  写入点在 injectAgentEnv；下方 bootFor 读它，决定拉起 agent 的启动命令
   *  要不要前置 unset。 */
  let baseUrlState: 'never' | 'set' | 'cleared' = 'never';
  // 就绪派发：会话缺失则建、裸 shell 则拉起 agent 并等 REPL 就绪、选择菜单
  // 拒派转人工——任务只在 agent 在位后发出（2026-09-12 can't-find-session
  // 与裸 shell 直投事故的修复）。绑定会话（专用 agent 隔离）自建时用配置
  // cwd——绑定会话按其配置 cwd 启动以吃到项目级 skill。
  // 优先级（2026-09-21 补声明段）：绑定会话专用 cwd > 声明 agent 的 cwd >
  // 引擎目录——research/stats 会话自动起时不再落错目录。
  // 外包一层 serializeProvision（A-P2-2）：任务派发与启动预热共用这一个
  // provision，同会话的并发进入在这里串行，启动命令不会被敲两遍。
  //（attach 路径 R2-F 起不再走 provision——fail-closed 不预热。）
  const provision = tmux
    ? serializeProvision(createProvisioningDispatch({
      tmux,
      log: (m) => log.info(m),
      // 模型分层引导（2026-09-28「非必要不高智能」）：声明 high 的会话冷启动
      // 带 --model 高档 id；standard 档 id 配了同样生效（默认降档省 token）。
      // 未配 models=两档都裸 claude（历史行为）。已就绪会话不受影响。
      bootFor: (s) => {
        const tier = config.agents.find((a) => a.session === s)?.model_tier === 'high' ? 'high' : 'standard';
        const id = tier === 'high' ? config.models.high : config.models.standard;
        const base = id !== '' ? `claude --model '${id}'` : 'claude';
        // herdr 后端由 backend 包 env 兜底前缀（恢复态 env 全丢的实测口径）；
        // tmux 恒等返回——分支只存在于工厂内部。
        // 清空过接口地址（2026-11-23）：启动命令前置 unset——终端侧的环境是
        // 只增不删的（tmux set-environment / herdr tab 环境都没有删除接口），
        // 旧地址会留在 pane 的 shell 环境里被新起的 agent 继承。前缀放在后端
        // 包装的外层：herdr 的包装以 `JULI_HERDR_SESSION='…' claude` 收尾，
        // 塞进去会让那个赋值只对 unset 生效、到不了 claude。
        return `${baseUrlState === 'cleared' ? 'unset ANTHROPIC_BASE_URL; ' : ''}${agentBackend.bootCommand(base, s)}`;
      },
      cwdFor: (s) => config.email.bound_agents.find((b) => b.session === s)?.cwd
        || config.agents.find((a) => a.session === s)?.cwd
        || undefined,
      // CC context 门（wf_a79a6fcbf7ef）：切单 clear / 600K compact。
      // workflowFor=store 查该会话当前 running 单 id；contextTokensFor=
      // prompt_usage 该 tmux 会话最新回合 input（≈当前 context 量级）。
      contextGate: {
        workflowFor: async (sess) => {
          const w = store.listWorkflows(500).find(x =>
            x.status === 'running' && (x.session === sess || (x.meta?.['assigned_session'] ?? '') === sess));
          return w?.id ?? '';
        },
        contextTokensFor: async (sess) => usage.latestInputTokens(sess),
      },
    }))
    : null;
  // web 终端 attach（ptyhub 消费面）：herdr 只在确认 agent 在位时附着，其余
  // 交 attach 首闸报错（fail-closed 不预热——createReadyAttach 注释，A-P2-3
  // R2-F；此前「裸 shell 预热再附着」已关，启动键不再走 attach 路径）。
  const readyAttach = createReadyAttach({
    kind: agentBackend.kind, terminal: tmux,
    attach: agentBackend.attach, log: (m) => log.info(m),
  });
  // 纯适配器：write-ahead 登记（createPrompt）与确定性失败回写
  // 已挪进引擎 runAgentStep（steps.ts）——「每个 DispatcherPort 派发都先登记」
  // 由引擎自身保证，不再依赖注入实现自觉；软失败判据单点 isSoftSubmitFailure
  //（support.ts），prompts 表回写 SQL 单点（steps.ts）。provision 与
  // DispatcherPort 同签名（createProvisioningDispatch 返回
  // (source, session, text) => Promise<Result<void, Error>>），闭包仅包一层命名。
  const dispatch = seams.dispatch ?? (provision !== null ? { dispatch: provision } : null);

  // ---- agent 执行环境注入（2026-10-10 开源 MVP）：统一 ai 段的 key/base_url
  // 进 agent 后端环境——新建会话里的 claude 进程即继承 ANTHROPIC_API_KEY /
  // ANTHROPIC_BASE_URL（tmux=server 内存态不落盘；herdr=data_dir/agent-env.sh
  // 0600 落盘 + 新建 workspace 的 tab env 注入面，落盘失败包内尽力语义记日志
  // 不抛）。进程 env 同步置位：引擎首建的 tmux server 天然继承引擎 env
  // （set-environment 失败时的兜底）。已在跑的会话不受影响——热改 key 后
  // 新会话生效（诚实边界，见 applySettings）。地址清空时进程 env 里的变量
  // 显式删掉（2026-11-23），终端侧清不掉的旧值靠启动命令前置 unset 挡（见
  // bootFor）。----
  const injectAgentEnv = (resolved: AiResolved): void => {
    if (resolved.apiKey === '') return;
    // 双通道：API_KEY（x-api-key）+ AUTH_TOKEN（Bearer）。Claude Code 对自定义
    // API_KEY 有一次性「是否使用」对话框（误答 No 即写进 .claude.json 永拒，
    // 容器无头环境必踩）；AUTH_TOKEN 无此对话框且 Anthropic 官方与兼容端
    // （GLM 等）都接受 Bearer——两键同值并注，两世界通吃。
    process.env['ANTHROPIC_API_KEY'] = resolved.apiKey;
    process.env['ANTHROPIC_AUTH_TOKEN'] = resolved.apiKey;
    if (resolved.baseUrl !== '') {
      process.env['ANTHROPIC_BASE_URL'] = resolved.baseUrl;
      baseUrlState = 'set';
    } else if (baseUrlState !== 'never') {
      // 清空（2026-11-23 全量审查修复）：此前地址为空只是「不赋值」，本进程
      // 之前设进去的旧地址留在引擎环境里——之后首建的 tmux server、引擎自动
      // 拉起的 herdr server 从引擎环境继承到的还是旧地址，设置接口却回「已生效」。
      // 只删自己注入过的：没注入过就不动（操作员自己设的变量不归这里管）。
      delete process.env['ANTHROPIC_BASE_URL'];
      baseUrlState = 'cleared';
      log.info('[ai] 接口地址已清空：进程环境里的 ANTHROPIC_BASE_URL 已移除；之后拉起的 agent 启动时不再带旧地址（已在跑的会话不受影响）');
    }
    const vars: readonly (readonly [string, string])[] = resolved.baseUrl !== ''
      ? [['ANTHROPIC_API_KEY', resolved.apiKey], ['ANTHROPIC_AUTH_TOKEN', resolved.apiKey], ['ANTHROPIC_BASE_URL', resolved.baseUrl]]
      : [['ANTHROPIC_API_KEY', resolved.apiKey], ['ANTHROPIC_AUTH_TOKEN', resolved.apiKey]];
    // 后端接缝注入（tmux=set-environment -g；herdr=env 文件+新建面）——
    // 差异在包内 backend.applyEnv，这里零分支。
    agentBackend.applyEnv(vars);
    log.info(`[ai] agent 执行环境已注入（ANTHROPIC_API_KEY+AUTH_TOKEN${resolved.baseUrl !== '' ? ' + BASE_URL' : ''}，新会话生效）`);
  };

  // ---- 工件账本（disk 主存 + S3/OSS 兼容远端，share 走 presigned URL）----
  const s3 = config.s3.endpoint !== ''
    ? createS3Backend({
      endpoint: config.s3.endpoint, region: config.s3.region, bucket: config.s3.bucket,
      accessKeyId: config.s3.access_key_id,
      secretAccessKey: resolveSecret({ envValue: process.env['JULI_S3_SECRET_KEY'], configured: config.secrets.s3_secret_key }),
      pathStyle: config.s3.path_style,
      publicHost: config.s3.share_domain,
    })
    : null;
  // 双后端：disk 永远留影子（本地读零网络、远端抖动不伤管线），远端承接外链
  // presign 并在分享时惰性回填存量字节——切远端不需要迁移脚本。
  const backend: ArtifactBackend = s3
    ? createDualBackend(createDiskBackend(join(dataDir, 'artifacts-store')), s3)
    : createDiskBackend(join(dataDir, 'artifacts-store'));
  // gates 域登记库（第 5 步）：拍板卡登记与审计。规则面与自动批准 sweep 的
  // 定时器（boot 即扫 + 30s 心跳）都在 business/gates/——定时器是 timers.ts
  // 的 startGatesTimers，runtime 只在 start() 里取句柄（下方 gatesTimers），
  // 另留一个手动触发口 runAutoApproveSweep。
  //（2026-11-23 全量审查：此处原注释写「sweep 的定时器仍在此处」，早已搬走。）
  const gates = openGatesStore(join(dataDir, 'gates.db'));
  // ledger 关门（2026-11-12）：ArtifactLedger 的表搬自己的库文件 artifacts.db
  //（同 feedback 域先例，一个域一个库）——lifecycle.db 不再承载 artifacts 表，
  // 存量表数据迁移走演练脚本 rehearse-feedback-mirror.mts 的同款路径。
  const artifactLedger = createArtifactLedger(openDatabase(join(dataDir, 'artifacts.db')), backend);
  const caseInboxDir = (workflowId: string): string => join(dataDir, 'case-inbox', workflowId);

  // ---- 推送注册表（runtime.ts 持有文件与读写；业务侧消费见 wireBusiness）----
  // 设备注册表存取（第 7 步收进 platform/push——runtime 不落业务文件）。
  const deviceTokens = (): readonly string[] => deviceTokensOf(dataDir);
  const saveDeviceTokens = (tokens: readonly string[]): void => saveDeviceTokensTo(dataDir, tokens);
  // ---- 业务装配分册（APNs/Bark 推送真实现、反馈墙/客户库/CRM/Party 目录）
  // ----：全部私仓扩展位，装配体在 runtime.business.ts（公开投影=同形桩）。----
  const business = wireBusiness({ config, dataDir, store, backend, log, deviceTokens, saveDeviceTokens });
  // 自动批准现行配置（Settings 热改键 auto_approve 的内存落点——gates 域
  // 句柄持有（第 7 步），sweep 每轮现读，规则改动下轮即生效，无需重启）。
  const autoApproveInitial: AutoApproveConfig = projectAutoApprove(config.auto_approve);
  // 邮件通知收件人（Settings 热改键的内存落点——notifier 每次发送现读这里）。
  let notifyTo: readonly string[] = config.notify.to;
  let notifyCc: readonly string[] = config.notify.cc;
  // SMTP 未配置 = 邮件通知不可能，跳过装配（send 步的明确报错语义不变）。
  const emailNotifier = mailer !== null
    ? createEmailNotifier({
        mailer, baseUrl: config.notify.base_url,
        recipients: () => ({ to: notifyTo, cc: notifyCc }),
        // 自回环断根（2026-09-21）：通知收件人=被轮询邮箱自身 → 发信前整体
        // 跳过（发给自己的信必然落回自己的 INBOX）。
        selfAddress: config.email.username,
        log: (m) => log.error(m),
      })
    : null;
  // 设备推送（APNs/Bark）：三事件——chainDangling/stepFailed 是邮件专属
  // （设备侧维持现状不扩面，热键/悬空这类「要人动手」的低频警报先进邮箱
  // 验证价值，扩不扩另裁）。事件→深链字段映射在 createDevicePusher 钉死
  // （契约=iOS AppDelegate 读 userInfo.workflow_id/step_id）。真实现（通道
  // 装配/失败显性化/死 token 除名）在 runtime.business.ts；公开桩为 no-op。
  const deviceSend = async (title: string, body: string, link: {
    workflowId: string; stepId?: string;
  }): Promise<void> => {
    await business.devicePushRaw(title, body, `juli://workflow/${link.workflowId}`, link.workflowId, link.stepId);
  };
  const devicePusher: PusherPort = createDevicePusher(deviceSend);
  // 告警分级（alert_grade，2026-09-27，影子先行）挂钩：推送前判严重度。
  // shadow=留痕原样推；on+高置信 info=静默（降噪）。默认 null=直推（网关
  // 未装配/场景 off 时零行为）。声明在网关之前、赋值在网关之后（顺序依赖）。
  let gradeAlert: ((title: string, body: string) => Promise<boolean>) | null = null;
  // 双通道组合（fire-and-forget）：方法立即返回、发送后台跑——引擎在
  // withLock 内 await 这些方法，SMTP 故障的最坏延迟不串进持锁路径。
  // alert_grade 挂在真实推送面上（2026-09-27 审查 P1：此前唯一挂点
  // pushAllWithDesktop 是零调用方的死函数，场景永不运行）；分级在包装层
  // 后台跑，组合器的 fire-and-forget 语义不变。
  const pusher: PusherPort = seams.pusher ?? withAlertGrade(
    combinePushers(devicePusher, emailNotifier),
    (title, body) => (gradeAlert !== null ? gradeAlert(title, body) : Promise.resolve(true)),
  );

  // ---- 邮件入站（IMAP 轮询；渠道授权 + 账本去重 → 引擎 authz 兜底）----
  let mailSource: MailSource | null = null;
  const emailEnabled = config.email_enabled ?? config.email.enabled;
  if (emailEnabled && config.email.host !== '') {
    const emailPassword = resolveEmailPassword(config);
    mailSource = seams.mailSource ?? createMailSource({
      params: {
        host: config.email.host, username: config.email.username,
        mailbox: config.email.mailbox, timeoutMs: config.email.timeout_sec * 1000,
      },
      password: emailPassword,
      // 重抓治理（2026-09-21 自回环洪水收口）：探针 = 已摄取（工作流 meta
      // dedup_key）∪ 本引擎已发送（email_sent 登记 + 历史 send 步）。引擎发
      // 给轮询邮箱自身的信（失败/闸门通知）回灌 INBOX 时从不建单，光靠
      // hasSeenDedup 永远查无——每轮全量信封抓取都把它当新信再拉再记
      // （11 万事件/日洪水的根因）。并入出站登记后这类信在阶段一即被跳过：
      // 不拉正文、不记事件，整个生命周期至多处理一次。
      ledgerSeen: (key) =>
        Promise.resolve(store.hasSeenDedup(key) || store.sentMessageIdExists(key)),
      // 渠道闸与引擎全局后备必须同源：生效键是顶层 email_authz_*（schema 注释
      // 与 PUT 热切换均按此语义）；嵌套 email.authz_* 是 Go 时代遗留不读。
      // mode 一并传给编译函数：open 模式下名单里有内容也不翻成白名单。
      channelAuthz: compileChannelPolicy(config.email_authz_mode, config.email_authz_allow, config.email_authz_deny),
      onMessage: (m) => engine.onEmailReceived({
        from: m.from, fromName: m.fromName, to: '', subject: m.subject, body: m.body,
        messageId: m.messageId, date: m.date, uid: m.uid,
        inReplyTo: m.inReplyTo, references: m.references, raw: m.raw,
        attachments: m.attachments.map((a) => ({ name: a.filename, bytes: a.size, content: a.content })),
      }),
      intervalSec: config.email.poll_interval_sec,
      log: (m) => log.info(m),
    });
  }

  // ---- 聊天事件 hub（环形历史 + 广播；orchestrator/voice 事件注入）----
  const chatHub = createChatHub();

  // （反馈墙/客户库/CRM/Party 目录装配已收进 wireBusiness——见上方业务分册调用。）

  // 自家域=进件账号的邮箱域（example.com 类）：内部判定的唯一域来源——只推导
  // 一次，routing 注入与 rt 暴露（/api/parties 等消费方）共用，禁止各处再推导。
  const internalDomains: readonly string[] = config.email.username.includes('@')
    ? [config.email.username.split('@')[1]!.toLowerCase()]
    : [];

  // ---- 用量账本 + 编排器（/api/chat 的大脑）----
  const usage = createUsageStore(join(dataDir, 'prompt_usage.db'));
  let orchestrator: Orchestrator | null = null;
  if (llm !== null) {
    orchestrator = createOrchestrator({
      llm: makeChatLlm(),
      model: ai.model,
      tools: tmux ? makeAllTools({
        tmux,
        notifier: null,
        assessor: null,
        cwd: dataDir,
      }) : [],
      systemPrompt: '你是 juli-service 的编排助手，通过工具驱动 tmux 会话里的 agent 完成工作。简洁、直接、说中文。',
      maxContextMessages: 40,
      usage: (r) => usage.record({ source: 'orchestrator', ...r }),
      log: (m) => log.info(m),
    });
    registerDefaultCommands(orchestrator.commands, {
      createSession: async (name, cwd) => (tmux ? tmux.newSession(name, cwd) : { ok: false, error: new Error('tmux not available') }),
      listSessions: async () => (tmux ? tmux.listSessions() : []),
    });
    registerSkillCommands(orchestrator.commands, skillRegistry, (m) => log.info(m));
  }

  const bus = createBus(log);

  // （alert_grade 挂钩的 gradeAlert 声明已上移至 pusher 装配处；赋值在下方
  // 网关装配之后。曾经的 pushAllWithDesktop/桌面通知兜底是零调用方死代码，
  // 2026-09-27 审查随 P1 修复一并删除。）

  // ---- 语音通话状态机 + 会话快照 ----
  const voiceState: { call: VoiceCall | null } = { call: null };
  const voiceCallActive = (): boolean => voiceState.call !== null;
  const voiceCallMode = (): CallMode => voiceState.call?.mode ?? 'plan';
  const snapshotFile = join(dataDir, 'sessions_snapshot.json');
  const snapshotDeps = {
    tmux: tmux,
    file: snapshotFile,
    log: (m: string) => log.info(m),
  };
  if (orchestrator !== null) {
    // 派发门：通话激活时拦截派发类工具（hooks 铁腕位）。
    // 窄 adapter：voiceGateHook 声明的返回形状 type: string 比 HookPayload 的
    // HookType 宽（实现恒回传 p 或 {...p, block, blockReason}），这里显式以
    // p 为底合并回传——替代原先的 as never 双转（R8 批2）。
    orchestrator.hooks.on('before_tool_call', (p) => {
      const gated = voiceGateHook(voiceCallActive, voiceCallMode)(p);
      return { ...p, ...gated, type: p.type };
    });
  }

  // ---- 未来渠道挂载点：teams/slack/feishu 适配器在此追加 ----
  const extraChannels: InboundChannel[] = [];

  // ---- 模板注册表 ----
  const tplDir = pipelinesDir(dataDir);
  let loaded = loadTemplates(tplDir);
  const registry: Record<string, Template> = { ...loaded.templates };

  // 路由兜底（2026-10-16 搬家）：顶层 default_session 正位，email 段 legacy 回退。
  const defaultLanding = effectiveDefaultSession(config);
  const router = tmux && defaultLanding.session !== ''
    ? createSessionRouter({
      listSync: () => agentBackend.listSync(),
      defaultSession: defaultLanding.session, log: (m) => log.info(m),
    })
    : null;

  // ---- 语义判定网关（Jev，2026-09-23）：judgment.json 缺省=全 off 零网络；
  // 场景级 off/shadow/on 热读（改文件即生效），提供方 cloud/local-api/cli 可换。
  const judgmentGateway = createJudgmentGateway({
    load: () => loadJudgmentConfig(join(dataDir, 'judgment.json')),
    judgeOf: (cfg) => createJudgeFromConfig(cfg),
    // 判定成本入账（与 orchestrator/claude_code 同一本 prompt_usage）：source=
    // 'judgment'，note=场景:模式——看板按 source 切片即得 jev 开销。
    onUsage: (r) => usage.record({
      source: 'judgment', note: `${r.scenario}:${r.mode}`,
      model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cachedTokens: r.cachedTokens,
      durationMs: r.durationMs, error: r.error ?? '',
    }),
    log: (m) => log.info(m),
  });
  // alert_grade 挂钩（judgmentGateway 已在位）：true=照推，false=info 静默。
  // 判定本体（choice 判据全文/judgment_made 留痕/采用闸）在
  // business/workflow/judgmentScenarios——runtime 只注入网关+账本+日志
  // （R8 批4 刀1 下放，语义逐字保持）。
  gradeAlert = makeGradeAlert({ judgment: judgmentGateway, store, log });

  // ---- 路由装配（0930「所有的都走路由」）：引擎进件与任务路由（routeTask）
  // 共用同一份 routing 视图 + 忙闲谓词（sessionHasOpenWork 新定义：排队/在跑
  // /等批准都算忙）——两个入口一个家，input 层不重复装配。----
  const taskRouting = {
    defaultSession: defaultLanding.session,
    defaultProject: config.email.default_project,
    boundAgents: config.email.bound_agents,
    agents: config.agents,
    internalDomains,
  };
  /** 任务路由（chat 暂存计划 + HTTP /tasks 无键兜底共用）：判定在 routing 层
   * （routeTask），此处只做依赖装配。availableSessions 调用时取活快照。 */
  const taskRoute = (title: string, brief: string): Promise<TaskLanding> =>
    routeTask(title, brief, {
      routing: taskRouting,
      judgment: judgmentGateway,
      busySession: (s) => store.sessionHasOpenWork(s),
      availableSessions: router ? router.available() : undefined,
    });

  /** 任务档位判定（task_tier 场景，2026-10-12）：进件无键路径的难度分类，
   * 判不准 = standard（成本纪律）——判定本体（判据全文/留痕/采用闸）在
   * business/workflow/judgmentScenarios（R8 批4 刀1 下放），此处只接线。 */
  const taskTier = makeTaskTier({ judgment: judgmentGateway, store, log });

  /** 命名孪生查找：session+'-hi' 在声明表且 high 才算孪生（无孪生不升档——
   * 改道落点必须真实存在，与 zod 硬规则③互为读写两侧）。 */
  const highTwinFor = (session: string): string => {
    if (session === '' || session.endsWith('-hi')) return '';
    const twin = `${session}-hi`;
    return config.agents.some((a) => a.session === twin && a.model_tier === 'high') ? twin : '';
  };

  const engine = createEngine({
    usage: (r) => usage.record(r),
    store,
    // feedback 域回挂答复计数（2026-11-12 ledger 关门）：workflow 域经注入
    // 依赖读 feedback 域库，不摸别家的表。
    feedbackReplyCount: (recordId) => feedbackMirror.replyCountOf(business.feedbackMirrorDb, recordId),
    llm,
    model: ai.model,
    queueConcurrency: config.queue?.concurrency,
    workHours: config.work_hours,
    partyDirectory: business.party,
    partyAutoCreate: config.party.auto_create,
    routing: taskRouting,
    // 引擎租户收口（A2）：按单子 tenant 选候选/落点——引擎无请求上下文，
    // 租户上下文来自 workflow.tenant，绝不来自请求头。缺省模式（无 tenants
    // 声明）不接线 = 守卫恒 null = 引擎行为与 A2 之前逐字节一致（缺省模式
    // 回填 stamp 的存量行也不收口，回归面零扩大）。
    ...(config.tenants.length > 0 ? {
      tenants: {
        tenantOfSession: (s: string) => tenantTable.table.bySession[s],
        defaultSessionFor: (t: string) =>
          tenantTable.table.tenants.find((x) => x.id === t)?.defaultSession,
      } satisfies TenantTableShape,
    } : {}),
    // 写侧打标记信号表（A3）：三路进件建单时 resolveTenant 的判定面，五张
    // 映射全部复用 A1 登记表（判定口径零分叉）。两种模式都接：缺省模式下
    // 内置存量信号（acme.de / team-pb / 老会话别名）同样生效，与 A1
    // 回填对缺省形态的 stamp 口径一致，同一库不出现两套归属真相。
    tenantSignals: {
      bySenderAddress: tenantTable.table.bySenderAddress,
      bySenderDomain: tenantTable.table.bySenderDomain,
      byFeedbackSource: tenantTable.table.byFeedbackSource,
      bySession: tenantTable.table.bySession,
      stampableTenants: tenantTable.table.stampableTenants,
      defaultTenant: INTERNAL_TENANT,
    } satisfies TenantSignalTable,
    dispatch,
    pusher,
    mailer,
    // 已批闸门静默收口判据②（wf_be61c3a55842）：认领会话最近 claude_code
    // 用量行时刻——事件链静默但行还在涨 = agent 仍在回流执行，不许收口。
    lastSessionActivity: (sess) => {
      const t = usage.lastClaudeCodeAt(sess);
      return t === '' ? 0 : (Date.parse(t) || 0);
    },
    captureOutput: tmux
      ? async (session) => {
        // 兜底而非首选：Stop hook 的结构化输出（transcript 最终答复，见
        // cli/hook.ts）缺席时才抓屏幕——pane 是终端缓冲，混着 spinner/状态栏。
        const res = await tmux.capturePane(session, 400);
        return res.ok ? res.value : null;
      }
      : null,
    zombieFingerprint: tmux
      ? async (session) => {
        const res = await tmux.capturePane(session, 200);
        return res.ok ? res.value : null;
      }
      : null,
    workspaceFor: null,
    // 复用优先路由：点名的会话不存在 → 落回 default_session（juli-reply），
    // 绝不因一次流水凭空造新 agent；triage 白名单 = 真实活会话名单。
    // P1-1（2026-09-20 审查）：这里曾用条件展开 + 字面量尾部同键兜底——对象
    // 字面量后键恒胜，忙闲选枝（availableSessions 恒 []）与 route_fallback
    // （resolveSession 恒 null）在产线双双死码。现在无展开、无第二键：
    // availableSessions 是 getter 活快照——每次读取都调 router.available()，
    // 运行期新建的 -2..9 克隆重启前即对选枝/triage 可见（装配时固化数组会让
    // 它们重启前不可见）。
    get availableSessions() { return router ? router.available() : []; },
    resolveSession: router ? (session: string) => router.resolve(session) : null,
    judgment: judgmentGateway,
    // 判定收敛执行层（2026-10-13）：三无单的落点/档位判定从进件层移进引擎
    // 派发时刻（steps 三无腿）——runtime 只装配缝，判定本体仍在此处定义。
    taskRoute: (title: string, brief: string) => taskRoute(title, brief).catch(() => null),
    taskTier,
    highTwinFor,
    // 一等插话/回流投递面：与引擎派发同一 tmux 通道（bracketed paste + Enter）。
    // 入队语义（2026-09-23 插话 400 事故）：intervene/relay 面对的常是忙碌会话
    // （agent 正在跑，输入排队消费，输入框不重置）——严格提交确认（20s 预算）
    // 对它永远超时（实测 20127ms）。sendTextQueued 只验证「文本到达过会话」，
    // 到达输入框即算投递成立；失败带原因（会话不存在/送键失败/粘贴丢失）。
    sendToSession: tmux
      ? async (session, text) => {
          if (!(await tmux.hasSession(session))) {
            return { delivered: false, reason: `tmux 会话 "${session}" 不存在（已关闭或改名）`, finalState: undefined };
          }
          const res = await tmux.sendTextQueued(session, text);
          if (!res.ok) return { delivered: false, reason: `送键失败：${res.error.message}`, finalState: undefined };
          return {
            delivered: true,
            reason: res.value.finalState === 'in_box' ? '已入输入框（会话忙碌，排队待消费）' : '',
            finalState: res.value.finalState,
          };
        }
      : null,
    // 回流送达验证：读回 pane（含历史）——外发箱防重复投递的依据。
    readPane: tmux ? async (session) => {
      const res = await tmux.capturePane(session, 500);
      return res.ok ? res.value : null;
    } : null,
    artifacts: {
      // putAndRegister 补齐后，邮件 bucket（original.eml + 附件）从死代码
      // 变成活路径；amendment/send_check 也从这里登记。
      putAndRegister: (r) => artifactLedger.putAndRegister({
        workflowId: r.workflowId, role: r.role as ArtifactRole,
        name: r.name, bytes: r.bytes, stepId: r.stepId, meta: r.meta,
      }),
      list: (wf) => artifactLedger.list(wf).map((a) => ({
        id: a.id, name: a.name, key: a.key, stepId: a.stepId, deletedAt: a.deletedAt, meta: a.meta,
      })),
      updateMeta: (id, patch) => artifactLedger.updateMeta(id, patch),
      getContent: async (id) => {
        const row = artifactLedger.get(id);
        if (!row || row.key === '' || row.deletedAt !== null) return null;
        const bytes = await backend.get(row.key);
        if (!bytes.ok) return null;
        return {
          bytes: bytes.value, sha256: row.sha256, name: row.name,
          viewRole: typeof row.meta['view_role'] === 'string' ? row.meta['view_role'] : 'report',
        };
      },
      sweepCaseInbox: (wf, stepId) => sweepCaseInbox({
        inboxDir: caseInboxDir(wf), workflowId: wf, stepId, ledger: artifactLedger,
        log: (m) => log.info(m),
      }),
    },
    externalLink: async (a) => {
      // presign_ttl 从死配置变活:外链时长随配置(disk 后端忽略 ttl,无影响)。
      const r = await backend.url(a.key, config.s3.presign_ttl);
      return r.ok ? r.value : null;
    },
    caseInboxDir,
    interruptSession: tmux
      ? async (session) => (await tmux.interrupt(session)).ok
      : null,
    rebuildAgent: null,
    templates: registry,
    authz: senderAuthzOf(config),
    log,
  });

  // 发件人授权两层同源（2026-11-23 全量审查修复）。渠道闸（邮件源阶段一的
  // 过滤，被拒的邮件直接跳过、不建单不留痕）与引擎全局策略此前只在装配时
  // 对齐一次：授权面板 POST 只换引擎那层，设置页 PUT 只落盘——渠道闸还是
  // 启动时编译的那份，面板上新加的白名单地址继续被第一层挡掉，界面却提示
  // 「即时生效」，要重启才生效。两条热改路径都收口到这里：同一份策略写
  // 引擎，渠道策略由装配时用的同一个编译函数从它产出，两层不会分叉。
  const setSenderAuthz = (policy: AuthzPolicy): void => {
    engine.setAuthz(policy);
    mailSource?.setAuthzPolicy(compileChannelPolicy(policy.mode, policy.allow, policy.deny));
  };

  // 自动批准 sweep 统一装配（runAutoApproveSweep 手动触发用；boot 扫与
  // 30s 心跳在 gates 域 startGatesTimers——句柄在下方装配，config() 每轮
  // 现读句柄，Settings 热改下一轮即生效）。
  const sweepAutoApprove = (): Promise<number> => autoApproveSweep({
    store, approve: (id, note, by) => engine.approve(id, note, by),
    config: () => gatesTimers.autoApprove(), log,
  });

  // ---- 开单对话（09-29）：clarify loop → 用户确认 → startTask 正门开单。
  // 工具白名单只读（chatTools.ts 封闭清单），对话 transcript 不进账。----
  let intakeRegistry: ChatIntakeRegistry | null = null;
  if (llm !== null) {
    const terminalStatuses = new Set(
      WORKFLOW_STATUSES.filter((s) => s.terminal).map((s) => s.key),
    );
    // conv 分线程（2026-10-17）：deps 走工厂——注册表按 conv 惰性建实例，
    // 每实例一条独立 LLM 对话上下文；main 桶永驻，其余按 LRU 封顶逐出。
    // 租户参数（A2 读侧边界）：每个 conv 实例的工具面按发起方租户收口
    // （one 只见本租户单子/会话）。缺省模式（无 tenants 声明）不过滤——
    // 行为与 A2 之前逐字节一致。
    const tenantSessionSet = (tenant: string): ReadonlySet<string> =>
      new Set(Object.entries(tenantTable.table.bySession)
        .filter(([, t]) => t === tenant).map(([s]) => s));
    const makeIntakeDeps = (tenant: string): ChatIntakeDeps => {
      const declared = config.tenants.length > 0;
      const filterTenant = declared ? tenant : null;
      const tenantSessions = filterTenant !== null ? tenantSessionSet(filterTenant) : null;
      // 账本读模型的租户收口视图（tenantReadView：listWorkflows 下推 tenant，
      // getWorkflow 越租户回 null）。filterTenant=null = 全视角原样透传。
      const scopedStore = tenantReadView(store, filterTenant);
      return {
      llm: makeChatLlm(),
      model: ai.model,
      tools: makeChatTools({
        lookupCustomer: business.lookupCustomer,
        // list_tasks/get_task 账本读模型（R8 批4 刀2 下放）：检索窗口规则与
        // usageAggOf 计价聚合在 business/intake/chatTasks——runtime 只注入
        // store/usage/artifacts，语义逐字保持。
        listTasks: listTasksOf({ store: scopedStore, usage, artifacts: artifactLedger }),
        getTask: getTaskOf({ store: scopedStore, usage, artifacts: artifactLedger }),
        // 会话清单：声明表 × 在办分布（在办=非终态，含排队/闸门，0930 忙闲口径）。
        listSessions: () => {
          const inflight = new Map<string, number>();
          for (const w of store.listWorkflows(200)) {
            if (terminalStatuses.has(w.status)) continue;
            const assigned = typeof w.meta?.['assigned_session'] === 'string' ? (w.meta['assigned_session']) : '';
            // 同一单每会话至多计一次：session===assigned_session（点名落同会话，
            // 常态）时数组直加会双计——sessionHasOpenWork 的 SQL OR 口径只计一次。
            for (const sess of new Set([w.session ?? '', assigned])) {
              if (sess !== '') inflight.set(sess, (inflight.get(sess) ?? 0) + 1);
            }
          }
          return routeTaskMenu(taskRouting)
            .filter((a) => tenantSessions === null || tenantSessions.has(a.session))
            .map((a) => ({
              session: a.session, company: a.company, domain: a.domain,
              description: a.description ?? '', inflight: inflight.get(a.session) ?? 0,
            }));
        },
        // 服务自信息：全部非敏感只读面（版本/模型/端口/单量/今日用量/hold）。
        serviceInfo: () => {
          const all = filterTenant === null
            ? store.listWorkflows(5000)
            : store.listWorkflows(5000, undefined, filterTenant);
          const midnight = new Date();
          midnight.setHours(0, 0, 0, 0);
          const todayStart = midnight.toISOString();
          const todayEnd = new Date(midnight.getTime() + 86_400_000).toISOString();
          // byLocalDay 只含有用量的天：at(-1) 在今天尚零用量时会错拿昨天整行
          // （todayTokens 名不符实）——按本地日期取行（1 天窗口必含今天全天），
          // 取不到=今天真零用量。租户收口（A2）：按本租户会话逐会话聚合今日
          // 用量行——缺省模式（tenantSessions=null）保持全局行口径。
          const two = (n: number): string => String(n).padStart(2, '0');
          const todayKey = `${midnight.getFullYear()}-${two(midnight.getMonth() + 1)}-${two(midnight.getDate())}`;
          const todayRow = usage.byLocalDay(1).find((r) => r.day === todayKey);
          let today = { input: todayRow?.inputTokens ?? 0, output: todayRow?.outputTokens ?? 0, calls: todayRow?.calls ?? 0 };
          if (tenantSessions !== null) {
            today = { input: 0, output: 0, calls: 0 };
            for (const sess of tenantSessions) {
              for (const r of usage.perSessionWindowsRows(sess, [[todayStart, todayEnd]])) {
                today.input += r.inputTokens;
                today.output += r.outputTokens;
                today.calls += 1;
              }
            }
          }
          const idSet = new Set(all.map((w) => w.id));
          return {
            version: VERSION,
            startedAt: new Date(BOOT_MS).toISOString(),
            model: ai.model,
            ports: { http: config.listen_port, tls: config.tls_port ?? null },
            workflows: {
              total: all.length,
              inflight: all.filter((w) => !terminalStatuses.has(w.status)).length,
              today: all.filter((w) => (w.createdAt ?? '') >= todayStart).length,
            },
            todayTokens: today,
            heldTasks: [...engine.queueStatus().held].filter((id) => idSet.has(id)).length,
          };
        },
      }),
      startTask: async (title, brief, session, autoApprove, tenant) => {
        try {
          const w = await engine.startTask(title, {
            brief,
            ...(session !== undefined && session !== '' ? { session } : {}),
            ...(autoApprove === true ? { auto_approve: true } : {}),
            // 显式租户（A3 写侧打标记）：确认卡的人为选择，HTTP 边界校验过
            // 才进来；键随 input 进 template_input（来源留痕）。
            ...(tenant !== undefined && tenant !== '' ? { tenant } : {}),
          });
          return ok({ id: w.id });
        } catch (e) {
          return err(e instanceof Error ? e : new Error(String(e)));
        }
      },
      // 落点判定注入（0930）：chat 层零路由逻辑——routeTask（routing 层）给
      // 落点，计划卡显示；via/diverted 原样透传（十一跑 P1-1）：confirm 只注
      // 「真判定」（jev 采纳/改道），fail-open default 不注入不钉（HTTP 线
      // 同口径），计划卡显示不受影响。
      resolveLanding: (title, brief) => taskRoute(title, brief)
        .then((l) => ({ session: l.session, note: l.note, via: l.via, diverted: l.diverted })),
      pinnableSessions: routeTaskMenu(taskRouting).map((a) => a.session),
      sessionRoster: routeTaskMenu(taskRouting)
        .map((a) => `${a.session} — ${a.company}/${a.domain}${a.description !== undefined && a.description !== '' ? ` — ${a.description}` : ''}`)
        .join('\n'),
      onDispatched: (info) => {
        // 落点进账本（路由图 recent 读 route_decision 同款事件）。
        store.appendEvent('workflow', info.id, 'route_decision', {
          from: 'chat-intake', company: '', domain: '', session: info.session,
          chain: ['chat', info.pinned ? 'pin' : 'route_task'],
          reasons: {
            chat: '开单对话确认开单（创建动词=人按按钮）',
            [info.pinned ? 'pin' : 'route_task']: info.note !== '' ? info.note : (info.session !== '' ? `落点 ${info.session}` : '默认会话'),
          },
          fallback: false,
        });
      },
      usage: (r) => usage.record({ source: 'chat-intake', ...r }),
      log: (m) => log.info(m),
      };
    };
    intakeRegistry = createChatIntakeRegistry(makeIntakeDeps);
  }

  // ---- feedback 进件（09-19）：镜像新记录 → startTask 起单（装配体在
  // runtime.business.ts——不走 onInbound 的裁决语义见该文件；公开桩=null）----
  const feedbackIntake = wireFeedbackIntake({ feedbackMirrorDb: business.feedbackMirrorDb, config, store, engine, judgment: judgmentGateway, log });

  // ---- 周期任务 ----
  let timers: NodeJS.Timeout[] = [];
  // Settings 热改键的内存落点（config 本体冻结——改这里，不改 config）。
  // retentionDays 是账本参数（ledger_retention_days）：状态留组合根，
  // workflow 域 prune 定时器经 getter 现读（域不持有跨域配置）。
  let retentionDays = config.ledger_retention_days;
  let gatesTimers: GatesTimers = { timers: [], setAutoApprove: () => {}, autoApprove: () => autoApproveInitial };
  let workflowTimers: WorkflowTimers = { timers: [] };
  const hotApplied: Record<string, unknown> = {};
  const setDotted = (obj: Record<string, unknown>, path: string, value: unknown): void => {
    const segs = path.split('.');
    let cur: Record<string, unknown> = obj;
    for (const seg of segs.slice(0, -1)) {
      const next = cur[seg];
      if (!isPlainRecord(next)) { const fresh: Record<string, unknown> = {}; cur[seg] = fresh; cur = fresh; continue; }
      cur = next;
    }
    cur[segs[segs.length - 1]!] = value;
  };

  // 认证器：config 冻结、无热改键——装配期一次成型（此前 getter 每请求重建）。
  const authImpls: Authenticator[] = [];
  if (config.password !== '') authImpls.push(createLocalAuthenticator(config.password));
  if (config.pb_url !== '') authImpls.push(createPbAuthenticator({ url: config.pb_url, collection: config.pb_collection }));
  const authenticator: Authenticator | null =
    authImpls.length > 0 ? createCompositeAuthenticator(authImpls) : null;

  return {
    config,
    home,
    store,
    feedbackMirrorDb: business.feedbackMirrorDb,
    gates,
    engine,
    bus,
    tmux,
    artifactLedger,
    artifactBackend: backend,
    artifactSharing: s3 !== null,
    usage,
    orchestrator,
    chatIntake: intakeRegistry !== null ? intakeRegistry.main : null,
    chatIntakeFor: (conv: string, tenant?: string) =>
      (intakeRegistry !== null ? intakeRegistry.of(conv, tenant) : null),
    chatConvTenant: (conv: string) => (intakeRegistry !== null ? intakeRegistry.tenantOf(conv) : null),
    tenants: tenantTable.table,
    taskRoute,
    taskTier,
    highTwinFor,
    mailSource,
    feedback: business.feedback,
    feedbackIntake,
    customers: business.customers,
    crm: business.crm,
    party: business.party,
    internalDomains,
    templateErrors: loaded.errors,
    get templateFiles() { return loaded.files; },
    get lastImapPoll() { return mailSource?.status().lastPoll ?? null; },

    authenticator,
    get voiceCall() { return voiceState.call; },
    get channels(): readonly InboundChannel[] {
      return [mailSource, ...extraChannels].filter((c): c is InboundChannel => c !== null);
    },

    emitChat: (type: string, data: string, conv?: string) => chatHub.emit(type, data, conv),
    get chatHub() { return chatHub; },
    async chat(input: string): Promise<{ events: { type: string; data?: string }[]; reply: string }> {
      if (!orchestrator) return { events: [{ type: 'chat:error', data: 'not configured' }], reply: '' };
      const events: { type: string; data?: string }[] = [];
      await orchestrator.handle(input, (e) => {
        const item: { type: string; data?: string } = { type: e.type };
        if (e.type === 'text' || e.type === 'thinking') item.data = e.content;
        else if (e.type === 'tool_call') item.data = e.tool;
        else if (e.type === 'tool_result') item.data = e.content;
        events.push(item);
        chatHub.emit(e.type, item.data ?? '');
      });
      const reply = [...events].reverse().find((e) => e.type === 'text')?.data ?? '';
      return { events, reply };
    },
    openVoiceCall(mode: CallMode) {
      if (!orchestrator) return null;
      voiceState.call = createVoiceCall(mode, {
        llm: makeChatLlm(),
        model: ai.model,
        dispatch: async (session, brief) => {
          if (!(await tmux.hasSession(session))) {
            const created = await tmux.newSession(session);
            if (!created.ok) return created;
          }
          return tmux.sendText(session, brief);
        },
        log: (m) => log.info(m),
      });
      log.info(`[voice] 通话开始（mode=${mode}）`);
      return voiceState.call;
    },

    closeVoiceCall(): void {
      // P0（2026-10-27）：通话有进无出——全仓曾无任何置回 null 的路径。
      // 幂等：无在途通话直接返回（挂断端点对空态也回 ok）。
      if (voiceState.call === null) return;
      voiceState.call = null;
      log.info('[voice] 通话结束');
    },

    async confirmVoicePlan(): Promise<VoiceEvent[]> {
      if (!voiceState.call) return [{ type: 'chat:error', data: 'no active call' }];
      const t = await voiceState.call.confirmPlan();
      return t.events;
    },

    async denyVoicePlan(): Promise<VoiceEvent[]> {
      if (!voiceState.call) return [{ type: 'chat:error', data: 'no active call' }];
      return voiceState.call.denyPlan().events;
    },

    async takeSnapshotNow(): Promise<number> {
      const snap = await takeSnapshot(snapshotDeps);
      return snap.ok ? snap.value.sessions.length : 0;
    },

    async recoverNow(): Promise<number> {
      return recoverFromSnapshot({ ...snapshotDeps });
    },

    registerDeviceToken(token: string): void {
      const cur = deviceTokens().filter((t) => t !== token);
      saveDeviceTokens([...cur, token]);
    },

    saveTemplate(fileName, yaml) {
      const e = saveTemplateFile(tplDir, fileName, yaml);
      if (e === null) this.reloadTemplates();
      return e;
    },
    readTemplate(fileName) {
      return readTemplateFile(tplDir, fileName);
    },
    deleteTemplate(fileName) {
      deleteTemplateFile(tplDir, fileName);
      this.reloadTemplates();
    },
    reloadTemplates() {
      loaded = loadTemplates(tplDir);
      engine.setTemplates({ ...loaded.templates });
    },

    // 热改键白名单：其余键写文件后重启生效（见 PUT /api/settings）。
    // 只上报真被接受的键——setIntervalSec 拒掉的值不算「已生效」。
    applySettings(patch: JsonRecord): { applied: readonly string[] } {
      const applied: string[] = [];
      const emailPatch = patch['email'];
      if (isPlainRecord(emailPatch) && typeof emailPatch['poll_interval_sec'] === 'number') {
        if (mailSource?.setIntervalSec(emailPatch['poll_interval_sec'])) {
          hotApplied['email.poll_interval_sec'] = emailPatch['poll_interval_sec'];
          applied.push('email.poll_interval_sec');
        }
      }
      // 发件人授权热改（2026-11-23 全量审查修复）：patch 带了 email_authz_*
      // 任一键，就把渠道闸和引擎策略一起换掉。生效值重新读配置文件（路由侧
      // 已先落盘），不拿 patch 自己拼——patch 可以只带其中一个键，另外两个
      // 键得以盘上的为准；env 覆盖后的结果也和重启后一致。
      const authzTouched = SENDER_AUTHZ_KEYS.filter((k) => patch[k] !== undefined);
      if (authzTouched.length > 0) {
        let effective: AuthzPolicy | null = null;
        try {
          effective = senderAuthzOf(loadConfig({ env: process.env, home }));
        } catch (e) {
          // 读不回来就不换、也不上报已生效（落盘侧刚校验过，这里只是防御）。
          log.error(`[authz] 热改读回配置失败，授权策略未变（重启后生效）: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (effective !== null) {
          setSenderAuthz(effective);
          // GET 投影用：冻结的 config 读不到已生效的新值，不记的话保存后
          // 刷新会把旧值再显示出来。
          hotApplied['email_authz_mode'] = effective.mode;
          hotApplied['email_authz_allow'] = [...effective.allow];
          hotApplied['email_authz_deny'] = [...effective.deny];
          applied.push(...authzTouched);
        }
      }
      if (typeof patch['ledger_retention_days'] === 'number') {
        retentionDays = patch['ledger_retention_days'];
        hotApplied['ledger_retention_days'] = patch['ledger_retention_days'];
        applied.push('ledger_retention_days');
      }
      const queuePatch = patch['queue'];
      if (isPlainRecord(queuePatch) && typeof queuePatch['concurrency'] === 'number') {
        const n = Math.floor(queuePatch['concurrency']);
        // 收单台并发热改（2026-10-27 配置化）：范围与 schema 同口径（1..16）；
        // 上调即泵等待队，下调不抢占（queue.setConcurrency 语义）。值域外的
        // 请求不应用也不标记 applied——PUT 落盘侧 zod 会拒，这里防御重复。
        if (n >= 1 && n <= 16) {
          engine.setQueueConcurrency(n);
          hotApplied['queue.concurrency'] = n;
          applied.push('queue.concurrency');
        }
      }
      const aaPatch = patch['auto_approve'];
      if (aaPatch !== undefined) {
        const aaNext = projectAutoApprove(aaPatch);
        gatesTimers.setAutoApprove(aaNext);
        hotApplied['auto_approve'] = { mode: aaNext.mode, rules: aaNext.rules };
        applied.push('auto_approve');
      }
      const notifyPatch = patch['notify'];
      if (isPlainRecord(notifyPatch)) {
        const pickList = (v: unknown): readonly string[] =>
          Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
        if (Array.isArray(notifyPatch['to'])) {
          notifyTo = pickList(notifyPatch['to']);
          hotApplied['notify.to'] = [...notifyTo];
          applied.push('notify.to');
        }
        if (Array.isArray(notifyPatch['cc'])) {
          notifyCc = pickList(notifyPatch['cc']);
          hotApplied['notify.cc'] = [...notifyCc];
          applied.push('notify.cc');
        }
      }
      const aiPatch = patch['ai'];
      // 旧散键（设置页「Provider / 模型 / Base URL（散键兜底）」那三个字段）：ai 段
      // 留空时生效值来自它们——有的部署只填了旧散键。这里只看「补丁动没动旧散键」
      // （动了才进热改，并把盘上的值记给设置页回显）；生效值本身从盘上读（见下）。
      const legacyTouched = (['llm_provider', 'llm_model', 'llm_base_url'] as const).filter((k) =>
        k === 'llm_provider'
          ? (patch[k] === 'anthropic' || patch[k] === 'openai')
          : typeof patch[k] === 'string');
      if (isPlainRecord(aiPatch) || legacyTouched.length > 0) {
        // ai 段与旧散键热改（ai 段：2026-10-10 开源 MVP；旧散键：2026-11-24 复审
        // 修复补上）：终端/进程环境即时重注入（新 agent 会话生效）；引擎自身 LLM
        // 构造是闭包冻结——重启生效。路由侧已先过 saveConfigFile 的 zod 校验
        // （不过=文件未动，到不了这里）。
        // 生效值以盘上为准（2026-11-24 R2 复审 P1-A）：路由侧已先把补丁落盘，这里
        // 读回来，和发件人授权那条路同一个做法。此前用「冻结的启动配置 + 本次
        // 补丁」算，算不出上一次保存的值——连续保存两次（先存地址、再只存模型），
        // 后一次算出来的地址是启动时的，前一次热改的地址被删掉或被旧值顶回去，
        // 盘上却是对的。
        let fresh: AiResolved | null = null;
        try {
          const onDisk = loadConfig({ env: process.env, home });
          fresh = resolveAiConfig(onDisk);
          // 旧散键改了，设置页上那一栏也要跟着变（R2 复审 P3-G）：GET /api/settings
          // 是冻结的启动配置盖一层热改值，不记的话保存后刷新还是旧值。
          for (const k of legacyTouched) hotApplied[k] = onDisk[k];
        } catch (e) {
          // 读不回来就不动环境、也不上报已生效（落盘侧刚校验过，这里只是防御）。
          log.error(`[ai] 热改读回配置失败，agent 环境未变（重启后生效）: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (fresh !== null && fresh.apiKey !== '') {
          injectAgentEnv(fresh);
          hotApplied['ai.provider'] = fresh.provider;
          // 地址、模型清空了也要记一个空串（2026-11-24 复审修复；模型那条是 R3 复审
          // P3-4 补的）：这里不带空串就盖不住冻结配置里的旧值——人清空之后刷新
          // 页面看到的还是旧值，以为没清掉。
          hotApplied['ai.base_url'] = fresh.baseUrl;
          hotApplied['ai.model'] = fresh.model;
          applied.push(`${isPlainRecord(aiPatch) ? 'ai' : legacyTouched.join(' / ')}（agent 环境已热注入，新 agent 会话生效；引擎 LLM 重启生效）`);
        }
      }
      return { applied };
    },

    runAutoApproveSweep(): Promise<number> {
      return sweepAutoApprove();
    },

    setSenderAuthz,

    liveOverrides(): JsonRecord {
      const out: JsonRecord = {};
      for (const [k, v] of Object.entries(hotApplied)) setDotted(out, k, v);
      return out;
    },

    start() {
      // 统一 ai 段 → agent 执行环境（先于声明会话预热——冷启动会话即吃到注入）。
      injectAgentEnv(ai);
      // 渠道路由卫兵（2026-09-21 深夜 /site→acme 死规则事故）：悬空规则
      // 每单运行时被复用优先静默兜底，启动时点名让死规则第一分钟可见。
      for (const rule of danglingFeedbackRoutes(config)) {
        log.error(`[config] feedback_routing 死规则：prefix "${rule.prefix}" → 会话 "${rule.session}" 不在 config.agents 声明表，每单将静默落回 ${config.email.default_session}——请声明该会话、改指已有会话或删除规则`);
      }
      // 租户登记摘要（2026-11-08 多租户提案 A1）：一行说清现行租户面——
      // 多租户时逐租户报 agent 数；无 tenants 键 = 单 internal 全收编。
      if (config.tenants.length > 0) {
        log.info(`[tenants] ${tenantTable.table.tenants.map((t) => `${t.id}（${t.agents.length} agents）`).join('、')}`);
      } else {
        log.info('[tenants] tenants 未配置，全部归 internal');
      }
      // 显式 boot（2026-11-08 审查 P1 副作用后置）：启动重排队/孤儿救援从
      // 构造期挪到这里——rt.start 本身已由 index.ts 推迟到全部 server listen
      // 成功之后，账本副作用不再早于端口独占执行。
      engine.boot();
      engine.reconcileStartup().catch((e) => log.error(`reconcileStartup: ${String(e)}`));
      // 声明会话预热（2026-09-28 用户口令）：重启后按 config.agents 声明表
      // 逐个 provision（幂等——已就绪的会话秒过；缺的按声明 cwd 建会话拉
      // claude）。消灭「重启后 ✗ 全躺、首单吃冷启动」：session:list 立即全绿、
      // 第一张派给任何声明会话的单零冷启动延迟。后台执行不拦启动；单个会话
      // 预热失败只留日志（派发时会再走同一链路自愈）。
      if (provision !== null) {
        void (async () => {
          const names = warmupPlan(config.agents);
          let okCount = 0; let failCount = 0;
          for (const name of names) {
            const r = await provision('startup-warmup', name, '').catch((e: unknown) => ({
              ok: false as const, error: { message: e instanceof Error ? e.message : String(e) },
            }));
            if (r.ok) okCount++;
            else { failCount++; log.error(`[warmup] 会话 ${name} 预热失败（不拦启动，派发时自愈）: ${r.error.message}`); }
          }
          log.info(`[warmup] 声明会话预热完成：${okCount} 就绪${failCount > 0 ? `，${failCount} 失败（见上）` : ''}（backend=${agentBackend.describe}）`);
        })();
      }
      mailSource?.start();
      // CC hooks 注入（幂等）：agent 事件回流的服务端路径。注入前先验证
      // hook 脚本真在盘上——注入死路径会让每个会话的每个事件都报
      // Cannot find module（0923 loader:1386：src/cli/hook.js 残留条目）。
      if (config.claude_dir !== '' && existsSync(config.claude_dir)) {
        // hook 入口优先数据卷自装 bin（`juli setup` 维护的 <data_dir>/bin/juli，
        // 与 checkout 解耦——2026-10-11 dist 清失事故后定案）；缺席回退仓内
        // dist 构建产物（需 npm run build）。两入口同 runHook，命令模板零改写。
        const hookBin = join(config.data_dir, 'bin', 'juli');
        const hookJs = existsSync(hookBin) ? hookBin : join(distDirOf(import.meta), 'cli', 'hook.js');
        if (!existsSync(hookJs)) {
          log.error(`CC hooks 注入跳过：hook 脚本不存在 ${hookJs}（先 npm run build）`);
        } else {
          const res = installClaudeHooks(config.claude_dir, agentBackend.hookSpecs(hookJs, config.password, `http://127.0.0.1:${config.listen_port}`));
          // 日志带实际解析的 hook 入口路径：bin 在位（数据卷）vs 缺席回退
          // dist 两种形态立即可辨——陈旧 bin 静默服役的第一现场。
          if (res.ok) log.info(`CC hooks 已注入 ${config.claude_dir}/settings.json（hook=${hookJs}）`);
          else log.error(`CC hooks 注入失败: ${res.error.message}`);
        }
      }
      // ---- 周期任务装配（第 7 步：定时器归各域，runtime 只剩聚合启动）----
      // workflow 域：对账/定档/回流外发箱/已批收口/僵尸扫描/账本修剪。
      // retentionDays 传 getter 现读（b56-R1）：Settings 热改写组合根变量，
      // prune tick 每轮取当前值——装配期收快照会把热改断线到重启（已修）。
      workflowTimers = startWorkflowTimers({ engine, store, retentionDays: () => retentionDays, log });
      // gates 域：自动批准 sweep（boot 即扫 + 30s 心跳；含 auto_approve 热改盒）。
      gatesTimers = startGatesTimers({
        store, approve: (id, note, by) => engine.approve(id, note, by),
        initial: autoApproveInitial, log,
      });
      timers = [
        ...workflowTimers.timers,
        ...gatesTimers.timers,
        // CC transcript 摄取（usage 计价侧）：每分钟增量。
        ...startUsageIngestTimers({
          usage, tmux, agentBackend,
          claudeDir: config.claude_dir || join(process.env['HOME'] ?? '', '.claude'),
          log,
        }),
        // feedback 域：镜像 sweep → 进件 → villa 源 → apply 链收口。
        ...startFeedbackTimers({
          mirrorDb: business.feedbackMirrorDb,
          dataDir: config.data_dir, store, engine,
          feedbackIntake,
          log,
        }),
        // 财务备份巡检（platform/ops；未配置=空集）。
        ...startFinanceBackupTimers({
          config, mailer: mailer ?? undefined,
          recipients: () => ({ to: notifyTo, cc: notifyCc }),
          log,
        }),
      ];
      log.info(`juli-service 已启动：data_dir=${dataDir} templates=${Object.keys(loaded.templates).length}`);
    },

    attachWs(server: import('node:http').Server): void {
      // 租户握手闭包（A2）：三个 hub 共用——解析 X-Juli-Tenant（header 或同名
      // query），未声明的租户 id → null（拒连，HTTP 面 400 的 WS 等价）。
      const resolveTenantScope = (v: string | undefined) => {
        try {
          return parseTenantScope(v, tenantTable.table.tenants.map((t) => t.id));
        } catch {
          return null;
        }
      };
      attachChatWireWs({
        server, chatHub, password: config.password,
        // conv 租户过滤（A2）：逐帧查登记——one 只见同租户 conv；未登记 conv
        // 只进 all。逐帧求值让「先订阅后开线程」的时序成立。
        convTenantOf: (conv) => (intakeRegistry !== null ? intakeRegistry.tenantOf(conv) : null),
        resolveScope: resolveTenantScope,
        log: (m) => log.info(m),
      });
      // 会话租户握手（A2）：X-Juli-Tenant（header 或同名 query）→ one 时会话须
      // 属该租户，越租户 1008 拒（ptyhub 与 snapshot 同款）。缺省模式不接
      //（无租户可判=全视角）。
      const wsTenants = config.tenants.length > 0 ? {
        tenants: {
          resolve: resolveTenantScope,
          tenantOfSession: (s: string) => tenantTable.table.bySession[s],
        },
      } : {};
      attachPtyHub({
        server, password: config.password,
        attach: readyAttach,
        boundSessions: config.email.bound_agents.map((b) => b.session),
        ...wsTenants,
        log: (m) => log.info(m),
      });
      attachSnapshotWireWs({
        server, tmux, password: config.password,
        ...wsTenants,
        log: (m) => log.info(m),
      });
      log.info('[ws] PTY 桥已挂载（/ws/xterm/{session}）+ 快照流（/ws/snapshot/{session}）');
    },

    stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
      mailSource?.stop();
    },
  };
};
