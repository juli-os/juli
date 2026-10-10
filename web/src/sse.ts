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
  es.onmessage = (m) => {
    try {
      onEvent(m.type, JSON.parse(m.data));
    } catch { /* 忽略坏帧 */ }
  };
  es.addEventListener('email_received', (m) => onEvent('email_received', safe(m)));
  es.addEventListener('step_completed', (m) => onEvent('step_completed', safe(m)));
  es.addEventListener('completed', (m) => onEvent('completed', safe(m)));
  // 路由 DAG（apply 2026-09-20）：命名事件帧此前无监听会被静默丢弃。
  es.addEventListener('route_decision', (m) => onEvent('route_decision', safe(m)));
  es.addEventListener('route_fallback', (m) => onEvent('route_fallback', safe(m)));
  es.addEventListener('session_bound_route', (m) => onEvent('session_bound_route', safe(m)));
  // jev 判定三态（九跑 P1 补监听）：账本真实事件名（intake.ts:337-350、
  // steps.ts:306-317 产生，events.ts 以 event:<type> 命名帧下发）——此前无
  // 监听被静默丢弃，routegraph 掌舵/陪跑/否决计数与判定列表永不实时更新。
  es.addEventListener('route_judgment', (m) => onEvent('route_judgment', safe(m)));
  es.addEventListener('route_judgment_applied', (m) => onEvent('route_judgment_applied', safe(m)));
  es.addEventListener('route_judgment_rejected', (m) => onEvent('route_judgment_rejected', safe(m)));
  // 反馈页自动刷新（2026-09-28「提交了但页面上看不到」）：挂件/提交卡起单
  // → task_started 帧；镜像聚合 flush → feedback_flushed；闸门回挂 →
  // feedback_gate_*；锚点继承 → feedback_anchor_inherited（九跑 P2：补齐
  // feedback 前缀真实命名帧监听，feedback 页的前缀条件由此复活）。
  es.addEventListener('task_started', (m) => onEvent('task_started', safe(m)));
  es.addEventListener('workflow_denied', (m) => onEvent('workflow_denied', safe(m)));
  es.addEventListener('feedback_flushed', (m) => onEvent('feedback_flushed', safe(m)));
  es.addEventListener('feedback_gate_backfilled', (m) => onEvent('feedback_gate_backfilled', safe(m)));
  es.addEventListener('feedback_gate_auto_appended', (m) => onEvent('feedback_gate_auto_appended', safe(m)));
  es.addEventListener('feedback_gate_auto_append_failed', (m) => onEvent('feedback_gate_auto_append_failed', safe(m)));
  es.addEventListener('feedback_anchor_inherited', (m) => onEvent('feedback_anchor_inherited', safe(m)));
  return () => es.close();
};

const safe = (m: MessageEvent): unknown => {
  try {
    return JSON.parse((m as MessageEvent<string>).data);
  } catch {
    return null;
  }
};
