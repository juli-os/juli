// 管线端口：引擎拥有状态转变，传输细节全部注入。每个端口都是纯对象
// 接口，错误走 Result——生产环境接 tmux/SMTP/APNs，测试接 mock。

import { createHash } from 'node:crypto';
import type { Result } from '../platform/shared/result.ts';
import type { JsonRecord } from '../platform/shared/json.ts';
import type { DeliverableRef, SweepEnvelope } from '../platform/artifacts/ledger.ts';
import type { Step, Workflow } from './entities.ts';

// ---- LLM --------------------------------------------------------------------

export interface CompletionRequest {
  readonly system: string;
  readonly user: string;
  readonly maxTokens: number;
  /** 步骤级模型覆盖（空 = 引擎全局 model）。 */
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface CompletionResult {
  readonly text: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** z.ai 计费口径的缓存命中 token（wf_66a9b632154d）：cached_tokens，
   * input_tokens 的子集——命中率=cached/input。 */
  readonly cachedTokens?: number;
}

export interface LlmPort {
  complete(req: CompletionRequest): Promise<Result<CompletionResult, Error>>;
}

// ---- 邮件 ---------------------------------------------------------------------

/** 入站邮件（触发器载荷）。date 为 RFC3339。 */
export interface EmailMessage {
  readonly from: string;
  /** 发件人显示名（RFC2047 已解码，如「陈义芳」）——称呼的唯一合法来源之一；
   * 摄取层曾整字段丢弃（2026-10-01 陈莉君幻觉事故：agent 只见地址被逼起名）。 */
  readonly fromName?: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly messageId: string;
  readonly date: string;
  readonly uid: number | string;
  readonly attachments: readonly { readonly name: string; readonly bytes: number; readonly content?: Buffer }[];
  /** 线程链头(Run 间因果锚);intake 落 meta 并解析关联工作流。 */
  readonly inReplyTo?: string;
  readonly references?: string;
  /** 原始 RFC 822(bucket 归档用;信封路径可缺)。 */
  readonly raw?: Buffer;
}

/** 去重键（对齐 Go inbox.DedupKey）：Message-ID 优先；缺省用
 * nosuchid- 前缀的稳定哈希（无 ID 邮件 + 每连接 \Seen 重投洪水的守卫）。 */
export const dedupKey = (m: EmailMessage): string => {
  if (m.messageId !== '') return m.messageId;
  const sum = createHash('sha1').update(`${m.from}|${m.subject}|${m.date}`).digest('hex');
  return `nosuchid-${sum.slice(0, 8)}`;
};

export const DEDUP_META_KEY = 'dedup_key';

// ---- 发信 ---------------------------------------------------------------------

export interface MailSendCommand {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** 客户可见的渲染版（multipart/alternative 的 html 件）；text 件=审批文本不变。 */
  readonly html?: string;
  readonly inReplyTo: string;
  /** 抄送（断点十：闸门申报单 envelope.cc 声明，种子流转到 send 步）。
   * bcc 不支持（第 5 轮审查：死字段已删——envelope/manifest 从未产出过 bcc，
   * 留着假支持只会制造「以为密送了其实没有」的静默丢弃误会；真有密送需求时
   * 按 cc 同款整体引入解析+播种+展示）。 */
  readonly cc?: readonly string[];
  /** 交付契约声明的附件（工件字节；宣称"见附件"必须真附——0913 事故）。 */
  readonly attachments?: readonly { readonly name: string; readonly bytes: Buffer }[];
}

export interface MailerPort {
  send(cmd: MailSendCommand): Promise<Result<{ readonly messageId: string }, Error>>;
}

// ---- agent 派发 ----------------------------------------------------------------

/** 异步派发（tmux 路径）：发出即返回，完成由 hook/OnAgentStopped 结算。 */
export interface DispatcherPort {
  dispatch(source: string, session: string, text: string): Promise<Result<void, Error>>;
}

/** 同步派发（ACP/协议级完成路径）：阻塞到 turn 结束，返回最终消息。 */
export interface SyncDispatcherPort {
  dispatchSync(source: string, session: string, text: string): Promise<Result<string, Error>>;
}

// ---- 推送 ---------------------------------------------------------------------

/** 闸门/完成/失败通知。尽力而为：推送失败绝不阻塞闸门状态本身。 */
export interface PusherPort {
  gateWaiting(w: Workflow, st: Step, summary: string): Promise<void>;
  workflowDone(w: Workflow, summary: string): Promise<void>;
  /** 工作流守卫性失败（如零步骤禁完成）的主动推送：守卫的全部意图是人工
   * 处置，通知缺位则处置闭环迟迟不启动。 */
  workflowFailed(w: Workflow, summary: string): Promise<void>;
  /** 链尾悬空（nodes 链全终态且从未有 send 步）的主动推送。可选方法：
   * 引擎侧 try/catch 尽力而为调用，mock 缺省不炸。 */
  chainDangling?(w: Workflow, note: string): Promise<void>;
  /** 步骤失败即时推送（2026-09-15 断点十一①）：agent/发送步 failed 后链路
   * 静默停摆等人喊「继续」——失败必须响。与 chainDangling 同款可选形态：
   * 引擎侧尽力而为调用（失败只记日志），mock 缺省不炸。 */
  stepFailed?(w: Workflow, st: Step, reason: string): Promise<void>;
  /** 链尾可结算提示（2026-09-23 断点③）：nodes 链全终态、无人 settle——
   * run 停在链尾等收口的静默形态。「该 settle 了」不再靠人自己想起来。
   * 同款可选形态；按既定分工设备推送不扩面，走邮箱/站内。 */
  settleHint?(w: Workflow, note: string): Promise<void>;
  /** agent 等输入（2026-09-28 提问卡单修复）：会话里的 agent 在等人在终端
   * 回答（权限/选择/提问）——不是僵尸是等人，看门狗豁免改走通知。可选
   * 形态同 settleHint。 */
  awaitingInput?(w: Workflow, st: Step, note: string): Promise<void>;
}

// ---- 会话投递 -------------------------------------------------------------------

/** 一等插话/回流向 tmux 会话投递的结果：delivered = 文本已到达会话输入
 * （含忙碌会话的 in_box 排队形态——CC 会在回合结束消费，不是失败）。
 * 失败时 reason 是给人看的原因（会话不存在/送键失败/粘贴丢失），不许再
 * 笼统一句 delivery failed（2026-09-23 插话 400 事故：20s 确认超时被打成
 * 无因 400，排查只能靠猜）。 */
export interface SessionDelivery {
  readonly delivered: boolean;
  readonly reason: string;
  /** 到达形态：cleared=已提交/输入框已重置；in_box=忙碌会话排队待消费。 */
  readonly finalState?: 'cleared' | 'in_box';
}

// ---- 工件收编 ------------------------------------------------------------------

/** sweep 收编结果：登记后的交付物指针 + 申报单信封。step output.deliverables
 * 的数据源；deliverables 只放给人审的产物（申报单本体以 manifest=true 落
 * meta，不入 entries）。指针形状复用账本的 DeliverableRef——唯一声明。 */
export interface SweepOutcome {
  readonly count: number;
  readonly entries: readonly DeliverableRef[];
  readonly envelope: SweepEnvelope | null;
  readonly warnings: readonly string[];
  readonly has_manifest: boolean;
}

/** 工件端口（引擎视角）：申报单核验收编、登记、按哈希取件。 */
export interface ArtifactPort {
  readonly putAndRegister?: (r: {
    workflowId: string; role: string; name: string; bytes: Buffer;
    stepId?: string; meta?: JsonRecord;
  }) => Promise<{ id: string; sha256: string }>;
  readonly list: (workflowId: string) => readonly {
    readonly id: string; readonly name: string; readonly key: string;
    readonly stepId: string;
    readonly deletedAt: string | null; readonly meta: JsonRecord;
  }[];
  readonly updateMeta: (id: string, patch: JsonRecord) => void;
  /** 按 id 取登记内容（发送步取件入口）：字节 + 哈希核验数据。 */
  readonly getContent?: (id: string) => Promise<{ bytes: Buffer; sha256: string; name: string; viewRole: string } | null>;
  readonly sweepCaseInbox: (workflowId: string, stepId?: string) => Promise<SweepOutcome>;
}

// ---- 语义判定（Jev/System One，可插拔） ---------------------------------------

/** 判定场景（细粒度开关的粒度）：每个场景可独立 off/shadow/on（judgment.json）。 */
export type JudgmentScenario =
  | 'route_intake'    // 邮件进件第一跳：内容判定落哪个声明会话（规则腿降为兜底）
  | 'route_fallback'  // 路由兜底腿：规则链全未命中时选声明会话
  | 'intake_gate'     // 起单价值判定：这条进件值不值得开单
  | 'align_needed'    // 对齐必要性预筛（预留）
  | 'aggregate_same'  // feedback 同因聚合（预留）
  | 'handoff_domain'  // 转派 domain 判定（预留）
  | 'output_quality'  // 产出合格性预检（预留）
  | 'redline_semantic'// 红线语义体检（预留）
  | 'triage_classify' // 邮件 triage：category/needs_reply 类型化判定（summary 留 LLM）
  | 'mount_infer'     // feedback 挂载推断（预留）
  | 'alert_grade';    // 告警分级降噪（预留）

/** 场景全集的运行时镜像（judgment.json 是人工热读面——拼错的场景键必须能被
 * 识别丢弃，否则「以为在影子期攒数据、实际该场景从未出网」零反馈；注解钉住
 * 与联合类型的同构，两边漂移时此处编译报错）。 */
export const JUDGMENT_SCENARIOS: readonly JudgmentScenario[] = [
  'route_intake', 'route_fallback', 'intake_gate', 'align_needed', 'aggregate_same', 'handoff_domain',
  'output_quality', 'redline_semantic', 'triage_classify', 'mount_infer', 'alert_grade',
];

/** 判定问题（结构最小形状——contracts 不依赖 business/routing 的 JevQuestion，
 * 这里与它结构相容，提供方契约解释 instructions/criteria 的具体语义）：
 * noul=是否向 0-1 概率（**极性=P(答案为是)**，plan.ts 钉死）；choice=选项+概率。 */
export type JudgmentQuestion =
  | { readonly type: 'noul'; readonly instructions: unknown; readonly criteria?: unknown }
  | { readonly type: 'choice'; readonly instructions: unknown; readonly criteria: unknown };

/** 判定网关（消费方只认这个）：模式裁断在网关（off 直接 null，不产生网络）；
 * shadow=照常判定留痕但结果不生效；on=结果可被消费方采用（消费方仍须按
 * 引擎侧规则校验答案——「typed judgment 只做输入，决定留引擎」）。 */
export interface JudgmentGateway {
  /** 采纳阈值（config.min_confidence，**全局单值**默认 0.7）：on 模式下置信度
   * 低于它的答案消费方必须拒绝（降级默认行为）。无场景参数——场景级的是
   * off/shadow/on，阈值不是，勿误读为可按场景配置。 */
  threshold(): number;
  /** 执行判定。off → null（调用方零成本跳过）；网关不抛——网络/配置失败
   * 降级为 error 结果，消费方按默认行为走（jev 挂了不许挂管线）。 */
  ask(scenario: JudgmentScenario, state: unknown, questions: Readonly<Record<string, JudgmentQuestion>>):
    Promise<JudgmentOutcome | null>;
}

export interface JudgmentOutcome {
  readonly mode: 'shadow' | 'on';
  readonly ok: boolean;
  /** 本次判定所用配置裁断出的采纳阈值：与 mode 同源同一次 load——消费方
   * 以此为准、勿再自行读配置（热改落在多次读之间的 TOCTOU 就此收口）。 */
  readonly threshold: number;
  /** ok=true 时的判定结果（choice 选项 / noul 0-1 概率映射出的 'true'/'false'）。 */
  readonly answer?: string;
  readonly confidence?: number;
  readonly probabilities?: Readonly<Record<string, number>>;
  /** 多问时的全量答案（键=问题键，值与 answer/confidence 同构）。单问消费方
   * 可忽略；legacy 顶层 answer/confidence 恒等于**第一个问题**的答案（兼容
   * 既有两消费点）。triage_classify 一调多问（category+needs_reply）靠它。 */
  readonly answers?: Readonly<Record<string, { readonly answer?: string; readonly confidence?: number }>>;
  readonly provider: string;
  readonly error?: string;
  /** 用量回执（成本账本输入）：ok=true 时来自判定响应的真实 usage；
   * 失败/off 缺省。消费方可透传进留痕事件供后续分析。 */
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** z.ai 计费口径的缓存命中 token（wf_66a9b632154d）：cached_tokens，
   * input_tokens 的子集——命中率=cached/input。 */
  readonly cachedTokens?: number;
  readonly durationMs?: number;
}
