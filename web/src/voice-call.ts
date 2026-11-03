// 通话开单组件（2026-10-21 用户裁定：通话过程中异步开单/异步确认/异步思考与
// 工具调用）：发单对话的 📞 模式——麦克常开连续聆听（VAD 分段自动成轮次），
// 回复用浏览器 speechSynthesis 朗读（juli-voice TTS 的 sts 文本注入路径实测
// 只有首秒真声+静音填充，暂不可用；Speaker 接口位留给它修复后接入），朗读期
// 半双工关闭上行防回声（外放时 juli 听不到自己；抢话=点横幅止播）。
// 计划卡出现后，说「确认/开单/可以」走语音确认（classifyConfirmUtterance 严格
// 短句匹配，长句一律当修订轮次）——确认动作仍走 confirmPlan 正门。
//
// 2026-10-27 通话后台保持（缺陷单 wf_efccc6271097：通话进行中切页即断线）：
// 生命周期两层拆开——
//   · 核心单例 getVoiceCall：通话状态/朗读/半双工/轮次裁决，生命周期=页面。
//     视图切走只注销「视图接线」，通话本体照常：轮次走内置后台执行器（turn/
//     confirm/deny POST 是纯 API，服务端按 conv 隔离上下文），回复照常朗读，
//     transcript 写穿透（chat-transcript 单一事实源）——回到 /chat 回放即见。
//   · UI 挂载 mountVoiceCallUI / mountVoiceCallPill：随挂载面生灭，只渲染与
//     事件绑定，任何 detach 都不动通话。
// 会话（采集/WS/stt 协议机）用共享单例 getSharedVoiceSession，同理不随视图生灭。

import { GUARD_MS, wavToPcm16 } from './voice-protocol.ts';
import { api } from './api.ts';
import { classifyConfirmUtterance, speechText } from './chat-live.ts';
import { appendTranscriptMsg, convId } from './chat-transcript.ts';
import { getSharedVoiceSession } from './voice-session.ts';
import type { VoiceSession } from './voice-session.ts';

// 分类器零 DOM 实现在 chat-live.ts（node 测试直接引用）；此处 re-export 维持
// 通话模块的语义聚合面。
export { classifyConfirmUtterance };
export type { ConfirmIntent } from './chat-live.ts';

// ---- 朗读（浏览器 speechSynthesis；无可用语音=无声通话，文本照常上屏）-------------

export interface Speaker {
  readonly available: boolean;
  /** 朗读（异步）；onDone 恒会被调一次（含 stop/出错）。 */
  speak(text: string, onDone: () => void): void;
  /** 立即停（抢话）；触发挂起 utterance 的 onDone。 */
  stop(): void;
  speaking(): boolean;
  /** 卸载收口（b44 R1 P2）：移除 voiceschanged 监听——挂载面反复建 Speaker
   * 逐次累积监听（同一 synth 全局对象），漏移除=泄漏累积。 */
  dispose(): void;
}

// 引用保活：Chrome 的已知怪癖——utterance 被 GC 会连朗读一起停。
const refs: SpeechSynthesisUtterance[] = [];

export const createSpeaker = (): Speaker => {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (synth === undefined) {
    return { available: false, speak: (_t, onDone) => { onDone(); }, stop: () => {}, speaking: () => false, dispose: () => {} };
  }
  let voice: SpeechSynthesisVoice | null = null;
  let done: (() => void) | null = null;
  // 朗读代际（R1 P1#1）：每次 speak/stop 递增。synth.cancel() 后被弃 utterance
  // 的 onend 滞后才到，此刻 done 已指向新句回调——不闸代际就是旧句替新句收口
  // （半双工上行提前重开，TTS 回声进麦）。滞后到点的旧 fin 一律 no-op。
  let gen = 0;
  // Chrome 语音列表异步到（voiceschanged）；先同步取一次，列表到了再挑。
  const pick = (): void => {
    const voices = synth.getVoices();
    voice = voices.find((v) => /zh[-_]CN/i.test(v.lang) && /ting|xiao|yue|hui|yun/i.test(v.name))
      ?? voices.find((v) => /zh/i.test(v.lang))
      ?? voices[0] ?? null;
  };
  pick();
  synth.addEventListener('voiceschanged', pick);
  return {
    available: true,
    speak(text, onDone) {
      synth.cancel(); // 前一句没完就来了新句：弃旧读新
      gen++;
      done?.(); // 旧句立即收口通知（契约：onDone 恒调一次；消费侧按代际决定是否恢复上行）
      done = onDone;
      const myGen = gen;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      if (voice !== null) u.voice = voice;
      u.rate = 1.05;
      refs.push(u);
      if (refs.length > 8) refs.shift();
      let settled = false;
      const fin = (): void => {
        if (!settled && myGen === gen) { settled = true; window.clearTimeout(watchdog); done?.(); done = null; }
      };
      // 朗读看门狗：无语音环境（无头/极简系统）speak 可能永不回调——按文本
      // 估时强制收口，否则半双工上行永久关闭、通话死气。被顶掉的旧看门狗到点
      // 因代际闸成 no-op。
      const watchdog = window.setTimeout(fin, Math.min(30_000, 1_500 + text.length * 350));
      u.onend = fin;
      u.onerror = fin;
      synth.speak(u);
    },
    stop() {
      synth.cancel();
      gen++; // 抢话/挂断后滞后 onend 不得再收口
      done?.();
      done = null;
    },
    speaking() {
      return synth.speaking;
    },
    dispose() {
      synth.removeEventListener('voiceschanged', pick); // 挂载面反复建 Speaker：监听随 dispose 收口（b44 R1 P2）
    },
  };
};

// ---- 通话核心（单例；生命周期=页面）-------------------------------------------------

export type VoiceCallStatus = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

/** 视图接线（视图在场时注册；切页注销，通话回落后台执行器）。 */
export interface VoiceCallViewHandlers {
  /** 轮次交视图执行（fire 路径：流式渲染 + busy 守卫 + transcript）。 */
  onUserText(text: string): void;
  /** 瞬时提示（转写错误/没听清/连接态）。 */
  onNote(text: string): void;
  /** 通话起停（视图据此切换输入按钮/计划卡提示/朗读接线）。 */
  onActiveChange(active: boolean): void;
}

/** turn 回包（与服务端 /api/chat/intake/turn 契约对齐的只读形状）。 */
interface TurnReply {
  readonly reply: string;
  readonly events: readonly { readonly type: string; readonly data: string }[];
}

export interface VoiceCallCore {
  active(): boolean;
  status(): VoiceCallStatus;
  /** 通话时长（秒；未开始=0）。 */
  elapsed(): number;
  /** 最近一条瞬时提示（pill 在视图不在场时展示用）。 */
  note(): string;
  /** 视图接线（挂载注册 / 切页注销）。 */
  setViewHandlers(h: VoiceCallViewHandlers | null): void;
  /** 对齐计划卡相位（服务端是唯一事实源）：视图挂载恢复 state / 切页移交。 */
  syncPlanPending(has: boolean): void;
  /** 后台轮次写穿透后的视图回放通知口（视图注册；busy 时自行延后）。 */
  setOnExternalTranscript(fn: (() => void) | null): void;
  /** 状态/时长变化观察（多播：视图横幅与全局 pill 各订各的；返回注销口）。
   * 每秒 tick + 状态迁移都广播——时长走表由核心统一供（挂载面不再自持 timer）。 */
  onState(fn: () => void): () => void;
  begin(): void;
  speak(text: string): void;
  stopSpeaking(): void;
  end(): void;
  /** 朗读可用性（无声环境下 pill/横幅文案照常，朗读静默直通）。 */
  speakerAvailable(): boolean;
  /** 探针口径（E2E ?probe=1）。 */
  counters(): { framesSent: number; chunksDropped: number; micReady: boolean };
  state(): { ws: boolean; ready: boolean; reconnects: number };
  trace(): { finals: readonly string[]; spoken: readonly string[] };
}

// 后台轮次执行守卫：单飞行——上一轮 turn 在途时新终稿不再进件（视图 fire 的
// busy 守卫同口径；误并发=服务端 intake 上下文交错）。
let bgBusy = false;

export const ensureVoiceCall = (session: VoiceSession): VoiceCallCore => {
  let inCall = false;
  let status: VoiceCallStatus = 'idle';
  let tStart = 0;
  // 朗读代际（R1 P1#1）：与 speaker 内部代际同向——被新句顶掉/被打断的旧句
  // onDone 不得武装恢复定时器，否则 350ms 尾音窗后上行在第二句仍播放时重开，
  // 麦克风采到 TTS 回声被转写成幻轮次。
  let speakGen = 0;
  let guardTimer = 0;
  let noteText = '';
  let hasPlanPending = false;
  let speaker: Speaker | null = null;
  let view: VoiceCallViewHandlers | null = null;
  let onExternal: (() => void) | null = null;
  let tickTimer = 0;
  const watchers = new Set<() => void>();
  const finals: string[] = [];
  const spoken: string[] = [];

  const speakerOf = (): Speaker => {
    if (speaker === null) speaker = createSpeaker();
    return speaker;
  };

  const notify = (): void => { for (const w of watchers) w(); };
  const setStatus = (s: VoiceCallStatus): void => {
    status = s;
    notify();
  };
  const setNote = (t: string): void => {
    noteText = t;
    notify();
  };
  /** 时长走表：通话中每秒广播一次（挂载面不再自持 interval，多挂载面同源）。 */
  const armTick = (): void => {
    window.clearInterval(tickTimer);
    if (!inCall) return;
    tickTimer = window.setInterval(notify, 1000);
  };

  const resumeUplink = (): void => {
    if (!inCall) return;
    session.setUplink(true);
    setStatus('listening');
  };

  /** 后台轮次事件投影（视图 applyEvents 的落档子集——plan 相位 + 系统行）。 */
  const applyBgEvents = (events: readonly { readonly type: string; readonly data: string }[]): string => {
    let dispatched = '';
    for (const e of events) {
      if (e.type === 'chat:plan') hasPlanPending = true;
      else if (e.type === 'chat:phase' && e.data !== 'proposed') hasPlanPending = false;
      else if (e.type === 'chat:dispatched') { dispatched = e.data; hasPlanPending = false; }
      else if (e.type === 'chat:system') appendTranscriptMsg('sys', e.data);
      else if (e.type === 'chat:error') appendTranscriptMsg('sys', `⚠ ${e.data}`);
    }
    return dispatched;
  };

  // ---- 后台执行器（视图不在场时轮次/确认的落点）-------------------------------------

  const bgTurn = async (text: string): Promise<void> => {
    if (bgBusy) { setNote('（上一轮还在处理，稍候）'); return; }
    bgBusy = true;
    setStatus('thinking');
    appendTranscriptMsg('user', text);
    onExternal?.();
    try {
      const r = await api.post<TurnReply>(`/api/chat/intake/turn?conv=${convId()}`, { input: text });
      const dispatched = applyBgEvents(r.events);
      if (r.reply !== '') appendTranscriptMsg('assistant', r.reply);
      if (dispatched !== '') appendTranscriptMsg('sys', `📞 已开单 ${dispatched}（后台轮次开单，回 /chat 看回执卡）`);
      onExternal?.();
      call.speak(dispatched !== '' ? '已开单。' : speechText(r.reply));
    } catch (e) {
      appendTranscriptMsg('sys', `⚠ 通话轮次发送失败：${e instanceof Error ? e.message : String(e)}`);
      onExternal?.();
      setStatus('listening');
    } finally {
      bgBusy = false;
      if (status === 'thinking') setStatus('listening');
    }
  };

  const bgConfirm = async (): Promise<void> => {
    if (bgBusy) { setNote('（上一轮还在处理，稍候）'); return; }
    bgBusy = true;
    setStatus('thinking');
    try {
      const r = await api.post<{ events: readonly { readonly type: string; readonly data: string }[]; runId: string | null }>(
        `/api/chat/intake/confirm?conv=${convId()}`, { auto_approve: false });
      const dispatched = applyBgEvents(r.events);
      const id = r.runId ?? dispatched;
      appendTranscriptMsg('sys', id !== '' ? `📞 已开单 ${id}（语音确认·后台）` : '📞 语音确认已提交（后台）');
      onExternal?.();
      call.speak('已开单。');
    } catch (e) {
      appendTranscriptMsg('sys', `⚠ 语音确认失败：${e instanceof Error ? e.message : String(e)}`);
      onExternal?.();
      setStatus('listening');
    } finally {
      bgBusy = false;
      if (status === 'thinking') setStatus('listening');
    }
  };

  const bgDeny = async (): Promise<void> => {
    try {
      const r = await api.post<{ events: readonly { readonly type: string; readonly data: string }[] }>(
        `/api/chat/intake/deny?conv=${convId()}`);
      applyBgEvents(r.events);
      appendTranscriptMsg('sys', '📞 语音取消：计划卡已放弃（后台）');
    } catch { /* 回到讨论态失败也不阻塞继续对话 */ }
    hasPlanPending = false;
    onExternal?.();
  };

  /** 会话事件接管（通话期间 route 在此；转写裁决见 onFinal）。 */
  const sink = {
    onFinal: (text: string): void => {
      if (!inCall || speakerOf().speaking()) return; // 半双工：朗读期来的转写=回声，丢
      finals.push(text);
      if (finals.length > 100) finals.shift();
      setStatus('thinking');
      // 计划卡裁决：视图在场=视图裁（它的 plan 状态权威，走 confirmPlan 正门）；
      // 不在场=核心裁（syncPlanPending 对齐的相位投影），确认/否决走同一 API
      // 端点。长句（含「确认」字样）一律当修订轮次——误开单的代价远大于多说一轮。
      if ((view !== null || hasPlanPending) && !bgBusy) {
        const intent = classifyConfirmUtterance(text);
        if (intent === 'confirm') {
          if (view !== null) { view.onUserText(text); return; }
          appendTranscriptMsg('sys', `📞 语音确认：「${text}」`);
          void bgConfirm();
          return;
        }
        if (intent === 'deny') {
          if (view !== null) { view.onUserText(text); return; }
          void bgDeny();
          return;
        }
      }
      if (view !== null) view.onUserText(text);
      else void bgTurn(text);
    },
    onNote: (t: string) => {
      if (t === '') return;
      if (view !== null) view.onNote(t);
      else setNote(t);
    },
    onVad: () => { /* 横幅状态由轮次驱动，VAD 灯省 */ },
    onReady: () => { if (inCall && status === 'connecting') setStatus('listening'); },
  };

  const call: VoiceCallCore = {
    active() { return inCall; },
    status() { return status; },
    elapsed() { return inCall ? Math.floor((Date.now() - tStart) / 1000) : 0; },
    note() { return noteText; },
    setViewHandlers(h) { view = h; },
    syncPlanPending(has) { hasPlanPending = has; },
    setOnExternalTranscript(fn) { onExternal = fn; },
    onState(fn) {
      watchers.add(fn);
      fn(); // 注册即画一帧（挂载面无需再手动初渲）
      return () => { watchers.delete(fn); };
    },
    speakerAvailable() { return speakerOf().available; },
    counters() { return session.counters(); },
    state() { return session.state(); },
    trace() { return { finals: [...finals], spoken: [...spoken] }; },
    speak(text) {
      if (!inCall) return;
      if (text === '' || !speakerOf().available) { setStatus('listening'); return; } // 无声通话：文本照常上屏
      spoken.push(text);
      if (spoken.length > 50) spoken.shift();
      window.clearTimeout(guardTimer); // 新句入口先拆恢复定时器：被顶掉的旧句收尾不再能重开上行
      speakGen++;
      const myGen = speakGen;
      session.setUplink(false); // 半双工：朗读期关上行（外放防回声）
      setStatus('speaking');
      speakerOf().speak(text, () => {
        if (myGen !== speakGen) return; // 旧代际收尾（被顶掉句的滞后/同步通知）：不武装恢复
        // 尾音抑制窗：朗读刚停的混响尾不进麦克风（GUARD_MS 同源语义）
        window.clearTimeout(guardTimer);
        guardTimer = window.setTimeout(resumeUplink, GUARD_MS);
      });
    },
    stopSpeaking() {
      speakerOf().stop();
      window.clearTimeout(guardTimer);
      resumeUplink();
    },
    begin() {
      if (inCall) return;
      inCall = true;
      tStart = Date.now();
      setNote('');
      setStatus('connecting');
      armTick();
      session.route(sink);
      session.setUplink(true);
      void session.start().then((ok) => {
        if (!ok) { call.end(); setNote('麦克风不可用，通话未接通'); return; }
        if (!inCall) return; // 握手/授权可挂数秒，期间挂断：不误报激活（R1 P2：否则无横幅无按钮死面）
        setStatus('listening');
        view?.onActiveChange(true);
      }).catch(() => {
        // 采集层异常（AudioContext/worklet 初始化失败等）：与 !ok 同款收口（R1 P2#2）
        call.end();
        setNote('麦克风不可用，通话未接通');
      });
      notify();
    },
    end() {
      if (!inCall) return;
      inCall = false;
      hasPlanPending = false;
      speakerOf().stop();
      window.clearTimeout(guardTimer);
      window.clearInterval(tickTimer);
      session.route(null);
      session.setUplink(true);
      session.close(); // 主动挂断=立即释放管线槽
      setStatus('idle');
      view?.onActiveChange(false);
    },
  };

  // ---- E2E 探针（?probe=1）：回放 WAV 走共享会话同一条上行路径 ---------------

  const wantProbe = typeof location !== 'undefined'
    && (new URLSearchParams(location.search).has('probe')
      || new URLSearchParams(location.hash.split('?')[1] ?? '').has('probe'));
  if (wantProbe) {
    const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
    window.__voiceCallProbe = () => ({
      inCall, status, active: call.active(), speaking: speakerOf().speaking(),
      speakerAvailable: speakerOf().available, bgBusy,
      ...(call.trace() as Record<string, unknown>), ...(session.counters() as Record<string, unknown>), ...session.state(),
    });
    window.__voiceCallFeedUrl = async (url: string) => {
      const wav = wavToPcm16(new Uint8Array(await (await fetch(url)).arrayBuffer()));
      if (wav === null) return '不是可解析的 PCM16 WAV';
      if (!(await session.start({ mic: false }))) return '连接未就绪';
      const t0 = performance.now();
      while (!session.state().ready && performance.now() - t0 < 12_000) await sleep(60);
      if (!session.state().ready) return '连接未就绪';
      const per = Math.max(1, Math.round(wav.sampleRate / 10));
      for (let i = 0; i < wav.samples.length && session.state().ws; i += per) {
        session.send(wav.samples.subarray(i, i + per));
        await sleep(100);
      }
      return 'ok';
    };
  }

  return call;
};

// 核心单例：通话状态全页面只有一份（切页/重挂共享同一通话）。session 用共享
// 会话（getSharedVoiceSession）——两层单例合成完整后台保持。
let singleton: VoiceCallCore | null = null;
export const getVoiceCall = (): VoiceCallCore => {
  if (singleton === null) singleton = ensureVoiceCall(getSharedVoiceSession());
  return singleton;
};

// ---- 通话 UI（横幅随挂载面生灭；detach 不动通话本体）--------------------------------

declare global {
  interface Window {
    __voiceCallProbe?: () => Record<string, unknown>;
    __voiceCallFeedUrl?: (url: string) => Promise<string>;
    __voiceCallStart?: () => void;
  }
}

const VOICECALL_CSS = `
.vc-call { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border: 1px solid var(--c-orange); border-radius: 999px; background: var(--c-orange-soft); font-size: var(--fs-small); color: var(--c-orange-deep); }
.vc-call .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c-orange); flex-shrink: 0; }
.vc-call.speaking .dot { background: var(--c-green); }
.vc-call .dur { font-variant-numeric: tabular-nums; font-family: var(--font-mono); }
.vc-call .st { flex: 1; }
.vc-call .end { height: 26px; padding: 0 12px; font-size: var(--fs-micro); background: var(--c-red-soft); color: var(--c-red); }
`;

export const mountVoiceCallUI = (
  host: HTMLElement,
  call: VoiceCallCore,
): (() => void) => {
  host.innerHTML = `
    <style>${VOICECALL_CSS}</style>
    <button class="btn" id="vc-start" title="开始通话：连续聆听说一轮开一轮；计划卡出现后说「确认」即开单">📞 通话</button>
    <div class="vc-call" id="vc-banner" hidden>
      <span class="dot"></span><span class="st">接通中…</span><span class="dur" id="vc-dur">00:00</span>
      <button class="end" id="vc-stop-say" title="立即停止朗读（抢话）">止播</button>
      <button class="end" id="vc-end">挂断</button>
    </div>`;
  const startBtn = host.querySelector('#vc-start') as HTMLButtonElement;
  const banner = host.querySelector('#vc-banner') as HTMLElement;
  const stEl = host.querySelector('.vc-call .st') as HTMLElement;
  const durEl = host.querySelector('#vc-dur') as HTMLElement;

  const fmtDur = (s: number): string => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const ui = (s: VoiceCallStatus): void => {
    const on = s !== 'idle';
    banner.hidden = !on;
    startBtn.hidden = on;
    banner.classList.toggle('speaking', s === 'speaking');
    stEl.textContent = s === 'connecting' ? '接通中…'
      : s === 'listening' ? '聆听中（说话即成轮）'
      : s === 'thinking' ? '处理中…'
      : '朗读中（点「止播」抢话）';
    durEl.textContent = fmtDur(call.elapsed());
  };

  startBtn.addEventListener('click', () => call.begin());
  (host.querySelector('#vc-end') as HTMLButtonElement).addEventListener('click', () => call.end());
  (host.querySelector('#vc-stop-say') as HTMLButtonElement).addEventListener('click', () => call.stopSpeaking());
  const unwatch = call.onState(() => ui(call.status())); // 多播订阅：与 pill 互不顶掉
  ui(call.status());

  // E2E 探针入口（?probe=1；核心探针已由 ensureVoiceCall 装，此处补起话口）。
  const wantProbe = new URLSearchParams(location.search).has('probe')
    || new URLSearchParams(location.hash.split('?')[1] ?? '').has('probe');
  if (wantProbe) window.__voiceCallStart = () => { startBtn.click(); };

  return () => {
    unwatch(); // 视图横幅退场：只摘自己的订阅，通话与 pill 不受影响
    host.innerHTML = '';
  };
};

// ---- 全局通话 pill（壳层常驻；切页后通话的可见面+挂断口）-----------------------------

const VOICEPILL_CSS = `
.vc-pill { position: fixed; right: 18px; bottom: 84px; z-index: 900; display: flex; align-items: center; gap: 10px;
  padding: 8px 14px; border: 1px solid var(--c-orange); border-radius: 999px; background: var(--c-orange-soft);
  font-size: var(--fs-small); color: var(--c-orange-deep); box-shadow: var(--shadow-md); }
/* bottom:84 让位反馈浮钮（fbv2-fab 常驻右下 16~70px，z-index 2147483000 压过一切
   —— pill 沉到同位挂断按钮永远点不到，不是视觉偏好是可用性）。 */
.vc-pill[hidden] { display: none; }
.vc-pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c-orange); flex-shrink: 0; }
.vc-pill.speaking .dot { background: var(--c-green); }
.vc-pill .st { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vc-pill .dur { font-variant-numeric: tabular-nums; font-family: var(--font-mono); }
.vc-pill .end { height: 26px; padding: 0 12px; font-size: var(--fs-micro); background: var(--c-red-soft); color: var(--c-red); }
`;

/** 通话后台保持的可见面（缺陷单 wf_efccc6271097）：通话进行中切页，/chat 的
 * 横幅随视图退场，本 pill 在壳层接管——状态/时长可见、止播/挂断可点、点状态
 * 回 /chat。仅通话中且不在 /chat 时显示（在 /chat 时横幅已在场，双显=噪音）。 */
export const mountVoiceCallPill = (host: HTMLElement, call: VoiceCallCore): void => {
  const box = document.createElement('div');
  box.innerHTML = `<style>${VOICEPILL_CSS}</style>
    <div class="vc-pill" id="vc-pill" hidden>
      <span class="dot"></span><span class="st" id="vc-pill-st"></span><span class="dur" id="vc-pill-dur">00:00</span>
      <button class="end" id="vc-pill-stop" title="立即停止朗读（抢话）">止播</button>
      <button class="end" id="vc-pill-end">挂断</button>
    </div>`;
  host.appendChild(box);
  const pill = box.querySelector('#vc-pill') as HTMLElement;
  const stEl = box.querySelector('#vc-pill-st') as HTMLElement;
  const durEl = box.querySelector('#vc-pill-dur') as HTMLElement;
  const fmtDur = (s: number): string => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const paint = (): void => {
    const s = call.status();
    const onChat = location.hash.startsWith('#/chat');
    pill.hidden = s === 'idle' || onChat;
    pill.classList.toggle('speaking', s === 'speaking');
    stEl.textContent = s === 'connecting' ? '📞 通话中：接通中…'
      : s === 'listening' ? `📞 通话保持中${call.note() !== '' ? ` · ${call.note()}` : ''}`
      : s === 'thinking' ? '📞 通话中：处理轮次…'
      : s === 'speaking' ? '📞 通话中：朗读回复…'
      : '';
    durEl.textContent = fmtDur(call.elapsed());
  };
  stEl.addEventListener('click', () => { location.hash = '#/chat'; });
  stEl.title = '通话在后台保持——点这里回到发单页';
  (box.querySelector('#vc-pill-stop') as HTMLButtonElement).addEventListener('click', () => call.stopSpeaking());
  (box.querySelector('#vc-pill-end') as HTMLButtonElement).addEventListener('click', () => call.end());
  call.onState(paint); // 壳层常驻订阅（与视图横幅多播并存，切页互不顶掉）
  window.addEventListener('hashchange', paint);
};
