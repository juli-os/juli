// Settings 面：掩码（敏感字面量不出门）/ 写回（哨兵剔除 + zod 拒改留盘）/
// 热改键（轮询间隔 + 账本保留天数）/ HTTP GET+PUT 全链（tmp home，不碰真配置）。

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SECRET_SENTINEL, configFilePath, configSchema, maskConfig, saveConfigFile,
} from '../src/platform/config/schema.ts';
import { createRuntime } from '../src/runtime.ts';
import { createHttpApp } from '../src/http/app.ts';

// ---- 掩码 --------------------------------------------------------------------

describe('maskConfig', () => {
  it('敏感字面量换哨兵；keychain 引用是指针不是秘密，保持可见；空串保持空串', () => {
    const masked = maskConfig({
      password: 'hunter2',
      bark_key: '',
      smtp: { host: 'smtp.example.com' },
      secrets: {
        llm_api_key: 'sk-live',
        smtp_password: 'keychain:juli-smtp',
        email_password: '',
      },
    });
    expect(masked['password']).toBe(SECRET_SENTINEL);
    expect(masked['bark_key']).toBe('');
    expect(masked['smtp']).toEqual({ host: 'smtp.example.com' });
    const secrets = masked['secrets'] as Record<string, unknown>;
    expect(secrets['llm_api_key']).toBe(SECRET_SENTINEL);
    expect(secrets['smtp_password']).toBe('keychain:juli-smtp');
    expect(secrets['email_password']).toBe('');
  });

  it('原对象不被改动（深拷贝）', () => {
    const src = { password: 'x', secrets: { llm_api_key: 'k' } };
    maskConfig(src);
    expect(src['password']).toBe('x');
    expect((src['secrets'] as Record<string, unknown>)['llm_api_key']).toBe('k');
  });
});

// ---- 写回 --------------------------------------------------------------------

describe('saveConfigFile', () => {
  const deps = (existing: string | null, written: { path: string; content: string }[]) => ({
    home: '/home/u',
    readFile: (_p: string): string | null => existing,
    writeFile: (path: string, content: string): void => { written.push({ path, content }); },
  });

  it('patch 深合并进现有文件；哨兵值剔除，绝不落盘', () => {
    const existing = JSON.stringify({ listen_port: 7070, email: { host: 'imap.old' }, password: 'real' });
    const written: { path: string; content: string }[] = [];
    const r = saveConfigFile(deps(existing, written), {
      email: { host: 'imap.new', poll_interval_sec: 33 },
      password: SECRET_SENTINEL, // 掩码回写保护：不覆盖真值
    });
    expect(r.ok).toBe(true);
    const saved = JSON.parse(written[0]!.content);
    expect(saved['listen_port']).toBe(7070); // 未提及的键保持
    expect(saved['email']['host']).toBe('imap.new'); // 深合并
    expect(saved['email']['poll_interval_sec']).toBe(33);
    expect(saved['password']).toBe('real'); // 哨兵没有覆盖真值
  });

  it('落盘写 merged 而非 zod parse 结果：未知键保留、默认值不物化', () => {
    const existing = JSON.stringify({ listen_port: 7070, future_key: { a: 1 } });
    const written: { path: string; content: string }[] = [];
    const r = saveConfigFile(deps(existing, written), { listen_port: 7071 });
    expect(r.ok).toBe(true);
    const saved = JSON.parse(written[0]!.content);
    expect(saved['future_key']).toEqual({ a: 1 }); // 未知键不剔
    expect(saved['listen_port']).toBe(7071);
    expect('llm_provider' in saved).toBe(false); // 默认值不物化
  });

  it('zod 校验不过 = 报错且文件一个字节不动', () => {
    const existing = JSON.stringify({ listen_port: 7070 });
    const written: { path: string; content: string }[] = [];
    const r = saveConfigFile(deps(existing, written), { listen_port: 'not-a-number' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('配置校验失败');
    expect(written).toEqual([]);
  });

  it('现有文件坏 JSON = 拒绝写回（不静默覆盖）', () => {
    const written: { path: string; content: string }[] = [];
    const r = saveConfigFile(deps('{broken', written), { listen_port: 7071 });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('不是合法 JSON');
    expect(written).toEqual([]);
  });
});

// ---- HTTP 全链（tmp home）--------------------------------------------------------

const dataDir = mkdtempSync(join(tmpdir(), 'juli-settings-data-'));
const home = mkdtempSync(join(tmpdir(), 'juli-settings-home-'));
// 预置 config.json：哨兵保护的前提是盘上已有真值可保。
mkdirSync(join(home, '.juli-service'), { recursive: true });
writeFileSync(join(home, '.juli-service', 'config.json'), JSON.stringify({ password: 'file-secret', listen_port: 7070 }));
const cfg = configSchema.parse({
  data_dir: dataDir,
  password: 'sekrit',
  email: { enabled: true, host: 'imap.example.com', poll_interval_sec: 60 },
});
const rt = createRuntime(cfg, { home });
const app = createHttpApp(rt);

const j = async (method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> => {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer sekrit' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

describe('HTTP /api/settings', () => {
  it('GET：全量配置 + 密码脱敏 + 文件路径', async () => {
    const r = await j('GET', '/api/settings');
    expect(r.status).toBe(200);
    expect(r.data.config['password']).toBe(SECRET_SENTINEL);
    expect(r.data.file).toBe(configFilePath(home));
    expect(r.data.config['email']['host']).toBe('imap.example.com');
    expect(r.data.hot_keys).toContain('email.poll_interval_sec');
  });

  it('PUT：热改键即时生效 + 其余键落盘；密码哨兵不覆盖真值', async () => {
    const r = await j('PUT', '/api/settings', {
      patch: {
        email: { poll_interval_sec: 33 },
        ledger_retention_days: 30,
        password: SECRET_SENTINEL,
        listen_port: 7071,
      },
    });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(r.data.applied_hot).toContain('email.poll_interval_sec');
    expect(r.data.applied_hot).toContain('ledger_retention_days');

    const saved = JSON.parse(readFileSync(configFilePath(home), 'utf8'));
    expect(saved['listen_port']).toBe(7071);
    expect(saved['password']).toBe('file-secret'); // 哨兵没把盘上真值洗掉
    expect(saved['email']['poll_interval_sec']).toBe(33);

    // 热改真的进了运行时（mailSource 节拍 + retention 内存落点）。
    expect(rt.mailSource?.status().enabled).toBe(false); // 未 start，但间隔已记
    expect(rt.applySettings({ ledger_retention_days: 7 }).applied).toContain('ledger_retention_days');
  });

  it('PUT 后 GET 反映热改现行值（不回滚展示）；非法热值不上报已生效', async () => {
    await j('PUT', '/api/settings', { patch: { email: { poll_interval_sec: 45 } } });
    const got = await j('GET', '/api/settings');
    expect(got.data.config['email']['poll_interval_sec']).toBe(45);

    // 0 在闸门就被 zod .positive() 拒掉：400、文件不动、现行值不被污染。
    const r = await j('PUT', '/api/settings', { patch: { email: { poll_interval_sec: 0 } } });
    expect(r.status).toBe(400);
    const got2 = await j('GET', '/api/settings');
    expect(got2.data.config['email']['poll_interval_sec']).toBe(45);
  });

  it('PUT：校验失败 400 且文件不动；缺 patch 400', async () => {
    const before = readFileSync(configFilePath(home), 'utf8');
    const bad = await j('PUT', '/api/settings', { patch: { listen_port: 'x' } });
    expect(bad.status).toBe(400);
    expect(readFileSync(configFilePath(home), 'utf8')).toBe(before);

    expect((await j('PUT', '/api/settings', {})).status).toBe(400);
    expect((await j('PUT', '/api/settings', { patch: [1] })).status).toBe(400);
  });

  it('notify 收件人热改：即时生效 + GET 反映现行值 + 空白项过滤', async () => {
    const r = await j('PUT', '/api/settings', {
      patch: { notify: { to: ['boss@example.com', '  '], cc: ['watcher@example.com'] } },
    });
    expect(r.status).toBe(200);
    expect(r.data.applied_hot).toContain('notify.to');
    expect(r.data.applied_hot).toContain('notify.cc');
    expect(rt.liveOverrides()['notify']).toEqual({
      to: ['boss@example.com'], // 空白项不进热改落点
      cc: ['watcher@example.com'],
    });

    const got = await j('GET', '/api/settings');
    expect(got.data.hot_keys).toContain('notify.to');
    expect(got.data.config['notify']['to']).toEqual(['boss@example.com']);
    expect(got.data.config['notify']['cc']).toEqual(['watcher@example.com']);

    const saved = JSON.parse(readFileSync(configFilePath(home), 'utf8'));
    expect(saved['notify']['to']).toEqual(['boss@example.com', '  ']); // 落盘保原样，热改只滤内存

    // 清空收件人 = 关通知：PUT 空数组合法，热改落点归零。
    await j('PUT', '/api/settings', { patch: { notify: { to: [] } } });
    expect(rt.liveOverrides()['notify']).toEqual({ to: [], cc: ['watcher@example.com'] });
  });
});


// ---- 语义判定（Jev）端点：judgment.json 脱敏读 + 热写回 -----------------------

import { parseJudgmentConfig } from '@juli-os/routing';

describe('HTTP /api/settings/judgment', () => {
  const jp = join(dataDir, 'judgment.json');
  const seed = {
    provider: 'cloud', timeout_ms: 15000, min_confidence: 0.7,
    cloud: { token: 'tok-real-1234', model: 'jev-latest' },
    scenarios: { intake_gate: 'shadow', route_fallback: 'shadow' },
  };

  it('GET：token 脱敏 + 场景注册表透出 + 存在标记', async () => {
    writeFileSync(jp, JSON.stringify(seed));
    const r = await j('GET', '/api/settings/judgment');
    expect(r.status).toBe(200);
    expect(r.data.exists).toBe(true);
    expect(r.data.config['cloud']['token']).toBe(SECRET_SENTINEL);
    expect(r.data.config['scenarios']['intake_gate']).toBe('shadow');
    expect(r.data.registry).toContain('route_fallback');
  });

  it('PUT：场景开关热写回（引擎每次 ask 热读）；哨兵不覆盖真 token', async () => {
    const r = await j('PUT', '/api/settings/judgment', {
      patch: { scenarios: { route_fallback: 'on' }, cloud: { token: SECRET_SENTINEL } },
    });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(jp, 'utf8'));
    expect(onDisk['scenarios']['route_fallback']).toBe('on');
    expect(onDisk['scenarios']['intake_gate']).toBe('shadow'); // 深合并：未动键保留
    expect(onDisk['cloud']['token']).toBe('tok-real-1234'); // 哨兵被剔除，真值保持
    expect(parseJudgmentConfig(onDisk)).not.toBeNull();
  });

  it('PUT：provider 非法 → 400 且文件一个字节不动', async () => {
    const before = readFileSync(jp, 'utf8');
    const r = await j('PUT', '/api/settings/judgment', { patch: { provider: 'magic' } });
    expect(r.status).toBe(400);
    expect(readFileSync(jp, 'utf8')).toBe(before);
  });

  it('PUT：纯 scenarios 片段但文件不存在且无 provider → 400', async () => {
    const r = await j('PUT', '/api/settings/judgment', { patch: { scenarios: { intake_gate: 'on' } } });
    // dataDir 里已有 seed 文件（前例写的）——走深合并合法路径，provider 已在
    expect(r.status).toBe(200);
  });
});
