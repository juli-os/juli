// 会话（板 04 · 2026-09-29 用户裁定重做）：会话页=交互终端本体——选中即
// 直连（xterm WS attach），无截屏代理视图、无独立发送条；左边会话列表，
// 右边终端吃满视口（main.fullbleed 见 style.css）。形态对齐旧 Makro 的
// terminal tabs：FitAddon 缺席则手写 fit 数学，ResizeObserver 跟随容器，
// Cmd/Ctrl+C 复制选中、+V 粘贴进会话。
// 断线语义（2026-09-20 裁决沿用）：政策性关闭（1008 绑定会话/1011/1000）
// 停止重连显原因；只有网络断线才指数退避重连。

import { api } from '../api.ts';
import { esc } from './dashboard.ts';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

export const sessionsView = async (el: HTMLElement): Promise<(() => void) | void> => {
  el.innerHTML = `
    <div class="split ss-split">
      <aside id="ss-list" class="split-side">
        <div class="ss-list-head">会话</div>
        <div id="ss-items"><p class="muted">加载中…</p></div>
        <div class="ss-new">
          <input id="new-name" placeholder="新会话名" />
          <button class="mini" id="new">新建</button>
        </div>
      </aside>
      <section class="split-main" id="ss-term">
        <div class="ss-term-bar">
          <span class="ss-term-name" id="ss-term-name">未选中会话</span>
          <span class="ss-term-st" id="ss-term-st"></span>
          <span class="ss-term-hint">⌘C 复制选中 · ⌘V 粘贴</span>
        </div>
        <div class="ss-term-mount" id="term-mount"><p class="muted" style="padding:18px">← 从左侧选择一个会话，终端在这里直接展开。</p></div>
      </section>
    </div>`;

  const items = el.querySelector('#ss-items') as HTMLElement;
  const mount = el.querySelector('#term-mount') as HTMLElement;
  const nameEl = el.querySelector('#ss-term-name') as HTMLElement;
  const stEl = el.querySelector('#ss-term-st') as HTMLElement;

  // ---- 终端生命周期（一次一个；换会话/离开页面即整体收口） ----------------
  let current = '';
  let term: Terminal | null = null;
  let ws: WebSocket | null = null;
  let ro: ResizeObserver | null = null;
  let termGen = 0;              // 代际：切会话/重开时使旧 socket 的重连计划失效
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (t: string, cls = ''): void => {
    stEl.textContent = t === '' ? '' : `· ${t}`;
    stEl.className = `ss-term-st ${cls}`;
  };

  /** fit 数学（FitAddon 缺席的手写版）：字号→单元宽高→容器尺寸取整。
   * 上限/下限对齐 hub 的合法窗（cols 20–400 / rows 10–200）。 */
  const fitOf = (fontSize: number): { cols: number; rows: number } => {
    const charW = fontSize * 0.6;
    const charH = fontSize * 1.35;
    const cols = Math.max(40, Math.min(200, Math.floor((mount.clientWidth || 800) / charW)));
    const rows = Math.max(12, Math.min(120, Math.floor((mount.clientHeight || 480) / charH)));
    return { cols, rows };
  };

  const closeTerminal = (): void => {
    termGen++;
    ro?.disconnect();
    ro = null;
    ws?.close();
    ws = null;
    term?.dispose();
    term = null;
    mount.innerHTML = '';
  };

  /** 打开（或重开）current 的终端：xterm + WS 直连；代际防旧连接回写。 */
  const openTerminal = (): void => {
    if (current === '') return;
    closeTerminal();
    const gen = ++termGen;
    nameEl.textContent = current;
    const fontSize = window.innerWidth < 700 ? 10 : 13;
    const { cols, rows } = fitOf(fontSize);
    const t = new Terminal({
      cols, rows, fontSize, convertEol: false, cursorBlink: true, scrollback: 10000,
      fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Monaco, "PingFang SC", monospace',
      theme: { background: '#191713' },
    });
    term = t;
    mount.innerHTML = '';
    t.open(mount);
    t.focus();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = localStorage.getItem('juli_token') ?? '';
    let retries = 0;
    let everOpened = false;
    // 键入订阅只注册一次：onData 叠加监听是重连泄漏的老坑（P1-4），回调读
    // 当前 ws——换代后自然指向新 socket。
    t.onData((d) => { if (ws !== null && ws.readyState === ws.OPEN) ws.send(d); });
    const connect = (): void => {
      if (gen !== termGen) return;
      setStatus('连接中…');
      const sock = new WebSocket(`${proto}://${location.host}/ws/xterm/${encodeURIComponent(current)}?token=${encodeURIComponent(token)}`);
      ws = sock;
      sock.binaryType = 'arraybuffer';
      sock.onopen = () => {
        if (gen !== termGen) { sock.close(); return; }
        retries = 0;
        everOpened = true;
        setStatus('已连接', 'ok');
        const f = fitOf(fontSize);
        sock.send(JSON.stringify({ type: 'size', cols: f.cols, rows: f.rows }));
        t.focus();
      };
      // rAF 批写：agent 高速输出时逐帧落地，避免逐消息渲染打爆主线程。
      let pending: (Uint8Array | string)[] = [];
      let flushScheduled = false;
      const flush = (): void => {
        flushScheduled = false;
        if (pending.length === 0) return;
        const chunk = pending;
        pending = [];
        for (const c of chunk) t.write(c);
      };
      sock.onmessage = (m) => {
        pending.push(typeof m.data === 'string' ? m.data : new Uint8Array(m.data));
        if (!flushScheduled) { flushScheduled = true; requestAnimationFrame(flush); }
      };
      sock.onclose = (ev) => {
        if (gen !== termGen) return;
        // 政策性关闭（1008 绑定会话 / 1011 attach 失败 / 1000 pty 退出）带着
        // 原因——重试也不会通，停下来把话说清楚；只有异常断线才退避重连。
        if (ev.code === 1008 || ev.code === 1011 || ev.code === 1000) {
          const why = ev.reason && ev.reason.trim() !== '' ? ev.reason : '连接被服务端关闭';
          setStatus('已断开', 'bad');
          t.write(`\r\n\x1b[90m[${why}]\r\n`);
          return;
        }
        // 401（token 失效）在握手前拒连，表现为裸 close 1006——从未连上过且
        // 连续失败 ≥3 次即停（即连即断 3 次足以确诊）；连上过则照常退避重连。
        retries += 1;
        if (!everOpened && retries >= 3) {
          setStatus('连接失败', 'bad');
          t.write('\r\n\x1b[90m[连续 3 次连接失败（从未连上）——检查 token / 服务状态]\r\n');
          return;
        }
        const delay = Math.min(15000, 1200 * retries);
        setStatus(`断线 · ${Math.round(delay / 1000)}s 后重连`);
        t.write(`\r\n\x1b[90m[连接已关闭 · ${Math.round(delay / 1000)}s 后重连]\r\n`);
        setTimeout(connect, delay);
      };
    };
    connect();

    // 容器变化 → fit → cols 变化才发 size（hub 侧 cols 变才重建 PTY；rows-only
    // 绝不触发——键盘弹起/窗口微调狂刷重建是移动端卡死的老元凶）。防抖 300ms。
    ro = new ResizeObserver(() => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (term !== t || ws === null || ws.readyState !== ws.OPEN) return;
        const f = fitOf(fontSize);
        if (f.cols !== t.cols || f.rows !== t.rows) {
          t.resize(f.cols, f.rows);
          ws.send(JSON.stringify({ type: 'size', cols: f.cols, rows: f.rows }));
        }
      }, 300);
    });
    ro.observe(mount);

    // 剪贴板（Makro 同款）：复制=有选中才拦截（无选中时 ⌘C 是终端 Ctrl+C 的
    // 事情，不抢）；粘贴=读剪贴板整段进会话。
    mount.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'c' && t.hasSelection()) {
        e.preventDefault(); e.stopPropagation();
        void navigator.clipboard.writeText(t.getSelection()).catch(() => undefined);
      } else if (k === 'v') {
        e.preventDefault(); e.stopPropagation();
        void navigator.clipboard.readText().then((text) => {
          if (text !== '' && ws !== null && ws.readyState === ws.OPEN) ws.send(text);
        }).catch(() => undefined);
      }
    }, true);
  };

  // ---- 会话列表（5s 慢轮询：名单与 agent 标签；活性由终端连接本身表达） ----
  let listTimer: ReturnType<typeof setInterval> | null = null;
  // 深链聚焦的存活窗：列表轮询重建 innerHTML 冲掉高亮类——重绘后按名字回补。
  let focusName = '';
  let focusUntil = 0;
  const refocus = (): void => {
    if (focusName === '' || Date.now() > focusUntil) return;
    items.querySelector(`.ss-item[data-s="${CSS.escape(focusName)}"]`)?.classList.add('ss-focus');
  };

  const loadList = async (): Promise<void> => {
    // /api/sessions 现为 Go/iOS 形状裸对象数组（name/active/working/agent…）。
    const sessions = await api.get<{ name: string; agent: string }[]>('/api/sessions');
    items.innerHTML = sessions.length === 0
      ? '<p class="muted" style="padding:10px">无活动会话。</p>'
      : sessions.map((s) => `
        <div class="ss-item${s.name === current ? ' active' : ''}" data-s="${esc(s.name)}" role="link" tabindex="0">
          <div class="ss-name">${esc(s.name)}</div>
          <div class="ss-sub">${esc(s.agent !== '' ? s.agent : 'tmux')}</div>
        </div>`).join('');
    refocus();
    for (const item of items.querySelectorAll<HTMLElement>('.ss-item')) {
      item.addEventListener('click', () => {
        if (item.dataset.s === current) { term?.focus(); return; }
        current = item.dataset.s ?? '';
        for (const x of items.querySelectorAll('.ss-item')) x.classList.toggle('active', (x as HTMLElement).dataset.s === current);
        openTerminal();
      });
    }
  };

  (el.querySelector('#new') as HTMLButtonElement).addEventListener('click', async () => {
    const name = (el.querySelector('#new-name') as HTMLInputElement).value.trim();
    if (name === '') return;
    await api.post('/api/sessions', { name });
    current = '';
    await loadList();
    const item = items.querySelector<HTMLElement>(`.ss-item[data-s="${CSS.escape(name)}"]`);
    if (item) item.click();
  });

  listTimer = setInterval(() => { if (!document.hidden) void loadList(); }, 5000);
  await loadList();

  // 深链（实体锚点落点）：#/sessions?s=NAME 自动选中 + 滚动高亮——终端直开。
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const deep = q.get('s');
  if (deep) {
    const item = el.querySelector<HTMLElement>(`.ss-item[data-s="${CSS.escape(deep)}"]`);
    if (item) {
      item.click();
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      focusName = deep;
      focusUntil = Date.now() + 2600;
      item.classList.add('ss-focus');
      setTimeout(() => item.classList.remove('ss-focus'), 2600);
    }
  }
  return () => {
    if (listTimer) clearInterval(listTimer);
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    closeTerminal(); // 离开页面整体收口：ws 关、xterm dispose、observer 断
  };
};
