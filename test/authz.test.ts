// 发件人授权策略（v2 authz）的契约测试。锁死的规则：deny 优先；allowlist
// 空表 fail-closed；`*` 与 `*@domain` 模式；拒绝理由人类可读可入账。

import { describe, expect, it } from 'vitest';
import { checkAuthz, defaultAuthzPolicy, matchPattern } from '../src/contracts/authz.ts';

const policy = (over: Partial<{ mode: string; allow: string[]; deny: string[] }> = {}) => ({
  ...defaultAuthzPolicy,
  allow: [] as string[],
  deny: [] as string[],
  ...over,
});

describe('matchPattern', () => {
  it('全匹配模式 *', () => {
    expect(matchPattern('any@x.com', '*')).toBe(true);
  });

  it('*@domain 匹配整域、不跨域', () => {
    expect(matchPattern('a@Example.COM', '*@example.com')).toBe(true);
    expect(matchPattern('a@example.com.evil.io', '*@example.com')).toBe(false);
    expect(matchPattern('no-at-sign', '*@example.com')).toBe(false);
  });

  it('精确匹配（大小写与空白不敏感）', () => {
    expect(matchPattern('  Boss@Example.com ', 'boss@example.com')).toBe(true);
    expect(matchPattern('boss2@example.com', 'boss@example.com')).toBe(false);
  });
});

describe('checkAuthz', () => {
  it('allowlist 模式：表内放行', () => {
    const p = policy({ allow: ['boss@example.com', '*@partner.io'] });
    expect(checkAuthz(p, 'boss@example.com')).toBeNull();
    expect(checkAuthz(p, 'any@partner.io')).toBeNull();
  });

  it('allowlist 模式：空表 fail-closed 全拒', () => {
    const reason = checkAuthz(policy(), 'anyone@anywhere.io');
    expect(reason).toContain('not on the allowlist');
  });

  it('deny 优先于 allow（哪怕同时命中）', () => {
    const p = policy({ allow: ['*@example.com'], deny: ['bad@example.com'] });
    expect(checkAuthz(p, 'good@example.com')).toBeNull();
    expect(checkAuthz(p, 'bad@example.com')).toContain('blacklisted');
  });

  it('open 模式放行所有人，但 deny 仍然优先', () => {
    const p = policy({ mode: 'open', deny: ['*@spammers.io'] });
    expect(checkAuthz(p, 'stranger@nowhere.io')).toBeNull();
    expect(checkAuthz(p, 'x@spammers.io')).toContain('blacklisted');
  });

  it('空地址拒绝', () => {
    expect(checkAuthz(policy({ mode: 'open' }), '  ')).toContain('empty sender');
  });
});
