// 入站渠道端口（对应 email 之外的 Teams/Slack/飞书等未来渠道）：
// 每个渠道是一个自轮询/自订阅的适配器，把外部事件规约成统一的
// InboundMessage 交给引擎；渠道自身的鉴权（channelAuthz）与去重在
// 适配器内完成，引擎只做全局 authz 兜底 + 按模板 trigger 路由。

export interface InboundMessage {
  /** 渠道名（= 模板 trigger 名，如 email/teams/slack/feishu）。 */
  readonly channel: string;
  readonly from: string;
  readonly subject: string;
  readonly body: string;
  /** 渠道内去重键（引擎幂等建流的依据）。 */
  readonly dedupKey: string;
  readonly messageId?: string;
  readonly ts: string;
}

export interface ChannelStatus {
  readonly enabled: boolean;
  readonly lastPoll: string | null;
  readonly lastOk: string | null;
  readonly lastError: string;
  readonly processed: number;
}

export interface InboundChannel {
  readonly name: string;
  start(): void;
  stop(): void;
  status(): ChannelStatus;
}
