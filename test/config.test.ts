// 配置加载契约：文件缺省容忍、环境变量恒覆盖（JULI_* 优先 MAKRO_* 兜底）、
// 顶层 email_authz_* 是生效键（email 嵌套段是遗留不读——Go 版拿事故换来的
// 结论）。

import { describe, expect, it } from 'vitest';
import { loadConfig, resolveSecret, defaultDataDir, danglingFeedbackRoutes } from '../src/platform/config/schema.ts';

describe('loadConfig', () => {
  it('无文件时给出安全默认（allowlist + 空授权表 = fail-closed）', () => {
    const cfg = loadConfig({ env: {}, home: '/home/test', readFile: () => null });
    expect(cfg.email_authz_mode).toBeUndefined(); // 未配置 → 引擎侧按 allowlist 处理
    expect(cfg.email_authz_allow).toEqual([]);
    expect(cfg.data_dir).toBe(defaultDataDir('/home/test'));
    expect(cfg.listen_host).toBe('127.0.0.1');
  });

  it('读文件 + zod 默认补全', () => {
    const cfg = loadConfig({
      env: {},
      home: '/home/test',
      readFile: () => JSON.stringify({
        llm_provider: 'openai', llm_model: 'glm-5.3',
        email_authz_mode: 'open',
        email: { enabled: true, host: 'imap.example.com', username: 'juli@example.com' },
      }),
    });
    expect(cfg.llm_provider).toBe('openai');
    expect(cfg.email_authz_mode).toBe('open');
    expect(cfg.email.poll_interval_sec).toBe(60); // 默认值
  });

  it('环境变量恒覆盖文件；JULI_* 优先于 MAKRO_*', () => {
    const cfg = loadConfig({
      env: {
        MAKRO_DATA_DIR: '/data/makro',
        JULI_DATA_DIR: '/data/juli',
        JULI_EMAIL_AUTHZ_MODE: 'open',
        JULI_EMAIL_AUTHZ_ALLOW: 'a@x.com, b@y.com',
      },
      home: '/home/test',
      readFile: () => JSON.stringify({ data_dir: '/data/file' }),
    });
    expect(cfg.data_dir).toBe('/data/juli');
    expect(cfg.email_authz_mode).toBe('open');
    expect(cfg.email_authz_allow).toEqual(['a@x.com', 'b@y.com']);
  });

  it('JULI_DATA_DIR 空串作未设（|| 双认）：实读 MAKRO config.json，不与写侧分家', () => {
    const cfg = loadConfig({
      env: { JULI_DATA_DIR: '', MAKRO_DATA_DIR: '/data/makro' },
      home: '/home/test',
      // 旧 `??` 语义会去读默认路径（readFile 返回 null → 全默认），读写分家。
      readFile: (p) => (p === '/data/makro/config.json' ? JSON.stringify({ listen_port: 7071 }) : null),
    });
    expect(cfg.listen_port).toBe(7071);
    expect(cfg.data_dir).toBe('/data/makro'); // envOverrides get 同语义兜出 MAKRO
  });
});

describe('resolveSecret', () => {
  it('环境变量优先于配置值', () => {
    expect(resolveSecret(
      { envValue: 'env-secret', configured: 'file-secret' },
      { run: () => { throw new Error('should not run'); } },
    )).toBe('env-secret');
  });

  it('keychain: 引用经 security CLI 解析', () => {
    const v = resolveSecret(
      { configured: 'keychain: juli-smtp' },
      { run: (cmd) => (cmd.includes('juli-smtp') ? 'real-password\n' : null) },
    );
    expect(v).toBe('real-password'); // security 输出的尾部换行被 trim
  });

  it('字面量直通', () => {
    expect(resolveSecret({ configured: 'plain' }, { run: () => 'x' })).toBe('plain');
  });
});

describe('agents 命名 schema 硬校验（2026-10-12 more structure）', () => {
  const load = (agents: unknown) =>
    loadConfig({ env: {}, home: '/home/test', readFile: () => JSON.stringify({ agents }) });

  it('合规名照常通过：standard 无后缀 + high 孪生成对', () => {
    const cfg = load([
      { session: 'juli-reply' },
      { session: 'juli-dev' },
      { session: 'juli-dev-hi', model_tier: 'high' },
      { session: 'team-research-cases' },
    ]);
    expect(cfg.agents.map((a) => a.session)).toEqual(['juli-reply', 'juli-dev', 'juli-dev-hi', 'team-research-cases']);
  });

  it('非 kebab 名（下划线/大写/空串）→ 配置拒载', () => {
    expect(() => load([{ session: 'juli_dev' }])).toThrow(/命名 schema/);
    expect(() => load([{ session: 'Juli-Dev' }])).toThrow(/命名 schema/);
    expect(() => load([{ session: '' }])).toThrow(/命名 schema/);
  });

  it('后缀 -hi ⟺ model_tier=high，缺一不可', () => {
    expect(() => load([{ session: 'juli-web-hi' }])).toThrow(/-hi 后缀但 model_tier 非 high/);
    expect(() => load([{ session: 'juli-web', model_tier: 'high' }])).toThrow(/high 但会话名不带 -hi/);
  });

  it('-hi 孪生的基名必须在声明表内（改道目标不成对 = 拒载）', () => {
    expect(() => load([{ session: 'juli-eng-hi', model_tier: 'high' }])).toThrow(/孪生基名/);
    expect(() => load([{ session: 'juli-eng' }, { session: 'juli-eng-hi', model_tier: 'high' }])).not.toThrow();
  });
});

describe('danglingFeedbackRoutes（渠道路由卫兵，2026-09-21 死规则事故）', () => {
  const load = (json: unknown) =>
    loadConfig({ env: {}, home: '/home/test', readFile: () => JSON.stringify(json) });

  it('目标会话未声明 → 点名悬空规则；已声明的照常通过', () => {
    const cfg = load({
      agents: [{ session: 'juli-reply' }],
      feedback_routing: { rules: [
        { prefix: '/site', session: 'acme' },
        { prefix: '/x', session: 'juli-reply' },
      ] },
    });
    expect(danglingFeedbackRoutes(cfg)).toEqual([{ prefix: '/site', session: 'acme' }]);
  });

  it('无 feedback_routing / 全部已声明 → 空集', () => {
    expect(danglingFeedbackRoutes(load({}))).toEqual([]);
    expect(danglingFeedbackRoutes(load({
      agents: [{ session: 'acme' }],
      feedback_routing: { rules: [{ prefix: '/site', session: 'acme' }] },
    }))).toEqual([]);
  });
});
