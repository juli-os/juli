// 认证端口：本地密码（单操作员）与 PocketBase token（多用户）是两个实现。
// 中间件按顺序尝试：任一实现确认身份即放行；都拒绝 → 401。

import { timingSafeEqual } from 'node:crypto';
import { safeEqual } from '../shared/secure.ts';
import { ok, toResult, type Result } from '@juli-os/artifacts';

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly role: 'operator' | 'customer';
}

export interface Authenticator {
  readonly mode: string;
  verify(token: string): Promise<Result<AuthUser, Error>>;
}

/** 本地单操作员：token 与配置密码常量时间比对。 */
export const createLocalAuthenticator = (password: string): Authenticator => ({
  mode: 'local',
  async verify(token) {
    if (password === '' || token === '') return { ok: false, error: new Error('local auth failed') };
    if (password === '' || !safeEqual(token, password)) {
      return { ok: false, error: new Error('local auth failed') };
    }
    return ok({ id: 'operator', email: '', role: 'operator' });
  },
});

/** PocketBase token 校验：auth-refresh 端点验证 token 有效性并返回用户。 */
export const createPbAuthenticator = (deps: {
  readonly url: string;
  readonly collection?: string; // 默认 users
  readonly fetchImpl?: typeof fetch;
}): Authenticator => {
  const doFetch = deps.fetchImpl ?? fetch;
  const collection = deps.collection ?? 'users';
  return {
    mode: 'pocketbase',
    async verify(token) {
      const res = await toResult(doFetch(
        `${deps.url.replace(/\/$/, '')}/api/collections/${collection}/auth-refresh`,
        { method: 'POST', headers: { authorization: token, 'content-type': 'application/json' }, body: '{}' },
      ), 'pb auth failed');
      if (!res.ok) return res;
      if (!res.value.ok) return { ok: false, error: new Error(`pb http ${res.value.status}`) };
      const data = await toResult(res.value.json() as Promise<Record<string, unknown>>, 'pb json');
      if (!data.ok) return data;
      const record = data.value['record'] as { id?: string; email?: string } | undefined;
      if (!record?.id) return { ok: false, error: new Error('pb: no user in response') };
      return ok({ id: record.id, email: record.email ?? '', role: 'operator' });
    },
  };
};

/** 组合认证器：按顺序尝试，任一成功即放行。 */
export const createCompositeAuthenticator = (impls: readonly Authenticator[]): Authenticator => ({
  mode: impls.map((i) => i.mode).join('+') || 'none',
  async verify(token) {
    let last: Error = new Error('no authenticator configured');
    for (const impl of impls) {
      const r = await impl.verify(token);
      if (r.ok) return r;
      last = r.error;
    }
    return { ok: false, error: last };
  },
});
