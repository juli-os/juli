// SSE 事件流订阅：断线自动重连（EventSource 原生），token 走 query（兼容面）。

import { SSE_LISTEN_TYPES } from './events-meta.ts';

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
  // 监听名全集从 events-meta.ts 派生（R1 P1#2）：手写清单与元数据表漂移，
  // 3 个 urgent 警报帧 + 7 个状态重载帧曾被静默丢弃——派生逻辑、历史溯源
  // 注释与防回归测试都在那边（test/sse-listen-types.test.ts）。
  for (const type of SSE_LISTEN_TYPES) es.addEventListener(type, (m) => onEvent(type, safe(m)));
  return () => es.close();
};

const safe = (m: MessageEvent<string>): unknown => {
  try {
    return JSON.parse(m.data);
  } catch {
    return null;
  }
};
