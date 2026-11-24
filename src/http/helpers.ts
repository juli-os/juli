// HTTP 共享助手：类型环境 / 数值夹取 / 宽容读体 / 工件分享签名 / inline disposition。
// 分层重构（2026-09-23）：从 app.ts 拆出，路由模块按需引用。

import { createHmac } from 'node:crypto';
import type { Context } from 'hono';
import { safeEqual } from '../platform/shared/secure.ts';
import { type JsonRecord } from '../platform/shared/json.ts';
import type { TenantScope } from '../business/workflow/tenantScope.ts';

export type AppEnv = { Variables: { user: string; tenantScope: TenantScope | null } };

/** 请求租户（A2 读侧边界）：中间件已解析并挂到 context；取不到（未过中间件
 * 的装配形态）按 all 处理——operator 形态绝不因缺键收窄。 */
export const tenantScopeOf = (c: Context<AppEnv>): TenantScope => c.get('tenantScope') ?? { kind: 'all' };

/** scope=one 时的租户 id（all 返回 undefined）——读 API 下推过滤的取值面。 */
export const tenantFilterOf = (c: Context<AppEnv>): string | undefined => {
  const s = tenantScopeOf(c);
  return s.kind === 'one' ? s.tenant : undefined;
};

/** 运营面守卫（A2，2026-11-09）：one 身份一律 404——这些端点是 operator 专用
 * 面（全租户聚合/系统级状态/客户档案池），无逐条租户归属信号，逐租户精细
 * 归属是 follow-up，不做过度设计。有意豁免（连 404 都不加）的运营面清单见
 * tenantScope.ts 头注。all（operator 缺省）行为零变化。 */
export const operatorFaceBlocked = (c: Context<AppEnv>): boolean =>
  tenantScopeOf(c).kind === 'one';

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

/** 内联直开响应的浏览器安全头（2026-11-23 全量审查修复）。工件取件与客户合同
 *  下载把 html、svg 以内联方式同源返回，此前不带任何限制——文件里的脚本就在
 *  引擎的源上运行，持密码的页面能调的 API 它都能调。两条头：
 *  · nosniff 对所有类型都加：浏览器不得脱离声明的 Content-Type 去猜类型。
 *  · CSP sandbox 只加在浏览器会当「可执行文档」渲染的类型上（html /
 *    xhtml / svg / xml——xml 文档里能嵌 xhtml 命名空间的脚本，同样会执行；
 *    R1 复审补）。PDF、图片、Office 文档、JSON、纯文本不加——它们不是脚本
 *    执行面，加了反而影响 iPhone QuickLook 与浏览器的直接预览。
 *    sandbox 之内：脚本一律不许（default-src 'none' 挡掉 script-src）；放行
 *    内联样式与内嵌图片（style-src 'unsafe-inline' + img-src data:/blob:）
 *    ——样式不是脚本入口，全挡会让直接打开的工件没了样式。不放开网络加载
 *    （外链图片、字体、样式表），页面不替工件对外发请求。
 *  contentType 传完整 Content-Type（带 charset 参数也行），类型判断只看主类型。
 *  与 inlineDisposition 同样的收口：artifacts.ts 与 customers.ts 两处同用。 */
const SCRIPTED_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/xml', 'text/xml',
]);

export const inlineContentSecurityHeaders = (contentType: string): Record<string, string> => {
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return {
    'x-content-type-options': 'nosniff',
    ...(SCRIPTED_MEDIA_TYPES.has(mediaType)
      ? { 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:" }
      : {}),
  };
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

// ---- 写面租户闸与租户事件查询（2026-11-11 R&F R1）--------------------------------

/** 建单入参闸依赖的最小结构（Runtime 的投影——helpers 不 import runtime）。 */
export interface CreateGateDeps {
  readonly tenants: {
    readonly byFeedbackSource: Readonly<Record<string, string>>;
    readonly bySession: Readonly<Record<string, string>>;
  };
  readonly store: { readonly getWorkflow: (id: string) => { readonly tenant: string } | null };
}

/** 表查值：只认自有键、只认字符串（A-P2-4）。 */
const ownTenant = (t: Readonly<Record<string, string>>, key: string): string | undefined => {
  if (key === '' || !Object.hasOwn(t, key)) return undefined;
  const v: unknown = t[key];
  return typeof v === 'string' ? v : undefined;
};

/** body 里钉的会话名（改派/重试补丁/追加节点/建单/补料 patch 的落点）是否越租户。
 * one 身份只能钉本租户会话：不拦的话「往他租户终端发文本」能借本租户单子绕回来——把
 * 自己的单改派到别家会话，任务卡照样打进别家终端。未声明的会话与他租户会话
 * 同文拒绝（不泄露会话在否）。返回错误文案，'' = 放行。
 * 钉会话键扫三处两键（NEW-1，2026-11-11 R2）：body 顶层（override/assign/retry）、
 * body.input（nodes/tasks/pipelines——步 input 的 session 与 resolved_session 都
 * 是派发落点，steps.ts 重派跟随 resolved_session）、body.patch（amend 的补丁全量
 * 写进步 input，human.ts setStepInput 不挑键）——R1 只查了前两处的 session，
 * amend 的 patch.session 实测 200 落库重派，patch/resolved_session 三处同等对待。 */
export const foreignSessionError = (c: Context<AppEnv>, deps: CreateGateDeps, body: JsonRecord): string => {
  const scope = tenantScopeOf(c);
  if (scope.kind === 'all') return '';
  const sessionKeysOf = (obj: unknown): readonly unknown[] => {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return [];
    const r = obj as JsonRecord;
    return [r['session'], r['resolved_session']];
  };
  for (const raw of [body['session'], ...sessionKeysOf(body['input']), ...sessionKeysOf(body['patch'])]) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name === '') continue;
    if (ownTenant(deps.tenants.bySession, name) !== scope.tenant) {
      return `会话 "${name}" 不属于本租户——单租户身份只能派到本租户的会话`;
    }
  }
  return '';
};

/** one 身份建单的入参闸：请求租户当显式租户。显式 tenant 必须是本租户；source
 * （反馈来源信号，判定优先级高于显式）不许指向他租户；relates_to 必须是本租户
 * 的单子——挂靠会继承原单的会话与反馈锚，他租户的单不能当来源（不存在同文
 * 拒绝，不泄露在否）。返回补上 tenant 的 input。调用方以 throw 把文案带成 400。 */
export const pinTenantCreateInput = (tenant: string, deps: CreateGateDeps, input: JsonRecord): JsonRecord => {
  const str = (k: string): string => (typeof input[k] === 'string' ? (input[k]).trim() : '');
  const exp = str('tenant');
  if (exp !== '' && exp !== tenant) {
    throw new Error(`单租户身份只能给本租户开单（请求租户 ${tenant}，显式租户 ${exp}）`);
  }
  const srcOwner = ownTenant(deps.tenants.byFeedbackSource, str('source'));
  if (srcOwner !== undefined && srcOwner !== tenant) {
    throw new Error('单租户身份只能给本租户开单（入参带有指向其他租户的进件信号）');
  }
  const rel = str('relates_to');
  if (rel !== '' && deps.store.getWorkflow(rel)?.tenant !== tenant) {
    throw new Error('关联单不存在或不可见——单租户身份只能关联本租户的单子');
  }
  return { ...input, tenant };
};


