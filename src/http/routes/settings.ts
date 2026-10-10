// Settings：全量配置脱敏读 + 写回 config.json + 渠道清单。
// 分层重构（2026-09-23）：自 app.ts 按资源族拆出，路由注册体逐字保留。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Hono } from 'hono';
import {
  configFilePath, maskConfig, mergeConfigPatch, resolveAiConfig, resolveSecret, saveConfigFile,
} from '../../platform/config/schema.ts';
import { createAnthropicChat, createOpenAiChat } from '../../platform/llm/chat.ts';
import { parseJudgmentConfig } from '../../business/routing/judgment.ts';
import { JUDGMENT_SCENARIOS } from '../../contracts/ports.ts';
import type { Runtime } from '../../runtime.ts';
import type { JsonRecord } from '../../platform/shared/json.ts';
import { readBody, type AppEnv } from '../helpers.ts';

/** judgment.json 读盘（缺文件=null；坏 JSON=null 的口径与引擎 loadJudgmentConfig 一致）。 */
const readJudgmentRaw = (p: string): Record<string, unknown> | null => {
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    return d !== null && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** judgment 脱敏：只掩 cloud.token（tokenEnv 是变量名不是秘密）。深拷贝不改原对象。 */
const maskJudgment = (raw: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = structuredClone(raw);
  const cloud = out['cloud'];
  if (cloud !== null && typeof cloud === 'object' && !Array.isArray(cloud)) {
    const c = cloud as Record<string, unknown>;
    if (typeof c['token'] === 'string' && c['token'] !== '') c['token'] = SECRET_SENTINEL_J;
  }
  return out;
};
const SECRET_SENTINEL_J = '__MASKED__';

export const registerSettingsRoutes = (app: Hono<AppEnv>, rt: Runtime): void => {
  // ---- Settings：全量配置脱敏读 + 写回 config.json ------------------------------
  // 热改键（email.poll_interval_sec / ledger_retention_days / notify.to / notify.cc）
  // 经 rt.applySettings 即时生效；其余键落盘、重启生效——诚实边界，不做运行期重装配。
  app.get('/api/settings', (c) => {
    // 热改键的现行值盖在冻结 config 上——否则保存后 GET 仍报旧值，
    // 用户刷新再存会把热值静默回滚。
    const view = mergeConfigPatch(maskConfig(rt.config), rt.liveOverrides());
    return c.json({
      file: configFilePath(rt.home, process.env['JULI_DATA_DIR']),
      config: view,
      hot_keys: ['email.poll_interval_sec', 'ledger_retention_days', 'notify.to', 'notify.cc', 'auto_approve'],
    });
  });

  app.put('/api/settings', async (c) => {
    const body = await readBody(c);
    const patch = body['patch'];
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return c.json({ error: 'patch (object) required' }, 400);
    }
    const saved = saveConfigFile({ home: rt.home, dataDir: process.env['JULI_DATA_DIR'] }, patch);
    if (!saved.ok) return c.json({ error: saved.error }, 400);
    const hot = rt.applySettings(patch as JsonRecord);
    return c.json({ ok: true, applied_hot: hot.applied });
  });

  // ---- 统一 AI 段（2026-10-10 开源 MVP）：状态投影 + 连通性自检 ------------------
  // 状态面给驾驶舱引导态（未配置显眼引导，不静默降级）；自检打一次最小
  // completion（max_tokens 8）——不落账、不写配置。body 可带覆盖值（保存前
  // 先测），空串 = 用现行生效值（env JULI_AI_* > ai 段 > 旧散键）。
  app.get('/api/ai/status', (c) => {
    const ai = resolveAiConfig(rt.config, process.env);
    return c.json({
      configured: ai.apiKey !== '',
      provider: ai.provider,
      model: ai.model,
      base_url_set: ai.baseUrl !== '',
    });
  });

  app.post('/api/ai/check', async (c) => {
    const body = await readBody(c);
    const asString = (k: string): string => (typeof body[k] === 'string' ? (body[k] as string) : '');
    const cur = resolveAiConfig(rt.config, process.env);
    const provider = asString('provider') === 'openai' || asString('provider') === 'anthropic'
      ? (asString('provider') as 'openai' | 'anthropic')
      : cur.provider;
    const keyRaw = asString('api_key');
    const apiKey = keyRaw === '' ? cur.apiKey : resolveSecret({ configured: keyRaw });
    const baseUrl = asString('base_url') || cur.baseUrl;
    const model = asString('model') || cur.model;
    if (apiKey === '') {
      return c.json({ ok: false, error: '未配置 API key——填 ai.api_key（或环境 JULI_AI_API_KEY）后再测' }, 400);
    }
    const port = provider === 'openai'
      ? createOpenAiChat({ apiKey, baseUrl, model })
      : createAnthropicChat({ apiKey, baseUrl, model });
    const t0 = Date.now();
    const r = await port.chat({
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      maxTokens: 8,
      signal: AbortSignal.timeout(20_000),
    });
    const latencyMs = Date.now() - t0;
    if (!r.ok) return c.json({ ok: false, latency_ms: latencyMs, error: r.error.message });
    return c.json({ ok: true, latency_ms: latencyMs, provider, model, reply: r.value.content.slice(0, 40) });
  });

  // ---- 语义判定（Jev）：judgment.json 脱敏读 + 写回（引擎每次 ask 热读，改完即生效）。
  // 与 config.json 的写回同款语义：深合并 + 哨兵剔除（token 留空/哨兵=不变）+
  // parseJudgmentConfig 校验（不过=文件一个字节不动）+ 原子落盘 0600。
  app.get('/api/settings/judgment', (c) => {
    const p = join(rt.config.data_dir, 'judgment.json');
    const raw = readJudgmentRaw(p);
    return c.json({
      file: p,
      exists: raw !== null,
      config: raw === null ? null : maskJudgment(raw),
      registry: JUDGMENT_SCENARIOS,
    });
  });

  app.put('/api/settings/judgment', async (c) => {
    const body = await readBody(c);
    const patch = body['patch'];
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return c.json({ error: 'patch (object) required' }, 400);
    }
    const p = join(rt.config.data_dir, 'judgment.json');
    const current = readJudgmentRaw(p) ?? {};
    const merged = mergeConfigPatch(current, patch as Record<string, unknown>);
    // 首建必须有 provider（纯 scenarios 片段无处挂）。
    if (current['provider'] === undefined && merged['provider'] === undefined) {
      return c.json({ error: 'provider required（首次创建 judgment.json 必须声明提供方）' }, 400);
    }
    const parsed = parseJudgmentConfig(merged);
    if (parsed === null) {
      return c.json({ error: 'judgment 配置校验失败（文件未动）：provider 缺失/非法或结构损坏' }, 400);
    }
    try {
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, p);
    } catch (e) {
      return c.json({ error: `写入失败: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }
    return c.json({ ok: true, hot: true, applied_hot: ['scenarios（引擎每次判定热读，即时生效）'] });
  });

  app.get('/api/channels', (c) => {
    return c.json({
      channels: rt.channels.map((ch) => ({ name: ch.name, ...ch.status() })),
    });
  });

};
