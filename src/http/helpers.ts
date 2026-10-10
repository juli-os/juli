// HTTP 共享助手：类型环境 / 数值夹取 / 宽容读体 / 工件分享签名。
// 分层重构（2026-09-23）：从 app.ts 拆出，路由模块按需引用。

import { createHmac } from 'node:crypto';
import type { Context } from 'hono';
import { safeEqual } from '../platform/shared/secure.ts';
import type { JsonRecord } from '../platform/shared/json.ts';

export type AppEnv = { Variables: { user: string } };

/** 数值查询参数夹取：畸形值回退默认，绝不让 NaN 摸进 sqlite 绑定。 */
export const clampInt = (raw: string | undefined, fallback: number, lo: number, hi: number): number => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
};

/** JSON 请求体宽容解析：非对象/坏 JSON 一律回空对象。 */
export const readBody = async (c: Context): Promise<JsonRecord> => {
  try {
    const v: unknown = await c.req.raw.json();
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonRecord) : {};
  } catch {
    return {};
  }
};

/** 工件分享链接签名（HMAC(服务密码, id|exp)）：收件人免密取件、限时失效，
 * 密码本体永不出现在 URL（替代 Go 时代的 OSS presign；无 OSS 时的诚实形态）。 */
export const makeShareAuth = (rt: { readonly config: { readonly password: string } }) => {
  const SHARE_TTL_SEC = 3600;
  const secret = (): string => rt.config.password || 'open-mode';
  const sign = (id: string, exp: number): string =>
    createHmac('sha256', secret()).update(`${id}|${exp}`).digest('hex').slice(0, 32);
  const verify = (id: string, raw: string | undefined): boolean => {
    if (raw === undefined || raw === '') return false;
    const [expStr, sig] = raw.split(':');
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || sig === undefined || exp * 1000 < Date.now()) return false;
    return safeEqual(sig, sign(id, exp));
  };
  return { shareTtlSec: SHARE_TTL_SEC, shareSign: sign, shareVerify: verify };
};
