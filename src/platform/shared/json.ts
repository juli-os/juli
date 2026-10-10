// JSON 字符串侧的窄口径工具（JsonValue/JsonRecord/safeParse/asRecord 的事实源
// 已收编 npm 包 @juli-os/artifacts——10-10 影子清除；本文件只留包面没有的
// asString/truncate 两个私仓惯用件）。

import type { JsonValue } from '@juli-os/artifacts';

export const asString = (v: JsonValue | undefined): string => (typeof v === 'string' ? v : '');

/** 截断到 n 个字符（Go util.Truncate 对应物），超长以…收尾。 */
export const truncate = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
