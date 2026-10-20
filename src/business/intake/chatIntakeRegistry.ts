// chat intake 会话注册表（2026-10-17 分用户第一步）：intake 从「服务器级
// 单线程」改为按 conv id 分线程——每 conv 一个独立 intake 实例（自带独立
// LLM 对话上下文）。动机：单线程下任何客户端（含诊断注入）的回合会出现在
// 所有端上（「幽灵消息」事故）；诊断/并行使用/误注入全靠本层隔离。
//
// 兼容：无 conv 的旧客户端统一落 'main' 桶（行为=旧单线程）。
// 容量：每实例持一条 LLM 对话上下文，封顶 evict 最久未用的非 main 桶（真
// LRU：命中即 delete+set 刷序，活跃线程不因创建早被逐出；main 永驻）。

import { createChatIntake, type ChatIntake, type ChatIntakeDeps } from './chatIntake.ts';
import { sanitizeConv } from '../../platform/shared/conv.ts';

// conv id 清洗已收敛到 platform/shared/conv.ts（单一事实源，2026-10-18）；
// 此处再导出保公开面（routes/chat.ts 与既有测试的 import 路径零漂移）。
export { sanitizeConv };

export interface ChatIntakeRegistry {
  /** 取（惰性建）指定 conv 的 intake 实例。 */
  of(conv: string): ChatIntake;
  /** main 桶（旧客户端/无 conv 调用方的兼容面）。 */
  readonly main: ChatIntake;
  /** 在役 conv 数（观测用）。 */
  count(): number;
}

const MAIN = 'main';

export const createChatIntakeRegistry = (
  deps: () => ChatIntakeDeps,
  cap = 32,
): ChatIntakeRegistry => {
  const convs = new Map<string, ChatIntake>();
  const of = (convRaw: string): ChatIntake => {
    const conv = sanitizeConv(convRaw);
    const hit = convs.get(conv);
    if (hit) {
      // 真 LRU（R1-F4）：命中刷序——delete+set 移到队尾，逐出按「最久未用」。
      convs.delete(conv);
      convs.set(conv, hit);
      return hit;
    }
    const inst = createChatIntake(deps());
    if (convs.size >= cap) {
      // 逐出最久未用的非 main 桶（Map 迭代序=最近使用序）；全是 main 时只此一个，无需逐出。
      for (const k of convs.keys()) {
        if (k !== MAIN) { convs.delete(k); break; }
      }
    }
    convs.set(conv, inst);
    return inst;
  };
  return {
    of,
    get main(): ChatIntake { return of(MAIN); },
    count: () => convs.size,
  };
};
