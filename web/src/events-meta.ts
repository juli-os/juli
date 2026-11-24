// 事件元数据单一事实源（2026-09-22 信任修复）：LIVE EVENTS 白名单（dashboard）、
// toast 分级与文案（main）、feed 行配色（dashboard）都读这里——三张表曾分居
// dashboard.ts 与 main.ts 两处，口径漂移正是「面板把日志原文当产品内容」的根。
// 新增人类语义事件 = 在 HUMAN_EVENT_TYPES 加一行；未收录的事件一律按内部事件
// 折叠（安全默认：新守卫/回声类机器事件不会再刷屏）。

export type ToastLevel = 'urgent' | 'ok' | 'info';

/** 对人有语义的事件（精确名白名单，按账本真实事件名逐个收录）：
 * 步状态转变 / 闸门决定 / 流水与任务生命周期 / 邮件与路由 / 结算与异常。
 * 有意不用 step_*、workflow_* 整前缀——step_activity、session_turn、
 * self_echo_ignored 等逐回合机器事件就藏在通用前缀里。例外：B3 审查 F4 把
 * 具名状态面回执 step_seed_render_fallback 与 envelope_*_ignored 两枚收录
 * （它们是判定结果帧，进 STATE_CHANGING 后必须 ⊆ 本表）。
 * b44 R1 P1：与 webapp/src/logic/events-meta.ts 的同名表收敛到两侧并集
 * （缺失名已逐一 grep src/business 核实真实发射），跨拷贝恰等由
 * test/events-meta-parity.test.ts 钉死。 */
export const HUMAN_EVENT_TYPES: ReadonlySet<string> = new Set([
  // 步状态转变（step_activity/step_patch 除外——那是 agent hook 逐回合流水；
  // step_seed_render_fallback 随 B3 F4 补录）
  'step_dispatched', 'step_redispatched', 'step_waiting_human', 'step_completed',
  'step_failed', 'step_cancelled', 'step_skipped', 'step_retry', 'step_amended',
  'step_input_amended', 'step_intervened', 'step_self_heal', 'step_seed_render_fallback',
  // 闸门决定（每道闸一次，低频高语义；含自动免批/影子免批/问询闸开/打回回执）
  'gate_approved', 'gate_denied', 'gate_resolved', 'gate_aligned', 'gate_rework',
  'gate_relayed', 'gate_relay_queued', 'gate_relay_delivered', 'gate_relay_stuck',
  'gate_auto_approved', 'gate_auto_approve_shadow', 'question_gate_opened',
  'send_rework',
  // 流水/任务生命周期（override_set 随 B2 F3、发送管线五帧随 B3 F4 进
  // STATE_CHANGING，⊆ 本表）
  'flow_started', 'task_queued', 'task_started', 'task_dispatched',
  'workflow_failed', 'workflow_resolved', 'workflow_denied', 'workflow_closed',
  'workflow_force_closed', 'run_settled', 'run_settleable', 'hold_released', 'override_set',
  'send_checks_ran', 'send_checks_skipped_delivery', 'send_seed_skipped_delivery',
  'envelope_override_ignored', 'envelope_cc_override_ignored',
  // 邮件与路由
  'email_sent', 'email_received', 'email_rejected',
  'route_decision', 'route_fallback', 'route_busy_divert', 'route_content_handoff',
  'session_bound_route', 'session_inherited',
  // 结算与异常（failed 为历史账本事件名，保留渲染历史行）
  'completed', 'failed', 'agent_zombie', 'agent_interrupted', 'agent_rebuild_failed',
  'sweep_failed',
]);

/** 该事件是否逐条照显（false = 折叠进「+ N 条内部事件」）。 */
export const isHumanEvent = (type: string): boolean => HUMAN_EVENT_TYPES.has(type);

/** 状态会变的事件（dashboard 节流重载白名单）：到达即触发闸门队列/状态卡/
 * 流水表重拉（服务端为准）。此前住在 dashboard.ts 一份手写清单——事件元
 * 数据归本模块单一源（09-22 收口之半补全）。b44 R1 P1：与 webapp 侧同名表
 * 收敛到两侧并集（webapp 的步推进/重跑/否决/派发/打回/中继卡住 6 名补入；
 * gate_approved/gate_aligned/agent_zombie/run_settled 为旧 web 现役名保留）
 * ——只增不删，重载触发面零回退，跨拷贝恰等由 test/events-meta-parity.test.ts 钉死。 */
export const STATE_CHANGING_EVENTS: ReadonlySet<string> = new Set([
  'step_dispatched', 'step_waiting_human', 'step_completed', 'step_failed',
  'step_retry', 'gate_approved', 'gate_aligned', 'workflow_failed',
  'workflow_denied', 'completed', 'agent_zombie', 'run_settled',
  'task_dispatched', 'send_rework', 'gate_relay_stuck',
  // B2 F3：hold 名单三帧，与 webapp 侧同步；工作时间窗跨界本身不发事件（引擎面缺口，不动）
  'task_queued', 'override_set', 'hold_released',
  // B3 审查 F4：发送管线六帧，与 webapp 侧同步；checks/seed/envelope 判定
  // 结果没有后续 step 帧兜底，不进名单 = 判定不可见。
  'send_checks_ran', 'send_checks_skipped_delivery', 'step_seed_render_fallback',
  'send_seed_skipped_delivery', 'envelope_override_ignored', 'envelope_cc_override_ignored',
]);

/** toast 分级（警报纪律）：urgent=需要人动（红，6s 长亮）/ ok=结果类（绿，4.5s）/
 * info=过程类（3s）。未收录 = silent——所有事件同一强度会训练操作人无视警报。
 * b44 R1 P1：gate_relay_stuck/send_rework 两映射自 webapp 侧互灌（有映射一侧为准）。 */
export const TOAST_LEVELS: Readonly<Record<string, ToastLevel | 'silent'>> = {
  step_waiting_human: 'urgent',
  workflow_failed: 'urgent',
  agent_zombie: 'urgent',
  gate_relay_stuck: 'urgent',
  email_sent: 'ok',
  completed: 'ok',
  gate_approved: 'ok',
  gate_aligned: 'ok',
  run_settled: 'ok',
  send_rework: 'ok',
  email_received: 'info',
};

/** toast 文案（与 TOAST_LEVELS 同键）：to = 收件人（email_sent 用）。 */
export const TOAST_TEXT: Readonly<Record<string, (to: string) => string>> = {
  step_waiting_human: () => '闸门等待你的决定',
  workflow_failed: () => '流水失败，需要处理',
  agent_zombie: () => 'agent 疑似卡死，自愈中',
  gate_relay_stuck: () => '闸门中继卡住',
  email_sent: (to) => `回信已发出${to !== '' ? ` → ${to}` : ''}`,
  completed: () => '流水完成',
  gate_approved: () => '闸门已批准',
  gate_aligned: () => '对齐修正已生效',
  run_settled: () => 'run 已结算',
  send_rework: () => '已打回补正',
  email_received: () => '收到新邮件',
};

/** feed 行事件名的语义配色类（style.css 的 evt-ok/evt-warn/evt-bad/evt-info）。 */
export const EVENT_CLASS: Readonly<Record<string, string>> = {
  step_waiting_human: 'evt-warn', workflow_failed: 'evt-bad', agent_zombie: 'evt-bad',
  step_failed: 'evt-bad',
  email_sent: 'evt-ok', completed: 'evt-ok', gate_approved: 'evt-ok',
  gate_aligned: 'evt-ok', run_settled: 'evt-info', email_received: 'evt-info',
};

// ---- SSE 命名帧监听全集（R1 P1#2 收口） -------------------------------------
// 服务端（src/http/routes/events.ts）把账本每条事件按 `event: <type>` 命名帧
// 下发，浏览器只把命名帧派给 addEventListener——监听表缺名 = 该帧被客户端
// 静默丢弃。sse.ts 的手写 16 名清单与上面几张元数据表漂移（3 个 urgent +
// STATE_CHANGING 缺 7 + email_sent 全没监听），「闸门等待你的决定」等红色
// 警报在 live 通路永不出现。现从本模块的事实源派生并在测试钉死
// （test/sse-listen-types.test.ts），杜绝第四度漂移。

/** 监听表专属、有意不入 HUMAN_EVENT_TYPES 的名字：只被特定视图消费、
 * 无全局人类语义（toast/feed 白名单不该收）。 */
const SSE_EXTRA_TYPES: readonly string[] = [
  // 路由判定三态（九跑 P1 补监听）：routegraph 掌舵/陪跑/否决计数与判定
  // 列表实时更新（intake.ts / steps.ts 产生）。
  'route_judgment', 'route_judgment_applied', 'route_judgment_rejected',
  // feedback 页专属前缀条件（2026-09-28「提交了但页面上看不到」）：挂件/
  // 提交卡起单 → task_started（已在 HUMAN 表）；镜像聚合 flush →
  // feedback_flushed；闸门回挂 → feedback_gate_*；锚点继承 →
  // feedback_anchor_inherited——feedback 前缀条件由此复活。
  'feedback_flushed', 'feedback_gate_backfilled', 'feedback_gate_auto_appended',
  'feedback_gate_auto_append_failed', 'feedback_anchor_inherited',
];

/** SSE 客户端要监听的事件名全集 = 人类事件白名单 ∪ 状态重载白名单 ∪
 * toast 分级键 ∪ 表外专属名单（sse.ts 逐名 addEventListener）。 */
export const SSE_LISTEN_TYPES: ReadonlySet<string> = new Set([
  ...HUMAN_EVENT_TYPES,
  ...STATE_CHANGING_EVENTS,
  ...Object.keys(TOAST_LEVELS),
  ...SSE_EXTRA_TYPES,
]);
