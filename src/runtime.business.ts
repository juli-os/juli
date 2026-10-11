// 公开投影桩：与私仓同形，双侧 typecheck 兜底防漂移。
// 私仓本文件是组合根的业务装配分册（APNs/Bark 推送真实现、反馈墙/客户库/
// CRM/Party 目录、feedback 进件、镜像 sweep/villa 源/财务备份巡检定时器）
// ——公开投影未含这些模块（MVP 砍面），桩提供同形空实现：feedback/
// customers/crm/party = null、设备推送 no-op（通知统一走邮件通道）、
// lookupCustomer 空表降级、业务定时器空集。runtime.ts 组合根零改动即可
// 在两侧编译；导出面漂移（私仓改签名忘同步桩）即公开树 typecheck 红灯。

import type { Config } from './platform/config/schema.ts';
import type { Logger } from './platform/events/bus.ts';
import type { LifecycleStore } from '@juli-os/ledger';
import type { ArtifactBackend } from '@juli-os/artifacts';
import type { JudgmentGateway } from '@juli-os/routing';
import type { Engine } from './business/workflow/engine.ts';
import type { PartyDirectory } from './business/party/party.ts';
import type { ChatCustomerRow } from './business/intake/chatTools.ts';

/** wireBusiness 依赖（引擎在位前的装配面——runtime.ts 持有并注入）。 */
export interface BusinessDeps {
  readonly config: Config;
  readonly dataDir: string;
  readonly store: LifecycleStore;
  readonly backend: ArtifactBackend;
  readonly log: Logger;
  /** 设备 token 注册表读取（runtime.ts 持有文件——业务只消费不落盘）。 */
  readonly deviceTokens: () => readonly string[];
  /** 设备 token 注册表写回（除名用；与 registerDeviceToken 同一落点）。 */
  readonly saveDeviceTokens: (tokens: readonly string[]) => void;
}

/** 业务装配产物（公开桩：数据面全 null，函数面全 no-op）。 */
export interface BusinessParts {
  readonly feedback: null;
  readonly customers: null;
  readonly crm: null;
  readonly party: PartyDirectory | null;
  /** 设备推送原始面（公开投影未含 APNs/Bark——no-op，通知走邮件）。 */
  readonly devicePushRaw: (title: string, body: string, deepLink: string, workflowId?: string, stepId?: string) => Promise<void>;
  /** chat 工具 lookupCustomer（公开投影无客户库——空表降级）。 */
  readonly lookupCustomer: (query: string) => Promise<readonly ChatCustomerRow[]>;
}

/** 引擎在位前的业务装配（公开桩：不装配任何业务件，只留通道可见性日志）。 */
export const wireBusiness = (deps: BusinessDeps): BusinessParts => {
  deps.log.info(`[push] 通道装配：开源投影未含设备推送 · 在册设备 ${deps.deviceTokens().length} 台（通知走邮件）`);
  return {
    feedback: null,
    customers: null,
    crm: null,
    party: null,
    devicePushRaw: async () => {},
    lookupCustomer: async () => [],
  };
};

/** wireFeedbackIntake 依赖（引擎与判定网关在位后的二段装配面）。 */
export interface IntakeDeps {
  readonly config: Config;
  readonly store: LifecycleStore;
  readonly engine: Engine;
  readonly judgment: JudgmentGateway;
  readonly log: Logger;
}

/** feedback 进件产物（公开投影未含进件链——恒 null）。 */
export type BusinessIntake = null;

/** 引擎在位后的业务二段装配（公开桩：进件链不进开源投影，恒 null）。 */
export const wireFeedbackIntake = (_deps: IntakeDeps): BusinessIntake => null;

/** startBusinessTimers 依赖（start() 时点注入——含 Settings 热改键的活读面）。 */
export interface BusinessTimerDeps {
  readonly config: Config;
  readonly store: LifecycleStore;
  readonly engine: Engine;
  readonly feedbackIntake: BusinessIntake;
  /** 通知邮件通道（未配置=null——巡检告警随之静默，与引擎邮件通知同款语义）。 */
  readonly mailer: {
    send(cmd: { readonly to: string; readonly subject: string; readonly body: string; readonly inReplyTo: string; readonly cc?: readonly string[] }): Promise<{ readonly ok: boolean; readonly error?: { readonly message: string } }>;
  } | null;
  /** 巡检告警收件人（Settings 热改键的活读 getter）。 */
  readonly recipients: () => { readonly to: readonly string[]; readonly cc: readonly string[] };
  readonly log: Logger;
}

/** 业务定时器（公开桩：空集——镜像 sweep/villa 源/财务巡检均不在投影内）。 */
export const startBusinessTimers = (_deps: BusinessTimerDeps): NodeJS.Timeout[] => [];
