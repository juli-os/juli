// 入站渠道端口（对应 email 之外的 Teams/Slack/飞书等未来渠道）：
// 每个渠道是一个自轮询/自订阅的适配器，把外部事件规约成统一的
// InboundMessage 交给引擎；渠道自身的鉴权（channelAuthz）在适配器内完成，
// 引擎做全局 authz 兜底 + dedupKey 幂等建流（模板 trigger 路由已于
// 2026-09-13 动态模型裁决废除——事件直达 nodes，见 intake.ts onInbound）。

export interface InboundMessage {
  /** 渠道名（如 email/teams/slack/feishu；作 workflow kind 与日志标签，
   * email 走专用邮件路径——动态模型下无模板 trigger 映射）。 */
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
