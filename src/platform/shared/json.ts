// JSON 字符串侧的窄口径工具（JsonValue/JsonRecord/safeParse/asRecord 的事实源
// 已收编 npm 包 @juli-os/artifacts——10-10 影子清除；本文件只留包面没有的
// asString/strCoerced/truncate 私仓惯用件）。
// R8 批3 清洗收口：str() 原先 5 处独立实现 2 种语义（静默空串 / String()
// 强转），正是口径漂移温床——现两语义在此显式命名并存，禁止互相统一：
// crm/store 的强转语义是既定行为（sqlite Row/PB 字段数字→"42"），改语义
// =行为变更。

/** 静默空串语义：非字符串（含数字/布尔/null）一律 ''。 */
export const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/** String() 强转语义：字符串原样；null/undefined → ''；其余非字符串按
 * String() 强转（42 → "42"）。crm/store 行读的既定口径。 */
export const strCoerced = (v: unknown): string =>
  typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);

/** 截断到 n 个字符（Go util.Truncate 对应物），超长以…收尾。 */
export const truncate = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
