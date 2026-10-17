// 设计系统组件基元（板「00 · 设计系统」）：返回 HTML 字符串，延续 innerHTML
// 模板渲染风格。着色/字阶只引用 style.css :root 的 tokens 变量（锁 1）；
// 状态语义与能力词表 = tokens.status / tokens.stepKind，全视图统一无第二表达。

import { esc } from './esc.ts';
import { ALL_STATUS_LABELS, statusLabelOf as listLabelOf } from './statuses.ts';
// 导航分组表单一事实源在 nav.ts（开源投影以公开四组同形桩替换）。
import { NAV_GROUPS } from './nav.ts';

/** 状态徽标（旧原语，范围外视图续用；八屏内新代码用 statusChip/statusDot）。 */
export const badge = (s: string): string =>
  `<span class="badge ${esc(s)}">${esc(s)}</span>`;

/** 回信主题派生（与引擎 replySubject 同口径的展示版）。 */
export const replySubject = (subject: string): string =>
  subject === '' ? 'Re: (无主题)'
    : subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`;

/** 状态语义（tokens.status）：中文释义——chip/图例/空态统一用这份。
 * 第四期起由状态唯一名单派生（statuses.ts 对齐副本），不再手写第二份。 */
export const STATUS_LABEL: Readonly<Record<string, string>> = ALL_STATUS_LABELS;

export const statusLabel = (s: string): string => listLabelOf(s);

/** 步骤能力词表（tokens.stepKind）：chip 显英文 mono，中文释义进标题/副行。 */
export const KIND_LABEL: Readonly<Record<string, string>> = {
  triage: '分诊', gate: '闸门', agent: '执行', verify: '核验',
  draft: '起草', send: '发送', llm: '推理', share: '分享',
};

export const kindLabel = (k: string): string => KIND_LABEL[k] ?? k;

/** 状态点（8px 圆点，状态语义色）。 */
export const statusDot = (s: string): string =>
  `<span class="dot st-${esc(s)}" aria-hidden="true"></span>`;

/** 状态 chip：软底 + 状态字色 + 前置点（板① status chip）。 */
export const statusChip = (s: string): string =>
  `<span class="chip st-${esc(s)}">${statusDot(s)}${esc(statusLabel(s))}</span>`;

/** 能力 chip（mono）：`gate` 短形态 / `gate · 闸门` 全形态（板① step kind）。 */
export const kindChip = (k: string, withLabel = false): string =>
  `<span class="chip kind">${esc(withLabel ? `${k} · ${kindLabel(k)}` : k)}</span>`;

export type BtnVariant = 'primary' | 'ghost' | 'danger';

/** 按钮（tokens.btn）：primary=不可逆动作专用橘；ghost=描边；danger=红软底。
 * label 一律转义；要带图标/富内容时用 btnRaw 并自行 esc。 */
export const btn = (variant: BtnVariant, label: string, attrs = ''): string =>
  `<button class="j-${esc(variant)}" ${attrs}>${esc(label)}</button>`;

export const btnRaw = (variant: BtnVariant, html: string, attrs = ''): string =>
  `<button class="j-${esc(variant)}" ${attrs}>${html}</button>`;

/** 统计卡 props（板①④）：status 同时着色圆点与数字（waiting=橘唯一强调）。
 * href = 实体锚点（如 #/kanban?col=failed）——数字是相位计数，点它走图
 * 到该相位的看板列；提供时根元素用 <a>（导航原生化，无 JS 拼装）。 */
export interface StatCardProps {
  readonly label: string;
  readonly num: string | number;
  readonly sub?: string;
  readonly status?: string;
  readonly badge?: string;
  readonly href?: string;
  readonly title?: string;
}

/** 统计卡：状态点+标签 [+chip] / mono 大数字 / 副行注记。 */
export const statCard = (p: StatCardProps): string => {
  const attrs = p.href !== undefined ? ` href="${esc(p.href)}"${p.title !== undefined ? ` title="${esc(p.title)}"` : ''}` : '';
  return `
  <${p.href !== undefined ? 'a' : 'div'} class="stat-card${p.status !== undefined ? ` st-${esc(p.status)}` : ''}"${attrs}>
    <div class="sc-head">${p.status !== undefined ? statusDot(p.status) : ''}<span class="sc-label">${esc(p.label)}</span>${p.badge !== undefined ? `<span class="chip soft">${esc(p.badge)}</span>` : ''}</div>
    <div class="sc-num">${esc(String(p.num))}</div>
    ${p.sub !== undefined ? `<div class="sc-sub">${esc(p.sub)}</div>` : ''}
  </${p.href !== undefined ? 'a' : 'div'}>`;
};

/** 面板头：kicker（// KICKER mono 橘）+ 标题 + 右侧动作槽。 */
export const panelHead = (kicker: string, title: string, right = ''): string => `
  <div class="panel-head">
    <div class="ph-left"><div class="kicker">// ${esc(kicker)}</div><h2 class="panel-title">${esc(title)}</h2></div>
    ${right}
  </div>`;

/** 顶栏导航：分组表（NavGroup/NAV_GROUPS）已抽至 nav.ts——sidebar 数据源。 */

/** 顶栏（2026-10-07 左栏化）：只留存在感——橘点 wordmark + 拖拽区 + LIVE 灯 +
 * 密码框；导航职能整体移交左栏 sidebar（head-tab 退役：用户习惯左侧切换）。
 * 注入一次；SSE 连接态切 #conn。 */
export const topbar = (_activeTab: string, live = false): string => `
  <span class="brand"><span class="brand-dot" aria-hidden="true"></span>juli-service</span>
  <span class="drag-strip" aria-hidden="true"></span>
  <span id="conn" class="conn"${live ? '' : ' hidden'}><span class="dot st-completed" aria-hidden="true"></span>LIVE · SSE</span>
  <input id="token" type="password" placeholder="访问密码" title="Bearer token（留空 = 本机模式）" />`;

/** 左侧导航栏（2026-10-07）：五组常驻平铺，组名小标 + 页名直列——无下拉无
 * 悬停浮层，当前页永远点亮。沿用 id="nav" 与 .nav-group 类名，main.ts 的
 * active 切换与组高亮选择器（#nav a / #nav .nav-group）零改动。
 * 2026-10-14：core 组（单子 · 路由）置顶强化（side-group--core：大字重+
 * 橘组名+底分割线），其余组为辅助节——左栏不再全平级。左栏顶部常驻
 * 「＋ 开单」主按钮（开合逻辑在 orderfab.ts，document 委托）。 */
export const sidebar = (activeTab: string): string => `
  <button id="side-order-btn" title="随时开一张单（不打断当前页）">＋ 开单</button>
  <div class="side-q"><div class="side-q-h">在办单子</div><div id="side-q-items"><span class="muted side-q-empty">加载中…</span></div></div>
  <nav id="nav" aria-label="主导航">${NAV_GROUPS.map((g) => {
    const active = g.items.some(([, route]) => route === activeTab);
    return `<div class="nav-group side-group${g.core === true ? ' side-group--core' : ''}${active ? ' active' : ''}"><div class="side-glabel">${esc(g.label)}</div>${g.items.map(([label, route]) =>
      `<a href="#${route}"${route === activeTab ? ' class="active"' : ''}>${esc(label)}</a>`).join('')}</div>`;
  }).join('')}</nav>`;

/** 全局 toast（单一实现，R7-F1 P2-11 三收一：main.ts/settings.ts 本地版已
 * 删，全仓只此一份）：样式沿用 style.css 的 .toast 分级（z-index 1000 在
 * 弹层 overlay 之上）；🔴/✓ 前缀由此处统一自带——调用方不得手写前缀（防
 * 双前缀）；时长 urgent 6s / ok 4.5s / info 3s。文案原样 textContent（防 XSS）。 */
export const toast = (msg: string, level: 'ok' | 'info' | 'urgent' = 'info'): void => {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = level === 'urgent' ? `🔴 ${msg}` : level === 'ok' ? `✓ ${msg}` : msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), level === 'urgent' ? 6000 : level === 'ok' ? 4500 : 3000);
};
