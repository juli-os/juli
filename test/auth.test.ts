// 认证链契约测试：本地密码常量时间比对、PB token 校验（fetch 注入）、组合顺序。

import { describe, expect, it } from 'vitest';
import {
  createCompositeAuthenticator, createLocalAuthenticator, createPbAuthenticator,
} from '../src/platform/auth/authenticator.ts';

describe('认证链', () => {
  it('本地密码：正确放行 operator，错误拒绝', async () => {
    const auth = createLocalAuthenticator('secret-pw');
    const okR = await auth.verify('secret-pw');
    expect(okR.ok).toBe(true);
    if (okR.ok) expect(okR.value.role).toBe('operator');
    expect((await auth.verify('wrong')).ok).toBe(false);
    expect((await auth.verify('')).ok).toBe(false);
  });

  it('PB token：auth-refresh 验证返回用户', async () => {
    const pb = createPbAuthenticator({
      url: 'https://pb.example.com',
      fetchImpl: (async () => new Response(JSON.stringify({
        record: { id: 'usr_1', email: 'customer@x.com' },
      }), { status: 200 })),
    });
    const r = await pb.verify('any-token');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe('usr_1');
      expect(r.value.email).toBe('customer@x.com');
    }
  });

  it('组合认证器：任一实现确认即放行；全失败返回最后错误', async () => {
    const impls = [
      createLocalAuthenticator('pw-a'),
      createPbAuthenticator({
        url: 'https://pb.example.com',
        fetchImpl: (async (_url: string, init?: { headers?: Record<string, string> }) => {
          const token = init?.headers?.authorization ?? '';
          if (token !== 'pb-token') return new Response('unauthorized', { status: 401 });
          return new Response(JSON.stringify({ record: { id: 'usr_9', email: 'b@x.com' } }), { status: 200 });
        }) as never,
      }),
    ];
    const combo = createCompositeAuthenticator(impls);
    const okR = await combo.verify('pw-a');
    expect(okR.ok).toBe(true);
    // 'pb-token' 会被第二个实现以 200 响应——组合器放行
    const r2 = await combo.verify('pb-token');
    expect(r2.ok).toBe(true);
    expect((await combo.verify('nope')).ok).toBe(false); // 两实现都拒
  });
});
