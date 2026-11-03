// juli-voice 协议机围栏（#/voice，2026-10-20）：契约条目的机械面——打断/看门狗/
// 指标/退避/握手负载/音频纯函数。依据=juli-voice INTEGRATION-frontend.md「必须
// 遵守的客户端契约」+ VALIDATION.md（§2.2 噪声挂起、§8.13 废弃会话）。假钟注入，
// 零 DOM（voice-protocol.ts 同款纪律：被 node 测试引用的 web 模块不碰 DOM）。

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSTRUCTIONS, GUARD_MS, ROUND_WATCHDOG_MS,
  createFrameAccumulator, createVoiceMachine, float32ToPcm16,
  reconnectDelayMs, transcriptFromDone, voiceHttpBase, voiceWsUrl, wavToPcm16,
} from '../web/src/voice-protocol.ts';
import type { ClientEffect, ServerEvent } from '../web/src/voice-protocol.ts';

/** 假钟 harness：时间推进/到点触发全手动，看门狗行为可确定性断言。 */
const setup = (watchdogMs = ROUND_WATCHDOG_MS): {
  machine: ReturnType<typeof createVoiceMachine>;
  effects: ClientEffect[];
  adv: (ms: number) => void;
  fire: () => void;
  timers: unknown[];
} => {
  const effects: ClientEffect[] = [];
  let now = 1_000;
  const timers: { fn: () => void; at: number; handle: object }[] = [];
  const machine = createVoiceMachine({
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms, handle: {} }; timers.push(t); return t.handle; },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.handle === h);
      if (i >= 0) timers.splice(i, 1);
    },
    emit: (e) => { effects.push(e); },
    watchdogMs,
  });
  return {
    machine,
    effects,
    adv: (ms) => { now += ms; },
    fire: () => { for (const t of [...timers]) if (t.at <= now) t.fn(); },
    timers,
  };
};

const kinds = (fx: readonly ClientEffect[]): string[] => fx.map((e) => e.kind);
const ev = (type: string, extra: Record<string, unknown> = {}): ServerEvent => ({ type, ...extra });
const sent = (fx: readonly ClientEffect[]): Record<string, unknown>[] =>
  fx.filter((e): e is Extract<ClientEffect, { kind: 'send' }> => e.kind === 'send').map((e) => e.msg);

describe('握手：session.created → session.update（重连后必须重走）', () => {
  it('负载形状：realtime/pcm16 双向/server_vad+interrupt_response/系统提示词', () => {
    const { machine, effects } = setup();
    machine.handle(ev('session.created'));
    const msgs = sent(effects);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: DEFAULT_INSTRUCTIONS,
        modalities: ['text', 'audio'],
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: { type: 'server_vad', interrupt_response: true },
      },
    });
    expect(machine.state().ready).toBe(false);
    machine.handle(ev('session.updated'));
    expect(machine.state().ready).toBe(true);
    expect(kinds(effects)).toContain('ready');
  });

  it('reset 后 ready 归零：断线重连收到新 session.created 会重发 session.update', () => {
    const { machine, effects } = setup();
    machine.handle(ev('session.created'));
    machine.handle(ev('session.updated'));
    expect(sent(effects)).toHaveLength(1); // 首次握手一条
    machine.reset();
    expect(machine.state().ready).toBe(false);
    machine.handle(ev('session.created')); // 重连
    expect(sent(effects)).toHaveLength(2); // 握手重走
    machine.handle(ev('session.updated'));
    expect(machine.state().ready).toBe(true);
  });
});

describe('正常一轮：转写/指标/回答文本/音频/收口', () => {
  it('e2e=最后 speech_stopped→首块音频；stt=判停→转写终稿；gen=终稿→首音频', () => {
    const { machine, effects, adv } = setup();
    machine.handle(ev('session.created'));
    machine.handle(ev('session.updated'));
    machine.handle(ev('input_audio_buffer.speech_started'));
    adv(2_700);
    machine.handle(ev('input_audio_buffer.speech_stopped')); // 多段判停取最后一次
    adv(130);
    machine.handle(ev('conversation.item.input_audio_transcription.completed', { transcript: '帮我看看明天的天气' }));
    adv(50);
    machine.handle(ev('response.created'));
    adv(820);
    machine.handle(ev('response.output_audio.delta', { delta: 'QUJD' }));
    machine.handle(ev('response.output_audio_transcript.delta', { delta: '明天晴。' }));
    machine.handle(ev('response.done', { response: { status: 'completed', output: [] } }));
    const ms = effects.filter((e): e is Extract<ClientEffect, { kind: 'metrics' }> => e.kind === 'metrics').map((e) => e.m);
    expect(ms.at(-1)).toEqual({ e2eMs: 1_000, sttMs: 130, genMs: 870 });
    expect(machine.state().doneCount).toBe(1);
    expect(machine.state().responding).toBe(false);
    // 音频块与回答文本原样透传给视图播放/上屏
    const audio = effects.find((e): e is Extract<ClientEffect, { kind: 'audio' }> => e.kind === 'audio');
    expect(audio?.b64).toBe('QUJD');
    expect(effects.some((e) => e.kind === 'ai_text' && e.text === '明天晴。')).toBe(true);
  });

  it('回答文本兜底：一个 delta 都没来时从 response.done.output[].content[].transcript 抽', () => {
    const { machine, effects } = setup();
    machine.handle(ev('response.created'));
    machine.handle(ev('response.done', {
      response: { status: 'completed', output: [{ content: [{ transcript: 'Canberra is the capital.' }] }] },
    }));
    const ai = effects.filter((e): e is Extract<ClientEffect, { kind: 'ai_text' }> => e.kind === 'ai_text');
    expect(ai.some((e) => e.final && e.text === 'Canberra is the capital.')).toBe(true);
  });

  it('两种回答文本事件名都收：现行 output_audio_transcript + 任务书旧名 audio_transcript', () => {
    const { machine: m1, effects: f1 } = setup();
    m1.handle(ev('response.audio_transcript.delta', { delta: 'a' }));
    m1.handle(ev('response.output_audio_transcript.delta', { delta: 'b' }));
    const texts = f1.filter((e): e is Extract<ClientEffect, { kind: 'ai_text' }> => e.kind === 'ai_text').map((e) => e.text);
    expect(texts).toEqual(['a', 'b']);
  });

  it('非 completed 终态上报（failed/cancelled 不静默）', () => {
    const { machine, effects } = setup();
    machine.handle(ev('response.done', { response: { status: 'failed' } }));
    expect(effects.some((e) => e.kind === 'response_status' && e.status === 'failed')).toBe(true);
  });

  it('空转写（VAD 关轮但 Parakeet 出空串）：final 空文本事件照发不炸，由看门狗收口', () => {
    const { machine, effects } = setup();
    machine.handle(ev('input_audio_buffer.speech_started'));
    machine.handle(ev('input_audio_buffer.speech_stopped'));
    machine.handle(ev('conversation.item.input_audio_transcription.completed', { transcript: '' }));
    expect(effects.some((e) => e.kind === 'user_text' && e.final && e.text === '')).toBe(true);
    expect(machine.state().roundOpen).toBe(true);
  });

  it('error 事件取 error.message 上报', () => {
    const { machine, effects } = setup();
    machine.handle(ev('error', { error: { message: 'pool full' } }));
    expect(effects.some((e) => e.kind === 'error' && e.message === 'pool full')).toBe(true);
  });
});

describe('打断（barge-in）：speech_started → 立即停播（无条件）；打断计数只认真打断', () => {
  it('停播无条件（本地可能还在播已完成响应的存货）；barge 只在响应在途时计数', () => {
    const { machine, effects } = setup();
    machine.handle(ev('input_audio_buffer.speech_started'));
    expect(machine.state().vad).toBe(true);
    expect(effects.filter((e) => e.kind === 'stop_playback')).toHaveLength(1);
    expect(kinds(effects)).not.toContain('barge');
    machine.handle(ev('input_audio_buffer.speech_stopped'));
    machine.handle(ev('response.created'));
    machine.handle(ev('input_audio_buffer.speech_started')); // 抢话（生成在途）
    expect(machine.state().bargeCount).toBe(1);
    expect(effects.filter((e) => e.kind === 'stop_playback')).toHaveLength(2);
    expect(kinds(effects)).toContain('barge');
    machine.handle(ev('input_audio_buffer.speech_stopped'));
    machine.handle(ev('response.created'));
    machine.handle(ev('input_audio_buffer.speech_started'));
    expect(machine.state().bargeCount).toBe(2);
    expect(effects.filter((e) => e.kind === 'stop_playback')).toHaveLength(3);
  });

  it('output_audio_buffer.cleared 到达时再次清空播放', () => {
    const { machine, effects } = setup();
    machine.handle(ev('output_audio_buffer.cleared'));
    expect(effects.filter((e) => e.kind === 'stop_playback')).toHaveLength(1);
  });
});

describe('30s 看门狗：失败路径不死等', () => {
  it('判停后 30s 无 response.done → 发 response.cancel + abandoned + 回 idle', () => {
    const { machine, effects, adv, fire } = setup();
    machine.handle(ev('input_audio_buffer.speech_started'));
    machine.handle(ev('input_audio_buffer.speech_stopped'));
    adv(29_999);
    fire();
    expect(kinds(effects)).not.toContain('abandoned');
    adv(1);
    fire();
    expect(sent(effects).some((m) => (m as { type?: string }).type === 'response.cancel')).toBe(true);
    expect(effects.some((e) => e.kind === 'abandoned')).toBe(true);
    expect(machine.state().responding).toBe(false);
    expect(machine.state().doneCount).toBe(0);
    expect(machine.canIdleClose()).toBe(true);
  });

  it('response.done 解除看门狗：之后到点不再触发', () => {
    const { machine, effects, adv, fire, timers } = setup();
    machine.handle(ev('input_audio_buffer.speech_started'));
    machine.handle(ev('input_audio_buffer.speech_stopped'));
    machine.handle(ev('response.created'));
    machine.handle(ev('response.done', { response: { status: 'completed', output: [] } }));
    expect(timers).toHaveLength(0);
    adv(60_000);
    fire();
    expect(kinds(effects)).not.toContain('abandoned');
  });

  it('VAD 挂起（speech_stopped 永不来）：松开上行时武装，30s 后取消——babble 契约', () => {
    const { machine, effects, adv, fire, timers } = setup();
    machine.uplinkStarted();
    machine.handle(ev('input_audio_buffer.speech_started'));
    expect(timers).toHaveLength(0); // 说话中不计时
    machine.uplinkEnded(); // 松开（VAD 没判停）
    expect(timers).toHaveLength(1);
    adv(30_000);
    fire();
    expect(effects.some((e) => e.kind === 'abandoned')).toBe(true);
  });

  it('多段判停：每次 speech_stopped 重置计时（长句不被首段计时误杀）', () => {
    const { machine, timers } = setup();
    machine.handle(ev('input_audio_buffer.speech_started'));
    machine.handle(ev('input_audio_buffer.speech_stopped'));
    expect(timers).toHaveLength(1);
    machine.handle(ev('input_audio_buffer.speech_started')); // 用户接着说 → 拆表
    expect(timers).toHaveLength(0);
    machine.handle(ev('input_audio_buffer.speech_stopped'));
    expect(timers).toHaveLength(1);
  });

  it('没说过话的空按（无 speech_started）不武装——无事可取消', () => {
    const { machine, timers } = setup();
    machine.uplinkStarted();
    machine.uplinkEnded();
    expect(timers).toHaveLength(0);
  });
});

describe('空闲断开与卸载收口', () => {
  it('canIdleClose：上行/响应中/轮开时都为假', () => {
    const { machine } = setup();
    expect(machine.canIdleClose()).toBe(true);
    machine.uplinkStarted();
    expect(machine.canIdleClose()).toBe(false);
    machine.uplinkEnded();
    machine.handle(ev('input_audio_buffer.speech_started'));
    expect(machine.canIdleClose()).toBe(false);
    machine.handle(ev('input_audio_buffer.speech_stopped'));
    expect(machine.canIdleClose()).toBe(false);
    machine.handle(ev('response.done', { response: { status: 'completed', output: [] } }));
    expect(machine.canIdleClose()).toBe(true);
  });

  it('prepareClose：轮未收口先补 cancel（废弃会话不再吃算力），收口后安静', () => {
    const { machine, effects } = setup();
    machine.handle(ev('input_audio_buffer.speech_started'));
    machine.handle(ev('input_audio_buffer.speech_stopped'));
    machine.prepareClose();
    expect(sent(effects).some((m) => (m as { type?: string }).type === 'response.cancel')).toBe(true);
    machine.prepareClose();
    expect(sent(effects).filter((m) => (m as { type?: string }).type === 'response.cancel')).toHaveLength(1);
  });

  it('reset 清看门狗（断线时不留幽灵计时器）', () => {
    const { machine, timers } = setup();
    machine.handle(ev('input_audio_buffer.speech_started'));
    machine.handle(ev('input_audio_buffer.speech_stopped'));
    expect(timers).toHaveLength(1);
    machine.reset();
    expect(timers).toHaveLength(0);
    expect(machine.state().roundOpen).toBe(false);
  });
});

describe('重连退避与地址派生', () => {
  it('0.5s 起倍增、封顶 10s（服务重启冷启 10–18s 窗口内持续探连）', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(reconnectDelayMs)).toEqual([500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]);
  });

  it('ws→http / wss→https；非法输入空串', () => {
    expect(voiceHttpBase('ws://127.0.0.1:8790/ws')).toBe('http://127.0.0.1:8790');
    expect(voiceHttpBase('wss://mac.lan:8790/ws?x=1')).toBe('https://mac.lan:8790');
    expect(voiceHttpBase('not a url')).toBe('');
  });

  it('token 走 query（LAN 模式网关强制）；已有 query 用 & 接', () => {
    expect(voiceWsUrl('ws://h:1/ws', 't k')).toBe('ws://h:1/ws?token=t%20k');
    expect(voiceWsUrl('ws://h:1/ws?a=1', 't')).toBe('ws://h:1/ws?a=1&token=t');
    expect(voiceWsUrl('ws://h:1/ws', '')).toBe('ws://h:1/ws');
  });
});

describe('音频纯函数', () => {
  it('float32→pcm16 钳位到 ±32767/-32768', () => {
    const out = float32ToPcm16(new Float32Array([0, 0.5, 1, -1, 2, -2]));
    expect([...out]).toEqual([0, 16384, 32767, -32768, 32767, -32768]);
  });

  it('帧聚合器：8ms×200 攒成 16 个 1600 样本整帧，flush 吐残帧不切尾音', () => {
    const acc = createFrameAccumulator();
    const frames: number[] = [];
    for (let i = 0; i < 200; i++) for (const f of acc.push(new Int16Array(128).fill(i & 0x7f))) frames.push(f.length);
    expect(frames).toEqual(new Array<number>(16).fill(1600)); // 200×128=25600=16×1600 整
    expect(acc.flush()).toBeNull();
    const tail = acc.push(new Int16Array(300));
    expect(tail).toHaveLength(0);
    expect(acc.flush()?.length).toBe(300);
    acc.reset();
    expect(acc.flush()).toBeNull();
  });

  it('wav 解析：PCM16 头/data 块/采样率；非 PCM16 与坏头拒绝', () => {
    const wav = makeWav([1, -2, 3], 16_000);
    const parsed = wavToPcm16(wav);
    expect(parsed).not.toBeNull();
    expect(parsed?.sampleRate).toBe(16_000);
    expect([...(parsed?.samples ?? [])]).toEqual([1, -2, 3]);
    expect(wavToPcm16(new Uint8Array(4))).toBeNull();
    expect(wavToPcm16(makeWav([1], 8_000, { format: 3 }))).toBeNull(); // IEEE float 拒绝
  });

  it('transcriptFromDone：拼接多 item 的 transcript', () => {
    expect(transcriptFromDone(ev('response.done', { response: { output: [{ content: [{ transcript: 'a' }, { transcript: '' }] }, { content: [{ transcript: 'b' }] }] } }))).toBe('ab');
    expect(transcriptFromDone(ev('response.done', { response: {} }))).toBe('');
  });
});

// ---- 测试夹具 -----------------------------------------------------------------------

const makeWav = (samples: number[], rate: number, opt: { format?: number } = {}): Uint8Array => {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const dv = new DataView(buf);
  const w = (o: number, s: string): void => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF');
  dv.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, opt.format ?? 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, 'data');
  dv.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => dv.setInt16(44 + i * 2, s, true));
  return new Uint8Array(buf);
};

// 常量锚定：契约数值改了要有意识地改这里（对应 INTEGRATION-frontend.md 契约 2/4/5）。
describe('契约常量锚定', () => {
  it('尾音抑制 350ms / 看门狗 30s', () => {
    expect(GUARD_MS).toBe(350);
    expect(ROUND_WATCHDOG_MS).toBe(30_000);
  });
});

// ---- stt 模式（2026-10-21 发单语音输入）：只要转写不要回答 ------------------------

const setupStt = () => {
  const effects: ClientEffect[] = [];
  let now = 1_000;
  const timers: { fn: () => void; at: number; handle: object }[] = [];
  const machine = createVoiceMachine({
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms, handle: {} }; timers.push(t); return t.handle; },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.handle === h);
      if (i >= 0) timers.splice(i, 1);
    },
    emit: (e) => { effects.push(e); },
    mode: 'stt',
  });
  return {
    machine, effects, timers,
    adv: (ms: number) => { now += ms; },
    fire: () => { for (const t of [...timers]) if (t.at <= now) t.fn(); },
  };
};

describe('stt 模式：response.created 即 cancel，回答面效应全抑制', () => {
  it('转写照常透传（final 与 delta）', () => {
    const { machine, effects } = setupStt();
    machine.handle(ev('conversation.item.input_audio_transcription.delta', { delta: '帮我' }));
    machine.handle(ev('conversation.item.input_audio_transcription.completed', { transcript: '帮我看看天气' }));
    const texts = effects.filter((e): e is Extract<ClientEffect, { kind: 'user_text' }> => e.kind === 'user_text');
    expect(texts.map((e) => [e.text, e.final])).toEqual([['帮我', false], ['帮我看看天气', true]]);
  });

  it('response.created → 发 response.cancel，不进 responding；后续回答帧全丢弃', () => {
    const { machine, effects } = setupStt();
    machine.handle(ev('input_audio_buffer.speech_started'));
    machine.handle(ev('input_audio_buffer.speech_stopped'));
    machine.handle(ev('response.created'));
    expect(sent(effects).some((m) => (m as { type?: string }).type === 'response.cancel')).toBe(true);
    expect(kinds(effects)).not.toContain('responding');
    machine.handle(ev('response.output_audio_transcript.delta', { delta: '回答' }));
    machine.handle(ev('response.output_audio.delta', { delta: 'QUJD' }));
    machine.handle(ev('response.done', { response: { status: 'cancelled', output: [] } }));
    const ks = kinds(effects);
    for (const k of ['audio', 'ai_text', 'metrics', 'response_status', 'stop_playback', 'barge']) {
      expect(ks, `stt 模式不应产 ${k}`).not.toContain(k);
    }
    expect(machine.state().doneCount).toBe(1); // 轮次照常收口（cancelled 的 done 也算）
    expect(machine.state().roundOpen).toBe(false);
  });

  it('VAD 事件照常（按钮灯），但 speech_started 不再产停播/打断（无播放面）', () => {
    const { machine, effects } = setupStt();
    machine.handle(ev('response.created')); // 即便伪 responding 也不可能出现（stt 不置位）
    machine.handle(ev('input_audio_buffer.speech_started'));
    expect(kinds(effects)).toContain('vad');
    expect(kinds(effects)).not.toContain('stop_playback');
    expect(machine.state().bargeCount).toBe(0);
  });

  it('空转写挂起：松手武装看门狗，30s cancel+abandoned（babble 契约同 conversation 模式）', () => {
    const { machine, effects, adv, fire } = setupStt();
    machine.uplinkStarted();
    machine.handle(ev('input_audio_buffer.speech_started'));
    machine.handle(ev('input_audio_buffer.speech_stopped'));
    machine.handle(ev('conversation.item.input_audio_transcription.completed', { transcript: '' }));
    machine.uplinkEnded();
    adv(30_000);
    fire();
    expect(effects.some((e) => e.kind === 'abandoned')).toBe(true);
    expect(sent(effects).some((m) => (m as { type?: string }).type === 'response.cancel')).toBe(true);
  });

  it('有终稿 + cancel 后 done 缺席：30s 静默收口不喊 abandoned（稿已进件，误报会覆盖 status）；新轮挂起照旧报', () => {
    const { machine, effects, adv, fire } = setupStt();
    machine.uplinkStarted();
    machine.handle(ev('input_audio_buffer.speech_started'));
    machine.handle(ev('input_audio_buffer.speech_stopped'));
    machine.handle(ev('conversation.item.input_audio_transcription.completed', { transcript: '开一单' }));
    machine.handle(ev('response.created')); // stt：瞬间 cancel，服务端可以不回 done
    machine.uplinkEnded();
    adv(30_000);
    fire();
    expect(kinds(effects)).not.toContain('abandoned');
    expect(sent(effects).some((m) => (m as { type?: string }).type === 'response.cancel')).toBe(true);
    // 新轮（如 babble 挂起）hasFinal 清零：真没稿的轮次仍要「没听清」
    effects.length = 0;
    machine.handle(ev('input_audio_buffer.speech_started'));
    machine.handle(ev('input_audio_buffer.speech_stopped'));
    adv(30_000);
    fire();
    expect(effects.some((e) => e.kind === 'abandoned')).toBe(true);
  });
});
