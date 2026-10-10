// 安全 JSON 与字符串工具（对应 Go internal/infra/util 的常用面）。

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [k: string]: JsonValue };

export type JsonRecord = { readonly [k: string]: JsonValue };

export const safeParse = (raw: string | null | undefined): JsonValue | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
};

export const asRecord = (v: JsonValue | null | undefined): JsonRecord =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonRecord) : {};

export const asString = (v: JsonValue | undefined): string => (typeof v === 'string' ? v : '');

/** 截断到 n 个字符（Go util.Truncate 对应物），超长以…收尾。 */
export const truncate = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
