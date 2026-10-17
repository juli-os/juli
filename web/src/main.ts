// juli-service Web 壳：hash 路由 + 视图挂载。每个视图是一个 (el) => 渲染
// 函数，返回可选的清理回调（SSE/定时器的关闭口）。

import { api, getToken, setToken } from './api.ts';
import { subscribeEvents } from './sse.ts';
import { topbar, sidebar, toast } from './ui.ts';
import { esc } from './esc.ts';
import { anchorHref } from './anchors.ts';
import { mountOrderDrawer } from './orderfab.ts';
import { TOAST_LEVELS, TOAST_TEXT } from './events-meta.ts';
// 视图路由表/默认页/兜底视图 + 手机门牌：单一事实源在各自注册表文件
// （开源投影以同形桩替换——公开视图子集与英文门牌）。
import { ROUTES, DEFAULT_ROUTE, FALLBACK_VIEW } from './views-registry.ts';
import { MOBILE_GATE_HTML } from './mgate.ts';

// Electron 壳桥：juli Service 桌面（window.juli）优先，旧 Makro 壳
// （window.makro）兼容——主进程持有密码，原生前端从不手输；纯浏览器
// 无桥，行为不变。
declare global {
  interface Window {
    readonly juli?: { getConnectionInfo(): Promise<{ password?: string }> };
    readonly makro?: { getConnectionInfo(): Promise<{ password?: string }> };
  }
}

const app = document.getElementById('app') as HTMLElement;
// 手机端 Web 弃用（2026-09-30 用户裁定：移动入口只剩 iOS App——手机浏览器
// 版体验不达标，不再投入）——≤768px 落「请用 App」门牌页：不注入导航、
// 不载 SPA、不连 SSE。桌面初始化整段跳过。
if (window.matchMedia('(max-width: 768px)').matches) {
  document.getElementById('topbar')!.innerHTML =
    '<span class="brand"><span class="brand-dot" aria-hidden="true"></span>juli-service</span>';
  app.innerHTML = MOBILE_GATE_HTML;
} else {
// 顶栏（存在感行）+ 左栏导航各注入一次（2026-10-07 左栏化：head-tab 退役）；
// 路由切换只切 #nav .active，SSE 连接态切 #conn。
// 默认首页 = 路由图（2026-10-07 用户裁决：按路由图的形式出版本——图=空间轴底座）。
const route0 = location.hash.replace(/^#/, '').split('?')[0] || DEFAULT_ROUTE;
document.getElementById('topbar')!.innerHTML = topbar(route0);
document.getElementById('sidebar')!.innerHTML = sidebar(route0);
// 常驻开单（2026-10-14）：左栏顶部主按钮 + 右侧抽屉（orderfab 自含开合）。
mountOrderDrawer();
// 移动端底部 tab 已随手机 Web 弃用拆除（2026-09-30；手机入口=iOS App）。
const tokenInput = document.getElementById('token') as HTMLInputElement;
tokenInput.value = getToken();
tokenInput.addEventListener('change', () => {
  setToken(tokenInput.value.trim());
  void render();
});

let cleanup: (() => void) | void;
// 代际计数（九跑 P1）：async view（如 routegraph 四路 fetch）await 期间切走，
// 晚返回的 view 若直接覆盖 cleanup，会把当前视图的清理口顶掉（SSE/定时器
// 泄漏到再切两次页）——过期返回的清理口立即自清理、即调即弃。
let renderGen = 0;

const render = async (): Promise<void> => {
  cleanup?.();
  const gen = ++renderGen;
  const hash = location.hash.replace(/^#/, '');
  const route = hash.split('?')[0] || DEFAULT_ROUTE;
  const view = ROUTES[route] ?? FALLBACK_VIEW;
  // 会话全屏（2026-09-29 用户裁定：会话是操作面，直接吃满视口）——壳层
  // 版心/边距按路由开关，其余视图版心不动。发单聊天面同理（js-261006-s0msv9）。
  app.classList.toggle('fullbleed', route === '/sessions');
  app.classList.toggle('chatfull', route === '/chat');
  // 常驻开单按钮在 /chat 整页形态下隐藏（页面即合成器，按钮冗余）。
  document.body.classList.toggle('on-chat', route === '/chat');
  // 单子聚焦（驾驶舱二期）：/order?w=ID 时隐左目录/费用面板，详情吃满；
  // 组高亮归属「流水」（order 是流水详情的 solo 形态，不是独立目的地）。
  const orderSolo = route === '/order' && (new URLSearchParams(hash.split('?')[1] ?? '').get('w') ?? '') !== '';
  app.classList.toggle('ordersolo', orderSolo);
  // 导航高亮归一（驾驶舱二期）：/order 是流水详情的 solo 形态 → 左栏点亮『流水』
  const navRoute = route === '/order' ? '/lifecycle' : route;
  for (const a of document.querySelectorAll('#nav a')) {
    a.classList.toggle('active', a.getAttribute('href') === `#${navRoute}`);
  }
  // 组名高亮跟随：当前路由落在哪个组，哪个组名点亮
  for (const g of document.querySelectorAll('#nav .nav-group')) {
    g.classList.toggle('active', g.querySelector('a.active') !== null);
  }
  app.innerHTML = '<p class="muted">加载中…</p>';
  // 兜底壳（P1-7 belt+suspenders）：视图自身未收口的加载失败也不许永久
  // 「加载中…」——失败面+重试；代际过期的失败直接丢弃，不覆盖新渲染。
  try {
    const c = await view(app);
    if (gen !== renderGen) { c?.(); return; }
    cleanup = c;
  } catch (e) {
    if (gen !== renderGen) return;
    app.innerHTML = `<div class="panel"><p>视图加载失败：${esc(e instanceof Error ? e.message : String(e))}</p>` +
      `<button class="mini" id="app-retry">重试</button></div>`;
    app.querySelector('#app-retry')?.addEventListener('click', () => void render());
    return;
  }
  void refreshSideQueue();
};

// 在办队列（驾驶舱二期，纯前端）：消费现成 GET /api/queue（active/waiting/
// held）× workflows 名册拼标题，常驻左栏顶——队列卡与图上动点同终点（POC
// 契约）。20s 轮询 + 每次路由切换即刷；卡片 → #/order?w= 直达单子。
// 代际守卫（照 render 先例）：双触发下晚到的旧响应/旧失败兜底不得覆盖新渲染。
let sqGen = 0;
const refreshSideQueue = async (): Promise<void> => {
  const box = document.getElementById('side-q-items');
  if (box === null) return;
  const gen = ++sqGen;
  try {
    const [q, wf] = await Promise.all([
      api.get<{ concurrency: number; active: readonly string[]; waiting: readonly string[]; held: readonly string[] }>('/api/queue'),
      api.get<{ workflows: readonly { id: string; title: string; status: string; session?: string }[] }>('/api/lifecycle/workflows?limit=100'),
    ]);
    if (gen !== sqGen) return;
    const map = new Map(wf.workflows.map((w) => [w.id, w]));
    const rows = [
      ...q.active.map((id) => ({ id, st: 'run', t: '执行中' })),
      ...q.waiting.map((id) => ({ id, st: 'wait', t: '排队' })),
      ...q.held.map((id) => ({ id, st: 'hold', t: 'HOLD' })),
    ].slice(0, 10);
    box.innerHTML = rows.length === 0
      ? '<span class="muted side-q-empty">队空——都在正轨</span>'
      : rows.map((r) => {
        const w = map.get(r.id);
        return `<a class="side-q-item" href="#${anchorHref('run', r.id)}">` +
          `<span class="sq-t">${esc(w?.title ?? r.id)}</span>` +
          `<span class="sq-s">${r.t}${w?.session !== undefined && w.session !== '' ? ` · @${esc(w.session)}` : ''}</span></a>`;
      }).join('');
  } catch {
    if (gen !== sqGen) return;
    box.innerHTML = '<span class="muted side-q-empty">（队列暂不可达）</span>';
  }
};
setInterval(() => { if (!document.hidden) void refreshSideQueue(); }, 20_000);

window.addEventListener('hashchange', () => void render());

// 旧的导航分组点击开合（下拉第二通道）随 head-tab 退役拆除（2026-10-07
// 左栏化：左栏常驻平铺，无开合状态）。

const boot = async (): Promise<void> => {
  const bridge = window.juli ?? window.makro;
  if (bridge) {
    // Electron 壳形态：header 变窗口拖拽区（红绿灯让位），互动物件豁免。
    document.body.classList.add('mac-frame');
    try {
      const info = await bridge.getConnectionInfo();
      if (typeof info?.password === 'string' && info.password !== '') {
        setToken(info.password);
        tokenInput.value = info.password;
      }
    } catch { /* 桥在但取不到：回落手动输入 */ }
  }
  // AI 未配置引导（2026-10-10 开源 MVP）：不静默降级——chat 起单与 agent
  // 干活都吃统一 ai 段，没配就全站显眼指路。关闭仅记 sessionStorage。
  if (sessionStorage.getItem('ai-guide') !== 'off') {
    const st = await api.get<{ configured: boolean }>('/api/ai/status').catch(() => null);
    if (st !== null && !st.configured) {
      document.body.insertAdjacentHTML('afterbegin', `
        <div class="ai-guide" id="aiGuide">
          <span>⚠ AI 未配置——agent 无法干活。去 <a href="#/settings">设置 → AI</a> 填 API key，或跑 <code>npx tsx cli/juli.ts setup</code></span>
          <button id="aiGuideClose" aria-label="关闭">×</button>
        </div>`);
      document.getElementById('aiGuideClose')?.addEventListener('click', () => {
        sessionStorage.setItem('ai-guide', 'off');
        document.getElementById('aiGuide')?.remove();
      });
    }
  }
  void render();
  // 全局事件提示条（SSE 驱动）——分级是警报纪律：需要人动的红色长亮，
  // 结果类绿色短亮，过程类静默。所有事件同一强度 = 训练操作人无视警报。
  // 顶栏连接灯（板②「● 已连接」）：SSE 通了常亮，断线熄灭。
  const conn = document.getElementById('conn');
  subscribeEvents((type, data) => {
    const to = (data !== null && typeof data === 'object' && typeof (data as { to?: unknown }).to === 'string')
      ? (data as { to: string }).to : '';
    const level = TOAST_LEVELS[type];
    if (level === undefined || level === 'silent') return;
    const text = TOAST_TEXT[type];
    toast(text !== undefined ? text(to) : type, level);
  }, () => {
    toast('已连接事件流', 'info');
    if (conn) conn.hidden = false;
  }, () => {
    if (conn) conn.hidden = true;
  });
};

void boot();

// TOAST_LEVELS / TOAST_TEXT / ToastLevel 已收编进 events-meta.ts（与 LIVE
// EVENTS 白名单、feed 配色同源——事件元数据单一事实源，勿在此复制第二份）。
// toast 实现单一在 ui.ts（R7-F1 P2-11：原本地版 🔴/✓ 前缀与时长语义已并入
// 共享版，此处直接引用——main/settings/feedback 三处调用面同一份）。

void api; // api 命名空间由各视图引用；此处引用防 tree-shake 误删类型
} // 手机门牌分支的桌面侧收尾（2026-09-30 手机 Web 弃用）
