// 统一 AI 段（2026-10-10 开源 MVP）契约：一处配置两处用（引擎 LLM + agent
// 执行环境注入）。解析优先级 env（JULI_AI_*）> config.ai > 旧散键
// （llm_* / secrets.llm_api_key）；JULI_DATA_DIR 置位时配置文件跟随数据卷
// （容器重建不丢配置）；ai.api_key 是掩码键。

import { describe, expect, it } from 'vitest';
import {
  configFilePath, configSchema, loadConfig, maskConfig, resolveAiConfig, saveConfigFile, SECRET_SENTINEL,
} from '../src/platform/config/schema.ts';

const baseCfg = (over: Record<string, unknown> = {}): Parameters<typeof resolveAiConfig>[0] =>
  configSchema.parse(over);

describe('resolveAiConfig（统一 AI 段解析）', () => {
  it('空 ai 段 = 旧散键直通（存量部署零迁移）', () => {
    const cfg = baseCfg({
      llm_provider: 'openai', llm_model: 'glm-5.3', llm_base_url: 'https://bigmodel.cn/api',
      secrets: { llm_api_key: 'legacy-key' },
    });
    const ai = resolveAiConfig(cfg, {});
    expect(ai).toEqual({
      provider: 'openai', apiKey: 'legacy-key',
      baseUrl: 'https://bigmodel.cn/api', model: 'glm-5.3',
    });
  });

  it('ai 段压过旧散键；provider 空串继承 llm_provider', () => {
    const cfg = baseCfg({
      llm_provider: 'openai', llm_model: 'legacy-model',
      secrets: { llm_api_key: 'legacy-key' },
      ai: { provider: '', api_key: 'ai-key', base_url: 'https://proxy.example', model: 'claude-x' },
    });
    const ai = resolveAiConfig(cfg, {});
    expect(ai.provider).toBe('openai'); // 继承
    expect(ai.apiKey).toBe('ai-key');
    expect(ai.baseUrl).toBe('https://proxy.example');
    expect(ai.model).toBe('claude-x');
  });

  it('ai.provider 显式声明时不再继承（anthropic 覆盖 openai）', () => {
    const cfg = baseCfg({ llm_provider: 'openai', ai: { provider: 'anthropic', api_key: 'k' } });
    expect(resolveAiConfig(cfg, {}).provider).toBe('anthropic');
  });

  it('env（JULI_AI_*）压过一切；旧 env 别名 JULI_LLM_API_KEY 兜底', () => {
    const cfg = baseCfg({
      secrets: { llm_api_key: 'legacy-key' },
      ai: { api_key: 'ai-key', model: 'ai-model' },
    });
    expect(resolveAiConfig(cfg, { JULI_AI_API_KEY: 'env-key', JULI_AI_MODEL: 'env-model' }))
      .toMatchObject({ apiKey: 'env-key', model: 'env-model' });
    expect(resolveAiConfig({ ...cfg, ai: { ...cfg.ai, api_key: '' } }, { JULI_LLM_API_KEY: 'legacy-env' }).apiKey)
      .toBe('legacy-env');
  });

  it('全空 = 未配置（apiKey 空串，驾驶舱引导态）', () => {
    expect(resolveAiConfig(baseCfg(), {}).apiKey).toBe('');
  });
});

describe('ai 段掩码与写回', () => {
  it('maskConfig 掩 ai.api_key（空串保持空——「没配」不是秘密）', () => {
    const cfg = baseCfg({ ai: { api_key: 'sk-secret', model: 'm' } });
    const masked = maskConfig(cfg) as { ai: { api_key: string; model: string } };
    expect(masked.ai.api_key).toBe(SECRET_SENTINEL);
    expect(masked.ai.model).toBe('m');
    expect(masked).not.toBe(cfg);
  });

  it('saveConfigFile 写 ai 段 + 掩码哨兵剔除（GET 回显体直接 PUT 不泄不毁）', () => {
    const files = new Map<string, string>();
    files.set('/data/config.json', JSON.stringify({ ai: { api_key: 'old', model: 'm0' } }));
    const r = saveConfigFile(
      { home: '/home/test', dataDir: '/data', readFile: (p) => files.get(p) ?? null, writeFile: (p, c) => files.set(p, c) },
      { ai: { api_key: SECRET_SENTINEL, model: 'm1' } },
    );
    expect(r.ok).toBe(true);
    const saved = JSON.parse(files.get('/data/config.json')!) as { ai: { api_key: string; model: string } };
    expect(saved.ai.api_key).toBe('old'); // 哨兵剔除=保持不变
    expect(saved.ai.model).toBe('m1');
  });
});

describe('configFilePath 跟随 JULI_DATA_DIR（容器形态配置不丢）', () => {
  it('env 置位 → 配置文件进数据卷', () => {
    expect(configFilePath('/home/test', '/data')).toBe('/data/config.json');
    expect(configFilePath('/home/test', '/data/')).toBe('/data/config.json');
  });

  it('env 未设 → 本机形态 ~/.juli-service 不变', () => {
    expect(configFilePath('/home/test')).toBe('/home/test/.juli-service/config.json');
    expect(configFilePath('/home/test', undefined)).toBe('/home/test/.juli-service/config.json');
  });

  it('loadConfig 按 JULI_DATA_DIR 定位读文件', () => {
    const seen: string[] = [];
    const cfg = loadConfig({
      env: { JULI_DATA_DIR: '/data' },
      home: '/home/test',
      readFile: (p) => { seen.push(p); return JSON.stringify({ ai: { api_key: 'k' } }); },
    });
    expect(seen).toEqual(['/data/config.json']);
    expect(cfg.ai.api_key).toBe('k');
  });
});
