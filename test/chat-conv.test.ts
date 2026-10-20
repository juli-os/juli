// conv 分线程（2026-10-17 分用户第一步）契约：注册表按 conv 隔离 intake
// 实例（独立 LLM 上下文/相位/暂存计划）；chathub 帧带 conv 标签，replay 与
// WS 消费按 conv 过滤；无 conv 的旧客户端统一落 main 桶（旧单线程语义）。
// 动机=「幽灵消息」事故：单线程下任何客户端（含诊断注入）的回合出现在所有端。

import { describe, expect, it } from 'vitest';
import { ok } from '@juli-os/artifacts';
import { type ChatLlmPort } from '@juli-os/agents';
import { createChatIntakeRegistry, sanitizeConv } from '../src/business/intake/chatIntakeRegistry.ts';
import { createChatHub } from '../src/platform/ws/chathub.ts';
import { type ChatIntakeDeps } from '../src/business/intake/chatIntake.ts';

const fakeDeps = (replies: readonly string[]): ChatIntakeDeps => {
  let i = 0;
  const llm: ChatLlmPort = {
    name: 'fake',
    async chat() {
      return ok({ content: replies[Math.min(i++, replies.length - 1)]!, toolCalls: [] });
    },
  };
  return {
    llm,
    model: 'fake',
    tools: [],
    startTask: async () => ok({ id: 'wf_x' }),
    pinnableSessions: [],
    log: () => undefined,
  };
};

const PLAN = '```intake-plan\n{"title":"t","summary":"s","brief":"b"}\n```';

describe('chatIntakeRegistry conv 隔离', () => {
  it('A 线程提议后 B 线程仍是 discuss——相位/暂存互不可见', async () => {
    const reg = createChatIntakeRegistry(() => fakeDeps(['没问题' + PLAN]));
    const a = reg.of('device-a');
    await a.turn('帮我开个单', { onEvent: () => undefined });
    expect(a.state().phase).toBe('proposed');
    const b = reg.of('device-b');
    expect(b.state().phase).toBe('discuss');
    expect(b.state().plan).toBeNull();
    // A 的暂存不因 B 的回合被丢（旧单线程里任何输入都会清 staged）。
    await b.turn('随口聊聊', { onEvent: () => undefined });
    expect(a.state().phase).toBe('proposed');
  });

  it('同 conv 二次取=同实例（上下文延续）；main 桶兼容面恒在', () => {
    const reg = createChatIntakeRegistry(() => fakeDeps(['好']));
    expect(reg.of('x')).toBe(reg.of('x'));
    expect(reg.main).toBe(reg.of('main'));
  });

  it('非法 conv 一律归 main（fail-safe 旧形态）；容量封顶逐出最久未用非 main 桶', () => {
    expect(sanitizeConv('ok-id_1')).toBe('ok-id_1');
    expect(sanitizeConv('带空格 id')).toBe('main');
    expect(sanitizeConv(undefined)).toBe('main');
    expect(sanitizeConv('x'.repeat(65))).toBe('main');
    const reg = createChatIntakeRegistry(() => fakeDeps(['好']), 3);
    reg.of('a'); reg.of('b'); reg.of('c');
    expect(reg.count()).toBe(3);
    reg.of('d'); // 逐出 a（最久未用非 main；本场景 a/b/c 依序创建无 touch，最老恰=最久未用）
    expect(reg.count()).toBe(3);
    expect(reg.of('b')).toBeTruthy(); // b/c/d 在
    expect(reg.main).toBeTruthy(); // main 永驻不受逐出影响
  });

  it('真 LRU：命中刷序——活跃 conv 不被逐出（R1-F4）', () => {
    const reg = createChatIntakeRegistry(() => fakeDeps(['好']), 3);
    const a = reg.of('a');
    reg.of('b');
    reg.of('c');
    expect(reg.of('a')).toBe(a); // touch a：a 变「最近使用」
    reg.of('d'); // 逐出最久未用的 b（FIFO 旧行为逐出的是活跃的 a——线程上下文无声清零）
    expect(reg.count()).toBe(3);
    expect(reg.of('a')).toBe(a); // a 上下文延续（未被逐出重建）
    expect(reg.of('c')).toBeTruthy();
  });
});

describe('chatHub conv 标签', () => {
  it('帧带 conv；replay(conv) 只回该线程；无参 replay 全量（兼容面）', () => {
    const hub = createChatHub(10);
    hub.emit('assistant', 'a1', 'device-a');
    hub.emit('assistant', 'm1');
    hub.emit('assistant', 'a2', 'device-a');
    hub.emit('assistant', 'b1', 'device-b');
    expect(hub.replay('device-a').map((e) => e.data)).toEqual(['a1', 'a2']);
    expect(hub.replay('device-b').map((e) => e.data)).toEqual(['b1']);
    expect(hub.replay('main').map((e) => e.data)).toEqual(['m1']);
    expect(hub.replay().length).toBe(4);
  });
  it('订阅侧按 conv 过滤=WS 消费纪律（模拟 attachChatWireWs 的过滤逻辑）', () => {
    const hub = createChatHub(10);
    const gotA: string[] = [];
    const gotMain: string[] = [];
    hub.subscribe((e) => { if (e.conv === 'device-a') gotA.push(e.data); });
    hub.subscribe((e) => { if (e.conv === 'main') gotMain.push(e.data); });
    hub.emit('assistant', '给A', 'device-a');
    hub.emit('assistant', '给旧客户端');
    expect(gotA).toEqual(['给A']);
    expect(gotMain).toEqual(['给旧客户端']);
  });
  it('capacity=全 conv 共享全局预算，不分线程配额（口径钉住，R1-F5）', () => {
    // 口径（chathub 头注）：一条活跃线程可把安静线程的回放历史挤出 ring。
    // 若未来改成 per-conv 配额，本测试红——须同步头注并过人眼。
    const hub = createChatHub(3);
    hub.emit('assistant', 'a1', 'device-a');
    hub.emit('assistant', 'b1', 'device-b');
    hub.emit('assistant', 'b2', 'device-b');
    hub.emit('assistant', 'b3', 'device-b'); // b 线程第 3 帧把 a1 挤出全局预算
    expect(hub.count()).toBe(3);
    expect(hub.replay('device-b').map((e) => e.data)).toEqual(['b1', 'b2', 'b3']);
    expect(hub.replay('device-a')).toEqual([]); // a1 被全局预算挤出（非配额保底）
  });
  it('capacity=1/0 边界：环形历史裁到容量，不无界增长（R1-FX 封边界）', () => {
    // 旧式 slice(-(capacity-1)) 在 capacity=1 时是 slice(-0)=slice(0)=全量保留，
    // ring 永不裁剪（内存慢性泄漏）——改正向下标裁剪后本测试钉住回归。
    const hub1 = createChatHub(1);
    for (let i = 0; i < 5; i++) hub1.emit('assistant', `e${i}`);
    expect(hub1.count()).toBe(1); // 洞在则这里是 5
    expect(hub1.replay('main').map((e) => e.data)).toEqual(['e4']); // 留最新一条
    const hub0 = createChatHub(0);
    hub0.emit('assistant', 'x');
    hub0.emit('assistant', 'y');
    expect(hub0.count()).toBe(1); // capacity=0 既有语义：稳定 1 条
  });
});
