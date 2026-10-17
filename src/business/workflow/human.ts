// 人工动作：一等插话（intervene）、补料（amendStep/amendSuggestions）、
// 发送守卫打回（reworkSend）、内容转派（handoff）、会话改派（assignSession）、
// 重试（retry）。人的修正权全在这层——快照钉死输入，这里开合法窗口。

import { rfc3339 } from '@juli-os/artifacts';
import { asString, truncate } from '../../platform/shared/json.ts'
import type { JsonRecord, JsonValue } from '@juli-os/artifacts'
import type { Logger } from '../../platform/events/bus.ts';
import type { LifecycleStore } from '@juli-os/ledger';
import { AGENT_STEP_KINDS, INSTRUCTABLE_STEP_KINDS } from '@juli-os/ledger';
import { isActiveWorkflowStatus, isSettledWorkflowStatus } from '../../contracts/statuses.ts';
import { agentLiveSessionOf } from './capabilities/index.ts';
import type { EngineDeps } from './engine.ts';
import type { Journal } from './journal.ts';
import type { Queue } from './queue.ts';
import type { AgentSettle } from './agentSettle.ts';
import type { Zombie } from './zombie.ts';

export interface HumanActions {
  intervene(stepId: string, text: string, by: string): Promise<void>;
  amendStep(stepId: string, patch: JsonRecord, by: string): Promise<void>;
  amendSuggestions(workflowId: string): JsonRecord;
  reworkSend(stepId: string, feedback: string, by: string): Promise<void>;
  handoff(workflowId: string, domain: string, reason: string, by: string): Promise<{ from: string; to: string }>;
  assignSession(workflowId: string, session: string, by: string): Promise<void>;
  retry(stepId: string, patch?: { plan?: string; prompt?: string; session?: string }, by?: string): Promise<void>;
}

export const makeHumanActions = (o: {
  readonly deps: EngineDeps;
  readonly store: LifecycleStore;
  readonly now: () => Date;
  readonly log: Logger;
  readonly withLock: <T>(workflowId: string, fn: () => Promise<T>) => Promise<T>;
  readonly journal: Journal;
  readonly queue: Pick<Queue, 'continueWorkflow'>;
  readonly agentSettle: Pick<AgentSettle, 'recordActivity'>;
  readonly zombie: Pick<Zombie, 'touchSession'>;
  /** 晚绑 advance（handoff 尾部 void advance——fire-and-forget 续推）。 */
  readonly late: { advance: (workflowId: string) => Promise<void> };
}): HumanActions => {
  const { deps, store, log } = o;
  const now = o.now;

  /** 一等插话：/api/sessions/:name/send 的裸 send-keys 没有账本、没有 step
   * 关联——插话是运营动作，必须可审计可重放。投递成功才落账：账本只记
   * 发生过的事。三处留痕：input.interventions（重放）、output.activity
   * （时间线）、step_intervened 事件（审计）。
   * 投递失败兜底（2026-09-23 插话 400 事故）：插话转持久外发箱（marker
   * 验证 + 周期补投）并落 step_intervention_deferred 事件——「人的指示到
   * 不了 agent」不再只留一个无因 400，下一回合（补投送达）必然看得到。 */
  const intervene = async (stepId: string, text: string, by: string): Promise<void> => {
    const st = store.getStep(stepId);
    if (!st) throw new Error(`step ${stepId} not found`);
    if (!AGENT_STEP_KINDS.includes(st.kind) || st.status !== 'running') {
      throw new Error(`step ${stepId} is not a running agent step (kind=${st.kind} status=${st.status})`);
    }
    const t = text.trim();
    if (t === '') throw new Error('intervention text required');
    if (!deps.sendToSession) throw new Error('no session transport configured');
    const session = agentLiveSessionOf(st);
    if (session === '') throw new Error('step has no session to intervene');
    const res = await deps.sendToSession(session, t);
    if (!res.delivered) {
      const marker = `[intervene:${st.id.slice(-6)}]`;
      const relayId = store.insertRelay({
        workflowId: st.workflowId, stepId: st.id, session,
        text: `${marker} ${t}`, marker,
      });
      store.appendEvent('step', st.id, 'step_intervention_deferred', {
        text: truncate(t, 500), by, session, reason: res.reason, relay_id: relayId,
        workflow_id: st.workflowId, kind: st.kind, seq: st.seq,
      });
      throw new Error(
        `intervention delivery failed to @${session}: ${res.reason}——已转外发箱补投（relay ${relayId}），送达后下一回合可见`,
      );
    }
    const hist = Array.isArray(st.input['interventions']) ? st.input['interventions'] : [];
    store.setStepInput(st.id, {
      interventions: [...hist, { text: t, by, at: rfc3339(now()) }],
    });
    await o.agentSettle.recordActivity(session, 'intervene', `[${by}] ${t}`);
    store.appendEvent('step', st.id, 'step_intervened', {
      text: truncate(t, 500), by, session,
      workflow_id: st.workflowId, kind: st.kind, seq: st.seq,
      ...(res.finalState === 'in_box' ? { queued: true } : {}),
    });
    o.zombie.touchSession(session);
  };

  const retry = async (stepId: string, patch?: { plan?: string; prompt?: string; session?: string }, by = 'operator'): Promise<void> => {
    const st0 = store.getStep(stepId);
    if (!st0) throw new Error(`step ${stepId} not found`);
    await o.withLock(st0.workflowId, async () => {
      // 锁内重读：等锁期间步状态可能已被 hook/对账改变。
      const st = store.getStep(stepId);
      if (!st) throw new Error(`step ${stepId} not found`);
      if (st.status !== 'failed') throw new Error(`step ${stepId} is not failed (status=${st.status})`);
      // 守卫拒发的盲重试是死循环（2026-09-14 wf_7e8c73973b61：同一 body 四连
      // 拒）：内容缺陷必须先修正——amend 补料或 reworkSend 打回；修正动作会清
      // 掉 guard 标记，retry 那时才有资格再跑。
      if (st.kind === 'send' && asString(st.output['guard']) !== '') {
        throw new Error(`内容守卫拒发（${asString(st.output['guard'])}）——盲重试不会变好：请 amend 补正文或 rework-send 打回 agent 补正`);
      }
      // 被拒绝的流水是终态：重试任何步都是绕过人工否决（推进链会跳过失败的
      // 闸门一路走到 send）。先走 reopen。
      const w = store.getWorkflow(st.workflowId);
      if (w && w.status === 'failed') {
        const reason = asString(w.meta['denied_reason']);
        if (reason !== '') throw new Error(`workflow was denied (${reason}) — reopen it before retrying`);
      }
      // 干预补丁：重臂前覆写步骤指令/会话（只对能承载指令的步开放）。
      if (patch && INSTRUCTABLE_STEP_KINDS.includes(st.kind)) {
        const input: Record<string, JsonValue> = {};
        if (patch.plan !== undefined && patch.plan.trim() !== '') input['plan'] = patch.plan;
        if (patch.prompt !== undefined && patch.prompt.trim() !== '') input['prompt'] = patch.prompt;
        if (patch.session !== undefined && patch.session.trim() !== '') input['session'] = patch.session;
        if (Object.keys(input).length > 0) {
          store.setStepInput(st.id, input);
          o.journal.stepEvent(st, 'step_patch', input);
        }
      }
      // 清掉上次失败的 error 键（output 是合并写，不清则成功后仍显示旧错）。
      store.setStepOutput(st.id, { error: null });
      store.setStepStatus(st.id, 'pending');
      if (w && w.status === 'failed') store.setWorkflowStatus(st.workflowId, 'running');
      // 重试留痕（用户实报「每一次重试具体干了什么没有痕迹」）：谁重试、
      // 带了什么干预补丁，进事件账本——与 gate_rework/send_rework 同口径。
      o.journal.stepEvent(st, 'step_retry', {
        by,
        ...(patch !== undefined ? { patch: patch as unknown as JsonRecord } : {}),
      });
      // 推进 fire-and-forget（同闸门动作壳）：重臂的执行链不进 HTTP 等待。
      o.queue.continueWorkflow(st.workflowId);
    });
  };

  /** 补料：快照把输入钉死防篡改，但也锁死了人的修正权——这是给「缺料冻死
   * （pending）」与「守卫拒发（failed）」开的合法修正窗口。三不碰：在飞步骤
   * （竞态）、终态工作流（先 reopen 语义归 retry/force-close）、_ref（模板
   * 血统不可改）。补料即记账：before/after + by 进事件链，审计靠链不靠封死。 */
  const amendStep = async (stepId: string, patch: JsonRecord, by: string): Promise<void> => {
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([k, v]) => !k.startsWith('_') && v !== null && v !== undefined),
    );
    if (Object.keys(clean).length === 0) throw new Error('amend patch is empty');
    const st0 = store.getStep(stepId);
    if (!st0) throw new Error(`step ${stepId} not found`);
    await o.withLock(st0.workflowId, async () => {
      const st = store.getStep(stepId);
      if (!st) throw new Error(`step ${stepId} not found`);
      if (st.status === 'running') throw new Error(`step ${stepId} is running — wait for it to settle before amending`);
      if (st.status !== 'pending' && st.status !== 'failed') {
        throw new Error(`step ${stepId} is ${st.status} — only pending/failed steps take amendments`);
      }
      const w = store.getWorkflow(st.workflowId);
      if (!w || isSettledWorkflowStatus(w.status)) {
        throw new Error(`workflow ${st.workflowId} is ${w?.status ?? 'gone'} — start a new run instead`);
      }
      const before: Record<string, JsonValue> = {};
      for (const k of Object.keys(clean)) before[k] = st.input[k] !== undefined ? (st.input[k]) : null;
      // 冻结类（缺模板 key 渲染失败）步骤是 pending——补齐后重臂；失败类顺手
      // 清掉上次的错误输出与守卫标记（守卫清了 retry 才有资格再跑）。
      store.setStepInput(st.id, clean);
      store.setStepOutput(st.id, { error: null, guard: null });
      store.appendEvent('workflow', st.workflowId, 'step_input_amended', {
        step: st.id, kind: st.kind, keys: Object.keys(clean), before, after: clean, by, at: rfc3339(now()),
      });
      o.journal.stepEvent(st, 'step_amended', { keys: Object.keys(clean), by });
      if (st.status === 'failed') {
        store.setStepStatus(st.id, 'pending');
        if (w.status === 'failed') store.setWorkflowStatus(st.workflowId, 'running');
      }
      log.info(`[engine] step ${st.id} amended [${Object.keys(clean).join(',')}] by ${by}`);
      o.queue.continueWorkflow(st.workflowId);
    });
  };

  /** 补料候选值：人只裁断不当检索器。来源优先级 = 本单 meta（邮件进件自带的
   * from/subject/message_id）> 关联单（relates_to/related_workflow，重发/答复
   * 场景的 in_reply_to 就躺在它的 meta.message_id 里）> 既有步骤 input。 */
  const amendSuggestions = (workflowId: string): JsonRecord => {
    const w = store.getWorkflow(workflowId);
    if (!w) throw new Error(`workflow ${workflowId} not found`);
    const out: Record<string, JsonValue> = {};
    const put = (k: string, v: JsonValue, source: string): void => {
      if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return;
      if (out[k] === undefined) out[k] = { value: v, source };
    };
    for (const k of ['from', 'subject', 'message_id'] as const) put(k, w.meta[k] ?? null, '本单 meta');
    // 关联单：起流声明的 relates_to 与引擎落账的 related_workflow 双查。
    const relId = asString(w.meta['related_workflow']) ||
      asString((w.meta['template_input'] as JsonRecord | undefined)?.['relates_to']);
    if (relId !== '') {
      const rel = store.getWorkflow(relId);
      if (rel) {
        for (const k of ['from', 'subject', 'message_id'] as const) put(k, rel.meta[k] ?? null, `关联单 ${relId}`);
      }
    }
    for (const st of store.stepsForWorkflow(workflowId)) {
      for (const k of ['to', 'subject', 'in_reply_to', 'body'] as const) {
        put(k, st.input[k] ?? null, `步骤 ${st.seq}(${st.id.slice(3, 9)}) input`);
      }
    }
    return out;
  };

  /** 发送守卫拒发的打回补正：内容缺陷（缺披露/空正文/红线）retry 永远不好
   * ——正文不在 send 步手里。复用 rework 闭环：回扫最近 agent 步带 feedback
   * 重做；中间步（share/闸门）一并退回 pending——修正后的内容必须重新过人审
   * （人审不可跳过），闸门批准后再走 send。 */
  const reworkSend = async (stepId: string, feedback: string, by: string): Promise<void> => {
    if (feedback.trim() === '') throw new Error('驳回必须写明修改意见（哪里不对/怎么改）');
    const st0 = store.getStep(stepId);
    if (!st0) throw new Error(`step ${stepId} not found`);
    await o.withLock(st0.workflowId, async () => {
      const st = store.getStep(stepId);
      if (!st) throw new Error(`step ${stepId} not found`);
      if (st.kind !== 'send') throw new Error(`step ${stepId} is not a send step`);
      if (st.status !== 'failed') throw new Error(`send step is not failed (status=${st.status})`);
      const steps = store.stepsForWorkflow(st.workflowId);
      let ai = -1;
      for (let i = st.seq - 2; i >= 0; i--) {
        if (AGENT_STEP_KINDS.includes(steps[i]!.kind)) { ai = i; break; }
      }
      if (ai < 0) throw new Error('send 步前面没有可回修的 agent 步——请用 amend 直接补正文');
      const prev = steps[ai]!;
      const hist = Array.isArray(prev.input['feedback_history']) ? prev.input['feedback_history'] : [];
      store.setStepInput(prev.id, {
        feedback, feedback_history: [...hist, feedback] as JsonValue[],
      });
      store.setStepStatus(prev.id, 'pending');
      // 中间步退回 pending：闸门重开 = 人审新版本（重开时 openGate 检测
      // feedback 强制重算 checks——修正后的正文不许沿用上一轮的绿灯）。
      for (let i = ai + 1; i <= st.seq - 2; i++) {
        const mid = steps[i]!;
        if (mid.status === 'completed' || mid.status === 'failed') {
          store.setStepStatus(mid.id, 'pending');
        }
      }
      store.setStepInput(st.id, { feedback });
      store.setStepOutput(st.id, { error: null, guard: null });
      store.setStepStatus(st.id, 'pending');
      const w = store.getWorkflow(st.workflowId);
      if (w && w.status === 'failed') store.setWorkflowStatus(st.workflowId, 'running');
      const round = Number(w?.meta['round'] ?? 1) + 1;
      store.updateWorkflowMeta(st.workflowId, { round });
      store.appendEvent('workflow', st.workflowId, 'send_rework', { step: st.id, feedback, by, round });
      o.journal.stepEvent(st, 'send_rework', { feedback, by, round });
      o.queue.continueWorkflow(st.workflowId);
    });
  };

  const assignSession = async (workflowId: string, session: string, by: string): Promise<void> => {
    const s = session.trim();
    if (s === '') throw new Error('session required');
    const steps = store.stepsForWorkflow(workflowId);
    for (const st of steps) {
      if (AGENT_STEP_KINDS.includes(st.kind) && st.status === 'running') {
        throw new Error(`agent step ${st.title} is running — wait for the turn to settle before reassigning`);
      }
    }
    // 路由记录：闸门批准读 steps[0].output.session。
    const triage = steps.find((st) => st.kind === 'triage');
    if (triage) store.setStepOutput(triage.id, { session: s });
    // 未起步的 agent/verify 跟随新路由。顺带清三字段（九跑 P1）：上次派发的
    // resolved_session（忙闲改道/别名/jev 落点快照）不清则 steps.ts 派发优先级
    // 压过人改的 input.session——改派对失败步静默失效；busy_diverted_from 是
    // 同源的改道痕迹；session_pinned=true（0930 修）：人点名即钉住——忙时不
    // 改道宁可排队（宁可慢不换人），与 ovSession 消费路径同语义；旧钉随
    // 合并写一并覆盖为新落点的钉。
    for (const st of steps) {
      if (AGENT_STEP_KINDS.includes(st.kind) &&
        (st.status === 'pending' || st.status === 'failed')) {
        store.setStepInput(st.id, {
          session: s, resolved_session: null, busy_diverted_from: null, session_pinned: true,
        });
      }
    }
    store.updateWorkflowMeta(workflowId, {
      assigned_session: s, assigned_by: by, assigned_at: rfc3339(now()),
    });
    store.appendEvent('workflow', workflowId, 'agent_assigned', { session: s, by });
  };

  /** 转派（task-handoff，2026-09-20 裁决）：agent 读懂内容发现「不归我」后的
   * 显式让渡通道——LLM 提案（domain + 理由），引擎裁决（四道校验）并执行
   * （同案卷追加执行步钉目标会话），账本记账（route_content_handoff）。
   * 绑定会话无进出权；chain 回访拒绝（防乒乓）；目标忙闲由 runAgentStep
   * 的既有选枝在 advance 时接管。物理动作 = 同一案卷追加一枚执行步，
   * 案卷不分裂、账本连续。 */
  const handoff = async (workflowId: string, domain: string, reason: string, by: string): Promise<{ from: string; to: string }> => {
    // 空 domain 显式拒绝（P2-6）：graph 端点确实产出空 domain 节点，HTTP 侧
    // 缺省 '' 时 `d.domain === domain` 会命中它们——「没说要转给谁」不该被静默解析。
    if (domain.trim() === '') throw new Error('转派必须指定业务域（domain 不能为空）');
    if (reason.trim() === '') throw new Error('转派必须写明理由（为何不归本会话）');
    return o.withLock(workflowId, async () => {
      const w = store.getWorkflow(workflowId);
      if (!w) throw new Error(`workflow ${workflowId} not found`);
      if (!isActiveWorkflowStatus(w.status)) {
        throw new Error(`workflow ${workflowId} is ${w.status} — 已结束的案卷不可转派`);
      }
      const from = w.session;
      const bound = deps.routing.boundAgents ?? [];
      if (from !== '' && bound.some((b) => b.session === from)) {
        throw new Error(`绑定会话 ${from} 无转出权（隔离纪律：专线只进不出）`);
      }
      const decls = deps.routing.agents ?? [];
      if (decls.length === 0) throw new Error('mesh 无声明（config.agents 空）——无表可查，转派不可用');
      // 目标选取：domain 命中的声明里排除绑定与当前会话；同公司优先，声明序兜底。
      const fromDecl = decls.find((d) => d.session === from);
      const cands = decls.filter((d) =>
        d.domain === domain && d.session !== from && !bound.some((b) => b.session === d.session));
      if (cands.length === 0) {
        throw new Error(
          bound.some((b) => decls.some((d) => d.session === b.session && d.domain === domain))
            ? `domain=${domain} 只由绑定会话承担（隔离纪律，不接受转派）`
            : `mesh 里没有 domain=${domain} 的非绑定 agent（可用: ${[...new Set(decls.map((d) => d.domain))].filter(Boolean).join('/') || '（空）'}）`);
      }
      const sameCompany = cands.find((d) => d.company !== '' && d.company === fromDecl?.company);
      const target = (sameCompany ?? cands[0]!).session;
      // 乒乓守卫：本单去过的会话（进门落点 + 历次转派落点）拒绝再进。
      const visited = new Set<string>();
      const rs = asString(w.meta['route_session']);
      if (rs !== '') visited.add(rs);
      if (from !== '') visited.add(from);
      // per-entity 事件查询（P2-5）：本单转派事件全史回放——listEvents(600)
      // 是全库窗口（entityId 过滤在窗口之后），事件产量大的部署里更早的
      // route_content_handoff 会落到窗外，A→B→C→A 长周期回访漏判。
      for (const e of store.entityEvents('workflow', workflowId, 'route_content_handoff')) {
        const to = asString(e.payload['to']);
        if (to !== '') visited.add(to);
      }
      if (visited.has(target)) {
        throw new Error(`乒乓守卫：${target} 已处理过本单（chain 回访拒绝），请人工裁决`);
      }
      // 追加执行步：plan 携转派理由 + 前站理解摘要（接手不重读原文）。
      const steps = store.stepsForWorkflow(workflowId);
      const lastAgent = [...steps].reverse().find((s) => s.kind === 'agent' && s.status === 'completed');
      const summary = asString(lastAgent?.output['output']) || asString(lastAgent?.output['draft']);
      const seq = (steps[steps.length - 1]?.seq ?? 0) + 1;
      store.createStep({
        workflowId, seq,
        kind: 'agent',
        title: `转派执行 · ${domain}`,
        input: {
          session: target,
          plan: `[转派自 ${from} · 业务=${domain} · 理由] ${reason}\n\n[前站理解摘要]\n${summary || '（无摘要，请读案卷原文）'}\n\n[原任务] ${w.title} —— 按上述继续推进。`,
          handoff_from: from,
          handoff_domain: domain,
        },
      });
      if (lastAgent) {
        store.setStepOutput(lastAgent.id, {
          handed_off: { to: target, domain, reason, by },
        });
      }
      store.appendEvent('workflow', workflowId, 'route_content_handoff', {
        from, to: target, domain, reason, by,
      });
      void o.late.advance(workflowId);
      return { from, to: target };
    });
  };

  return { intervene, amendStep, amendSuggestions, reworkSend, handoff, assignSession, retry };
};

