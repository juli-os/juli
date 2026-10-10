// 进程内同步 pub/sub（对应 Go internal/infra/eventbus）。非 MQ：handler
// 同步派发、单个 handler 抛错不影响其他订阅者（panic 隔离的 TS 对应物）。

export interface BusEvent<T = unknown> {
  readonly topic: string;
  readonly payload: T;
  readonly at: Date;
}

export type BusHandler = (e: BusEvent) => void;

export interface Bus {
  subscribe(topic: string, h: BusHandler): () => void;
  emit(topic: string, payload: unknown): void;
  subscriberCount(topic: string): number;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`[juli] ${m}`),
  warn: (m) => console.warn(`[juli] ${m}`),
  error: (m) => console.error(`[juli] ${m}`),
};

export const createBus = (log: Logger = consoleLogger): Bus => {
  const handlers = new Map<string, Set<BusHandler>>();
  return {
    subscribe(topic, h) {
      const set = handlers.get(topic) ?? new Set<BusHandler>();
      set.add(h);
      handlers.set(topic, set);
      return () => set.delete(h);
    },
    emit(topic, payload) {
      const e: BusEvent = { topic, payload, at: new Date() };
      for (const h of handlers.get(topic) ?? []) {
        try {
          h(e);
        } catch (err) {
          log.error(`eventbus handler panic (topic=${topic}): ${String(err)}`);
        }
      }
    },
    subscriberCount: (topic) => handlers.get(topic)?.size ?? 0,
  };
};

// v1 说明：总线已装配、暂无进程内订阅者（SSE 直读账本 events 表，跨进程
// 语义更强）；保留作插件/hook 期的进程内事件面。
