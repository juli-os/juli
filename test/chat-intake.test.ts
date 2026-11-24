// 开单对话（chat intake）契约测试：loop 行为（clarify/收敛/确认/取消/
// 失败显性化）+ 白名单只读硬断言 + 路由契约（turn/confirm/deny/state）。
// 对话不进账：全程无账本写断言靠 startTask 只在 confirm 被调一次锁定。

import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ok } from '../src/platform/shared/result.ts';
import { type ChatLlmPort, type ToolCallRequest } from '@juli-os/agents';
import { createChatIntake, extractIntakePlanBlock, stripIntakePlanBlock, hasIntakePlanBlock, INTAKE_SYSTEM_PROMPT, type ChatIntakeDeps, type ChatIntakeStreamEvent } from '../src/business/intake/chatIntake.ts';
import { CHAT_TOOL_NAMES, makeChatTools, type ChatToolDeps } from '../src/business/intake/chatTools.ts';
import { openGatesStore } from '../src/business/gates/index.ts';
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

  // b44 R1 P1 回归：多段回复（text→tool_call→text 是编排器常态）。reply 必须是
  // 全段累积（'\n\n' 连接，与客户端 mergeAssistant 分段口同形），未修时只剩末段、
  // 客户端 heal 会把多段合并稿改写成只剩末段（DOM+transcript 双丢前段）。
  it('多段回合：reply 累积全段而非只剩末段', async () => {
    const { llm } = fakeLlm([
      { content: '先查一下在办单子。', toolCalls: [{ id: 't1', name: 'list_tasks', arguments: '{}' }] },
      { content: '查到了：3 单在办。' },
    ]);
    const intake = createChatIntake({ llm, model: 'fake', tools: [], startTask: fakeStartTask().fn });
    const t = await intake.turn('现在有哪些单子在办？');
    expect(t.reply).toBe('先查一下在办单子。\n\n查到了：3 单在办。');
    const types = t.events.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types.filter((x) => x === 'text')).toHaveLength(2);
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

  // 2026-10-27 手机「JSON 堆 + 卡不弹」事故回归（loop 级）：模型漏写闭合围栏
  // 时卡照常暂存；且流式 text 事件以净稿出闸（围栏+JSON 不进 /ws/chat ——
  // 旧 iOS 客户端逐 chunk 剥不掉跨段/半开围栏，原文会直接糊屏）。
  it('半开围栏提议：卡照常暂存，流式 text 净稿无围栏（2026-10-27 事故回归）', async () => {
    const { llm } = fakeLlm([{ content: '复述这一单。\n```intake-plan\n{"title":"t","summary":"s","brief":"b"}' }]);
    const intake = createChatIntake({ llm, model: 'fake', tools: [], startTask: fakeStartTask().fn });
    const streamed: string[] = [];
    const t = await intake.turn('开这一单', {
      onEvent: (e) => { if (e.type === 'text') streamed.push(e.content); },
    });
    expect(intake.state().phase).toBe('proposed');
    expect(intake.state().plan?.title).toBe('t');
    expect(t.events.map((e) => e.type)).toContain('chat:plan');
    expect(t.reply).not.toContain('intake-plan');
    expect(streamed.join('')).not.toContain('intake-plan'); // 流式净稿
    expect(streamed.join('')).toContain('复述这一单'); // 正文原样
  });
  it('流式净稿：闭合计划块的 text 事件同样剥净再出闸', async () => {
    const { llm } = fakeLlm([{ content: `这一单要做的就是产线介绍。${PLAN_BLOCK}` }]);
    const intake = createChatIntake({ llm, model: 'fake', tools: [], startTask: fakeStartTask().fn });
    const streamed: string[] = [];
    const t = await intake.turn('客户是 Casey，周四上门', {
      onEvent: (e) => { if (e.type === 'text') streamed.push(e.content); },
    });
    expect(t.reply).toContain('产线介绍');
    expect(streamed.join('')).not.toContain('intake-plan');
    expect(streamed.join('')).toContain('产线介绍');
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
      startTask: async () => ({ ok: false as const, error: new Error('标题过长') }),
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

  // 2026-10-27 手机「JSON 堆 + 卡不弹」事故回归：glm-5.3-flash 多次漏写闭合
  // 围栏（JSON 完整、结尾断在 `"}`）——旧提取只认闭合围栏 → 卡永不弹；旧
  // 在场判定同漏 → 「JSON 炸了」告警也被静默吞。
  it('半开围栏：JSON 完整 → 照常提取（闭合围栏缺失不再吞卡）', () => {
    const p = extractIntakePlanBlock('复述这一单。\n```intake-plan\n{"title":"t","summary":"s","brief":"b"}');
    expect(p).not.toBeNull();
    expect(p?.title).toBe('t');
    expect(p?.brief).toBe('b');
  });
  it('半开围栏：JSON 尾部手抖 → firstBalancedObject 兜住', () => {
    const p = extractIntakePlanBlock('```intake-plan\n{"title":"t","summary":"s","brief":"b"};\n后缀废话');
    expect(p?.title).toBe('t');
  });
  it('半开围栏：JSON 截断 → 提取 null 但在场=true（告警路径覆盖半开）', () => {
    expect(extractIntakePlanBlock('```intake-plan\n{"title":"t","brief":"b')).toBeNull();
    expect(hasIntakePlanBlock('```intake-plan\n{"title":"t"')).toBe(true);
  });
  it('在场判定词边界：```plaintext / ```plantuml 不算计划块', () => {
    expect(hasIntakePlanBlock('```plaintext\nhello\n```')).toBe(false);
    expect(hasIntakePlanBlock('```plantuml\nx\n```')).toBe(false);
    expect(hasIntakePlanBlock('```intake-plan\n{}')).toBe(true);
  });

  // b44 R2 NEW-γ：strip 与 webapp 客户端 stripPlanFences（chat-live.ts）同口径
  // ——全局、双名（intake-plan|plan）、半开围栏也剥。此前服务端只剥第一处、
  // 只认 intake-plan：LLM 输出 ```plan 围栏或双块时 reply 残留围栏 ≠ 客户端
  // 剥净稿，heal 把围栏 JSON 原文写回显示面。对照函数=旧正则口径的基线
  // （2026-11-23 前服务端与客户端共用的那两条正则，内联保留）：括号配平改法
  // 之后这些既有形态的输出必须一字不变。与现客户端（webapp）的行为对照在
  // test/chat-strip-parity.test.ts（动态 import 真模块）。
  it('strip 与旧正则基线同口径：```plan 双名/全局多块/半开围栏也剥（b44 R2 NEW-γ）', () => {
    const legacyStrip = (text: string): string => {
      // b45 R1-FX P2：围栏名加词边界（与三处源正则同步，漏改对照即红）
      let out = text.replace(/```(?:intake-plan|plan)(?![a-z0-9-])\s*[\s\S]*?```/g, '');
      out = out.replace(/```(?:intake-plan|plan)(?![a-z0-9-])\s*[\s\S]*$/g, ''); // 半开（流式中）
      return out.trim();
    };
    const shapes = [
      '看一下\n```plan\n{"title":"x"}\n```\n好的', // ```plan 双名
      `前文。${PLAN_BLOCK}中段${PLAN_BLOCK}后文`, // 双 intake-plan（全局多块）
      '回复到一半\n```intake-plan\n{"title":"x"', // 半开围栏
      `开场${PLAN_BLOCK}\n\`\`\`plan\n{"brief":"y"}\n\`\`\`\n收尾`, // 混合双名双块
    ];
    for (const s of shapes) {
      expect(stripIntakePlanBlock(s), `形态不一致：${s.slice(0, 30)}…`).toBe(legacyStrip(s));
    }
    // 行为抽查：围栏剥净、正文原样保留（前后正文间的换行不动、首尾 trim——
    // 口径与客户端逐字节一致，上方对照断言已证）。
    expect(stripIntakePlanBlock('看一下\n```plan\n{"title":"x"}\n```\n好的')).toBe('看一下\n\n好的');
    expect(stripIntakePlanBlock('回复到一半\n```intake-plan\n{"title":"x"')).toBe('回复到一半');
  });

  // b45 R1-FX P2：围栏名加词边界 (?![a-z0-9-])——```plaintext/```plantuml 等
  // 以 plan 为前缀的普通语言块不再被误吃（此前 FULL 从 ```plan 起配到最近 ```、
  // OPEN 尾块把剩余全文剥到串尾：代码内容被吞）；真计划围栏（双名×完整/半开）
  // 照常剥，行为零回退。不剥形态同样过 legacyStrip 对照（口径一致性含「不动」）。
  it('strip 词边界：```plaintext / ```plantuml 不误吃，```plan / ```intake-plan 照常剥（b45 R1-FX P2）', () => {
    const legacyStrip = (text: string): string => {
      let out = text.replace(/```(?:intake-plan|plan)(?![a-z0-9-])\s*[\s\S]*?```/g, '');
      out = out.replace(/```(?:intake-plan|plan)(?![a-z0-9-])\s*[\s\S]*$/g, '');
      return out.trim();
    };
    // 前缀撞名：完整块与半开尾块两形态都原样保留（含块内正文与围栏本身）
    expect(stripIntakePlanBlock('a\n```plaintext\nhi\n```\nb')).toBe('a\n```plaintext\nhi\n```\nb');
    expect(stripIntakePlanBlock('说明如下\n```plaintext\nhello')).toBe('说明如下\n```plaintext\nhello');
    expect(stripIntakePlanBlock('a\n```plantuml\n@startuml')).toBe('a\n```plantuml\n@startuml');
    expect(stripIntakePlanBlock('流程\n```plantuml\n@startuml\nA->B\n```*\n完')).toBe(
      '流程\n```plantuml\n@startuml\nA->B\n```*\n完',
    );
    // 真计划围栏照常剥（双名 × 完整/半开）
    expect(stripIntakePlanBlock('a\n```plan\n{"title":"x"}\n```\nb')).toBe('a\n\nb');
    expect(stripIntakePlanBlock('a\n```intake-plan\n{"title":"x"\n')).toBe('a');
    // 对照（不剥与剥的形态同口径）
    const shapes = [
      'a\n```plaintext\nhi\n```\nb',
      'a\n```plantuml\n@startuml',
      'a\n```plan\n{"title":"x"}\n```\nb',
      'a\n```intake-plan\n{"title":"x"',
    ];
    for (const s of shapes) {
      expect(stripIntakePlanBlock(s), `形态不一致：${s.slice(0, 30)}…`).toBe(legacyStrip(s));
    }
  });

  // 2026-11-23「brief 里带 ``` 时确认卡不弹、屏幕上漏 JSON」回归。旧实现靠非贪婪
  // 正则 ```intake-plan…``` 找结尾，brief 的字符串里出现三个反引号就停在正文
  // 内部：提取拿到半截 JSON 解析失败（卡不弹），剥除只剥到那里（后面的 JSON
  // 留在屏幕上）。2026-10-27 修过同类事故（模型漏写闭合围栏），没覆盖这种写法。
  describe('brief 里带反引号 / 转义 / 括号：按 JSON 对象括号配平找结尾', () => {
    const BRIEFS: readonly (readonly [string, string])[] = [
      ['带 ``` 命令', '背景：周四上门。构建命令：```npm run build``` 然后部署。'],
      ['带 ```bash 代码块', '步骤：\n```bash\nnpm ci\nnpm run build\n```\n产出：部署完成。'],
      ['带单个反引号', '跑 `npm test`，通过后交付。'],
      ['带转义引号与转义反斜杠', '客户说："路径是 C:\\prod\\dist，别动"。另：引号 " 与反斜杠 \\ 都要原样保留。'],
      ['括号出现在字符串里', '模板是 {"name":"{x}"} 这种；不成对也行：{ ] } 收尾。'],
      ['brief 里写了围栏名', '照 ```intake-plan 的格式输出，不要写成 ```plan。'],
    ];
    const blockOf = (brief: string): string =>
      '```intake-plan\n' + JSON.stringify({ title: '给 Casey 出介绍材料', summary: '产线介绍', brief }) + '\n```';

    for (const [name, brief] of BRIEFS) {
      it(`${name}：提取的 brief 与原文逐字符相同；剥除后不留 JSON，前后说明文字保留`, () => {
        const text = `先复述一下这一单。\n${blockOf(brief)}\n等你确认。`;
        const p = extractIntakePlanBlock(text);
        expect(p, name).not.toBeNull();
        expect(p?.brief, name).toBe(brief);
        expect(p?.title).toBe('给 Casey 出介绍材料');
        expect(p?.summary).toBe('产线介绍');
        expect(hasIntakePlanBlock(text)).toBe(true);
        const stripped = stripIntakePlanBlock(text);
        expect(stripped, name).toBe('先复述一下这一单。\n\n等你确认。');
        expect(stripped).not.toContain('"brief"');
        expect(stripped).not.toContain('intake-plan');
        // 旧名字 ```plan：剥除照旧认（显示面不留 JSON）；提取保持只认
        // intake-plan（进件语义不变——与 2026-11-23 之前一致）。
        const legacyName = text.replace('```intake-plan', '```plan');
        expect(stripIntakePlanBlock(legacyName), name).toBe('先复述一下这一单。\n\n等你确认。');
        expect(extractIntakePlanBlock(legacyName)).toBeNull();
      });
    }

    it('模型漏写闭合围栏 + brief 里带 ```：照样提取，剥到对象结束、后面的正文照留', () => {
      const brief = '构建命令：```npm run build``` 然后部署。';
      // 2026-10-27 的事故形态：结尾断在 `"}`，闭合围栏没写。
      const text = `复述。\n${blockOf(brief).slice(0, -4)}\n以上，等你确认。`;
      expect(extractIntakePlanBlock(text)?.brief).toBe(brief);
      expect(stripIntakePlanBlock(text)).toBe('复述。\n\n以上，等你确认。');
    });

    it('两块计划（第一块 brief 带 ```）：两块都剥净，中段正文保留', () => {
      const text = `开头。\n${blockOf('跑 ```make```')}\n中段。\n${blockOf('普通 brief')}\n收尾。`;
      expect(extractIntakePlanBlock(text)?.brief).toBe('跑 ```make```');
      expect(stripIntakePlanBlock(text)).toBe('开头。\n\n中段。\n\n收尾。');
    });

    it('JSON 截断（流式半开）：提取 null、在场 true；剥到文末，不留半截 JSON', () => {
      const text = '复述。\n```intake-plan\n{"title":"t","brief":"跑 ```npm run build``` 然后';
      expect(extractIntakePlanBlock(text)).toBeNull();
      expect(hasIntakePlanBlock(text)).toBe(true);
      expect(stripIntakePlanBlock(text)).toBe('复述。');
    });

    it('围栏里混进别的 JSON 对象：整块剥到闭合围栏，不漏 JSON', () => {
      const text = `复述。\n\`\`\`intake-plan\n（示意，不是计划）{"a":1}\n${JSON.stringify({ title: 't', brief: 'b' })}\n\`\`\`\n后文。`;
      expect(stripIntakePlanBlock(text)).toBe('复述。\n\n后文。');
    });

    it('对象后面跟手抖尾巴（`};`）再闭合：尾巴连同闭合围栏一并剥掉', () => {
      const text = '复述。\n```intake-plan\n{"title":"t","brief":"b"};\n```\n后文。';
      expect(extractIntakePlanBlock(text)?.brief).toBe('b');
      expect(stripIntakePlanBlock(text)).toBe('复述。\n\n后文。');
    });

    it('走完整回合：卡照常弹出（brief 原样），流式 text 帧与 reply 都不带 JSON', async () => {
      const brief = '构建命令：```npm run build``` 然后部署。';
      const { llm } = fakeLlm([{ content: `复述。\n${blockOf(brief)}\n等确认。` }]);
      const live: ChatIntakeStreamEvent[] = [];
      const intake = createChatIntake({ llm, model: 'fake', tools: [], startTask: fakeStartTask().fn });
      const r = await intake.turn('出材料', { onEvent: (e) => live.push(e) });
      expect(intake.state().phase).toBe('proposed');
      expect(intake.state().plan?.brief).toBe(brief);
      const textFrames = live.filter((e) => e.type === 'text');
      expect(textFrames).toHaveLength(1);
      expect(textFrames[0]).toMatchObject({ type: 'text', content: '复述。\n\n等确认。' });
      expect(r.reply).toBe('复述。\n\n等确认。');
      expect(live.some((e) => e.type === 'chat:plan')).toBe(true);
    });

    // 流式分段：编排器每个 LLM 回合发一个独立完整 text 事件（text→tool_call→
    // text 是常态），服务端对每个 text 事件单独剥除——计划块所在的那一段被
    // 剥净，其它段原样。
    it('流式分段：计划块所在的 text 事件单独剥净，其它段原样', async () => {
      const brief = '跑 ```npm run build```';
      const { llm } = fakeLlm([
        { content: '先查一下在办单子。', toolCalls: [{ id: 't1', name: 'list_tasks', arguments: '{}' }] },
        { content: `材料如下。\n${blockOf(brief)}` },
      ]);
      const live: ChatIntakeStreamEvent[] = [];
      const intake = createChatIntake({ llm, model: 'fake', tools: [], startTask: fakeStartTask().fn });
      const r = await intake.turn('出材料', { onEvent: (e) => live.push(e) });
      expect(intake.state().plan?.brief).toBe(brief);
      expect(live.filter((e) => e.type === 'text').map((e) => (e as { content: string }).content))
        .toEqual(['先查一下在办单子。', '材料如下。']);
      expect(r.reply).toBe('先查一下在办单子。\n\n材料如下。');
    });
  });

  // R1 审查 P2-③（2026-11-24）：计划块剥除多删正文。模型漏写闭合围栏、后面的
  // 正文里又有代码块、第二块计划或错位的围栏时，旧实现按「对象之后第一个光杆
  // 围栏」找结尾，把中间的正文一起删掉了。现在闭合围栏只有紧跟着才算：对象和
  // 围栏之间只许空白、手抖多打的 ; 和 }（以及紧挨着的又一个 JSON 对象——围栏
  // 里混进两个对象的形态，都是计划块的 JSON）。中间有别的字符，计划块就到对象
  // 结束为止，后面的正文照留。
  describe('计划块结尾的边界（R1 审查 P2-③）', () => {
    const J = JSON.stringify({ title: '给 Casey 出介绍材料', summary: '产线介绍', brief: '背景：周四上门' });
    const open = (after: string): string => `复述。\n\`\`\`intake-plan\n${after}`;
    // [名称, 围栏起点之后的内容, 期望的剥除结果]
    const CASES: readonly (readonly [string, string, string])[] = [
      ['漏闭合围栏 + 后面有代码块', `${J}\n\`\`\`bash\nnpm ci\n\`\`\`\n后文。`, '复述。\n\n```bash\nnpm ci\n```\n后文。'],
      ['漏闭合围栏 + 第二块计划（闭合）', `${J}\n\`\`\`intake-plan\n${J}\n\`\`\`\n后文。`, '复述。\n\n\n后文。'],
      ['漏闭合围栏 + 第二块计划（也没闭合）', `${J}\n\`\`\`intake-plan\n${J}\n后文。`, '复述。\n\n\n后文。'],
      ['漏闭合围栏 + 普通正文', `${J}\n以上，等你确认。`, '复述。\n\n以上，等你确认。'],
      ['漏闭合围栏 + 正文，错位的围栏在最后', `${J}\n以上。\n\`\`\``, '复述。\n\n以上。\n```'],
      ['漏闭合围栏 + 对象后夹一句说明才出现围栏', `${J}\n好的，计划如上\n\`\`\`\n后文。`, '复述。\n\n好的，计划如上\n```\n后文。'],
      ['闭合围栏紧跟（不换行）', `${J}\`\`\`\n后文。`, '复述。\n\n后文。'],
      ['闭合围栏隔一行', `${J}\n\n\`\`\`\n后文。`, '复述。\n\n后文。'],
      ['闭合围栏前隔一个分号', `${J};\n\`\`\`\n后文。`, '复述。\n\n后文。'],
      ['闭合围栏前多打了一个右花括号', `${J}}\`\`\`\n后文。`, '复述。\n\n后文。'],
      ['围栏里混进两个对象，没闭合', `{"a":1}\n${J}\n后文。`, '复述。\n\n后文。'],
      ['围栏里混进两个对象，闭合', `{"a":1}\n${J}\n\`\`\`\n后文。`, '复述。\n\n后文。'],
    ];

    it('漏闭合围栏时正文照留；闭合围栏紧跟 / 隔行 / 隔分号都照常剥（12 种形态逐个钉）', () => {
      expect(CASES.length).toBe(12);
      for (const [name, after, want] of CASES) {
        expect(stripIntakePlanBlock(open(after)), name).toBe(want);
      }
    });

    it('漏闭合围栏不影响提取：计划照常取到（正文里有没有代码块都一样）', () => {
      for (const name of ['漏闭合围栏 + 后面有代码块', '漏闭合围栏 + 普通正文', '漏闭合围栏 + 正文，错位的围栏在最后']) {
        const after = CASES.find((c) => c[0] === name)![1];
        expect(extractIntakePlanBlock(open(after))?.title, name).toBe('给 Casey 出介绍材料');
      }
    });
  });
});

// ---- 白名单只读硬断言 --------------------------------------------------------------

describe('chatTools 白名单', () => {
  /** 工具 Result → 字符串探针：ok 取 value，失败取 err:消息。 */
  const val = async (r: Promise<{ ok: boolean; value?: string; error?: Error }>): Promise<string> => {
    const v = await r;
    return v.ok ? (v.value ?? '') : `err:${v.error?.message}`;
  };

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
      // conv 分线程（2026-10-17）：fake=单桶直通（与 main 桶同语义）。
      chatIntakeFor: (_conv: string) => chatIntake,
      emitChat: () => undefined,
      usage: { stats: () => ({}), timeline: () => [] },
      // R1 P2-4 起路由注册即读 config.data_dir（附件目录与数据面同根）——
      // fake rt 补齐（临时路径即可：本组用例不触上传/附件校验的落盘）。
      config: { data_dir: join(tmpdir(), 'juli-chat-intake-fake') },
      // gates 域登记面（第 5 步）：fake rt 给一个临时文件真库（confirm/deny 审计行落这）。
      gates: openGatesStore(join(tmpdir(), `juli-chat-intake-gates-${Math.random().toString(36).slice(2)}.db`)),
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

// 2026-10-17「开单卡不弹」事故回归：LLM 计划块 JSON 尾巴带 `};` 手抖——旧
// 严格 JSON.parse 直接炸+catch 静默 null，相位永停 discuss（用户端=LLM 承诺
// 开单但卡永不出现）。边界纪律：LLM 输出=外部数据，解析须宽容（平衡花括号
// 提取）+「块在场但解析失败」可区分（hasIntakePlanBlock）。
describe('extractIntakePlanBlock 宽容解析（LLM 手抖面）', () => {
  const tonightPayload = '好的，如果没问题我按这个提议开单：\n\n```intake-plan\n{"title":"跟进单","summary":"概要","brief":"完整 brief"}\n```\n';
  it('事故原串：JSON 尾巴多 } 与分号 → 平衡提取救回', () => {
    const text = '复述……如果没问题，我按这个提议开单：\n\n```intake-plan\n{"title":"音标迭代","summary":"音标模块","brief":"三个改动点……"}\n};\n```';
    const p = extractIntakePlanBlock(text);
    expect(p?.title).toBe('音标迭代');
    expect(p?.brief).toContain('三个改动点');
  });
  it('干净块照常', () => {
    expect(extractIntakePlanBlock(tonightPayload)?.title).toBe('跟进单');
  });
  it('块后带 LLM 废话尾巴也救回（右边界收在首个平衡闭括号）', () => {
    const text = '```intake-plan\n{"title":"t","summary":"s","brief":"b"}\n以上，请确认。\n```';
    expect(extractIntakePlanBlock(text)?.title).toBe('t');
  });
  it('字符串内的花括号不误判深度（嵌套 JSON 值）', () => {
    const text = '```intake-plan\n{"title":"t","summary":"s","brief":"含 } 与 { 的内容"}\n```';
    expect(extractIntakePlanBlock(text)?.brief).toContain('含 } 与 { 的内容');
  });
  it('无块 → null 且 hasIntakePlanBlock=false；块在解析炸 → null 但 has=true（可区分告警）', () => {
    expect(extractIntakePlanBlock('没有块')).toBeNull();
    expect(hasIntakePlanBlock('没有块')).toBe(false);
    const broken = '```intake-plan\n根本不是 JSON\n```';
    expect(extractIntakePlanBlock(broken)).toBeNull();
    expect(hasIntakePlanBlock(broken)).toBe(true);
  });
});
