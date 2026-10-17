// 开单对话（chat intake）契约测试：loop 行为（clarify/收敛/确认/取消/
// 失败显性化）+ 白名单只读硬断言 + 路由契约（turn/confirm/deny/state）。
// 对话不进账：全程无账本写断言靠 startTask 只在 confirm 被调一次锁定。

import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ok } from '@juli-os/artifacts';
import { type ChatLlmPort, type ToolCallRequest } from '@juli-os/agents';
import { createChatIntake, extractIntakePlanBlock, stripIntakePlanBlock, INTAKE_SYSTEM_PROMPT, type ChatIntakeDeps } from '../src/business/intake/chatIntake.ts';
import { CHAT_TOOL_NAMES, makeChatTools, type ChatToolDeps } from '../src/business/intake/chatTools.ts';
import { registerChatRoutes } from '../src/http/routes/chat.ts';
import type { AppEnv } from '../src/http/helpers.ts';
import type { Runtime } from '../src/runtime.ts';
import { makeEngine, until } from './helpers.ts';

// ---- 假件 ------------------------------------------------------------------------

/** 剧本式假 LLM：按序吐回复；toolCalls 轮可编排。 */
const fakeLlm = (replies: readonly { content: string; toolCalls?: { id: string; name: string; arguments: string }[] }[]): { llm: ChatLlmPort; requests: ToolCallRequest[] } => {
  const requests: ToolCallRequest[] = [];
  let i = 0;
  return {
    requests,
    llm: {
      name: 'fake',
      async chat(req) {
        requests.push(req);
        const r = replies[Math.min(i++, replies.length - 1)]!;
        return ok({ content: r.content, toolCalls: r.toolCalls ?? [] });
      },
    },
  };
};

const fakeStartTask = (id = 'wf_chat_1'): { calls: { title: string; brief: string; session?: string }[]; fn: ChatIntakeDeps['startTask'] } => {
  const calls: { title: string; brief: string; session?: string }[] = [];
  return {
    calls,
    fn: async (title: string, brief: string, session?: string) => {
      calls.push({ title, brief, ...(session !== undefined && session !== '' ? { session } : {}) });
      return ok({ id });
    },
  };
};

const toolDeps = (over: Partial<ChatToolDeps> = {}): ChatToolDeps => ({
  lookupCustomer: async (q) => [{ email: `${q}@acme.de`, displayName: 'Casey', company: 'Acme', workflows: 3, lastContactAt: '2026-09-01' }],
  listTasks: (_scope, limit, _q) => Array.from({ length: Math.min(limit, 2) }, (_, k) => ({ id: `wf_${k}`, title: `单${k}`, status: 'running', updatedAt: '2026-09-28' })),
  getTask: async (wfId) => wfId === 'wf_known000001'
    ? {
        id: wfId, title: '已知单', status: 'waiting_human', kind: 'adhoc',
        createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z', session: 'juli-dev',
        steps: [{ seq: 1, kind: 'agent', title: '执行', status: 'completed', updatedAt: '2026-10-06T00:00:00Z' }],
        waitingOn: '发送确认', deliverables: [{ name: '报告.html', role: 'report' }],
        prompts: 3, costCny: 12.5,
      }
    : null,
  listSessions: () => [{ session: 'juli-dev', company: 'juli', domain: 'juli', description: '开发', inflight: 2 }],
  serviceInfo: () => ({
    version: 'test-ver', startedAt: '2026-10-07T00:00:00Z', model: 'glm-test',
    ports: { http: 7170, tls: 7171 },
    workflows: { total: 10, inflight: 2, today: 1 },
    todayTokens: { input: 100, output: 20, calls: 5 }, heldTasks: 0,
  }),
  ...over,
});

const PLAN_BLOCK = '```intake-plan\n{"title":"给 Casey 出介绍材料","summary":"产线介绍","brief":"背景：周四上门；产出：10 分钟材料"}\n```';

// ---- loop 行为 -------------------------------------------------------------------

describe('chatIntake loop', () => {
  it('clarify 回合不暂存：无计划块 → phase 停在 discuss，编排器事件进流', async () => {
    const { llm } = fakeLlm([{ content: '这单是给哪个客户的？要什么格式？' }]);
    const intake = createChatIntake({ llm, model: 'fake', tools: [], startTask: fakeStartTask().fn });
    const live: string[] = [];
    const t = await intake.turn('帮我出个材料', { onEvent: (e) => live.push(e.type) });
    expect(t.reply).toBe('这单是给哪个客户的？要什么格式？');
    // 客户端渲染依赖：text/done 事件必须随回合流出（/ws/chat 镜像）
    const types = t.events.map((e) => e.type);
    expect(types).toContain('text');
    expect(types).toContain('done');
    expect(types).not.toContain('chat:plan');
    // 实时回调与事件流逐帧一致（0929 死机感修复锚）
    expect(live).toEqual(types);
    expect(intake.state()).toEqual({ phase: 'discuss', plan: null });
  });

  it('收敛回合暂存：末尾计划块 → chat:plan + chat:phase(proposed)，reply 剥掉块', async () => {
    const { llm } = fakeLlm([{ content: `这一单要做的就是产线介绍。${PLAN_BLOCK}` }]);
    const intake = createChatIntake({ llm, model: 'fake', tools: [], startTask: fakeStartTask().fn });
    const t = await intake.turn('客户是 Casey，周四上门');
    expect(t.reply).not.toContain('intake-plan');
    expect(t.reply).toContain('产线介绍');
    const types = t.events.map((e) => e.type);
    expect(types).toContain('chat:plan');
    expect(types).toContain('chat:phase');
    const plan = intake.state().plan;
    expect(plan?.title).toBe('给 Casey 出介绍材料');
    expect(plan?.brief).toContain('周四上门');
    expect(intake.state().phase).toBe('proposed');
  });

  it('已提议后继续输入 = 修订：丢弃暂存回到讨论，文字确认不算数', async () => {
    const { llm } = fakeLlm([
      { content: `复述。${PLAN_BLOCK}` },
      { content: '好，改成一页纸版本。' },
    ]);
    const intake = createChatIntake({ llm, model: 'fake', tools: [], startTask: fakeStartTask().fn });
    await intake.turn('出材料');
    expect(intake.state().phase).toBe('proposed');
    const t = await intake.turn('改成确认');
    expect(intake.state().phase).toBe('discuss');
    expect(intake.state().plan).toBeNull();
    expect(t.events.map((e) => e.type)).toContain('chat:phase');
  });

  it('confirm = 开单正门：startTask(title, brief) 恰一次，dispatched/system 事件带 runId', async () => {
    const { llm } = fakeLlm([{ content: PLAN_BLOCK }]);
    const st = fakeStartTask('wf_confirm_1');
    const intake = createChatIntake({ llm, model: 'fake', tools: [], startTask: st.fn });
    await intake.turn('出材料');
    const r = await intake.confirm();
    expect(r.runId).toBe('wf_confirm_1');
    expect(st.calls).toEqual([{ title: '给 Casey 出介绍材料', brief: '背景：周四上门；产出：10 分钟材料' }]);
    const types = r.events.map((e) => e.type);
    expect(types).toContain('chat:dispatched');
    expect(types).toContain('chat:system');
    expect(r.events.find((e) => e.type === 'chat:dispatched')?.data).toBe('wf_confirm_1');
    expect(intake.state()).toEqual({ phase: 'discuss', plan: null });
    // 再 confirm（无暂存）不再开单
    const again = await intake.confirm();
    expect(again.runId).toBeNull();
    expect(st.calls).toHaveLength(1);
  });

  it('开单失败显性化：chat:error 事件，不装作成功', async () => {
    const { llm } = fakeLlm([{ content: PLAN_BLOCK }]);
    const intake = createChatIntake({
      llm, model: 'fake', tools: [],
      startTask: async () => ({ ok: false, error: new Error('标题过长') }) as never,
    });
    await intake.turn('出材料');
    const r = await intake.confirm();
    expect(r.runId).toBeNull();
    expect(r.events.map((e) => e.type)).toContain('chat:error');
    expect(r.events.find((e) => e.type === 'chat:error')?.data).toContain('标题过长');
  });

  it('deny：回讨论，startTask 永不触发', async () => {
    const { llm } = fakeLlm([{ content: PLAN_BLOCK }]);
    const st = fakeStartTask();
    const intake = createChatIntake({ llm, model: 'fake', tools: [], startTask: st.fn });
    await intake.turn('出材料');
    const r = intake.deny();
    expect(intake.state()).toEqual({ phase: 'discuss', plan: null });
    expect(r.events.map((e) => e.type)).toContain('chat:phase');
    expect(st.calls).toHaveLength(0);
  });

  it('语音回合：输入前缀进 LLM 且 system prompt 是开单纪律', async () => {
    const { llm, requests } = fakeLlm([{ content: '好的，简短问一句。' }]);
    const intake = createChatIntake({ llm, model: 'fake', tools: [], startTask: fakeStartTask().fn });
    await intake.turn('帮我出个材料', { voice: true });
    expect(requests[0]!.messages[0]).toMatchObject({ role: 'system', content: INTAKE_SYSTEM_PROMPT });
    const lastUser = [...requests[0]!.messages].reverse().find((m) => m.role === 'user');
    expect(lastUser?.content).toContain('[语音输入]');
    expect(lastUser?.content).toContain('帮我出个材料');
  });

  it('只读工具经编排器循环可调（lookup_customer 结果回到模型上下文）', async () => {
    const { llm, requests } = fakeLlm([
      { content: '', toolCalls: [{ id: 't1', name: 'lookup_customer', arguments: '{"query":"casey"}' }] },
      { content: 'Casey 是 Acme 的，历史 3 单。这单要什么产出？' },
    ]);
    const intake = createChatIntake({ llm, model: 'fake', tools: makeChatTools(toolDeps()), startTask: fakeStartTask().fn });
    const t = await intake.turn('给 casey 出个材料');
    expect(t.reply).toContain('Acme');
    // 工具结果作为 role=tool 消息（toolResults 字段）回到第二轮上下文
    expect(requests[1]!.messages.some((m) => m.role === 'tool' && JSON.stringify(m.toolResults).includes('acme.de'))).toBe(true);
  });

  // ---- 落点（0930「所有的都走路由」）：chat 层不自选会话 -------------------------

  it('落点展示：暂存时调 resolveLanding，state/chat:plan 带 landing；机器判定不再注入（执行层判）', async () => {
    const { llm } = fakeLlm([{ content: PLAN_BLOCK }]);
    const st = fakeStartTask('wf_land_1');
    const asked: { title: string; brief: string }[] = [];
    const intake = createChatIntake({
      llm, model: 'fake', tools: [], startTask: st.fn,
      resolveLanding: async (title, brief) => {
        asked.push({ title, brief });
        return { session: 'acme', note: 'acme 忙 → 改道 meridian-product-stats', via: 'jev', diverted: false };
      },
    });
    const t = await intake.turn('出材料');
    expect(asked).toEqual([{ title: '给 Casey 出介绍材料', brief: '背景：周四上门；产出：10 分钟材料' }]);
    const plan = intake.state().plan!;
    expect(plan.landing).toEqual({ session: 'acme', note: 'acme 忙 → 改道 meridian-product-stats', via: 'jev', diverted: false });
    // chat:plan 事件载荷带 landing（客户端渲染落点行）
    const planEvt = t.events.find((e) => e.type === 'chat:plan') as { data: string } | undefined;
    expect(planEvt).toBeDefined();
    expect(JSON.parse(planEvt!.data).landing).toEqual({ session: 'acme', note: 'acme 忙 → 改道 meridian-product-stats', via: 'jev', diverted: false });
    const r = await intake.confirm();
    expect(r.runId).toBe('wf_land_1');
    // 2026-10-13 判定收敛执行层：机器判定（jev/改道）不随 input.session 注入
    // ——计划卡落点是展示预测，真判定在派发时刻（engine steps 三无腿）。
    expect(st.calls[0]).not.toHaveProperty('session');
  });

  it('钉住转述：用户点名会话在 pinnableSessions 内 → 不调 resolveLanding，confirm 钉死', async () => {
    const block = '```intake-plan\n{"title":"t","summary":"s","brief":"b","pinned_session":"juli-dev"}\n```';
    const { llm } = fakeLlm([{ content: block }]);
    const st = fakeStartTask();
    const intake = createChatIntake({
      llm, model: 'fake', tools: [], startTask: st.fn,
      resolveLanding: async () => { throw new Error('钉住时不得走判定'); },
      pinnableSessions: ['juli-dev', 'acme'],
    });
    await intake.turn('这单给 juli-dev');
    const plan = intake.state().plan!;
    expect(plan.pinnedSession).toBe('juli-dev');
    expect(plan.landing).toEqual({ session: 'juli-dev', note: '按你指定的会话（不改道，忙则排队）' });
    await intake.confirm();
    expect(st.calls[0]).toMatchObject({ session: 'juli-dev' });
  });

  it('无效钉住（不在名单/LLM 幻觉）→ 转述作废；判定结果仅展示不注入', async () => {
    const block = '```intake-plan\n{"title":"t","summary":"s","brief":"b","pinned_session":"不存在的会话"}\n```';
    const { llm } = fakeLlm([{ content: block }]);
    const st = fakeStartTask();
    const intake = createChatIntake({
      llm, model: 'fake', tools: [], startTask: st.fn,
      resolveLanding: async () => ({ session: 'juli-reply', note: 'juli-reply', via: 'jev', diverted: false }),
      pinnableSessions: ['juli-dev'],
    });
    await intake.turn('给那个谁');
    const plan = intake.state().plan!;
    expect(plan.pinnedSession).toBe(''); // 钉住作废清空
    expect(plan.landing).toEqual({ session: 'juli-reply', note: 'juli-reply', via: 'jev', diverted: false });
    await intake.confirm();
    expect(st.calls[0]).not.toHaveProperty('session'); // 判定收敛执行层：不注入
  });

  it('resolveLanding 抛错 fail-open：session 空 → confirm 不带 session（default），不开天窗', async () => {
    const { llm } = fakeLlm([{ content: PLAN_BLOCK }]);
    const st = fakeStartTask();
    const intake = createChatIntake({
      llm, model: 'fake', tools: [], startTask: st.fn,
      resolveLanding: async () => { throw new Error('网关炸了'); },
    });
    await intake.turn('出材料');
    const plan = intake.state().plan!;
    expect(plan.landing).toEqual({ session: '', note: '' });
    await intake.confirm();
    expect(st.calls[0]).not.toHaveProperty('session');
  });

  it('机器判定不注入 → onDispatched 零留痕（留痕只属于真注入=用户钉住）', async () => {
    const { llm } = fakeLlm([{ content: PLAN_BLOCK }]);
    const dispatched: { id: string; session: string; pinned: boolean }[] = [];
    const intake = createChatIntake({
      llm, model: 'fake', tools: [], startTask: fakeStartTask('wf_audit').fn,
      resolveLanding: async () => ({ session: 'villa', note: 'villa', via: 'jev', diverted: false }),
      onDispatched: (info) => dispatched.push({ id: info.id, session: info.session, pinned: info.pinned }),
    });
    await intake.turn('官网反馈');
    await intake.confirm();
    expect(dispatched).toEqual([]); // 判定收敛执行层：没注入就不留「注过」的痕
  });

  it('fail-open default（via=default 未改道）→ confirm 不注 session、onDispatched 不留痕（十一跑 P1-1）', async () => {
    // routeTask 判定挂/off/低置信时恒返回非空 default——旧 confirm 只判非空
    // 就注入，把 fail-open 落点当真判定钉死（session_pinned），忙时只排队。
    const { llm } = fakeLlm([{ content: PLAN_BLOCK }]);
    const st = fakeStartTask();
    const dispatched: unknown[] = [];
    const intake = createChatIntake({
      llm, model: 'fake', tools: [], startTask: st.fn,
      resolveLanding: async () => ({ session: 'juli-reply', note: 'juli-reply', via: 'default', diverted: false }),
      onDispatched: (info) => dispatched.push(info),
    });
    await intake.turn('出材料');
    const plan = intake.state().plan!;
    expect(plan.landing?.session).toBe('juli-reply'); // 计划卡照常显示落点（display 与注入分离）
    await intake.confirm();
    expect(st.calls[0]).not.toHaveProperty('session'); // 不把 default 当显式钉住
    expect(dispatched).toHaveLength(0); // 「没判」不记成「判过」——零 route_decision
  });

  it('忙闲改道（diverted=true）的判定结果 → 仅展示不注入（执行层对实时忙闲重判）', async () => {
    const { llm } = fakeLlm([{ content: PLAN_BLOCK }]);
    const st = fakeStartTask('wf_divert_1');
    const dispatched: { id: string; session: string; note: string; pinned: boolean }[] = [];
    const intake = createChatIntake({
      llm, model: 'fake', tools: [], startTask: st.fn,
      resolveLanding: async () => ({ session: 'juli-dev', note: 'juli-reply 忙 → 改道 juli-dev', via: 'default', diverted: true }),
      onDispatched: (info) => dispatched.push(info),
    });
    await intake.turn('出材料');
    await intake.confirm();
    expect(st.calls[0]).not.toHaveProperty('session'); // 进件快照的改道不作数
    expect(dispatched).toHaveLength(0);
  });

  it('onDispatched 留痕抛错 → 已开的单不报错：runId 正常返回（十一跑 P2-2，钉住注入路径）', async () => {
    const block = '```intake-plan\n{"title":"t","summary":"s","brief":"b","pinned_session":"juli-dev"}\n```';
    const { llm } = fakeLlm([{ content: block }]);
    const logs: string[] = [];
    const intake = createChatIntake({
      llm, model: 'fake', tools: [], startTask: fakeStartTask('wf_audit_boom').fn,
      pinnableSessions: ['juli-dev'],
      onDispatched: () => { throw new Error('账本炸了'); },
      log: (m) => logs.push(m),
    });
    await intake.turn('给 juli-dev');
    const r = await intake.confirm();
    expect(r.runId).toBe('wf_audit_boom'); // 单已开，留痕失败只记日志
    expect(r.events.map((e) => e.type)).toContain('chat:dispatched');
    expect(logs.join('\n')).toContain('留痕失败');
  });
});

// ---- 计划块解析 -------------------------------------------------------------------

describe('extractIntakePlanBlock / stripIntakePlanBlock', () => {
  it('缺 title 或 brief 判非法（null）', () => {
    expect(extractIntakePlanBlock('```intake-plan\n{"title":"t"}\n```')).toBeNull();
    expect(extractIntakePlanBlock('```intake-plan\nnot json\n```')).toBeNull();
    expect(extractIntakePlanBlock('没有块')).toBeNull();
  });
  it('strip 只去块，保留正文', () => {
    expect(stripIntakePlanBlock(`前文。${PLAN_BLOCK}后文`)).toBe('前文。后文');
  });
});

// ---- 白名单只读硬断言 --------------------------------------------------------------

describe('chatTools 白名单', () => {
  it('封闭清单：工具名与 CHAT_TOOL_NAMES 完全一致，零写语义工具', () => {
    const tools = makeChatTools(toolDeps());
    expect(tools.map((t) => t.name)).toEqual([...CHAT_TOOL_NAMES]);
    // 写语义动词进工具名 = 白名单被突破，当场红。
    const WRITE_VERBS = /^(send|create|update|delete|remove|write|dispatch|approve|deny|amend|intervene|set|put|patch|post)_/i;
    for (const t of tools) {
      expect(WRITE_VERBS.test(t.name)).toBe(false);
    }
  });

  it('lookup_customer 空查询 → []；list_tasks 收敛 limit（100 窗）并透传 scope/q', async () => {
    const seen: string[] = [];
    const deps = toolDeps({
      listTasks: (scope, limit, q) => {
        seen.push(`${scope}|${limit}|${q}`);
        return [{ id: `${scope}:${limit}:${q}`, title: 'x', status: 'running', updatedAt: '' }];
      },
    });
    const tools = makeChatTools(deps);
    const lookup = tools.find((t) => t.name === 'lookup_customer')!;
    const list = tools.find((t) => t.name === 'list_tasks')!;
    const val = async (r: Promise<{ ok: boolean; value?: string; error?: Error }>): Promise<string> => {
      const v = await r;
      return v.ok ? (v.value ?? '') : `err:${v.error?.message}`;
    };
    expect(await val(lookup.execute({ query: '   ' }))).toBe('[]');
    expect(await val(lookup.execute({ query: 'casey' }))).toContain('acme.de');
    // 收敛窗（2026-10-14 用户裁定「找单子只能找 20 太少」）：999→100、
    // 0→1、缺省→20。
    expect(await val(list.execute({ scope: 'recent', limit: 999 }))).toContain('"recent:100:"');
    expect(await val(list.execute({ scope: 'inflight', limit: 0 }))).toContain('"inflight:1:"');
    expect(await val(list.execute({ scope: 'bogus' }))).toContain('"inflight:20:"');
    // q 关键词透传（trim 后；缺省=空串不过滤）。
    expect(await val(list.execute({ scope: 'recent', q: ' 税收 ' }))).toContain('"recent:20:税收"');
    expect(seen[seen.length - 1]).toBe('recent|20|税收');
  });

  it('get_task：命中回全息、未命中 found:false、空参拒；list_sessions/service_info 直通', async () => {
    const tools = makeChatTools(toolDeps());
    const val = async (r: Promise<{ ok: boolean; value?: string; error?: Error }>): Promise<string> => {
      const v = await r;
      return v.ok ? (v.value ?? '') : `err:${v.error?.message}`;
    };
    const getTask = tools.find((t) => t.name === 'get_task')!;
    expect(await val(getTask.execute({ wf_id: 'wf_known000001' }))).toContain('"waiting_human"');
    expect(await val(getTask.execute({ wf_id: 'wf_nope' }))).toBe('{"found":false}');
    expect(await val(getTask.execute({}))).toContain('"found":false');
    const sessions = tools.find((t) => t.name === 'list_sessions')!;
    expect(await val(sessions.execute({}))).toContain('"juli-dev"');
    const info = tools.find((t) => t.name === 'service_info')!;
    expect(await val(info.execute({}))).toContain('"test-ver"');

    // 读函数抛错 → 工具错误回模型，不炸穿回合（P2 纪律同 lookup）。
    const boom = makeChatTools(toolDeps({ getTask: async () => { throw new Error('db down'); } }));
    const r = await boom.find((t) => t.name === 'get_task')!.execute({ wf_id: 'x' });
    expect(r.ok).toBe(false);
  });
});

// ---- 路由契约 ---------------------------------------------------------------------

describe('HTTP /api/chat/intake/*', () => {
  const makeApp = (chatIntake: unknown): Hono<AppEnv> => {
    const app = new Hono<AppEnv>();
    const rt = {
      chatIntake,
      emitChat: () => undefined,
      usage: { stats: () => ({}), timeline: () => [] },
      // R1 P2-4 起路由注册即读 config.data_dir（附件目录与数据面同根）——
      // fake rt 补齐（临时路径即可：本组用例不触上传/附件校验的落盘）。
      config: { data_dir: join(tmpdir(), 'juli-chat-intake-fake') },
    } as unknown as Runtime;
    registerChatRoutes(app, rt);
    return app;
  };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试 JSON 探针：data=JSON.parse 动态形态，下游数十处临时断言消费，精确建型需给全部 expect 补窄化（零安全增益 churn）。
  const j = async (app: Hono<AppEnv>, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  it('turn：input 必填；事件+reply 回传；voice 透传', async () => {
    const { llm } = fakeLlm([{ content: '问句' }, { content: '语音回复' }]);
    const intake = createChatIntake({ llm, model: 'fake', tools: [], startTask: fakeStartTask().fn });
    const app = makeApp(intake);
    expect((await j(app, 'POST', '/api/chat/intake/turn', {})).status).toBe(400);
    expect((await j(app, 'POST', '/api/chat/intake/turn', { input: '  ' })).status).toBe(400);
    const r = await j(app, 'POST', '/api/chat/intake/turn', { input: '出材料' });
    expect(r.status).toBe(200);
    expect(r.data.reply).toBe('问句');
    // 编排器事件在响应流里（路由层镜像进 chatHub 的同一份）
    expect(r.data.events.map((e: { type: string }) => e.type)).toContain('text');
    const r2 = await j(app, 'POST', '/api/chat/intake/turn', { input: '语音说的', voice: true });
    expect(r2.data.reply).toBe('语音回复');
  });

  it('confirm/deny/state：收敛→确认带 runId；未配置 503', async () => {
    const { llm } = fakeLlm([{ content: PLAN_BLOCK }]);
    const intake = createChatIntake({ llm, model: 'fake', tools: [], startTask: fakeStartTask('wf_route_1').fn });
    const app = makeApp(intake);
    expect((await j(app, 'GET', '/api/chat/intake/state')).data.phase).toBe('discuss');
    await j(app, 'POST', '/api/chat/intake/turn', { input: '出材料' });
    expect((await j(app, 'GET', '/api/chat/intake/state')).data.phase).toBe('proposed');
    const c = await j(app, 'POST', '/api/chat/intake/confirm');
    expect(c.data.runId).toBe('wf_route_1');
    expect((await j(app, 'GET', '/api/chat/intake/state')).data.phase).toBe('discuss');
    const d = await j(app, 'POST', '/api/chat/intake/deny');
    expect(d.status).toBe(200);
    // 未配置 LLM → 503 显性化
    const off = makeApp(null);
    expect((await j(off, 'POST', '/api/chat/intake/turn', { input: 'x' })).status).toBe(503);
    expect((await j(off, 'GET', '/api/chat/intake/state')).data).toEqual({ phase: 'discuss', plan: null });
  });
});

// ---- 引擎级（十一跑 P1-1）：chat fail-open default 不钉、忙时改道 --------------
// runtime 同款装配（startTask=engine.startTask 正门 + resolveLanding=routeTask
// 判定结果）+ 真引擎忙世界，锁「fail-open 形态不注入不钉」与「jev 真判定注入
// 即钉」两侧——修复前 fail-open 落点被播种 session_pinned 钉死、忙时只排队。

describe('chat 线落点注入引擎级（十一跑 P1-1）', () => {
  const CHAT_BRIEF = 'chat fail-open 独特标记 brief';
  const PLAN = `\`\`\`intake-plan\n{"title":"chat 兜底单","summary":"s","brief":"${CHAT_BRIEF}"}\n\`\`\``;
  type Landing = { session: string; note: string; via: 'jev' | 'default'; diverted: boolean };

  const setup = (landing: Landing) => {
    const w = makeEngine({
      queueConcurrency: 2,
      routing: {
        defaultSession: 'juli-reply', defaultProject: 'p',
        agents: [
          { session: 'juli-reply', company: 'juli', domain: 'reply' },
          { session: 'juli-dev', company: 'juli', domain: 'dev' },
        ],
      },
      availableSessions: ['juli-reply', 'juli-dev'],
    });
    const { llm } = fakeLlm([{ content: PLAN }]);
    const audit: { id: string; session: string; pinned: boolean }[] = [];
    const intake = createChatIntake({
      llm, model: 'fake', tools: [],
      // runtime 同款正门：session 注入=随 input 播种（钉住通道）。
      startTask: async (title, brief, session) => {
        const wf = await w.engine.startTask(title, session !== undefined && session !== '' ? { brief, session } : { brief });
        return ok({ id: wf.id });
      },
      // runtime 同款落点面：routeTask 判定结果透传（此处用固定 landing 代表
      // 判定形态——fail-open / jev 两种，见各用例）。
      resolveLanding: async () => landing,
      onDispatched: (info) => audit.push({ id: info.id, session: info.session, pinned: info.pinned }),
    });
    return { w, intake, audit };
  };

  it('fail-open default（via=default 未改道）→ 不钉；juli-reply 忙时派发改道 juli-dev', async () => {
    const { w, intake, audit } = setup({ session: 'juli-reply', note: 'juli-reply', via: 'default', diverted: false });
    // 忙世界：juli-reply 名下有在跑单（sessionHasOpenWork 占忙）。
    const busy = await w.engine.startTask('占用 juli-reply', { brief: 'busy', session: 'juli-reply' });
    await until(() => w.store.getWorkflow(busy.id)!.status === 'running');
    await intake.turn('出材料');
    const r = await intake.confirm();
    expect(r.runId).not.toBeNull();
    const step = w.store.stepsForWorkflow(r.runId!)[0]!;
    // 不钉：首步无 session 无 session_pinned（与 HTTP 线 fail-open 同款口径）。
    expect(step.input['session']).toBeUndefined();
    expect(step.input['session_pinned']).toBeUndefined();
    // 忙时改道：落 juli-dev，绝不挤进忙死的 juli-reply（修复前钉死只排队）。
    await until(() => w.dispatched.some((d) => d.text.includes(CHAT_BRIEF)));
    const hit = w.dispatched.find((d) => d.text.includes(CHAT_BRIEF))!;
    expect(hit.session).toBe('juli-dev');
    // fail-open 不留 route_decision（「没判」不记成「判过」）。
    expect(audit).toHaveLength(0);
  });

  it('对照：via=jev 真判定 → 不再注入（判定收敛执行层）——default 直达，忙会话守卫照常', async () => {
    const { w, intake, audit } = setup({ session: 'juli-dev', note: 'juli-dev', via: 'jev', diverted: false });
    const busy = await w.engine.startTask('占用 juli-dev', { brief: 'busy', session: 'juli-dev' });
    await until(() => w.store.getWorkflow(busy.id)!.status === 'running');
    await intake.turn('出材料');
    const r = await intake.confirm();
    expect(r.runId).not.toBeNull();
    const step = w.store.stepsForWorkflow(r.runId!)[0]!;
    // 机器判定不随 input.session 注入播种——计划卡落点是展示预测，真判定
    // 在派发时刻（engine steps 三无腿，本测试世界无 taskRoute 缝=走 default）。
    expect(step.input['session']).toBeUndefined();
    expect(step.input['session_pinned']).toBeUndefined();
    await until(() => w.dispatched.some((d) => d.text.includes(CHAT_BRIEF)));
    // default juli-reply 空闲 → 直达（不注入，也不改道去忙的 juli-dev）
    expect(w.dispatched.find((d) => d.text.includes(CHAT_BRIEF))!.session).toBe('juli-reply');
    expect(audit).toEqual([]); // 「没注入」不记成「注过」
  });
});
