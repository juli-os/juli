// 事件元数据单一事实源（2026-09-22 信任修复）：LIVE EVENTS 白名单（dashboard）、
// toast 分级与文案（main）、feed 行配色（dashboard）都读这里——三张表曾分居
// dashboard.ts 与 main.ts 两处，口径漂移正是「面板把日志原文当产品内容」的根。
// 新增人类语义事件 = 在 HUMAN_EVENT_TYPES 加一行；未收录的事件一律按内部事件
// 折叠（安全默认：新守卫/回声类机器事件不会再刷屏）。

export type ToastLevel = 'urgent' | 'ok' | 'info';

/** 对人有语义的事件（精确名白名单，按账本真实事件名逐个收录）：
 * 步状态转变 / 闸门决定 / 流水与任务生命周期 / 邮件与路由 / 结算与异常。
 * 有意不用 step_*、workflow_* 整前缀——step_activity、session_turn、
 * self_echo_ignored、envelope_*_ignored 等逐回合机器事件就藏在通用前缀里。 */
export const HUMAN_EVENT_TYPES: ReadonlySet<string> = new Set([
  // 步状态转变（step_activity/step_patch 除外——那是 agent hook 逐回合流水）
  'step_dispatched', 'step_redispatched', 'step_waiting_human', 'step_completed',
  'step_failed', 'step_cancelled', 'step_skipped', 'step_retry', 'step_amended',
  'step_input_amended', 'step_intervened', 'step_self_heal',
  // 闸门决定（每道闸一次，低频高语义）
  'gate_approved', 'gate_denied', 'gate_resolved', 'gate_aligned', 'gate_rework',
  'gate_relayed', 'gate_relay_queued', 'gate_relay_delivered', 'gate_relay_stuck',
  // 流水/任务生命周期
  'flow_started', 'task_queued', 'task_started', 'task_dispatched',
  'workflow_failed', 'workflow_resolved', 'workflow_denied', 'workflow_closed',
  'workflow_force_closed',
  // 邮件与路由
  'email_sent', 'email_received', 'email_rejected',
  'route_decision', 'route_fallback', 'route_busy_divert', 'route_content_handoff',
  'session_bound_route',
  // 结算与异常
  'completed', 'failed', 'run_settled', 'agent_zombie',
]);

/** 该事件是否逐条照显（false = 折叠进「+ N 条内部事件」）。 */
export const isHumanEvent = (type: string): boolean => HUMAN_EVENT_TYPES.has(type);

/** 状态会变的事件（dashboard 节流重载白名单）：到达即触发闸门队列/状态卡/
 * 流水表重拉（服务端为准）。此前住在 dashboard.ts 一份手写清单——事件元
 * 数据归本模块单一源（09-22 收口之半补全）。 */
export const STATE_CHANGING_EVENTS: ReadonlySet<string> = new Set([
  'step_waiting_human', 'gate_approved', 'gate_aligned', 'workflow_failed',
  'completed', 'step_failed', 'step_completed', 'agent_zombie', 'run_settled',
]);

/** toast 分级（警报纪律）：urgent=需要人动（红，6s 长亮）/ ok=结果类（绿，4.5s）/
 * info=过程类（3s）。未收录 = silent——所有事件同一强度会训练操作人无视警报。 */
export const TOAST_LEVELS: Readonly<Record<string, ToastLevel | 'silent'>> = {
  step_waiting_human: 'urgent',
  workflow_failed: 'urgent',
  agent_zombie: 'urgent',
  email_sent: 'ok',
  completed: 'ok',
  gate_approved: 'ok',
  gate_aligned: 'ok',
  run_settled: 'ok',
  email_received: 'info',
};

/** toast 文案（与 TOAST_LEVELS 同键）：to = 收件人（email_sent 用）。 */
export const TOAST_TEXT: Readonly<Record<string, (to: string) => string>> = {
  step_waiting_human: () => '闸门等待你的决定',
  workflow_failed: () => '流水失败，需要处理',
  agent_zombie: () => 'agent 疑似卡死，自愈中',
  email_sent: (to) => `回信已发出${to !== '' ? ` → ${to}` : ''}`,
  completed: () => '流水完成',
  gate_approved: () => '闸门已批准',
  gate_aligned: () => '对齐修正已生效',
  run_settled: () => 'run 已结算',
  email_received: () => '收到新邮件',
};

/** feed 行事件名的语义配色类（style.css 的 evt-ok/evt-warn/evt-bad/evt-info）。 */
export const EVENT_CLASS: Readonly<Record<string, string>> = {
  step_waiting_human: 'evt-warn', workflow_failed: 'evt-bad', agent_zombie: 'evt-bad',
  step_failed: 'evt-bad',
  email_sent: 'evt-ok', completed: 'evt-ok', gate_approved: 'evt-ok',
  gate_aligned: 'evt-ok', run_settled: 'evt-info', email_received: 'evt-info',
};
