// SSE 事件流订阅：断线自动重连（EventSource 原生），token 走 query（兼容面）。

export const subscribeEvents = (
  onEvent: (type: string, data: unknown) => void,
  onStart?: () => void,
  onDrop?: () => void,
): (() => void) => {
  const token = localStorage.getItem('juli_token') ?? '';
  const url = `/api/events/stream${token !== '' ? `?token=${encodeURIComponent(token)}` : ''}`;
  const es = new EventSource(url);
  es.onopen = () => onStart?.();
  es.onerror = () => onDrop?.();
  // 服务端（src/http/routes/events.ts）每帧都带 event 名，浏览器只把命名帧
  // 派给 addEventListener——onmessage 仅收无名帧，原 onmessage 分支不可达已删。
  const on = (type: string): void => es.addEventListener(type, (m) => onEvent(type, safe(m)));
  on('email_received');
  on('step_completed');
  on('completed');
  // 路由 DAG（apply 2026-09-20）：命名事件帧此前无监听会被静默丢弃。
  on('route_decision');
  on('route_fallback');
  on('session_bound_route');
  // jev 判定三态（九跑 P1 补监听）：账本真实事件名（intake.ts:337-350、
  // steps.ts:306-317 产生，events.ts 以 event:<type> 命名帧下发）——此前无
  // 监听被静默丢弃，routegraph 掌舵/陪跑/否决计数与判定列表永不实时更新。
  on('route_judgment');
  on('route_judgment_applied');
  on('route_judgment_rejected');
  // 反馈页自动刷新（2026-09-28「提交了但页面上看不到」）：挂件/提交卡起单
  // → task_started 帧；镜像聚合 flush → feedback_flushed；闸门回挂 →
  // feedback_gate_*；锚点继承 → feedback_anchor_inherited（九跑 P2：补齐
  // feedback 前缀真实命名帧监听，feedback 页的前缀条件由此复活）。
  on('task_started');
  on('workflow_denied');
  on('feedback_flushed');
  on('feedback_gate_backfilled');
  on('feedback_gate_auto_appended');
  on('feedback_gate_auto_append_failed');
  on('feedback_anchor_inherited');
  return () => es.close();
};

const safe = (m: MessageEvent<string>): unknown => {
  try {
    return JSON.parse(m.data);
  } catch {
    return null;
  }
};
