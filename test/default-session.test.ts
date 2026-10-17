// 路由兜底落点搬家（2026-10-16 演示实例派发秒败事故）：default session 是
// 路由域概念，从 email.default_session（历史包袱：email 是第一个进件渠道）
// 升顶为顶层 default_session；legacy 回退保存量部署零迁移。单一取值点 =
// effectiveDefaultSession，runtime 装配与 boot 断言都吃它。

import { describe, expect, it } from 'vitest';
import { configSchema, effectiveDefaultSession } from '../src/platform/config/schema.ts';

const cfg = (over: Record<string, unknown> = {}) => configSchema.parse(over);

describe('effectiveDefaultSession（兜底落点单一取值点）', () => {
  it('顶层 default_session 正位', () => {
    const r = effectiveDefaultSession(cfg({ default_session: 'juli-reply' }));
    expect(r).toEqual({ session: 'juli-reply', legacy: false });
  });

  it('顶层空 → legacy email.default_session 回退（存量部署零迁移）', () => {
    const r = effectiveDefaultSession(cfg({ email: { default_session: 'juli-reply' } }));
    expect(r).toEqual({ session: 'juli-reply', legacy: true });
  });

  it('顶层优先于 legacy（搬家完成 + 邮件段未清的过渡态）', () => {
    const r = effectiveDefaultSession(cfg({ default_session: 'new-home', email: { default_session: 'old-home' } }));
    expect(r.session).toBe('new-home');
    expect(r.legacy).toBe(false);
  });

  it('双空 = 路由无兜底（boot 断言腿：agents 非空时必炸）', () => {
    const r = effectiveDefaultSession(cfg({ agents: [{ session: 'juli-reply' }] }));
    expect(r).toEqual({ session: '', legacy: false });
  });

  it('schema 默认值：顶层缺省空串，不惊扰存量 parse', () => {
    expect(cfg().default_session).toBe('');
    expect(cfg().email.default_session).toBe('');
  });
});
