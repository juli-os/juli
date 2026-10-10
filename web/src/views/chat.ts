// 发单对话视图（09-29 定案）：#/trigger 表单的继任者。说一句话，开单助手
// clarify（白名单只读查询）到 target 清晰，亮 brief 预览卡，点「开单」走
// startTask 正门（POST /api/chat/intake/*，与旧表单同一契约）——创建动词
// 是人按按钮，机器只申报。提交后深链 #/lifecycle?w={id} 展开该单节点流
// （与表单时代同一落点）。v1 同步 JSON 往返（无 WS 流式）；语音输入是
// iOS 端的模态，web 端文本先行。
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

// ---- 本地 transcript（2026-10-07 用户实报「chat 不记录历史」；照 iOS
// chat-transcript.json 同语义：写穿透、500 条上限、含附件元数据；工具活动
// 行是过程帧不落档。服务端 chathub 环形 200 条只服务 WS 断线补帧——web 是
// 同步回合无断档，本地档即唯一历史源。 ----
const TS_KEY = 'juli_chat_transcript_v1';
const TS_LIMIT = 500;

interface TsMsg {
  readonly role: 'user' | 'assistant' | 'sys';
  readonly text: string;
  readonly at: string;
  readonly atts?: readonly { name: string; mime: string }[];
}

const loadTranscript = (): TsMsg[] => {
  try {
    const v = JSON.parse(localStorage.getItem(TS_KEY) ?? '[]') as TsMsg[];
    return Array.isArray(v) ? v.filter((m) => typeof m.text === 'string' && (m.role === 'user' || m.role === 'assistant' || m.role === 'sys')) : [];
  } catch { return []; }
};

const saveTranscript = (msgs: readonly TsMsg[]): void => {
  try {
    localStorage.setItem(TS_KEY, JSON.stringify(msgs.slice(-TS_LIMIT)));
  } catch { /* 隐私模式/配额——历史是增强不是地基，写失败不炸对话 */ }
};

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
.chat-input textarea { flex: 1; resize: none; min-height: 44px; max-height: 160px; padding: 11px 14px;
  border: 1px solid var(--line); border-radius: 12px; background: var(--card); color: var(--ink);
  font: inherit; line-height: 1.6; field-sizing: content; }
.chat-input textarea:focus { border-color: var(--c-orange); box-shadow: var(--ring); outline: none; }
`;

export const chatView = async (el: HTMLElement): Promise<void> => {
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
        ${transcript.length > 0 ? '<button class="mini ghost" id="c-clear" title="清空本浏览器的历史记录（服务端与其它设备不受影响）">清空</button>' : ''}
      </div>
      <div class="chat-thread" id="c-thread">
        <div class="chat-empty" id="c-empty">
          <span class="lead">有什么要办的？</span>
          说一句话，juli 问清楚后给你一张单子卡——确认才开单。
        </div>
      </div>
      <div id="c-plan"></div>
      <div class="chat-tray" id="c-tray"></div>
      <div class="chat-input">
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
  const status = el.querySelector('#c-status') as HTMLElement;
  const attachBtn = el.querySelector('#c-attach') as HTMLButtonElement;
  const fileInput = el.querySelector('#c-file') as HTMLInputElement;
  const tray = el.querySelector('#c-tray') as HTMLElement;

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
      <label class="chat-auto" title="这一单的非发送闸门由 juli 自动批准（by=juli-auto，账本留痕）；问询与外发邮件仍会等你">
        <input type="checkbox" id="c-autoap" /> 本单免批（外发邮件仍会等我）
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
        // 工具活动行：只读白名单查询的透明化（不渲染参数与结果原文）。
        const line = document.createElement('span');
        line.className = 'chat-tool';
        line.textContent = `🔧 查询 ${e.data}`;
        el.querySelector('#c-empty')?.remove();
        thread.appendChild(line);
        scrollBottom();
      }
    }
    renderPlan();
  };

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
      const r = await api.post<TurnResponse>('/api/chat/intake/turn', {
        input: text === '' ? '[附件]' : text,
        ...(refs.length > 0 ? { attachments: refs } : {}),
      });
      if (r.reply !== '') appendMsg('assistant', r.reply);
      applyEvents(r.events);
      status.textContent = '';
    } catch (e) {
      status.textContent = `发送失败：${e instanceof Error ? e.message : String(e)}`;
      // 上传失败件回托盘不丢（已成功的件下次重传，服务端按 id 前缀幂等落盘）。
      pendingAtts = [...outAtts, ...pendingAtts].slice(0, ATTACH_MAX_COUNT);
      renderTray();
    }
    busy = false;
    send.disabled = false;
  };

  const confirmPlan = async (): Promise<void> => {
    if (!plan || busy) return;
    busy = true;
    status.textContent = '开单中…';
    try {
      const autoAp = (planSlot.querySelector('#c-autoap') as HTMLInputElement | null)?.checked === true;
      const r = await api.post<{ events: readonly IntakeEvent[]; runId: string | null }>('/api/chat/intake/confirm', {
        auto_approve: autoAp,
      });
      applyEvents(r.events);
      if (r.runId) {
        status.textContent = `✓ 已开单 ${r.runId}`;
        location.hash = `/lifecycle?w=${r.runId}`; // 深链展开该单节点流
        return; // 页面即切走，收尾交给路由
      }
      status.textContent = '开单失败，请重试或继续对话';
    } catch (e) {
      status.textContent = `开单失败：${e instanceof Error ? e.message : String(e)}`;
    }
    busy = false;
  };

  const denyPlan = async (): Promise<void> => {
    if (busy) return;
    try {
      const r = await api.post<{ events: readonly IntakeEvent[] }>('/api/chat/intake/deny');
      applyEvents(r.events);
    } catch { /* 回到讨论态失败也不阻塞继续对话 */ }
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

  const clearBtn = el.querySelector('#c-clear') as HTMLButtonElement | null;
  if (clearBtn !== null) {
    clearBtn.addEventListener('click', () => {
      if (!window.confirm('清空本浏览器的对话历史？（服务端与其它设备不受影响）')) return;
      transcript = [];
      saveTranscript(transcript);
      clearBtn.remove();
      thread.innerHTML = `
        <div class="chat-empty" id="c-empty">
          <span class="lead">有什么要办的？</span>
          说一句话，juli 问清楚后给你一张单子卡——确认才开单。
        </div>`;
    });
  }

  // 重连恢复：暂存中的计划卡不丢（transcript 是 UI 态，丢了可接受）。
  try {
    const s = await api.get<StateResponse>('/api/chat/intake/state');
    if (s.plan) { plan = s.plan; renderPlan(); }
  } catch { /* 未配置 LLM 时端点 503——视图保持空线程 */ }
};
