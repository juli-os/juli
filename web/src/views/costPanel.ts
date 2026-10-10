// 费用分析面板（wf_6a74fc4a23e4）：从流水视图抽出为公共件——流水页与统计
// 页双挂。数据=GET /api/lifecycle/cost-stats（逐单复用详情 usageCost 口径
// 聚合）。折叠面板默认收起，首次展开才拉数据；时间预设单行作用于下方全部
// KPI+图。图表纯内联 SVG 零依赖；系列色固定跟实体（服务端按 model id 升序
// 给序，切范围幸存模型不换色）：蓝=首模型、橘=次模型、超出折叠灰。蓝的彩度
// 低于 dataviz 审美带（判别力实测过：CVD ΔE18.7/常视 25/对比 3:1），以图例+
// 柱帽直标+段间 2px 缝做次级编码兜底——设计系统 token 锁定下的取舍。

import { api } from '../api.ts';
import { esc } from './dashboard.ts';
import { statCard } from '../ui.ts';

/** 费用分析聚合：GET /api/lifecycle/cost-stats。分桶右开区间（服务端单一定义）。 */
export interface CostStats {
  readonly days: number;
  readonly since: string;
  readonly pricingRetrievedAt: string;
  readonly overall: {
    readonly workflows: number; readonly ordersWithCost: number; readonly zeroCostOrders: number;
    readonly totalCny: number; readonly meanCny: number; readonly medianCny: number;
    readonly p90Cny: number; readonly maxCny: number;
  };
  readonly buckets: readonly {
    readonly label: string; readonly edges: readonly [number, number | null];
    readonly count: number; readonly totalCny: number;
    readonly byModel: readonly { readonly model: string; readonly label: string; readonly count: number; readonly totalCny: number }[];
  }[];
  readonly perOrder: readonly {
    readonly id: string; readonly title: string; readonly kind: string; readonly status: string;
    readonly createdAt: string; readonly prompts: number; readonly totalCny: number; readonly models: string[];
  }[];
  readonly models: readonly { readonly model: string; readonly label: string; readonly orders: number; readonly totalCny: number }[];
  readonly unpricedOrders: readonly string[];
}

/** 面板 HTML（details 折叠态）：宿主页仅负责放置与 onOrderClick 接线。 */
export const costPanelHTML = (): string => `
    <details class="panel cost-panel" id="cost-panel">
      <summary>费用分析<span class="cost-sum-sub">每单 API 等效成本 × 价位分布（点开展开）</span></summary>
      <div class="cost-presets" id="cost-presets"></div>
      <div id="cost-body"><p class="muted" style="padding:6px 2px">加载中…</p></div>
    </details>`;

/** 挂载费用面板：onOrderClick 缺省时散点/最贵单不可点（统计页无单子详情面）。 */
export const mountCostPanel = (el: HTMLElement, opts?: { onOrderClick?: (id: string) => void }): void => {
  const COST_PRESETS: readonly (readonly [number, string])[] = [[1, '今日'], [7, '近7天'], [30, '近30天'], [90, '近90天'], [0, '全部']];
  let costDays = 30;
  const costPanel = el.querySelector('#cost-panel') as HTMLDetailsElement;
  const costPresets = el.querySelector('#cost-presets') as HTMLElement;
  const costBody = el.querySelector('#cost-body') as HTMLElement;
  const cny = (x: number): string => (x >= 1000 ? `¥${Math.round(x).toLocaleString()}` : `¥${x.toFixed(x >= 100 ? 0 : 1)}`);
  const niceMax = (v: number): number => {
    if (v <= 0) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  };
  const colorOf = (i: number): string => (i === 0 ? 'var(--c-blue)' : i === 1 ? 'var(--c-orange)' : 'var(--c-dim)');
  const renderPresets = (): void => {
    costPresets.innerHTML = COST_PRESETS.map(([d, lab]) =>
      `<button class="lf-chip${d === costDays ? ' on' : ''}" data-days="${d}">${lab}</button>`).join('')
      + `<span class="lf-count">${costDays === 0 ? '全时段' : `近 ${costDays} 天`}</span>`;
    for (const b of costPresets.querySelectorAll<HTMLButtonElement>('button[data-days]')) {
      b.addEventListener('click', () => {
        if (costDays === Number(b.dataset.days)) return;
        costDays = Number(b.dataset.days);
        void loadCost();
      });
    }
  };
  const costBarChart = (d: CostStats): string => {
    const W = 560, H = 272, ML = 34, MR = 8, MT = 18, MB = 46;
    const pw = W - ML - MR, ph = H - MT - MB, n = d.buckets.length;
    const yMax = niceMax(Math.max(...d.buckets.map((b) => b.count), 1));
    const y = (v: number): number => MT + ph * (1 - v / yMax);
    const band = pw / n, bw = 24;
    const ticks = Array.from({ length: 5 }, (_, i) => Math.round((yMax / 4) * i));
    let svg = '';
    for (const t of ticks) svg += `<line class="cost-grid" x1="${ML}" y1="${y(t)}" x2="${W - MR}" y2="${y(t)}"/><text class="cost-tick" x="${ML - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
    svg += `<line class="cost-axis" x1="${ML}" y1="${MT + ph}" x2="${W - MR}" y2="${MT + ph}"/>`;
    d.buckets.forEach((b, i) => {
      const x = ML + i * band + (band - bw) / 2;
      const segs = b.byModel.map((m) => ({ m, n: m.count })).filter((s) => s.n > 0);
      let acc = 0;
      segs.forEach((sg, si) => {
        const yTop = y(acc + sg.n), yBot = y(acc);
        const gap = si < segs.length - 1 ? 2 : 0;
        const h = yBot - yTop - gap;
        const slot = d.models.findIndex((mm) => mm.model === sg.m.model);
        if (h > 0) svg += `<rect x="${x}" y="${yTop}" width="${bw}" height="${h}" rx="${si === segs.length - 1 ? 4 : 0}" class="cost-seg" fill="${colorOf(slot)}"><title>${esc(b.label)} 档 · ${esc(sg.m.label)}：${sg.n} 单 · 共 ${cny(sg.m.totalCny)}</title></rect>`;
        acc += sg.n;
      });
      if (b.count > 0) svg += `<text class="cost-cap" x="${x + bw / 2}" y="${y(acc) - 6}" text-anchor="middle">${b.count}</text>`;
      svg += `<text class="cost-xlab" x="${ML + i * band + band / 2}" y="${MT + ph + 17}" text-anchor="middle">${esc(b.label)}</text>
        <text class="cost-xsub" x="${ML + i * band + band / 2}" y="${MT + ph + 31}" text-anchor="middle">${cny(b.totalCny)}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="价位分桶单量柱状图">${svg}</svg>`;
  };
  const costScatter = (d: CostStats, onOrderClick?: (id: string) => void): string => {
    const pts = d.perOrder.filter((o) => o.totalCny > 0);
    if (pts.length === 0) return '<p class="muted" style="padding:20px 4px">该范围内没有已计价单。</p>';
    const W = 560, H = 272, ML = 34, MR = 58, MT = 16, MB = 30;
    const pw = W - ML - MR, ph = H - MT - MB;
    const t0 = Math.min(...pts.map((o) => Date.parse(o.createdAt)));
    const t1 = Math.max(...pts.map((o) => Date.parse(o.createdAt)));
    const pad = t1 - t0 < 86_400_000 ? 86_400_000 : 0; // 单日范围撑开一天，点不贴边
    const x = (iso: string): number => ML + pw * ((Date.parse(iso) - (t0 - pad / 2)) / (t1 + pad / 2 - (t0 - pad / 2)));
    const yMax = niceMax(d.overall.maxCny);
    const y = (v: number): number => MT + ph * (1 - v / yMax);
    let svg = '';
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const v = yMax * t;
      svg += `<line class="cost-grid" x1="${ML}" y1="${y(v)}" x2="${W - MR}" y2="${y(v)}"/><text class="cost-tick" x="${ML - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`;
    }
    for (const [v, lab] of [[d.overall.medianCny, `中位 ${cny(d.overall.medianCny)}`], [d.overall.p90Cny, `P90 ${cny(d.overall.p90Cny)}`]] as const) {
      if (v <= 0) continue;
      svg += `<line class="cost-ref" x1="${ML}" y1="${y(v)}" x2="${W - MR}" y2="${y(v)}"/><text class="cost-reflab" x="${W - MR + 5}" y="${y(v) + 4}">${lab}</text>`;
    }
    // 同日横向微散（成本序）防重叠——日期归属不变
    const perDay = new Map<string, number[]>();
    for (const o of pts) { const l = perDay.get(o.createdAt) ?? []; l.push(o.totalCny); perDay.set(o.createdAt, l); }
    for (const l of perDay.values()) l.sort((a, b) => a - b);
    for (const o of pts) {
      const l = perDay.get(o.createdAt)!;
      const jit = (l.indexOf(o.totalCny) - (l.length - 1) / 2) * Math.min(4, 90 / l.length);
      const slot = d.models.findIndex((m) => (o.models[0] ?? '') === m.label);
      svg += `<circle class="cost-dot${onOrderClick ? ' clickable' : ''}" data-id="${esc(o.id)}" cx="${(x(o.createdAt) + jit).toFixed(1)}" cy="${y(o.totalCny).toFixed(1)}" r="4.5" fill="${colorOf(slot)}"><title>${cny(o.totalCny)} · ${esc(o.id)} · ${esc(o.createdAt)} · ${esc(o.models.join('+') || '（无价目）')} · ${o.prompts} 回合 · ${esc(o.status)}${o.status === 'running' ? '（成本未封口）' : ''}</title></circle>`;
    }
    const tickDays = [t0, (t0 + t1) / 2, t1];
    for (const t of tickDays) {
      const iso = new Date(t).toISOString().slice(0, 10);
      svg += `<text class="cost-tick" x="${x(iso)}" y="${MT + ph + 18}" text-anchor="middle">${iso.slice(5).replace('-', '/')}</text>`;
    }
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="每单成本散点图">${svg}</svg>`;
  };
  const loadCost = async (): Promise<void> => {
    renderPresets();
    costBody.innerHTML = '<p class="muted" style="padding:6px 2px">加载中…</p>';
    let d: CostStats;
    try {
      d = await api.get<CostStats>(`/api/lifecycle/cost-stats?days=${costDays}`);
    } catch (e) {
      costBody.innerHTML = `<p class="muted" style="padding:6px 2px">费用数据加载失败：${esc(e instanceof Error ? e.message : String(e))}</p>`;
      return;
    }
    const o = d.overall;
    const legends = d.models.slice(0, 3).map((m, i) =>
      `<span class="cost-legend"><span class="cost-swatch" style="background:${colorOf(i)}"></span>${esc(m.label)} ${cny(m.totalCny)}</span>`).join('')
      + (d.models.length > 3 ? `<span class="cost-legend muted">+${d.models.length - 3} 模型</span>` : '');
    const top5 = d.perOrder.slice(0, 5).map((p) =>
      `<button class="cost-top" data-id="${esc(p.id)}"${opts?.onOrderClick ? '' : ' disabled'}><span class="muted">${esc(p.createdAt)}</span><span class="cost-top-id">${esc(p.id)}</span><span>${esc(p.models.join('+') || '（无价目）')}</span><strong>${cny(p.totalCny)}</strong></button>`).join('');
    costBody.innerHTML = `
      <div class="dash-stats cost-kpis">
        ${statCard({ label: 'API 等效总成本', num: cny(o.totalCny), sub: `${o.ordersWithCost}/${o.workflows} 单有计价`, title: '范围内每单 usageCost 加总（bigmodel 价目 ' + esc(d.pricingRetrievedAt) + ' 快照，cache/input/output 三价）' })}
        ${statCard({ label: '单均成本', num: cny(o.meanCny), sub: `中位 ${cny(o.medianCny)}` })}
        ${statCard({ label: 'P90', num: cny(o.p90Cny), sub: `最贵 ${cny(o.maxCny)}` })}
        ${statCard({ label: '无计费用量单', num: o.zeroCostOrders, sub: '历史归属盲区+纯闸门单', title: 'tmux 映射接线前的历史单无归属、纯闸门/llm 单无 CC 回合——显式计数不隐藏' })}
      </div>
      <div class="cost-charts">
        <div class="cost-chart">
          <div class="cost-chart-h">单子价位分布<span class="muted">（分桶 × 单量${d.models.length > 1 ? '，按模型堆叠' : ''}）</span></div>
          ${d.models.length > 1 ? `<div class="cost-legends">${legends}</div>` : ''}
          ${costBarChart(d)}
        </div>
        <div class="cost-chart">
          <div class="cost-chart-h">每单成本离散度${opts?.onOrderClick ? '<span class="muted">（点单点开详情）</span>' : ''}</div>
          ${costScatter(d, opts?.onOrderClick)}
        </div>
      </div>
      <div class="cost-toprow">
        <div class="cost-chart-h">最贵 5 单</div>
        <div class="cost-tops">${top5 || '<p class="muted">该范围内无计价单。</p>'}</div>
        ${d.unpricedOrders.length > 0 ? `<p class="muted" style="font-size:11px;margin:6px 0 0">另有 ${d.unpricedOrders.length} 单含不在价目的模型（只计用量不出价）：${d.unpricedOrders.slice(0, 5).map((id) => esc(id)).join('、')}${d.unpricedOrders.length > 5 ? '…' : ''}</p>` : ''}
      </div>`;
    if (opts?.onOrderClick) {
      for (const dot of costBody.querySelectorAll<SVGCircleElement>('.cost-dot')) {
        dot.addEventListener('click', () => opts.onOrderClick?.(dot.dataset.id ?? ''));
      }
      for (const b of costBody.querySelectorAll<HTMLButtonElement>('.cost-top')) {
        b.addEventListener('click', () => opts.onOrderClick?.(b.dataset.id ?? ''));
      }
    }
  };
  renderPresets();
  costPanel.addEventListener('toggle', () => { if (costPanel.open) void loadCost(); });
};
