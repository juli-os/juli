// HTTP 共享助手：类型环境 / 数值夹取 / 宽容读体 / 工件分享签名 / inline disposition。
// 分层重构（2026-09-23）：从 app.ts 拆出，路由模块按需引用。

import { createHmac } from 'node:crypto';
import type { Context } from 'hono';
import { safeEqual } from '../platform/shared/secure.ts';
import type { JsonRecord } from '@juli-os/artifacts';

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

/** body 字符串字段提取（R8 批3 收口）：字符串原样，非字符串/缺省 → fallback。
 * 原先 ~50 处 `typeof body['x'] === 'string' ? body['x'] : …` 内联散布 9 个
 * 路由文件——lifecycle 的本件实现升为共享，机械替换同形调用点。 */
export const bodyStr = (body: JsonRecord, key: string, fallback = ''): string =>
  typeof body[key] === 'string' ? body[key] : fallback;

/** inline 文件名 disposition（ascii 兜底 + UTF-8 扩展）：裸 inline 时浏览器按
 * URL 存文件（"content"、无扩展名），下载后本地无法双击打开。artifacts 取件
 * 与客户合同下载两处同形，收口单一实现。 */
export const inlineDisposition = (name: string): string => {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

/** 工件分享链接签名（HMAC(服务密码, id|exp)）：收件人免密取件、限时失效，
 * 密码本体永不出现在 URL（替代 Go 时代的 OSS presign；无 OSS 时的诚实形态）。 */
export const makeShareAuth = (rt: {
  readonly config: { readonly password: string };
  /** 只判在场（null = 开放模式），不耦合 Authenticator 具体接口。 */
  readonly authenticator: unknown;
}) => {
  const SHARE_TTL_SEC = 3600;
  const secret = (): string => rt.config.password || 'open-mode';
  // PB-only 形态（有 authenticator、无本地密码）：'open-mode' 是源码公开常量，
  // 本地签名链可被任意伪造且验签侧恒拒——链接「能签不能开」（收件人必 401）
  // 的功能性死亡。签发侧对称拒绝（sign 抛错 → 分享路由 4xx 人话），不留死链
  // （b46 R1-FX P2#2）。开放模式（authenticator=null）无鉴权面、content 路由
  // 全开放，本地链照签（share 参数形同虚设但链接可开，无回归）；纯密码部署
  // password 非空不触发。
  const pbOnly = (): boolean => rt.config.password === '' && rt.authenticator !== null;
  const sign = (id: string, exp: number): string => {
    if (pbOnly()) {
      throw new Error('分享链接不可用：当前部署未设置本地密码（PB-only 认证），本地签名链已关闭');
    }
    return createHmac('sha256', secret()).update(`${id}|${exp}`).digest('hex').slice(0, 32);
  };
  const verify = (id: string, raw: string | undefined): boolean => {
    if (raw === undefined || raw === '') return false;
    // 无本地密码 = 无 HMAC 秘钥：'open-mode' 是源码公开常量，签名可被任意
    // 伪造——本地签名链拒绝生效（安全闸，比签发侧 pbOnly 更严无妨；开放
    // 模式无鉴权面不依赖此链，无回归）。
    if (rt.config.password === '') return false;
    const [expStr, sig] = raw.split(':');
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || sig === undefined || exp * 1000 < Date.now()) return false;
    return safeEqual(sig, sign(id, exp));
  };
  return { shareTtlSec: SHARE_TTL_SEC, shareSign: sign, shareVerify: verify };
};
