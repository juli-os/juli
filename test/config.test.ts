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
