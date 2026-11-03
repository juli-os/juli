// 语音会话层（2026-10-21 通话开单）：麦克风采集 + juli-voice WS 生命周期 + stt
// 协议机 + 帧发送，一条会话一套——按住说话（voice-input）与通话模式（voice-call）
// 共用，宿主负责两者互斥（服务端并发=2 管线槽，双会话=占满拒连）。采集分层
// AEC（system→browser→裸）在会话首次启动时打开，随会话释放。协议判定在
// voice-protocol.ts（stt 模式：转写照常、回答一露头即 cancel）。

import {
  IDLE_CLOSE_MS, SAMPLE_RATE,
  createFrameAccumulator, createVoiceMachine, float32ToPcm16,
  reconnectDelayMs, voiceWsUrl,
} from './voice-protocol.ts';
import type { ClientEffect } from './voice-protocol.ts';

// 语音服务端点配置（R1 P2 裁定保留）：无 UI 写入口，仅 devtools 手动覆盖
// localStorage 的隐性逃生口（换机部署/服务上 token 时唯一通路）；不设即默认
// 本地回环 ws://127.0.0.1:8790/ws。不要误当有配置通路。
const WS_KEY = 'juli_voice_ws';
const TOKEN_KEY = 'juli_voice_token';

const pcm16ToB64 = (i16: Int16Array): string => {
  const u8 = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return btoa(s);
};

export interface VoiceSessionCallbacks {
  /** 转写终稿（一次判停一条；一次按住/通话轮可多条，宿主拼接）。 */
  onFinal(text: string): void;
  /** 瞬时提示（连接/断线/麦克风），空串=清空。 */
  onNote(text: string): void;
  /** VAD 状态（服务端判定你在说话）。 */
  onVad(on: boolean): void;
  /** 会话就绪（握手完成，可说话）。 */
  onReady(): void;
}

export interface VoiceSession {
  /** 事件路由切换（宿主在输入模式/通话模式间互斥接管；未路由=事件丢弃）。 */
  route(cb: VoiceSessionCallbacks | null): void;
  /** 打开麦克风 + 连接 WS（幂等；mic:false=不开麦（回放测试灌帧用）；返回 false=麦克风不可用）。 */
  start(opts?: { mic?: boolean }): Promise<boolean>;
  /** 主动收口：断开 WS（空闲断开的正门，slot 立即释放）。 */
  close(): void;
  /** 直发一帧（回放测试通道：绕过采集，走同一条上行协议路径；受上行门控）。 */
  send(i16: Int16Array): void;
  /** 上行门控（半双工）：false 期间麦克风波丢弃（朗读回包防回声）。 */
  setUplink(on: boolean): void;
  /** 刷上行尾帧（PTT 松开时收口用；通话模式不调）。 */
  flushTail(): void;
  /** 帧计数（探针口径）。 */
  counters(): { framesSent: number; chunksDropped: number; micReady: boolean };
  state(): { ws: boolean; ready: boolean; reconnects: number };
  dispose(): void;
}

export const createVoiceSession = (): VoiceSession => {
  const cfg = {
    ws: localStorage.getItem(WS_KEY) ?? '',
    token: localStorage.getItem(TOKEN_KEY) ?? '',
  };
  let sink: VoiceSessionCallbacks | null = null;
  let disposed = false;
  let ws: WebSocket | null = null;
  let wsOK = false;
  let connectWanted = false;
  let deliberateClose = false;
  let reconnectAttempt = 0;
  let reconnects = 0;
  let reconnectTimer = 0;
  let idleTimer = 0;

  let audioCtx: AudioContext | null = null;
  let mediaStream: MediaStream | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let micReady = false;
  let uplink = true;
  let framesSent = 0;
  let chunksDropped = 0;
  let lastUplinkAt = performance.now(); // 最近一次实发上行（sendFrame 早退后的刷新点，丢弃帧不算活动）
  const acc = createFrameAccumulator();

  const sendFrame = (i16: Int16Array): void => {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm16ToB64(i16) }));
    framesSent++;
    lastUplinkAt = performance.now();
  };

  const machine = createVoiceMachine({
    now: () => performance.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (h) => window.clearTimeout(h as number),
    emit: (e: ClientEffect) => {
      const cb = sink;
      if (cb === null) return;
      switch (e.kind) {
        case 'send': if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e.msg)); break;
        case 'ready':
          reconnectAttempt = 0;
          cb.onReady();
          break;
        case 'vad': cb.onVad(e.on); break;
        case 'user_text': if (e.final && e.text !== '') cb.onFinal(e.text); break;
        case 'abandoned': sink?.onNote('（这轮没听清——环境太吵或没说话，再试一次）'); break;
        case 'error': sink?.onNote(`语音服务错误：${e.message}`); break;
        default: break; // stt 模式无其余效应
      }
    },
    mode: 'stt',
  });

  const connect = (): void => {
    if (disposed) return;
    if (ws !== null && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const sock = new WebSocket(voiceWsUrl(cfg.ws, cfg.token));
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock || disposed) return;
      wsOK = true;
      machine.reset();
    };
    sock.onmessage = (m: MessageEvent<string>) => {
      if (ws !== sock || disposed) return;
      try {
        machine.handle(JSON.parse(m.data) as { type: string });
      } catch { /* 非 JSON 帧丢弃 */ }
    };
    sock.onclose = (ev: CloseEvent) => {
      if (ws !== sock) return;
      ws = null;
      wsOK = false;
      machine.reset();
      if (deliberateClose) {
        deliberateClose = false;
        return;
      }
      if (ev.code === 4401) {
        connectWanted = false;
        sink?.onNote('语音服务 token 不对（局域网模式）');
        return;
      }
      if (disposed || !connectWanted) return;
      reconnects++;
      const delay = reconnectDelayMs(reconnectAttempt++);
      sink?.onNote(`语音服务断开，${(delay / 1000).toFixed(1)}s 后重连…`);
      reconnectTimer = window.setTimeout(connect, delay);
    };
  };

  const armIdleClose = (): void => {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      // 空闲的完整定义：整窗无上行帧才算。锁定 PTT/通话聆听期帧连流（静默也是
      // 帧），连接在真占用管线槽；只看轮次态会把「按住中长静默」误判空闲，
      // 断开后同一次按住的后继帧静默丢弃到松手。
      if (machine.canIdleClose() && wsOK && performance.now() - lastUplinkAt >= IDLE_CLOSE_MS) {
        if (ws !== null) deliberateClose = true; // 仅在有 close 事件可消费时置位（b44 R1 P2：陈旧标记吞下次真断线重连）
        connectWanted = false;
        machine.prepareClose();
        try { ws?.close(); } catch { /* 已断 */ }
      } else {
        armIdleClose();
      }
    }, IDLE_CLOSE_MS);
  };

  const initMic = async (): Promise<boolean> => {
    if (micReady) return true;
    if (navigator.mediaDevices?.getUserMedia === undefined) {
      sink?.onNote('此环境没有麦克风 API');
      return false;
    }
    const base: Record<string, unknown> = { channelCount: 1, noiseSuppression: true, autoGainControl: true };
    const order: string[] = [];
    try {
      const sup = navigator.mediaDevices.getSupportedConstraints() as Record<string, boolean>;
      if (sup['echoCancellationType'] === true) order.push('system');
    } catch { /* 探测失败走浏览器层 */ }
    order.push('browser');
    for (const ect of order) {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { ...base, echoCancellation: true, echoCancellationType: ect } as MediaTrackConstraints,
        });
        break;
      } catch { /* 换下一层 */ }
    }
    if (mediaStream === null) {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, echoCancellation: true } as MediaTrackConstraints });
      } catch {
        sink?.onNote('麦克风不可用（权限被拒或无设备）');
        return false;
      }
    }
    // 采集链后半段（AudioContext/worklet 装配，R1 P2#2）：CSP/极端环境任一步
    // 抛出都归一为「不可用 + 提示」并释放已到手的 mediaStream——不裸抛成
    // unhandled rejection（麦克风指示灯滞留、通话横幅滞留「接通中…」）。
    let blobUrl = '';
    try {
      audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      blobUrl = URL.createObjectURL(new Blob([`
        class SendProc extends AudioWorkletProcessor {
          process(inputs) {
            const ch = inputs[0][0];
            if (ch) this.port.postMessage(ch.slice(0));
            return true;
          }
        }
        registerProcessor('juli-voice-send', SendProc);
      `], { type: 'application/javascript' }));
      await audioCtx.audioWorklet.addModule(blobUrl);
      workletNode = new AudioWorkletNode(audioCtx, 'juli-voice-send');
      workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (!uplink || !wsOK) { chunksDropped++; return; }
        for (const frame of acc.push(float32ToPcm16(e.data))) sendFrame(frame);
      };
      audioCtx.createMediaStreamSource(mediaStream).connect(workletNode); // 不连 destination
    } catch {
      workletNode?.disconnect();
      workletNode = null;
      for (const t of mediaStream?.getTracks() ?? []) t.stop();
      mediaStream = null;
      void audioCtx?.close().catch(() => { /* 已关 */ });
      audioCtx = null;
      sink?.onNote('语音采集初始化失败（浏览器拒绝音频工作器）');
      return false;
    } finally {
      if (blobUrl !== '') URL.revokeObjectURL(blobUrl);
    }
    micReady = true;
    return true;
  };

  return {
    route(cb) {
      sink = cb;
    },
    async start(opts) {
      connectWanted = true;
      connect();
      armIdleClose();
      if (audioCtx !== null && audioCtx.state === 'suspended') void audioCtx.resume().catch(() => { /* 下次手势再试 */ });
      if (opts?.mic !== false && !micReady && !(await initMic())) {
        connectWanted = false;
        return false;
      }
      return true;
    },
    close() {
      // 空闲断开正门：先收协议层，再断 WS（槽位立即释放；再按说话键自动连回）
      // deliberateClose 仅在有 close 事件可消费（ws 在场）时置位（b44 R1 P2）：
      // 退避窗内挂断时 ws===null、无 onClose 到达，置位即成陈旧标记——下一次
      // 真断线被当主动挂断吞掉，通话静默死面。
      if (ws !== null) deliberateClose = true;
      connectWanted = false;
      machine.prepareClose();
      try { ws?.close(); } catch { /* 已断 */ }
      window.clearTimeout(idleTimer);
      window.clearTimeout(reconnectTimer); // 退避窗内挂断：拆除在途重连，不留僵尸连接占管线槽（R1 P1#2）
    },
    send(i16) {
      if (uplink) sendFrame(i16);
    },
    setUplink(on) {
      uplink = on;
      if (!on) acc.reset(); // 朗读期丢弃的帧不留尾巴
      // b44 R1 P2 接线：上行闸状态镜像进协议机（此前 uplinkStarted/uplinkEnded
      // 全仓零调用——PTT 中噪声致 speech_started 无 stopped 时 roundOpen 恒
      // true，「松手武装」看门狗不可达：无 abandoned 提示、45s 空闲正门永不
      // 触发，juli-voice 槽位占至页面关闭）。松手（false）即 uplinkEnded：
      // roundOpen 残轮就地武装看门狗；按住（true）即 uplinkStarted：闸开着
      // 不断空闲（canIdleClose 的 uplinking 腿与 lastUplinkAt 门同向加固）。
      if (on) machine.uplinkStarted();
      else machine.uplinkEnded();
    },
    flushTail() {
      if (!uplink) return;
      const tail = acc.flush();
      if (tail !== null) sendFrame(tail);
    },
    counters() {
      return { framesSent, chunksDropped, micReady };
    },
    state() {
      return { ws: wsOK, ready: machine.state().ready, reconnects };
    },
    dispose() {
      disposed = true;
      connectWanted = false;
      deliberateClose = true;
      machine.prepareClose();
      try { ws?.close(); } catch { /* 已断 */ }
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(idleTimer);
      workletNode?.disconnect();
      for (const t of mediaStream?.getTracks() ?? []) t.stop();
      void audioCtx?.close().catch(() => { /* 已关 */ });
    },
  };
};

// 共享会话单例（2026-10-27 通话后台保持）：会话生命周期=页面，不随 /chat
// 视图挂载/卸载生灭——此前每次进视图 createVoiceSession、切页 dispose，
// 通话进行中切页即断线（缺陷单 wf_efccc6271097）。视图与通话中心共用这一份
// （服务端并发=2 管线槽，双会话=占满拒连，单例顺带根除互斥隐患）。
let shared: VoiceSession | null = null;
export const getSharedVoiceSession = (): VoiceSession => {
  if (shared === null) shared = createVoiceSession();
  return shared;
};
