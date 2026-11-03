// 语音输入组件（2026-10-21 用户裁决「语音=交互模态，不是页面」；同日通话化
// 改建后瘦身）：发单对话 composer 的 🎤 按钮——按住说话（点一下锁定），松手
// 成稿（一次按住=一条消息，多段拼接）直接进件。采集/WS/协议在 voice-session.ts
// （与通话模式共用一套，chat.ts 创建并在两模式间 route 互斥）；本文件只做
// PTT 按钮语义与拼接成稿。样式纪律同 chat：颜色只引 :root token，零裸 hex。
// ?probe=1 装 E2E 探针（回放 WAV 走会话同一条上行路径）。

import { wavToPcm16 } from './voice-protocol.ts';
import type { VoiceSession } from './voice-session.ts';

declare global {
  interface Window {
    __voiceProbe?: () => Record<string, unknown>;
    __voiceReplayUrl?: (url: string) => Promise<string>;
    __voicePtt?: (on: boolean) => void;
  }
}

/** 松手后等终稿的宽限：VAD 判停 ≤300ms + 终稿 ≤300ms，4s 覆盖慢转写。 */
const SETTLE_MS = 4_000;

const VOICEIN_CSS = `
.vc-mic { flex-shrink: 0; min-width: 44px; }
.vc-mic.on { background: var(--c-red); }
.vc-mic[disabled] { opacity: .55; }
`;

export interface VoiceInputCallbacks {
  /** 实时转写预览与瞬时提示（连接/没听清）；空串=清空。 */
  onLive(text: string): void;
  /** 松手成稿：一次按住=一条消息（多段判停拼接）。空串不会回调。 */
  onFinal(text: string): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

export const mountVoiceInput = (
  host: HTMLElement,
  cb: VoiceInputCallbacks,
  session: VoiceSession,
): (() => void) => {
  let disposed = false;
  let ptt = false;
  let locked = false;
  let downAt = 0;
  let tapHandled = false;
  let settleTimer = 0;
  const userFinals: string[] = [];
  const pageErrors: string[] = [];
  /** 一次按住期间的终稿（长停顿被 VAD 切段时拼接为一条消息）。 */
  let heldFinals: string[] = [];

  host.innerHTML = `
    <style>${VOICEIN_CSS}</style>
    <button class="btn vc-mic" title="按住说话（点一下锁定）；juli-voice 本地转写，不外发">🎤</button>`;
  const btn = host.querySelector('button') as HTMLButtonElement;

  const ui = (): void => {
    btn.classList.toggle('on', ptt);
    btn.textContent = ptt ? '🔴' : '🎤';
    btn.title = ptt ? (locked ? '说话中…再点结束' : '说话中…松开结束') : '按住说话（点一下锁定）；juli-voice 本地转写，不外发';
  };

  const live = (t: string): void => { if (!disposed) cb.onLive(t); };

  /** 本模式激活时接管会话事件（chat.ts 在输入/通话间 route）。 */
  const sink = {
    onFinal: (text: string): void => {
      heldFinals.push(text);
      if (userFinals.length >= 200) userFinals.shift();
      userFinals.push(text);
      live(`🎤 ${text}`);
    },
    onNote: live,
    onVad: () => { /* PTT 态不需要灯 */ },
    onReady: () => { if (ptt) live('🎤 请说——松手成稿'); },
  };
  session.route(sink);

  const settle = (): void => {
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      if (disposed) return;
      const text = heldFinals.join('');
      heldFinals = [];
      if (text !== '') cb.onFinal(text);
      else live('（没听清，再试一次）');
      live('');
    }, SETTLE_MS);
  };

  const pttStart = async (): Promise<void> => {
    if (ptt || disposed) return;
    ptt = true;
    locked = false;
    ui();
    // 上一按的迟到终稿先交付再清零（R1 P2#1）：settle 4s 宽限窗内再按，已到的
    // 终稿立即成稿（不丢、不串进新按）；先拆 settle 定时器，防空窗到点误报
    // 「没听清」。残余：再按之后才到的终稿仍归新按（协议机无轮次 id 可分归属）。
    window.clearTimeout(settleTimer);
    if (heldFinals.length > 0) {
      const pending = heldFinals.join('');
      heldFinals = [];
      cb.onFinal(pending);
    }
    session.setUplink(true);
    let ok = false;
    try {
      ok = await session.start();
    } catch {
      ok = false; // 采集层异常按不可用收口（R1 P2#2）：不裸抛成 unhandled rejection
    }
    if (!ok) {
      ptt = false;
      ui();
      session.close(); // 失败即关 WS（槽位立即释放），不悬开等 45s idle 兜底
      return;
    }
    live('🎤 请说——松手成稿');
  };

  const pttStop = (): void => {
    if (!ptt) return;
    ptt = false;
    locked = false;
    ui();
    session.flushTail(); // 尾帧先出门再关闸：关闸后 flushTail 早退，尾音会被切
    // 松手=不再说话，必须关上行闸（R2 NEW P2）：闸开着静默帧连流实发，lastUplinkAt
    // 永远新鲜，45s 空闲断开（管线槽唯一释放正门）永不触发。只关上行不停下行——
    // settle 宽限窗内的迟到终稿照收；按住中仍开闸帧连流，永不判空闲（R1 语义不变）。
    session.setUplink(false);
    settle();
  };

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    if (ptt && locked) { tapHandled = true; pttStop(); return; }
    tapHandled = false;
    downAt = performance.now();
    void pttStart();
  });
  btn.addEventListener('pointerup', () => {
    if (tapHandled) return;
    if (!ptt) return;
    if (performance.now() - downAt < 300) locked = true; // 点一下=锁定（长句免按住）
    else pttStop();
    ui();
  });
  btn.addEventListener('pointercancel', () => { if (!locked) pttStop(); });

  // ---- E2E 探针（?probe=1）--------------------------------------------------------

  const wantProbe = new URLSearchParams(location.search).has('probe')
    || new URLSearchParams(location.hash.split('?')[1] ?? '').has('probe');
  const onWinError = (e: ErrorEvent): void => { if (pageErrors.length < 50) pageErrors.push(`error: ${e.message}`); };
  const onRejection = (e: PromiseRejectionEvent): void => { if (pageErrors.length < 50) pageErrors.push(`unhandledrejection: ${String(e.reason)}`); };
  const probeFn = (): Record<string, unknown> => ({
    ptt, locked, micMode: true, userFinals: [...userFinals], errors: [...pageErrors],
    ...(session.counters() as Record<string, unknown>), ...session.state(),
  });
  const replayFn = async (url: string): Promise<string> => {
    const wav = wavToPcm16(new Uint8Array(await (await fetch(url)).arrayBuffer()));
    if (wav === null) return '不是可解析的 PCM16 WAV';
    heldFinals = [];
    window.clearTimeout(settleTimer);
    if (!(await session.start({ mic: false }))) return '连接未就绪';
    const t0 = performance.now();
    while (!session.state().ready && performance.now() - t0 < 12_000 && !disposed) await sleep(60);
    if (!session.state().ready) return '连接未就绪（服务启动中/槽满）';
    const per = Math.max(1, Math.round(wav.sampleRate / 10));
    // 回放帧走 send 的上行闸（不经 pttStart，闸不会自己开）：上一按松手关过闸，
    // 不在此重开则整段回放被静默丢弃；灌完即关（同 pttStop），探针页若开过麦，
    // 闸留着会让静默帧连流占死 45s 空闲正门。早退路径不碰闸，无需 try/finally。
    session.setUplink(true);
    for (let i = 0; i < wav.samples.length && !disposed && session.state().ws; i += per) {
      session.send(wav.samples.subarray(i, i + per));
      await sleep(100); // 实时节奏（VAD 按真实停顿判段）
    }
    session.setUplink(false);
    settle();
    return 'ok';
  };
  const pttFn = (on: boolean): void => { if (on) void pttStart(); else pttStop(); };
  if (wantProbe) {
    window.__voiceProbe = probeFn;
    window.__voiceReplayUrl = replayFn;
    window.__voicePtt = pttFn;
    window.addEventListener('error', onWinError);
    window.addEventListener('unhandledrejection', onRejection);
  }
  ui();
  return () => {
    disposed = true;
    window.clearTimeout(settleTimer);
    if (wantProbe) {
      window.removeEventListener('error', onWinError);
      window.removeEventListener('unhandledrejection', onRejection);
      if (window.__voiceProbe === probeFn) delete window.__voiceProbe;
      if (window.__voiceReplayUrl === replayFn) delete window.__voiceReplayUrl;
      if (window.__voicePtt === pttFn) delete window.__voicePtt;
    }
    host.innerHTML = '';
  };
};
