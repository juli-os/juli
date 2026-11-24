// 写侧打标记（2026-11-08 多租户提案 A3）：进件时刻的租户判定纯函数。
// 与 A1 回填判定（platform/config/tenants.ts 的 judgeTenant）的分工：
//   · judgeTenant 吃 meta JSON（存量行只有落库事实可判），四档，回填 CLI 用；
//   · resolveTenant 吃各路进件「已知的明文信号」（发件地址 / 反馈来源 /
//     显式选择 / 会话名），六档，建单时刻用。信号在 createWorkflow 的同一
//     次写入里落 tenant 列与 meta.tenant_basis，无双写窗口。
// 两边不合并：回填历史行，进件新单；判定映射（域名表 / 来源表 / 会话表）
// 全部复用 A1 登记表，绝不造第二套。
//
// 本文件不 import platform/config（arch 白名单 business/workflow 未登记该
// 边，同 tenantScope.ts 先例）：登记表以结构接口（TenantSignalTable）注入，
// runtime 装配侧把 A1 的 TenantTable 适配进来。basis 值取 snake_case，
// meta 现有键全量 snake（template_input/dedup_key/from_name/session_bound/…，
// 2026-11-09 全仓 grep 核实），与 meta.tenant_basis 键名风格一致。
// claimed 不是进件产物：认领端点（POST /api/lifecycle/workflows/:id/tenant）
// 改判时把 basis 覆写为 claimed，记录「这个租户是人认领的不是信号判的」。

export type TenantBasis =
  | 'sender_address' | 'sender_domain' | 'feedback_source'
  | 'explicit' | 'session' | 'default' | 'claimed';

/** 进件信号表：A1 登记表的写侧投影（runtime 适配，判定映射同源）。 */
export interface TenantSignalTable {
  /** 完整发件邮箱（小写）→ 租户 id（A1 bySenderAddress）。 */
  readonly bySenderAddress: Readonly<Record<string, string>>;
  /** 发件域名（小写）→ 租户 id：config 声明 + 内置存量信号（A1 bySenderDomain）。 */
  readonly bySenderDomain: Readonly<Record<string, string>>;
  /** 反馈渠道来源 → 租户 id（A1 byFeedbackSource，内置存量信号 team-pb）。 */
  readonly byFeedbackSource: Readonly<Record<string, string>>;
  /** 会话名 → 租户 id：声明 + 内置老会话别名（A1 bySession）。 */
  readonly bySession: Readonly<Record<string, string>>;
  /** 可落租户全集（A1 stampableTenants）：显式选择的合法性闸。 */
  readonly stampableTenants: ReadonlySet<string>;
  /** 无信号兜底租户（internal）。 */
  readonly defaultTenant: string;
}

/** 各路进件的已知明文信号（plain object，不依赖请求上下文）。缺档留 undefined。 */
export interface TenantSignals {
  /** 发件完整邮箱（邮件进件路）。 */
  readonly senderAddress?: string;
  /** 反馈镜像记录的 source 键（team-pb 等）。 */
  readonly feedbackSource?: string;
  /** 显式租户选择（chat 确认卡；HTTP 边界校验过才进来，此处再对
   * stampableTenants 闸一次，非法值不炸单子，静默落下一档）。 */
  readonly explicit?: string;
  /** 建单时刻已知会话（input.session / 继承链；邮件路由后的兜底补判同款）。 */
  readonly session?: string;
}

export interface TenantResolution {
  readonly tenant: string;
  readonly basis: TenantBasis;
}

/** 发件地址的域名 token（最后一个 @ 之后，小写；容忍 "Name <a@b>" 形态）。 */
const domainOfAddress = (addr: string): string => {
  const at = addr.trim().lastIndexOf('@');
  if (at < 0) return '';
  const m = /^([\w.-]+)/.exec(addr.trim().slice(at + 1).toLowerCase());
  return m !== null ? (m[1] ?? '') : '';
};

/** 表查值（2026-11-11 A-P2-4）：只认自有键、只认字符串。查找键来自外部输入
 * （发件域名是发件人自己写的）：普通对象上查 constructor / __proto__ 会查到
 * 函数或对象，当成「租户」带进 createWorkflow 的 SQLite 绑定就崩——被授权规则
 * 拒掉的信也先走这一步，邮件源对抛错的信不标已读、每轮重试。runtime 注入的表
 * 本身无原型（A1 parseTenantDecls）；这里再守一道，因为本接口是结构注入，
 * 调用方可以给普通对象。 */
const ownTenant = (t: Readonly<Record<string, string>>, key: string): string | undefined => {
  if (key === '' || !Object.hasOwn(t, key)) return undefined;
  const v: unknown = t[key];
  return typeof v === 'string' ? v : undefined;
};

/** 判租户：六档优先级取首个命中。显式租户不在 stampableTenants（声明外越权）
 * 不炸进件、静默落下一档。边界已 400 点名，引擎侧只做纵深防御。 */
export const resolveTenant = (table: TenantSignalTable, signals: TenantSignals): TenantResolution => {
  const addr = (signals.senderAddress ?? '').trim().toLowerCase();
  const byAddr = ownTenant(table.bySenderAddress, addr);
  if (byAddr !== undefined) return { tenant: byAddr, basis: 'sender_address' };
  const byDom = ownTenant(table.bySenderDomain, addr !== '' ? domainOfAddress(addr) : '');
  if (byDom !== undefined) return { tenant: byDom, basis: 'sender_domain' };
  const bySrc = ownTenant(table.byFeedbackSource, (signals.feedbackSource ?? '').trim());
  if (bySrc !== undefined) return { tenant: bySrc, basis: 'feedback_source' };
  const exp = (signals.explicit ?? '').trim();
  if (exp !== '' && table.stampableTenants.has(exp)) return { tenant: exp, basis: 'explicit' };
  const bySess = ownTenant(table.bySession, (signals.session ?? '').trim());
  if (bySess !== undefined) return { tenant: bySess, basis: 'session' };
  return { tenant: table.defaultTenant, basis: 'default' };
};

/** 表未接（缺省单租户形态）= 不 stamp（返回 null）：createWorkflow 不传
 * tenant，store 落缺省 internal，行为与 A3 之前逐字节一致。 */
export const resolveTenantOf = (
  table: TenantSignalTable | undefined,
  signals: TenantSignals,
): TenantResolution | null => (table === undefined ? null : resolveTenant(table, signals));
