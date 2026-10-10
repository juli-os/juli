// 语义判定网关（2026-09-23 用户口令）：场景 off/shadow/on 热读、提供方可换
// （cloud/local-api/cli 同形 Judge）、失败降级不挂管线、配置缺省=零网络。
// noul 极性映射（P1 锁定）：noul=P(答案为是)，confidence=所选答案的概率。

import { describe, expect, it } from 'vitest';
import {
  createCliJudge, createJudgmentGateway, createJudgeFromConfig,
  createLocalApiJudge, loadJudgmentConfig, parseJudgmentConfig,
} from '@juli-os/routing';
import { ok } from '@juli-os/artifacts';

describe('parseJudgmentConfig / loadJudgmentConfig', () => {
  it('provider 非法/非对象 → null（整体关）', () => {
    expect(parseJudgmentConfig(null)).toBeNull();
    expect(parseJudgmentConfig({})).toBeNull();
    expect(parseJudgmentConfig({ provider: 'magic' })).toBeNull();
  });
  it('非法模式值丢弃；合法三态保留；未知场景键显式丢弃（20260927 P2-5 翻转 batch1「宽容」：新场景本就随引擎代码进 JUDGMENT_SCENARIOS 注册表，宽容只掩护拼错——影子期静默空转零反馈）', () => {
    const cfg = parseJudgmentConfig({
      provider: 'cloud',
      scenarios: { route_fallback: 'shadow', intake_gate: 'on', aggregate_smae: 'on', bad: 'sometimes' },
    })!;
    expect(cfg.scenarios).toEqual({ route_fallback: 'shadow', intake_gate: 'on' });
  });
  it('cloud.token 配置直书优先于 env（20260928 用户裁定：引擎与启动 shell env 解耦）', () => {
    // token 在配置、env 全空 → judge 构建成功（旧实现此处恒 null=provider unavailable）。
    const cfgFile = { provider: 'cloud' as const, cloud: { token: 'tok-from-config' } };
    const judge = createJudgeFromConfig(cfgFile, {});
    expect(judge).not.toBeNull();
    // token 在配置时压过 env 同名值（配置优先）。
    const judge2 = createJudgeFromConfig(cfgFile, { JEV_TOKEN: 'tok-from-env' });
    expect(judge2).not.toBeNull();
    // 无配置 token 且 env 全空 → 恒 null（降级全 off，既有行为不变）。
    expect(createJudgeFromConfig({ provider: 'cloud' }, {})).toBeNull();
  });
  it('文件缺失/坏 JSON → null（零网络）', () => {
    expect(loadJudgmentConfig('/nonexistent/judgment.json')).toBeNull();
    expect(loadJudgmentConfig('/tmp')).toBeNull();
  });
  it('timeout_ms 夹紧 [1000,30000]（派发路径持锁阻塞有上界；0/负不全废）', () => {
    expect(parseJudgmentConfig({ provider: 'cli', cli: { cmd: ['x'] }, timeout_ms: 600_000 })!.timeout_ms).toBe(30_000);
    expect(parseJudgmentConfig({ provider: 'cli', cli: { cmd: ['x'] }, timeout_ms: 0 })!.timeout_ms).toBe(1_000);
    expect(parseJudgmentConfig({ provider: 'cli', cli: { cmd: ['x'] }, timeout_ms: -5 })!.timeout_ms).toBe(1_000);
    expect(parseJudgmentConfig({ provider: 'cli', cli: { cmd: ['x'] }, timeout_ms: 8_000 })!.timeout_ms).toBe(8_000);
  });
});

describe('createJudgmentGateway', () => {
  const cfg = (scenarios: Record<string, 'off' | 'shadow' | 'on'>, min = 0.7) => ({
    provider: 'cloud' as const, scenarios, min_confidence: min,
  });
  const judge = (answer: string, confidence: number, fail = false) => ({
    model: 'test',
    ask: async () => {
      if (fail) throw new Error('boom');
      return {
        model: 'test',
        answers: { q: { type: 'choice' as const, choice: answer, probabilities: { [answer]: confidence }, confidence } },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  });
  const noulJudge = (noul: number) => ({
    model: 'test',
    ask: async () => ({
      model: 'test',
      answers: { q: { type: 'noul' as const, noul } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });

  it('配置缺省 → 全场景 off，ask 恒 null（零网络零构建）', async () => {
    const gw = createJudgmentGateway({ load: () => null, judgeOf: () => judge('x', 1) });
    expect(await gw.ask('route_fallback', {}, { q: { type: 'noul', instructions: 'x' } })).toBeNull();
  });
  it('off 场景 → null；shadow/on → 结果带模式+同源阈值（热读：改配置即变）', async () => {
    let current = cfg({ route_fallback: 'off', intake_gate: 'shadow' });
    const gw = createJudgmentGateway({ load: () => current, judgeOf: () => judge('juli-dev', 0.9) });
    expect(await gw.ask('route_fallback', {}, { q: { type: 'choice', instructions: 'x', criteria: {} } })).toBeNull();
    const shadow = await gw.ask('intake_gate', {}, { q: { type: 'choice', instructions: 'x', criteria: {} } });
    expect(shadow?.mode).toBe('shadow');
    expect(shadow?.answer).toBe('juli-dev');
    expect(shadow?.threshold).toBe(0.7);
    current = cfg({ intake_gate: 'on' });
    const on = await gw.ask('intake_gate', {}, { q: { type: 'choice', instructions: 'x', criteria: {} } });
    expect(on?.mode).toBe('on');
  });
  it('判定失败 → ok:false + error（消费方按默认行为走，不抛）', async () => {
    const gw = createJudgmentGateway({ load: () => cfg({ intake_gate: 'on' }), judgeOf: () => judge('x', 1, true) });
    const r = await gw.ask('intake_gate', {}, { q: { type: 'choice', instructions: 'x', criteria: {} } });
    expect(r?.ok).toBe(false);
    expect(r?.error).toContain('boom');
  });
  it('noul 极性映射（P1 锁定）：noul=0.1 → answer false + confidence 0.9，能过 0.7 阈值', async () => {
    const gw = createJudgmentGateway({ load: () => cfg({ intake_gate: 'on' }), judgeOf: () => noulJudge(0.1) });
    const r = await gw.ask('intake_gate', {}, { q: { type: 'noul', instructions: 'x' } });
    expect(r?.ok).toBe(true);
    expect(r?.answer).toBe('false');
    expect(r?.confidence).toBeCloseTo(0.9, 10);
    expect(r?.probabilities).toEqual({ true: 0.1, false: 0.9 });
    // 消费方采纳条件 answer==='false' && confidence>=threshold 现在可达：
    // 模型自信判「不值得起单」必须能拦下单子，而不是被当低置信放行。
    expect((r?.confidence ?? 0) >= gw.threshold()).toBe(true);
  });
  it('noul=0.93 → true + confidence 0.93；0.5 边界 → true（>= 极性）', async () => {
    const gw = createJudgmentGateway({ load: () => cfg({ intake_gate: 'on' }), judgeOf: () => noulJudge(0.93) });
    const r = await gw.ask('intake_gate', {}, { q: { type: 'noul', instructions: 'x' } });
    expect(r?.answer).toBe('true');
    expect(r?.confidence).toBeCloseTo(0.93, 10);
    const half = createJudgmentGateway({ load: () => cfg({ intake_gate: 'on' }), judgeOf: () => noulJudge(0.5) });
    const r2 = await half.ask('intake_gate', {}, { q: { type: 'noul', instructions: 'x' } });
    expect(r2?.answer).toBe('true');
    expect(r2?.confidence).toBeCloseTo(0.5, 10);
  });
  it('失败降级错误串截断 80 字符（远端可控响应体不整段进审计面）', async () => {
    const j = { model: 'test', ask: async () => { throw new Error(`Jev API 502: ${'x'.repeat(300)}`); } };
    const gw = createJudgmentGateway({ load: () => cfg({ intake_gate: 'on' }), judgeOf: () => j, log: () => undefined });
    const r = await gw.ask('intake_gate', {}, { q: { type: 'choice', instructions: 'x', criteria: {} } });
    expect(r?.ok).toBe(false);
    expect(r?.error).toHaveLength(80);
  });
  it('按问题键取答案（多问响应不静默错配到第一个值）', async () => {
    const j = {
      model: 'test',
      ask: async () => ({
        model: 'test',
        answers: {
          decoy: { type: 'choice' as const, choice: 'WRONG', probabilities: {}, confidence: 0 },
          target: { type: 'choice' as const, choice: 'RIGHT', probabilities: {}, confidence: 0.9 },
        },
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    };
    const gw = createJudgmentGateway({ load: () => cfg({ intake_gate: 'on' }), judgeOf: () => j });
    const r = await gw.ask('intake_gate', {}, { target: { type: 'choice', instructions: 'x', criteria: {} } });
    expect(r?.answer).toBe('RIGHT');
  });
  it('多问全量透出：answers 按问题键各带极性映射，legacy 顶层=第一问（triage 一调多问靠它）', async () => {
    const j = {
      model: 'test',
      ask: async () => ({
        model: 'jev-multi',
        answers: {
          category: { type: 'choice' as const, choice: '任务', probabilities: { 任务: 0.92 }, confidence: 0.92 },
          needs_reply: { type: 'noul' as const, noul: 0.15 },
        },
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    };
    const gw = createJudgmentGateway({ load: () => cfg({ triage_classify: 'on' }), judgeOf: () => j });
    const r = await gw.ask('triage_classify', {}, {
      category: { type: 'choice', instructions: 'x', criteria: {} },
      needs_reply: { type: 'noul', instructions: 'y' },
    });
    expect(r?.answers?.['category']).toEqual({ answer: '任务', confidence: 0.92 });
    // noul=0.15 → answer false + confidence 1-0.15（所选答案的概率）。
    expect(r?.answers?.['needs_reply']).toEqual({ answer: 'false', confidence: 0.85 });
    // legacy 顶层字段 = 第一个问题（category）的答案。
    expect(r?.answer).toBe('任务');
    expect(r?.confidence).toBe(0.92);
  });
  it('onUsage 写失败不反噬判定：成功路径仍 ok:true（成本入账故障只降级为日志，20260927 P2-3）', async () => {
    const gw = createJudgmentGateway({
      load: () => cfg({ intake_gate: 'on' }), judgeOf: () => judge('x', 0.9),
      onUsage: () => { throw new Error('SQLITE_FULL: disk I/O error'); },
      log: () => undefined,
    });
    const r = await gw.ask('intake_gate', {}, { q: { type: 'choice', instructions: 'x', criteria: {} } });
    expect(r?.ok).toBe(true);
    expect(r?.answer).toBe('x');
  });
  it('onUsage 持续失败时失败路径也只返回不抛（「网关 ask 全 catch 不抛」纪律不被用量写击穿）', async () => {
    const gw = createJudgmentGateway({
      load: () => cfg({ intake_gate: 'on' }), judgeOf: () => judge('x', 1, true),
      onUsage: () => { throw new Error('SQLITE_BUSY: database is locked'); },
      log: () => undefined,
    });
    const r = await gw.ask('intake_gate', {}, { q: { type: 'choice', instructions: 'x', criteria: {} } });
    expect(r?.ok).toBe(false);
    expect(r?.error).toBe('boom');
  });
  it('judgeFor 缓存键含 timeout_ms：只改超时也重建 judge（热改即时生效）', async () => {
    let t = 1_000;
    let builds = 0;
    const gw = createJudgmentGateway({
      load: () => ({ provider: 'cli', cli: { cmd: ['x'] }, timeout_ms: t, scenarios: { intake_gate: 'on' } }),
      judgeOf: () => { builds++; return null; },
      log: () => undefined,
    });
    const q = { q: { type: 'noul' as const, instructions: 'x' } };
    await gw.ask('intake_gate', {}, q);
    await gw.ask('intake_gate', {}, q);
    expect(builds).toBe(1); // 未变 → 缓存命中
    t = 5_000;
    await gw.ask('intake_gate', {}, q);
    expect(builds).toBe(2); // 只改超时 → 重建
    await gw.ask('intake_gate', {}, q);
    expect(builds).toBe(2); // 再问不再重建
  });
  it('提供方不可用（缺 token）→ ok:false 降级', async () => {
    const gw = createJudgmentGateway({
      load: () => parseJudgmentConfig({ provider: 'cloud', scenarios: { intake_gate: 'on' } }),
      judgeOf: () => null,
    });
    const r = await gw.ask('intake_gate', {}, { q: { type: 'noul', instructions: 'x' } });
    expect(r?.ok).toBe(false);
  });
  it('threshold 读全局 min_confidence（无场景参数），默认 0.7', () => {
    const gw = createJudgmentGateway({ load: () => cfg({}, 0.55), judgeOf: () => null });
    expect(gw.threshold()).toBe(0.55);
    const gw2 = createJudgmentGateway({ load: () => parseJudgmentConfig({ provider: 'cloud' }), judgeOf: () => null });
    expect(gw2.threshold()).toBe(0.7);
  });
  it('用量回执：outcome 携带 model/tokens/duration，onUsage 同步入账（成本账本输入）', async () => {
    const j = {
      model: 'test',
      ask: async () => ({
        model: 'jev-latest',
        answers: { q: { type: 'choice' as const, choice: 'a', probabilities: { a: 0.9 }, confidence: 0.9 } },
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
    };
    const receipts: Record<string, unknown>[] = [];
    const gw = createJudgmentGateway({
      load: () => cfg({ intake_gate: 'on' }), judgeOf: () => j,
      onUsage: (r) => receipts.push({ ...r }),
    });
    const r = await gw.ask('intake_gate', {}, { q: { type: 'choice', instructions: 'x', criteria: {} } });
    expect(r?.model).toBe('jev-latest');
    expect(r?.inputTokens).toBe(7);
    expect(r?.outputTokens).toBe(3);
    expect(r?.durationMs).toBeGreaterThanOrEqual(0);
    expect(receipts).toEqual([{
      scenario: 'intake_gate', mode: 'on', model: 'jev-latest',
      inputTokens: 7, outputTokens: 3, durationMs: r?.durationMs, ok: true,
    }]);
  });
  it('判定失败也入账：tokens 0 + error（影子期静默失败不伪装成零成本零运行）', async () => {
    const receipts: Record<string, unknown>[] = [];
    const gw = createJudgmentGateway({
      load: () => cfg({ intake_gate: 'shadow' }), judgeOf: () => judge('x', 1, true),
      onUsage: (r) => receipts.push({ ...r }), log: () => undefined,
    });
    const r = await gw.ask('intake_gate', {}, { q: { type: 'choice', instructions: 'x', criteria: {} } });
    expect(r?.ok).toBe(false);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!['ok']).toBe(false);
    expect(receipts[0]!['inputTokens']).toBe(0);
    expect(String(receipts[0]!['error'])).toContain('boom');
  });
  it('off / 提供方不可用 → 零回执（没出网就不产生账目）', async () => {
    const receipts: unknown[] = [];
    let current: unknown = null;
    const gw = createJudgmentGateway({
      load: () => current as never, judgeOf: () => null,
      onUsage: (r) => receipts.push(r), log: () => undefined,
    });
    await gw.ask('intake_gate', {}, { q: { type: 'noul', instructions: 'x' } });
    current = cfg({ intake_gate: 'on' });
    await gw.ask('intake_gate', {}, { q: { type: 'noul', instructions: 'x' } });
    expect(receipts).toHaveLength(0);
  });
});

describe('提供方（约束②：cloud/local-api/cli 同形可换）', () => {
  it('local-api：POST {state,model,questions} → answers', async () => {
    let captured = '';
    const j = createLocalApiJudge({
      url: 'http://127.0.0.1:9/judge', model: 'jev-local',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        captured = `${String(url)} ${String(init?.body)}`;
        return new Response(JSON.stringify({ model: 'jev-local', answers: { q: { type: 'choice', choice: 'acme', confidence: 0.8 } } }), { status: 200 });
      }) as typeof fetch,
    });
    const r = await j.ask('s', { q: { type: 'choice', instructions: 'x', criteria: {} } });
    expect(captured).toContain('http://127.0.0.1:9/judge');
    expect(r.answers['q']).toMatchObject({ choice: 'acme' });
  });
  it('cli：stdin JSON → stdout JSON', async () => {
    const j = createCliJudge({
      cmd: [process.execPath, '-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify({answers:{q:{type:"noul",noul:0.93}}})))'],
    });
    const r = await j.ask('s', { q: { type: 'noul', instructions: 'x' } });
    expect((r.answers['q'] as { noul: number }).noul).toBe(0.93);
  });
  it('cli：非零退出把 stderr 收进错误消息（判定失败可诊断）', async () => {
    const j = createCliJudge({
      cmd: [process.execPath, '-e', 'process.stderr.write("模型炸了: OOM");process.exit(3)'],
    });
    await expect(j.ask('s', { q: { type: 'noul', instructions: 'x' } })).rejects.toThrow('模型炸了: OOM');
  });
  it('createJudgeFromConfig：cloud 缺 token → null；cli 缺 cmd → null', () => {
    expect(createJudgeFromConfig(parseJudgmentConfig({ provider: 'cloud' })!, { JEV_TOKEN: '' })).toBeNull();
    expect(createJudgeFromConfig(parseJudgmentConfig({ provider: 'cli' })!, {})).toBeNull();
    expect(createJudgeFromConfig(parseJudgmentConfig({ provider: 'local-api', local_api: { url: 'http://x' } })!, {})).not.toBeNull();
  });
  it('createJudgeFromConfig：自定义 cloud.tokenEnv 精确匹配（此前恒 null）；缺省链 TYPESAFE_API_KEY 兜底恢复', () => {
    const myToken = parseJudgmentConfig({ provider: 'cloud', cloud: { tokenEnv: 'MY_JUDGE_TOKEN' } })!;
    expect(createJudgeFromConfig(myToken, { MY_JUDGE_TOKEN: 'x' })).not.toBeNull();
    expect(createJudgeFromConfig(myToken, { JEV_TOKEN: 'y' })).toBeNull(); // 自定义名不吃别的键
    expect(createJudgeFromConfig(parseJudgmentConfig({ provider: 'cloud' })!, { TYPESAFE_API_KEY: 'k' })).not.toBeNull();
  });
  it('createJev 契约不变（cloud 形状回归）', async () => {
    const { createJev } = await import('@juli-os/routing');
    const j = createJev({
      token: 't',
      fetchImpl: (async () => new Response(JSON.stringify({ model: 'jev-latest', answers: { q: { type: 'noul', noul: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })) as typeof fetch,
    });
    const r = await j.ask('s', { q: { type: 'noul', instructions: 'x' } });
    expect(r.model).toBe('jev-latest');
    void ok;
  });
});
