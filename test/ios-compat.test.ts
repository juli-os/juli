// iOS 兼容面契约测试（Go routes.go 逐字对齐）：agents 族 / artifacts 族 /
// lifecycle steps + workflows2 / sessions 辅助动作 / ws chat wire。
// 字段名逐字锁定——错一个 iOS 端解码即失败。

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createServer as createHttpServer } from 'node:http';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime } from '../src/runtime.ts';
import { createHttpApp } from '../src/http/app.ts';
import { attachChatWireWs, attachSnapshotWireWs, attachUpgradeFallback, toWireEvent } from '../src/platform/ws/wirehubs.ts';
import { createChatHub } from '../src/platform/ws/chathub.ts';
import { ok, err, type Result } from '@juli-os/artifacts';
import type { TmuxClient } from '@juli-os/agents';

const dir = mkdtempSync(join(tmpdir(), 'juli-ios-'));
const cfg = configSchema.parse({ data_dir: dir, email: { default_session: 'agent-a', default_project: 'demo' } });
const rt = createRuntime(cfg);
const app = createHttpApp(rt);

// ---- fake tmux（runtime seams 注入）：capture/kill/批量化守卫用 -----------------
const makeFakeTmux = (over: Partial<TmuxClient> = {}): {
  tmux: TmuxClient;
  execCount: () => number;
  killed: readonly string[];
} => {
  let execs = 0;
  const killed: string[] = [];
  const LIST_FMT = '#{session_name}\t#{session_attached}\t#{pane_current_path}\t#{pane_current_command}';
  const tmux: TmuxClient = {
    async hasSession() { return true; },
    async sendTextConfirmed() { return ok({ enters: 0, repasted: false, elapsedMs: 0 }); },
    async sendTextQueued() { return ok({ enters: 0, repasted: false, elapsedMs: 0, finalState: 'cleared' }); },
    async exec(args) {
      execs++;
      if (args[0] === 'list-sessions') {
        const fmt = String(args[2] ?? '');
        return ok(fmt.includes('\t') ? 'sess-a\t1\t/tmp/proj-a\tclaude' : 'sess-a\n');
      }
      return ok('');
    },
    async listSessions() {
      const r = await tmux.exec(['list-sessions', '-F', '#{session_name}']);
      return r.ok ? r.value.split('\n').map((s) => s.trim()).filter(Boolean) : [];
    },
    async listSessionsDetailed() {
      const r = await tmux.exec(['list-sessions', '-F', LIST_FMT]);
      if (!r.ok) return err(r.error);
      const rows = r.value.split('\n').filter(Boolean).map((line) => {
        const [name, attached, path, cmd] = line.split('\t');
        return {
          name: (name ?? '').trim(),
          attached: (attached ?? '0').trim() !== '0',
          path: (path ?? '').trim(),
          cmd: (cmd ?? '').trim(),
        };
      });
      return ok(rows);
    },
    async newSession() { return ok(undefined); },
    async sendText() { return ok(undefined); },
    async capturePane(name) { return ok(`pane:${name}`); },
    async killSession(name) { killed.push(name); return ok(undefined); },
    async interrupt() { return ok(undefined); },
    ...over,
  };
  return { tmux, execCount: () => execs, killed };
};

const mkTmpCfg = (label: string) => configSchema.parse({ data_dir: mkdtempSync(join(tmpdir(), `juli-ios-${label}-`)) });
const fake = makeFakeTmux();
const rtT = createRuntime(mkTmpCfg('tmux'), { tmux: fake.tmux });
const appT = createHttpApp(rtT);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试 JSON 探针：data=JSON.parse 动态形态，下游数十处临时断言消费，精确建型需给全部 expect 补窄化（零安全增益 churn）。
const j = async (method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> => {
  const res = await app.request(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};

const seed = (title: string, from: string): string => {
  const w = rt.store.createWorkflow({ kind: 'email', title, meta: { from } });
  // createWorkflow 不建步骤（那是引擎模板播种的事）——测试手工播种两步。
  rt.store.createStep({ workflowId: w.id, seq: 1, kind: 'triage', title: '抽取·邮件结构化' });
  rt.store.createStep({ workflowId: w.id, seq: 2, kind: 'gate', title: '闸门·抽取审批' });
  return w.id;
};

describe('agents 族', () => {
  it('GET /api/agents：agents 空数组 + failed 步骤进 history（含 workflow_title）', async () => {
    const wid = seed('t', 'a@x.com');
    // history 只收 agent/verify 步——triage/gate 的 failed 是上游噪声。
    const stAgent = rt.store.createStep({ workflowId: wid, seq: 3, kind: 'agent', title: 'agent 失败' });
    rt.store.setStepOutput(stAgent.id, { error: 'boom' });
    rt.store.setStepStatus(stAgent.id, 'failed');
    const { data } = await j('GET', '/api/agents');
    expect(data.agents).toEqual([]);
    expect(data.history.length).toBeGreaterThanOrEqual(1);
    const h = data.history.find((x: { workflow_id: string; error?: unknown; workflow_title?: unknown }) => x.workflow_id === wid);
    expect(h.error).toBe('boom');
    expect(h.workflow_title).toBe('t');
    expect(typeof h.updated_at).toBe('string');
  });

  it('GET /api/agents：history 只含 agent/verify 步；session 走 w.session → output.session 兜底', async () => {
    const wid = seed('t-filter', 'g@x.com');
    // 播种 failed triage + failed agent 两步——history 必须只收 agent 步。
    const stTriage = rt.store.createStep({ workflowId: wid, seq: 3, kind: 'triage', title: 'triage-fail' });
    const stAgent = rt.store.createStep({ workflowId: wid, seq: 4, kind: 'agent', title: 'agent-fail' });
    rt.store.setStepStatus(stTriage.id, 'failed');
    rt.store.setStepOutput(stAgent.id, { error: 'agent boom', session: 'sess-fallback' });
    rt.store.setStepStatus(stAgent.id, 'failed');
    const { data } = await j('GET', '/api/agents');
    const mine = data.history.filter((x: { workflow_id: string; step_id?: unknown; error?: unknown; session?: unknown }) => x.workflow_id === wid);
    expect(mine).toHaveLength(1);
    expect(mine[0].step_id).toBe(stAgent.id);
    expect(mine[0].error).toBe('agent boom');
    // workflow 无 session → 回退到步 output JSON 的 session
    expect(mine[0].session).toBe('sess-fallback');
  });

  it('profile/session 未分类时不得带空 project 键（空串会让 iOS owns() 恒真）', async () => {
    const prof = await app.request('/api/agents/profiles');
    const profiles = (await prof.json()) as { profiles: Array<{ project?: unknown }> };
    expect(profiles.profiles.every((x: { project?: unknown }) => x.project === undefined)).toBe(true);
    const sess = await app.request('/api/sessions');
    const arr = (await sess.json()) as Array<{ project?: unknown }>;
    expect(arr.every((x: { project?: unknown }) => x.project === undefined)).toBe(true);
  });

  it('GET /api/agents/profiles：数组且条目字段逐字（updated_at 毫秒）', async () => {
    const { data } = await j('GET', '/api/agents/profiles');
    expect(Array.isArray(data.profiles)).toBe(true);
    for (const p of data.profiles) {
      expect(typeof p.name).toBe('string');
      expect(p.runtime).toBe('tmux');
      expect(typeof p.updated_at).toBe('number');
    }
  });

  it('GET/DELETE /api/agents/:id：未知线程 404 / 归档 204', async () => {
    expect((await j('GET', '/api/agents/nope')).status).toBe(404);
    expect((await j('DELETE', '/api/agents/nope')).status).toBe(204);
  });
});

describe('artifacts 族', () => {
  it('案件证据链：register → Go 形状投影 → content 200 → purge → 410', async () => {
    const wid = seed('t2', 'b@x.com');
    const put = await rt.artifactLedger.putAndRegister({
      workflowId: wid, role: 'agent_output', name: 'demo.html', bytes: Buffer.from('<h1>ok</h1>'),
    });
    const { data } = await j('GET', `/api/lifecycle/workflows/${wid}/artifacts`);
    expect(data.artifacts).toHaveLength(1);
    const a = data.artifacts[0];
    expect(a.name).toBe('demo.html');
    expect(a.workflow_id).toBe(wid);
    expect(a.storage.backend).toBe('disk');
    expect(a.created_at).toBeTruthy();

    const dl = await app.request(`/api/artifacts/${put.id}/content`);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('<h1>ok</h1>');

    const purge = await j('POST', `/api/lifecycle/workflows/${wid}/artifacts/purge`);
    expect(purge.data.purged).toBe(1);
    expect((await app.request(`/api/artifacts/${put.id}/content`)).status).toBe(410);
  });

  it('会话产物裸数组 + content 按类型出流', async () => {
    const wid = seed('t3', 'c@x.com');
    await rt.artifactLedger.putAndRegister({
      workflowId: wid, role: 'agent_output', name: 'page.html', bytes: Buffer.from('<p>x</p>'),
    });
    const list = await app.request('/api/artifacts');
    const arr = (await list.json()) as Array<{ name?: unknown; session?: unknown; type?: unknown; size?: unknown; mtime?: unknown; id: string }>;
    expect(Array.isArray(arr)).toBe(true);
    const entry = arr.find((x) => x.name === 'page.html')!;
    expect(entry.session).toBe(wid);
    expect(entry.type).toBe('html');
    expect(typeof entry.mtime).toBe('number');
    // 账本 id 随行（PROBLEMS-R2 P2）：POST /api/artifact/share {id} 的取值面。
    expect(typeof entry.id).toBe('string');
    expect(entry.id.length).toBeGreaterThan(0);

    const raw = await app.request(`/api/artifact?session=${wid}&path=page.html`);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe('<p>x</p>');
  });

  it('purge 删字节：列表剔除 + artifact 404 + 磁盘文件删除', async () => {
    const wid = seed('t-purge', 'purge@x.com');
    const put = await rt.artifactLedger.putAndRegister({
      workflowId: wid, role: 'agent_output', name: 'purge-me.html', bytes: Buffer.from('<p>bye</p>'),
    });
    const diskFile = join(rt.config.data_dir, 'artifacts-store', put.key);
    expect(existsSync(diskFile)).toBe(true);

    const purge = await j('POST', `/api/lifecycle/workflows/${wid}/artifacts/purge`);
    expect(purge.data.purged).toBe(1);
    // (a) /api/artifacts 列表不含该 name（墓碑过滤生效）
    const arr = (await (await app.request('/api/artifacts')).json()) as Array<{ name?: unknown }>;
    expect(arr.find((x) => x.name === 'purge-me.html')).toBeUndefined();
    // (b) /api/artifact?session&path 404
    expect((await app.request(`/api/artifact?session=${wid}&path=purge-me.html`)).status).toBe(404);
    // (c) 磁盘字节已删（purge 不再只做墓碑）
    expect(existsSync(diskFile)).toBe(false);
  });

  it('share：签名链接免密取件 + 篡改/过期拒收（替代 501 stub）', async () => {
    const wid = seed('t-share', 'share@x.com');
    const put = await rt.artifactLedger.putAndRegister({
      workflowId: wid, role: 'agent_output', name: 'share.html', bytes: Buffer.from('<p>share me</p>'),
    });
    // 无 body id → 400；未知 id → 404。
    expect((await app.request('/api/artifact/share', { method: 'POST' })).status).toBe(400);
    expect((await app.request('/api/artifact/share', {
      method: 'POST', body: JSON.stringify({ id: 'art_none' }), headers: { 'content-type': 'application/json' },
    })).status).toBe(404);
    // 真实 share：返回带签名的限时 URL。
    const res = await app.request('/api/artifact/share', {
      method: 'POST', body: JSON.stringify({ id: put.id }), headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const { url } = await res.json() as { url: string };
    expect(url).toContain(`/api/artifacts/${put.id}/content?share=`);
    // 收件人免 Bearer 取件成功（app.request 自带 token 也行；剥掉再验一次真免密）。
    const strip = (u: string): string => u.replace(/^https?:\/\/[^/]+/, '');
    const bare = await app.request(strip(url));
    expect(bare.status).toBe(200);
    expect(await bare.text()).toBe('<p>share me</p>');
    // 篡改签名 → 401（HMAC 防伪；开放模式无鉴权面，用带密码实例验证）。
    const rtPw = createRuntime(configSchema.parse({ data_dir: mkdtempSync(join(tmpdir(), 'juli-sh-pw-')), password: 'pw-share-test' }));
    const appPw = createHttpApp(rtPw);
    const widPw = seed('t-share-pw', 'pw@x.com');
    const putPw = await rtPw.artifactLedger.putAndRegister({
      workflowId: widPw, role: 'agent_output', name: 'pw.html', bytes: Buffer.from('<p>pw</p>'),
    });
    const resPw = await appPw.request('/api/artifact/share', {
      method: 'POST', body: JSON.stringify({ id: putPw.id }),
      headers: { 'content-type': 'application/json', authorization: 'Bearer pw-share-test' },
    });
    const { url: urlPw } = await resPw.json() as { url: string };
    expect((await appPw.request(strip(urlPw))).status).toBe(200); // 免密取件 ✓
    const evilPw = urlPw.replace(/share=[0-9]+:[0-9a-f]+/, 'share=9999999999:deadbeefdeadbeefdeadbeefdeadbeef');
    expect((await appPw.request(strip(evilPw))).status).toBe(401); // 篡改拒收 ✓
    rtPw.stop();
  });

  it('share：OSS 已配 → presign share 域外链（10y）优先于 HMAC 本地链（Go 时代行为回归）', async () => {
    // iPhone 经 frp 直连时,请求 origin 是自签证书的 IP:端口——收件人打不开
    // (2026-09-30 用户实报)。配了 s3+share_domain,分享必须出 example 形态链。
    const realFetch = globalThis.fetch;
    const putCalls: { url: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      putCalls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response('', { status: 200 });
    });
    const rtOss = createRuntime(configSchema.parse({
      data_dir: mkdtempSync(join(tmpdir(), 'juli-sh-oss-')),
      s3: {
        endpoint: 'https://artifacts-bucket.oss-cn-hangzhou.aliyuncs.com', region: 'cn-hangzhou',
        bucket: 'artifacts-bucket', access_key_id: 'AKID', path_style: false,
        share_domain: 'share.example.com',
      },
      secrets: { s3_secret_key: 'test-secret' },
    }));
    const appOss = createHttpApp(rtOss);
    try {
      const widOss = rtOss.store.createWorkflow({ kind: 'email', title: 'oss-share', meta: { from: 'oss@x.com' } }).id;
      const put = await rtOss.artifactLedger.putAndRegister({
        workflowId: widOss, role: 'agent_output', name: 'report.html', bytes: Buffer.from('<p>oss</p>'),
      });
      const res = await appOss.request('/api/artifact/share', {
        method: 'POST', body: JSON.stringify({ id: put.id }), headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(200);
      const data = await res.json() as { url: string; expires_in_sec: number };
      expect(data.url.startsWith('https://share.example.com/cases/')).toBe(true);
      expect(data.url).toContain('OSSAccessKeyId=AKID');
      expect(data.url).toContain('Signature=');
      expect(data.url).not.toContain('aliyuncs.com');
      // 10y 语义:发出去的链接收件人数月后打开仍活(Go shareURLTTL 同款)。
      expect(data.expires_in_sec).toBe(10 * 365 * 24 * 3600);
      // dual.url() 顺带重传主存字节:重传 PUT 带对 Content-Type(存量旧伤自愈面)。
      expect(putCalls.length).toBeGreaterThanOrEqual(2); // 登记一次 + 分享重传一次
      expect(putCalls.at(-1)!.headers['content-type']).toBe('text/html; charset=utf-8');
      // OSS 全瘫(url 出 err)→ 回退 HMAC 本地链,分享按钮永有链可出。
      rtOss.artifactBackend.url = async () => ({ ok: false, error: new Error('oss down') });
      const res2 = await appOss.request('/api/artifact/share', {
        method: 'POST', body: JSON.stringify({ id: put.id }), headers: { 'content-type': 'application/json' },
      });
      expect(res2.status).toBe(200);
      const data2 = await res2.json() as { url: string };
      expect(data2.url).toContain(`/api/artifacts/${put.id}/content?share=`);
    } finally {
      globalThis.fetch = realFetch;
      rtOss.stop();
    }
  });
});

describe('GET /api/sessions/:name/capture（iOS content 键）', () => {
  it('fake tmux：200 且 content/output 同为 pane 文本（2000 行语义）', async () => {
    const res = await appT.request('/api/sessions/sess-a/capture');
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(typeof data['content']).toBe('string');
    expect(data['content']).toBe('pane:sess-a');
    expect(data['output']).toBe(data['content']);
  });
});

describe('DELETE /api/sessions/:name', () => {
  it('fake tmux：killSession 被调用且返回 204', async () => {
    const res = await appT.request('/api/sessions/sess-a', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(fake.killed).toContain('sess-a');
  });
  it('kill 失败：404', async () => {
    // 模块 app 用真实 tmux：kill 不存在的会话必失败 → 404。
    expect((await j('DELETE', '/api/sessions/juli-no-such-session')).status).toBe(404);
  });
});

describe('会话列表批量化（N+1 消除）', () => {
  it('GET /api/sessions：单次请求 exec ≤ 1 且形状正确', async () => {
    const f = makeFakeTmux();
    const appx = createHttpApp(createRuntime(mkTmpCfg('ls'), { tmux: f.tmux }));
    const res = await appx.request('/api/sessions');
    expect(res.status).toBe(200);
    const arr = (await res.json()) as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(1);
    expect(arr[0]).toMatchObject({ name: 'sess-a', active: true, path: '/tmp/proj-a', agent: 'claude' });
    expect(f.execCount()).toBeLessThanOrEqual(1);
  });
  it('GET /api/agents/profiles：单次请求 exec ≤ 1 且 cwd = pane path', async () => {
    const f = makeFakeTmux();
    const appx = createHttpApp(createRuntime(mkTmpCfg('ls2'), { tmux: f.tmux }));
    const res = await appx.request('/api/agents/profiles');
    expect(res.status).toBe(200);
    const p = ((await res.json()) as { profiles: Array<Record<string, unknown>> }).profiles;
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ name: 'sess-a', runtime: 'tmux', cwd: '/tmp/proj-a' });
    expect(f.execCount()).toBeLessThanOrEqual(1);
  });
});

describe('lifecycle steps / workflows2', () => {
  it('GET steps?status=waiting_human：step+workflow 双层摘要', async () => {
    const wid = seed('t4', 'd@x.com');
    const steps = rt.store.stepsForWorkflow(wid);
    rt.store.setStepStatus(steps[1]!.id, 'waiting_human');
    const { data } = await j('GET', '/api/lifecycle/steps?status=waiting_human&limit=30');
    const hit = data.steps.find((x: { step: { workflow_id: string } }) => x.step.workflow_id === wid);
    expect(hit).toBeDefined();
    expect(hit.step.kind).toBe(steps[1]!.kind);
    expect(hit.workflow).toEqual({ id: wid, title: 't4', kind: 'email', status: 'running' });
  });

  it('GET 详情：workflow/steps 全 snake_case 必填键齐（iOS 解码契约）', async () => {
    const wid = seed('detail-t', 'f@x.com');
    const { data } = await j('GET', `/api/lifecycle/workflows/${wid}`);
    expect(data.workflow.created_at).toBeTruthy();
    expect(data.workflow.updated_at).toBeTruthy();
    expect(data.workflow.kind).toBe('email');
    expect(data.workflow.meta.from).toBe('f@x.com');
    expect(data.steps.length).toBeGreaterThanOrEqual(2);
    for (const st of data.steps) {
      expect(st.workflow_id).toBe(wid);
      expect(st.updated_at).toBeTruthy();
      expect(st.seq).toBeGreaterThan(0);
    }
  });

  it('workflows2：POST 空 body = 列表（snake_case + waiting_steps）；GET 同源', async () => {
    const wid = seed('t5', 'e@x.com');
    const steps = rt.store.stepsForWorkflow(wid);
    rt.store.setStepStatus(steps[1]!.id, 'waiting_human');
    const post = await j('POST', '/api/lifecycle/workflows2', {});
    const wf = post.data.workflows.find((x: { id: string; created_at?: unknown; waiting_steps?: unknown }) => x.id === wid);
    expect(wf.created_at).toBeTruthy();
    expect(wf.waiting_steps).toBe(1);
    expect(wf.meta.from).toBe('e@x.com');
    const get = await j('GET', '/api/lifecycle/workflows2?limit=5');
    expect(get.status).toBe(200);
  });
});

describe('GET /api/sessions（Go/iOS 形状）', () => {
  it('无 tmux 时返回裸空数组（非 {sessions:[]} 包裹——iOS 解码裸数组）', async () => {
    const res = await app.request('/api/sessions');
    expect(res.status).toBe(200);
    const arr = (await res.json()) as unknown[];
    expect(Array.isArray(arr)).toBe(true);
  });
});

describe('HTTP 访问日志（401 留痕守卫）', () => {
  it('坏 token 请求产生 [http-warn] 日志行（爆破可见性）', async () => {
    // 需要启用鉴权的 runtime（无密码 = 开放模式，永不产生 401）
    const cfg2 = configSchema.parse({
      data_dir: mkdtempSync(join(tmpdir(), 'juli-ios-auth-')),
      password: 'secret',
    });
    const app2 = createHttpApp(createRuntime(cfg2));
    const logs: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => logs.push(m);
    try {
      await app2.request('/api/lifecycle/workflows2', {
        headers: { authorization: 'Bearer wrong-password' },
      });
    } finally {
      console.warn = orig;
    }
    expect(logs.some((l) => l.includes('[http-warn]') && l.includes('401'))).toBe(true);
  });
});

describe('sessions 辅助动作', () => {
  it('viewed / start-agent → 204', async () => {
    expect((await app.request('/api/sessions/s1/viewed', { method: 'POST' })).status).toBe(204);
    expect((await app.request('/api/sessions/s1/start-agent', { method: 'POST' })).status).toBe(204);
  });
});

describe('ws chat wire', () => {
  it('toWireEvent 映射：chat:X → X；text → assistant', () => {
    expect(toWireEvent('chat:plan', 'p')).toEqual({ type: 'plan', data: 'p' });
    expect(toWireEvent('text', 'hi')).toEqual({ type: 'assistant', data: 'hi' });
    expect(toWireEvent('done', '')).toEqual({ type: 'done', data: '' });
  });

  it('真连接：chatHub.emit → wire 帧（鉴权 token）', async () => {
    const hub = createChatHub();
    const server = createHttpServer();
    attachChatWireWs({ server, chatHub: hub, password: 'pw1', log: () => undefined });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const frames: unknown[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?token=pw1`);
    const opened = new Promise<void>((r) => ws.on('open', r));
    ws.on('message', (d) => frames.push(JSON.parse(String(d))));
    await opened;
    hub.emit('chat:plan', JSON.stringify({ session: 's', brief: 'b' }));
    hub.emit('text', '你好');
    await new Promise((r) => setTimeout(r, 250));
    ws.close();
    server.close();
    expect(frames).toContainEqual({ type: 'plan', data: JSON.stringify({ session: 's', brief: 'b' }) });
    expect(frames).toContainEqual({ type: 'assistant', data: '你好' });
  });

  it('conv 分线程真分支：各 conv 只收本线程帧；空串 ?conv= 清洗归 main（R1-F2）', async () => {
    // 真连接走 attachChatWireWs 的真实订阅/过滤分支（此前只有测试内模拟过滤）；
    // 「?conv=」空串是 `?? 'main'` 不触发的洞——清洗后必须落 main 而非静默零帧。
    const hub = createChatHub();
    const server = createHttpServer();
    attachChatWireWs({ server, chatHub: hub, password: '', log: () => undefined });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const collect = (query: string): {
      frames: { type: string; data: string }[];
      opened: Promise<void>;
      ws: WebSocket;
    } => {
      const frames: { type: string; data: string }[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat${query}`);
      const opened = new Promise<void>((r) => ws.on('open', r));
      ws.on('message', (d) => frames.push(JSON.parse(String(d))));
      return { frames, opened, ws };
    };
    const convA = collect('?conv=conv-a'); // 正常线程
    const emptyConv = collect('?conv='); // 空串——清洗归 main（旧 ?? 写法=静默零帧）
    const legacy = collect(''); // 旧客户端不带 conv → main
    await Promise.all([convA.opened, emptyConv.opened, legacy.opened]);
    hub.emit('text', '给A', 'conv-a');
    hub.emit('text', '给main', 'main');
    await new Promise((r) => setTimeout(r, 250));
    convA.ws.close();
    emptyConv.ws.close();
    legacy.ws.close();
    server.close();
    expect(convA.frames.map((f) => f.data)).toEqual(['给A']); // 真分支过滤：不串 main
    expect(emptyConv.frames.map((f) => f.data)).toEqual(['给main']); // 空串归 main
    expect(legacy.frames.map((f) => f.data)).toEqual(['给main']);
  });

  it('错误 token 401 拒连', async () => {
    const hub = createChatHub();
    const server = createHttpServer();
    attachChatWireWs({ server, chatHub: hub, password: 'pw1', log: () => undefined });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?token=wrong`);
    const outcome = await new Promise<string>((r) => {
      ws.on('error', () => r('error'));
      ws.on('close', (c) => r(`close:${c}`));
      setTimeout(() => r('timeout'), 3000);
    });
    server.close();
    expect(outcome.startsWith('close') || outcome === 'error').toBe(true);
  });

  it('snapshot tick 重叠闸：capture 在途时不重入', async () => {
    let count = 0;
    const state: { release: ((r: Result<string, Error>) => void) | null } = { release: null };
    const f = makeFakeTmux({
      capturePane: async () => {
        count++;
        if (count === 1) return new Promise<Result<string, Error>>((res) => { state.release = res; });
        return ok('snapshot-content');
      },
    });
    const server = createHttpServer();
    attachSnapshotWireWs({ server, tmux: f.tmux, password: '', log: () => undefined });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/snapshot/s1?interval=30`);
    await new Promise<void>((r) => ws.on('open', r));
    // ≥4 个 tick 窗口：首帧在途期间绝不并发重入 capturePane。
    await new Promise((r) => setTimeout(r, 150));
    expect(count).toBe(1);
    state.release?.(ok('first'));
    await new Promise((r) => setTimeout(r, 150));
    expect(count).toBeGreaterThan(1); // 闸释放后恢复周期抓取
    ws.close();
    server.close();
  });

  it('未匹配 upgrade 兜底销毁：/ws/unknown 3s 内 error/close（不悬挂）', async () => {
    const hub = createChatHub();
    const server = createHttpServer();
    attachChatWireWs({ server, chatHub: hub, password: '', log: () => undefined });
    attachUpgradeFallback(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/unknown`);
    const outcome = await new Promise<string>((r) => {
      ws.on('error', () => r('error'));
      ws.on('close', (c) => r(`close:${c}`));
      setTimeout(() => r('timeout'), 3000);
    });
    ws.close();
    server.close();
    expect(outcome === 'error' || outcome.startsWith('close')).toBe(true);
  });
});
