// 聊天事件 hub（对应 Go cmd/gui chatHub）：环形历史 200 条 + 订阅广播。
// iPhone ChatView / Web 聊天视图共用：新连接先回放历史，再收实时。
// conv 分线程（2026-10-17）：帧带 conv 标签，replay/消费按 conv 过滤——
// 诊断注入与并行使用不再串台（「幽灵消息」事故的结构修法）。旧调用
// emit(type,data) 不带 conv = 'main'（旧单线程语义）。
// 容量口径（2026-10-18 R1-F5 钉）：capacity（默认 200）是**全 conv 共享的
// 全局预算**，不分线程配额——一条活跃线程的帧流会把安静线程的回放历史挤出
// ring。这是单运营者现实下的有意取舍：ring 只服务 WS 断线/挂起的补帧回放
//（web 本地 transcript 与 iOS 会话档才是完整历史源），补不到帧=少补不是
// 错补；为兜底路径引入 per-conv 配额属过度设计。未来多运营者/长挂起场景
// 确有需要时再改配额，并同步本注释与 chat-conv 的全局预算测试（改口径即红）。

export interface ChatEvent {
  readonly type: string;
  readonly data: string;
  readonly at: string;
  /** 会话线程标签（conv 注册表同款清洗后的值；缺省 'main'）。 */
  readonly conv: string;
}

export interface ChatHub {
  emit(type: string, data: string, conv?: string): void;
  /** 新连接回放：返回最近的历史（按时间正序）。conv 给定=只回该线程；
   * 缺省=全量（兼容面，勿在新代码使用）。 */
  replay(conv?: string): readonly ChatEvent[];
  subscribe(fn: (e: ChatEvent) => void): () => void;
  count(): number;
}

/** capacity=全 conv 共享的全局预算（口径见头注；非 per-conv 配额）。 */
export const createChatHub = (capacity = 200): ChatHub => {
  let ring: ChatEvent[] = [];
  const subs = new Set<(e: ChatEvent) => void>();
  return {
    emit(type, data, conv = 'main') {
      const e: ChatEvent = { type, data, at: new Date().toISOString(), conv };
      // 裁剪起点用正向下标算，不用 slice(-(capacity-1))：capacity=1 时
      // -(capacity-1) === -0，JS 规范里 slice(-0) 走非负分支 = slice(0) =
      // 全量保留，ring 无界增长（内存慢性泄漏）。capacity≥2 时两式等价
      //（未满全量、满后裁到容量），capacity=0 稳定 1 条的既有语义不变。
      ring = [...ring.slice(Math.max(0, ring.length - capacity + 1)), e];
      for (const fn of subs) {
        try {
          fn(e);
        } catch { /* 订阅者异常不影响其他 */ }
      }
    },
    replay(conv) {
      return conv === undefined ? ring : ring.filter((e) => e.conv === conv);
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
