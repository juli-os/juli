// 组合根：把配置、账本、模板注册表、能力端口（LLM/派发/发信/推送）与引擎
// 装配成一个冻结的 Runtime——依赖只从这里注入（对齐 Go 的 chat_wiring 组合
// 根；Go 的 init() 注入化债务在这里从第一天就不存在）。

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import type { Config } from './platform/config/schema.ts';
import { resolveAiConfig, resolveSecret, danglingFeedbackRoutes, type AiResolved } from './platform/config/schema.ts';
import { consoleLogger, createBus, type Logger } from './platform/events/bus.ts';
import { createLedgerStore, type LifecycleStore } from '@juli-os/ledger';
import type { JsonRecord } from '@juli-os/artifacts'
import { createUsageStore, type UsageStore } from '@juli-os/ledger';
import { createAnthropicChat, createOpenAiChat } from './platform/llm/chat.ts';
import { type ChatLlmPort } from '@juli-os/agents';
import { createOrchestrator, registerDefaultCommands, registerSkillCommands, type Orchestrator } from '@juli-os/agents';
import { makeAllTools } from '@juli-os/agents';
import type { InboundChannel } from './contracts/channels.ts';
import { createChatHub, type ChatHub } from './platform/ws/chathub.ts';
import { createSkillRegistry } from '@juli-os/agents';
import { createVoiceCall, voiceGateHook, type VoiceCall, type CallMode, type VoiceEvent } from '@juli-os/agents';
import { startSnapshotLoop, recoverFromSnapshot, takeSnapshot } from '@juli-os/agents';
import type { SessionHealer } from '@juli-os/agents';
import { attachPtyHub } from './platform/ws/ptyhub.ts';
import { attachChatWireWs, attachSnapshotWireWs } from './platform/ws/wirehubs.ts';
import { createCompositeAuthenticator, createLocalAuthenticator, createPbAuthenticator, type Authenticator } from './platform/auth/authenticator.ts';
import { mkdirSync as mkDirSync } from 'node:fs';
import { createEngine, type Engine } from './business/workflow/engine.ts';
import { compileChannelPolicy } from './contracts/authz.ts';
import { loadTemplates, pipelinesDir, saveTemplateFile, deleteTemplateFile, readTemplateFile } from './business/templates/registry.ts';
import { createChatIntake, type ChatIntake } from './business/intake/chatIntake.ts';
import { makeChatTools } from './business/intake/chatTools.ts';
import { autoApproveSweep, projectAutoApprove, type AutoApproveConfig } from './business/workflow/autoApprove.ts';
import { costContextOf } from './business/workflow/costContext.ts';
import { VERSION } from './contracts/version.ts';
import { err, ok } from '@juli-os/artifacts';
import { WORKFLOW_STATUSES } from './contracts/statuses.ts';
import { createJudgmentGateway, createJudgeFromConfig, loadJudgmentConfig } from '@juli-os/routing';
import { routeTask, routeTaskMenu, type TaskLanding } from '@juli-os/routing';
import type { Template } from './business/templates/template.ts';
import type { PusherPort } from './contracts/ports.ts';
import { type Step, type Workflow } from '@juli-os/ledger';
import { createAnthropicProvider, createOpenAiProvider } from './platform/llm/providers.ts';
import { createSmtpMailer } from './platform/email/smtp.ts';
import { createMailSource, type MailSource } from './platform/email/source.ts';
import { resolveEmailPassword } from './platform/email/passwords.ts';
import { createTmuxClient, type TmuxClient } from '@juli-os/agents';
import { createProvisioningDispatch } from '@juli-os/agents';
import { createSessionRouter, tmuxListSync } from '@juli-os/agents';
import { createAcpExecutor, type AcpExecutor } from '@juli-os/agents';
import { installClaudeHooks, defaultHookSpecs } from '@juli-os/agents';
import { createArtifactLedger, sweepCaseInbox, type ArtifactLedger, type ArtifactRole } from '@juli-os/artifacts';
import { createDiskBackend, createS3Backend, createDualBackend, type ArtifactBackend } from '@juli-os/artifacts';
import { createDevicePusher, createEmailNotifier, combinePushers, withAlertGrade } from './platform/push/email.ts';
// 业务装配分册（反馈墙/客户库/CRM/Party/推送真实现/feedback 进件/巡检定时器）
// ——私仓扩展位单一入口；开源投影以同形桩替换（export/overlay/）。
import { wireBusiness, wireFeedbackIntake, startBusinessTimers, type BusinessParts, type BusinessIntake } from './runtime.business.ts';
import type { PartyDirectory } from './business/party/party.ts';
import { truncate } from './platform/shared/json.ts'
import { fileURLToPath } from 'node:url';

/** 进程起点（service_info 的 startedAt / uptime 近似——模块加载即记）。 */
const BOOT_MS = Date.now();

/** 运行时自身所在的 dist（hook.js 与它同源——dev 用 tsx 也能解析到 ts）。 */
const distDirOf = (meta: { url: string }): string => {
  const here = fileURLToPath(meta.url);
  const dir = here.replace(/\/[^/]*$/, '');
  // dist/runtime.js → dist；src/runtime.ts → src（hook 有 .js/.ts 两个入口）。
  if (dir.endsWith('src')) return dir;
  return dir;
};

export type EngineDeps = Parameters<typeof createEngine>[0];

export interface RuntimeSeams {
  /** 测试/嵌入接缝：覆盖组合根自动装配的端口。 */
  readonly llm?: EngineDeps['llm'];
  readonly mailer?: EngineDeps['mailer'];
  readonly dispatch?: EngineDeps['dispatch'];
  readonly tmux?: TmuxClient;
  readonly pusher?: PusherPort;
  /** config.json 所在 home（Settings 写回落点）；测试注入 tmpdir 用。 */
  readonly home?: string;
}

export interface Runtime {
  readonly config: Config;
  readonly store: LifecycleStore;
  readonly engine: Engine;
  readonly bus: ReturnType<typeof createBus>;
  readonly tmux: TmuxClient | null;
  readonly acp: AcpExecutor | null;
  readonly artifactLedger: ArtifactLedger;
  readonly artifactBackend: import('@juli-os/artifacts').ArtifactBackend;
  readonly artifactSharing: boolean;
  readonly usage: UsageStore;
  readonly orchestrator: Orchestrator | null;
  readonly channels: readonly InboundChannel[];
  readonly authenticator: Authenticator | null;
  readonly chatHub: ChatHub;
  emitChat(type: string, data: string): void;
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
  readonly voiceCall: VoiceCall | null;
  openVoiceCall(mode: CallMode): VoiceCall | null;
  confirmVoicePlan(): Promise<VoiceEvent[]>;
  denyVoicePlan(): Promise<VoiceEvent[]>;
  /** 开单对话（09-29）：clarify loop + 白名单只读工具 + 确认开单走 startTask
   * 正门（与 #/trigger 表单同契约）。null = LLM 未配置。 */
  readonly chatIntake: ChatIntake | null;
  /** 任务路由（0930「所有的都走路由」）：无键起单兜底判定（chat 计划暂存与
   * HTTP /api/lifecycle/tasks 共用）——jev 判定 + 忙闲感知落点，判定在
   * routing 层，本面只做装配。 */
  taskRoute(title: string, brief: string): Promise<TaskLanding>;
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

export const createRuntime = (config: Config, seams: RuntimeSeams = {}, log: Logger = consoleLogger): Runtime => {
  // 部署红线：绑非回环地址必须配密码（对齐 Go 版启动守卫）。
  if (!isLoopbackHost(config.listen_host) && config.password === '') {
    throw new Error('非回环地址监听必须配置密码（JULI_PASSWORD / config.password）');
  }
  const dataDir = config.data_dir;
  const home = seams.home ?? homedir();
  mkdirSync(dataDir, { recursive: true });
  // 技能（markdown 目录 + /skills /skill 命令）——orchestrator 组合前就绪。
  const skillsDir = join(dataDir, 'skills');
  mkDirSync(skillsDir, { recursive: true });
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
  const tmux = seams.tmux ?? createTmuxClient({ socketPath: config.tmux_socket_path || undefined });
  // 就绪派发：会话缺失则建、裸 shell 则拉起 agent 并等 REPL 就绪、选择菜单
  // 拒派转人工——任务只在 agent 在位后发出（2026-09-12 can't-find-session
  // 与裸 shell 直投事故的修复）。绑定会话（专用 agent 隔离）自建时用配置
  // cwd——绑定会话按其配置 cwd 启动以吃到项目级 skill。
  // 优先级（2026-09-21 补声明段）：绑定会话专用 cwd > 声明 agent 的 cwd >
  // 引擎目录——research/stats 会话自动起时不再落错目录。
  const provision = tmux
    ? createProvisioningDispatch({
      tmux,
      log: (m) => log.info(m),
      // 模型分层引导（2026-09-28「非必要不高智能」）：声明 high 的会话冷启动
      // 带 --model 高档 id；standard 档 id 配了同样生效（默认降档省 token）。
      // 未配 models=两档都裸 claude（历史行为）。已就绪会话不受影响。
      bootFor: (s) => {
        const tier = config.agents.find((a) => a.session === s)?.model_tier === 'high' ? 'high' : 'standard';
        const id = tier === 'high' ? config.models.high : config.models.standard;
        return id !== '' ? `claude --model '${id}'` : 'claude';
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
    })
    : null;
  const dispatch = seams.dispatch ?? (provision
    ? {
      async dispatch(source, session, text) {
        const sent = await provision(source, session, text);
        // prompt 意图入账（对账/重放的依据；engine 已保证 run 存在）。
        if (sent.ok) {
          const run = store.activeRunForSession(session);
          if (run && run.workflowId) store.createPrompt(run.id, text, 'send');
        }
        return sent;
      },
    }
    : null);

  // ---- agent 执行环境注入（2026-10-10 开源 MVP）：统一 ai 段的 key/base_url
  // 进 tmux 全局环境——新建会话里的 claude 进程即继承 ANTHROPIC_API_KEY /
  // ANTHROPIC_BASE_URL（tmux server 内存态，不落盘）。进程 env 同步置位：
  // 引擎首建的 tmux server 天然继承引擎 env（set-environment 失败时的兜底）。
  // 已在跑的会话不受影响——热改 key 后新会话生效（诚实边界，见 applySettings）。----
  const injectAgentEnv = (resolved: AiResolved): void => {
    if (resolved.apiKey === '') return;
    // 双通道：API_KEY（x-api-key）+ AUTH_TOKEN（Bearer）。Claude Code 对自定义
    // API_KEY 有一次性「是否使用」对话框（误答 No 即写进 .claude.json 永拒，
    // 容器无头环境必踩）；AUTH_TOKEN 无此对话框且 Anthropic 官方与兼容端
    // （GLM 等）都接受 Bearer——两键同值并注，两世界通吃。
    process.env['ANTHROPIC_API_KEY'] = resolved.apiKey;
    process.env['ANTHROPIC_AUTH_TOKEN'] = resolved.apiKey;
    if (resolved.baseUrl !== '') process.env['ANTHROPIC_BASE_URL'] = resolved.baseUrl;
    if (tmux === null) return;
    const vars: readonly (readonly [string, string])[] = resolved.baseUrl !== ''
      ? [['ANTHROPIC_API_KEY', resolved.apiKey], ['ANTHROPIC_AUTH_TOKEN', resolved.apiKey], ['ANTHROPIC_BASE_URL', resolved.baseUrl]]
      : [['ANTHROPIC_API_KEY', resolved.apiKey], ['ANTHROPIC_AUTH_TOKEN', resolved.apiKey]];
    for (const [k, v] of vars) {
      void tmux.exec(['set-environment', '-g', k, v]).then((r) => {
        if (!r.ok) log.info(`[ai] tmux set-environment ${k} 跳过（${r.error.message}）——引擎 env 继承兜底`);
      });
    }
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
  const artifactLedger = createArtifactLedger(store.db, backend);
  const caseInboxDir = (workflowId: string): string => join(dataDir, 'case-inbox', workflowId);

  // ---- ACP 同步执行器（协议级完成；优先于 tmux 异步路径）----
  const acpKey = resolveSecret({
    envValue: process.env['JULI_ACP_API_KEY'] ?? process.env['MAKRO_ACP_API_KEY'] ?? process.env['GLM_API_KEY'],
    configured: config.secrets.acp_api_key,
  });
  const acp = config.acp.enabled
    ? createAcpExecutor({
      command: config.acp.command.split(/\s+/).filter(Boolean),
      model: config.acp.model,
      apiKey: acpKey,
      env: process.env, // 子进程解析可执行文件与 JULI_ACP_CWD 都从这里读
      log: (m) => log.info(m),
    })
    : null;

  // ---- 推送注册表（runtime.ts 持有文件与读写；业务侧消费见 wireBusiness）----
  const tokensFile = join(dataDir, 'device_tokens.json');
  const deviceTokens = (): readonly string[] => {
    try {
      const v = JSON.parse(readFileSync(tokensFile, 'utf8')) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  const saveDeviceTokens = (tokens: readonly string[]): void => {
    writeFileSync(tokensFile, JSON.stringify(tokens), { mode: 0o600 });
  };
  // ---- 业务装配分册（APNs/Bark 推送真实现、反馈墙/客户库/CRM/Party 目录）
  // ----：全部私仓扩展位，装配体在 runtime.business.ts（公开投影=同形桩）。----
  const business = wireBusiness({ config, dataDir, store, backend, log, deviceTokens, saveDeviceTokens });
  // 自动批准现行配置（Settings 热改键 auto_approve 的内存落点——sweep 每
  // 轮现读这里，规则改动下轮即生效，无需重启）。
  let autoApproveCfg: AutoApproveConfig = projectAutoApprove(config.auto_approve);
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
    mailSource = createMailSource({
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
      channelAuthz: compileChannelPolicy(config.email_authz_allow, config.email_authz_deny),
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
    tmux: tmux!,
    file: snapshotFile,
    log: (m: string) => log.info(m),
  };
  const healer: SessionHealer = {
    async healSession(session) {
      if (!tmux) return false;
      const snap = takeSnapshot;
      void snap;
      const n = await recoverFromSnapshot({ ...snapshotDeps }).catch(() => 0);
      return n >= 0 && (await tmux.hasSession(session));
    },
  };
  if (orchestrator !== null) {
    // 派发门：通话激活时拦截派发类工具（hooks 铁腕位）。
    orchestrator.hooks.on('before_tool_call', (p) =>
      voiceGateHook(voiceCallActive, voiceCallMode)(p as never) as never);
  }

  // ---- 未来渠道挂载点：teams/slack/feishu 适配器在此追加 ----
  const extraChannels: InboundChannel[] = [];

  // ---- 模板注册表 ----
  const tplDir = pipelinesDir(dataDir);
  let loaded = loadTemplates(tplDir);
  const registry: Record<string, Template> = { ...loaded.templates };

  const router = tmux && config.email.default_session !== ''
    ? createSessionRouter({
      listSync: () => tmuxListSync(config.tmux_socket_path || undefined),
      defaultSession: config.email.default_session, log: (m) => log.info(m),
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
  gradeAlert = async (title, body) => {
    const outcome = await judgmentGateway.ask('alert_grade',
      { title, body: body.slice(0, 300) },
      {
        severity: {
          type: 'choice',
          instructions: 'Grade this system alert for an operator: critical needs immediate action, warning should be seen soon, info is routine noise.',
          criteria: {
            critical: 'Failure/stuck/loss of customer-facing capability — act now.',
            warning: 'Degraded but self-healing or bounded — check soon.',
            info: 'Routine/status noise — no action needed.',
          },
        },
      });
    if (outcome === null) return true;
    store.appendEvent('judgment', `alert_grade:${title.slice(0, 24)}`, 'judgment_made', {
      scenario: 'alert_grade', mode: outcome.mode, provider: outcome.provider,
      ok: outcome.ok === true, answer: outcome.answer ?? '', confidence: outcome.confidence ?? 0,
      threshold: outcome.threshold, error: outcome.error ?? '',
      model: outcome.model ?? '', input_tokens: outcome.inputTokens ?? 0,
      output_tokens: outcome.outputTokens ?? 0, duration_ms: outcome.durationMs ?? 0,
    });
    if (outcome.mode === 'on' && outcome.ok && outcome.answer === 'info'
        && (outcome.confidence ?? 0) >= outcome.threshold) {
      log.info(`[judgment] alert_grade 降噪：${title}（info@${(outcome.confidence ?? 0).toFixed(2)}）`);
      return false;
    }
    return true;
  };

  // ---- 路由装配（0930「所有的都走路由」）：引擎进件与任务路由（routeTask）
  // 共用同一份 routing 视图 + 忙闲谓词（sessionHasOpenWork 新定义：排队/在跑
  // /等批准都算忙）——两个入口一个家，input 层不重复装配。----
  const taskRouting = {
    defaultSession: config.email.default_session,
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

  const engine = createEngine({
    usage: (r) => usage.record(r),
    store,
    llm,
    model: ai.model,
    queueConcurrency: config.queue?.concurrency,
    workHours: config.work_hours,
    partyDirectory: business.party,
    partyAutoCreate: config.party.auto_create,
    routing: taskRouting,
    dispatch,
    syncDispatch: acp ? { dispatchSync: acp.dispatchSync } : null,
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
    // 中断：ACP 在途 turn 优先，tmux C-c 兜底。
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
    interruptSession: acp
      ? async (session) => {
        const res = await acp.interrupt(session).catch(() => ({ ok: false } as const));
        if (res.ok) return true;
        if (tmux) return (await tmux.interrupt(session)).ok;
        return false;
      }
      : tmux
        ? async (session) => (await tmux.interrupt(session)).ok
        : null,
    rebuildAgent: null,
    templates: registry,
    authz: {
      mode: config.email_authz_mode ?? 'allowlist',
      allow: config.email_authz_allow,
      deny: config.email_authz_deny,
    },
    log,
  });

  // ---- 开单对话（09-29）：clarify loop → 用户确认 → startTask 正门开单。
  // 工具白名单只读（chatTools.ts 封闭清单），对话 transcript 不进账。----
  let chatIntake: ChatIntake | null = null;
  if (llm !== null) {
    const terminalStatuses = new Set(
      WORKFLOW_STATUSES.filter((s) => s.terminal).map((s) => s.key as string),
    );
    chatIntake = createChatIntake({
      llm: makeChatLlm(),
      model: ai.model,
      tools: makeChatTools({
        lookupCustomer: business.lookupCustomer,
        listTasks: (scope, limit) => store.listWorkflows(scope === 'inflight' ? 50 : limit)
          .filter((w) => scope !== 'inflight' || !terminalStatuses.has(w.status))
          .slice(0, limit)
          .map((w) => ({ id: w.id, title: w.title, status: w.status, updatedAt: w.updatedAt })),
        // 单子全息（2026-10-07 白名单扩容）：costContextOf 同口径归属——
        // 与详情 usageCost/cost-stats/统计归属率四方同源，防口径漂移。
        getTask: async (wfId) => {
          const w = store.getWorkflow(wfId);
          if (!w) return null;
          const steps = store.stepsForWorkflow(w.id);
          // 计费时点修复（wf_be61c3a55842）：全量 steps + 最后活动时刻——
          // approve 后回流执行段并入计费窗口。
          const ctx = costContextOf(w, steps, store.lastEventAt('workflow', w.id));
          let prompts = 0;
          for (const sess of ctx.sessions) prompts += usage.perSessionWindows(sess, ctx.effWindows).count;
          const priced = usage.sessionWindowsPriced(ctx.sessions, ctx.effWindows);
          // 无价目纪律（b5148a9 同款）：纯无价目单成本未知≠0，出 null 不猜价。
          const costCny = priced.unpricedModels.length > 0 && priced.totalCny.total <= 0
            ? null : Math.round(priced.totalCny.total * 100) / 100;
          const waiting = steps.find((st) => st.status === 'waiting_human');
          return {
            id: w.id, title: w.title, status: w.status, kind: w.kind,
            createdAt: w.createdAt, updatedAt: w.updatedAt, session: w.session ?? '',
            steps: steps.map((st) => ({ seq: st.seq, kind: st.kind, title: st.title, status: st.status, updatedAt: st.updatedAt })),
            waitingOn: waiting !== undefined ? waiting.title : '',
            deliverables: artifactLedger.list(w.id).map((a) => ({ name: a.name, role: a.role })),
            prompts, costCny,
          };
        },
        // 会话清单：声明表 × 在办分布（在办=非终态，含排队/闸门，0930 忙闲口径）。
        listSessions: () => {
          const inflight = new Map<string, number>();
          for (const w of store.listWorkflows(200)) {
            if (terminalStatuses.has(w.status)) continue;
            const assigned = typeof w.meta?.['assigned_session'] === 'string' ? (w.meta['assigned_session'] as string) : '';
            for (const sess of [w.session ?? '', assigned]) {
              if (sess !== '') inflight.set(sess, (inflight.get(sess) ?? 0) + 1);
            }
          }
          return routeTaskMenu(taskRouting).map((a) => ({
            session: a.session, company: a.company, domain: a.domain,
            description: a.description ?? '', inflight: inflight.get(a.session) ?? 0,
          }));
        },
        // 服务自信息：全部非敏感只读面（版本/模型/端口/单量/今日用量/hold）。
        serviceInfo: () => {
          const all = store.listWorkflows(5000);
          const midnight = new Date();
          midnight.setHours(0, 0, 0, 0);
          const todayStart = midnight.toISOString();
          const todayRow = usage.byLocalDay(1).at(-1);
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
            todayTokens: {
              input: todayRow?.inputTokens ?? 0, output: todayRow?.outputTokens ?? 0, calls: todayRow?.calls ?? 0,
            },
            heldTasks: engine.queueStatus().held.length,
          };
        },
      }),
      startTask: async (title, brief, session, autoApprove) => {
        try {
          const w = await engine.startTask(title, {
            brief,
            ...(session !== undefined && session !== '' ? { session } : {}),
            ...(autoApprove === true ? { auto_approve: true } : {}),
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
    });
  }

  // ---- feedback 进件（09-19）：镜像新记录 → startTask 起单（装配体在
  // runtime.business.ts——不走 onInbound 的裁决语义见该文件；公开桩=null）----
  const feedbackIntake = wireFeedbackIntake({ config, store, engine, judgment: judgmentGateway, log });

  // ---- 周期任务 ----
  let timers: NodeJS.Timeout[] = [];
  let imapPollAt: string | null = null;
  // Settings 热改键的内存落点（config 本体冻结——改这里，不改 config）。
  let retentionDays = config.ledger_retention_days;
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

  return {
    config,
    home,
    store,
    engine,
    bus,
    tmux,
    acp,
    artifactLedger,
    artifactBackend: backend,
    artifactSharing: s3 !== null,
    usage,
    orchestrator,
    chatIntake,
    taskRoute,
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

    get authenticator(): Authenticator | null {
      const impls: Authenticator[] = [];
      if (config.password !== '') impls.push(createLocalAuthenticator(config.password));
      if (config.pb_url !== '') impls.push(createPbAuthenticator({ url: config.pb_url, collection: config.pb_collection }));
      return impls.length > 0 ? createCompositeAuthenticator(impls) : null;
    },
    get voiceCall() { return voiceState.call; },
    get channels(): readonly InboundChannel[] {
      return [mailSource, ...extraChannels].filter((c): c is InboundChannel => c !== null);
    },

    emitChat: (type: string, data: string) => chatHub.emit(type, data),
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
      if (!orchestrator || llm === null) return null;
      voiceState.call = createVoiceCall(mode, {
        llm: makeChatLlm(),
        model: ai.model,
        dispatch: async (session, brief) => {
          if (!tmux) return { ok: false, error: new Error('tmux not available') };
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
      writeFileSync(tokensFile, JSON.stringify([...cur, token]), { mode: 0o600 });
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
      if (typeof patch['ledger_retention_days'] === 'number') {
        retentionDays = patch['ledger_retention_days'];
        hotApplied['ledger_retention_days'] = patch['ledger_retention_days'];
        applied.push('ledger_retention_days');
      }
      const aaPatch = patch['auto_approve'];
      if (aaPatch !== undefined) {
        autoApproveCfg = projectAutoApprove(aaPatch);
        hotApplied['auto_approve'] = { mode: autoApproveCfg.mode, rules: autoApproveCfg.rules };
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
      if (isPlainRecord(aiPatch)) {
        // ai 段热改（2026-10-10 开源 MVP）：tmux/进程环境即时重注入（新 agent
        // 会话生效）；引擎自身 LLM 构造是闭包冻结——重启生效。路由侧已先过
        // saveConfigFile 的 zod 校验（不过=文件未动，到不了这里）。
        const fresh = resolveAiConfig({
          ...config,
          ai: { ...config.ai, ...(aiPatch as Partial<Config['ai']>) },
        });
        if (fresh.apiKey !== '') {
          injectAgentEnv(fresh);
          hotApplied['ai.provider'] = fresh.provider;
          if (fresh.baseUrl !== '') hotApplied['ai.base_url'] = fresh.baseUrl;
          if (fresh.model !== '') hotApplied['ai.model'] = fresh.model;
          applied.push('ai（tmux 环境已热注入，新 agent 会话生效；引擎 LLM 重启生效）');
        }
      }
      return { applied };
    },

    runAutoApproveSweep(): Promise<number> {
      return autoApproveSweep({
        store, approve: (id, note, by) => engine.approve(id, note, by),
        config: () => autoApproveCfg, log,
      });
    },

    liveOverrides(): JsonRecord {
      const out: JsonRecord = {};
      for (const [k, v] of Object.entries(hotApplied)) setDotted(out as Record<string, unknown>, k, v);
      return out;
    },

    start() {
      // 统一 ai 段 → agent 执行环境（先于声明会话预热——冷启动会话即吃到注入）。
      injectAgentEnv(ai);
      // 自动批准 boot 即扫：配置已开时，存量在等闸门不等第一个 30s。
      if (autoApproveCfg.mode !== 'off') {
        void autoApproveSweep({ store, approve: (id, note, by) => engine.approve(id, note, by), config: () => autoApproveCfg, log })
          .then((n) => { if (n > 0) log.info(`[auto-approve] boot 扫描处理 ${n} 个闸门`); })
          .catch((e) => log.warn(`[auto-approve] boot 扫描失败：${e instanceof Error ? e.message : String(e)}`));
      }
      // 渠道路由卫兵（2026-09-21 深夜 /site→acme 死规则事故）：悬空规则
      // 每单运行时被复用优先静默兜底，启动时点名让死规则第一分钟可见。
      for (const rule of danglingFeedbackRoutes(config)) {
        log.error(`[config] feedback_routing 死规则：prefix "${rule.prefix}" → 会话 "${rule.session}" 不在 config.agents 声明表，每单将静默落回 ${config.email.default_session}——请声明该会话、改指已有会话或删除规则`);
      }
      engine.reconcileStartup().catch((e) => log.error(`reconcileStartup: ${String(e)}`));
      // 声明会话预热（2026-09-28 用户口令）：重启后按 config.agents 声明表
      // 逐个 provision（幂等——已就绪的会话秒过；缺的按声明 cwd 建会话拉
      // claude）。消灭「重启后 ✗ 全躺、首单吃冷启动」：session:list 立即全绿、
      // 第一张派给任何声明会话的单零冷启动延迟。后台执行不拦启动；单个会话
      // 预热失败只留日志（派发时会再走同一链路自愈）。
      if (provision !== null) {
        void (async () => {
          const names = warmupPlan(config.agents);
          let ok = 0; let fail = 0;
          for (const name of names) {
            const r = await provision('startup-warmup', name, '').catch((e: unknown) => ({
              ok: false as const, error: { message: e instanceof Error ? e.message : String(e) },
            }));
            if (r.ok) ok++;
            else { fail++; log.error(`[warmup] 会话 ${name} 预热失败（不拦启动，派发时自愈）: ${r.error.message}`); }
          }
          log.info(`[warmup] 声明会话预热完成：${ok} 就绪${fail > 0 ? `，${fail} 失败（见上）` : ''}（socket=${config.tmux_socket_path || 'default'}）`);
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
          const res = installClaudeHooks(config.claude_dir, defaultHookSpecs(hookJs, config.password, `http://127.0.0.1:${config.listen_port}`));
          if (res.ok) log.info(`CC hooks 已注入 ${config.claude_dir}/settings.json`);
          else log.error(`CC hooks 注入失败: ${res.error.message}`);
        }
      }
      timers = [
        // 在途对账安全网：丢 hook 的 agent 步 10 分钟宽限后收口。
        setInterval(() => void engine.reconcileInflight().catch(() => undefined), 60_000),
        // hold 放行泵（2026-09-28 工作时间窗）：窗口关闭后把 hold 中的单按
        // 原队序放行——收单台纯事件驱动，没有这条心跳就没人叫醒 hold 单。
        // 自动批准 sweep（2026-10-07）：30s 一轮——新到闸门与存量在等闸门同一条
        // 路径兜住；boot 即扫一次（用户开规则时排队的存量当轮就清）。
        setInterval(() => void autoApproveSweep({
          store, approve: (id, note, by) => engine.approve(id, note, by),
          config: () => autoApproveCfg, log,
        }).catch((e) => log.warn(`[auto-approve] sweep 失败：${e instanceof Error ? e.message : String(e)}`)), 30_000),
        // 定档扫描：到点的定时发送续推（60s 精度足够——定档单位是小时）。
        setInterval(() => void engine.sweepSchedules().catch(() => undefined), 60_000),
        // 回流外发箱：欠款必还（60s 补投 + 卡死告警）。
        setInterval(() => void engine.sweepRelays().catch(() => undefined), 60_000),
        // 已批闸门静默收口（wf_be61c3a55842，2026-10-09）：60s 一轮扫「闸已批
        // +全链终态」的单，双静默（事件链+会话用量行）超 5 分钟即 settle——
        // agent 自 settle 被其会话权限层拦（实测），引擎兜底收口。
        setInterval(() => void engine.autoSettleApprovedRuns().catch(() => undefined), 60_000),
        // 僵尸扫描：30s tick。
        setInterval(() => void engine.sweepZombies().catch(() => undefined), 30_000),
        // CC transcript 摄取：每分钟增量。
        // wf_9658ce9225e0：ingest 的 tmux_session 归属靠 claude_sessions 映射，
        // 而 recordClaudeSession 此前从未接线（映射 0 行→归属恒空→详情页
        // promptStats 恒 0）。这里每轮先按 tmux pane cwd ↔ claude projects
        // 目录名（cwd 的 / → - 转义）自动建映射；存量空归属行自动重放回填。
        setInterval(() => {
          void (async () => {
            try {
              const projects = join(config.claude_dir || join(process.env['HOME'] ?? '', '.claude'), 'projects');
              const det = await tmux.listSessionsDetailed();
              if (det.ok) {
                // 十四跑 R1（P2-2）：scan 只映射「mtime 新于会话存活起点」的
                // transcript——live 会话 cwd 项目目录下的全部 .jsonl 整目录映射
                // 会把人用 CC 同仓的旧 transcript 划给 agent（人机混仓污染）。
                // created 取不到（exec 失败/老 tmux）保守回落旧行为（全映射）。
                const createdOf = new Map<string, number>();
                const cr = await tmux.exec(['list-sessions', '-F', '#{session_name}\t#{session_created}']);
                if (cr.ok) {
                  for (const line of cr.value.split('\n')) {
                    const [nm, ts] = line.split('\t');
                    const t = Number(ts);
                    if (nm && Number.isFinite(t) && t > 0) createdOf.set(nm.trim(), t * 1000);
                  }
                }
                for (const si of det.value) {
                  const cwd = si.path;
                  if (cwd === '') continue;
                  const dir = join(projects, cwd.replaceAll('/', '-'));
                  if (!existsSync(dir)) continue;
                  const bornMs = createdOf.get(si.name);
                  for (const f of readdirSync(dir)) {
                    if (f.endsWith('.jsonl')) {
                      if (bornMs !== undefined) {
                        try {
                          if (statSync(join(dir, f)).mtimeMs <= bornMs) continue; // 会话出生前的旧 transcript 不映射
                        } catch { continue; }
                      }
                      usage.recordClaudeSession(f.replace('.jsonl', ''), si.name, join(dir, f), cwd);
                    }
                  }
                }
              }
              if (usage.needsClaudeReplay()) {
                log.info('[usage] claude_code 归属空行过半——重放 transcript 回填 tmux_session');
                usage.resetClaudeIngest();
              }
              usage.ingestProjectTranscripts(projects);
            } catch { /* 目录缺失容忍 */ }
          })();
        }, 60_000),
        // 账本修剪：retention_days 可被 Settings 热改，定时器常驻、按当前值决定动不动。
        setInterval(() => {
          if (retentionDays <= 0) return;
          try {
            const r = store.prune(retentionDays);
            if (r.events + r.workflows > 0) log.info(`[prune] 清理 ${r.events} 事件 / ${r.workflows} 终态工作流`);
          } catch (e) { log.error(`[prune] ${String(e).slice(0, 100)}`); }
        }, 86_400_000),
        // 业务定时器（feedback 镜像 sweep + villa 运营源 + 财务备份巡检）：
        // 装配体在 runtime.business.ts（公开桩=空集，零业务定时器）。
        ...startBusinessTimers({
          config, store, engine, feedbackIntake, mailer,
          recipients: () => ({ to: notifyTo, cc: notifyCc }),
          log,
        }),
      ];
      log.info(`juli-service 已启动：data_dir=${dataDir} templates=${Object.keys(registry).length}`);
    },

    attachWs(server: import('node:http').Server): void {
      attachChatWireWs({ server, chatHub, password: config.password, log: (m) => log.info(m) });
      if (!tmux) return;
      attachPtyHub({
        server, tmux, password: config.password,
        boundSessions: config.email.bound_agents.map((b) => b.session),
        log: (m) => log.info(m),
      });
      attachSnapshotWireWs({ server, tmux, password: config.password, log: (m) => log.info(m) });
      log.info('[ws] PTY 桥已挂载（/ws/xterm/{session}）+ 快照流（/ws/snapshot/{session}）');
    },

    stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
      mailSource?.stop();
    },
  };
};
