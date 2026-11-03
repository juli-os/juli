// juli-voice 协议机（零 DOM，2026-10-20）：OpenAI Realtime 兼容事件流 → 客户端
// 契约的判定层。WebSocket/音频 I/O/计时器全部经 deps 注入，本模块只产出
// 「效应」（ClientEffect）——vitest 直接可测，视图（views/voice.ts）只做执行。
//
// 契约依据：juli-voice/INTEGRATION-frontend.md + VALIDATION.md（§2.2 噪声致
// VAD 挂起/空转写不发 response.done → 30s 看门狗 response.cancel；§4.2 半双工
// 防回声；§8.13 废弃会话继续生成 → 断开前先 cancel）。
//
// 实测修正（2026-10-20 直灌 assets/wav 取得的真实序列）：
//   · 一句话内 VAD 可分多段（speech_started/stopped 多次），转写 .completed 只
//     在末尾出一次 → e2e 锚点取「最后一次 speech_stopped」；
//   · 回答文本事件实名 response.output_audio_transcript.delta（任务书写的
//     response.audio_transcript.delta 是旧名，这正是「可能不触发」的真因）——
//     两名都收，response.done.output[].content[].transcript 仍作兜底；
//   · 无在途响应时发 response.cancel 服务端静默接受（看门狗路径零噪音）。

export const VOICE_WS_DEFAULT = 'ws://127.0.0.1:8790/ws';
/** 停播后尾音抑制窗：覆盖输出设备缓冲 + 室内混响尾音，窗内丢弃上行帧。 */
export const GUARD_MS = 350;
/** 空闲自动断开：每条连接占服务端一个模型管线槽（并发=2，满了拒连）。 */
export const IDLE_CLOSE_MS = 45_000;
/** 一轮语音后无 response.done 的放弃阈值（噪声挂起/空转写）。 */
export const ROUND_WATCHDOG_MS = 30_000;
export const SAMPLE_RATE = 16_000;
/** 100ms @16kHz = 1600 样本 = 3200 字节（协议建议帧长）。 */
export const FRAME_SAMPLES = 1600;
export const DEFAULT_INSTRUCTIONS = '你是 juli 的语音助手，用用户的语言简短回答。';

/** 握手第二步：收到 session.created 即发（重连后必须重走）。 */
export const buildSessionUpdate = (instructions: string): Record<string, unknown> => ({
  type: 'session.update',
  session: {
    type: 'realtime',
    instructions,
    modalities: ['text', 'audio'],
    input_audio_format: 'pcm16',
    output_audio_format: 'pcm16',
    turn_detection: { type: 'server_vad', interrupt_response: true },
  },
});

/** 断线重连退避：0.5s 起倍增，封顶 10s（服务重启冷启 10–18s，音色切换 8–15s
 * ——封顶值保证重启窗口内持续探连，而不是指数爆到分钟级）。 */
export const reconnectDelayMs = (attempt: number): number =>
  Math.min(10_000, 500 * 2 ** Math.max(0, Math.min(attempt, 10)));

/** ws(s)://host/ws[?…] → http(s)://host（状态/音色 API 同宿主）。 */
export const voiceHttpBase = (wsUrl: string): string => {
  const m = /^(wss?):\/\/([^/?#]+)/i.exec(wsUrl.trim());
  if (m === null) return '';
  return `${m[1]!.toLowerCase() === 'wss' ? 'https' : 'http'}://${m[2]}`;
};

/** WS 地址附 token（局域网模式网关强制 ?token=；本机回环可空）。 */
export const voiceWsUrl = (base: string, token: string): string => {
  const u = base.trim() === '' ? VOICE_WS_DEFAULT : base.trim();
  if (token === '') return u;
  return `${u}${u.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
};

// ---- 音频纯函数 -------------------------------------------------------------------

/** Float32 [-1,1] → Int16（截断钳位；与参考实现同算法）。 */
export const float32ToPcm16 = (f32: Float32Array): Int16Array => {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = f32[i]! * 32768;
    out[i] = v >= 32767 ? 32767 : v <= -32768 ? -32768 : (v | 0);
  }
  return out;
};

/** 帧聚合器：AudioWorklet 每次只给 128 样本（8ms），攒满 frameSamples 再出帧
 * ——上行 10 msg/s 而非 125 msg/s。flush() 收尾吐出残帧（丢掉会切掉尾音）。 */
export const createFrameAccumulator = (frameSamples = FRAME_SAMPLES): {
  push(chunk: Int16Array): Int16Array[];
  flush(): Int16Array | null;
  reset(): void;
} => {
  let buf = new Int16Array(frameSamples);
  let fill = 0;
  return {
    push(chunk) {
      const out: Int16Array[] = [];
      let i = 0;
      while (i < chunk.length) {
        const n = Math.min(frameSamples - fill, chunk.length - i);
        buf.set(chunk.subarray(i, i + n), fill);
        fill += n;
        i += n;
        if (fill === frameSamples) {
          out.push(buf);
          buf = new Int16Array(frameSamples);
          fill = 0;
        }
      }
      return out;
    },
    flush() {
      if (fill === 0) return null;
      const tail = buf.slice(0, fill);
      buf = new Int16Array(frameSamples);
      fill = 0;
      return tail;
    },
    reset() {
      buf = new Int16Array(frameSamples);
      fill = 0;
    },
  };
};

export interface WavPcm16 {
  readonly sampleRate: number;
  readonly channels: number;
  /** 单声道样本（多声道只取首声道——服务端重采样任意采样率，不伪造 16k）。 */
  readonly samples: Int16Array;
}

/** 最小 RIFF/WAVE 解析（只认 PCM16）：回放测试通道用，非法/非 PCM16 返回 null。 */
export const wavToPcm16 = (bytes: Uint8Array): WavPcm16 | null => {
  if (bytes.length < 12) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number): string => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (fmt === null || fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1) return null;
      const end = Math.min(bytes.length, body + size);
      const frames = Math.floor((end - body) / (2 * fmt.channels));
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) samples[i] = dv.getInt16(body + i * 2 * fmt.channels, true);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
    }
    off = body + size + (size & 1);
  }
  return null;
};

// ---- 协议机 -----------------------------------------------------------------------

/** 服务端事件（宽松形态：只认 type，其余按需读）。 */
export interface ServerEvent {
  readonly type: string;
  readonly [k: string]: unknown;
}

export interface TurnMetrics {
  /** 最后一次 speech_stopped → 首块回答音频（任务书定义的端到端）。 */
  readonly e2eMs: number | null;
  /** 最后一次 speech_stopped → 转写终稿（STT 收尾）。 */
  readonly sttMs: number | null;
  /** 转写终稿 → 首块音频（LLM 首句 + TTS 首包）；终稿晚于首音频时为 null。 */
  readonly genMs: number | null;
}

/** 协议机产出的效应：视图逐条执行，测试逐条断言。 */
export type ClientEffect =
  | { readonly kind: 'send'; readonly msg: Record<string, unknown> }
  | { readonly kind: 'ready' }
  | { readonly kind: 'vad'; readonly on: boolean }
  | { readonly kind: 'user_text'; readonly text: string; readonly final: boolean }
  | { readonly kind: 'ai_text'; readonly text: string; readonly final: boolean }
  | { readonly kind: 'audio'; readonly b64: string }
  /** 打断/清队：立即停本地播放。不加抑制窗——用户正在说，别切掉话音起振（§4.2⑤）。 */
  | { readonly kind: 'stop_playback' }
  | { readonly kind: 'barge'; readonly count: number }
  | { readonly kind: 'responding'; readonly on: boolean }
  | { readonly kind: 'metrics'; readonly m: TurnMetrics }
  /** 看门狗放弃本轮（已发 response.cancel），UI 回 idle。 */
  | { readonly kind: 'abandoned'; readonly reason: string }
  | { readonly kind: 'response_status'; readonly status: string }
  | { readonly kind: 'error'; readonly message: string };

export interface VoiceMachineDeps {
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly emit: (e: ClientEffect) => void;
  readonly instructions?: string;
  readonly watchdogMs?: number;
  /**
   * stt：只要转写不要回答（2026-10-21 发单语音输入形态）。实测服务端契约：
   * turn_detection:"none" 是摆设（VAD 照跑、转写在判停后 ~80ms 自己来，commit
   * 可省）；modalities:["text"] 也无效。唯一干净路径 = response.created 瞬间发
   * response.cancel（实测 0 音频块泄漏，回答完全不起播）。此模式下回答面效应
   * （audio/ai_text/responding/barge/metrics/response_status）全抑制。
   */
  readonly mode?: 'conversation' | 'stt';
}

export interface VoiceMachineState {
  readonly ready: boolean;
  readonly responding: boolean;
  readonly vad: boolean;
  /** 上行进行中（PTT 按住 / 回放流送中）。 */
  readonly uplinking: boolean;
  /** 本轮已见 speech_started 且未收 response.done。 */
  readonly roundOpen: boolean;
  readonly bargeCount: number;
  /** 已收口的 response.done 轮数（看门狗放弃不计——浸泡/e2e 的口径）。 */
  readonly doneCount: number;
  readonly watchdogArmed: boolean;
}

export interface VoiceMachine {
  handle(ev: ServerEvent): void;
  /** PTT 按下 / 回放开始。 */
  uplinkStarted(): void;
  /** PTT 松开 / 回放结束：若本轮仍开着（VAD 挂起没发 speech_stopped）则武装看门狗。 */
  uplinkEnded(): void;
  /** 断线/重连/卸载：清计时器与轮次态（握手态归零，等下一个 session.created）。 */
  reset(): void;
  /** 空闲断开前的收尾：本轮未收口则先 cancel（§8.13 废弃会话会继续生成）。 */
  prepareClose(): void;
  canIdleClose(): boolean;
  state(): VoiceMachineState;
}

/** 从 response.done 兜底抽回答文本：response.output[].content[].transcript。 */
export const transcriptFromDone = (ev: ServerEvent): string => {
  const resp = ev['response'];
  if (resp === null || typeof resp !== 'object') return '';
  const output = (resp as { output?: unknown }).output;
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    const content = (item as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      const t = (c as { transcript?: unknown })?.transcript;
      if (typeof t === 'string' && t !== '') parts.push(t);
    }
  }
  return parts.join('');
};

export const createVoiceMachine = (deps: VoiceMachineDeps): VoiceMachine => {
  const instructions = deps.instructions ?? DEFAULT_INSTRUCTIONS;
  const watchdogMs = deps.watchdogMs ?? ROUND_WATCHDOG_MS;
  const stt = deps.mode === 'stt';
  let ready = false;
  let responding = false;
  let vad = false;
  let uplinking = false;
  let roundOpen = false;
  let bargeCount = 0;
  let doneCount = 0;
  let aiTextSeen = false;
  let hasFinal = false; // 本轮已交付非空转写终稿（看门狗放弃的「没听清」只许在真没稿时喊）
  let tSpeechStop: number | null = null;
  let tFirstAudio: number | null = null;
  let tSttDone: number | null = null;
  let watchdog: unknown = null;

  const metrics = (): TurnMetrics => {
    const e2eMs = tSpeechStop !== null && tFirstAudio !== null ? tFirstAudio - tSpeechStop : null;
    const sttMs = tSpeechStop !== null && tSttDone !== null ? tSttDone - tSpeechStop : null;
    const genMs = tSttDone !== null && tFirstAudio !== null && tFirstAudio >= tSttDone ? tFirstAudio - tSttDone : null;
    return { e2eMs, sttMs, genMs };
  };

  const disarm = (): void => {
    if (watchdog !== null) {
      deps.clearTimer(watchdog);
      watchdog = null;
    }
  };

  const closeRound = (): void => {
    disarm();
    roundOpen = false;
    if (responding) {
      responding = false;
      deps.emit({ kind: 'responding', on: false });
    }
  };

  const arm = (): void => {
    if (watchdog !== null) return;
    watchdog = deps.setTimer(() => {
      watchdog = null;
      deps.emit({ kind: 'send', msg: { type: 'response.cancel' } });
      closeRound();
      tSpeechStop = null;
      tFirstAudio = null;
      tSttDone = null;
      // 稿已交付的轮次静默收口：stt 模式 response.cancel 后服务端可以不回
      // response.done，看门狗到点时稿早已进件——再喊「没听清」是误报，会覆盖
      // 用户刚看到的成稿 status。cancel/收口/清时间戳不受此门影响。
      if (!hasFinal) {
        deps.emit({ kind: 'abandoned', reason: `${Math.round(watchdogMs / 1000)}s 无响应（噪声致 VAD 挂起或空转写），已取消本轮` });
      }
    }, watchdogMs);
  };

  const handle = (ev: ServerEvent): void => {
    const t = deps.now();
    switch (ev.type) {
      case 'session.created':
        ready = false;
        deps.emit({ kind: 'send', msg: buildSessionUpdate(instructions) });
        break;
      case 'session.updated':
        ready = true;
        deps.emit({ kind: 'ready' });
        break;
      case 'input_audio_buffer.speech_started':
        vad = true;
        roundOpen = true;
        hasFinal = false; // 新轮开始：上一轮的终稿不再给本轮的看门狗护体
        disarm(); // 用户在说：轮次活着，不计时
        deps.emit({ kind: 'vad', on: true });
        if (!stt) {
          // 无条件停播（验收②：正在播回答 → 立即停）：音频在 response.done 前已
          // 全部送达，本地还在播时 responding 已 false——耦合它会让「播完存货时
          // 抢话」漏停。空队列/未在播时是无害 no-op。
          deps.emit({ kind: 'stop_playback' });
          if (responding) {
            bargeCount++;
            deps.emit({ kind: 'barge', count: bargeCount });
          }
        }
        break;
      case 'input_audio_buffer.speech_stopped':
        vad = false;
        tSpeechStop = t;
        tFirstAudio = null;
        tSttDone = null;
        deps.emit({ kind: 'vad', on: false });
        disarm();
        arm(); // 服务端已判停，自此 30s 内必须有 response.done（多段判停以最后一次为准）
        break;
      case 'conversation.item.input_audio_transcription.delta': {
        const d = ev['delta'];
        if (typeof d === 'string' && d !== '') deps.emit({ kind: 'user_text', text: d, final: false });
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        tSttDone = t;
        const tr = ev['transcript'];
        if (typeof tr === 'string' && tr !== '') hasFinal = true;
        deps.emit({ kind: 'user_text', text: typeof tr === 'string' ? tr : '', final: true });
        if (!stt) deps.emit({ kind: 'metrics', m: metrics() });
        break;
      }
      case 'response.created':
        if (stt) {
          // 只要转写：回答一露头就掐掉（实测 0 音频块泄漏；不 cancel 服务端会白跑
          // 一整轮 LLM+TTS——modalities/turn_detection 都拦不住它）。
          deps.emit({ kind: 'send', msg: { type: 'response.cancel' } });
          break;
        }
        responding = true;
        aiTextSeen = false;
        deps.emit({ kind: 'responding', on: true });
        break;
      case 'response.output_audio.delta': {
        if (stt) break; // cancel 后不会来；万一来了丢弃
        if (tFirstAudio === null) {
          tFirstAudio = t;
          deps.emit({ kind: 'metrics', m: metrics() });
        }
        const d = ev['delta'];
        if (typeof d === 'string' && d !== '') deps.emit({ kind: 'audio', b64: d });
        break;
      }
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta': {
        if (stt) break;
        const d = ev['delta'];
        if (typeof d === 'string' && d !== '') {
          aiTextSeen = true;
          deps.emit({ kind: 'ai_text', text: d, final: false });
        }
        break;
      }
      case 'response.done': {
        doneCount++;
        if (!stt) {
          const resp = ev['response'];
          const status = resp !== null && typeof resp === 'object' ? (resp as { status?: unknown }).status : undefined;
          if (!aiTextSeen) {
            const fallback = transcriptFromDone(ev);
            if (fallback !== '') deps.emit({ kind: 'ai_text', text: fallback, final: true });
          } else {
            deps.emit({ kind: 'ai_text', text: '', final: true });
          }
          if (typeof status === 'string' && status !== 'completed') deps.emit({ kind: 'response_status', status });
          deps.emit({ kind: 'metrics', m: metrics() });
        }
        closeRound();
        break;
      }
      case 'output_audio_buffer.cleared':
        if (!stt) deps.emit({ kind: 'stop_playback' });
        break;
      case 'error': {
        const err = ev['error'];
        const msg = err !== null && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string'
          ? (err as { message: string }).message
          : JSON.stringify(err ?? ev);
        deps.emit({ kind: 'error', message: msg });
        break;
      }
      default:
        break; // response.output_item.*/content_part.*/output_audio.done 等过程帧不消费
    }
  };

  return {
    handle,
    uplinkStarted() {
      uplinking = true;
    },
    uplinkEnded() {
      uplinking = false;
      if (roundOpen && watchdog === null) arm();
    },
    reset() {
      disarm();
      ready = false;
      responding = false;
      vad = false;
      uplinking = false;
      roundOpen = false;
      aiTextSeen = false;
      hasFinal = false;
      tSpeechStop = null;
      tFirstAudio = null;
      tSttDone = null;
    },
    prepareClose() {
      if (roundOpen || responding) deps.emit({ kind: 'send', msg: { type: 'response.cancel' } });
      closeRound();
    },
    canIdleClose() {
      return !uplinking && !responding && !roundOpen;
    },
    state() {
      return { ready, responding, vad, uplinking, roundOpen, bargeCount, doneCount, watchdogArmed: watchdog !== null };
    },
  };
};
