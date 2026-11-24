// 发件人授权的两层热改（2026-11-23 全量审查修复）。授权有两层：邮件源收信
// 第一步的渠道闸（阶段一过滤，被拒的邮件直接跳过——不建单、不留痕，只有一行
// 日志）和引擎的全局策略（被拒的建 rejected 单，可审计）。此前两层只在装配时
// 对齐一次：授权面板 POST 只换引擎那层，设置页 PUT 只落盘，渠道闸仍是启动时
// 编译的旧策略——面板提示「即时生效」，新加的地址却继续被第一层挡掉，要重启
// 才生效。既有测试走的是 /api/email/simulate（直达引擎，绕过渠道闸），所以
// 一直是绿的。
//
// 同一批还修了 compileChannelPolicy 不看 mode：模式设成 open 而名单里有内容
// 时，渠道闸被翻成白名单，open 的语义是「除黑名单外都放行」，实际却是所有人
// 被渠道闸拒掉。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAuthz, compileChannelPolicy, type AuthzPolicy } from '../src/contracts/authz.ts';
import { configFilePath, configSchema } from '../src/platform/config/schema.ts';
import type { MailSource } from '../src/platform/email/source.ts';
import { createRuntime, type Runtime, type RuntimeSeams } from '../src/runtime.ts';
import { createHttpApp } from '../src/http/app.ts';

// ---- 渠道策略编译 ---------------------------------------------------------------

describe('compileChannelPolicy（带 mode）', () => {
  it('open + 只有黑名单：黑名单内的拒、名单外的放行', () => {
    const p = compileChannelPolicy('open', [], ['*@spam.io']);
    expect(p.mode).toBe('open');
    expect(checkAuthz(p, 'ad@spam.io')).toContain('blacklisted');
    expect(checkAuthz(p, 'stranger@anywhere.io')).toBeNull();
  });

  it('open + 有白名单：照样放行（open 模式下白名单不起作用）', () => {
    const p = compileChannelPolicy('open', ['only@this.io'], []);
    expect(p.mode).toBe('open');
    expect(checkAuthz(p, 'only@this.io')).toBeNull();
    expect(checkAuthz(p, 'other@elsewhere.io')).toBeNull();
  });

  it('allowlist + 白名单：现有行为不变（名单外被渠道闸拒）', () => {
    const p = compileChannelPolicy('allowlist', ['a@x.io'], ['b@x.io']);
    expect(p).toEqual({ mode: 'allowlist', allow: ['a@x.io'], deny: ['b@x.io'] });
    expect(checkAuthz(p, 'a@x.io')).toBeNull();
    expect(checkAuthz(p, 'b@x.io')).toContain('blacklisted');
    expect(checkAuthz(p, 'c@x.io')).toContain('not on the allowlist');
  });

  it('mode 没写（配置缺省）：按 allowlist 的既有口径——无规则 = 渠道不加限制，有规则翻白名单', () => {
    expect(compileChannelPolicy(undefined, [], [])).toEqual({ mode: 'open', allow: [], deny: [] });
    expect(compileChannelPolicy(undefined, ['a@x.io'], [])).toEqual({ mode: 'allowlist', allow: ['a@x.io'], deny: [] });
  });
});

// ---- 两条热改路径 ----------------------------------------------------------------

/** 可观察的假邮件源：只记录收到的渠道策略——运行时有没有把新策略送到渠道闸。 */
const fakeMailSource = (): { source: MailSource; received: AuthzPolicy[] } => {
  const received: AuthzPolicy[] = [];
  const source: MailSource = {
    name: 'email',
    pollOnce: async () => undefined,
    start() {},
    stop() {},
    status: () => ({ enabled: false, lastPoll: null, lastOk: null, lastError: '', processed: 0 }),
    setIntervalSec: () => true,
    setAuthzPolicy: (policy) => { received.push(policy); },
  };
  return { source, received };
};

describe('发件人授权热改：渠道闸与引擎策略同时更新', () => {
  // env 清场：PUT 落盘定位、热改重读生效值（loadConfig）都吃本机 env——开发者
  // 设了这些键时，热改读到的就不是测试写进 tmp home 的值。恢复在 afterAll。
  const envKeys = ['JULI_DATA_DIR', 'MAKRO_DATA_DIR', 'JULI_EMAIL_AUTHZ_MODE', 'JULI_EMAIL_AUTHZ_ALLOW', 'JULI_EMAIL_AUTHZ_DENY'];
  const savedEnv = new Map(envKeys.map((k) => [k, process.env[k]]));
  const dirs: string[] = [];
  beforeAll(() => {
    for (const k of envKeys) delete process.env[k];
  });
  afterAll(() => {
    savedEnv.forEach((v, k) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  interface World {
    readonly rt: Runtime;
    readonly received: AuthzPolicy[];
    readonly home: string;
    call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }>;
  }
  const build = (over: Record<string, unknown> = {}): World => {
    const dataDir = mkdtempSync(join(tmpdir(), 'juli-authz-data-'));
    const home = mkdtempSync(join(tmpdir(), 'juli-authz-home-'));
    dirs.push(dataDir, home);
    const fake = fakeMailSource();
    const rt = createRuntime(configSchema.parse({
      data_dir: dataDir,
      // 邮件源要被装配（email_enabled + host 非空），注入缝才顶替真源。
      email_enabled: true, email: { host: 'imap.test', username: 'inbox@corp.io' },
      ...over,
    }), { home, mailSource: fake.source } satisfies RuntimeSeams);
    const app = createHttpApp(rt);
    const call = async (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, data: await res.json().catch(() => ({})) as Record<string, unknown> };
    };
    return { rt, received: fake.received, home, call };
  };

  it('POST /api/pipeline/authz：新策略同时送到引擎和邮件源（渠道闸）', async () => {
    const w = build();
    const r = await w.call('POST', '/api/pipeline/authz', { mode: 'allowlist', allow: ['new@x.io'], deny: ['bad@x.io'] });
    expect(r.status).toBe(200);
    // 渠道闸：面板新加的地址下一轮轮询就放行（修复前这里一条都没收到——
    // 新地址继续被第一层挡掉，邮件被跳过且不留痕）。
    expect(w.received.at(-1)).toEqual({ mode: 'allowlist', allow: ['new@x.io'], deny: ['bad@x.io'] });
    // 引擎策略：与渠道闸同一份。
    expect(w.rt.engine.currentAuthz()).toEqual({ mode: 'allowlist', allow: ['new@x.io'], deny: ['bad@x.io'] });
  });

  it('POST open 模式：渠道闸拿到 open 策略（黑名单生效，白名单不下发）', async () => {
    const w = build();
    await w.call('POST', '/api/pipeline/authz', { mode: 'open', allow: ['a@x.io'], deny: ['*@spam.io'] });
    expect(w.rt.engine.currentAuthz()).toEqual({ mode: 'open', allow: ['a@x.io'], deny: ['*@spam.io'] });
    expect(w.received.at(-1)).toEqual({ mode: 'open', allow: [], deny: ['*@spam.io'] });
  });

  it('PUT /api/settings 带 email_authz_*：按落盘后的生效值同时更新两层', async () => {
    const w = build();
    const r = await w.call('PUT', '/api/settings', {
      patch: { email_authz_mode: 'open', email_authz_allow: ['a@x.io'], email_authz_deny: ['*@spam.io'] },
    });
    expect(r.status).toBe(200);
    expect(w.rt.engine.currentAuthz()).toEqual({ mode: 'open', allow: ['a@x.io'], deny: ['*@spam.io'] });
    expect(w.received.at(-1)).toEqual({ mode: 'open', allow: [], deny: ['*@spam.io'] });
    // 返回面如实：三个键都算「已生效」；盘上也是这份值（重启不丢）。
    const applied = r.data['applied_hot'] as string[];
    for (const k of ['email_authz_mode', 'email_authz_allow', 'email_authz_deny']) expect(applied).toContain(k);
    const saved = JSON.parse(readFileSync(configFilePath(w.home), 'utf8')) as Record<string, unknown>;
    expect(saved['email_authz_mode']).toBe('open');
    // GET 投影反映现行值（不回滚展示）。
    const got = await w.call('GET', '/api/settings');
    expect((got.data['config'] as Record<string, unknown>)['email_authz_mode']).toBe('open');
  });

  it('PUT 只带其中一个键：其余键取盘上的生效值，不拿 patch 自己拼', async () => {
    const w = build();
    await w.call('PUT', '/api/settings', { patch: { email_authz_allow: ['a@x.io'] } });
    // 第二次保存只动黑名单——白名单必须还是上一次落盘的那份。
    await w.call('PUT', '/api/settings', { patch: { email_authz_deny: ['b@x.io'] } });
    expect(w.rt.engine.currentAuthz()).toEqual({ mode: 'allowlist', allow: ['a@x.io'], deny: ['b@x.io'] });
    expect(w.received.at(-1)).toEqual({ mode: 'allowlist', allow: ['a@x.io'], deny: ['b@x.io'] });
  });

  it('PUT 不带授权键：不碰两层', async () => {
    const w = build();
    await w.call('PUT', '/api/settings', { patch: { ledger_retention_days: 3 } });
    expect(w.received).toEqual([]);
    expect(w.rt.engine.currentAuthz()).toEqual({ mode: 'allowlist', allow: [], deny: [] });
  });
});
