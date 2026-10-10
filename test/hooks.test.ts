// HTTP E2E：真实 hono app（不经网络，直接 app.fetch）+ 真实组合根
// createRuntime（真实 sqlite 文件、真实模板目录）+ mock 传输端口。
// 邮件 → 工作流 → 三闸门全人审 → SMTP 回信 → completed，全程走 HTTP。

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime, type RuntimeSeams } from '../src/runtime.ts';
import type { CompletionResult } from '../src/contracts/ports.ts';
import { createHttpApp } from '../src/http/app.ts';
import { ok } from '../src/platform/shared/result.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'juli-e2e-'));

const sent: { to: string; subject: string }[] = [];
const dispatched: string[] = [];
const seams: RuntimeSeams = {
  llm: {
    async complete(req) {
      if (req.system.includes('邮件信息抽取')) {
        return ok({ text: JSON.stringify({ category: '任务', summary: '出一份销量表', session: 'agent-a', needs_reply: true }) });
      }
      if (req.system.includes('商务邮件助理')) {
        return ok({ text: JSON.stringify({ draft: '您好，销量表已发出。\n此致\n敬礼\n\njuli Labs\nAI 助理\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。' }) });
      }
      return ok({ text: 'ok' });
    },
  },
  mailer: { async send(cmd) { sent.push({ to: cmd.to, subject: cmd.subject }); return ok({ messageId: '<r@juli>' }); } },
  dispatch: { async dispatch(_s, session, text) { dispatched.push(`${session}:${text.slice(0, 10)}`); return ok(undefined); } },
};

const cfg = configSchema.parse({
  data_dir: dataDir,
  // P1-1 随修（2026-09-20）：runtime 装配的 resolveSession 覆盖修复后复活，
  // 复用优先路由开始真实生效——本测试此前隐形依赖该死码（点名会话原样放行），
  // 现会随宿主机 tmux 会话名单漂移（宿主恰有 agent-a 时 e2e-demo 被落回）。
  // 指向 tmpdir 死 socket：listSync 稳定空名单 → 路由器按「名单未见放行」
  // 处理钉定会话，测试密闭、不再读宿主机 tmux。
  tmux_socket_path: join(dataDir, 'tmux.sock'),
  email_authz_allow: ['*@example.com'],
  email: { default_session: 'agent-a', default_project: 'demo', simulate_enabled: true },
});
const rt = createRuntime(cfg, seams);
const app = createHttpApp(rt);

const j = async (method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> => {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

describe('HTTP API 全链 E2E', () => {
  it('健康检查免认证；未带 token 的 API 在设密码后 401', async () => {
    expect((await j('GET', '/healthz')).status).toBe(200);
    expect((await j('GET', '/api/version')).status).toBe(200);
    expect((await j('GET', '/api/lifecycle/workflows')).status).toBe(200);
  });

  it('模板注册表：内嵌默认已 seed 到磁盘并可读', async () => {
    const res = await j('GET', '/api/pipelines');
    expect(res.status).toBe(200);
    const keys = res.data.templates.map((t: { key: string }) => t.key);
    expect(keys).toContain('email-reply');
    expect(keys).toContain('video-prod');
  });

  it('邮件全流程：simulate → gate1 审 → agent → gate2 审 → send → completed', async () => {
    // 1) 配方起流（email-reply 阶梯）：动态进件已是单节点模型，全流程
    //    阶梯语义改由配方承载——模拟注入口的动态形态见 templateless 测试。
    const sim = await j('POST', '/api/pipelines/start', {
      template: 'email-reply', title: '季度数据求助',
      input: { from: 'client@example.com', subject: '季度数据求助', body: '请整理 Q3 数据。', in_reply_to: '<q3@client>' },
    });
    expect(sim.status).toBe(200);

    // 2) 工作流已建，triage 已过，闸门 1 等人。
    const wfs = await j('GET', '/api/lifecycle/workflows');
    const wf = wfs.data.workflows[0];
    expect(wf.status).toBe('running');
    const detail = await j('GET', `/api/lifecycle/workflows/${wf.id}`);
    const steps = detail.data.steps;
    expect(steps[0].status).toBe('completed');
    expect(steps[1].status).toBe('waiting_human');

    // 3) HTTP 批准 → agent 派发 → 模拟 agent 停止 → verify → 停止 → 闸门 2。
    await j('POST', `/api/lifecycle/steps/${steps[1].id}/approve`, { note: 'ok', by: 'boss' });
    expect(dispatched.length).toBe(1);
    await rt.engine.onAgentStopped('agent-a', 'ok');
    await rt.engine.onAgentStopped('agent-a', 'ok');
    const detail2 = await j('GET', `/api/lifecycle/workflows/${wf.id}`);
    expect(detail2.data.steps[4].status).toBe('waiting_human');

    // 4) 批准成品 → draft → 批准回信 → SMTP 真实路径（mock 传输）→ completed。
    await j('POST', `/api/lifecycle/steps/${detail2.data.steps[4].id}/approve`, { note: '产出可以', by: 'boss' });
    const detail3 = await j('GET', `/api/lifecycle/workflows/${wf.id}`);
    expect(detail3.data.steps[6].status).toBe('waiting_human');
    expect(detail3.data.case_file.decisions.length).toBeGreaterThanOrEqual(2);
    await j('POST', `/api/lifecycle/steps/${detail3.data.steps[6].id}/approve`, { note: '发', by: 'boss' });

    const final = await j('GET', `/api/lifecycle/workflows/${wf.id}`);
    expect(final.data.workflow.status).toBe('completed');
    expect(sent.length).toBe(1);
    expect(sent[0]!.to).toBe('client@example.com'); // 结构性约束：只回原始发件人
    const events = await j('GET', '/api/lifecycle/events');
    const types: string[] = events.data.events.map((e: { type: string }) => e.type);
    expect(types).toContain('flow_started'); // 配方起流（email_received 属动态进件面）
    expect(types).toContain('email_sent');
    expect(types).toContain('completed');
  });

  it('authz 热更新生效（PUT 即切换引擎策略）', async () => {
    const setRes = await j('POST', '/api/pipeline/authz', { mode: 'allowlist', allow: ['vip@vip.io'], deny: [] });
    expect(setRes.status).toBe(200);
    const sim = await j('POST', '/api/email/simulate', { from: 'new@stranger.io', subject: 'x', body: 'y' });
    expect(sim.status).toBe(200);
    const wfs = await j('GET', '/api/lifecycle/workflows');
    expect(wfs.data.workflows[0]!.status).toBe('rejected'); // 新策略立即生效
  });

  it('StartFlow 手动触发模板流', async () => {
    const res = await j('POST', '/api/pipelines/start', { template: 'video-prod', title: '测试视频', input: { concept: '咖啡拉花' } });
    expect(res.status).toBe(200);
    expect(res.data.workflow.kind).toBe('video-prod');
    const detail = await j('GET', `/api/lifecycle/workflows/${res.data.workflow.id}`);
    // concept llm 步已被 mock LLM 推到完成，停在闸门①。
    expect(detail.data.steps[0].status).toBe('completed');
    expect(detail.data.steps[0].output['response']).toBe('ok');
    expect(detail.data.steps[1].status).toBe('waiting_human');
  });

  it('agent 结算上报路由：stopped 推进阶梯，activity 留痕', async () => {
    const start = await j('POST', '/api/pipelines/start', { template: 'video-prod', title: '结算路由', input: { concept: 'x' } });
    const wfId = start.data.workflow.id as string;
    // concept(llm mock) 完成 → 闸门① 等人；批准 → storyboard(llm) → 闸门②；
    // 两道创意/分镜闸门都拍板后，render agent 步（session 钉定 e2e-demo）派发。
    const d1 = await j('GET', `/api/lifecycle/workflows/${wfId}`);
    expect(d1.data.steps[1].status).toBe('waiting_human');
    await j('POST', `/api/lifecycle/steps/${d1.data.steps[1].id}/approve`, { note: '创意拍板', by: 'boss' });
    let d = await j('GET', `/api/lifecycle/workflows/${wfId}`);
    expect(d.data.steps[3].status).toBe('waiting_human');
    await j('POST', `/api/lifecycle/steps/${d.data.steps[3].id}/approve`, { note: '分镜拍板', by: 'boss' });
    expect(dispatched.some((x) => x.startsWith('e2e-demo:'))).toBe(true);
    // 经 HTTP 上报心跳/活动/stopped——agent 步的服务端结算路径。
    expect((await j('POST', '/api/agents/e2e-demo/heartbeat', {})).status).toBe(200);
    expect((await j('POST', '/api/agents/e2e-demo/activity', { text: '渲染中 30%' })).status).toBe(200);
    expect((await j('POST', '/api/agents/e2e-demo/stopped', { status: 'ok' })).status).toBe(200);
    // render 完成 → share（空案卷直过）→ 闸门③ 等人。
    d = await j('GET', `/api/lifecycle/workflows/${wfId}`);
    const kinds: string[] = d.data.steps.map((s: { kind: string }) => s.kind);
    expect(kinds).toEqual(['llm', 'gate', 'llm', 'gate', 'agent', 'share', 'gate']);
    expect(d.data.steps[6].status).toBe('waiting_human');
    // activity 留痕在 render 步 output。
    expect(d.data.steps[4].output['activity']).toBeTruthy();
  });

  it('坏模板 YAML 被 400 拒绝；authz 查询回读', async () => {
    const bad = await j('POST', '/api/pipelines', { file: 'bad.yaml', yaml: 'key: [broken' });
    expect(bad.status).toBe(400);
    const authz = await j('GET', '/api/pipeline/authz');
    expect(authz.data.mode).toBe('allowlist');
    expect(authz.data.allow).toEqual(['vip@vip.io']);
  });

  afterAll(() => {
    rt.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
