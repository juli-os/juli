// 聊天事件 hub（对应 Go cmd/gui chatHub）：环形历史 200 条 + 订阅广播。
// iPhone ChatView / Web 聊天视图共用：新连接先回放历史，再收实时。

export interface ChatEvent {
  readonly type: string;
  readonly data: string;
  readonly at: string;
}

export interface ChatHub {
  emit(type: string, data: string): void;
  /** 新连接回放：返回最近的历史（按时间正序）。 */
  replay(): readonly ChatEvent[];
  subscribe(fn: (e: ChatEvent) => void): () => void;
  count(): number;
}

export const createChatHub = (capacity = 200): ChatHub => {
  let ring: ChatEvent[] = [];
  const subs = new Set<(e: ChatEvent) => void>();
  return {
    emit(type, data) {
      const e: ChatEvent = { type, data, at: new Date().toISOString() };
      ring = [...ring.slice(-(capacity - 1)), e];
      for (const fn of subs) {
        try {
          fn(e);
        } catch { /* 订阅者异常不影响其他 */ }
      }
    },
    replay() {
      return ring;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    count() {
      return ring.length;
    },
  };
};
