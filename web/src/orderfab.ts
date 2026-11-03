// 常驻开单（2026-10-14 用户裁决「前端开单要常驻，随时点按钮唤起」）：左栏
// 顶部常驻「＋ 开单」主按钮（ui.ts sidebar 渲染 #side-order-btn）+ 右侧滑出
// 抽屉，抽屉内挂发单对话视图本体（views/chat.ts 的 chatView）。chatView 自
// 含且无定时器/无 SSE 订阅（本地 transcript + 服务端 state 端点恢复），可
// 反复挂载/卸载——抽屉每次打开重挂，关闭即清 DOM。
//
// 入口位置修订（同日，用户实报「开单和反馈混到了一起」）：首版是右下角
// 浮钮，实测与反馈页列表行的「起单」按钮、全局 toast（同为右下角固定位）
// 三者叠放——右下角是既有物件的地盘，常驻件迁入左栏 chrome 层（本模块只
// 管抽屉与开合；触发钮事件走 document 委托，sidebar 重渲染不失联）。
//
// 生命周期咬合：开单成功 chatView 跳 #/lifecycle?w= → hashchange 到来时本
// 模块顺手收抽屉（视图切换与抽屉收口同一事件，无双通道）。#/chat 整页形
// 态下按钮隐藏（main.ts render 切 body.on-chat，CSS 消费——本模块不读路由）。
// 手机门牌分支（≤768px）不注入本模块（main.ts 桌面侧才挂）。

import { chatView } from './views/chat.ts';
import { trapFocus } from './dialog.ts';

/** 注入抽屉并绑定开合（桌面壳初始化时调用一次）。幂等：既存 #order-drawer
 * 即返回。 */
export const mountOrderDrawer = (): void => {
  if (document.getElementById('order-drawer') !== null) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="order-drawer" role="dialog" aria-modal="true" aria-label="开单对话">
      <div class="od-head">
        <span class="od-title">开单</span>
        <span class="od-sub">说一句话，juli 问清楚后给单子卡——确认才开单</span>
        <span class="od-space"></span>
        <button class="od-close" id="order-drawer-close" aria-label="关闭抽屉">✕ 关闭</button>
      </div>
      <div class="od-body" id="order-drawer-body"></div>
    </div>`);
  const drawer = document.getElementById('order-drawer') as HTMLElement;
  const body = document.getElementById('order-drawer-body') as HTMLElement;

  // 抽屉是模态面（P2-6）：开着时背景 inert（不可聚焦不可读穿），焦点圈闭在
  // 抽屉内（P2-4）；关闭归还触发钮（P2-5，trapFocus 释放器一并收口）。
  let releaseTrap: (() => void) | null = null;
  const setBackgroundInert = (on: boolean): void => {
    for (const id of ['topbar', 'sidebar', 'app']) {
      const el = document.getElementById(id);
      if (el !== null) el.inert = on;
    }
  };
  // chatView 自 2026-10-21 起带清理口（语音输入的 WS/计时器/音轨）：抽屉关闭
  // 必须调用，否则语音件泄漏到抽屉外。挂载是 async——抽屉在挂载完成前就被关
  // 的竞态下，晚到的清理口立即自调（照 main.ts render 代际守卫先例）。
  // b44 R1 P2 代际计数：仅靠 isOpen 判定挡不住「关后未决期再开」——第一次
  // 挂载的 then 在第二次打开后才兑现，drawer 是 open 的，死视图清理口被注册
  // 为现役，关闭时调的是死口、活视图的清理口永不被调（/ws/chat 连接泄漏）。
  // 每次开/关推代号，then 先验代际，过期即调即弃。
  let chatCleanup: (() => void) | null = null;
  let renderGen = 0;
  const close = (): void => {
    renderGen++; // 未决挂载整体作废（then 兑现即调即弃，不留死清理口）
    drawer.classList.remove('open');
    chatCleanup?.();
    chatCleanup = null;
    body.innerHTML = ''; // 卸载对话视图（清理口之外的 DOM 残留一并清）
    setBackgroundInert(false); // 先解除背景 inert 再归还焦点——inert 中的元素不可聚焦
    releaseTrap?.();
    releaseTrap = null;
  };
  // 触发钮在左栏（ui.ts sidebar 渲染）——document 委托绑定，一次挂全周期。
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('#side-order-btn') : null;
    if (!(btn instanceof HTMLElement)) return;
    if (drawer.classList.contains('open')) return;
    // 显式聚焦触发钮=opener 记录点（真实指针点击本就聚焦；防御合成调用路径），
    // 关闭时 trapFocus 释放器把焦点还到这里。
    btn.focus();
    releaseTrap = trapFocus(drawer);
    drawer.classList.add('open');
    setBackgroundInert(true);
    const myGen = ++renderGen;
    void chatView(body).then((c) => { // 挂载即 input.focus()（chat.ts）——焦点入抽屉
      if (c === undefined || c === null) return;
      if (myGen !== renderGen || !drawer.classList.contains('open')) c(); // 过代际/已关：即调即弃
      else chatCleanup = c;
    });
  });
  document.getElementById('order-drawer-close')!.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !drawer.classList.contains('open')) return;
    // 打字中 Esc 不清场（P1-2）：焦点在抽屉内输入控件上时，Esc 属于输入
    // 语境——不关抽屉，未发送的草稿与附件托盘原样保留；焦点在控件外/
    // 体外时照常关（与 dialog 家族「Esc=关」肌肉记忆保持一致）。
    const ae = document.activeElement;
    if (ae instanceof HTMLElement && drawer.contains(ae) && ae.matches('input, textarea, select')) return;
    close();
  });
  // 视图切换（开单成功深链 / 用户点左栏）即收抽屉——与路由同一事件源。
  window.addEventListener('hashchange', () => {
    if (drawer.classList.contains('open')) close();
  });
};
