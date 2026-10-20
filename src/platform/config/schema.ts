// 配置模式（对应 Go internal/infra/config 的核心面）。文件为
// ~/.juli-service/config.json；环境变量恒覆盖文件（部署友好）。密钥值可为
// 字面量或 `keychain:<service>` 引用，加载期解析；密码类优先取环境变量。

import { execSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { createReadFile } from '../shared/fsutil.ts';

const authzModeSchema = z.enum(['allowlist', 'open']);

export const configSchema = z.object({
  llm_provider: z.enum(['anthropic', 'openai']).default('anthropic'),
  llm_model: z.string().default(''),
  llm_base_url: z.string().default(''),

  // 统一 AI 段（2026-10-10 开源 MVP）：一处配置两处用——引擎自身 LLM
  // （orchestrator / chat-intake / voice / engine 记账）与 agent 执行环境
  // （tmux 会话里 claude 的 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL 注入）
  // 同源。字段留空 = 回退旧散键（llm_provider / llm_model / llm_base_url /
  // secrets.llm_api_key），存量部署零迁移。base_url 填 Anthropic 兼容端点
  // （GLM 等）即走代理；留空 = 官方 api.anthropic.com。
  ai: z
    .object({
      provider: z.enum(['', 'anthropic', 'openai']).default(''),
      api_key: z.string().default(''),
      base_url: z.string().default(''),
      model: z.string().default(''),
    })
    .default({}),
  tmux_mode: z.enum(['auto', 'dedicated', 'shared']).default('auto'),
  tmux_socket_path: z.string().default(''),
  claude_dir: z.string().default(''),
  data_dir: z.string().default(''),
  listen_host: z.string().default('127.0.0.1'),
  listen_port: z.number().int().default(7070),
  password: z.string().default(''),
  email_enabled: z.boolean().optional(),

  // 全局邮件触发授权（生效键在 config 顶层——email 嵌套段是遗留不读）。
  email_authz_mode: authzModeSchema.optional(),
  email_authz_allow: z.array(z.string()).default([]),
  email_authz_deny: z.array(z.string()).default([]),

  // agents 全量声明（板C：图的唯一结构源——bound_agents 只是它的绑定段，
  // 2026-09-20 升格）。company/domain 是组织树两个维度；未声明的会话在
  // mesh 里落「未归属」虚线区（进图先声明，数据驱动，视图零自有状态）。
  // 命名 schema（2026-10-12 用户裁定 more structure）：{org}-{role}[-{aspect}]
  // [-{tier}]，org=归属主体（juli 自家/客户名），role=职能（reply/dev/eng/
  // accounting/web/research），aspect=多主题限定（cases/products/…），tier=
  // 档位后缀。org/role 语义属约定不可机检，以下三条硬规则 zod 把关（loadConfig
  // 与 saveConfigFile（PUT /api/settings 热注入）同一 parse 口，启动/热注入同
  // 语义）：① 全名 kebab 小写
  // （tmux 名安全）；② 后缀 -hi ⟺ model_tier=high（standard 永无后缀）；③
  // -hi 孪生的基名（去后缀）必须在声明表内——升档改道落的是孪生会话，基名
  // 缺席=改道目标凭空消失。
  agents: z
    .array(
      z.object({
        session: z.string(),
        company: z.string().default(''),
        domain: z.string().default(''),
        senders: z.array(z.string()).default([]),
        cwd: z.string().default(''),
        // 一句话业务描述（0922 routing 判定菜单用）：jev 分类只看声明时，
        // company/domain 两词太瘦——这句话是判定质量的杠杆，属数据非结构。
        description: z.string().default(''),
        // 模型档位（2026-09-28「非必要不高智能」）：high=冷启动引导带
        // --model 高档 id；standard=默认。路由改道规则见 lifecycle startTask。
        model_tier: z.enum(['standard', 'high']).default('standard'),
      }),
    )
    .superRefine((decls, ctx) => {
      const names = new Set(decls.map((a) => a.session));
      for (const [i, a] of decls.entries()) {
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a.session)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'session'],
            message: `agent 会话名 "${a.session}" 不合命名 schema：须 kebab 小写 {org}-{role}[-{aspect}][-{tier}]`,
          });
          continue;
        }
        const hi = a.session.split('-').at(-1) === 'hi';
        if (hi !== (a.model_tier === 'high')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'session'],
            message: hi
              ? `agent 会话名 "${a.session}" 带 -hi 后缀但 model_tier 非 high（后缀 ⟺ 档位，二选一改齐）`
              : `agent "${a.session}" model_tier=high 但会话名不带 -hi 后缀（升档孪生命名 = 基名 + "-hi"）`,
          });
        }
        if (hi && !names.has(a.session.slice(0, -3))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'session'],
            message: `agent 会话名 "${a.session}" 的孪生基名 "${a.session.slice(0, -3)}" 不在声明表——改道目标必须成对声明`,
          });
        }
      }
    })
    .default([]),

  // 模型两档声明（2026-09-28）：模型 id（CC 透传给 GLM anthropic 兼容端），
  // 引擎在冷启动引导时拼 `claude --model '<id>'`。空串=该档不引导（裸
  // claude）；未配 models 整体=两档都不引导（历史行为，存量会话不受影响）。
  models: z
    .object({
      standard: z.string().default(''),
      high: z.string().default(''),
    })
    .default({}),

  // CRM（PocketBase，只读投影，自部署可选项）。url 指向实例地址
  // （例 127.0.0.1:8091）；admin_pass 可为
  // 字面量或 keychain:<svc> 引用。
  crm: z
    .object({
      enabled: z.boolean().default(false),
      url: z.string().default(''),
      admin_email: z.string().default(''),
      admin_pass: z.string().default(''),
    })
    .default({}),

  // Party（当事人，第三期）：身份在 CRM（Twenty），juli 只存引用不建档。
  // twenty_url 指向 Twenty REST 根（如 http://127.0.0.1:8091）；api_key 为
  // Twenty API Key（env JULI_TWENTY_API_KEY 优先）。auto_create 开了才为陌生
  // 外部地址顺路建 contact（先查再建，幂等）——默认关：juli 不擅自建客户档案。
  party: z
    .object({
      enabled: z.boolean().default(false),
      twenty_url: z.string().default(''),
      api_key: z.string().default(''),
      auto_create: z.boolean().default(false),
    })
    .default({}),

  // 收单台（0920 定案）：机器执行串行准入——占队位的是「机器在干活」，
  // 人工闸门等待不占位。concurrency=1 即一次只跑一张单的机器链。
  queue: z
    .object({
      concurrency: z.number().int().min(1).max(16).default(1),
    })
    .default({}),

  // TLS（iOS App 兼容）：启用后额外开 tls_port 服务 HTTPS（自签证书自动
  // 生成，App 端 TOFU 钉扎公钥）；listen_port 恒为明文——本地/LAN 习惯不变，
  // 公网入口（frp）指向 tls_port。平铺键：env JULI_TLS_ENABLED / JULI_TLS_PORT。
  tls_enabled: z.boolean().default(false),
  tls_port: z.number().int().optional(),
  /** 受信证书（mkcert 等）：iPhone/中转隧道免重配的 TLS 面。缺省回退自签。 */
  tls_cert_path: z.string().default(''),
  tls_key_path: z.string().default(''),

  email: z
    .object({
      enabled: z.boolean().default(false),
      host: z.string().default(''),
      username: z.string().default(''),
      mailbox: z.string().default('INBOX'),
      poll_interval_sec: z.number().int().positive().default(60),
      timeout_sec: z.number().int().default(30),
      default_session: z.string().default(''),
      default_project: z.string().default(''),
      authz_allow: z.array(z.string()).default([]),
      authz_deny: z.array(z.string()).default([]),
      // 绑定会话（专用 agent 隔离）：白名单发件人的邮件→钉死指定会话；
      // 会话不存在时按 cwd 自建（复用优先落回对绑定会话豁免）；其余通道
      // （web/CLI/agent 步钉）被引擎 session_bound 守卫拒派。
      bound_agents: z
        .array(
          z.object({
            session: z.string(),
            cwd: z.string().default(''),
            senders: z.array(z.string()).default([]),
          }),
        )
        .default([]),
      // 开发/测试注入口（POST /api/email/simulate）生产收紧（2026-09-20 P1）：
      // 默认关——持 token 的调用方可伪造任意白名单发件人从「邮件口」进件，
      // 绕过 IMAP 直达 startEmailWorkflow。测试/本机调试显式开。
      simulate_enabled: z.boolean().default(false),
    })
    .default({}),

  smtp: z
    .object({
      host: z.string().default(''),
      port: z.number().int().default(465),
      username: z.string().default(''),
      from: z.string().default(''),
    })
    .default({}),

  apns: z
    .object({
      key_path: z.string().default(''),
      key_id: z.string().default(''),
      team_id: z.string().default(''),
      bundle_id: z.string().default(''),
      sandbox: z.boolean().default(false),
    })
    .default({}),

  bark_key: z.string().default(''),
  bark_url: z.string().default('https://api.day.app'),

  // 邮件通知：五事件（闸门/完成/失败/链尾悬空/步骤失败）全量进邮箱，
  // 复用回信 SMTP 通道。to/cc 热改生效；base_url 只用于拼跳转深链。
  // ⚠ 自回环断根（2026-09-21）：to/cc 若配成被轮询的邮箱自身（email.username），
  // 该收件人在发信前被剔除、全中则整封不发（push/email.ts 守卫）——发给
  // 自己的信必然落回被轮询的 INBOX。告警请走设备推送/站内 SSE，或配一个
  // 不同于轮询账号的收件地址。
  notify: z
    .object({
      to: z.array(z.string()).default([]),
      cc: z.array(z.string()).default([]),
      base_url: z.string().default(''),
    })
    .default({}),

  acp: z
    .object({
      enabled: z.boolean().default(false),
      command: z.string().default('codex app-server'),
      model: z.string().default(''),
    })
    .default({}),

  // 财务备份巡检（自部署可选项，默认关）：
  // ssh 单发 aliyun oss ls 核对最新 bundle 年龄，过期邮件告警（每 episode 一封防重）。
  // 默认关：部署处显式开启。
  finance_backup_check: z
    .object({
      enabled: z.boolean().default(false),
      ssh_host: z.string().default('julia'),
      oss_prefix: z.string().default(''),
      max_age_hours: z.number().int().default(36),
    })
    .default({}),

  secrets: z
    .object({
      llm_api_key: z.string().default(''),
      acp_api_key: z.string().default(''),
      s3_secret_key: z.string().default(''),
      email_password: z.string().default(''),
      smtp_password: z.string().default(''),
    })
    .default({}),

  s3: z
    .object({
      endpoint: z.string().default(''),
      region: z.string().default('auto'),
      bucket: z.string().default(''),
      access_key_id: z.string().default(''),
      path_style: z.boolean().default(true),
      presign_ttl: z.number().int().default(3600),
      // 公网分享域(CNAME 指向桶):OSS V1 出链改写域名,
      // 收件人拿到的是分享域形态而非 .aliyuncs.com 端点。空=不改写。
      share_domain: z.string().default(''),
    })
    .default({}),

  // 路由兜底落点（2026-10-16 从 email.default_session 搬家升顶）：所有进件
  // 渠道（chat/feedback/email/villa）路由判定链的最后一腿。default session 是
  // 路由域概念，email 是第一个进件渠道的历史包袱——概念升级后键没搬家，
  // 造成「chat 开单却读邮件键」的错位（演示实例派发秒败事故）。email 段同名
  // 键降级为 legacy 回退（见 effectiveDefaultSession），存量部署零迁移。
  default_session: z.string().default(''),

  // feedback 渠道路由声明（2026-09-21）：页面前缀 → 会话。确定性匹配，无 LLM；
  // 无命中回落 default_session（「永远兜底」→「缺路由键才兜底」）。
  feedback_routing: z
    .object({
      rules: z
        .array(
          z.object({
            prefix: z.string(),
            session: z.string(),
          }),
        )
        .default([]),
    })
    .default({ rules: [] }),

  // 渠道声明（2026-09-28 用户需求①）：渠道=客户/站点的进件投影，一等登记面。
  // 反馈镜像的 source 键与这里对齐（缺省 'acme'）；官网渠道未就绪——声明位
  // 先立（enabled:false），channel 实现接入时只加实现类+改声明，零 schema 变更。
  channels: z
    .object({
      declared: z
        .array(
          z.object({
            id: z.string(), // 渠道键（feedback 渠道=镜像 source；官网渠道预留 id 如 official-site）
            kind: z.enum(['feedback', 'email', 'web', 'custom']).default('feedback'),
            label: z.string().default(''), // 人读名（批量单标题用）
            enabled: z.boolean().default(true),
            session: z.string().default(''), // 渠道默认路由（空=走全局兜底链）
            // 同渠道攒批：一段时间的 feedback 聚合成一条 Message（一次 flush
            // 一单携 N 引用）——「客户从一个渠道过来就是针对这个 site 的」。
            aggregate: z.boolean().default(false),
            // 紧急直通（零 token 规则判，不靠 LLM）：命中即 priority=high，
            // hold 窗口内也立即处理（「除非很紧急的，安排在这个时间处理」）。
            priority_keywords: z.array(z.string()).default([]), // body 子串（大小写不敏感）
            priority_senders: z.array(z.string()).default([]), // 提交人/发件人精确匹配
          }),
        )
        .default([]),
    })
    .default({ declared: [] }),

  // 工作时间窗 hold（2026-09-28 用户需求③）：北京时间高价时段（默认
  // 14:00–17:00）非 high 任务 hold——hold 在判定/派发之前，进件落账零 token，
  // 攒到窗口关闭后 flush。scope=feedback（v1 默认，只圈 feedback 进件单，
  // 客户对话邮件时效性不同）| all（全队列）。mode=shadow 只记不做（影子期）。
  work_hours: z
    .object({
      mode: z.enum(['off', 'shadow', 'on']).default('off'),
      start: z.string().default('14:00'),
      end: z.string().default('17:00'),
      timezone: z.string().default('Asia/Shanghai'),
      scope: z.enum(['feedback', 'all']).default('feedback'),
      // 同渠道聚合 flush 节流（分钟）：mirror 高频 sweep 下没有它就是
      // 「每 sweep 一张批量单」。窗口关闭后的第一次 sweep 执行 flush。
      aggregate_throttle_min: z.number().int().default(120),
    })
    .default({}),

  // 闸门自动批准（2026-10-07 用户裁定「有的 workflow 不需要我干预/批准」）：
  // 规则匹配 → 复用 approve 正门（by='juli-auto' 全审计留痕）。mode 三态
  // 照 hold/alert_grade 惯例：off=关（默认）/shadow=只留痕不动作/on=真批。
  // 两条硬安全边界在 autoApprove 模块内钉死：问询闸门永不自动批；发送闸门
  // （delivery=email，真实外发）须规则显式 include_send 才在自动面内。
  auto_approve: z
    .object({
      mode: z.enum(['off', 'shadow', 'on']).default('off'),
      rules: z.array(z.object({
        id: z.string().default(''),
        /** 匹配 workflow.kind（如 adhoc/email/feedback）。 */
        kind: z.string().optional(),
        /** 匹配归属会话（声明/落点名，如 juli-dev）。 */
        session: z.string().optional(),
        /** 只匹配内部单（无外部发件人 meta.from）。 */
        internal: z.boolean().optional(),
        /** 标题包含（子串，大小写不敏感）。 */
        title_contains: z.string().optional(),
        /** 本规则可自动批发送闸门（默认 false——外发邮件须显式授权）。 */
        include_send: z.boolean().default(false),
      })).default([]),
    })
    .default({}),

  // 发送者→客户映射（2026-09-28 用户需求②预留）：一个客户一个邮箱。运行时
  // 事实源=partyDirectory（Twenty CRM，engine party 段已接线）；此处是静态
  // 兜底面——CRM 未登记/不可达时的身份注记入口。entity-model Party 一等实体
  // 落地时接管（治理面已有立项），本段届时退役并入。
  parties: z
    .array(
      z.object({
        email: z.string(),
        customer: z.string(),
        note: z.string().default(''),
      }),
    )
    .default([]),
  ledger_retention_days: z.number().int().default(0),
  pb_url: z.string().default(''),
  pb_collection: z.string().default('users'),
  high_cost_models: z.array(z.string()).default([]),
});

export type Config = Readonly<z.infer<typeof configSchema>>;

/** 路由兜底落点的单一取值点（2026-10-16 搬家）：顶层 default_session 为正位，
 * email.default_session 为 legacy 回退（保住存量部署零迁移）。runtime 装配与
 * boot 断言都吃这里，禁止各处自行读 email 键。legacy=true 供 boot 提示迁移。 */
export const effectiveDefaultSession = (
  config: Pick<Config, 'default_session' | 'email'>,
): { session: string; legacy: boolean } =>
  config.default_session !== ''
    ? { session: config.default_session, legacy: false }
    : { session: config.email.default_session, legacy: config.email.default_session !== '' };

/** 环境取值器（envOverrides 与 resolveAiConfig 共用同一语义）：按名序取
 *  首个命中，undefined 与空串均作未设（部署 env 清键 = 留空常见形态）。 */
const envGetter = (
  env: Readonly<Record<string, string | undefined>>,
): ((...names: string[]) => string | undefined) =>
  (...names) => {
    for (const n of names) {
      const v = env[n];
      if (v !== undefined && v !== '') return v;
    }
    return undefined;
  };

/** 环境变量覆盖表：JULI_* 优先，MAKRO_* 兜底（迁移期双认）。 */
const envOverrides = (env: Readonly<Record<string, string | undefined>>): Partial<Record<string, unknown>> => {
  const get = envGetter(env);
  const list = (v: string | undefined): readonly string[] | undefined =>
    v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean);
  const port = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));
  const flag = (v: string | undefined): boolean | undefined => (v === undefined ? undefined : v === 'true');
  return {
    llm_provider: get('JULI_LLM_PROVIDER', 'MAKRO_LLM_PROVIDER'),
    llm_model: get('JULI_LLM_MODEL', 'MAKRO_LLM_MODEL'),
    llm_base_url: get('JULI_LLM_BASE_URL', 'MAKRO_LLM_BASE_URL'),
    data_dir: get('JULI_DATA_DIR', 'MAKRO_DATA_DIR'),
    listen_host: get('JULI_LISTEN_HOST'),
    listen_port: port(get('JULI_LISTEN_PORT', 'PORT')),
    password: get('JULI_PASSWORD', 'MAKRO_PASSWORD'),
    email_enabled: flag(get('JULI_EMAIL_ENABLED', 'MAKRO_EMAIL_ENABLED')),
    email_authz_mode: get('JULI_EMAIL_AUTHZ_MODE', 'MAKRO_EMAIL_AUTHZ_MODE'),
    email_authz_allow: list(get('JULI_EMAIL_AUTHZ_ALLOW', 'MAKRO_EMAIL_AUTHZ_ALLOW')),
    email_authz_deny: list(get('JULI_EMAIL_AUTHZ_DENY', 'MAKRO_EMAIL_AUTHZ_DENY')),
    tls_enabled: flag(get('JULI_TLS_ENABLED')),
    tls_port: port(get('JULI_TLS_PORT')),
  };
};

interface LoadConfigDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly readFile?: (path: string) => string | null;
}

export const defaultDataDir = (home: string): string => `${home}/.juli-service`;

/** config.json 磁盘路径（与 loadConfig 同源——读写必须打同一个文件）。
 * JULI_DATA_DIR 显式置位时（docker/容器形态）配置文件跟随数据卷——否则
 * 容器重建即丢配置。env 未设 = 本机形态 ~/.juli-service/config.json 不变。 */
export const configFilePath = (home: string, dataDirEnv?: string): string =>
  dataDirEnv !== undefined && dataDirEnv !== ''
    ? `${dataDirEnv.replace(/\/+$/, '')}/config.json`
    : `${defaultDataDir(home)}/config.json`;

/** 渠道路由卫兵（2026-09-21 深夜 /site→acme 死规则事故）：返回目标会话
 * 不在 agents 声明表的 feedback 路由规则。悬空规则每单运行时被复用优先
 * 静默兜底（只有 route_fallback 事件知道），zombie 看门狗还会盯着这个
 * 不存在的会话误判僵尸——启动时点名，让死规则在第一分钟可见。 */
export const danglingFeedbackRoutes = (
  config: Config,
): readonly { readonly prefix: string; readonly session: string }[] => {
  const declared = new Set(config.agents.map((a) => a.session));
  return (config.feedback_routing?.rules ?? []).filter((r) => !declared.has(r.session));
};

/** 敏感值掩码哨兵：GET 出来的形态；PUT 里出现即剔除，绝不落盘。 */
export const SECRET_SENTINEL = '__MASKED__';

/** 敏感键（点路径）：字面量掩码；`keychain:<svc>` 是指针不是秘密，保持可见。
 * s3.access_key_id 同掩码（2026-09-22 信任修复）：云厂商 AK 半公开也不是
 * 明文摆设置页的理由——LTAI 前缀直指阿里云主账号身份。 */
const SECRET_PATHS: readonly string[] = [
  'password',
  'ai.api_key',
  'secrets.llm_api_key', 'secrets.acp_api_key', 'secrets.s3_secret_key',
  'secrets.email_password', 'secrets.smtp_password',
  'crm.admin_pass', 'party.api_key', 'bark_key', 's3.access_key_id',
];

const isSecretPath = (path: string): boolean => SECRET_PATHS.includes(path);

/** 深拷贝并把敏感字面量换成哨兵（空串保持空串——「没配」不是秘密）。 */
export const maskConfig = (config: unknown): Record<string, unknown> => {
  const walk = (node: unknown, path: string): unknown => {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return [...node]; // 数组也拷贝——返回值与入参零共享
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const p = path === '' ? k : `${path}.${k}`;
      if (typeof v === 'string' && isSecretPath(p) && v !== '' && !v.startsWith('keychain:')) {
        out[k] = SECRET_SENTINEL;
      } else {
        out[k] = walk(v, p);
      }
    }
    return out;
  };
  return walk(config, '') as Record<string, unknown>;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** 深合并 patch → 目标；哨兵值剔除；数组整体替换；返回新对象不碰入参。 */
export const mergeConfigPatch = (
  current: unknown,
  patch: unknown,
): Record<string, unknown> => {
  const merge = (base: unknown, over: unknown): unknown => {
    if (!isPlainObject(over)) return over;
    // base 缺席/非对象（段首建）也照走剔哨兵分支——嵌套哨兵绝不透传落盘。
    const b = isPlainObject(base) ? base : {};
    const out: Record<string, unknown> = { ...b };
    for (const [k, v] of Object.entries(over)) {
      if (v === SECRET_SENTINEL) continue; // 掩码回写保护
      out[k] = merge(b[k], v);
    }
    return out;
  };
  return merge(current, patch) as Record<string, unknown>;
};

interface SaveConfigDeps {
  readonly home: string;
  /** JULI_DATA_DIR 置位形态（docker）：配置写进数据卷。 */
  readonly dataDir?: string;
  readonly readFile?: (path: string) => string | null;
  readonly writeFile?: (path: string, content: string) => void;
}

type SaveConfigResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** 写回 config.json：读现有文件 → 深合并 patch（哨兵剔除）→ zod 校验 → 原子落盘。
 *  校验不过 = 文件一个字节不动。落盘写 merged 而非 parse 结果——不物化默认值、
 *  不剔除文件里的未知键（zod 只做守门；真实值恰为哨兵的极端情形被丢弃，可接受）。 */
export const saveConfigFile = (deps: SaveConfigDeps, patch: unknown): SaveConfigResult => {
  const path = configFilePath(deps.home, deps.dataDir);
  const read = deps.readFile ?? createReadFile();
  let current: unknown = {};
  const raw = read(path);
  if (raw !== null) {
    try {
      current = JSON.parse(raw);
    } catch {
      return { ok: false, error: '现有 config.json 不是合法 JSON——请先手工修复再改配置' };
    }
  }
  const merged = mergeConfigPatch(current, patch);
  try {
    configSchema.parse(merged);
  } catch (e) {
    const msg = e instanceof z.ZodError
      ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      : String(e);
    return { ok: false, error: `配置校验失败（文件未动）: ${msg}` };
  }
  // 原子写：tmp + rename——半截 JSON 不会让下次启动即崩；rename 让 0600 恒生效。
  const write = deps.writeFile ?? ((p, content) => {
    mkdirSync(dirname(p), { recursive: true }); // 首次播种：~/.juli-service 可能还不存在
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, p);
  });
  try {
    write(path, `${JSON.stringify(merged, null, 2)}\n`);
  } catch (e) {
    return { ok: false, error: `写入失败: ${String(e)}` };
  }
  return { ok: true };
};

/** 纯加载：读文件（缺省容忍）→ zod 校验 → 环境覆盖 → 冻结。 */
export const loadConfig = (deps: LoadConfigDeps): Config => {
  // 默认真读磁盘（注入仅测试用）——冒烟抓过"默认空读导致 config.json 被忽略"。
  const read = deps.readFile ?? createReadFile();
  // 双认空串作未设（|| 而非 ??）：与 envOverrides get / 写侧落盘定位同语义，
  // JULI=''×MAKRO 设时读写不打同一个文件就是分家。
  const path = configFilePath(deps.home, deps.env['JULI_DATA_DIR'] || deps.env['MAKRO_DATA_DIR']);
  const raw = read(path);
  const parsed = configSchema.parse(raw ? JSON.parse(raw) : {});
  // 只应用真正存在的覆盖项——显式 undefined 绝不许抹掉文件值。
  const merged: Record<string, unknown> = { ...parsed };
  for (const [k, v] of Object.entries(envOverrides(deps.env))) {
    if (v !== undefined) merged[k] = v;
  }
  if (merged['data_dir'] === '' || merged['data_dir'] === undefined) {
    merged['data_dir'] = defaultDataDir(deps.home);
  }
  return Object.freeze(merged) as unknown as Config;
};

/** 密钥解析：环境变量 > secrets 配置；`keychain:<svc>` 经 macOS security CLI。 */
export const resolveSecret = (
  spec: { readonly envValue?: string; readonly configured: string },
  deps: { readonly run?: (cmd: string) => string | null } = {},
): string => {
  if (spec.envValue) return spec.envValue;
  if (!spec.configured.startsWith('keychain:')) return spec.configured;
  const service = spec.configured.slice('keychain:'.length);
  const run =
    deps.run ??
    ((cmd: string): string | null => {
      try {
        return execSync(cmd, { encoding: 'utf8' });
      } catch {
        return null;
      }
    });
  const out = run(`/usr/bin/security find-generic-password -s ${JSON.stringify(service)} -w 2>/dev/null`);
  // security -w 输出带尾部换行——必须 trim，否则密码含不可引用字符，
  // IMAP LOGIN 会报 "Unquotable character in IMAP string value"。
  return out === null ? '' : out.replace(/[\r\n]+$/, '');
};

export interface AiResolved {
  readonly provider: 'anthropic' | 'openai';
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

/** 统一 AI 段解析（2026-10-10 开源 MVP）：env（JULI_AI_*）> config.ai >
 *  旧散键（llm_provider / llm_model / llm_base_url / secrets.llm_api_key，
 *  env 别名 JULI_LLM_API_KEY / MAKRO_LLM_API_KEY）。keychain: 引用照
 *  resolveSecret 解析；ai.provider 空串 = 继承 llm_provider。引擎 LLM 构造
 *  与 tmux 环境注入（ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL）都吃这里——
 *  一处配置两处用，禁止各处自行拼装。 */
export const resolveAiConfig = (
  config: Pick<Config, 'ai' | 'llm_provider' | 'llm_model' | 'llm_base_url' | 'secrets'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): AiResolved => {
  const pick = envGetter(env);
  const providerRaw = pick('JULI_AI_PROVIDER') ?? config.ai.provider;
  const provider: 'anthropic' | 'openai' =
    providerRaw === 'openai' || (providerRaw === '' && config.llm_provider === 'openai')
      ? 'openai'
      : 'anthropic';
  const fromAiSection = config.ai.api_key !== ''
    ? resolveSecret({ configured: config.ai.api_key })
    : '';
  const apiKey = pick('JULI_AI_API_KEY')
    ?? (fromAiSection !== ''
      ? fromAiSection
      : resolveSecret({ envValue: pick('JULI_LLM_API_KEY', 'MAKRO_LLM_API_KEY'), configured: config.secrets.llm_api_key }));
  return {
    provider,
    apiKey: apiKey ?? '',
    baseUrl: (pick('JULI_AI_BASE_URL') ?? (config.ai.base_url !== '' ? config.ai.base_url : undefined))
      ?? config.llm_base_url,
    model: (pick('JULI_AI_MODEL') ?? (config.ai.model !== '' ? config.ai.model : undefined))
      ?? config.llm_model,
  };
};
