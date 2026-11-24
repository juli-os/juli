// chat intake 会话注册表（2026-10-17 分用户第一步）：intake 从「服务器级
// 单线程」改为按 conv id 分线程——每 conv 一个独立 intake 实例（自带独立
// LLM 对话上下文）。动机：单线程下任何客户端（含诊断注入）的回合会出现在
// 所有端上（「幽灵消息」事故）；诊断/并行使用/误注入全靠本层隔离。
//
// 兼容：无 conv 的旧客户端统一落 'main' 桶（行为=旧单线程）。
// 容量：每实例持一条 LLM 对话上下文，封顶 evict 最久未用的非 main 桶（真
// LRU：命中即 delete+set 刷序，活跃线程不因创建早被逐出；main 永驻）。
//
// conv → 租户登记（2026-11-08 多租户提案 A2 读侧边界）：conv 首次创建时按
// 发起方租户登记（缺省 internal），此后锁死——租户是线程的属性不是请求的
// 属性。/ws/chat 订阅与 /api/chat/history 回放按本表过滤：已登记 conv 只进
// 同租户；未登记 conv（A2 之前的存量）只进 all。登记与实例分表，登记是归属
// 的唯一事实源：实例 LRU 逐出只逐实例，租户登记保留（重建实例沿用登记的
// 原租户，后到的 tenant 参数不覆写）；登记表自带上限（1024）防灌水，且与
// 实例表同真 LRU 纪律——of() 命中 touch 刷序，活跃 conv 的登记不因 churn
// 被挤掉（挤掉会让活跃 conv 降级成「未登记存量」，one 身份看不见自己的线程）。

import { createChatIntake, type ChatIntake, type ChatIntakeDeps } from './chatIntake.ts';
import { sanitizeConv } from '../../platform/shared/conv.ts';

// conv id 清洗已收敛到 platform/shared/conv.ts（单一事实源，2026-10-18）；
// 此处再导出保公开面（routes/chat.ts 与既有测试的 import 路径零漂移）。
export { sanitizeConv };

/** 新 conv 的缺省租户——契约值，与 platform/config/tenants.ts 的
 * INTERNAL_TENANT 同源同值（A1 声明校验保证 internal 恒在）。 */
const DEFAULT_TENANT = 'internal';

/** 租户登记表上限：防未知客户端灌 conv id 撑大 Map（实例分表逐出不动登记，
 * 登记自己也要有界）。登记条目是纯字符串对（无 LLM 上下文），上限可比实例
 * 表（32）高一个数量级。LRU 同纪律：命中刷序，逐出最久未用的非 main 记录。 */
const TENANT_REG_CAP = 1024;

export interface ChatIntakeRegistry {
  /** 取（惰性建）指定 conv 的 intake 实例。tenant = 发起方租户，只在 conv
   * 首见（尚无登记）时作为登记值；已登记 conv 即使实例被逐出重建，也沿用
   * 登记的原租户——归属在首次登记时刻锁死，不被后到的身份覆写。 */
  of(conv: string, tenant?: string): ChatIntake;
  /** main 桶（旧客户端/无 conv 调用方的兼容面）。 */
  readonly main: ChatIntake;
  /** conv → 租户登记：已登记返回租户 id；未登记（含 A2 前存量）返回 null。 */
  tenantOf(conv: string): string | null;
  /** conv 是否有登记记录（区分「未登记存量」与「尚不存在」）。 */
  has(conv: string): boolean;
  /** 在役 conv 数（观测用）。 */
  count(): number;
}

const MAIN = 'main';

export const createChatIntakeRegistry = (
  deps: (tenant: string) => ChatIntakeDeps,
  cap = 32,
): ChatIntakeRegistry => {
  const convs = new Map<string, ChatIntake>();
  const tenantReg = new Map<string, string>();
  const evictOldestNonMain = (m: { keys(): Iterable<string>; delete(k: string): void }): void => {
    // 逐出最久未用的非 main 条目（Map 迭代序=最近使用序）；全是 main 时只此一个，无需逐出。
    for (const k of m.keys()) {
      if (k !== MAIN) { m.delete(k); break; }
    }
  };
  const touchReg = (conv: string): void => {
    const t = tenantReg.get(conv);
    if (t === undefined) return;
    tenantReg.delete(conv);
    tenantReg.set(conv, t);
  };
  const of = (convRaw: string, tenantRaw?: string): ChatIntake => {
    const conv = sanitizeConv(convRaw);
    // 归属判定：登记优先——tenant 参数只在首见时作数，此后登记锁死。
    const registered = tenantReg.get(conv) ?? null;
    const tenant = registered ?? tenantRaw ?? DEFAULT_TENANT;
    const hit = convs.get(conv);
    if (hit) {
      // 真 LRU（R1-F4）：命中刷序——delete+set 移到队尾，逐出按「最久未用」。
      convs.delete(conv);
      convs.set(conv, hit);
      touchReg(conv);
      return hit;
    }
    const inst = createChatIntake(deps(tenant));
    if (convs.size >= cap) evictOldestNonMain(convs);
    convs.set(conv, inst);
    if (registered === null) {
      if (tenantReg.size >= TENANT_REG_CAP) evictOldestNonMain(tenantReg);
      tenantReg.set(conv, tenant);
    } else {
      touchReg(conv);
    }
    return inst;
  };
  return {
    of,
    get main(): ChatIntake { return of(MAIN); },
    tenantOf: (convRaw: string): string | null => tenantReg.get(sanitizeConv(convRaw)) ?? null,
    has: (convRaw: string): boolean => tenantReg.has(sanitizeConv(convRaw)),
    count: () => convs.size,
  };
};
