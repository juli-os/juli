// 流水视图：左侧目录（工作流列表，即选即看）+ 右侧详情（步骤阶梯 + 闸门
// 审核 + 案卷）。窄屏退化为上下堆叠。
//
// 审核面 UX 纪律（Laws of UX 对齐，2026-09-12）：
// - 不可逆动作（批准并发送）必须先过【后果陈述确认卡】——收件人/主题/
//   正文预览/检查芯片摆在确认键上方（Mental Model：操作人带着邮件客户端
//   的心智来，确认=重述后果，不是填备注）。
// - 主行动 44pt 级大按钮，与反向动作物理分组（Fitts + Proximity）。
// - 动作在途禁用全部按钮，错误映射为操作人语言（Doherty + Postel）。
// - 状态徽标中文（引擎枚举不出操作面），三个"不"的语义给提示行（Hick）。
// - 发送完成有闭环横幅（Peak-End：全流程最高潮的落点不该是最安静的时刻）。

import { api, type Step, type Workflow } from '../api.ts';
import { esc } from './dashboard.ts';
import { renderEml } from '../eml.ts';
import { askText, askChecks, askConfirm, askSelect } from '../dialog.ts';
import { entityAnchor } from '../anchors.ts';
import { statusChip, kindChip, replySubject, toast, statCard } from '../ui.ts';
import { LIFECYCLE_FILTERS } from '../statuses.ts';
import { checkChip, gateDeliveryOf, isSendGate, resolveRecipientOf } from '../gates.ts';
import { decideStepActions } from '../step-actions.ts';
import { taskKeyOf } from '../task-model.ts';
import { costPanelHTML, mountCostPanel } from './costPanel.ts';

/** /api/lifecycle/task-map（Task 投影）：任务卡视图 + workflowId→taskId 归属。 */
interface TaskMap {
  readonly tasks: readonly { readonly id: string; readonly title: string; readonly status: string; readonly workflow_ids: readonly string[] }[];
  readonly map: Readonly<Record<string, string>>;
}

/** 详情 usageCost（wf_535149a174fe）：该单模型 × bigmodel 价目的 API 等效
 * 价格——cache/input/output 三价分别计价加总；不在价目的模型只显用量。 */
interface UsageCost {
  readonly currency: string;
  readonly pricingRetrievedAt: string;
  readonly byModel: readonly {
    readonly model: string; readonly label: string; readonly free: boolean; readonly priced: boolean;
    readonly calls: number; readonly inputTokens: number; readonly cachedTokens: number; readonly outputTokens: number;
    readonly tiersHit: readonly string[];
    readonly costCny: { readonly cache: number; readonly input: number; readonly output: number; readonly total: number };
  }[];
  readonly totalCny: { readonly cache: number; readonly input: number; readonly output: number; readonly total: number };
}

export const lifecycleView = async (el: HTMLElement): Promise<(() => void) | void> => {
  el.innerHTML = `
    ${costPanelHTML()}
    <div class="split">
      <aside id="wf-list" class="split-side"><p class="muted">加载中…</p></aside>
      <section id="wf-detail" class="split-main"><p class="muted">← 从左侧选择一条流水，细节在这里展开</p></section>
    </div>`;
  const list = el.querySelector('#wf-list') as HTMLElement;
  const detail = el.querySelector('#wf-detail') as HTMLElement;
  let selected = '';
  let filter = '';
  // Task 投影（第四期最小转正）：归属表 + 「属 Task」过滤（点徽标进入）。
  let tasks: TaskMap = { tasks: [], map: {} };
  let taskFilter = '';
  // hold 透明化（2026-09-28）：在途单被工作窗 hold 的 id 集 + 窗口文案——
  // 列表卡片与详情头挂「⏸ HOLD」徽标，详情头给「立即放行」干预钮。
  let heldIds = new Set<string>();
  let holdUntil = '';

  const fmtTime = (iso: string): string => (iso || '').replace('T', ' ').slice(5, 16);

  /** 状态排序权位：等你决定最前、进行中次之；终态一律沉底按时间新→旧。
   * 失败不浮头（2026-09-17 裁决：置顶是干扰）——找失败走看板失败列/
   * 筛选 chip，目录里它是历史不是待办。 */
  const statusRank = (s: string): number =>
    s === 'waiting_human' ? 0 : s === 'running' ? 1 : s === 'queued' ? 1.5 : 2;
  /** 邮件时间优先：案卷可能晚于邮件数天才建立（修复/重试/补摄取）。 */
  const mailAt = (w: Workflow): string => {
    const d = w.meta?.['date'];
    return typeof d === 'string' && d !== '' ? d : w.createdAt;
  };

  const load = async (): Promise<void> => {
    const [{ workflows, held_ids, hold_until }, taskRes] = await Promise.all([
      api.get<{ workflows: Workflow[]; held_ids?: string[]; hold_until?: string }>('/api/lifecycle/workflows?limit=100'),
      api.get<TaskMap>('/api/lifecycle/task-map'),
    ]);
    tasks = taskRes;
    heldIds = new Set(held_ids ?? []);
    holdUntil = hold_until ?? '';
    const taskTitle = (tid: string): string => tasks.tasks.find((t) => t.id === tid)?.title ?? '';
    const taskSize = (tid: string): number => tasks.tasks.find((t) => t.id === tid)?.workflow_ids.length ?? 0;
    // Task 过滤优先：只看该任务卡挂的全部单（含已取消——归属查账不受
    // 目录折叠口径影响）；无 Task 过滤走状态筛选（全部 = 已取消折叠进看板）。
    const visible = (taskFilter !== ''
      ? workflows.filter((w) => tasks.map[w.id] === taskFilter)
      : workflows.filter((w) => (filter === '' ? w.status !== 'cancelled' : w.status === filter)))
      .sort((a, b) => statusRank(a.status) - statusRank(b.status) || mailAt(b).localeCompare(mailAt(a)));
    list.innerHTML = `
      <div class="lf-filters">
        ${LIFECYCLE_FILTERS.map(([k, label]) => `<button class="lf-chip${k === filter && taskFilter === '' ? ' on' : ''}" data-filter="${esc(k)}">${esc(label)}</button>`).join('')}
        ${taskFilter !== '' ? `<button class="lf-chip on" data-task-clear="1" title="退出 Task 过滤，回到状态筛选">Task：${esc(taskTitle(taskFilter) || taskFilter)} ✕</button>` : ''}
        <span class="lf-count">${visible.length}</span>
      </div>
      ${visible.map((w) => {
        const tid = tasks.map[w.id] ?? '';
        const tSize = tid !== '' ? taskSize(tid) : 0;
        const taskBadge = tid !== '' && tSize > 1
          ? `<button class="lf-task-badge${tid === taskFilter ? ' on' : ''}" data-task="${esc(tid)}" title="属任务卡「${esc(taskTitle(tid) || tid)}」——点开只看同 Task 的 ${tSize} 单">属 Task ×${tSize}</button>`
          : '';
        return `
      <div class="wf-item${w.id === selected ? ' active' : ''}${w.status === 'waiting_human' ? ' has-waiting' : ''}" data-id="${w.id}" title="邮件 ${fmtTime(mailAt(w))} · 案卷建立 ${fmtTime(w.createdAt)}">
        <div class="t">${esc(w.title)}</div>
        <div class="s">${statusChip(w.status)}${heldIds.has(w.id) ? ` <span class="chip warn" title="工作窗 hold：非 high 任务在高价时段（${esc(holdUntil)}）暂停派发，窗口结束自动放行；详情页可立即放行">⏸ HOLD${holdUntil ? ' · ' + esc(holdUntil) : ''}</span>` : ''}${taskBadge}<span class="muted">✉ ${fmtTime(mailAt(w))}</span><span class="muted time">${esc(w.kind)}${w.session ? ' · ' + entityAnchor('session', w.session, `@${w.session}`, `会话 ${w.session}`) : ''}</span></div>
      </div>`;
      }).join('') || '<p class="muted" style="padding:10px">此筛选下暂无流水。</p>'}`;
    for (const btn of list.querySelectorAll('button[data-filter]')) {
      btn.addEventListener('click', () => {
        filter = (btn as HTMLElement).dataset.filter ?? '';
        taskFilter = ''; // 状态筛选与 Task 过滤互斥，互点即退出
        void load();
      });
    }
    // 「属 Task」徽标：只看同一张任务卡挂的全部单（store 层投影聚合）。
    for (const btn of list.querySelectorAll<HTMLButtonElement>('.lf-task-badge')) {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation(); // 不触发条目选中——徽标是过滤动作，不是点穿
        taskFilter = btn.dataset.task ?? '';
        void load();
      });
    }
    for (const btn of list.querySelectorAll<HTMLButtonElement>('[data-task-clear]')) {
      btn.addEventListener('click', () => {
        taskFilter = '';
        void load();
      });
    }
    for (const item of list.querySelectorAll('.wf-item')) {
      item.addEventListener('click', (ev) => {
        // 锚点/按钮豁免：实体导航与过滤动作不与条目选中抢点击。
        if ((ev.target as HTMLElement).closest('a, button') !== null) return;
        selected = (item as HTMLElement).dataset.id ?? '';
        for (const x of list.querySelectorAll('.wf-item')) {
          x.classList.toggle('active', (x as HTMLElement).dataset.id === selected);
        }
        void showDetail(selected);
      });
    }
  };

  // 费用分析面板：公共件（costPanel.ts，统计页双挂同款）；散点/最贵单下钻
  // 回调接本页选中态与详情面。
  mountCostPanel(el, {
    onOrderClick: (id) => {
      selected = id;
      for (const x of list.querySelectorAll('.wf-item')) x.classList.toggle('active', (x as HTMLElement).dataset.id === selected);
      void showDetail(selected);
    },
  });


  const humanError = (e: unknown): string => {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not an actionable gate')) return '该闸门已被处理（可能已在别处批准/驳回），正在刷新';
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) return '网络错误——动作未执行，请检查服务后重试';
    return msg;
  };

  /** 动作执行壳：在途禁用（防双击重复提交）→ 中文错误 → 永远刷新视图。 */
  const runAction = async (btn: HTMLButtonElement, fn: () => Promise<unknown>): Promise<void> => {
    const all = [...detail.querySelectorAll<HTMLButtonElement>('button')];
    all.forEach((b) => { b.disabled = true; });
    btn.textContent = `${btn.textContent ?? ''}…`;
    try {
      await fn();
    } catch (e) {
      alert(humanError(e));
    } finally {
      await showDetail(selected);
      await load();
    }
  };

  const showDetail = async (id: string): Promise<void> => {
    // 重渲染状态保持：已展开的 JSON 面板不折叠、滚动位置不丢（移动端审长
    // 正文后做动作，人不应被抛回页首）。
    const openIdx: number[] = [];
    detail.querySelectorAll('details').forEach((d, i) => { if ((d as HTMLDetailsElement).open) openIdx.push(i); });
    const scrollY = window.scrollY;
    detail.innerHTML = '<p class="muted">加载中…</p>';
    const d = await api.get<{ workflow: Workflow; steps: Step[]; case_file: { decisions?: unknown[] }; usageCost?: UsageCost; promptStats?: { count: number; inputTokens: number; outputTokens: number } }>(`/api/lifecycle/workflows/${id}`);
    const { steps } = d;
    const w = d.workflow;
    // Peak-End 闭环横幅：流水完成且确有发出动作时，给"真的发出去了"的落点。
    const sendStep = steps.find((s) => s.kind === 'send' && s.status === 'completed');
    const sentTo = typeof w.meta?.['from'] === 'string' ? w.meta['from'] : '';
    const banner = w.status === 'completed'
      ? (sendStep
        ? `<div class="done-banner">✓ 已发送给 ${entityAnchor('customer', sentTo, sentTo)} · 流水完成（${esc(String((sendStep.output as Record<string, unknown>)['message_id'] ?? ''))}）</div>`
        : '<div class="done-banner">✓ 流水完成</div>')
      : '';
    // 发出后回看面（09-19）：完成态 run 的交付工件只读面板。闸门卡只在
    // waiting_human 时渲染——批准发出后工件就从平台消失了；数据一直在
    // 步骤 input.deliverables（agent 收编/gate/send 都申报），取件复用
    // /api/artifacts/{id}/content + renderDeliverable，与审核同一渲染器。
    const seenArt = new Set<string>();
    const sentArts: { id: string; name: string; view_role: string; sha256: string; summary?: string }[] = [];
    const deliverablesOf = (s: Step): { id: string; name: string; view_role: string; sha256: string; summary?: string }[] =>
      Array.isArray((s.input ?? {})['deliverables'])
        ? ((s.input!)['deliverables'] as { id: string; name: string; view_role: string; sha256: string; summary?: string }[])
        : [];
    const pushDl = (dl: readonly { id: string; name: string; view_role: string; sha256: string; summary?: string }[]): void => {
      for (const d of dl) {
        // 同名工件在流程中会被重复登记（agent 收编与 gate 申报各一个 id，
        // 内容同源）——回看面按 role/name 去重，展示逻辑工件。
        const key = `${d.view_role}/${d.name}`;
        if (!seenArt.has(key)) { seenArt.add(key); sentArts.push(d); }
      }
    };
    // 实发清单优先（09-20 P2）：send 步 input.deliverables 是 seedSendFromGate
    // 播种的实际随信版本——多轮迭代同名工件（gate1 草案 v1 → gate2 终稿 v2）
    // 时，先收 send 版本，其余步骤只作补充；「回看=发出内容」不再被首见
    // 草稿版冒名。
    if (sendStep !== undefined) pushDl(deliverablesOf(sendStep));
    for (const s of steps) pushDl(deliverablesOf(s));
    const artsPanel = w.status === 'completed' && sentArts.length > 0 ? `
      <div class="panel sent-arts">
        <div class="gc-col-h">${sendStep ? '交付工件（已随信发出 · 点开回看）' : '交付工件（本单产出）'}</div>
        <div class="deliverables">${sentArts.map((d) => `
          <div class="deliverable" data-art="${esc(d.id)}" data-role="${esc(d.view_role)}" data-name="${esc(d.name)}">
            <div class="dl-head"><span class="chip kind">${esc(d.view_role)}</span> <strong>${esc(d.name)}</strong>
              <span class="muted" style="font-size:11px">sha256 ${esc(d.sha256.slice(0, 6))}…${d.summary ? ' · ' + esc(d.summary) : ''}</span></div>
            <div class="dl-body muted">加载中…</div>
          </div>`).join('')}
        </div>
      </div>` : '';
    // 用量与成本行（wf_535149a174fe + 2026-10-07 可见性对齐 iOS）：Prompts
    // 回合数与 in/out token 提到可见层（此前只藏在悬停里，iOS 详情头是明文
    // ——用户实报「Desktop 看不到」）；cache/input/output 三价拆分与命中档
    // 位仍留悬停全文。无价目模型只列名不猜价。口径=会话×agent 步窗口（与
    // 详情 usageCost / cost-stats / 统计归属率同源）。
    const uc = d.usageCost;
    const fmtCny = (x: number): string => `¥${x.toFixed(2)}`;
    const fmtTok = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    const ps = d.promptStats;
    const promptsSpan = ps !== undefined && ps.count > 0
      ? `<span class="muted" title="该单执行期间归属会话的 LLM 回合数（Round=Prompt）与 token 量——会话×agent 步窗口口径">Prompts ${ps.count}（in ${fmtTok(ps.inputTokens)} / out ${fmtTok(ps.outputTokens)}）</span>`
      : '';
    const costLine = (promptsSpan !== '' || (uc !== undefined && uc.byModel.length > 0)) ? `
      <div class="wf-meta" style="margin-top:2px">
        ${promptsSpan}${promptsSpan !== '' && uc !== undefined && uc.byModel.length > 0 ? ' · ' : ''}
        ${uc !== undefined && uc.byModel.length > 0 ? `<span title="如果这单走 API 要花多少钱：各回合模型代入智谱 bigmodel 官方价目（${esc(uc.pricingRetrievedAt)} 抓取），cache 价×缓存命中 + input 价×(输入−缓存) + output 价×输出，按百万 tokens 计。不在价目的模型只显用量。">¥ API 等效</span>` : ''}
        ${uc?.byModel.map((m) => `<span class="muted" title="${esc(m.priced
          ? `${m.calls} 回合 · in ${m.inputTokens.toLocaleString()}（缓存 ${m.cachedTokens.toLocaleString()}）/ out ${m.outputTokens.toLocaleString()} · cache ${fmtCny(m.costCny.cache)} + input ${fmtCny(m.costCny.input)} + output ${fmtCny(m.costCny.output)} · 档位：${m.tiersHit.join(' / ')}`
          : `${m.calls} 回合 · in ${m.inputTokens.toLocaleString()} / out ${m.outputTokens.toLocaleString()} · 不在智谱价目内，只计用量不出价`)}">${esc(m.priced ? m.label : m.model)}${m.priced ? (m.free ? '·免费' : ` ≈${fmtCny(m.costCny.total)} · ${m.calls}回 · in ${fmtTok(m.inputTokens)}/out ${fmtTok(m.outputTokens)}`) : `·无价目 · ${m.calls}回 · in ${fmtTok(m.inputTokens)}/out ${fmtTok(m.outputTokens)}`}</span>`).join(' · ') ?? ''}
        ${uc !== undefined && uc.totalCny.total > 0 ? `<strong title="cache ${fmtCny(uc.totalCny.cache)} + input ${fmtCny(uc.totalCny.input)} + output ${fmtCny(uc.totalCny.output)}">合计 ≈${fmtCny(uc.totalCny.total)}</strong>` : ''}
      </div>` : '';
    detail.innerHTML = `
      ${banner}
      ${artsPanel}
      <div class="panel">
        <div class="wf-head">
          <h2>${esc(w.title)}</h2> ${statusChip(w.status)}${heldIds.has(w.id) ? ` <span class="chip warn" title="工作窗 hold：高价时段（${esc(holdUntil)}）暂停派发，窗口结束自动放行">⏸ HOLD${holdUntil ? ' · ' + esc(holdUntil) : ''}</span>` : ''}
          <div class="wf-actions">
            ${(w.meta?.['auto_approve'] ?? null) === true ? `<span class="chip soft" title="本单免批：非发送闸门由 juli-auto 自动批准（问询与外发邮件仍等人）；点右侧「需批」恢复人工">⚡ 自动批准中</span>` : ''}
            ${(w.status === 'running' || w.status === 'queued' || w.status === 'waiting_human')
              ? (w.meta?.['auto_approve'] ?? null) === true
                ? `<button class="mini ghost" data-autoap-off="${w.id}" title="恢复人工批准">需批</button>`
                : `<button class="mini" data-autoap-on="${w.id}" title="本单免批：非发送闸门自动批准（by=juli-auto 留痕）；问询与外发邮件仍会等你">免批</button>`
              : ''}
            ${(w.status === 'running' || w.status === 'queued') && heldIds.has(w.id) ? `<button class="mini" data-release="${w.id}" title="窗口内立即派发（人的决定优先于窗口策略；hold_released 留痕）">立即放行</button>` : ''}
            ${w.status === 'failed' ? `<button class="mini ghost" data-close="${w.id}">收口</button>` : ''}
            ${(w.status === 'running' || w.status === 'queued') ? `<button class="mini ghost" data-override="${w.id}" title="统一干预：改派会话（钉住不被改道）/补充上下文/优先级/时机——派发时生效，任何状态可设">干预</button>` : ''}
            ${w.status === 'running' ? `<button class="mini" data-settle="${w.id}">完成</button>` : ''}
            ${w.status === 'running' || w.status === 'waiting_human' || w.status === 'queued' ? `<button class="mini danger" data-force="${w.id}">中止</button>` : ''}
            <button class="mini ghost" data-follow="${esc(w.id)}" title="同一任务的跟进单：新独立 Task + relates_to 留链，不复活本单">跟进</button>
          </div>
        </div>
        <div class="wf-meta">✉ 邮件 ${fmtTime(mailAt(w))} · 客户 ${sentTo !== '' ? entityAnchor('customer', sentTo, sentTo, `客户 ${sentTo}——点开看 TA 的全部往来`) : '（内部）'} · ${esc(w.kind)}${w.session ? ' · ' + entityAnchor('session', w.session, `@${w.session}`, `会话 ${w.session}——点开看终端`) : ''}${taskAnchorOf(w) !== '' ? ' · ' + entityAnchor('task', taskAnchorOf(w), '看任务卡', '去看板看这件事——含全部执行') : ''}</div>
        ${costLine}
        ${taskCard(w)}
        <div class="tl">
        ${steps.length === 0 && w.meta?.['mode'] === 'nodes' ? '<p class="muted" style="font-size:12px;margin:4px 0 8px">（行动驱动的空容器——juli claim 接管 / 里程碑 appendNode / settle 收口；每次回合自动入账）</p>' : ''}
        ${steps.map((s) => `
          <div class="tl-node${s.status === 'waiting_human' ? ' is-waiting' : ''}">
            <div class="tl-rail"><span class="tl-dot ${s.status}"></span><span class="tl-line"></span></div>
            <div class="tl-body">
              <div class="tl-head">${kindChip(s.kind)}<span class="t-title">${esc(s.title)}</span>
                <span class="tl-dur">${esc(stepDur(s))}</span></div>
              ${excerpt(s)}
              ${s.kind === 'gate' && s.status === 'waiting_human' ? gateCard(s, steps, w) : ''}
              ${s.output && (s.output as Record<string, unknown>)['aligned'] === true && typeof (s.output as Record<string, unknown>)['amendment'] === 'string' ? `<div class="muted" style="font-size:12px;margin-top:4px">✎ 对齐修正: ${esc(String((s.output as Record<string, unknown>)['amendment']).slice(0, 200))}</div>` : ''}
              ${s.kind === 'gate' && s.status === 'waiting_human' ? '' : actions(s, steps)}
            </div>
          </div>`).join('')}
        </div>
      </div>
      <details class="panel"><summary>步骤产出（JSON）</summary><pre>${esc(JSON.stringify(steps.map((s) => ({ seq: s.seq, status: s.status, output: s.output })), null, 2))}</pre></details>
      <details class="panel"><summary>案卷决策（JSON）</summary><pre>${esc(JSON.stringify(d.case_file?.decisions ?? [], null, 2))}</pre></details>`;
    detail.querySelectorAll('details').forEach((d2, i) => {
      if (openIdx.includes(i)) (d2 as HTMLDetailsElement).open = true;
    });
    window.scrollTo(0, scrollY);

    // 问询闸门选择题（2026-09-28）：点选项即回答——note=reply 原样走 approve
    // （引擎 answer 分支回流），点选即答不弹确认（选项即语义，无歧义可确认）。
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-answer]')) {
      btn.addEventListener('click', () => {
        void runAction(btn, () => api.post(`/api/lifecycle/steps/${btn.dataset.step}/approve`, { note: btn.dataset.answer ?? '', by: 'web' }));
      });
    }
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-answer-custom]')) {
      btn.addEventListener('click', async () => {
        const ans = await askText({ title: '自定义回答（原样发回 agent 会话）', multiline: true, placeholder: '例如：用方案 B，但别动 config 文件' });
        if (ans === null || ans.trim() === '') return;
        await runAction(btn, () => api.post(`/api/lifecycle/steps/${btn.dataset.answerCustom}/approve`, { note: ans.trim(), by: 'web' }));
      });
    }
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action ?? '';
        // 批准：后果陈述已在卡内（收件人/主题/正文/检查在确认键上方），
        // 不再弹 modal——闸门卡片是唯一审核表面。
        let note = '';
        if (action === 'deny') {
          note = await askText({ title: '拒绝理由（必填——整单作废，审计留痕）' }) ?? '';
          if (note.trim() === '') return;
        } else if (action === 'resolve') {
          note = await askText({ title: '在哪处理的？一句话（审计用）', multiline: true }) ?? '';
        } else if (action === 'retry') {
          // 重试 = 该步重新执行：send 步重试会真实再次发信，agent/verify 步
          // 重新消耗会话回合——确认卡先陈述后果（信任修复 2026-09-22）。
          const st = steps.find((x) => x.id === btn.dataset.step);
          const okRetry = await askConfirm({
            title: '重试这一步？',
            rows: [
              { k: '步骤', v: `${st?.kind ?? ''} ${st?.title ?? btn.dataset.step ?? ''}`.trim() },
              { k: '后果', v: '该步将重新执行——send 步会真实再次发信，agent/verify 步重新消耗会话回合' },
            ],
            confirmText: '确认重试',
          });
          if (okRetry === null) return;
        }
        await runAction(btn, () => api.post(`/api/lifecycle/steps/${btn.dataset.step}/${action}`, { note, by: 'web' }));
      });
    }
    // 定时发送（板③ 决定行）：批准=决定已做，执行可定档（时差礼仪——凌晨
    // 不打扰客户）。默认明天 09:00；send_at 走引擎 approve 的既定参数。
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-schedule]')) {
      btn.addEventListener('click', async () => {
        const st = steps.find((x) => x.id === btn.dataset.schedule);
        if (st === undefined) return;
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
        const pad = (n: number): string => String(n).padStart(2, '0');
        const def = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const when = await askText({ title: '定时发送——何时发出？（未来时刻，默认明天 09:00）', value: def });
        if (when === null || when.trim() === '') return;
        const t = new Date(when.trim().replace(' ', 'T'));
        if (!Number.isFinite(t.getTime()) || t.getTime() <= Date.now()) {
          alert('时刻不可解析或已过去——请用如 2026-09-17 09:00 的未来时刻。');
          return;
        }
        await runAction(btn, () => api.post(`/api/lifecycle/steps/${btn.dataset.schedule}/approve`, { note: `定时发送 ${when.trim()}`, by: 'web', send_at: t.toISOString() }));
      });
    }
    // deliverables 就地渲染（异步取件，不阻塞时间线骨架）。
    for (const el of detail.querySelectorAll<HTMLElement>('.deliverable')) {
      void renderDeliverable(el);
    }
    // 回看面板折叠：默认收起（完成态回看不必整屏长报告），点头部展开。
    for (const el of detail.querySelectorAll<HTMLElement>('.sent-arts .deliverable')) {
      el.querySelector('.dl-head')?.addEventListener('click', () => el.classList.toggle('open'));
    }
    // 对齐修正：就地改理解——修正成为新工件，下游 agent 锚定人定稿版本。
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-align]')) {
      btn.addEventListener('click', async () => {
        const amendment = await askText({ title: '对齐修正——下游 agent 将以人定稿版本执行（优先级最高）', multiline: true, placeholder: '例如：第 3 条诉求理解偏了，应为……' });
        if (amendment === null || amendment.trim() === '') return;
        await runAction(btn, () => api.post(`/api/lifecycle/steps/${btn.dataset.align}/align`, { amendment, by: 'web' }));
      });
    }
    // 统一干预（四件套，2026-09-28）：一个模态收齐 session/context/priority/
    // 时机——session 下拉（声明会话+活态，同干预重试的数据源）、context 多行、
    // priority 三选、时机三选（不动/立即派发/hold 到指定时刻）。留空=不动该维。
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-override]')) {
      btn.addEventListener('click', async () => {
        const wid = btn.dataset.override ?? '';
        let sessionOpts = '';
        try {
          const g = await api.get<{ nodes: { name: string; live?: boolean; working?: boolean; company?: string }[] }>('/api/agents/graph');
          sessionOpts = g.nodes.map((n) =>
            `<option value="${esc(n.name)}">${esc(n.name)}${n.working ? ' · 干活中' : n.live ? ' · 在位' : ' · 休眠'}${n.company ? `（${n.company}）` : ''}</option>`).join('');
        } catch { sessionOpts = ''; }
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999;display:flex;align-items:center;justify-content:center;padding:16px';
        wrap.innerHTML = `
          <div class="panel" style="width:min(680px,94vw);max-height:88vh;overflow:auto;margin:0">
            <h2 style="margin:0 0 6px;font-size:16px">干预 <span class="muted" style="font-weight:400">· 派发时生效，任何状态可设，留空=不动该维</span></h2>
            <div class="set-row"><label>改派会话（钉住——忙闲改道不换人，排队等它）</label>
              <select id="ov-session" style="flex:1"><option value="">不改</option>${sessionOpts}</select></div>
            <div class="set-row" style="align-items:flex-start"><label>补充上下文（追加进任务卡，agent 必读）</label>
              <textarea id="ov-context" rows="4" placeholder="例如：这批反馈的方案工件在原单 case-inbox；改文案别动结构" style="flex:1"></textarea></div>
            <div class="set-row"><label>优先级</label>
              <select id="ov-priority" style="flex:1"><option value="">不改</option><option value="high">high（hold 直通立即派发）</option><option value="normal">normal（恢复窗口 hold）</option></select></div>
            <div class="set-row"><label>时机</label>
              <select id="ov-timing" style="flex:1"><option value="">不动</option><option value="now">立即派发（清 hold）</option><option value="hold">hold 到指定时刻…</option></select></div>
            <div class="set-row" id="ov-hold-row" style="display:none"><label>hold 到（YYYY-MM-DD HH:MM）</label>
              <input id="ov-holduntil" type="text" placeholder="2026-09-28 18:00" style="flex:1" /></div>
            <div class="row" style="margin-top:10px;justify-content:flex-end">
              <button class="mini ghost" id="ov-cancel">取消</button>
              <button class="mini" id="ov-ok">应用干预</button>
            </div>
          </div>`;
        document.body.appendChild(wrap);
        const $ = (id: string): HTMLElement => wrap.querySelector(`#${id}`) as HTMLElement;
        const timing = $('ov-timing') as HTMLSelectElement;
        timing.addEventListener('change', () => { $('ov-hold-row').style.display = timing.value === 'hold' ? '' : 'none'; });
        const close = (): void => wrap.remove();
        $('ov-cancel').addEventListener('click', close);
        wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
        $('ov-ok').addEventListener('click', async () => {
          const body: Record<string, unknown> = { by: 'web' };
          const sess = ($('ov-session') as HTMLSelectElement).value;
          const ctx = ($('ov-context') as HTMLTextAreaElement).value.trim();
          const pri = ($('ov-priority') as HTMLSelectElement).value;
          if (sess !== '') body['session'] = sess;
          if (ctx !== '') body['context'] = ctx;
          if (pri !== '') body['priority'] = pri;
          if (timing.value === 'now') body['dispatch_now'] = true;
          if (timing.value === 'hold') {
            const hu = ($('ov-holduntil') as HTMLInputElement).value.trim();
            if (Number.isNaN(Date.parse(hu.replace(' ', 'T')))) { alert('hold 时刻不可解析——请用 2026-09-28 18:00 格式'); return; }
            body['hold_until'] = new Date(hu.replace(' ', 'T')).toISOString();
          }
          close();
          if (Object.keys(body).length === 1) { alert('没有填任何干预维度。'); return; }
          try {
            await api.post(`/api/lifecycle/workflows/${wid}/override`, body);
            toast('干预已应用（派发时生效）', 'ok');
          } catch (e) { alert('干预失败：' + (e instanceof Error ? e.message : String(e))); }
        });
      });
    }
    // hold 人工放行（2026-09-28 透明化配套）：窗口内立即派发。确认卡把
    // 「现在派发=高价时段干活」说清楚——成本决定交还给人，不静默。
    // 单子级免批切换（2026-10-07）：开=立即 sweep（在等闸门当秒处理）。
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-autoap-on], button[data-autoap-off]')) {
      btn.addEventListener('click', () => {
        const onBtn = btn.dataset.autoapOn !== undefined;
        void runAction(btn, () => api.post(`/api/lifecycle/workflows/${esc(w.id)}/auto-approve`, { on: onBtn }));
      });
    }
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-release]')) {
      btn.addEventListener('click', async () => {
        const okgo = await askConfirm({
          title: '立即放行这条 HOLD 单？',
          rows: [
            { k: '当前窗口', v: holdUntil || '（工作窗）' },
            { k: '动作', v: '跳过窗口等待，立即派发给目标会话（hold_released 留痕，重启不回退）' },
            { k: '成本提示', v: '现在处于高价 token 时段——这正是窗口 hold 想省的钱' },
          ],
          confirmText: '确认放行',
        });
        if (okgo === null) return;
        await runAction(btn, () => api.post(`/api/lifecycle/workflows/${btn.dataset.release}/release-hold`, { by: 'web' }));
      });
    }
    // 中止：running 单的人工取消出口（用户"不做了/重开"）——确认框后全 cancelled。
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-force]')) {
      btn.addEventListener('click', async () => {
        const note = await askText({ title: '中止这条流水？在跑的步与闸门将全部取消（审计留痕，不可恢复）', multiline: true, placeholder: '原因（可空）' });
        if (note === null) return;
        await runAction(btn, () => api.post(`/api/lifecycle/workflows/${btn.dataset.force}/force-close`, { note, by: 'web' }));
      });
    }
    // 跟进单（09-19）：同一任务再来一单 = 新独立 Task + relates_to 留链
    // （独立任务裁决的标准链路），不复活本单；原单任务卡可跳回。
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-follow]')) {
      btn.addEventListener('click', async () => {
        const note = await askText({ title: '跟进：同一任务的续单（挂靠本单留链）', multiline: true, placeholder: '这次要做什么/有什么变化（可空 = 同原任务）' });
        if (note === null) return;
        try {
          const parent = detail.querySelector<HTMLElement>('.wf-head h2')?.textContent?.trim() ?? '';
          const r = await api.post<{ workflow: { id: string } }>('/api/lifecycle/tasks', {
            title: `跟进：${parent}`,
            input: { brief: note.trim() !== '' ? note.trim() : '同原任务（见挂靠原单的任务卡）', relates_to: btn.dataset.follow ?? '' },
          });
          location.hash = `/lifecycle?w=${r.workflow.id}`;
        } catch (e) {
          alert('跟进单创建失败：' + (e instanceof Error ? e.message : String(e)));
        }
      });
    }
    // 收口：failed 尸体人工结案（下游 cancelled，审计全留）。终态不可逆——
    // 确认卡先陈述后果，备注同卡收集（信任修复 2026-09-22）。
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-close]')) {
      btn.addEventListener('click', async () => {
        const note = await askConfirm({
          title: '收口这条流水？',
          rows: [
            { k: '流水', v: w.title },
            { k: '后果', v: '收口后该单终态不可逆——下游未跑步骤全部取消，全程审计留痕' },
          ],
          confirmText: '确认收口',
          notePlaceholder: '收口备注（这段流水如何处置的，可空）',
        });
        if (note === null) return;
        await runAction(btn, () => api.post(`/api/lifecycle/workflows/${btn.dataset.close}/close`, { note, by: 'web' }));
      });
    }
    // 完成：running 单的人工结算收口——自动结算（发送+会话收尾）之外的人工
    // 立即出口（2026-09-14）。结算立即终态不可逆，确认卡陈述后果。
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-settle]')) {
      btn.addEventListener('click', async () => {
        const note = await askConfirm({
          title: '完成并结算这条流水？',
          rows: [
            { k: '流水', v: w.title },
            { k: '后果', v: '结算后本单立即终态（completed），在跑的步与 run 一并收口——不可逆' },
          ],
          confirmText: '确认结算',
          notePlaceholder: '备注（可空）',
        });
        if (note === null) return;
        await runAction(btn, () => api.post(`/api/lifecycle/workflows/${btn.dataset.settle}/settle`, { note, by: 'web' }));
      });
    }
    // 驳回回修：二选一——执行层回修（feedback 注入前一步重做）或方向修正
    // （feedback 进下次理解的任务卡顶格，重新理解后走新执行）。都必填：
    // 空驳回让重修变成重掷骰子（0913 PPT v3 事故）。
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-rework]')) {
      btn.addEventListener('click', async () => {
        const kind = await askChecks('驳回类型——你要修正的是哪一层?', [
          { id: '回修', label: '执行错了：方向对，做法/产物要改（feedback 注入重做同一工序）' },
          { id: '方向修正', label: '方向错了：诉求/形态本身要变（重新理解，feedback 是新输入）' },
        ]);
        if (kind === null || kind.length === 0) return;
        const isDirection = kind[0] === '方向修正';
        const feedback = await askText({
          title: isDirection ? '方向修正——新的要求是什么？（将作为最高优先输入重新理解）' : '回修——哪里不对，怎么改？（必填，agent 照此重做）',
          multiline: true,
        });
        if (feedback === null || feedback.trim() === '') {
          alert('修改意见必填——空驳回无法指导重修。');
          return;
        }
        if (isDirection) {
          // 方向修正：本单以修正意见收口归档，新意见起独立单（relates_to 链回）。
          const w = d.workflow;
          await runAction(btn, async () => {
            await api.post(`/api/lifecycle/steps/${btn.dataset.rework}/resolve`, { note: `方向修正→另起:${feedback}`, by: 'web' });
            await api.post('/api/lifecycle/tasks', {
              title: `〔方向修正〕${w.title}`,
              input: { relates_to: w.id, direction: feedback },
            });
          });
        } else {
          await runAction(btn, () => api.post(`/api/lifecycle/steps/${btn.dataset.rework}/rework`, { feedback, by: 'web' }));
        }
      });
    }
    // 插话纠偏（一等端点）：投递+留痕一体——step input 干预史/时间线/事件
    // 三处可查，不再是无账本的裸 send-keys。
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-intervene2]')) {
      btn.addEventListener('click', async () => {
        const text = await askText({ title: `插话给 @${btn.dataset.sess}（claude 将在本轮后读取；紧急打断请进会话终端）`, multiline: true, placeholder: '例如：跳过 XX，只做 YY；注意别动 ZZ 文件' });
        if (text === null || text.trim() === '') return;
        await runAction(btn, () => api.post(`/api/lifecycle/steps/${btn.dataset.intervene2}/intervene`, { text, by: 'web' }));
      });
    }
    // 干预重试：改指令/改会话再重跑（agent/verify/llm 失败步）。改派会话走
    // 下拉选择（2026-09-28 用户口令「list 选择，不是自己填写」）——声明表
    // 是合法路由目标全集，手填要记名字还易踩近匹配绑定守卫。
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-intervene]')) {
      btn.addEventListener('click', async () => {
        const sid = btn.dataset.intervene ?? '';
        const st = steps.find((x) => x.id === sid);
        if (!st) return;
        const plan0 = typeof st.input?.['plan'] === 'string' ? st.input['plan'] : typeof st.input?.['prompt'] === 'string' ? st.input['prompt'] : '';
        const plan = await askText({ title: '修改执行指令（重跑前覆写；留空 = 不改）', value: plan0, multiline: true }) ?? '';
        // 声明会话清单（graph API：声明×活态×占用一张表）——取不到时退回
        // 手填（接口异常不堵死干预入口）。
        let session = '';
        const cur = sessionOf(st);
        try {
          const g = await api.get<{ nodes: { name: string; live?: boolean; working?: boolean; company?: string }[] }>('/api/agents/graph');
          const opts = g.nodes.map((n) => ({
            value: n.name,
            label: `${n.name}${n.working ? ' · 干活中' : n.live ? ' · 在位' : ' · 休眠'}${n.company ? `（${n.company}）` : ''}`,
            selected: n.name === cur,
          }));
          if (opts.length > 0) {
            const picked = await askSelect({
              title: '改派会话（下拉选择）',
              options: opts,
              keepValue: '', keepLabel: '不改（保持原会话）',
            });
            if (picked === null) return; // 取消整个干预
            session = picked;
          }
        } catch { session = await askText({ title: '改派会话（清单不可用，手填；留空 = 不改）', value: cur }) ?? ''; }
        const patch: Record<string, string> = {};
        if (plan.trim() !== '' && plan !== plan0) patch['plan'] = plan;
        if (session !== '' && session !== cur) patch['session'] = session;
        await runAction(btn, () => api.post(`/api/lifecycle/steps/${sid}/retry`, { by: 'web', ...patch }));
      });
    }
    // 补料：缺 input 冻死/守卫拒发的合法修正窗口。候选值由引擎从关联单推导
    // 预填——人的记忆不进防线，人只裁断不当检索器。补齐后该步自动重跑。
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-amend]')) {
      btn.addEventListener('click', async () => {
        const sid = btn.dataset.amend ?? '';
        let hints = '';
        try {
          const s = await api.get<Record<string, { value: unknown; source: string }>>(`/api/lifecycle/workflows/${d.workflow.id}/amend-suggestions`);
          const lines = Object.entries(s).map(([k, v]) => `${k} = ${String(v.value).slice(0, 90)}   （${v.source}）`);
          if (lines.length > 0) hints = `候选值（引擎已推导，复制改成 key=value 即可）：\n${lines.join('\n')}`;
        } catch { /* 尽力而为：无候选值也可手填 */ }
        const raw = await askText({
          title: '补料——每行一个 key=value，补齐后该步自动重跑（修正会记账：改前/改后/操作人）',
          multiline: true,
          placeholder: hints !== '' ? hints : '例如：in_reply_to=<message-id@qq.com>',
        });
        if (raw === null || raw.trim() === '') return;
        const patch: Record<string, string> = {};
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (t === '' || t.startsWith('候选值') || t.startsWith('（')) continue;
          const eq = t.indexOf('=');
          if (eq <= 0) continue;
          patch[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
        }
        if (Object.keys(patch).length === 0) { alert('没有可识别的 key=value 行。'); return; }
        await runAction(btn, () => api.post(`/api/lifecycle/steps/${sid}/amend`, { patch, by: 'web' }));
      });
    }
    // 打回补正（send 守卫拒发）：agent 带 feedback 重做正文，修正内容重新过闸。
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-rework-send]')) {
      btn.addEventListener('click', async () => {
        const feedback = await askText({
          title: '打回补正——哪里不对，怎么改？（agent 补正后重新过闸，批准后才发）',
          multiline: true,
          value: '内容守卫拒发：请补上 AI 披露落款（本邮件由 AI 助理答复…）并按 juli-reply 规范成文后重新交付',
        });
        if (feedback === null || feedback.trim() === '') return;
        await runAction(btn, () => api.post(`/api/lifecycle/steps/${btn.dataset.reworkSend}/rework-send`, { feedback, by: 'web' }));
      });
    }
    // 单步取消：pending/waiting_human 步的人工出口（不整单作废）——原因可空
    // 但审计留痕；取消 = null 时不动作。
    for (const btn of detail.querySelectorAll<HTMLButtonElement>('button[data-cancel]')) {
      btn.addEventListener('click', async () => {
        const note = await askText({
          title: '取消此步？仅取消该步骤，不影响其他步骤（原因可空，审计留痕）',
          multiline: true,
          placeholder: '原因（可空）',
        });
        if (note === null) return;
        await runAction(btn, () => api.post(`/api/lifecycle/steps/${btn.dataset.cancel}/cancel`, { note, by: 'web' }));
      });
    }
  };

  /** 详情头「看任务卡」锚的分组键：与看板卡同一只 taskKeyOf——同 id 才点得
   * 回（任务卡枢纽的入边）。threadId 双形状读法：列表端点是 camel
   * （threadId），详情端点是 Go 形状（thread_id）——视图里两种 w 都流过。 */
  const taskAnchorOf = (w: Workflow): string => taskKeyOf(
    {
      id: w.id,
      status: w.status,
      thread_id: w.threadId ?? (w as { thread_id?: string }).thread_id ?? undefined,
      created_at: w.createdAt ?? (w as { created_at?: string }).created_at ?? '',
    },
    tasks,
  );

  /** 任务卡：nodes 独立任务的正文（input.brief）+ 挂靠链（可点跳转）。
   * 状态在账本——brief 是创建时定的任务契约，不是"当前进展"。 */
  const taskCard = (w: Workflow): string => {
    const ti = (w.meta?.['template_input'] ?? {}) as Record<string, unknown>;
    const brief = typeof ti['brief'] === 'string' && ti['brief'] !== '' ? ti['brief'] : '';
    const rel = typeof w.meta?.['related_workflow'] === 'string' ? w.meta['related_workflow'] as string : '';
    const relUnknown = typeof w.meta?.['relates_to_unknown'] === 'string' ? w.meta['relates_to_unknown'] as string : '';
    if (brief === '' && rel === '' && relUnknown === '') return '';
    return `<div class="task-card panel" style="margin-bottom:12px;padding:12px 14px">
      ${rel !== '' ? `<div style="font-size:12px;margin-bottom:6px">↳ 挂靠：<a href="#/lifecycle?w=${esc(rel)}" style="color:var(--brand)">${esc(rel)}</a></div>` : ''}
      ${relUnknown !== '' ? `<div class="muted" style="font-size:12px;margin-bottom:6px">↳ 链标记：${esc(relUnknown)}</div>` : ''}
      ${brief !== '' ? `<pre style="margin:0;white-space:pre-wrap;font-size:12px;max-height:none">${esc(brief)}</pre>` : ''}
    </div>`;
  };

  /** 渲染 deliverable 本体：按 role 分发渲染形态。 */
  // 二进制文档不读文本（字节当文本=乱码，用户实报「打开 pptx 一堆乱码」）
  // ——带票直链交给浏览器：iOS QuickLook 预览，桌面下载给本机 Office/WPS。
  const BINARY_DOC = /\.(pptx|ppt|docx|doc|xlsx|xls|pdf|zip|key|pages|numbers)$/i;
  const renderDeliverable = async (el: HTMLElement): Promise<void> => {
    const id = el.dataset.art ?? '';
    const role = el.dataset.role ?? 'report';
    const name = el.dataset.name ?? '';
    const body = el.querySelector('.dl-body') as HTMLElement;
    if (body === null) return;
    if (name.endsWith('.eml')) {
      // 邮件物证（2026-09-21 用户报：打开 eml 一堆奇怪的东西）——MIME 原文
      // 不再怼 pre：解析出头卡+可读正文+附件清单，原文折叠为物证备查。
      body.classList.remove('muted');
      body.innerHTML = '<div class="muted" style="font-size:12px">解析邮件…</div>';
      try {
        const rawEml = await api.getText(`/api/artifacts/${encodeURIComponent(id)}/content`);
        renderEml(body, rawEml);
      } catch (e) {
        body.innerHTML = `<span class="muted">工件加载失败：${esc(String(e))}</span>`;
      }
      return;
    }
    if (role !== 'body' && BINARY_DOC.test(name)) {
      body.classList.remove('muted');
      // 凭据不进 URL（09-20 P3）：直链改走短时 HMAC share 签名
      // （POST /api/artifact/share，1h 限时）——token 不落浏览器历史/下载引用
      // 面，链接复制转发不泄凭据。share 失败如实报错，绝不回落 ?token= 裸链。
      let href = '';
      try {
        const r = await api.post<{ url: string }>('/api/artifact/share', { id });
        href = r.url;
      } catch (e) {
        body.innerHTML = `<span class="muted">取件链接获取失败：${esc(String(e))}</span>`;
        return;
      }
      // 本地打开=download 属性：浏览器落盘时保留原文件名（服务端 disposition
      // 兜底），下载项一点即由本机 WPS/PowerPoint/QuickLook 打开；浏览器预览=
      // 普通导航（iOS 内联 QuickLook，桌面等于下载）。
      body.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <a download="${esc(name)}" href="${esc(href)}" style="display:inline-block;padding:10px 14px;border:1px solid var(--c-line);border-radius:8px;background:var(--c-orange-soft);color:var(--c-orange-deep);text-decoration:none;font-size:14px">⬇ 本地打开</a>
        <a target="_blank" rel="noopener" href="${esc(href)}" style="display:inline-block;padding:10px 14px;border:1px solid var(--c-line);border-radius:8px;color:var(--c-body);text-decoration:none;font-size:14px">浏览器预览 ${esc(name)}</a>
      </div>`;
      return;
    }
    try {
      const text = await api.getText(`/api/artifacts/${encodeURIComponent(id)}/content`);
      if (role === 'body') {
        // 正文纪律：原样 pre-wrap，绝不美化——审的就是发出的每个字。
        body.classList.remove('muted');
        body.innerHTML = `<pre class="dl-body body-text">${esc(text)}</pre>`;
      } else {
        // report / data / attachment 同一分发路：attachment 合法角色（随信
        // 附件），与 report 同路渲染——html→iframe 沙箱、json→结构化、其余→pre。
        if (name.endsWith('.html') || name.endsWith('.htm')) {
          body.classList.remove('muted');
          body.innerHTML = `<iframe sandbox class="dl-frame" srcdoc="${esc(text)}"></iframe>`;
        } else if (name.endsWith('.json')) {
          // 断点十五（2026-09-20）：.json 不再怼 raw JSON——能解析就渲染
          // 键值卡（嵌套值折叠进「查看原文」），解析失败才回退原文。
          let kv = '';
          try {
            const obj = JSON.parse(text) as Record<string, unknown>;
            kv = '<div class="gc-rows">' + Object.entries(obj).map(([k, v]) => {
              const vs = typeof v === 'string' ? v : JSON.stringify(v);
              const short = vs.length > 160 ? vs.slice(0, 160) + '…' : vs;
              return `<span class="k">${esc(k)}</span><span class="v">${esc(short)}</span>`;
            }).join('') + '</div>';
            body.innerHTML = kv + '<details style="margin-top:8px"><summary class="muted" style="font-size:12px">查看原文</summary><pre class="dl-body">' + esc(JSON.stringify(obj, null, 2)) + '</pre></details>';
            return;
          } catch { /* 解析失败回退原文 */ }
          body.innerHTML = `<pre class="dl-body">${esc(text)}</pre>`;
        } else {
          body.innerHTML = `<pre class="dl-body">${esc(text)}</pre>`;
        }
      }
    } catch (e) {
      body.innerHTML = `<span class="muted">工件加载失败：${esc(String(e))}</span>`;
    }
  };
  const excerpt = (s: Step): string => {
    const o = s.output ?? {};
    const parts: string[] = [];
    if (typeof o['output'] === 'string' && o['output'] !== '') parts.push(esc(o['output'].slice(0, 160)));
    if (typeof o['draft'] === 'string' && o['draft'] !== '') parts.push('✉ ' + esc(o['draft'].slice(0, 160)));
    if (typeof o['error'] === 'string' && o['error'] !== '') parts.push('✗ ' + esc(o['error'].slice(0, 120)));
    if (typeof o['message_id'] === 'string') parts.push('↗ ' + esc(o['message_id']));
    return parts.length ? `<div class="muted" style="font-size:12px;margin-top:4px">${parts.join('<br>')}</div>` : '';
  };

  const sessionOf = (s: Step): string => {
    const v = s.input?.['resolved_session'] ?? s.input?.['session'] ?? s.input?.['_session'];
    return typeof v === 'string' ? v : '';
  };

  /** 步骤时长（板 02 时长列，mono）：started→completed；未完→now。 */
  const stepDur = (s: Step): string => {
    const rec = s as unknown as Record<string, unknown>;
    const st = typeof rec['started_at'] === 'string' ? rec['started_at'] as string : '';
    if (st === '') return '';
    const start = new Date(st).getTime();
    const endRaw = rec['completed_at'];
    const end = typeof endRaw === 'string' && endRaw !== '' ? new Date(endRaw).getTime() : Date.now();
    const mins = Math.max(0, Math.round((end - start) / 60000));
    if (mins < 60) return `${mins} 分钟`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
  };

  /** 发送闸门判定与收件人解析已收口 web/src/gates.ts（与引擎 sendSeed.ts
   * 同判据，test/gates.test.ts 对齐锁定）——此处只消费。 */

  /** 闸门审核卡（板 02）：后果陈述确认卡——收件人/主题/正文预览/检查芯片
   * 摆在确认键上方（发出的就是看到的）；批准不弹 modal，卡片即审核表面。 */
  const gateCard = (s: Step, steps: readonly Step[], w: Workflow): string => {
    const send = isSendGate(s, steps);
    const i = s.input ?? {};
    const meta = w.meta ?? {};
    // 信封（申报单）先解析：任务流收件人/主题/抄送都在这里申报（envelope.to
    // 是 wf_505578377218 事故后的一等字段——人批卡看到的地址=发信地址）。
    const env = (i['envelope'] ?? null) as { to?: string; subject?: string; in_reply_to_hint?: string; feedback_refs?: string[]; cc?: string[] } | null;
    const envTo = env !== null && typeof env.to === 'string' ? env.to.trim() : '';
    const envSubject = env !== null && typeof env.subject === 'string' ? env.subject.trim() : '';
    // 收件人单一事实源（gates.resolveRecipientOf，与引擎 resolveSendRecipient
    // 同序——test 对齐锁定）：回信流（meta.from 在位）锁定原发件人，任务流
    // =申报 envelope.to。申报与锁定冲突时按引擎语义忽略申报，卡上标黄提示
    // ——「所见即所发」的结构保证（不再回退 i['to']：引擎不读它，展示了就是骗人）。
    const from = typeof meta['from'] === 'string' ? meta['from'].trim() : '';
    const { to, overrideIgnored } = resolveRecipientOf(from, envTo);
    // 信封锁（2026-09-20 P1 回信流收口）：cc/subject 与收件人同一 meta.from
    // 判据——回信流一律 Re: 原题 + 无抄送（与引擎 seedSendFromGate 同判据，
    // 改一处必须同步另一处）；申报 cc/subject 只展示 ⚠ 警示不进实发。任务流
    // 维持 nodes 模式门（申报才生效）。
    const isNodes = meta['mode'] === 'nodes';
    const replyLocked = from !== '';
    const metaSubject = typeof meta['subject'] === 'string' ? meta['subject'] : '';
    const subj = replyLocked
      ? replySubject(metaSubject)
      : isNodes && envSubject !== ''
        ? envSubject
        : replySubject(typeof meta['subject'] === 'string' ? meta['subject'] : typeof i['subject'] === 'string' ? i['subject'] as string : '');
    const subjIgnored = replyLocked && envSubject !== '' && envSubject !== subj ? envSubject : '';
    const dl = Array.isArray(i['deliverables'])
      ? (i['deliverables'] as { id: string; name: string; view_role: string; sha256: string; summary?: string }[])
      : [];
    const body = dl.find((d) => d.view_role === 'body');
    const others = dl.filter((d) => d.view_role !== 'body');
    const draft = typeof i['draft'] === 'string' ? i['draft'] : '';
    const checks = Array.isArray(i['checks'])
      ? (i['checks'] as { name: string; status: string; detail?: string }[])
      : [];
    const ccAll = env !== null && Array.isArray(env.cc) ? (env.cc as unknown[]).filter((x): x is string => typeof x === 'string' && x !== '') : [];
    const cc = replyLocked ? [] : ccAll; // 回信流：申报 cc 不进实发（引擎同判据丢弃）
    const ccIgnored = replyLocked ? ccAll : [];
    const attN = dl.filter((d) => d.view_role === 'attachment').length;
    const ccHtml = cc.length > 0
      ? ` · 抄送 <span class="chip soft">已授权</span> ${esc(cc.join(', '))}`
      : ccIgnored.length > 0
        ? ` <span class="chip warn" title="回信流锁定原线程（meta.from）：申报抄送 ${esc(ccIgnored.join(', '))} 已被引擎忽略（envelope_cc_override_ignored 事件留痕）">⚠ 申报抄送 ${esc(ccIgnored.join(', '))} 已忽略</span>`
        : '';
    const subjWarn = subjIgnored !== ''
      ? ` <span class="chip warn" title="回信流锁定原线程（meta.from）：申报主题「${esc(subjIgnored)}」不盖原题（envelope_cc_override_ignored 事件留痕）">⚠ 申报主题已忽略</span>`
      : '';
    const rows = send ? `
      <div class="gc-rows">
        <span class="k">收件人</span><span class="v">${to === '' ? '（缺失——发送将被引擎拒绝）' : entityAnchor('customer', to, to, `客户 ${to}——点开看 TA 的全部往来`)}${to !== '' ? ' <span class="chip soft">已授权</span>' : ''}${overrideIgnored !== '' ? ` <span class="chip warn" title="申报 envelope.to=${esc(overrideIgnored)} 与原发件人不符，已被引擎忽略（envelope_override_ignored 事件留痕）">⚠ 申报收件人 ${esc(overrideIgnored)} 已忽略——回信锁定原发件人</span>` : ''}</span>
        <span class="k">主题</span><span class="v">${esc(subj)}${subjWarn}</span>
        <span class="k">线程头</span><span class="v mono">${esc(env?.in_reply_to_hint ?? '—')}</span>
        <span class="k">附件</span><span class="v">${attN} 个${ccHtml}</span>
      </div>` : '';
    const preview = body !== undefined
      ? `<div class="gc-preview"><div class="deliverable" data-art="${esc(body.id)}" data-role="body" data-name="${esc(body.name)}"><div class="dl-body muted">加载中…</div></div></div>`
      : draft !== ''
        ? `<div class="gc-preview"><pre>${esc(draft.slice(0, 600))}${draft.length > 600 ? '\n…' : ''}</pre></div>`
        : send ? '<p class="muted" style="font-size:12px">（无正文工件——缺交付契约，勿盲批）</p>' : '';
    const checksHtml = checks.length > 0
      ? `<div class="gc-checks">${checks.map(checkChip).join('')}</div>`
      : '<span class="muted" style="font-size:12px">（引擎未附自检结果）</span>';
    const othersHtml = others.length > 0
      ? `<div class="gc-col-h">交付工件（登记后不可变）</div>
         <div class="deliverables">${others.map((d) => `
        <div class="deliverable" data-art="${esc(d.id)}" data-role="${esc(d.view_role)}" data-name="${esc(d.name)}">
          <div class="dl-head"><span class="chip kind">${esc(d.view_role)}</span> <strong>${esc(d.name)}</strong>
            <span class="muted" style="font-size:11px">sha256 ${esc(d.sha256.slice(0, 6))}…${d.summary ? ' · ' + esc(d.summary) : ''}</span></div>
          <div class="dl-body muted">加载中…</div>
        </div>`).join('')}
      </div>` : '';
    return `
    <div class="gate-card">
      <div class="gc-title">${send ? '✉ 发送闸门 · 等待你的决定' : `◆ ${esc(s.title)} · 等待你的决定`}</div>
      <div class="gc-sub">这是当前唯一需要人处理的卡片${(() => {
        const d = gateDeliveryOf(i);
        if (!send && d === 'apply') return ' <span class="chip soft" title="批准后 agent 按 plan 直接生效（动 site/账本等），答复走 feedback 面板/工件——无邮件">交付：apply · 批准=生效（无邮件）</span>';
        if (!send && d === 'artifact') return ' <span class="chip soft" title="交付物已是工件，批准即确认收货——无下游动作、无邮件">交付：artifact · 纯确认（无邮件）</span>';
        return '';
      })()}</div>
      <div class="gc-notice">${send
        ? '<strong>不可撤销</strong>——批准后邮件将按下方渲染内容真实寄出（引擎按哈希锁定，发出的就是看到的）'
        : '<strong>确认即继续</strong>——批准 = 按当前理解推进下游；修正并确认 = 你的修正升新工件，下游锚定人定稿版本'}</div>
      ${rows}
      ${preview !== '' ? '<div class="gc-col-h">正文预览</div>' : ''}
      ${preview}
      <div class="gc-col-h">${send ? '发送检查' : '检查'}${checks.length > 0 ? ' <span class="muted" style="font-weight:400">（引擎自动对账）</span>' : ''}</div>
      ${checksHtml}
      ${othersHtml}
      ${actions(s, steps)}
    </div>`;
  };

  /** 决定区（板 02）：主动作通栏 primary、与反向动作物理分组；底部两行
   * 动作语义注记（micro）——语义先于选项，人先知道按钮意味着什么。
   * 可用动词 = step-actions.ts 矩阵（kind×status 单一判定源），此处只渲染。 */
  const actions = (s: Step, steps: readonly Step[]): string => {
    const d = decideStepActions(s, sessionOf, { sendGate: isSendGate(s, steps) });
    const row = (inner: string): string => `<div class="row" style="margin-top:6px">${inner}</div>`;
    switch (d.branch) {
      case 'gate': {
        // 问询闸门（2026-09-28 选择题）：点选项=回答（note=reply 回流 agent
        // 会话续跑）——不做「批准」，这是答题不是放行。
        const qopts = Array.isArray((s.input as Record<string, unknown> | undefined)?.['question_options'])
          ? ((s.input as Record<string, unknown>)['question_options'] as { label: string; reply: string }[])
          : null;
        if (qopts !== null && qopts.length > 0) {
          return `<div class="ga-primary-v3">
        <div class="gc-col-h">问询——点选即回答（答案回流 agent 会话，任务续跑）</div>
        <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:4px">
          ${qopts.map((o) => `<button class="btn-primary" data-answer="${esc(o.reply)}" data-step="${esc(s.id)}" style="flex:0 0 auto">${esc(o.label)}</button>`).join('')}
          <button class="ghost" data-answer-custom="${esc(s.id)}" title="开放题自由回答">自定义回答…</button>
        </div>
        <div class="gc-notes">agent 在会话里等这个答案（问题全文见上方卡面）。点选项=把编号/答案发回它的会话；自定义=任意文本。它在收到回答前不做任何事。</div>
      </div>`;
        }
        return `<div class="ga-primary-v3">
        ${d.send
          ? `<button class="btn-primary btn-send" data-action="approve" data-step="${esc(s.id)}">批准并发送</button>`
          : `<button class="btn-primary" data-action="approve" data-step="${esc(s.id)}">批准</button>`}
        <div class="ga-secondary">
          <button class="danger" data-action="deny" data-step="${esc(s.id)}" title="中止：整条流水作废（终态，审计留痕）">拒绝（终态）</button>
          <button class="ghost" data-action="resolve" data-step="${esc(s.id)}" title="已在别处办结：下游取消，流水收尾">解决（级联）</button>
          ${d.send
            ? `<button class="ghost" data-schedule="${esc(s.id)}" title="时差礼仪：决定现在做，发出可定档（默认明天 09:00）">定时发送</button>
               <button class="ghost" data-amend="${esc(s.id)}" title="补 input 缺料（引擎预填候选值），补齐自动重跑">补料</button>`
            : `<button class="ghost" data-align="${esc(s.id)}" title="你的修正升新工件，下游锚定人定稿版本">修正并确认</button>`}
          <button class="ghost" data-rework="${esc(s.id)}" title="带引文回修上一步，流程不断">驳回重修</button>
        </div>
        <div class="gc-notes">${d.send
          ? '批准并发送 = 按上方渲染内容真实寄出，引擎按哈希锁定——发出的就是看到的。<br>拒绝（终态）整单作废；解决（级联）= 已在别处办结，下游取消；驳回重修带反馈回修，流程不断。'
          : '批准 = 按当前理解继续；修正并确认 = 修正升新工件（下游只认人定稿）；驳回重修 = 带引文回修。<br>拒绝（终态）整单作废；解决（级联）下游取消收尾。'}</div>
      </div>`;
      }
      case 'failed': {
        // 内容守卫拒发（缺披露/空正文/红线）：盲重试是死循环（引擎也会拒）——
        // 换「打回补正」与「补料修正」两条真出路。
        if (d.guard !== '') {
          return row(`<button class="mini" data-rework-send="${esc(s.id)}">打回补正</button>` +
            `<button class="mini ghost" data-amend="${esc(s.id)}">补料修正</button>`) +
            `<div class="hint-line">内容守卫（${esc(d.guard)}）拒发——重试不会变好：打回 agent 补正后重新过闸，或直接补正文/披露行</div>`;
        }
        return row(`<button class="mini ghost" data-action="retry" data-step="${esc(s.id)}">重试</button>` +
          `<button class="mini ghost" data-amend="${esc(s.id)}">补料</button>` +
          (d.actions.includes('intervene') ? `<button class="mini" data-intervene="${esc(s.id)}">干预重试</button>` : ''));
      }
      case 'running-agent':
        return d.interveneSession !== ''
          ? row(`<button class="mini ghost" data-intervene2="${esc(s.id)}" data-sess="${esc(d.interveneSession)}">插话纠偏</button>`)
          : '';
      case 'cancellable':
        // 单步取消：pending/waiting_human 步的人工出口——卡死/不再需要的步骤
        // 就地取消，不牵连整单。gate-waiting 已被 gate 分支接走（有批准/拒绝组），
        // 闸门不加取消。
        return row(`<button class="mini ghost" data-cancel="${esc(s.id)}">取消此步</button>`);
      default:
        return '';
    }
  };

  await load();
  // Enter 两段式（§4 键盘纪律）：有闸门确认卡时，第一次 Enter 聚焦「批准」
  // 键（不动作），第二次 Enter 才确认——键盘路径同样先看见后果。
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter') return;
    const tag = document.activeElement?.tagName ?? '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // 输入框里 Enter 属于输入，不劫持
    const btn = detail.querySelector<HTMLButtonElement>('.btn-primary[data-action="approve"]');
    if (btn === null || btn.disabled || document.activeElement === btn) return;
    e.preventDefault();
    btn.focus();
  };
  document.addEventListener('keydown', onKey);
  // 深链（总览/推送跳入）：#/lifecycle?w=ID 直接选中并展开详情。
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const deep = q.get('w');
  if (deep !== null && deep !== '') {
    selected = deep;
    for (const x of list.querySelectorAll('.wf-item')) {
      x.classList.toggle('active', (x as HTMLElement).dataset.id === selected);
    }
    await showDetail(deep);
  }
  // 实时刷新：4s 轮询，按【状态签名】（流水状态+各步状态）变化才重渲染。
  // 旧实现只看节点数增长——完成翻转恰恰节点数不变只变状态，导致界面永远
  // 卡在"运行中"（2026-09-12 事故：后端已 completed，app 显示未完成）。
  let lastSel = '';
  let lastSig = '';
  const timer = setInterval(async () => {
    if (selected === '' || document.hidden) return;
    try {
      const d = await api.get<{ workflow: Workflow; steps: Step[] }>(`/api/lifecycle/workflows/${selected}`);
      const sig = `${d.workflow.status}|${d.steps.map((x) => x.status).join(',')}`;
      if (selected !== lastSel) { lastSel = selected; lastSig = sig; return; } // 换选先建基线
      if (sig === lastSig) return;
      lastSig = sig;
      await showDetail(selected); // 滚动/展开态由 showDetail 保持
      await load();
    } catch { /* 网络抖动跳过本轮 */ }
  }, 4000);
  return () => { clearInterval(timer); document.removeEventListener('keydown', onKey); };
};
