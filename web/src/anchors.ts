// 实体锚点契约（ontology 导航 2026-09-29）——名词进图、动词不进：界面上
// 的实体文字（会话名/客户邮箱/任务/单号）经 entityAnchor 渲染成可点链接，
// 点击 = 沿 ontology 的一条边走到该实体的另一个投影。
//
// URL 即导航契约（hash 路由天然支持，hashchange 自动重挂视图）；落点视图
// 认参数定位高亮（kanban ?task= / sessions ?s= / customers ?focus= /
// order ?w=）。一处契约，勿在视图里手拼第二份。
//
// 本模块零 DOM 依赖（statuses.ts 同款纪律），vitest 直接可测；ui.ts 因
// toast() 持 DOM 引用不进 node 型 tsconfig，故锚点单列此处。

import { esc } from './esc.ts';

/** 实体种类 → 落点投影。 */
export type EntityKind = 'task' | 'session' | 'customer' | 'run';

export const anchorHref = (kind: EntityKind, id: string): string => {
  switch (kind) {
    case 'task': return `/kanban?task=${encodeURIComponent(id)}`;
    case 'session': return `/sessions?s=${encodeURIComponent(id)}`;
    case 'customer': return `/customers?focus=${encodeURIComponent(id)}`;
    case 'run': return `/order?w=${encodeURIComponent(id)}`;
  }
};

/** 实体锚点：`<a>` 原生导航（hash 变更 → 视图重挂），虚线下划线示「可走」。
 * 视图的卡片级点击守卫须豁免 a/button（见 kanban 卡片点击）。空 id/空文本
 * 降级纯文本，不留死链接。 */
export const entityAnchor = (kind: EntityKind, id: string, text: string, title = ''): string =>
  id === '' || text === '' ? esc(text)
    : `<a class="ea ea-${esc(kind)}" href="#${anchorHref(kind, id)}" title="${esc(title)}">${esc(text)}</a>`;

/** 相位列链接（视图态，非实体）：状态徽章/统计卡数字 → 看板「只看一列」。
 * 与实体锚同源声明——`#/kanban?col=` 的拼装只此一处，视图勿手拼第二份。 */
export const colHref = (colKey: string): string => `/kanban?col=${encodeURIComponent(colKey)}`;
