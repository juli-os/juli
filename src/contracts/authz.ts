// 发件人授权（v2 authz）：触发器绝不能对整个互联网开放——否则任意地址
// 都能烧 agent token 并产生出站邮件。
//
// 模型：mode "allowlist"（默认）只放行匹配 allow 模式的发件人；mode "open"
// 放行所有人。两种模式下 deny 都优先。被拒邮件不静默丢弃：仍然建
// workflow（status=rejected，原邮件进 meta）——可审计、可人工恢复。

export const AUTHZ_ALLOWLIST = 'allowlist';
export const AUTHZ_OPEN = 'open';

export interface AuthzPolicy {
  readonly mode: string;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

/** 空策略 = allowlist 无条目 = 全拒（fail-closed 由构造保证）。 */
export const defaultAuthzPolicy: AuthzPolicy = { mode: AUTHZ_ALLOWLIST, allow: [], deny: [] };

/** 渠道策略编译（对齐 Go inbox.Compiled）：渠道无任何规则 = open（渠道不加
 * 额外限制，全局引擎策略兜底）；任一规则翻成 allowlist。 */
export const compileChannelPolicy = (allow: readonly string[], deny: readonly string[]): AuthzPolicy =>
  allow.length === 0 && deny.length === 0
    ? { mode: AUTHZ_OPEN, allow: [], deny: [] }
    : { mode: AUTHZ_ALLOWLIST, allow, deny };

/** 单模式匹配：`*` 全匹配；`*@domain` 匹配整域；其余精确（大小写/空白不敏感）。 */
export const matchPattern = (addr: string, pattern: string): boolean => {
  const a = addr.toLowerCase().trim();
  const p = pattern.toLowerCase().trim();
  if (p === '*') return true;
  if (p.startsWith('*@')) {
    const domain = p.slice(2);
    const at = a.indexOf('@');
    return at >= 0 && a.slice(at + 1) === domain;
  }
  return a === p;
};

/**
 * 授权检查。返回 null = 放行；返回字符串 = 人类可读的拒绝理由
 * （记录进 workflow meta/审计）。
 */
export const checkAuthz = (p: AuthzPolicy, addr: string): string | null => {
  const a = addr.toLowerCase().trim();
  if (a === '') return 'empty sender address';
  for (const d of p.deny) {
    if (matchPattern(a, d)) return `sender ${a} is blacklisted`;
  }
  if (p.mode === AUTHZ_OPEN) return null;
  for (const allow of p.allow) {
    if (matchPattern(a, allow)) return null;
  }
  return `sender ${a} is not on the allowlist (mode=${p.mode})`;
};
