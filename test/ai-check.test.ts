// POST /api/ai/check 的两个洞（2026-11-23 全量审查修复）。此前请求体的 api_key
// 直接交给 resolveSecret，留空则拿**现行真实密钥**去打请求体指定的 base_url：
//   · 写 `keychain:<svc>`：引擎会去读用户钥匙串里的任意条目（配合当时 resolveSecret
//     的命令注入，还能借服务名执行命令——那条已在 schema.ts 另修）；
//   · 换 base_url、密钥留空：调用方填一个自己的地址就能把现行密钥骗走。
// 修后：keychain: 引用直接 400；换了地址必须同时带直接填写的密钥。地址没变
// 时留空照旧可用（保存前先测的既有流程不破）。
// 密闭：node:child_process 的 execFileSync 只拦 /usr/bin/security（记一笔、回
// 假值）——用例退回旧代码时也不会真读钥匙串；globalThis.fetch 换成记录器，
// 「这期间没有向任何地址发出请求」就是看它没被调过。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime } from '../src/runtime.ts';
import { createHttpApp } from '../src/http/app.ts';

const probe = vi.hoisted(() => ({
  security: [] as unknown[], // 每次 security 调用收到的参数数组
  fetches: [] as { url: string; headers: Record<string, string> }[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const realExecFileSync = actual.execFileSync as unknown as (file: string, ...rest: unknown[]) => unknown;
  return {
    ...actual,
    execFileSync: ((file: string, ...rest: unknown[]): unknown =>
      String(file).endsWith('/security')
        ? (probe.security.push(rest[0]), 'FAKE-KEYCHAIN-VALUE\n')
        : realExecFileSync(file, ...rest)) as typeof actual.execFileSync,
  };
});

// 假密钥别写成 sk- 开头的长串：公开导出的红名单按密钥形态拦（export/redlist.yaml）。
const CUR_KEY = 'fake-current-key';
const CUR_URL = 'https://api.current.example';

const dataDir = mkdtempSync(join(tmpdir(), 'juli-ai-check-'));
const home = mkdtempSync(join(tmpdir(), 'juli-ai-check-home-'));
const cfg = configSchema.parse({
  data_dir: dataDir,
  // 死 socket（与 tenant-isolation 同理）：tmux 面恒空/恒失败，测试密闭不读宿主 tmux。
  agent_backend: 'tmux',
  tmux_socket_path: join(dataDir, 'tmux.sock'),
  ai: { provider: 'anthropic', api_key: CUR_KEY, base_url: CUR_URL, model: 'cur-model' },
});
const rt = createRuntime(cfg, { home });
const app = createHttpApp(rt);

const realFetch = globalThis.fetch;
const installFetchRecorder = (): void => {
  globalThis.fetch = (async (input?: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    probe.fetches.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }), { status: 200 });
  });
};

const check = async (body: unknown): Promise<{ status: number; error: unknown; ok: unknown }> => {
  const res = await app.request('/api/ai/check', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null) as { error?: unknown; ok?: unknown } | null;
  return { status: res.status, error: data?.error, ok: data?.ok };
};

describe('POST /api/ai/check', () => {
  // env 清场（与 settings.test 同理）：resolveAiConfig 吃 JULI_AI_* / 旧别名，
  // 开发者本机设了这些键会让「现行密钥 / 现行地址」不是本文件配的那两个。
  const envKeys = [
    'JULI_AI_API_KEY', 'JULI_AI_BASE_URL', 'JULI_AI_MODEL', 'JULI_AI_PROVIDER',
    'JULI_LLM_API_KEY', 'MAKRO_LLM_API_KEY', 'JULI_DATA_DIR', 'MAKRO_DATA_DIR',
  ];
  const savedEnv = new Map(envKeys.map((k) => [k, process.env[k]]));
  beforeAll(() => {
    for (const k of envKeys) delete process.env[k];
  });
  afterAll(() => {
    savedEnv.forEach((v, k) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    rt.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  beforeEach(() => {
    probe.security.length = 0;
    probe.fetches.length = 0;
    installFetchRecorder();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('api_key 写 keychain: 引用 → 400（这里只接受直接填写的密钥）；不读钥匙串、不发请求', async () => {
    const r = await check({ api_key: 'keychain:juli-smtp' });
    expect(r.status).toBe(400);
    expect(String(r.error)).toContain('只接受直接填写的密钥');
    expect(probe.security).toEqual([]); // 没去读钥匙串里的任意条目
    expect(probe.fetches).toEqual([]);
  });

  it('换了接口地址却不带密钥 → 400，且这期间没有向任何地址发出请求（现行密钥不出门）', async () => {
    const r = await check({ base_url: 'https://attacker.example' });
    expect(r.status).toBe(400);
    expect(String(r.error)).toContain('更换接口地址时必须同时填写密钥');
    expect(probe.fetches).toEqual([]);
  });

  it('正常路径：地址不变、密钥留空 → 照旧用现行密钥打现行地址', async () => {
    const r = await check({});
    expect(r.status).toBe(200);
    expect(r.ok).toBe(true);
    expect(probe.fetches).toHaveLength(1);
    expect(probe.fetches[0]!.url).toBe(`${CUR_URL}/v1/messages`);
    expect(probe.fetches[0]!.headers['x-api-key']).toBe(CUR_KEY);
  });

  it('地址没变（原样重填 / 只多一个尾部斜杠）时，密钥留空照旧可用', async () => {
    for (const base_url of [CUR_URL, `${CUR_URL}/`]) {
      probe.fetches.length = 0;
      const r = await check({ base_url });
      expect(r.status, base_url).toBe(200);
      expect(probe.fetches.at(-1)?.url).toBe(`${CUR_URL}/v1/messages`);
    }
  });

  it('换了地址且带了直接填写的密钥 → 放行；发往新地址的是请求里带的密钥，不是现行密钥', async () => {
    const r = await check({ base_url: 'https://new.example/api', api_key: 'fake-typed-in-request' });
    expect(r.status).toBe(200);
    expect(probe.fetches).toHaveLength(1);
    expect(probe.fetches[0]!.url).toBe('https://new.example/api/v1/messages');
    expect(probe.fetches[0]!.headers['x-api-key']).toBe('fake-typed-in-request');
    expect(JSON.stringify(probe.fetches)).not.toContain(CUR_KEY);
  });
});
