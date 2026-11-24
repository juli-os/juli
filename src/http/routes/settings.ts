// Settings：全量配置脱敏读 + 写回 config.json + 渠道清单。
// 分层重构（2026-09-23）：自 app.ts 按资源族拆出，路由注册体逐字保留。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Hono } from 'hono';
import {
  configFilePath, maskConfig, mergeConfigPatch, resolveAiConfig, saveConfigFile,
  SECRET_SENTINEL,
} from '../../platform/config/schema.ts';
import { createAnthropicChat, createOpenAiChat } from '../../platform/llm/chat.ts';
import { parseJudgmentConfig } from '@juli-os/routing';
import { JUDGMENT_SCENARIOS } from '@juli-os/routing';
import type { Runtime } from '../../runtime.ts';
import { type JsonRecord } from '../../platform/shared/json.ts';
import { bodyStr, operatorFaceBlocked, readBody, type AppEnv } from '../helpers.ts';

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

/** judgment 脱敏：只掩 cloud.token（tokenEnv 是变量名不是秘密）。深拷贝不改原对象。
 * 哨兵与 config 脱敏同一常量（schema.ts SECRET_SENTINEL）——PUT 侧
 * mergeConfigPatch 靠字符串相等剔哨兵，两处定义漂移即掩码值透传落盘。 */
const maskJudgment = (raw: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = structuredClone(raw);
  const cloud = out['cloud'];
  if (cloud !== null && typeof cloud === 'object' && !Array.isArray(cloud)) {
    const c = cloud as Record<string, unknown>;
    if (typeof c['token'] === 'string' && c['token'] !== '') c['token'] = SECRET_SENTINEL;
  }
  return out;
};

export const registerSettingsRoutes = (app: Hono<AppEnv>, rt: Runtime): void => {
  // ---- Settings：全量配置脱敏读 + 写回 config.json ------------------------------
  // 热改键（email.poll_interval_sec / ledger_retention_days / notify.to / notify.cc）
  // 经 rt.applySettings 即时生效；其余键落盘、重启生效——诚实边界，不做运行期重装配。
  // 运营面（A-P1-5）：settings 读写与 judgment 读写对 one 身份 404。全量配置里
  // 有完整的 tenants 声明（各家的发件域/地址/agent 清单），/api/tenants 特意
  // 只给 id、名字、herdr_session——租户视角拿到全量配置等于绕过那层收窄；写回
  // 更不能开（改的就是租户声明本身）。all（operator）原样。
  app.get('/api/settings', (c) => {
    if (operatorFaceBlocked(c)) return c.json({ error: 'not found' }, 404);
    // 热改键的现行值盖在冻结 config 上——否则保存后 GET 仍报旧值，
    // 用户刷新再存会把热值静默回滚。
    const view = mergeConfigPatch(maskConfig(rt.config), rt.liveOverrides());
    return c.json({
      // 展示路径与下方 PUT 落盘定位同款双认——展示的必须是实写的那个文件。
      file: configFilePath(rt.home, process.env['JULI_DATA_DIR'] || process.env['MAKRO_DATA_DIR']),
      config: view,
      hot_keys: ['email.poll_interval_sec', 'ledger_retention_days', 'notify.to', 'notify.cc', 'auto_approve', 'queue.concurrency'],
    });
  });

  app.put('/api/settings', async (c) => {
    if (operatorFaceBlocked(c)) return c.json({ error: 'not found' }, 404);
    const body = await readBody(c);
    const patch = body['patch'];
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return c.json({ error: 'patch (object) required' }, 400);
    }
    // dataDir 双认（JULI 非空优先 → MAKRO → 默认），与引擎 boot 的 config
    // 定位（schema.ts loadConfig）、cli dataDirEnv 同语义——MAKRO_* 迁移用户
    // 的 Settings 改动必须落回引擎读的同一 config.json，否则重启即丢。
    const saved = saveConfigFile(
      { home: rt.home, dataDir: process.env['JULI_DATA_DIR'] || process.env['MAKRO_DATA_DIR'] },
      patch,
    );
    if (!saved.ok) return c.json({ error: saved.error }, 400);
    const hot = rt.applySettings(patch as JsonRecord);
    return c.json({ ok: true, applied_hot: hot.applied });
  });

  // ---- 统一 AI 段（2026-10-10 开源 MVP）：状态投影 + 连通性自检 ------------------
  // 状态面给驾驶舱引导态（未配置显眼引导，不静默降级）；自检打一次最小
  // completion（max_tokens 32）——不落账、不写配置。body 可带覆盖值（保存前
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
    // str() 收口（R8 批3）：原内联 body 版清洗与 bodyStr 同形（静默空串）——
    // 并入共享实现，语义逐字不变。
    const asString = (k: string): string => bodyStr(body, k);
    const cur = resolveAiConfig(rt.config, process.env);
    const providerRaw = asString('provider');
    const provider = providerRaw === 'openai' || providerRaw === 'anthropic' ? providerRaw : cur.provider;
    const keyRaw = asString('api_key');
    const baseUrlRaw = asString('base_url');
    // 2026-11-23 全量审查修复：这个口此前把 api_key 交给 resolveSecret、留空则拿
    // **现行真实密钥**去打请求体给的 base_url。两条边界：
    // ① `keychain:` 引用直接拒——否则持密码的人能让引擎去读用户钥匙串里的任意
    //    条目。本口只认直接填写的字面量，不碰钥匙串（所以也不再调 resolveSecret）。
    if (keyRaw.startsWith('keychain:')) {
      return c.json({ ok: false, error: '这里只接受直接填写的密钥——不解析 keychain: 引用（留空 = 用现行配置）' }, 400);
    }
    // ② 换了接口地址却没带密钥时直接拒——留空的语义是「用现行密钥」，不拦的话
    //    调用方填一个自己的地址就能把现行密钥骗走。地址没变时留空照旧可用。
    //    尾部斜杠不算地址变化：chat port 拼请求地址时同样只去掉一个尾部斜杠，
    //    两边同一口径，「判定为没变」才等于「请求真的发往同一个地址」。
    const stripSlash = (u: string): string => u.replace(/\/$/, '');
    if (keyRaw === '' && baseUrlRaw !== '' && stripSlash(baseUrlRaw) !== stripSlash(cur.baseUrl)) {
      return c.json({ ok: false, error: '更换接口地址时必须同时填写密钥——留空会把现行密钥发往新地址' }, 400);
    }
    const apiKey = keyRaw === '' ? cur.apiKey : keyRaw;
    const baseUrl = baseUrlRaw === '' ? cur.baseUrl : baseUrlRaw;
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
      maxTokens: 32,
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
    if (operatorFaceBlocked(c)) return c.json({ error: 'not found' }, 404);
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
    if (operatorFaceBlocked(c)) return c.json({ error: 'not found' }, 404);
    const body = await readBody(c);
    const patch = body['patch'];
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return c.json({ error: 'patch (object) required' }, 400);
    }
    const p = join(rt.config.data_dir, 'judgment.json');
    const current = readJudgmentRaw(p) ?? {};
    const merged = mergeConfigPatch(current, patch);
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
