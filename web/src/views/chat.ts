// 发单对话视图（09-29 定案）：#/trigger 表单的继任者。说一句话，开单助手
// clarify（白名单只读查询）到 target 清晰，亮 brief 预览卡，点「开单」走
// startTask 正门（POST /api/chat/intake/*，与旧表单同一契约）——创建动词
// 是人按按钮，机器只申报。提交后深链 #/lifecycle?w={id} 展开该单节点流
// （与表单时代同一落点）。v1 同步 JSON 往返（无 WS 流式）。
//
// 语音输入（2026-10-21 用户裁决「语音是流程里的一个功能，不是单独页面」）：
// composer 左侧 🎤 按住说话——juli-voice 本地转写（voice-input.ts，stt 模式），
// 松手成稿直接作为一轮对话进件，开单助手照常 clarify/出卡；iOS 的 Azure STT
// 语音优先发单是对位形态。
//
// 「call 效果」（2026-10-21 用户裁决：异步开单/异步 tool 调用/异步思考）：
// 挂 /ws/chat?conv= 帧流（服务端早已逐帧镜像，iOS 一直这么渲染），thinking
// 流式行、assistant chunk 原位合并、🔧 工具行、计划卡、开单回执全部边到边
// 上屏；POST 回包降级为兜底（WS 没通）与终稿校正。判定在 chat-live.ts
// （零 DOM，vitest），这里只执行。开单不再跳页：卡片原位「开单中…」→
// 系统行 + 单子卡，对话继续。
//
// 10-06 重设计（js-261006-s0msv9，用户裁定）：满高聊天面（main.chatfull，
// 沿会话 fullbleed 先例）——线程是真正的滚动容器（锚底从此生效）、合成器
// 常驻底部、说明文案降级为空态提示；黑屏根因修正：气泡只引 :root 真实
// token（旧 --panel/--accent 不存在，曾回退硬编码深色 → 黑底黑字），守卫
// 见 test/chat-view-css.test.ts。主页发单快入带 ?draft= 预填。
//
// 10-07 双端对齐（用户裁定「web 只能查有限的东西」）：①消息里的单子 ID
// 渲染任务单引用卡（标题/状态 + 点卡深链流水详情 + ➕跟进预填——照 iOS
// WorkflowRefCard 同语义）；②附件三件套（选择/托盘/上传，POST
// /api/chat/attachment 契约同 iOS）；③回合事件里的 tool_call 出「🔧 查询」
// 活动行（服务端白名单已扩到 5 只读工具，含 service_info 版本号查询）；
// ④本地 transcript 写穿透（用户实报「chat 不记录历史」——照 iOS
// chat-transcript.json 同语义，500 条上限，工具活动行不落档，头部「清空」）。

import { api, getToken } from '../api.ts';
import { esc } from '../esc.ts';
import { statusChip } from '../ui.ts';
import { chatReconnectDelayMs, chatWsUrl, classifyConfirmUtterance, createLiveChat, speechText, toolNameOf } from '../chat-live.ts';
import type { LiveOp } from '../chat-live.ts';
import { mountVoiceInput } from '../voice-input.ts';
import { getSharedVoiceSession } from '../voice-session.ts';
import { getVoiceCall, mountVoiceCallUI } from '../voice-call.ts';
import { convId, loadTranscript, resetConversation, saveTranscript, TS_LIMIT } from '../chat-transcript.ts';
import type { TsMsg } from '../chat-transcript.ts';

interface IntakeLanding {
  readonly session: string;
  readonly note: string;
}

interface IntakePlan {
  readonly title: string;
  readonly summary: string;
  readonly brief: string;
  readonly pinnedSession?: string;
  /** 路由层判定的落点（0930）：确认开单即钉进 input.session。 */
  readonly landing?: IntakeLanding;
}

interface IntakeEvent {
  readonly type: string;
  readonly data: string;
}

interface TurnResponse {
  readonly events: readonly IntakeEvent[];
  readonly reply: string;
}

interface StateResponse {
  readonly phase: 'discuss' | 'proposed';
  readonly plan: IntakePlan | null;
}

/** 附件回执（服务端 POST /api/chat/attachment 返回）。 */
interface AttachRef {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly bytes: number;
  readonly path: string;
}

/** 待上传附件（托盘本地态）。 */
interface PendingAttach {
  readonly name: string;
  readonly mime: string;
  readonly bytes: number;
  readonly file: File;
}

/** 单子引用卡数据（GET /api/lifecycle/workflows/:id 的 workflow 面）。 */
interface WorkflowRefData {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

// 附件纪律（与服务端 chat.ts 路由同款）：≤5 件、每件 ≤10MB、后缀白名单。
const ATTACH_MAX_COUNT = 5;
const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
const ATTACH_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.pdf',
  '.txt', '.md', '.json', '.csv', '.docx', '.xlsx', '.pptx', '.zip',
]);

/** wf_ + 12 位十六进制；去重保序（一条消息提到同一单多次只出一张卡）。 */
const wfRefs = (text: string): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(/wf_[0-9a-f]{12}/g)) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
};

/** 引用卡数据缓存（对齐 iOS WorkflowTreeCache 并补其并发竞态：60s TTL 数据
 * 档 + in-flight promise 去重——同批渲染同单多卡只发一次真实请求）。 */
const refCache = new Map<string, { title: string; status: string; at: number }>();
const refInflight = new Map<string, Promise<{ title: string; status: string }>>();
const REF_TTL = 60_000;

const refFetch = (id: string): Promise<{ title: string; status: string }> => {
  const hit = refCache.get(id);
  if (hit !== undefined && Date.now() - hit.at < REF_TTL) return Promise.resolve(hit);
  const flying = refInflight.get(id);
  if (flying !== undefined) return flying;
  const p = api.get<{ workflow: WorkflowRefData }>(`/api/lifecycle/workflows/${encodeURIComponent(id)}`)
    .then((d) => {
      const v = { title: d.workflow?.title ?? id, status: d.workflow?.status ?? '' };
      refCache.set(id, { ...v, at: Date.now() });
      refInflight.delete(id);
      return v;
    })
    .catch((e: unknown) => {
      refInflight.delete(id);
      throw e;
    });
  refInflight.set(id, p);
  return p;
};

/** 迷你 Markdown 渲染（对齐 iOS assistant 富渲染的 web 版）：围栏代码块/
 * 标题/有序无序列表/水平线/行内代码/粗斜体/链接。管线纪律：先整段 HTML
 * 转义、再生成自家标签——原文永远不直接进 innerHTML（XSS 面=零）；链接
 * 仅 http(s) 且新窗打开。 */
const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const inlineMd = (s: string): string =>
  escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

const renderMd = (src: string): string => {
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const closeList = (): void => { if (list !== null) { out.push(`</${list}>`); list = null; } };
  const parts = src.split(/```/);
  for (let pi = 0; pi < parts.length; pi++) {
    if (pi % 2 === 1) {
      // 围栏块：首行可能是语言标注
      closeList();
      const nl = parts[pi]!.indexOf('\n');
      const lang = nl >= 0 ? parts[pi]!.slice(0, nl).trim() : '';
      const body = nl >= 0 ? parts[pi]!.slice(nl + 1) : parts[pi]!;
      out.push(`<pre class="chat-code">${lang !== '' ? `<span class="chat-code-lang">${escHtml(lang)}</span>` : ''}<code>${escHtml(body.replace(/\n$/, ''))}</code></pre>`);
      continue;
    }
    for (const line of parts[pi]!.split('\n')) {
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      const ul = /^[-*]\s+(.*)$/.exec(line);
      const ol = /^\d+[.)]\s+(.*)$/.exec(line);
      if (line.trim() === '') { closeList(); continue; }
      if (/^(---+|\*\*\*+)$/.test(line.trim())) { closeList(); out.push('<hr>'); continue; }
      if (h !== null) { closeList(); out.push(`<div class="chat-md-h${h[1]!.length}">${inlineMd(h[2]!)}</div>`); continue; }
      if (ul !== null) { if (list !== 'ul') { closeList(); list = 'ul'; out.push('<ul>'); } out.push(`<li>${inlineMd(ul[1]!)}</li>`); continue; }
      if (ol !== null) { if (list !== 'ol') { closeList(); list = 'ol'; out.push('<ol>'); } out.push(`<li>${inlineMd(ol[1]!)}</li>`); continue; }
      closeList();
      out.push(`<p>${inlineMd(line)}</p>`);
    }
  }
  closeList();
  return out.join('');
};

// ---- 本地 transcript：实现收编进 chat-transcript.ts（2026-10-27 通话后台
// 保持抽出）——通话中心与视图是同一档的两个消费者，单一事实源必须单处持有。 ----

// 视图内 scope 样式（style.css 承壳层几何 main.chatfull；气泡/合成器住这里）。
// 颜色一律引 :root 真实 token，零裸 hex——test/chat-view-css.test.ts 守卫。
const CHAT_CSS = `
.chat-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: 10px; max-width: 760px; width: 100%; margin: 0 auto; }
.chat-head { display: flex; align-items: baseline; gap: 10px; }
.chat-head h1 { font-size: var(--fs-page-title); font-weight: 700; letter-spacing: -.3px; margin: 0; }
.chat-head .sub { font-size: var(--fs-sub); color: var(--muted); margin: 0; }
.chat-thread { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 2px 4px 8px; }
.chat-empty { margin: auto; text-align: center; color: var(--muted); font-size: var(--fs-sub); line-height: 1.9; padding: 16px 0; }
.chat-empty .lead { display: block; font-size: var(--fs-card-title); color: var(--body); margin-bottom: 2px; }
.chat-msg { max-width: 78%; padding: 10px 14px; border-radius: 13px; font-size: var(--fs-body); line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
.chat-msg.user { align-self: flex-end; background: var(--c-orange); color: var(--btn-primary-fg); border-bottom-right-radius: 4px; font-weight: 500; }
.chat-msg.assistant { align-self: flex-start; background: var(--card); color: var(--ink); border: 1px solid var(--line); border-bottom-left-radius: 4px; box-shadow: var(--shadow-sm); }
.chat-msg.sys { align-self: center; font-size: var(--fs-small); color: var(--muted); padding: 2px 0; }
.chat-md { white-space: normal; }
.chat-md p { margin: 0 0 6px; }
.chat-md p:last-child { margin-bottom: 0; }
.chat-md-h1, .chat-md-h2, .chat-md-h3, .chat-md-h4 { font-weight: 700; margin: 8px 0 4px; }
.chat-md-h1 { font-size: var(--fs-card-title); }
.chat-md-h2 { font-size: var(--fs-body); }
.chat-md-h3, .chat-md-h4 { font-size: var(--fs-sub); }
.chat-md ul, .chat-md ol { margin: 0 0 6px; padding-left: 20px; }
.chat-md li { margin: 2px 0; }
.chat-md hr { border: none; border-top: 1px solid var(--line); margin: 8px 0; }
.chat-md a { color: var(--c-blue); }
.chat-md code { font-family: var(--font-mono); font-size: var(--fs-small); background: var(--c-line-soft); border-radius: 4px; padding: 1px 5px; }
.chat-code { font-family: var(--font-mono); font-size: var(--fs-small); background: var(--c-line-soft); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 4px 0 8px; overflow-x: auto; white-space: pre; }
.chat-code code { background: none; padding: 0; }
.chat-code-lang { display: block; font-size: var(--fs-micro); color: var(--muted); margin-bottom: 6px; }
.chat-tool { align-self: flex-start; font-size: var(--fs-micro); color: var(--muted); padding: 1px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
.chat-thinking { align-self: flex-start; max-width: 78%; font-size: var(--fs-small); color: var(--muted); font-style: italic; padding: 4px 12px; border-left: 2px solid var(--line); white-space: pre-wrap; word-break: break-word; }
.chat-thinking::before { content: '💭 '; font-style: normal; }
.chat-msg.assistant.streaming::after { content: '▍'; color: var(--c-orange); animation: chat-blink 1s steps(2) infinite; }
@keyframes chat-blink { to { opacity: 0; } }
.chat-plan.pending .row button { opacity: .55; cursor: default; }
.chat-atts { display: flex; gap: 6px; flex-wrap: wrap; }
.chat-att-chip { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-micro); color: var(--muted); padding: 3px 9px; border: 1px solid var(--line); border-radius: 999px; background: var(--card); max-width: 240px; }
.chat-att-chip .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-ref { align-self: flex-start; display: flex; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); cursor: pointer; max-width: 78%; transition: border-color .12s; }
.chat-ref:hover { border-color: var(--c-dim); }
.chat-ref .t { font-size: var(--fs-sub); color: var(--body); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-ref .id { font-size: var(--fs-micro); color: var(--muted); font-family: var(--font-mono); }
.chat-ref .follow { font-size: var(--fs-micro); flex-shrink: 0; }
.chat-plan { border: 1px solid var(--line); border-left: 4px solid var(--c-orange); border-radius: 10px; background: var(--card); padding: 14px; }
.chat-plan h3 { margin: 0 0 6px; font-size: 15px; }
.chat-plan .summary { margin: 0 0 8px; font-size: var(--fs-sub); opacity: .85; }
.chat-plan .brief { margin: 0 0 8px; font-size: var(--fs-sub); white-space: pre-wrap; word-break: break-word; opacity: .75; }
.chat-plan .landing { margin: 0 0 12px; font-size: var(--fs-small); opacity: .85; }
.chat-plan .landing .sess { font-weight: 600; }
.chat-plan .landing .note { opacity: .75; margin-left: 6px; }
.chat-plan .row { display: flex; gap: 10px; }
.chat-auto { display: flex; align-items: center; gap: 6px; font-size: var(--fs-small); color: var(--muted); margin: 0 0 10px; cursor: pointer; }
.chat-tray { display: flex; gap: 6px; flex-wrap: wrap; }
.chat-tray:empty { display: none; }
.chat-input { display: flex; gap: 10px; align-items: flex-end; }
.chat-voice-slot { display: contents; }
.chat-call-slot { display: contents; }
.chat-input textarea { flex: 1; resize: none; min-height: 44px; max-height: 160px; padding: 11px 14px;
  border: 1px solid var(--line); border-radius: 12px; background: var(--card); color: var(--ink);
  font: inherit; line-height: 1.6; field-sizing: content; }
.chat-input textarea:focus { border-color: var(--c-orange); box-shadow: var(--ring); outline: none; }
`;

// 空线程空态（初始模板/新对话/清空三处同源）。
const EMPTY_HTML = `
        <div class="chat-empty" id="c-empty">
          <span class="lead">有什么要办的？</span>
          说一句话，juli 问清楚后给你一张单子卡——确认才开单。
        </div>`;

// conv 分线程：实现收编进 chat-transcript.ts（同 transcript，2026-10-27）——
// 通话后台轮次与视图必须发同一线程，切回 /chat 才看得到期间发生了什么。

export const chatView = async (el: HTMLElement): Promise<(() => void) | void> => {
  let plan: IntakePlan | null = null;
  let busy = false;
  let pendingAtts: PendingAttach[] = [];
  // transcript 在模板前就绪（头部「清空」按钮按有无历史显隐）。
  let transcript: TsMsg[] = loadTranscript();
  const persist = (): void => {
    transcript = transcript.slice(-TS_LIMIT);
    saveTranscript(transcript);
  };

  el.innerHTML = `
    <style>${CHAT_CSS}</style>
    <div class="chat-wrap">
      <div class="chat-head">
        <h1>发单</h1>
        <p class="sub">说一句话，juli 问清楚后给你一张单子卡——确认才开单。</p>
        <button class="mini ghost" id="c-new" title="换一条全新对话线程（服务端上下文重开；旧线程按容量自然过期）">新对话</button>${transcript.length > 0 ? '<button class="mini ghost" id="c-clear" title="清空本浏览器的历史记录（服务端与其它设备不受影响）">清空</button>' : ''}
        <span id="c-call" class="chat-call-slot"></span>
      </div>
      <div class="chat-thread" id="c-thread">${EMPTY_HTML}
      </div>
      <div id="c-plan"></div>
      <div class="chat-tray" id="c-tray"></div>
      <div class="chat-input">
        <span class="chat-voice-slot" id="c-voice"></span>
        <button class="btn" id="c-attach" title="附件（≤5 件，每件 ≤10MB）">📎</button>
        <input type="file" id="c-file" multiple hidden
          accept=".png,.jpg,.jpeg,.gif,.webp,.heic,.pdf,.txt,.md,.json,.csv,.docx,.xlsx,.pptx,.zip" />
        <textarea id="c-input" rows="1" placeholder="例：给 Casey 出一份齿轮产线的介绍材料，周四上门要用"></textarea>
        <button class="btn-primary" id="c-send">发送</button>
      </div>
      <span class="muted" id="c-status"></span>
    </div>`;

  const thread = el.querySelector('#c-thread') as HTMLElement;
  const planSlot = el.querySelector('#c-plan') as HTMLElement;
  const input = el.querySelector('#c-input') as HTMLTextAreaElement;
  const send = el.querySelector('#c-send') as HTMLButtonElement;
  // 模板无条件渲染（同 send；条件渲染的只有 #c-clear），故走 as 断言惯例。
  const newChatBtn = el.querySelector('#c-new') as HTMLButtonElement;
  const status = el.querySelector('#c-status') as HTMLElement;
  const attachBtn = el.querySelector('#c-attach') as HTMLButtonElement;
  const fileInput = el.querySelector('#c-file') as HTMLInputElement;
  const tray = el.querySelector('#c-tray') as HTMLElement;

  // 语音输入（2026-10-21）：按住说话→松手成稿→直接作为一轮进件（voice-first；
  // 回合在途时只落 composer 不抢发，fire 的 busy 守卫同口径）。会话与通话本体
  // 都是页面级单例（2026-10-27 通话后台保持，缺陷单 wf_efccc6271097）：切页只
  // 拆 UI/接线，麦克风与 WS 不断——通话进行中切页照常聆听/进件/朗读，回到本页
  // transcript 回放补齐期间轮次；全局 pill（main.ts 挂载）接管切页后的可见面。
  const voiceSession = getSharedVoiceSession();
  const call = getVoiceCall();
  const voiceSlot = el.querySelector('#c-voice') as HTMLElement;
  const voiceInputCbs = {
    onLive: (t: string) => { status.textContent = t; },
    onFinal: (t: string) => {
      input.value = t;
      if (!busy) void fire();
    },
  };
  let voiceCleanup: (() => void) = () => {};
  const remountVoiceInput = (): void => {
    voiceCleanup();
    if (call.active()) { voiceSlot.style.display = 'none'; return; } // 通话中不挂 PTT：mountVoiceInput 即抢 session 路由，会把转写从通话侧夺走
    voiceSlot.style.display = '';
    voiceCleanup = mountVoiceInput(voiceSlot, voiceInputCbs, voiceSession);
  };
  remountVoiceInput();

  // 通话开单（2026-10-21 用户裁定）：连续聆听，轮次/思考/工具照常异步流式
  // （chat-live），回复朗读（speechSynthesis），计划卡在场说「确认」即开单。
  let callActive = call.active(); // 通话中重进本页：朗读接线立即接上
  const maybeSpeak = (text: string): void => {
    if (callActive) call.speak(speechText(text));
  };
  call.setViewHandlers({
    onUserText: (t) => {
      if (t === '') return;
      // 计划卡在场：纯确认/纯否决短句走语音裁决（仍走 confirmPlan 正门）；
      // 其余（含长句里的「确认」）一律当修订轮次——误开单的代价远大于多说一轮。
      if (plan !== null && !busy) {
        const intent = classifyConfirmUtterance(t);
        if (intent === 'confirm') {
          appendMsg('sys', `📞 语音确认：「${t}」`);
          void confirmPlan();
          return;
        }
        if (intent === 'deny') {
          appendMsg('sys', `📞 语音取消：「${t}」`);
          void denyPlan();
          return;
        }
      }
      input.value = t;
      if (!busy) void fire();
    },
    onNote: (t) => { status.textContent = t; },
    onActiveChange: (active) => {
      callActive = active;
      if (active) { voiceCleanup(); voiceSlot.style.display = 'none'; renderPlan(); } // 通话接管会话路由；计划卡补通话提示
      else remountVoiceInput(); // 挂断后输入按钮接管回路由
    },
  });
  const voiceCall = mountVoiceCallUI(el.querySelector('#c-call') as HTMLElement, call);

  // 消息流锚定最底（0930 用户裁决；10-06 起线程是滚动容器，锚底真正生效）。
  const scrollBottom = (): void => {
    thread.scrollTop = thread.scrollHeight;
  };

  const attachChip = (name: string, mime: string): string =>
    `<span class="chat-att-chip" title="${esc(name)}">${mime.startsWith('image/') ? '🖼' : '📄'}<span class="nm">${esc(name)}</span></span>`;

  /** 单子引用卡：拉 tree 端点取标题/状态（60s TTL+in-flight 缓存），点卡深链
   * 流水详情，➕跟进预填。 */
  const refCard = (id: string): HTMLElement => {
    const card = document.createElement('div');
    card.className = 'chat-ref';
    card.innerHTML = `<span class="id">${esc(id)}</span><span class="t">读取中…</span>`;
    card.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('.follow') !== null) return;
      location.hash = `/lifecycle?w=${id}`;
    });
    const fill = (title: string, status: string): void => {
      card.innerHTML = `<span class="t">${esc(title)}</span>${statusChip(status)}<span class="id">${esc(id)}</span><button class="follow mini ghost">➕ 跟进</button>`;
      (card.querySelector('.follow') as HTMLButtonElement).addEventListener('click', (ev) => {
        ev.stopPropagation();
        input.value = `跟进单 ${id}（${title}）：请基于该单的上下文继续迭代优化——`;
        input.focus();
      });
    };
    void refFetch(id).then((v) => fill(v.title, v.status))
      .catch(() => { card.innerHTML = `<span class="t">单子 ${esc(id)}（读取失败）</span>`; });
    return card;
  };

  /** 纯渲染（不落档）——历史恢复复用；appendMsg 才写穿透。assistant 气泡走
   * Markdown 渲染（renderMd：先转义后生成，原文不进 innerHTML）。 */
  const renderMsg = (role: 'user' | 'assistant' | 'sys', text: string, atts?: readonly { name: string; mime: string }[]): void => {
    el.querySelector('#c-empty')?.remove();
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-direction:column;gap:6px;align-items:inherit';
    const div = document.createElement('div');
    div.className = `chat-msg ${role}${role === 'assistant' ? ' chat-md' : ''}`;
    if (role === 'assistant') div.innerHTML = renderMd(text);
    else div.textContent = text;
    row.appendChild(div);
    // 附件芯片（用户气泡下）与单子引用卡（iOS WorkflowRefCard 同语义）。
    if (atts !== undefined && atts.length > 0) {
      const box = document.createElement('div');
      box.className = 'chat-atts';
      box.innerHTML = atts.map((a) => attachChip(a.name, a.mime)).join('');
      row.appendChild(box);
    }
    for (const id of wfRefs(text)) {
      if (role === 'sys') break;
      row.appendChild(refCard(id));
    }
    thread.appendChild(row);
    scrollBottom();
  };

  const appendMsg = (role: 'user' | 'assistant' | 'sys', text: string, atts?: readonly { name: string; mime: string }[]): void => {
    renderMsg(role, text, atts);
    transcript.push({ role, text, at: new Date().toISOString(), ...(atts !== undefined && atts.length > 0 ? { atts } : {}) });
    persist();
  };

  // 后台轮次回放（2026-10-27 通话后台保持）：通话切页期间的轮次由核心后台
  // 执行器写穿透，本视图在场时收到通知就整线重放——transcript 是唯一事实源，
  // 重放幂等，不做增量拼接（增量=与 WS 流式渲染双重渲染的重复气泡风险）。
  // busy 在途时不打断本回合，标脏到回合收尾再放。
  let externalDirty = false;
  const replayThread = (): void => {
    transcript = loadTranscript();
    thread.innerHTML = EMPTY_HTML;
    thinkingRow = null;
    stream = null;
    lastFinal = null;
    for (const m of transcript) renderMsg(m.role, m.text, m.atts);
  };
  call.setOnExternalTranscript(() => {
    if (busy) { externalDirty = true; return; }
    replayThread();
  });

  const renderPlan = (): void => {
    planSlot.innerHTML = '';
    if (!plan) return;
    const card = document.createElement('div');
    card.className = 'chat-plan';
    card.innerHTML = `
      <h3>${esc(plan.title)}</h3>
      <p class="summary">${esc(plan.summary)}</p>
      <p class="brief">${esc(plan.brief)}</p>
      ${plan.landing && plan.landing.session
        ? `<p class="landing">落点：<span class="sess">${esc(plan.landing.session)}</span>${plan.landing.note ? `<span class="note">${esc(plan.landing.note)}</span>` : ''}</p>`
        : ''}
      ${callActive ? '<p class="landing">📞 通话中：说「确认」开单，说「取消」放弃（点按钮也行）</p>' : ''}
      <label class="chat-auto" title="这一单里申报为 apply / artifact 的审批由 juli 自动批准（by=juli-auto，账本留痕）；发送审批和问询仍会等你">
        <input type="checkbox" id="c-autoap" /> 本单免批（发送审批和问询仍会等我）
      </label>
      <div class="row">
        <button class="btn-primary" id="c-confirm">开单</button>
        <button class="btn" id="c-deny">取消</button>
      </div>`;
    planSlot.appendChild(card);
    (card.querySelector('#c-confirm') as HTMLButtonElement).addEventListener('click', () => void confirmPlan());
    (card.querySelector('#c-deny') as HTMLButtonElement).addEventListener('click', () => void denyPlan());
    scrollBottom();
  };

  /** 工具活动行：只读白名单查询的透明化（不渲染参数与结果原文）。 */
  const renderToolLine = (name: string): void => {
    const line = document.createElement('span');
    line.className = 'chat-tool';
    line.textContent = `🔧 查询 ${name}`;
    el.querySelector('#c-empty')?.remove();
    thread.appendChild(line);
    scrollBottom();
  };

  /** POST 回包整包渲染（WS 帧没到时的兜底路径；帧到过的操作不走这里）。 */
  const applyEvents = (events: readonly IntakeEvent[]): void => {
    for (const e of events) {
      if (e.type === 'chat:plan') {
        try {
          plan = JSON.parse(e.data) as IntakePlan;
        } catch { plan = null; }
      } else if (e.type === 'chat:phase') {
        if (e.data !== 'proposed') plan = null;
      } else if (e.type === 'chat:system') {
        appendMsg('sys', e.data);
      } else if (e.type === 'chat:error') {
        appendMsg('sys', `⚠ ${e.data}`);
      } else if (e.type === 'tool_call') {
        renderToolLine(toolNameOf(e.data));
      } else if (e.type === 'chat:dispatched') {
        thread.appendChild(refCard(e.data));
        scrollBottom();
      }
    }
    renderPlan();
  };

  // ---- call 效果：/ws/chat 帧流实时执行 ------------------------------------------
  // 判定（流式合并/剥围栏/去重标记）在 chat-live.ts；这里只把 LiveOp 落到 DOM。

  const live = createLiveChat();
  let liveWs: WebSocket | null = null;
  let liveAttempt = 0;
  let liveTimer = 0;
  let disposed = false;
  let thinkingRow: HTMLElement | null = null;
  /** 流式中的 assistant 气泡（done 后定稿：Markdown 重绘 + 落档）。 */
  let stream: { row: HTMLElement; div: HTMLElement; text: string } | null = null;
  /** 最近定稿的 assistant 气泡 + 其 transcript 下标（POST 回包校正终稿用）。 */
  let lastFinal: { div: HTMLElement; tsIndex: number } | null = null;
  /** 最近一张经 dispatched 帧渲染的开单回执卡 id（confirmPlan 兜底去重用）。 */
  let dispatchedId: string | null = null;

  /** 定稿流式气泡：Markdown 重绘+落档；返回定稿文本（空=没有流式气泡）。 */
  const finalizeStream = (): string => {
    if (stream === null) return '';
    const s = stream;
    stream = null;
    s.div.classList.remove('streaming');
    s.div.classList.add('chat-md');
    s.div.innerHTML = renderMd(s.text);
    for (const id of wfRefs(s.text)) s.row.appendChild(refCard(id));
    transcript.push({ role: 'assistant', text: s.text, at: new Date().toISOString() });
    persist();
    lastFinal = { div: s.div, tsIndex: transcript.length - 1 };
    scrollBottom();
    return s.text;
  };

  const applyLive = (op: LiveOp): void => {
    switch (op.kind) {
      case 'thinking': {
        if (thinkingRow === null) {
          el.querySelector('#c-empty')?.remove();
          thinkingRow = document.createElement('div');
          thinkingRow.className = 'chat-thinking';
          thread.appendChild(thinkingRow);
        }
        // 思考可长达数千字：只滚尾部，整段留给服务端账本
        thinkingRow.textContent = op.text.length > 240 ? `…${op.text.slice(-240)}` : op.text;
        if (busy) status.textContent = '💭 思考中…';
        scrollBottom();
        break;
      }
      case 'assistant_chunk': {
        thinkingRow?.remove();
        thinkingRow = null;
        if (op.fresh || stream === null) {
          el.querySelector('#c-empty')?.remove();
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;flex-direction:column;gap:6px;align-items:inherit';
          const div = document.createElement('div');
          div.className = 'chat-msg assistant streaming';
          div.textContent = op.text;
          row.appendChild(div);
          thread.appendChild(row);
          stream = { row, div, text: op.text };
        } else {
          stream.text += op.text;
          stream.div.textContent = stream.text;
        }
        if (busy) status.textContent = '回复中…';
        scrollBottom();
        break;
      }
      case 'turn_done': {
        thinkingRow?.remove();
        thinkingRow = null;
        maybeSpeak(finalizeStream());
        break;
      }
      case 'tool':
        renderToolLine(op.name);
        if (busy) status.textContent = `🔧 查询 ${op.name}…`;
        break;
      case 'plan':
        if (op.plan === null) {
          appendMsg('sys', '⚠ 计划卡数据变形（服务端帧 JSON 解析失败）——再发一轮触发重提议');
          break;
        }
        plan = op.plan;
        renderPlan();
        break;
      case 'phase':
        if (op.phase !== 'proposed') { plan = null; renderPlan(); }
        break;
      case 'system':
        appendMsg('sys', op.text);
        break;
      case 'error':
        thinkingRow?.remove();
        thinkingRow = null;
        finalizeStream();
        appendMsg('sys', `⚠ ${op.text}`);
        break;
      case 'dispatched':
        plan = null;
        renderPlan();
        dispatchedId = op.id; // 回执卡已由帧渲染（confirmPlan 回包兜底据此去重）
        thread.appendChild(refCard(op.id));
        scrollBottom();
        if (callActive) call.speak('已开单。');
        break;
    }
  };

  /** 终稿校正：服务端 reply 是剥净围栏的权威文本——chunk 边界切断围栏/漏帧
   * 时以它为准（DOM + transcript 同步）。 */
  const healAssistant = (reply: string): void => {
    if (reply === '') return;
    if (lastFinal === null) { appendMsg('assistant', reply); return; }
    const entry = transcript[lastFinal.tsIndex];
    if (entry !== undefined && entry.role === 'assistant' && entry.text === reply) return;
    lastFinal.div.innerHTML = renderMd(reply);
    if (entry !== undefined && entry.role === 'assistant') {
      transcript[lastFinal.tsIndex] = { ...entry, text: reply };
      persist();
    }
  };

  const connectLive = (): void => {
    if (disposed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(chatWsUrl(proto, location.host, convId(), getToken()));
    liveWs = sock;
    sock.onopen = () => { if (liveWs === sock) liveAttempt = 0; };
    sock.onmessage = (m: MessageEvent<string>) => {
      if (liveWs !== sock || disposed) return;
      try {
        for (const op of live.handle(JSON.parse(m.data) as { type: string; data?: string })) applyLive(op);
      } catch { /* 非 JSON 帧丢弃 */ }
    };
    sock.onclose = () => {
      if (liveWs !== sock) return;
      liveWs = null;
      // done 帧无缓冲无回放：掉线即定稿流式中的气泡（iOS handleDisconnect 同款）
      for (const op of live.disconnected()) applyLive(op);
      if (disposed) return;
      liveTimer = window.setTimeout(connectLive, chatReconnectDelayMs(liveAttempt++));
    };
  };
  const reconnectLive = (): void => {
    window.clearTimeout(liveTimer);
    const s = liveWs;
    liveWs = null;
    try { s?.close(); } catch { /* 未连 */ }
    liveAttempt = 0;
    connectLive();
  };
  connectLive();

  // ---- 附件托盘 ---------------------------------------------------------------

  const renderTray = (): void => {
    tray.innerHTML = pendingAtts.map((a, i) =>
      `<span class="chat-att-chip" title="${esc(a.name)} · ${(a.bytes / 1024).toFixed(0)}KB">${a.mime.startsWith('image/') ? '🖼' : '📄'}<span class="nm">${esc(a.name)}</span><button data-rm="${i}" title="移除" style="border:none;background:none;color:var(--muted);cursor:pointer;padding:0 0 0 2px">✕</button></span>`).join('');
    for (const b of tray.querySelectorAll<HTMLButtonElement>('button[data-rm]')) {
      b.addEventListener('click', () => {
        pendingAtts = pendingAtts.filter((_, i) => i !== Number(b.dataset.rm));
        renderTray();
      });
    }
  };

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    for (const f of fileInput.files ?? []) {
      if (pendingAtts.length >= ATTACH_MAX_COUNT) { status.textContent = `附件最多 ${ATTACH_MAX_COUNT} 件`; break; }
      const dot = f.name.lastIndexOf('.');
      const ext = dot >= 0 ? f.name.slice(dot).toLowerCase() : '';
      if (ext === '' || !ATTACH_EXTS.has(ext)) { status.textContent = `不支持的类型 ${ext || '(无后缀)'}——图片/pdf/文档/表格/zip 可以`; continue; }
      if (f.size > ATTACH_MAX_BYTES) { status.textContent = `「${f.name}」超过 10MB，未添加`; continue; }
      pendingAtts = [...pendingAtts, { name: f.name, mime: f.type || 'application/octet-stream', bytes: f.size, file: f }];
      status.textContent = '';
    }
    fileInput.value = '';
    renderTray();
  });

  /** 逐件上传（multipart，服务端权威校验在 POST /api/chat/attachment）。 */
  const uploadAttach = async (a: PendingAttach): Promise<AttachRef> => {
    const fd = new FormData();
    fd.append('file', a.file, a.name);
    const res = await fetch('/api/chat/attachment', {
      method: 'POST',
      headers: getToken() !== '' ? { authorization: `Bearer ${getToken()}` } : {},
      body: fd,
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(d?.error ?? `http ${res.status}`);
    }
    return await res.json() as AttachRef;
  };

  const fire = async (): Promise<void> => {
    const text = input.value.trim();
    if ((text === '' && pendingAtts.length === 0) || busy) return;
    busy = true;
    send.disabled = true; // 在途禁用（UX 纪律）
    newChatBtn.disabled = true; // 同禁：busy 守卫是静默 no-op，反馈只能靠按钮态（R3）
    const outAtts = pendingAtts;
    status.textContent = outAtts.length > 0 ? '上传附件…' : '开单助手思考中…';
    if (text !== '') appendMsg('user', text, outAtts);
    input.value = '';
    pendingAtts = [];
    renderTray();
    try {
      let refs: AttachRef[] = [];
      for (const a of outAtts) refs = [...refs, await uploadAttach(a)];
      status.textContent = '开单助手思考中…';
      live.beginOp(); // 自此到的帧=本回合的实时渲染
      lastFinal = null; // 校正只认本回合定稿的气泡，不许改写上一轮
      const r = await api.post<TurnResponse>(`/api/chat/intake/turn?conv=${convId()}`, {
        input: text === '' ? '[附件]' : text,
        ...(refs.length > 0 ? { attachments: refs } : {}),
      });
      if (live.liveSeen()) {
        // WS 已边到边渲染：只做收口与校正，不重渲染（去重）
        if (!live.sawDone()) for (const op of live.handle({ type: 'done' })) applyLive(op);
        healAssistant(r.reply);
        // 计划卡帧若漏（done 无缓冲、帧序竞态）以回包补——卡是开单入口，不能少
        if (plan === null) {
          const pe = r.events.find((e) => e.type === 'chat:plan');
          if (pe !== undefined) applyEvents([pe, { type: 'chat:phase', data: 'proposed' }]);
        }
        // 已知残差（chat-live 同披露）：endOp 后才迟到的 WS chunk 会以新气泡
        // 落地成碎片——双连接乱序的极窄时序，transcript 重载后自愈。
      } else {
        if (r.reply !== '') {
          appendMsg('assistant', r.reply);
          maybeSpeak(r.reply);
        }
        applyEvents(r.events);
      }
      status.textContent = '';
    } catch (e) {
      status.textContent = `发送失败：${e instanceof Error ? e.message : String(e)}`;
      // 上传失败件回托盘不丢（已成功的件下次重传，服务端按 id 前缀幂等落盘）。
      pendingAtts = [...outAtts, ...pendingAtts].slice(0, ATTACH_MAX_COUNT);
      renderTray();
    }
    live.endOp();
    busy = false;
    send.disabled = false;
    newChatBtn.disabled = false;
    if (externalDirty) { externalDirty = false; replayThread(); } // 在途期间后台轮次落档了：收尾重放补齐
  };

  // 异步开单（2026-10-21 call 效果）：不跳页。卡片原位「开单中…」，回执
  // （dispatched/system 帧或回包）到了换成系统行 + 单子卡，对话继续——
  // 深链流水页的入口就是那张卡。
  const confirmPlan = async (): Promise<void> => {
    if (!plan || busy) return;
    busy = true;
    newChatBtn.disabled = true; // 同 fire：在途守卫静默，禁用即反馈
    status.textContent = '开单中…';
    const card = planSlot.querySelector<HTMLElement>('.chat-plan');
    card?.classList.add('pending');
    for (const b of card?.querySelectorAll('button') ?? []) b.disabled = true;
    const confirmBtn = card?.querySelector<HTMLButtonElement>('#c-confirm') ?? null;
    if (confirmBtn !== null) confirmBtn.textContent = '开单中…';
    live.beginOp();
    try {
      const autoAp = planSlot.querySelector<HTMLInputElement>('#c-autoap')?.checked === true;
      const r = await api.post<{ events: readonly IntakeEvent[]; runId: string | null }>(`/api/chat/intake/confirm?conv=${convId()}`, {
        auto_approve: autoAp,
      });
      if (!live.liveSeen()) applyEvents(r.events);
      else if (r.runId !== null && dispatchedId !== r.runId) {
        // liveSeen 但 dispatched 帧丢了：回包补卡（与 fire 的 plan 卡兜底同款
        // 「卡是开单入口，不能少」）；帧确实到过则 dispatchedId === r.runId 不重卡。
        thread.appendChild(refCard(r.runId));
        scrollBottom();
      }
      if (r.runId) {
        status.textContent = `✓ 已开单 ${r.runId}`;
        if (plan !== null) { plan = null; renderPlan(); } // 帧漏了也不留一张「开单中」的死卡
      } else {
        status.textContent = '开单失败，请重试或继续对话';
        renderPlan(); // 恢复可点
      }
    } catch (e) {
      status.textContent = `开单失败：${e instanceof Error ? e.message : String(e)}`;
      renderPlan();
    }
    live.endOp();
    busy = false;
    newChatBtn.disabled = false;
    if (externalDirty) { externalDirty = false; replayThread(); }
  };

  const denyPlan = async (): Promise<void> => {
    if (busy) return;
    live.beginOp();
    try {
      const r = await api.post<{ events: readonly IntakeEvent[] }>(`/api/chat/intake/deny?conv=${convId()}`);
      if (!live.liveSeen()) applyEvents(r.events);
    } catch { /* 回到讨论态失败也不阻塞继续对话 */ }
    live.endOp();
  };

  send.addEventListener('click', () => void fire());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void fire(); }
  });

  // 主页发单快入的草稿（js-261006-s0msv9 追加）：#/chat?draft=… 预填聚焦。
  const draft = new URLSearchParams(location.hash.split('?')[1] ?? '').get('draft') ?? '';
  if (draft !== '') input.value = draft;
  input.focus();

  // 历史恢复（2026-10-07 用户实报「chat 不记录历史」）：本地 transcript
  // 写穿透，重进/刷新即回放——与 iOS restoreTranscript 同语义。
  for (const m of transcript) renderMsg(m.role, m.text, m.atts);

  // conv 分线程（2026-10-17）：「新对话」=换 conv id（服务端线程+本地回显双清）。
  newChatBtn.addEventListener('click', () => {
    if (busy) return; // 回合在途禁换线程：在途请求的 conv 已定格，清空后旧响应会血染新线程（R1-F3）
    resetConversation(); // conv id 与本地档同源收口（通话后台轮次同走新线程）
    transcript = [];
    thread.innerHTML = EMPTY_HTML;
    plan = null;
    planSlot.innerHTML = '';
    status.textContent = '';
    thinkingRow = null;
    stream = null;
    lastFinal = null;
    call.syncPlanPending(false); // 旧线程的计划相位随线程作废
    el.querySelector('#c-clear')?.remove();
    reconnectLive(); // 帧流按 conv 过滤：换线程=换订阅
  });
  const clearBtn = el.querySelector<HTMLButtonElement>('#c-clear');
  if (clearBtn !== null) {
    clearBtn.addEventListener('click', () => {
      if (!window.confirm('清空本浏览器的对话历史？（服务端与其它设备不受影响）')) return;
      transcript = [];
      saveTranscript(transcript);
      clearBtn.remove();
      thread.innerHTML = EMPTY_HTML;
      // 引用随 DOM 一起清（照 newChat 三行，R1 P1#3）：lastFinal 残留会让下一
      // 回合的 healAssistant 改写已脱离文档的旧气泡——屏上无泡、落档也跳过。
      thinkingRow = null;
      stream = null;
      lastFinal = null;
    });
  }

  // 重连恢复：暂存中的计划卡不丢（transcript 是 UI 态，丢了可接受）。
  try {
    const s = await api.get<StateResponse>(`/api/chat/intake/state?conv=${convId()}`);
    if (s.plan) { plan = s.plan; renderPlan(); }
  } catch { /* 未配置 LLM 时端点 503——视图保持空线程 */ }
  call.syncPlanPending(plan !== null); // 相位投影交核心：本页切走后语音确认裁决要用

  // 清理口（帧流 WS + 视图接线）：#/chat 页由 main.ts 路由切换时调用，抽屉
  // 形态由 orderfab 关闭时调用。通话本体/会话/朗读都不在此收口（2026-10-27
  // 后台保持：生命周期=页面，缺陷单 wf_efccc6271097）——切页只拆视图面，
  // 通话照常聆听/进件/朗读，轮次由核心后台执行器接管。
  return () => {
    disposed = true;
    window.clearTimeout(liveTimer);
    const s = liveWs;
    liveWs = null;
    try { s?.close(); } catch { /* 未连 */ }
    voiceCall(); // 横幅/按钮 DOM 随视图退场（返回的 detach 口，不动通话）
    voiceCleanup(); // PTT 拆（通话中本就不在场，幂等）
    call.syncPlanPending(plan !== null); // 相位投影随切页移交
    call.setViewHandlers(null); // 轮次回落后台执行器
    call.setOnExternalTranscript(null);
  };
};
