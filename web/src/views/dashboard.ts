// 总览（板 01）：待决闸门永远是第一视觉焦点——队列置顶、全页唯一橘色
// 强调区（Zeigarnik 第一公民）；下接 4 状态卡、最近流水（点穿）、实时
// 事件（SSE 驱动，无刷新按钮）。空闸门 = 「都办完了。」的清零奖赏时刻。

import { api, type LedgerEvent, type Workflow } from '../api.ts';
import { subscribeEvents } from '../sse.ts';
import { esc } from '../esc.ts';
import { colHref, entityAnchor } from '../anchors.ts';
import { statusDot, statusChip, statCard, panelHead } from '../ui.ts';
import { askText } from '../dialog.ts';
import { EVENT_CLASS, isHumanEvent, STATE_CHANGING_EVENTS } from '../events-meta.ts';
import { KANBAN_ARCHIVE_KEY, KANBAN_WAITING_KEY, currentStepOf } from '../statuses.ts';
import { buildTaskCards, countByColumn, taskColumnOf } from '../task-model.ts';
import { checkChip, isSendGate } from '../gates.ts';

// 兼容既有导入面：九个视图从这里 re-import esc（历史路径，勿断）。
export { esc };

/** 闸门队列行（/api/lifecycle/steps 的 {step, workflow} 形状，snake_case）。 */
interface GateRow {
  readonly step: {
    readonly id: string; readonly workflow_id?: string; readonly seq?: number;
    readonly kind?: string; readonly title?: string; readonly status: string;
    readonly updated_at?: string;
    readonly input?: Readonly<Record<string, unknown>>;
  };
  readonly workflow?: { readonly id: string; readonly title: string; readonly kind: string; readonly status: string };
}

/** 全量步骤（当前步/闸门序数推导用，limit=200）。 */
interface StepRow extends GateRow { readonly step: GateRow['step'] }

/** workflows2 行（snake_case + thread_id/waiting_steps）：任务读模型输入面。 */
interface GoWf {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly kind: string;
  readonly session?: string;
  readonly thread_id?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly created_at: string;
  readonly updated_at?: string;
  readonly waiting_steps?: number;
}

/** /api/lifecycle/task-map（Task 投影）：任务卡归属面（buildTaskCards 输入）。 */
interface TaskMap {
  readonly tasks: readonly { readonly id: string; readonly title: string; readonly status: string; readonly workflow_ids: readonly string[] }[];
  readonly map: Readonly<Record<string, string>>;
}

/** 等待时长（自 updated_at 起算）：分钟粒度，mono 呈现。 */
const waitSince = (iso: string | undefined): string => {
  if (iso === undefined || iso === '') return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `等 ${mins} 分钟`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m === 0 ? `等 ${h} 小时` : `等 ${h} 小时 ${m} 分`;
};

/** 状态会变的事件 → 节流重载闸门队列/状态卡/流水表（SSE 驱动，无刷新按钮）；
 * 白名单 = events-meta.ts STATE_CHANGING_EVENTS（事件元数据单一源）。 */

export const dashboardView = async (el: HTMLElement): Promise<() => void> => {
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  // 内部事件折叠计数：load() 按当前窗口重计，SSE 到达的内部事件实时 +1。
  let internalCount = 0;
  // 发单快捷条草稿（js-261006-s0msv9）：load() 会被 SSE 节流重跑重渲，
  // 输入到一半的字不能被冲掉——qcDraft 跨重渲存活。
  let qcDraft = '';

  const load = async (): Promise<void> => {
    // 窗口与看板对齐（limit=100）。数据源 workflows2（带 thread_id/waiting_steps，
    // 任务读模型的输入面）+ task-map：统计卡换【任务口径】——与看板列同一
    // 读法（task-model.buildTaskCards + taskColumnOf），「进行中 N」两处数字
    // 物理同源；run 形状经 map 兼容既有消费面（闸门发件人/最近流水表）。
    // 拉取失败（P1-7）：显性失败面+重试——此前=永久「加载中…」（本视图无
    // 轮询定时器，服务重启/隧道断开后不重导航永不恢复）。
    let data: [{ workflows: GoWf[] }, { events: LedgerEvent[] }, { steps: GateRow[] }, { steps: StepRow[] }, TaskMap];
    try {
      data = await Promise.all([
        api.get<{ workflows: GoWf[] }>('/api/lifecycle/workflows2?limit=100'),
        api.get<{ events: LedgerEvent[] }>('/api/lifecycle/events?limit=30'),
        api.get<{ steps: GateRow[] }>('/api/lifecycle/steps?status=waiting_human&limit=20'),
        api.get<{ steps: StepRow[] }>('/api/lifecycle/steps?limit=200'),
        api.get<TaskMap>('/api/lifecycle/task-map'),
      ]);
    } catch (e) {
      el.innerHTML = `
        <section class="panel">
          <p>加载失败：${esc(e instanceof Error ? e.message : String(e))}</p>
          <button class="mini" id="retry">重试</button>
        </section>`;
      el.querySelector('#retry')?.addEventListener('click', () => void load());
      return;
    }
    const [wfsRes, evsRes, waitRes, allRes, taskRes] = data;
    const goWfs = wfsRes.workflows;
    // 最近流水沿用产品裁决：已取消不回流总览（走看板归档折叠区）。
    const wfs: Workflow[] = goWfs.filter((g) => g.status !== 'cancelled').map((g) => ({
      id: g.id, kind: g.kind, title: g.title, status: g.status,
      session: g.session ?? '', project: '', meta: g.meta ?? {}, createdAt: g.created_at,
    }));
    const events = evsRes.events;
    internalCount = events.filter((e) => !isHumanEvent(e.type)).length;
    const gates = waitRes.steps;
    const allSteps = allRes.steps;
    // 任务口径统计：列键计数（归档除外，同旧「已取消不设卡」裁决）。
    // 进行中 = running + waiting 列（产品裁决：等人也是进行中；等你决定的
    // 专属入口=顶部闸门卡与看板等你决定列，统计卡 sub 里给分项数对账）。
    const tasks = buildTaskCards(goWfs, taskRes).filter((t) => taskColumnOf(t) !== KANBAN_ARCHIVE_KEY);
    const taskCounts = countByColumn(tasks);
    const runningN = (taskCounts['running'] ?? 0) + (taskCounts[KANBAN_WAITING_KEY] ?? 0);
    const waitingN = taskCounts[KANBAN_WAITING_KEY] ?? 0;
    // 按 workflow 分组：当前步 + 第几道闸（同单 seq 更小的 gate 计数）。
    // 组内按 seq 升序——isSendGate 的结构判据（steps[seq]=后继）依赖此序。
    const byWf = new Map<string, StepRow[]>();
    for (const r of allSteps) {
      const wid = r.step.workflow_id ?? r.workflow?.id ?? '';
      if (wid === '') continue;
      const arr = byWf.get(wid); if (arr === undefined) byWf.set(wid, [r]); else arr.push(r);
    }
    for (const arr of byWf.values()) arr.sort((a, b) => (a.step.seq ?? 0) - (b.step.seq ?? 0));
    const gateOrdinal = (wid: string, seq: number): number =>
      (byWf.get(wid) ?? []).filter((r) => r.step.kind === 'gate' && (r.step.seq ?? 0) < seq).length + 1;
    const currentOf = (wid: string): StepRow | undefined => currentStepOf(byWf.get(wid) ?? []);

    // 任务口径今日办成：相位=已完成 且该任务最新一次成员活动在今天。
    const today = new Date().toDateString();
    const doneToday = tasks.filter((t) => {
      if (taskColumnOf(t) !== 'completed') return false;
      const last = t.runs.map((r) => r.updated_at ?? '').filter((s) => s !== '').sort().at(-1);
      return last !== undefined && new Date(last).toDateString() === today;
    }).length;
    const oldestWait = gates.length > 0
      ? waitSince(gates.map((g) => g.step.updated_at ?? '').filter((s) => s !== '').sort()[0]) : '';

    el.innerHTML = `
      <section class="panel dash-compose">
        <div class="kicker">// NEW TASK</div>
        <div class="dash-compose-row">
          <input id="qc-input" type="text" placeholder="有事要办？说一句话，juli 开单助手帮你成单" />
          <button class="btn-primary" id="qc-go" type="button">发单 →</button>
        </div>
      </section>
      <section class="panel gate-queue">
        <div class="kicker">// GATES QUEUE</div>
        <h1 class="h-display">等待你的决定${gates.length > 0 ? ` <span class="chip soft">${gates.length}</span>` : ''}</h1>
        ${gates.length > 0 ? `
          <div class="gq-list">
            ${gates.slice(0, 5).map((g, i) => {
              const wid = g.workflow?.id ?? '';
              const seq = g.step.seq ?? 0;
              const from = wfs.find((w) => w.id === wid);
              const senderRaw = from !== undefined && typeof from.meta['from'] === 'string' ? from.meta['from'] : '';
              // 发件人=实体锚点（来源链）：点开客户页看 TA 的全部往来。
              const sender = senderRaw !== '' ? `发件人 ${entityAnchor('customer', senderRaw, senderRaw)} · ` : '';
              // 发送语义判据 = gates.isSendGate 完整版（delivery 显式申报优先 +
              // 结构后继 + 标题/envelope.to 兜底）——与 lifecycle 详情卡同源；
              // 旧残缺版（只认标题）曾让 delivery=email 的闸门在总览被直批。
              const send = isSendGate(g.step, (byWf.get(wid) ?? []).map((r) => r.step));
              const checks = Array.isArray(g.step.input?.['checks'])
                ? (g.step.input['checks'] as { name: string; status: string }[]) : [];
              // 移动端 hero（板 06）：首闸展开为审核主卡——收件人/检查行/不可撤销
              // 提示 + 拇指区宽钮；桌面隐藏（板 01 行式呈现）。
              const mob = i === 0 ? `
                <div class="gq-mob">
                  ${senderRaw !== '' ? `<div class="gq-mob-row"><span class="k">收件人</span><span class="v">${esc(senderRaw)}</span></div>` : ''}
                  ${checks.length > 0 ? `<div class="gq-mob-row"><span class="k">检查</span><span class="gq-mob-checks">${checks.map(checkChip).join('')}</span></div>` : ''}
                  ${send ? '<div class="gc-notice gq-mob-notice"><strong>不可撤销</strong>——批准后邮件真实寄出</div>' : ''}
                </div>` : '';
              return `
              <div class="gq-row" data-w="${esc(wid)}" role="link" tabindex="0">
                ${statusDot('waiting_human')}
                <div class="gq-main">
                  <div class="gq-title">${esc(g.workflow?.title ?? '(流水已结)')}<span class="gq-kind"> · ${esc(g.step.title ?? '')}</span></div>
                  <div class="gq-sub">${sender}第 ${gateOrdinal(wid, seq)} 道闸</div>
                  ${mob}
                </div>
                <span class="gq-wait">${esc(waitSince(g.step.updated_at))}</span>
                <button class="mini j-ghost" data-act="deny" data-id="${esc(g.step.id)}">拒绝</button>
                <button class="mini j-primary${send ? ' gq-approve' : ''}" data-act="approve" data-id="${esc(g.step.id)}" data-send="${send ? '1' : '0'}">${send ? '批准并发送' : '批准'}</button>
                <span class="gq-go" aria-hidden="true">详情 →</span>
              </div>`;
            }).join('')}
            ${gates.length > 5 ? `<div class="gq-more">还有 ${gates.length - 5} 个，进「流水」看全部</div>` : ''}
          </div>`
        : `<div class="empty-done"><span class="dot st-completed" aria-hidden="true"></span>都办完了。</div>
           <p class="empty-done-sub">没有等你决定的事——去看 <a href="#/kanban">看板</a> 或 <a href="#/usage">用量</a>。</p>`}
      </section>

      <div class="dash-stats">
        ${statCard({ label: '待人工闸门', num: gates.length, status: 'waiting_human', badge: gates.length > 0 ? '需处理' : undefined, sub: oldestWait, href: `#${colHref(KANBAN_WAITING_KEY)}`, title: '去看板「等你决定」列——按任务口径看这批事（闸门数与任务数粒度不同：一事可有多闸）' })}
        ${statCard({ label: '排队中', num: taskCounts['queued'] ?? 0, status: 'queued', sub: (taskCounts['queued'] ?? 0) > 0 ? '收单台 FIFO' : '—', href: `#${colHref('queued')}`, title: '只看「排队中」的任务' })}
        ${statCard({ label: '进行中', num: runningN, status: 'running', sub: runningN > 0 ? `含等你决定 ${waitingN} · 自动推进中` : '空闲', href: `#${colHref('running')}`, title: `只看「进行中」的任务（等你决定 ${waitingN} 件见首卡与等你决定列）` })}
        ${statCard({ label: '失败', num: taskCounts['failed'] ?? 0, status: 'failed', sub: (taskCounts['failed'] ?? 0) > 0 ? '需要看一眼' : '—', href: `#${colHref('failed')}`, title: '只看「失败」的任务' })}
        ${statCard({ label: '已完成', num: taskCounts['completed'] ?? 0, status: 'completed', sub: `今日 +${doneToday}`, href: `#${colHref('completed')}`, title: '只看「已完成」的任务' })}
      </div>

      <div class="dash-bottom">
        <section class="panel">
          ${panelHead('RECENT', '最近流水')}
          <div id="wf-list">${wfTable(wfs.slice(0, 10), currentOf)}</div>
          <p class="hint-line table-hint">点穿任意行 → 流水详情</p>
        </section>
        <section class="panel">
          ${panelHead('LIVE EVENTS', '实时事件', '<span class="live-flag" id="live-flag"><span class="dot" aria-hidden="true"></span>LIVE</span>')}
          <div class="feed" id="feed">${renderFeed(events)}</div>
        </section>
      </div>`;

    const feed = el.querySelector<HTMLElement>('#feed');
    if (feed !== null) feed.scrollTop = feed.scrollHeight;

    // 点穿：行/详情 → 流水详情；拒绝/批准就地动作。锚点（发件人/状态等
    // 实体导航）豁免——点锚点走锚点的路，不与点穿抢。
    for (const row of el.querySelectorAll<HTMLElement>('.gq-row, #wf-list tr[data-w]')) {
      const go = (): void => {
        const w = row.dataset.w ?? '';
        if (w !== '') location.hash = `/lifecycle?w=${w}`;
      };
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('a') !== null) return;
        const btn = (e.target as HTMLElement).closest('button[data-act]');
        if (btn === null) { go(); return; }
        e.stopPropagation();
        void act(btn as HTMLButtonElement, row.querySelector('.gq-sub'));
      });
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    }

    // 发单快捷条（js-261006-s0msv9 用户裁定：发单高频，主页直达）——带草稿
    // 跳 #/chat 预填聚焦；对话逻辑仍只活在 chat 视图一处，不复制。
    const qc = el.querySelector<HTMLInputElement>('#qc-input');
    if (qc !== null) {
      qc.value = qcDraft;
      qc.addEventListener('input', () => { qcDraft = qc.value; });
      const qcGo = (): void => {
        const t = qc.value.trim();
        location.hash = t === '' ? '/chat' : `/chat?draft=${encodeURIComponent(t)}`;
      };
      qc.addEventListener('keydown', (e) => { if (e.key === 'Enter') qcGo(); });
      el.querySelector('#qc-go')?.addEventListener('click', qcGo);
    }
  };

  // 拒绝 = 直接终态；批准：发送闸门点穿确认卡（无确认卡不得直发），其余直批。
  const act = async (btn: HTMLButtonElement, errSlot: Element | null): Promise<void> => {
    const id = btn.dataset.id ?? '';
    const action = btn.dataset.act === 'deny' ? 'deny' : 'approve';
    if (action === 'approve' && btn.dataset.send === '1') {
      const row = btn.closest<HTMLElement>('.gq-row');
      const w = row?.dataset.w ?? '';
      if (w !== '') location.hash = `/lifecycle?w=${w}`;
      return;
    }
    // 拒绝=整单作废（不可逆）：与流水详情同款必填理由防呆（P1-8）——空理由
    // 不发 POST，note 随 body 审计留痕。弹层期间背景 inert（dialog 家族），
    // 无双击面，在途禁用移到弹层之后。
    let note = '';
    if (action === 'deny') {
      const r = await askText({ title: '拒绝理由（必填——整单作废，审计留痕）' });
      if (r === null || r.trim() === '') return;
      note = r.trim();
    }
    btn.disabled = true;
    try {
      await api.post(`/api/lifecycle/steps/${id}/${action}`, { note, by: 'operator' });
      await load();
    } catch (e) {
      btn.disabled = false;
      if (errSlot !== null) errSlot.innerHTML = `<span class="gq-err">${esc(e instanceof Error ? e.message : String(e))}</span>`;
    }
  };

  await load();
  // SSE 状态驱动 feed 面板的 LIVE 灯：通了亮绿，断线熄灰（只读浏览不受阻）。
  const flag = (): HTMLElement | null => el.querySelector('#live-flag');
  const close = subscribeEvents((type, data) => {
    // 状态事件节流重载——队列/状态卡/流水表与 feed 全部以服务端为准。
    if (STATE_CHANGING_EVENTS.has(type)) {
      if (reloadTimer !== undefined) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { void load(); }, 600);
      return;
    }
    const feed = el.querySelector<HTMLElement>('#feed');
    if (isHumanEvent(type)) {
      // 不在重载表的人类事件（如 email_sent）：就地补一行，下次重载与服务端对账。
      const ts = data !== null && typeof data === 'object' && typeof (data as { ts?: unknown }).ts === 'string'
        ? (data as { ts: string }).ts : new Date().toISOString();
      feed?.insertAdjacentHTML('beforeend', feedRow({ ts, type } as LedgerEvent));
    } else {
      // 内部事件不逐条刷屏：折叠行实时累计（重载时按窗口重计）。
      const more = el.querySelector('#feed-more');
      if (more !== null) {
        internalCount += 1;
        more.textContent = `+ ${internalCount} 条内部事件`;
      }
    }
    if (feed !== null) feed.scrollTop = feed.scrollHeight;
  }, () => { flag()?.classList.add('on'); }, () => { flag()?.classList.remove('on'); });
  return () => { if (reloadTimer !== undefined) clearTimeout(reloadTimer); close(); };
};

const wfTable = (wfs: readonly Workflow[], currentOf: (wid: string) => StepRow | undefined): string => {
  if (wfs.length === 0) return '<p class="muted">暂无流水——注入一封邮件或从「模板」手动起流。</p>';
  return `<table>
    <tr><th>标题</th><th>状态</th><th>类型</th><th>当前步</th><th>创建</th></tr>
    ${wfs.map((w) => {
      const cur = currentOf(w.id);
      const curHtml = cur === undefined ? '<span class="muted">—</span>'
        : `${statusDot(cur.step.status)}<span class="cur-step">${esc(cur.step.title ?? cur.step.kind ?? '')}</span>`;
      // 实体锚点小字行（执行链+来源链）：与看板任务卡同款锚，最近流水也无死字。
      // 状态 chip 不加锚：这是 run 状态不是任务相位——锚到看板相位列会「落点
      // 找不到该卡」（任务在跑、成员已完成的常态场景），相位导航归看板任务卡。
      const from = typeof w.meta['from'] === 'string' ? w.meta['from'] : '';
      const anchors = [
        w.session !== '' ? entityAnchor('session', w.session, `@${w.session}`, `会话 ${w.session}`) : '',
        from !== '' ? entityAnchor('customer', from, from, `客户 ${from}`) : '',
      ].filter((s) => s !== '').join('<span class="tbl-anchor-sep"> · </span>');
      return `<tr class="clickable" data-w="${esc(w.id)}" title="点开流水详情">
        <td>${esc(w.title)}${anchors !== '' ? `<div class="tbl-anchors">${anchors}</div>` : ''}</td>
        <td>${statusChip(w.status)}</td>
        <td class="muted">${esc(w.kind)}</td>
        <td>${curHtml}</td>
        <td class="mono muted">${esc(w.createdAt.slice(5, 16).replace('T', ' '))}</td>
      </tr>`;
    }).join('')}
  </table>`;
};

const feedRow = (e: LedgerEvent): string => `
  <div><span class="feed-time">${esc(e.ts.slice(11, 19))}</span> <span class="${EVENT_CLASS[e.type] ?? 'evt-info'}">${esc(e.type)}</span></div>`;

/** feed 投影：对人有语义的事件逐条照显（白名单见 events-meta.ts）；内部
 * 事件（守卫/回声/逐回合 hook 流水）不逐条打扰——折叠为一行实时累计，
 * 用户裁定：把日志原文当产品内容 = 伤信任。 */
const renderFeed = (events: readonly LedgerEvent[]): string => {
  if (events.length === 0) return '<p class="muted">等待事件……注入一封测试邮件开始。</p>';
  const human = [...events].reverse().filter((e) => isHumanEvent(e.type)).map((e) => feedRow(e)).join('');
  const fold = internalFold(events.filter((e) => !isHumanEvent(e.type)).length);
  return `${human}${fold}`;
};

/** 折叠行：N=0 不渲染；hover 说明折叠的是什么。 */
const internalFold = (n: number): string =>
  n <= 0 ? '' : `<div class="feed-more muted" id="feed-more" title="机器守卫/回声类事件（self_echo_ignored、step_activity 等）不逐条打扰，此处实时累计">+ ${n} 条内部事件</div>`;
