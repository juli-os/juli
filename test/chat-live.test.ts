// 发单对话「call 效果」围栏（2026-10-21）：/ws/chat 帧 → UI 操作的判定层
// （chat-live.ts，零 DOM）+ chat.ts 接线防回退。语义对照 iOS ChatViewModel
// handleMessage（thinking 累计/assistant chunk 原位合并/done 收口/plan 出卡/
// phase 非 proposed 清卡）；去重标记=POST 回包降级为兜底与终稿校正的依据。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chatReconnectDelayMs, chatWsUrl, createLiveChat, stripPlanBlocks, toolNameOf } from '../web/src/chat-live.ts';

describe('toolNameOf：tool_call 帧只露工具名（参数原文不进界面）', () => {
  it('JSON {tool,args} 取 tool；非 JSON 原串（超长截断）', () => {
    expect(toolNameOf('{"tool":"list_tasks","args":{"limit":50}}')).toBe('list_tasks');
    expect(toolNameOf('{"name":"get_task"}')).toBe('get_task');
    expect(toolNameOf('service_info')).toBe('service_info');
    expect(toolNameOf('x'.repeat(60))).toBe(`${'x'.repeat(40)}…`);
  });
});

describe('stripPlanBlocks：intake-plan 围栏不进气泡（iOS 同款正则）', () => {
  it('剥 ```intake-plan 与 ```plan 两种围栏，保留其余文本', () => {
    expect(stripPlanBlocks('好的，这样安排：\n```intake-plan\n{"title":"x"}\n```\n再确认一下')).toBe('好的，这样安排：\n再确认一下');
    expect(stripPlanBlocks('前```plan\n{}\n```   后')).toBe('前后');
    expect(stripPlanBlocks('没有围栏')).toBe('没有围栏');
  });

  // b45 R1-FX P2：围栏名词边界（(?![a-z0-9-])，与服务端/webapp 同批同法）——
  // ```plaintext/```plantuml 等前缀撞名块不再被误吃（完整块与半开尾块两形态）。
  it('词边界：plaintext/plantuml 保留、plan 照常剥（b45 R1-FX P2）', () => {
    expect(stripPlanBlocks('a\n```plaintext\nhi\n```\nb')).toBe('a\n```plaintext\nhi\n```\nb');
    expect(stripPlanBlocks('a\n```plantuml\n@startuml')).toBe('a\n```plantuml\n@startuml');
    expect(stripPlanBlocks('前```plan\n{}\n```   后')).toBe('前后'); // 真计划围栏零回退
  });
});

describe('帧流地址与退避', () => {
  it('conv 走 query，token 有则附（wirehubs.acceptWithToken 口径）', () => {
    expect(chatWsUrl('ws', '127.0.0.1:7170', 'web-abc', '')).toBe('ws://127.0.0.1:7170/ws/chat?conv=web-abc');
    expect(chatWsUrl('wss', 'h', 'c d', 'p w')).toBe('wss://h/ws/chat?conv=c%20d&token=p%20w');
  });

  it('退避 1s 起倍增封顶 15s', () => {
    expect([0, 1, 2, 3, 4, 9].map(chatReconnectDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
  });
});

describe('流式回合：thinking 累计 → assistant chunk 合并 → done 定稿', () => {
  it('thinking 整段累计重绘；首个 assistant chunk 新开气泡，后续追加；done 收口', () => {
    const live = createLiveChat();
    expect(live.handle({ type: 'thinking', data: '先看' })).toEqual([{ kind: 'thinking', text: '先看' }]);
    expect(live.handle({ type: 'thinking', data: '天气' })).toEqual([{ kind: 'thinking', text: '先看天气' }]);
    expect(live.handle({ type: 'assistant', data: '明天' })).toEqual([{ kind: 'assistant_chunk', text: '明天', fresh: true }]);
    expect(live.handle({ type: 'assistant', data: '晴。' })).toEqual([{ kind: 'assistant_chunk', text: '晴。', fresh: false }]);
    expect(live.handle({ type: 'done' })).toEqual([{ kind: 'turn_done' }]);
    // 下一轮再来 chunk = 新气泡
    expect(live.handle({ type: 'assistant', data: '第二轮' })[0]).toMatchObject({ fresh: true });
  });

  it('assistant chunk 里的 intake-plan 围栏被剥；剥空的块不产操作', () => {
    const live = createLiveChat();
    expect(live.handle({ type: 'assistant', data: '```intake-plan\n{"title":"a"}\n```' })).toEqual([]);
    expect(live.handle({ type: 'assistant', data: '好的```plan\n{}\n```收到' })).toEqual([{ kind: 'assistant_chunk', text: '好的收到', fresh: true }]);
  });

  it('ping 与未知帧忽略；tool_call/system/error/dispatched 原样成操作', () => {
    const live = createLiveChat();
    expect(live.handle({ type: 'ping', data: '' })).toEqual([]);
    expect(live.handle({ type: 'whatever', data: 'x' })).toEqual([]);
    expect(live.handle({ type: 'tool_call', data: '{"tool":"list_tasks","args":{}}' })).toEqual([{ kind: 'tool', name: 'list_tasks' }]);
    expect(live.handle({ type: 'system', data: '已开单 ✓ wf_1' })).toEqual([{ kind: 'system', text: '已开单 ✓ wf_1' }]);
    expect(live.handle({ type: 'error', data: '' })).toEqual([{ kind: 'error', text: 'unknown error' }]);
    expect(live.handle({ type: 'dispatched', data: 'wf_abc' })).toEqual([{ kind: 'dispatched', id: 'wf_abc' }]);
  });

  it('error 帧收口流式气泡（之后 chunk 新开）', () => {
    const live = createLiveChat();
    live.handle({ type: 'assistant', data: 'a' });
    live.handle({ type: 'error', data: 'boom' });
    expect(live.handle({ type: 'assistant', data: 'b' })[0]).toMatchObject({ fresh: true });
  });

  it('掉线：流式中立即定稿（done 无缓冲无回放，已丢）；空闲掉线无操作', () => {
    const live = createLiveChat();
    expect(live.disconnected()).toEqual([]);
    live.handle({ type: 'assistant', data: 'a' });
    expect(live.disconnected()).toEqual([{ kind: 'turn_done' }]);
  });
});

describe('计划卡与相位', () => {
  it('plan 帧解析出卡；JSON 变形给 null（显性告警不静默）', () => {
    const live = createLiveChat();
    const ok = live.handle({ type: 'plan', data: JSON.stringify({ title: 'T', summary: 'S', brief: 'B', landing: { session: 's', note: 'n' } }) });
    expect(ok).toEqual([{ kind: 'plan', plan: { title: 'T', summary: 'S', brief: 'B', landing: { session: 's', note: 'n' } } }]);
    expect(live.handle({ type: 'plan', data: '{not json' })).toEqual([{ kind: 'plan', plan: null }]);
    expect(live.handle({ type: 'plan', data: '{"summary":"no title"}' })).toEqual([{ kind: 'plan', plan: null }]);
  });

  it('phase：缺省 discuss；视图据「非 proposed 即清卡」', () => {
    const live = createLiveChat();
    expect(live.handle({ type: 'phase', data: '' })).toEqual([{ kind: 'phase', phase: 'discuss' }]);
    expect(live.handle({ type: 'phase', data: 'proposed' })).toEqual([{ kind: 'phase', phase: 'proposed' }]);
  });
});

describe('去重标记：操作期间帧到过 → POST 回包只校正不重渲染', () => {
  it('beginOp 后任一非 ping 帧置 liveSeen；assistant 置 streamed；done 置 sawDone；endOp 归零', () => {
    const live = createLiveChat();
    live.handle({ type: 'assistant', data: '操作前的帧不算' });
    live.beginOp();
    expect(live.liveSeen()).toBe(false);
    live.handle({ type: 'ping', data: '' });
    expect(live.liveSeen()).toBe(false);
    live.handle({ type: 'thinking', data: 'x' });
    expect(live.liveSeen()).toBe(true);
    expect(live.streamed()).toBe(false);
    live.handle({ type: 'assistant', data: 'y' });
    expect(live.streamed()).toBe(true);
    expect(live.sawDone()).toBe(false);
    live.handle({ type: 'done' });
    expect(live.sawDone()).toBe(true);
    live.endOp();
    expect([live.liveSeen(), live.streamed(), live.sawDone()]).toEqual([false, false, false]);
  });
});

// ---- chat.ts 接线防回退（文本级，web-shell.test 同手法）-----------------------------

const chatSrc = readFileSync(resolve(import.meta.dirname, '../web/src/views/chat.ts'), 'utf8');

describe('chat.ts call 效果接线', () => {
  it('订阅 /ws/chat 帧流（conv 过滤+token），断线退避重连，新对话换订阅', () => {
    expect(chatSrc).toContain("from '../chat-live.ts'");
    expect(chatSrc).toContain('chatWsUrl(');
    expect(chatSrc).toContain('chatReconnectDelayMs(liveAttempt++)');
    expect(chatSrc).toContain('reconnectLive(); // 帧流按 conv 过滤');
  });

  it('POST 回包去重：帧到过只校正终稿/补卡，没到才整包渲染', () => {
    expect(chatSrc).toContain('if (live.liveSeen()) {');
    expect(chatSrc).toContain('healAssistant(r.reply)');
    expect(chatSrc).toContain('if (!live.liveSeen()) applyEvents(r.events);');
  });

  it('异步开单：不再跳页（location.hash 深链已退役），卡片原位 pending 态', () => {
    expect(chatSrc).not.toContain("location.hash = `/lifecycle?w=${r.runId}`");
    expect(chatSrc).toContain("card?.classList.add('pending')");
    expect(chatSrc).toContain(".chat-plan.pending");
  });

  it('清理口收帧流 WS 与语音件', () => {
    expect(chatSrc).toContain('disposed = true;');
    expect(chatSrc).toContain('voiceCleanup();');
  });
});
