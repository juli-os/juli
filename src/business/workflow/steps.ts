// 步执行器：闸门开启（openGate 含前置对账）与 agent/send 两类步的执行
// （tmux 异步 / ACP 同步两条派发路径；发送步=守卫链+信封契约+SMTP 全链）。

import { createHash } from 'node:crypto';
import { rfc3339 } from '@juli-os/artifacts';
import { asString } from '../../platform/shared/json.ts'
import type { JsonRecord, JsonValue } from '@juli-os/artifacts'
import type { Logger } from '../../platform/events/bus.ts';
import type { LifecycleStore } from '@juli-os/ledger';
import { appendReference } from '@juli-os/ledger';
import { type Step } from '@juli-os/ledger';
import type { StepCtx, StepHandler } from './capabilities/index.ts';
import { agentSessionOf, flowContext, planPrompt, renderFlowTemplate } from './capabilities/index.ts';
import {
  DEFAULT_REDLINE_WORDS, disclosureMissing, redlineHit, runSendChecks,
} from '../send/sendChecks.ts';
import { composeTextBody, renderEmailHtml, SIGNATURE_TEXT, stripSignature } from '../send/emailView.ts';
import {
  deliverablesBody, envelopeRefs, gateDelivery, isEffectDelivery, resolveSendRecipient,
} from '../send/sendSeed.ts';
import { anchorPlan, claimsAttachment, gateSummary } from './support.ts';
import type { EngineDeps } from './engine.ts';
import type { Journal } from './journal.ts';
import type { Queue } from './queue.ts';
import type { Zombie } from './zombie.ts';

export interface Steps {
  openGate: StepHandler;
  runAgentStep: StepHandler;
  runSendStep: StepHandler;
  /** 闸门视角的正文候选：优先 deliverables 里唯一 body 工件（按哈希取字节），
   * 退回内联 draft（旧链路/无契约）。取不到返回 null。 */
  resolveBodyText(gate: Step): Promise<string | null>;
  gateWorkflowActive(workflowId: string): string | null;
  /** 播种/自愈回退任务卡的渲染接缝（第 5 轮审查 P1）：上游 input.prompt 常
   * 是未渲染模板——原样复制会把字面占位符当计划派发。渲染成具体文本再落
   * plan；失败回退原文并留痕（事件+log），渲染异常绝不炸播种路径。 */
  renderSeedPlan(src: Step, tpl: string): string;
}

export const makeSteps = (o: {
  readonly deps: EngineDeps;
  readonly store: LifecycleStore;
  readonly now: () => Date;
  readonly log: Logger;
  readonly withLock: <T>(workflowId: string, fn: () => Promise<T>) => Promise<T>;
  readonly journal: Journal;
  readonly queue: Pick<Queue, 'continueWorkflow' | 'enqueueBack'>;
  readonly zombie: Pick<Zombie, 'touchSession'>;
  /** 晚绑 advanceLocked：解释器装配后才指向真身（步收工后续推锁内链）。 */
  readonly late: { advanceLocked: (workflowId: string) => Promise<void> };
}): Steps => {
  const { deps, store, log } = o;
  const now = o.now;

  // ---- 闸门 ---------------------------------------------------------------------

  /** pending→waiting_human 的一次性转变 + 推送。推送只在转变沿触发：
   * 重启风暴里 N 个待审闸门绝不能每次重启都各推一遍。 */
  const openGate = async (ctx: StepCtx): Promise<void> => {
    const { store: st0, step: st, workflow: w } = ctx;
    if (st.status !== 'pending') return;
    // 闸门开启时把前一步产出带进 input:审阅人看得见草稿,批准后原样流向 send。
    const steps0 = store.stepsForWorkflow(st.workflowId);
    const prev = steps0[st.seq - 2];
    if (prev && (prev.status === 'completed' || prev.status === 'failed')) {
      const out = prev.output ?? {};
      const carry = asString(out['draft']) !== '' ? asString(out['draft']) : asString(out['output']);
      if (carry !== '' && asString(st.input['draft']) === '' && asString(st.input['output']) === '' && asString(st.input['plan']) === '') {
        st0.setStepInput(st.id, { draft: carry });
      }
      // 交付物指针随闸门携带：审阅人按 role 渲染工件本体，发送步按哈希取件。
      const dl = out['deliverables'];
      if (Array.isArray(dl) && !Array.isArray(st.input['deliverables'])) {
        const patch: Record<string, JsonValue> = { deliverables: dl };
        // envelope 按键合并（wf_16454623bf49 两代事故）：任务流闸门定义时被
        // 强制申报 envelope.to（无原始发件人不申报则闸门开不起来），而 sweep
        // 产出的 envelope 经 parseEnvelope 只剩线程提示键——整包覆盖会把申报
        // 冲掉，approve 播种 to='' 必撞 no_recipient。申报在位（JSON object）
        // 时申报键优先、sweep 只补缺；无申报（回信流）维持整包原样。
        const declared = st.input['envelope'];
        const swept = out['envelope'];
        const declaredIsRecord =
          declared !== null && typeof declared === 'object' && !Array.isArray(declared);
        if (swept !== undefined) {
          patch['envelope'] = declaredIsRecord
            ? { ...(swept as JsonRecord), ...(declared as JsonRecord) }
            : swept;
        }
        st0.setStepInput(st.id, patch);
      }
    }
    // 发送闸门：开启即跑前置对账，结果钉在 input——人只判异常，不跑检查，
    // 忘记被结构性消灭。回修重开（input.feedback 非空）时强制重跑并覆盖
    // checks：merge 写无法删键，陈旧的红灯/绿灯都是对审阅契约的欺骗。
    const next = steps0[st.seq];
    const reworked = asString(st.input['feedback']) !== '';
    const gateDel = gateDelivery(st.input);
    if (next && next.kind === 'send' && isEffectDelivery(gateDel)) {
      // 交付显式化（板 A）：apply/artifact 闸门不是邮件决定——客户邮件的
      // 红线/披露/契约检查不适用；改 delivery 前跑过的陈旧红灯一并清空
      // （merge 删不掉键，留着就是对审阅契约的欺骗），跳过留痕。
      st0.setStepInput(st.id, { checks: [], checked_at: rfc3339(now()) });
      st0.appendEvent('step', st.id, 'send_checks_skipped_delivery', { delivery: gateDel });
    } else if (next && next.kind === 'send' && (!Array.isArray(st.input['checks']) || reworked)) {
      // 重读再对账：上面的 carry 刚把产出写进 input，st 快照还是旧值——
      // nodes 模式闸门与 send 同拍落地（自动配对）时，checks 是在 carry
      // 之后的同一次开启里跑的，读快照会把非空正文判成空。
      const cur = st0.getStep(st.id) ?? st;
      const body = await resolveBodyText(cur);
      const hasManifest = cur.input['manifest'] === true;
      const feedbackRefs = envelopeRefs(cur.input['envelope']);
      const checks = await runSendChecks(body ?? '', {
        redlineWords: deps.redlineWords ?? DEFAULT_REDLINE_WORDS,
        hasManifest, feedbackRefs, probeUrls: true,
        probeUrl: deps.probeUrl ?? undefined,
        // 称呼对账源（陈莉君事故 2026-10-01）：进件落的 from_name/from。
        senderName: asString(w.meta['from_name']) || undefined,
        senderAddress: asString(w.meta['from']) || undefined,
      });
      st0.setStepInput(st.id, { checks: checks as unknown as JsonValue, checked_at: rfc3339(now()) });
      st0.appendEvent('step', st.id, 'send_checks_ran', {
        checks: checks.map((c) => `${c.name}:${c.status}`),
        ...(reworked ? { recompute: true } : {}),
      });
    }
    st0.setStepStatus(st.id, 'waiting_human');
    o.journal.stepEvent(st, 'step_waiting_human', {});
    await o.journal.pushBestEffort('gateWaiting', deps.pusher &&
      (() => deps.pusher!.gateWaiting(w, st, gateSummary(st))));
  };

  const resolveBodyText = async (gate: Step): Promise<string | null> => {
    const body = deliverablesBody(gate.input);
    if (body !== null && deps.artifacts?.getContent) {
      const content = await deps.artifacts.getContent(body.id).catch(() => null);
      if (content !== null) return content.bytes.toString('utf8');
      return null;
    }
    const inline = asString(gate.input['draft']);
    return inline !== '' ? inline : null;
  };

  const gateWorkflowActive = (workflowId: string): string | null => {
    const w = store.getWorkflow(workflowId);
    if (!w) return `workflow ${workflowId} not found`;
    if (w.status !== 'running') {
      return `workflow is ${w.status} — gate actions are only valid while the workflow is running`;
    }
    return null;
  };

  const renderSeedPlan = (src: Step, tpl: string): string => {
    try {
      return renderFlowTemplate(tpl, { ...flowContext(store, src.workflowId, now()), Input: src.input });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`[engine] step ${src.id} 播种任务卡渲染失败（回退原文）: ${msg}`);
      store.appendEvent('step', src.id, 'step_seed_render_fallback', { error: msg });
      return tpl;
    }
  };

  // ---- agent 执行 -----------------------------------------------------------------

  const runAgentStep = async (ctx: StepCtx): Promise<void> => {
    const { store: st0, step: st, workflow: w } = ctx;
    let plan = asString(st.input['plan']);
    // 统一干预消费（四件套，2026-09-28）：meta.override 在派发点一次性消费
    // 销账（override_applied 事件）——①session：覆盖一切会话来源（播种/继承/
    // 落点），且「钉住」= 忙闲改道不得动它（人点名的会话排队等，不换人）；
    // ②context：追加进任务卡（与回修指示同位，agent 必读）。任何状态可设，
    // 派发时生效——「状态迁移时人插得进手」。
    const ovRaw = w.meta['override'];
    const ov = ovRaw !== null && typeof ovRaw === 'object' && !Array.isArray(ovRaw)
      ? ovRaw as Record<string, unknown> : null;
    const ovSession = ov !== null && typeof ov['session'] === 'string' && ov['session'] !== '' ? ov['session'] : '';
    const ovContext = ov !== null && typeof ov['context'] === 'string' && ov['context'] !== '' ? ov['context'] : '';
    if (ovSession !== '' || ovContext !== '') {
      const consumed: Record<string, unknown> = {};
      if (ovSession !== '') {
        consumed['session'] = ovSession;
        st0.setStepInput(st.id, { session: ovSession, session_pinned: true });
        store.setWorkflowSession(w.id, ovSession);
      }
      if (ovContext !== '') { consumed['context'] = ovContext.slice(0, 80); plan = `${plan}\n\n[人工干预补充（优先级最高，随任务卡）]\n${ovContext}`; }
      const rest = { ...ov } as Record<string, JsonValue>;
      delete rest['session']; delete rest['context'];
      store.updateWorkflowMeta(w.id, Object.keys(rest).length > 0 ? { override: rest } : { override: null });
      o.journal.stepEvent(st, 'override_applied', consumed as JsonRecord);
    }
    // 重派/重入跟随实际落点（2026-09-28 双投事故③）：上次派发的改道结果
    // （resolved_session=忙闲改道/别名解析/jev 采纳的落点）是这步的活会话，
    // 重派按它走——不再回到播种地址造成同一步双 session 双投。参数化
    // session（{{...}}）除外：它每次渲染，不吃上次的落点快照。
    // 干预 session 是最高优先例外：人刚点名的会话盖过历史落点。
    const declared0 = agentSessionOf(st);
    const resolved0 = asString(st.input['resolved_session']);
    const session0 = ovSession !== ''
      ? ovSession
      : (!declared0.includes('{{') && resolved0 !== '' ? resolved0 : declared0);
    // 模板流的参数化任务卡：缺 plan 时渲染本步 prompt 模板（{{.Input.*}} 等点
    // 路径），原文直读进任务——压缩摘要不再是 agent 的唯一信息源。
    if (plan.trim() === '') {
      const promptTpl = asString(st.input['prompt']);
      if (promptTpl.trim() !== '') {
        // 渲染失败必须显性化（2026-09-14 wf_994b0eb399ab 事故）：缺模板 key
        // 的异常若飞出 advance，步骤永冻 pending 且账本零痕迹——人只看到
        // 「在跑、没闸门」。与 session/_when 求值同一处置：failed + 留痕可重试。
        try {
          plan = renderFlowTemplate(promptTpl, { ...flowContext(store, w.id, now()), Input: st.input });
        } catch (e) {
          const msg = `任务卡渲染失败: ${e instanceof Error ? e.message : String(e)}`;
          st0.setStepOutput(st.id, { error: msg });
          st0.setStepStatus(st.id, 'failed');
          o.journal.stepEvent(st, 'step_failed', { error: msg });
          log.error(`[engine] step ${st.id} (${st.kind}) ${msg}`);
          return;
        }
      }
    }
    // 模板流：仍缺则退回最近 llm 响应（分镜/简报就是非邮件流的工单）。
    if (plan.trim() === '') {
      const resp = o.journal.latestLLMResponse(w.id);
      if (resp !== '') plan = `以下是你需要执行的任务说明：\n\n${resp}`;
    }
    // 回修指示（rework 注入）必须抵达任务卡——它是本轮的最高优先级输入。
    const fb = asString(st.input['feedback']);
    if (fb.trim() !== '') plan = `${plan}\n\n[人工回修指示（优先级最高）]\n${fb}`;
    let session = session0;
    // 动态模型的会话解析链：步钉 > 默认会话（与复用优先路由器兜底同源）。
    // manifest 时代靠 triage 播种；进件首节点无钉，必须落 defaultSession。
    if (session.trim() === '') session = deps.routing.defaultSession;
    // 参数化会话：session 带 {{...}} 时对 flow context 渲染（如
    // "{{.Steps.understand.output.session}}"——执行步自动跟随理解步实际落点）。
    if (session.includes('{{')) {
      try {
        session = renderFlowTemplate(session, { ...flowContext(store, w.id, now()), Input: st.input }).trim();
        st0.setStepInput(st.id, { resolved_session: session });
      } catch (e) {
        st0.setStepOutput(st.id, { error: `session 求值失败: ${e instanceof Error ? e.message : String(e)}` });
        st0.setStepStatus(st.id, 'failed');
        o.journal.stepEvent(st, 'step_failed', { error: 'session 求值失败' });
        return;
      }
    }
    // 会话归属回填:workflow.session 是"任务当前执行落点"的一等导航字段
    //(iOS/流水从它找 agent)——不能只躺在步 input 中。
    if (session !== '') store.setWorkflowSession(w.id, session);
    // 绑定会话守卫（专用 agent 隔离，2026-09-19 裁决）：bound_agents 声明的
    // 会话（如 project-a）只放行【sender 路由标记过的本单】进——web/
    // CLI/agent 给步钉绑定会话一律显式 failed，杜绝旁道。绑定会话同时豁免
    // 复用优先落回：不存在时保持原名交就绪派发按配置 cwd 自建（落回
    // juli-reply = 绑定被打穿，wf 事故形态）。
    const boundHit = (deps.routing.boundAgents ?? []).find((b) => b.session === session.trim());
    if (boundHit !== undefined) {
      if (asString(w.meta['session_bound']) !== boundHit.session) {
        const msg = `绑定会话 ${boundHit.session} 仅限其白名单发件人的邮件通道派发（本单未经 sender 路由标记）`;
        st0.setStepOutput(st.id, { error: msg, guard: 'session_bound' });
        st0.setStepStatus(st.id, 'failed');
        o.journal.stepEvent(st, 'step_failed', { error: 'session bound', guard: 'session_bound', session: boundHit.session });
        log.error(`[engine] step ${st.id} 绑定会话守卫拒派：${msg}`);
        return;
      }
    } else {
      // 近匹配守卫（P3，与正向守卫对称）：会话名大小写/变体拼写命中绑定名但
      // 非精确——exact 未命中会静默经 resolveSession 落回默认会话，会计任务
      // 泄进通用会话正是「绑定被打穿」的事故形态（反向）。变体一律显式
      // failed 留 guard，绝不静默改道。
      const nearHit = (deps.routing.boundAgents ?? []).find((b) =>
        b.session.toLowerCase() === session.trim().toLowerCase() && b.session !== session.trim());
      if (nearHit !== undefined) {
        const msg = `会话名 ${session} 近似绑定会话 ${nearHit.session}（非精确匹配）——绑定会话不接受变体拼写路由，请钉精确名`;
        st0.setStepOutput(st.id, { error: msg, guard: 'session_bound_near' });
        st0.setStepStatus(st.id, 'failed');
        o.journal.stepEvent(st, 'step_failed', { error: 'session bound near-match', guard: 'session_bound_near', session: nearHit.session });
        log.error(`[engine] step ${st.id} 近匹配绑定会话守卫拒派：${msg}`);
        return;
      }
      if (deps.resolveSession) {
        // LLM 路由会编造每邮件独立的会话名——派发前经别名接缝解析。
        const requested = session;
        session = deps.resolveSession(session);
        st0.setStepInput(st.id, { resolved_session: session });
        // 落回留痕（板B 审计行）：点名不存在被兜住不是静默事件——每次
        // requested→resolved 的改道都进账本，Agents 页审计表从这里读。
        if (session !== requested) {
          o.journal.stepEvent(st, 'route_fallback', { requested, resolved: session, by: 'resolveSession' });
          // jev 兜底腿（2026-09-23 用户口令，影子模式先行）：规则链全未命中
          // 时让语义判定从声明表里选会话。shadow=只留痕不生效；on=答案须过
          // 阈值且是「非绑定声明会话」（决定留引擎：校验在引擎，绑定会话
          // 绝不经判定改道——隔离纪律）。判定失败/关闭=原样落默认，零行为。
          // mode/threshold 以 ask 返回值为准（同一次 load 裁断，无热改 TOCTOU）。
          // 注意代价：本判定 await 在 advanceLocked/withLock 内、queue 并发=1
          // 的派发路径上——期间同工作流结算/闸门动作排队等锁、收单台槽位被
          // 占；timeout_ms 已被网关夹紧 [1s,30s]（judgment.ts），阻塞有上界。
          if (deps.judgment !== undefined) {
            const boundNames = new Set((deps.routing.boundAgents ?? []).map((b) => b.session));
            const declared = (deps.routing.agents ?? [])
              .filter((a) => !boundNames.has(a.session))
              .map((a) => ({ session: a.session, company: a.company, domain: a.domain }));
            if (declared.length > 0) {
              const criteria: Record<string, null> = {};
              for (const d of declared) criteria[d.session] = null;
              const outcome = await deps.judgment.ask('route_fallback',
                {
                  requested_session: requested,
                  default_session: session,
                  // 用已解析的局部 plan（模板渲染/回退/回修指示都已补全）——
                  // 原始 input.plan 在模板流下是空任务卡，判定纯属噪声。
                  task: plan.slice(0, 600),
                },
                {
                  target_session: {
                    type: 'choice',
                    instructions: 'Which declared session (by company/domain) should own this task instead of the default?',
                    criteria,
                  },
                });
              if (outcome === null) {
                // off（网关裁断）：零行为零留痕。
              } else if (!outcome.ok) {
                o.journal.stepEvent(st, 'route_judgment', { mode: outcome.mode, scenario: 'route_fallback', error: outcome.error ?? '' });
              } else if (outcome.mode === 'shadow') {
                o.journal.stepEvent(st, 'route_judgment', { mode: outcome.mode, scenario: 'route_fallback', answer: outcome.answer ?? '', confidence: outcome.confidence ?? 0, provider: outcome.provider, model: outcome.model ?? '', input_tokens: outcome.inputTokens ?? 0, output_tokens: outcome.outputTokens ?? 0, duration_ms: outcome.durationMs ?? 0 });
              } else {
                const valid = declared.some((d) => d.session === outcome.answer);
                if (valid && (outcome.confidence ?? 0) >= outcome.threshold) {
                  session = outcome.answer!;
                  st0.setStepInput(st.id, { resolved_session: session });
                  store.setWorkflowSession(w.id, session);
                  o.journal.stepEvent(st, 'route_judgment_applied', { requested, resolved: session, confidence: outcome.confidence ?? 0, provider: outcome.provider, model: outcome.model ?? '', input_tokens: outcome.inputTokens ?? 0, output_tokens: outcome.outputTokens ?? 0, duration_ms: outcome.durationMs ?? 0 });
                } else {
                  o.journal.stepEvent(st, 'route_judgment_rejected', { answer: outcome.answer ?? '', confidence: outcome.confidence ?? 0, reason: !valid ? '非声明会话' : '低于阈值', provider: outcome.provider, model: outcome.model ?? '', input_tokens: outcome.inputTokens ?? 0, output_tokens: outcome.outputTokens ?? 0, duration_ms: outcome.durationMs ?? 0 });
                }
              }
            }
          }
        }
      }
      // 判定收敛执行层（2026-10-13 用户裁定「排队后再决定路由」）：三无单
      // （无显式 session=也无人挂靠继承、无挂靠、无显式档位、未判定过）在
      // 派发时刻问落点与档位——进件层只收倾向，进件判的是排队前的世界、
      // 这里判的是现在（jev 对实时忙闲）。与上面 route_fallback（点名落空
      // 兜底）互补：那条管「点错名」，这条管「没点名」。判定挂/缺缝=零行
      // 为走 default（fail-open）。留痕=route_decision（路由图同款事件）。
      const tInput = (w.meta['template_input'] ?? {}) as JsonRecord;
      if (asString(st.input['session']).trim() === '' && asString(st.input['resolved_session']).trim() === ''
        && asString(tInput['relates_to']).trim() === '' && asString(tInput['model_tier']).trim() === '') {
        let tierReasons: Record<string, string> | null = null;
        if (deps.taskRoute !== undefined) {
          try {
            const landing = await deps.taskRoute(w.title, asString(tInput['brief']));
            if (landing !== null && landing.session.trim() !== ''
                && (landing.via === 'jev' || landing.diverted)) {
              tierReasons = { route_task: `${landing.note}（via=${landing.via}${landing.diverted ? ' 改道' : ''}）` };
              session = landing.session.trim();
              st0.setStepInput(st.id, { resolved_session: session });
            }
          } catch { /* fail-open：判定挂了不许挂派发 */ }
        }
        const twin = deps.highTwinFor !== undefined ? deps.highTwinFor(session) : '';
        if (twin !== '' && deps.taskTier !== undefined) {
          const tier = await deps.taskTier(w.title, asString(tInput['brief'])).catch(() => null);
          if (tier === 'high') {
            tierReasons = { ...(tierReasons ?? {}), model_tier: `jev 判 high → 升档 ${twin}` };
            session = twin;
            st0.setStepInput(st.id, { resolved_session: session, model_tier: 'high', model_tier_by: 'jev' });
          }
        }
        if (tierReasons !== null) {
          store.setWorkflowSession(w.id, session);
          try {
            store.appendEvent('workflow', w.id, 'route_decision', {
              from: 'engine-dispatch', company: '', domain: '', session,
              chain: ['task', 'route_task'], fallback: false,
              reasons: { task: '三无单派发时判定（收敛执行层）', ...tierReasons },
            });
          } catch { /* 留痕失败不推翻派发 */ }
        }
      }
      // 忙闲选枝（板D/G dispatcher 选枝函数落地，2026-09-20；2026-09-27 用户
      // 裁决改道语义）：默认路由的会话若已有 running 的 agent 步，改道到
      // **其他声明 agent**（非绑定、tmux 真实存在、空闲），同公司优先——
      // 负载摊到真实 agent 而非同基名克隆（clone 会让其他 agent 永远没忙过）；
      // 无候选才原路挤入（排队语义不变）。绑定会话绝不改道（隔离纪律，
      // 上方守卫的同族延伸）。改道三留痕：input 标记 + route_busy_divert
      // 事件 + workflow.session 回填。
      // 忙闲重定义（0930 用户裁定）：忙=名下存在非终态单（排队/在跑/停在
      // 闸门等批准都算），不再只看「正在跑的步」——等批准的会话不再被当
      // 空闲往里堆活。自排除：本单自己锚在目标会话且非终态，不排除=每次
      // 派发都自触发改道。
      const isBoundSession = (deps.routing.boundAgents ?? []).some((b) => b.session === session);
      // 干预钉住（2026-09-28 四件套）：人点名的会话不被忙闲改道换人——排队
      // 等它空闲（派发器会等就绪），宁可慢不换人（换人=上下文丢失，双投
      // 事故同族观感）。ovSession 是本次派发消费到的干预值（局部变量——
      // 上面 setStepInput 的写入不会反映进函数开头的步快照）；历史钉住
      // （重派场景）读 input 快照兜底。
      const pinned = ovSession !== ''
        || asString(st.input['session_pinned']) === 'true' || st.input['session_pinned'] === true;
      if (!isBoundSession && !pinned && store.sessionHasOpenWork(session, w.id)) {
        const boundNames = new Set((deps.routing.boundAgents ?? []).map((b) => b.session));
        const home = (deps.routing.agents ?? []).find((a) => a.session === session)?.company ?? '';
        // high 档孪生不做改道目标（成本纪律「非必要不高智能」，0930 与
        // routeTaskMenu 对齐）；候选自排除 w 本体（重派/再派发时本单已锚在
        // 上次改道落点，不排除=候选永远被自己占死、来回换人）。
        const others = (deps.routing.agents ?? [])
          .filter((a) => a.session !== '' && a.session !== session
            && !boundNames.has(a.session) && a.model_tier !== 'high');
        const idleOf = (s: string): boolean =>
          (deps.availableSessions ?? []).includes(s) && !store.sessionHasOpenWork(s, w.id);
        const divert = [...others.filter((a) => a.company === home), ...others.filter((a) => a.company !== home)]
          .find((a) => idleOf(a.session))?.session ?? null;
        if (divert !== null && divert !== undefined) {
          // 改道必须彻底（2026-09-28 双投事故）：resolved_session 一并落步——
          // 僵尸看门狗/重派/干预都按它找「这步的活会话」。只改运行时变量不落
          // 步，下游按播种地址（input.session）把空闲会话误判僵尸、再按旧地址
          // 重派 = 同一步两个 session 各收一份 prompt（acme 忙→改道 meridian
          // 后僵尸盯空闲的 acme 判死重派回 acme，实测双投）。
          st0.setStepInput(st.id, { busy_diverted_from: session, resolved_session: divert });
          o.journal.stepEvent(st, 'route_busy_divert', { from: session, to: divert, by: 'busy_agent' });
          log.info(`[engine] step ${st.id} 忙闲改道：${session} → ${divert}（基会话有未完单，负载摊给声明 agent）`);
          session = divert;
          store.setWorkflowSession(w.id, session);
        } else {
          // 全忙兜底（2026-10-13 双落点事故）：无空闲替代时不硬闯忙会话——
          // 步留 pending、置回 queued（启动扫描兜底重启窗口）延迟回队
          // （延迟避开 pump 即泵即判的热循环）。常态由 holdGate 忙会话腿
          // 在 pump 侧压住，本分支只兜「pump 检查后瞬间变忙」的竞态窗。
          o.journal.stepEvent(st, 'route_busy_wait', { session, by: 'busy_agent' });
          log.info(`[engine] step ${st.id} 目标会话 ${session} 忙且无空闲替代——回队等待`);
          store.setWorkflowStatus(w.id, 'queued');
          const retry = setTimeout(() => o.queue.enqueueBack(w.id), 30_000) as unknown as { unref?: () => void };
          retry.unref?.(); // 重试定时器不拖住进程退出
          return;
        }
      }
    }
    if (session === '' || plan.trim() === '') {
      // 断点七诊断：报错必须带上本步 input 键位——keys 列表让定位不用翻库。
      // 拆根（2026-10-16 演示实例派发秒败事故）：session 缺=配置问题
      // （default_session 空，boot 装配行也应有 [routing] 显性报错），plan 缺=
      // 播种断链（下方有确定性自愈路径）——两种病两种话，混一句会把排查
      // 带偏（当时把「缺路由兜底」误导向「上游播种断链」追了半天）。
      const diag = session === ''
        ? `路由无落点：default_session 未配置（顶层 default_session / legacy email.default_session 均空）——本步 input.keys=[${Object.keys(st.input).join(',')}]`
        : `missing plan input（上游播种检查：本步 input.keys=[${Object.keys(st.input).join(',')}]}）`;
      // 确定性自愈（断点十一②）：session 有着落而 plan 空、且本步无 prompt 兜底
      // ——上游播种断链的确定形态，不需要人裁：从紧邻上游步（steps[seq-2]）的
      // input.plan/prompt 取值重臂一次，留 step_self_heal 审计事件；output 打
      // self_healed 标记防循环（只自愈一次，再失败照常 failed）。
      const up = store.stepsForWorkflow(w.id)[st.seq - 2];
      const healPlan =
        session !== '' && plan.trim() === '' &&
        asString(st.input['prompt']).trim() === '' &&
        st.output['self_healed'] !== true && up !== undefined
          ? asString(up.input['plan']) || renderSeedPlan(up, asString(up.input['prompt']))
          : '';
      if (healPlan.trim() !== '') {
        st0.setStepInput(st.id, { plan: healPlan });
        st0.setStepOutput(st.id, { self_healed: true });
        st0.setStepStatus(st.id, 'pending');
        o.journal.stepEvent(st, 'step_self_heal', { from_seq: up!.seq, by: 'engine' });
        log.info(`[engine] step ${st.id} (${st.kind}) 播种断链自愈：plan 取自上游 seq=${up!.seq}，重臂`);
        await o.late.advanceLocked(st.workflowId);
        return;
      }
      st0.setStepOutput(st.id, { error: diag });
      st0.setStepStatus(st.id, 'failed');
      o.journal.stepEvent(st, 'step_failed', { error: diag });
      return;
    }
    st0.setStepStatus(st.id, 'running');
    // 保证该工作流在被路由会话上有一个 run（prompt 意图记录的挂靠点）。
    const run = st0.activeRunForSession(session);
    if (!run || run.workflowId !== st.workflowId) {
      st0.createRun(st.workflowId, session);
    }
    if (deps.syncDispatch) {
      // ACP/同步路径：阻塞到协议级完成信号，最终消息直接进步 output。
      o.journal.stepEvent(st, 'step_dispatched', { session, via: 'acp' });
      const anchored = deps.workspaceFor
        ? anchorPlan(session, deps.workspaceFor(session), plan)
        : plan;
      void (async () => {
        let res;
        try {
          res = await deps.syncDispatch!.dispatchSync('email', session, planPrompt(anchored));
        } catch (e) {
          res = { ok: false as const, error: e instanceof Error ? e : new Error(String(e)) };
        }
        await o.withLock(st.workflowId, async () => {
          if (!res.ok) {
            st0.setStepOutput(st.id, { error: res.error.message, via: 'acp' });
            st0.setStepStatus(st.id, 'failed');
            o.journal.stepEvent(st, 'step_failed', { error: res.error.message, via: 'acp' });
            return;
          }
          st0.setStepOutput(st.id, { output: res.value, via: 'acp', completed_at: rfc3339(now()) });
          const steps = st0.stepsForWorkflow(st.workflowId);
          const next = steps[st.seq];
          // 同 completeAgentStep 的 P1-2 守卫：转派步不被同步派发路径的
          // 结算播种覆盖（带 handoff_domain 标记的步整体跳过）。
          if (next && asString(next.input['handoff_domain']) === '') {
            const seed: Record<string, JsonValue> = { plan: asString(st.input['plan']), output: res.value };
            const s = asString(st.output['session']) || asString(st.input['session']);
            if (s !== '') seed['session'] = s;
            st0.setStepInput(next.id, seed);
          }
          st0.setStepStatus(st.id, 'completed');
          o.journal.stepEvent(st, 'step_completed', { via: 'acp' });
          await o.late.advanceLocked(st.workflowId);
        });
      })().catch((e) => log.error(`syncDispatch settle: ${String(e)}`));
      return;
    }
    // tmux 路径：工作区锚定后异步派发，OnAgentStopped 负责结算。
    if (deps.workspaceFor) {
      plan = anchorPlan(session, deps.workspaceFor(session), plan);
    }
    if (!deps.dispatch) {
      st0.setStepOutput(st.id, { error: 'no dispatcher' });
      st0.setStepStatus(st.id, 'failed');
      o.journal.stepEvent(st, 'step_failed', { error: 'no dispatcher' });
      return;
    }
    // 交付契约接线：任务卡自带 case-inbox 路径——agent 把交付物与申报单
    // (reply.json) 写进该目录，步结算时引擎收编为工件（闸门渲染/哈希发送）。
    // 契约行对齐 makro-artifacts 2026-10-04 终版裁定（单一自包含 HTML）：主
    // 交付物是一件 HTML，body.txt 仅发送语义附加。旧措辞「body=将发出的纯
    // 文本正文」列在首位，apply 类单被带偏成只交 txt、详情页渲染无意义
    // （wf_9658ce9225e0，2026-10-05）。
    if (deps.artifacts && deps.caseInboxDir) {
      const inbox = deps.caseInboxDir(st.workflowId);
      plan = `[交付目录] 本步交付物写到：${inbox}\n` +
        `主交付物=一件自包含 HTML（makro-artifacts 契约：人类视图+结构化数据岛 id="makro-meta" 全部内嵌单文件，不另产 JSON/md/txt）；` +
        `另写 reply.json 申报单（deliverables:[{file,role,summary}]，role∈report/data/attachment；` +
        `仅当本单要给客户发信才另产纯文本正文文件并申报 role=body——不发信不产 txt）。\n` +
        `仅写入该目录，发送由人工闸门决定。\n\n${plan}`;
    }
    const res = await deps.dispatch.dispatch('email', session, planPrompt(plan));
    if (!res.ok) {
      // 提交未确认（submit_unconfirmed/submit_lost）不判死（2026-09-21 深夜
      // 用户实测假阴性：agent 忙时 prompt 入队稍后才消费——判死会把做完了
      // 的单记成 failed，还诱导重试双投）。步保持 running：真被吞=看门狗
      // 静默判僵尸打断重派；真消费=Stop hook 正常结算。tmux 层硬错误仍
      // 显性 failed。
      const msg = res.error.message;
      if (msg.includes('submit_unconfirmed') || msg.includes('submit_lost')) {
        o.journal.stepEvent(st, 'submit_unverified', { error: msg, session });
        log.warn(`[engine] step ${st.id} 提交未确认但保持 running（看门狗兜底）：${msg}`);
        return;
      }
      st0.setStepOutput(st.id, { error: msg });
      st0.setStepStatus(st.id, 'failed');
      o.journal.stepEvent(st, 'step_failed', { error: msg });
      return;
    }
    o.journal.stepEvent(st, 'step_dispatched', { session });
    o.zombie.touchSession(session); // 派发时点种心跳；此后会话的每个 hook 事件续命。
  };

  // ---- 发送 -----------------------------------------------------------------------

  const runSendStep = async (ctx: StepCtx): Promise<void> => {
    const { store: st0, step: st, workflow: w } = ctx;
    // 重复发送保护（2026-09-15 断点六②最后一道闸）：本单已有另一封 send 完成
    // = 闸门 auto-pair 与手动 send 撞车（wf_4be459bfd035 双发事故）的兜底——
    // 无论种子/正文新旧，第二封一律不发。多余节点在此直接置 cancelled（第 5 轮
    // 审查）：拒发第二封不是失败而是正确的守卫动作；置 failed 会把整单翻 failed
    // 且唯一出口只剩 close（cancelStep 拒收 failed，操作指引撞墙）；cancelled
    // 终态与 autoSettle 的 completed+cancelled 口径、appendNode send 去重、
    // close 语义全部自洽，链可继续推进，guard 标记留审计。
    if (store.stepsForWorkflow(st.workflowId).some((s) =>
      s.kind === 'send' && s.id !== st.id && s.status === 'completed')) {
      st0.setStepOutput(st.id, {
        cancel_note: '本单已有一封发出（重复发送保护）——多余的重复节点自动取消',
        guard: 'duplicate_send',
      });
      st0.setStepStatus(st.id, 'cancelled');
      o.journal.stepEvent(st, 'step_cancelled', { guard: 'duplicate_send', note: 'duplicate send refused' });
      await o.late.advanceLocked(st.workflowId);
      return;
    }
    // 定档未到：不发送，挂回 pending 留痕——决定已生效，执行等钟。
    const sched = asString(st.input['send_at']);
    if (sched !== '' && new Date(sched).getTime() > now().getTime()) {
      st0.setStepOutput(st.id, { scheduled_until: sched });
      st0.setStepStatus(st.id, 'pending');
      o.journal.stepEvent(st, 'send_deferred', { until: sched });
      return;
    }
    st0.setStepStatus(st.id, 'running');
    if (!deps.mailer) {
      st0.setStepOutput(st.id, { error: 'smtp not configured' });
      st0.setStepStatus(st.id, 'failed');
      o.journal.stepEvent(st, 'step_failed', { error: 'smtp not configured' });
      return;
    }
    // 收件人解析（单一事实源 resolveSendRecipient，P0 收件人劫持）：与
    // seedSendFromGate / web 闸门卡同一优先级——回信流（meta.from 在位）锁定
    // 原发件人，nodes 模式播种的 input.to（=任务流申报 envelope.to）仅在
    // from 缺席时生效；ladder 回信流维持旧铁律「input.to 一律忽略」。
    // 双空 = 无处可发：显式 failed 留 no_recipient 守卫，绝不静默。
    const to = resolveSendRecipient(
      asString(w.meta['from']),
      w.meta['mode'] === 'nodes' ? asString(st.input['to']) : '',
    ).to;
    if (to === '') {
      st0.setStepOutput(st.id, {
        error: '无收件人（envelope.to 与 meta.from 双空）— 任务流发送闸门必须申报收件人，回信流必须有原始发件人',
        guard: 'no_recipient',
      });
      st0.setStepStatus(st.id, 'failed');
      o.journal.stepEvent(st, 'step_failed', { error: 'no recipient', guard: 'no_recipient' });
      return;
    }
    // 主题（2026-09-20 R3 NEW-1 收口）：meta.from 在位=回信流，subject 与
    // cc/to 同一优先级锁——种子已定 Re: 原题，这里兜住 amend 整包替换 send 步
    // input 后改 subject 的最后一道通道（审计在种子侧，此处静默锁）。
    const metaFrom = asString(w.meta['from']).trim();
    const subject = metaFrom !== '' ? `Re: ${asString(w.meta['subject'])}` : asString(st.input['subject']);
    // 正文契约铁律（2026-09-15 断点九①，wf_f4abf29e4e28 实发事故）：nodes 模式
    // （动态进件/任务单——会话汇报可能直接冲正文的事故面）正文只认 body_ref
    // （manifest body 工件哈希取件）。内联回退只保留给 ladder 模板流（draft 步
    // 产出无 manifest 的既有契约）；nodes 无契约时宁可拒发——盲重试被 guard 拒。
    const bodyRefIn = st.input['body_ref'];
    const hasBodyRef = bodyRefIn !== null && typeof bodyRefIn === 'object' && !Array.isArray(bodyRefIn);
    if (w.meta['mode'] === 'nodes' && !hasBodyRef) {
      st0.setStepOutput(st.id, {
        error: '正文无契约工件（body_ref 缺失）— nodes 模式正文只允许来自 manifest 的 body 工件，会话汇报文本一律不得作正文',
        guard: 'body_contract_missing',
      });
      st0.setStepStatus(st.id, 'failed');
      o.journal.stepEvent(st, 'step_failed', { error: 'body contract missing', guard: 'body_contract_missing' });
      return;
    }
    // 正文解析（契约优先）：body_ref → 工件库按 id 取字节、按哈希核验——
    // 批准时绑定的哈希与取件哈希不一致 = 工件被篡改，拒发。无 ref 时回退
    // 内联 body（ladder 旧链路）。
    let body = asString(st.input['body']);
    let bodyVia: string = body.trim() !== '' ? 'inline' : '';
    if (hasBodyRef) {
      const ref = bodyRefIn as { id?: unknown; sha256?: unknown };
      const id = typeof ref.id === 'string' ? ref.id : '';
      const sha = typeof ref.sha256 === 'string' ? ref.sha256 : '';
      if (id === '' || !deps.artifacts?.getContent) {
        st0.setStepOutput(st.id, { error: 'body_ref present but artifact store unavailable — reply refused' });
        st0.setStepStatus(st.id, 'failed');
        o.journal.stepEvent(st, 'step_failed', { error: 'body_ref without store' });
        return;
      }
      // 契约完整性（第 5 轮审查）：sha256 为空串 = 批准时没绑哈希，「批准的
      // 哈希=取件的哈希」不变式无从核验——拒发（guard 打标）。无哈希的指针
      // 不是契约（与 isDeliverableRef 的指针语义对齐）；sweep 正常播种恒带
      // 真实哈希，空串只来自残缺申报/amend——宁可拒发。
      if (sha === '') {
        st0.setStepOutput(st.id, {
          error: 'body_ref.sha256 缺失 — 正文契约不完整（批准哈希无从核验），拒发；请 rework-send 或 amend 补齐',
          guard: 'body_contract_incomplete',
        });
        st0.setStepStatus(st.id, 'failed');
        o.journal.stepEvent(st, 'step_failed', { error: 'body contract incomplete', guard: 'body_contract_incomplete' });
        return;
      }
      const content = await deps.artifacts.getContent(id).catch(() => null);
      if (content === null) {
        st0.setStepOutput(st.id, { error: `body artifact ${id} not found — reply refused` });
        st0.setStepStatus(st.id, 'failed');
        o.journal.stepEvent(st, 'step_failed', { error: 'body artifact missing' });
        return;
      }
      // 哈希核验对【取回字节】重算——账本登记值只作参考，传输/磁盘层面的
      // 任何篡改（字节变了账本没变）在这里被抓。
      const actual = createHash('sha256').update(content.bytes).digest('hex');
      if (sha !== '' && actual !== sha) {
        st0.setStepOutput(st.id, {
          error: `body artifact hash mismatch (approved ${sha.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — 内容与批准版本不一致，拒发`,
        });
        st0.setStepStatus(st.id, 'failed');
        o.journal.stepEvent(st, 'step_failed', { error: 'body hash mismatch' });
        return;
      }
      body = content.bytes.toString('utf8');
      bodyVia = `artifact:${id}`;
    }
    // 灾难守卫:空正文绝不出门(2026-09-11 事故——种子断链导致空信发给客户)。
    // guard 打标：内容缺陷 retry 永远不好——前端据此把「重试」换成「打回补正」。
    if (body.trim() === '') {
      st0.setStepOutput(st.id, { error: 'empty body — reply refused (draft seeding broke upstream)', guard: 'empty_body' });
      st0.setStepStatus(st.id, 'failed');
      o.journal.stepEvent(st, 'step_failed', { error: 'empty body', guard: 'empty_body' });
      return;
    }
    // 落款拼装（2026-09-14 裁决二轮）：落款所有权归引擎——审批正文（剥掉
    // 残留落款）+ 引擎自有落款常量；「juli Labs」被写成「举例科技」的漂移
    // 事故由此根治。守卫与渲染都作用于拼装后的完整正文。
    // 剥落款后主文再判空（第 3 轮审查问题 5）：草稿只有落款块（以「此致」
    // 开头/首个落款块前无正文）时 stripSignature 返回空串，上面的空正文守卫
    // 作用于剥落款前、拦不住「空白正文+落款」的信——空则同样拒发。
    const mainBody = stripSignature(body);
    if (mainBody.trim() === '') {
      st0.setStepOutput(st.id, { error: 'empty body after signature strip (signature-only draft) — reply refused', guard: 'empty_body' });
      st0.setStepStatus(st.id, 'failed');
      o.journal.stepEvent(st, 'step_failed', { error: 'empty body (signature-only draft)', guard: 'empty_body' });
      return;
    }
    // 实质截断留痕：剥掉的长度明显超过落款模板本身 → 剥掉的不是落款而是正文
    // （如整段引用客户原文、原文恰好含「此致」）。常态「模型按旧习惯补了落款」
    // 剥掉的 ≈ \n+SIGNATURE_TEXT（66 字符，自由发挥落款也就 +30 量级），阈值
    // 105 字符给足余量不误报；整段误剥动辄数百字符。保守照发（方向上宁可少
    // 发不错发），事件留痕供人核。
    const strippedChars = body.length - mainBody.length;
    if (strippedChars > SIGNATURE_TEXT.length + 40) {
      o.journal.stepEvent(st, 'send_body_truncated', { stripped_chars: strippedChars });
    }
    body = composeTextBody(body);
    // 红线硬守卫：内部词汇出门前最后一道机器闸（与闸门 checks 同表，send 侧
    // 强制复跑——审阅后的任何路径变更都逃不过）。
    const hit = redlineHit(body, deps.redlineWords ?? DEFAULT_REDLINE_WORDS);
    if (hit !== undefined) {
      st0.setStepOutput(st.id, { error: `redline word "「${hit}」" in body — reply refused`, guard: 'redline' });
      st0.setStepStatus(st.id, 'failed');
      o.journal.stepEvent(st, 'step_failed', { error: `redline: ${hit}`, guard: 'redline' });
      return;
    }
    // AI 披露硬守卫：落款固定块漏写/截断/改写时宁可拒发（与闸门 checks 同判
    // 据，redline 同构）。nodes 模式的 send 节点在批准后才追加，闸门 checks 无
    // 从跑起——这里是唯一必经的机器闸。
    if (disclosureMissing(body)) {
      st0.setStepOutput(st.id, { error: 'AI 披露行缺失（「本邮件由 AI 助理答复…」）— reply refused：落款固定块不可省略', guard: 'disclosure' });
      st0.setStepStatus(st.id, 'failed');
      o.journal.stepEvent(st, 'step_failed', { error: 'disclosure missing', guard: 'disclosure' });
      return;
    }
    const inReplyTo = asString(st.input['in_reply_to']);
    // 抄送（断点十）：种子侧从申报单 envelope.cc 播种，这里带给 mailer——
    // 只通链路，不做编辑/校验循环。2026-09-20 P1 回信流收口：meta.from 在位
    // =回信流，与收件人同一优先级锁——种子已不播 cc，这里再兜住直写/amend/
    // retry 改 send 步 input.cc 的通道（审计在种子侧 envelope_cc_override_
    // ignored 留痕；任务流 nodes 播种的 cc 照常出门）。
    const ccIn = st.input['cc'];
    const cc = asString(w.meta['from']).trim() !== ''
      ? []
      : Array.isArray(ccIn)
        ? ccIn.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        : [];
    // 交付契约附件（2026-09-15 断点八收窄）：只随 view_role 为
    // attachment/data 的工件——report 是闸门人审视图，绝不随信出门
    // （reply-review.html 外泄事故）。宣称与实物一致：正文写"见附件"就
    // 必须真附；0913 事故：正文说见附件但只发了正文。
    const dl = Array.isArray(st.input['deliverables']) ? st.input['deliverables'] as { id: string; name: string; view_role: string }[] : [];
    // name 一并复核（R8 批2）：agent 申报缺 name 时 undefined 会直进 SMTP 附件名。
    const attachmentRefs = dl.filter((x) =>
      typeof x.id === 'string' && typeof x.name === 'string' && (x.view_role === 'attachment' || x.view_role === 'data'));
    const attachments: { name: string; bytes: Buffer }[] = [];
    if (attachmentRefs.length > 0 && deps.artifacts?.getContent) {
      for (const ref of attachmentRefs) {
        const content = await deps.artifacts.getContent(ref.id).catch(() => null);
        if (content !== null) attachments.push({ name: ref.name, bytes: content.bytes });
      }
    }
    // 宣称与实物一致（守卫移出 deliverables 条件块，wf_e4013364bc8d）：正文
    // 宣称附件但一件可附工件都没有——契约缺位（deliverables 为空）与取件
    // 失败同样过不了这道闸（0913 事故：正文说见附件但只发了正文）。guard
    // 打标：内容缺陷 retry 永远不好，前端据此把「重试」换成「打回补正」。
    // 正则只认「存在性宣称」句式——裸「附件」会误伤「无附件/没有附件」表述；
    // 引用对方措辞的收执句（您…附上的…已收到）经 claimsAttachment 共现排除
    // 不误伤（第 5 轮审查），方向仍保守（错拦不错发）。
    if (claimsAttachment(body) && attachments.length === 0) {
      st0.setStepOutput(st.id, { error: '正文宣称附件但无任何可附工件 — 宣称与实物不一致，拒发', guard: 'declared_attachments_missing' });
      st0.setStepStatus(st.id, 'failed');
      o.journal.stepEvent(st, 'step_failed', { error: 'declared attachments missing', guard: 'declared_attachments_missing' });
      return;
    }
    // 语义红线体检（redline_semantic，2026-09-27，影子先行）：机械词表拦不住
    // 的形态——不可兑现的承诺、越权声明、敏感数据外泄、实质性误导。shadow=
    // 留痕；on+高置信踩线=redline_flagged 事件（今晚不拦发——发送硬契约已
    // 有机器闸三层，语义版先并行攒数据，拦发与否留数据后裁决）。
    // 后台执行（2026-09-27 审查 P2-7）：两态都不拦发——判定 RTT 没理由阻塞
    // 持锁的发送路径，fire-and-forget 让 provider 黑洞最坏 30s 只延迟留痕
    // 事件、不延迟发送本身。
    if (deps.judgment !== undefined) {
      const judgment = deps.judgment;
      void (async () => {
        const outcome = await judgment.ask('redline_semantic',
          { to, subject, body: body.slice(0, 2000) },
          {
            redline: {
              type: 'noul',
              instructions: 'Does this outbound email cross a semantic red line: an unfulfillable promise, an unauthorized commitment, disclosure of sensitive internal data, or a materially misleading claim?',
            },
          });
        if (outcome !== null && outcome.ok) {
          const p = { mode: outcome.mode, scenario: 'redline_semantic', answer: outcome.answer ?? '', confidence: outcome.confidence ?? 0, provider: outcome.provider, model: outcome.model ?? '', input_tokens: outcome.inputTokens ?? 0, output_tokens: outcome.outputTokens ?? 0, duration_ms: outcome.durationMs ?? 0 };
          if (outcome.mode === 'on' && outcome.answer === 'true' && (outcome.confidence ?? 0) >= outcome.threshold) {
            o.journal.stepEvent(st, 'redline_flagged', p);
          } else {
            o.journal.stepEvent(st, 'redline_judgment', p);
          }
        } else if (outcome !== null) {
          o.journal.stepEvent(st, 'redline_judgment', { mode: outcome.mode, scenario: 'redline_semantic', error: outcome.error ?? '' });
        }
      })().catch(() => undefined); // 留痕尽力而为，绝不反噬发送主链
    }
    // 客户可见形态（2026-09-14 美化裁决）：text=审批文本（哈希取件不变式），
    // html=代码确定性渲染（emailView）——LLM 不画样式，样式不进审批回路。
    const html = renderEmailHtml(body);
    const res = await deps.mailer.send({
      to, subject, body, html, inReplyTo,
      ...(cc.length > 0 ? { cc } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    if (!res.ok) {
      st0.setStepOutput(st.id, { error: res.error.message });
      st0.setStepStatus(st.id, 'failed');
      o.journal.stepEvent(st, 'step_failed', { error: res.error.message });
      return;
    }
    const messageId = res.value.messageId;
    st0.setStepOutput(st.id, {
      to, message_id: messageId, sent_at: rfc3339(now()),
      ...(cc.length > 0 ? { cc: cc } : {}),
      ...(bodyVia !== '' ? { body_via: bodyVia } : {}),
    });
    st0.appendEvent('workflow', st.workflowId, 'email_sent', {
      to, message_id: messageId, ...(cc.length > 0 ? { cc: cc as unknown as JsonValue } : {}),
    });
    growReferences(st.workflowId, messageId);
    st0.setStepStatus(st.id, 'completed');
    o.journal.stepEvent(st, 'step_completed', {});
    await o.late.advanceLocked(st.workflowId);
    // 自动结算不在这里：发送≠账目终点，skill 的收尾回合（确认发送→简要汇报）
    // 也属本单——收口点在会话结束，见 onAgentStopped/autoSettleAfterSend
    // （2026-09-14 裁决）。
  };

  // ---- 引用链 -----------------------------------------------------------------------

  const growReferences = (workflowId: string, messageId: string): void => {
    const w = store.getWorkflow(workflowId);
    if (!w) return;
    // 九跑 P2 类型翻转修复：读取兼容存量 string（修复前进件存的是空格分隔
    // 原文）——原实现把非 Array 一律当 [] 再整体替换，首封回信就抹掉进件
    // 原链。现在 normalize 后追加，引用链跨代保真。
    const raw = w.meta['references'];
    const refs = Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === 'string' && x !== '')
      : (typeof raw === 'string' ? raw.split(/\s+/).filter(Boolean) : []);
    store.updateWorkflowMeta(workflowId, { references: [...refs, messageId] });
    const cf = store.loadCaseFile(workflowId);
    store.saveCaseFile(workflowId, appendReference(cf, messageId, now()));
  };

  return { openGate, runAgentStep, runSendStep, resolveBodyText, gateWorkflowActive, renderSeedPlan };
};

