// 生命周期动词：起单族（startFlow 模板流/startTask 免模板/nodes 追加 appendNode）
// 与收口族（settle 人工结算/closeWorkflow 尸体收编/forceClose 活单中止/
// cancelStep 单步取消）。

import { rfc3339 } from '@juli-os/artifacts';
import { asString, truncate } from '../../platform/shared/json.ts'
import type { JsonRecord, JsonValue } from '@juli-os/artifacts'
import type { Logger } from '../../platform/events/bus.ts';
import type { LifecycleStore } from '@juli-os/ledger';
import { type Step, type StepKind, type Workflow } from '@juli-os/ledger';
import { STEP_KINDS } from '@juli-os/ledger';
import { isActiveStepStatus, isActiveWorkflowStatus, isLiveNodeStatus } from '../../contracts/statuses.ts';
import { carryStepConfig, type Template } from '../templates/template.ts';
import { envelopeTo, isSendGateDecision, seedSendFromGate } from '../send/sendSeed.ts';
import type { EngineDeps } from './engine.ts';
import type { Journal } from './journal.ts';
import type { Queue } from './queue.ts';
import type { Zombie } from './zombie.ts';

export interface Lifecycle {
  startFlow(templateKey: string, title: string, input: JsonRecord, onlySteps?: readonly string[]): Promise<Workflow>;
  startTask(title: string, input: JsonRecord): Promise<Workflow>;
  appendNode(workflowId: string, def: { kind: StepKind; title: string; input?: JsonRecord }): Promise<Step>;
  settle(workflowId: string, by: string): Promise<void>;
  closeWorkflow(workflowId: string, note: string, by: string): Promise<void>;
  forceClose(workflowId: string, note: string, by: string): Promise<void>;
  cancelStep(stepId: string, note: string, by: string): Promise<void>;
  finalSweepInbox(workflowId: string): Promise<void>;
}

export const makeLifecycle = (o: {
  readonly deps: EngineDeps;
  readonly store: LifecycleStore;
  readonly now: () => Date;
  readonly log: Logger;
  readonly withLock: <T>(workflowId: string, fn: () => Promise<T>) => Promise<T>;
  readonly journal: Journal;
  readonly queue: Queue;
  readonly zombie: Pick<Zombie, 'zombiePolicyMeta'>;
  readonly getTemplates: () => Readonly<Record<string, Template>>;
  readonly advanceLocked: (workflowId: string) => Promise<void>;
}): Lifecycle => {
  const { deps, store, log } = o;
  const now = o.now;

  /** 起流/起单共用的 meta 抽取（startFlow/startTask 原为 copy-paste 重复块）：
   * from/subject 进 meta——send 步的收件人被结构性锁在 meta.from，手动起流
   * 声明了 from 就获得完整答复能力（含发送），与邮件进件同一约束；
   * auto_approve 单子级免批（2026-10-07）：chat 计划卡「本单免批」勾选随
   * confirm 进来——创建即标记，闸门 sweep 直接吃（autoApprove.ts per-order
   * 分支）；in_reply_to 线程头透传进 meta.message_id——发送步的 msgId 兜底
   * 读它，跟帖不断线（juli-reply 线程纪律）。 */
  const copySendMeta = (input: JsonRecord, meta: Record<string, JsonValue>): void => {
    const fromV = input['from'];
    if (typeof fromV === 'string' && fromV.trim() !== '') meta['from'] = fromV.trim();
    const subjV = input['subject'];
    if (typeof subjV === 'string' && subjV.trim() !== '') meta['subject'] = subjV.trim();
    if (input['auto_approve'] === true) meta['auto_approve'] = true;
    const irtV = input['in_reply_to'];
    if (typeof irtV === 'string' && irtV.trim() !== '') meta['message_id'] = irtV.trim();
  };

  /** 收口兜底收编（settle/closeWorkflow 共用）：agent 迟到的交付文件不许
   * 烂在收口之后——结案前最后扫一次 case-inbox。尽力而为：失败只记日志，
   * 绝不阻断收口（收口是人工动作，工件可以事后从目录补录）。 */
  const finalSweepInbox = async (workflowId: string): Promise<void> => {
    if (!deps.artifacts) return;
    try {
      const res = await deps.artifacts.sweepCaseInbox(workflowId);
      if (res.count > 0) log.info(`case-inbox 收口兜底: ${workflowId} 收编 ${res.count} 件`);
    } catch (e) {
      log.error(`case-inbox 收口兜底失败 (${workflowId}): ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** 收口（人工结案）：failed 尸体的去向动作——下游 pending 全部 cancelled，
   * 审计全留，什么都不删。与 resolve 的区别：resolve 作用在等待中的闸门上，
   * close 作用在已经 failed 的整条流水上（僵尸转人工后的处置出口）。 */
  const closeWorkflow = async (workflowId: string, note: string, by: string): Promise<void> => {
    const w = store.getWorkflow(workflowId);
    if (!w) throw new Error(`workflow ${workflowId} not found`);
    if (w.status !== 'failed') throw new Error(`workflow ${workflowId} is not failed (status=${w.status})`);
    for (const s of store.stepsForWorkflow(workflowId)) {
      if (s.status === 'pending' || s.status === 'running') store.setStepStatus(s.id, 'cancelled');
    }
    store.setWorkflowStatus(workflowId, 'cancelled');
    store.appendEvent('workflow', workflowId, 'workflow_closed', { note, by, at: rfc3339(now()) });
    o.queue.releaseSlotOnClose(workflowId); // review F1:与 forceClose 同款收口放位兜底
    await finalSweepInbox(workflowId);
  };

  const startFlow = async (templateKey: string, title: string, input: JsonRecord, onlySteps?: readonly string[]): Promise<Workflow> => {
    const tpl = o.getTemplates()[templateKey];
    if (!tpl) throw new Error(`unknown flow template "${templateKey}"`);
    // 起流校验：模板声明的必需 input 缺了当场退回（HTTP 400 / CLI 报错），
    // 绝不让残缺单子进流水线——渲染期才炸等于冻死 pending 且人不可见。
    const missing = tpl.requires.filter((k) => {
      const v = input[k];
      return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    });
    if (missing.length > 0) {
      throw new Error(`template "${templateKey}" requires input keys [${tpl.requires.join(', ')}] — missing: ${missing.join(', ')}（可在起流时补齐，或对卡住步骤用 amend 补料）`);
    }
    // 单步/子集起流：只保留选中的步（保持模板顺序）——人工只需重跑某一步时，
    // 不必为一次执行复制改模板。
    let ladder = tpl.steps;
    if (onlySteps && onlySteps.length > 0) {
      const unknown = onlySteps.filter((id) => !tpl.steps.some((s) => s.id === id));
      if (unknown.length > 0) throw new Error(`unknown step ids: ${unknown.join(', ')}`);
      ladder = tpl.steps.filter((s) => onlySteps.includes(s.id));
    }
    const at = now();
    const two = (n: number): string => String(n).padStart(2, '0');
    const t = title.trim() !== '' ? title
      : `${tpl.name} · ${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
    // from/subject 进 meta：send 步的收件人被结构性锁在 meta.from——手动起流
    // 声明了 from 就获得完整答复能力（含发送），与邮件进件同一约束。
    // zombie_policy 同建流物化：模板快照语义的补全（见 zombiePolicyFor）。
    const meta: Record<string, JsonValue> = {
      template_key: tpl.key, template_hash: tpl.hash, template_input: input,
      ...o.zombie.zombiePolicyMeta(tpl),
    };
    // 挂靠：input.relates_to 指向既有流水 → 因果链入账（人肉开的单也是
    // 业务的一环，如"Casey 线拆出的 Banner 重做"）。
    const relatesTo = asString(input['relates_to']).trim();
    let parentId: string | undefined;
    if (relatesTo !== '') {
      const parent = store.getWorkflow(relatesTo);
      if (parent) {
        parentId = parent.id;
        meta['related_workflow'] = parent.id;
      } else {
        meta['relates_to_unknown'] = relatesTo;
      }
    }
    // from/subject/auto_approve/in_reply_to 四键抽取见 copySendMeta（注释在彼）。
    copySendMeta(input, meta);
    // nodes 模式:阶梯不预建——节点由动作(claim/deliver/send…)追加,
    // 模板只是词汇表;workflow 在显式 settle 前保持 running。
    if (tpl.mode === 'nodes') {
      const wn = store.createWorkflow({
        kind: tpl.key,
        title: truncate(t, 120),
        parentId,
        status: 'queued',
        meta: { ...meta, mode: 'nodes' },
      });
      store.appendEvent('workflow', wn.id, 'flow_started', { template: tpl.key, hash: tpl.hash, mode: 'nodes' });
      store.appendEvent('workflow', wn.id, 'task_queued', { via: `flow:${tpl.key}` });
      o.queue.enqueueBack(wn.id);
      return store.getWorkflow(wn.id) ?? wn;
    }
    const w = store.createWorkflow({
      kind: tpl.key,
      title: truncate(t, 120),
      parentId,
      status: 'queued',
      meta,
    });
    store.appendEvent('workflow', w.id, 'flow_started', { template: tpl.key, hash: tpl.hash, steps: ladder.map((s) => s.id) });
    store.appendEvent('workflow', w.id, 'task_queued', { via: `flow:${tpl.key}` });
    for (const [i, ts] of ladder.entries()) {
      let input0 = carryStepConfig(ts);
      if (i === 0) input0 = { ...input0, ...input };
      store.createStep({
        workflowId: w.id, seq: i + 1,
        kind: ts.kind, title: ts.title, input: input0,
      });
    }
    o.queue.enqueueBack(w.id);
    return store.getWorkflow(w.id) ?? w;
  };

  /** 免模板起单（动态模型的标准入口，内建 adhoc 语义）：relates_to 留链、
   * brief 进 template_input（前端任务卡）、mode nodes 等待动作追加。 */
  const startTask = async (title: string, input: JsonRecord): Promise<Workflow> => {
    const t = title.trim();
    if (t === '') throw new Error('title required');
    let inheritTo = ''; // 跟进继承的目标会话（relates_to 解析段填充；tier 改道可覆写）
    let inheritFrom = ''; // 继承来源单 id（事件留痕用）
    let inheritedFromParent = false; // 继承是否发生（与 tier 改道后的最终落点区分记账）
    let inheritedSession = ''; // 继承的原会话（session_inherited 事件与 tier 改道基准）
    const meta: Record<string, JsonValue> = { template_input: input, mode: 'nodes' };
    // from/subject/auto_approve/in_reply_to 四键抽取见 copySendMeta（注释在彼）。
    copySendMeta(input, meta);
    let parentId: string | undefined;
    const rel = asString(input['relates_to']).trim();
    if (rel !== '') {
      const parent = store.getWorkflow(rel);
      if (parent) { parentId = parent.id; meta['related_workflow'] = parent.id; }
      else meta['relates_to_unknown'] = rel;
      // 跟进会话继承（2026-09-28 用户口令「复用之前处理的 session」）：挂靠
      // 原单在哪个会话干过活，跟进就在哪续——上下文/证据记忆/工件全在原
      // 会话，落 defaultSession = 从零理解一遍（用户实录：acme 批量单的
      // 跟进被派给 juli-reply）。三不继承：显式 session 优先（调用方说了算）；
      // 绑定会话不继承（session_bound 守卫只认 sender 路由标记，继承必拒派）；
      // 原单无落点不猜。
      if (parent !== null && asString(input['session']).trim() === '') {
        const ps = parent.session.trim();
        const isBound = (deps.routing.boundAgents ?? []).some((b) => b.session === ps);
        if (ps !== '' && !isBound) {
          meta['session_inherited_from'] = parent.id;
          inheritTo = ps;
          inheritedSession = ps;
          inheritedFromParent = true;
          inheritFrom = parent.id;
        }
      }
      // feedback 锚继承（2026-09-28 主动 settle 补丁，两次实战咬人后补上）：
      // 挂靠原单带 feedback 锚（单 id 或批量 ids）→ 跟进单一并继承——
      // autoSettleFeedbackRuns 的「闸门已批+全链终态+回挂证据=自动收口」才
      // 认得跟进单（今日两次：干完部署仍停 running 等人手点完成）。单 id =
      // 首个记录（feedbackRecordIdOf 等单锚读者通吃），数组 = 全量去重
      // （isAnchor dedup/holdGate 圈定通吃）。已有锚不覆盖（调用方说了算）。
      if (parent !== null) {
        const pti = parent.meta['template_input'];
        const pt = (pti !== null && typeof pti === 'object' && !Array.isArray(pti) ? pti : {}) as Record<string, unknown>;
        const parentIds = Array.isArray(pt['feedback_record_ids'])
          ? (pt['feedback_record_ids'] as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        const parentId1 = typeof pt['feedback_record_id'] === 'string' ? pt['feedback_record_id'] : '';
        const ownIds = Array.isArray(input['feedback_record_ids'])
          ? (input['feedback_record_ids'] as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        const merged = [...new Set([...ownIds, ...parentIds])];
        const id1 = asString(input['feedback_record_id']) !== '' ? asString(input['feedback_record_id'])
          : parentId1 !== '' ? parentId1 : merged[0] ?? '';
        if (id1 !== '' || merged.length > 0) {
          meta['template_input'] = {
            ...input,
            ...(id1 !== '' ? { feedback_record_id: id1 } : {}),
            ...(merged.length > 0 ? { feedback_record_ids: merged } : {}),
          };
          meta['feedback_anchor_inherited_from'] = parent.id;
        }
      }
    }
    // 模型分层路由（2026-09-28 用户裁定「非必要不高智能」；2026-10-12 增
    // task_tier 自动档——jev 判难度，判 high 才升）：
    // input.model_tier='high' 时——①未点名会话（无 input.session、无继承）→ 改道
    // 声明 high 的会话：同 cwd 孪生优先（活儿还是那个仓，只是模型升档），否则
    // 第一个 high；②已点名会话（显式/渠道钉死/继承/task_tier 落孪生）→ 尊重
    // 落点不改道，落点非 high 只留 mismatch 事件（model_tier_by 在场=jev 升档
    // 记 model_tier_auto）；③无 high 声明 → 照旧派发 + unavailable 事件。
    // 全部 fail-open：tier 是成本优化不是硬约束，任何情况不拦单。standard/缺省
    // = 零变化。事件：model_tier_routed / model_tier_mismatch / model_tier_unavailable。
    let tierEvent: { kind: string; payload: JsonRecord } | null = null;
    if (asString(input['model_tier']).trim() === 'high') {
      const decls = deps.routing.agents ?? [];
      const highs = decls.filter((a) => a.model_tier === 'high' && a.session.trim() !== '');
      const explicit = asString(input['session']).trim();
      if (explicit !== '') {
        if (highs.length > 0 && !highs.some((a) => a.session === explicit)) {
          tierEvent = { kind: 'model_tier_mismatch', payload: { requested: 'high', session: explicit } };
        } else if (asString(input['model_tier_by']).trim() !== '' && highs.some((a) => a.session === explicit)) {
          // 自动升档留痕（2026-10-12 task_tier）：进件侧 jev 判 high 落孪生——
          // 与手动 mismatch/改道同流记账，审计一眼分得清「谁说的升档」。
          tierEvent = { kind: 'model_tier_auto', payload: { to: explicit, by: asString(input['model_tier_by']) } };
        }
      } else if (highs.length > 0) {
        const wantCwd = inheritTo !== ''
          ? decls.find((a) => a.session === inheritTo)?.cwd
          : undefined;
        const twin = wantCwd !== undefined && wantCwd !== '' ? highs.find((a) => a.cwd === wantCwd) : undefined;
        const pick = twin ?? highs[0]!;
        if (pick.session !== inheritTo) {
          tierEvent = inheritTo !== ''
            ? { kind: 'model_tier_routed', payload: { from: inheritTo, to: pick.session, twin: twin !== undefined } }
            : { kind: 'model_tier_routed', payload: { to: pick.session, twin: twin !== undefined } };
          inheritTo = pick.session;
        }
      } else {
        tierEvent = { kind: 'model_tier_unavailable', payload: { requested: 'high' } };
      }
    }
    const w = store.createWorkflow({ kind: 'adhoc', title: truncate(t, 120), parentId, status: 'queued', meta });
    store.appendEvent('workflow', w.id, 'task_started', { title: t, relates_to: rel });
    store.appendEvent('workflow', w.id, 'task_queued', { via: 'startTask' });
    // 发单即接手（wf_505578377218 停摆事故）：空 nodes 单对 advance 是「等
    // 下一次动作追加」，task_started 又无任何通知——零步单永远静止在 running。
    // 首节点在此播种：plan=brief（缺省回退标题；超长截断对齐邮件进件 8000
    // 上限——超长 brief 原样进 tmux bracketed-paste 任务卡无上限），session
    // 留空走 runAgentStep 的 defaultSession 兜底（与进件首节点同源）。播种
    // 失败显性 failed，绝不回落成无声停摆。
    const brief = asString(input['brief']).trim();
    // 渠道路由（2026-09-21）：input.session 非空 = 进件渠道钉死起点（feedback
    // 声明命中 / CLI 显式指定）；留空保持 defaultSession 兜底（旧行为不变）。
    const seedSession = asString(input['session']).trim() || inheritTo; // 显式 > 继承/tier 改道 > default 兜底
    if (inheritedFromParent) {
      store.appendEvent('workflow', w.id, 'session_inherited', { from: inheritFrom, session: inheritedSession });
    }
    if (tierEvent !== null) {
      store.appendEvent('workflow', w.id, tierEvent.kind, tierEvent.payload);
    }
    if (w.meta['feedback_anchor_inherited_from'] !== undefined) {
      const ti = w.meta['template_input'] as JsonRecord;
      store.appendEvent('workflow', w.id, 'feedback_anchor_inherited', {
        from: asString(w.meta['feedback_anchor_inherited_from']),
        record_id: asString(ti['feedback_record_id']),
        count: Array.isArray(ti['feedback_record_ids'])
          ? (ti['feedback_record_ids'] as unknown[]).length : 0,
      });
    }
    try {
      // 钉住收窄（2026-10-13 双落点事故裁定「忙时优先空闲 agent」）：只有
      // 「显式 input.session」=人的意志（chat 钉住转述/CLI --session/feedback
      // 渠道规则/HTTP 注入）才播种 session_pinned——忙时真排队等它、不被
      // 改道（0930 宁可慢不换人保留给人）。挂靠继承/tier 改道是机器推断的
      // 落点，不再钉：播种仍写 session（上下文倾向），派发时过忙闲判定
      // （engine holdGate 忙会话腿压单 + steps 守卫改道空闲 agent）。
      const pinned = asString(input['session']).trim() !== '';
      store.insertStepsAt(w.id, 0, [{
        kind: 'agent', title: '理解与接单',
        input: seedSession === ''
          ? { plan: truncate(brief !== '' ? brief : t, 8000), seq_ref: 'n1' }
          : { plan: truncate(brief !== '' ? brief : t, 8000), seq_ref: 'n1', session: seedSession, session_pinned: pinned },
      }]);
      // 落点锚定提前到播种（0930 忙闲重定义）：忙=名下非终态单——queued 期
      // 就要占住会话，否则「排队也是忙」判定不到。派发面幂等再写。
      if (seedSession !== '') store.setWorkflowSession(w.id, seedSession);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      store.setWorkflowStatus(w.id, 'failed');
      store.appendEvent('workflow', w.id, 'workflow_failed', { reason: `seed_failed: ${msg}` });
      log.error(`[engine] startTask ${w.id} 首节点播种失败 → failed: ${msg}`);
      throw e;
    }
    // 播种落账后入队 fire-and-forget（收单台 0920：startTask 只等「节点插库」
    // 不等「派发」——冷会话 provisioning 等待绝不串进 HTTP / feedback sweep 的
    // 等待路径；何时开跑由收单台 FIFO 决定）。派发失败走 step_failed 事件+
    // 推送（引擎既有失败通知面），与 approve 后的异步执行链同语义。
    o.queue.enqueueBack(w.id);
    return store.getWorkflow(w.id) ?? w;
  };

  /** nodes 模式核心原语:动作生节点。幂等——同 kind+title 的
   * pending/running 节点已存在时直接返回既有节点;send 更按 kind 判重
   * （不看 title，断点六①）。 */
  const appendNode = async (workflowId: string, def: { kind: StepKind; title: string; input?: JsonRecord }): Promise<Step> => {
    // kind 前置校验：HTTP 层的 `as StepKind` 直通不允许把未知 kind 写进账本
    // （解释器只 log.error，未知节点会 pending 永冻）。
    if (!STEP_KINDS.includes(def.kind)) {
      throw new Error(`unknown step kind "${String(def.kind)}" (legal: ${STEP_KINDS.join('/')})`);
    }
    const w0 = store.getWorkflow(workflowId);
    if (!w0) throw new Error(`workflow ${workflowId} not found`);
    // review F7：queued 也放行——排队期允许补节点（插入后照常走泵，首次
    // 派发自然带上）；终态才是 closed。
    if (!isActiveWorkflowStatus(w0.status)) {
      throw new Error(`workflow ${workflowId} is ${w0.status} — closed runs take no new nodes`);
    }
    // 与闸门动作同一并发模型：查重 + 前置校验 + 插入在锁内一气呵成；推进按
    // 收单台缝合（0920）：占位中照旧锁内续推（机器链未断），已放位（停在
    // 闸门/nodes 空档/排队中）则只插入、锁外走队列——机器工作不越过收单台。
    const inserted = await o.withLock(workflowId, async () => {
      const w = store.getWorkflow(workflowId);
      if (!w) throw new Error(`workflow ${workflowId} not found`);
      if (!isActiveWorkflowStatus(w.status)) {
        throw new Error(`workflow ${workflowId} is ${w.status} — closed runs take no new nodes`);
      }
      const steps = store.stepsForWorkflow(workflowId);
      // 对外承诺前置校验:发送节点必须已有「已批准的审阅节点」背书。
      if (def.kind === 'send' &&
          !steps.some((s) => s.kind === 'gate' && s.status === 'completed')) {
        throw new Error('send requires an approved review node first（先审后发）');
      }
      // send 按 kind 去重（2026-09-15 断点六①，wf_4be459bfd035 双发事故）：
      // 标题只是 UI 标签，不参与判重——同单已有非终态（pending/running/
      // waiting_human/completed）的 send 节点时返回既有节点，绝不新建第二封。
      // 多余的重复节点走 cancelStep 合规取消。
      if (def.kind === 'send') {
        const existing = steps.find((s) => s.kind === 'send' && isLiveNodeStatus(s.status));
        if (existing) return existing;
      }
      // 任务流发送闸门拒收（wf_505578377218 静默事故的第一道闸）：无原始
      // 发件人（meta.from）却不申报收件人（envelope.to）= 批准后无处可发。
      // 当场打回让 agent 补报（客户库可查地址）——闸门开不起来，就没有
      // 「批了却无声无息」的组合。回信流有 from 不受影响。必须在插库前：
      // 先插后抛会留下孤儿闸门。发送语义判据 isSendGateDecision 与标题解耦
      // （P2）：非「发送」标题但申报了 envelope.to 的闸门同受此闸约束。
      if (def.kind === 'gate' && isSendGateDecision(def.title, def.input ?? {}) &&
          asString(w.meta['from']).trim() === '' &&
          envelopeTo(def.input ?? {}) === '') {
        throw new Error('发送闸门须申报收件人（input.envelope.to）——本单无原始发件人，不申报则批准后无处可发；若此单本就不是邮件交付（feedback/内部工单/artifact 交付），请申报 delivery:\'apply\'（批准=生效）或 \'artifact\'（纯确认），不要借发送语义开确认闸');
      }
      const dup = steps.find((s) => s.kind === def.kind && s.title === def.title &&
        (s.status === 'pending' || s.status === 'running'));
      if (dup) return dup;
      const lastSeq = steps.length > 0 ? steps[steps.length - 1]!.seq : 0;
      store.insertStepsAt(workflowId, lastSeq, [{
        kind: def.kind, title: def.title,
        input: { ...def.input, seq_ref: `n${lastSeq + 1}` },
      }]);
      // 发送闸门自动配对（wf_e4013364bc8d「忘挂 send」+ wf_505578377218
      // 「批了没发」两代事故）：发送语义闸门一律连带 send 后继，不再以
      // meta.from 为前提——收件人由 resolveSendRecipient 解析（任务流=envelope.to
      // 申报，回信流=meta.from），双空时 send 步以 no_recipient 显式 failed。
      // 这条绕过上面的「先审后发」前置校验：send 与 gate 同时落地，gate 就是
      // 审。幂等：链上已有非终态 send（任何标题，断点六①判据）不重建。
      // 判据 isSendGateDecision 与标题解耦（P2）：申报了 envelope.to 的
      // 非「发送」标题闸门同样配对——「批了却没发」不再取决于 agent 起的文案。
      if (def.kind === 'gate' && isSendGateDecision(def.title, def.input ?? {}) &&
          !steps.some((s) => s.kind === 'send' && isLiveNodeStatus(s.status))) {
        store.insertStepsAt(workflowId, lastSeq + 1, [{
          kind: 'send', title: '发送答复', input: { seq_ref: `n${lastSeq + 2}` },
        }]);
      }
      // send 节点播种：nodes 模式合法顺序 deliver→review→approve→send 里，
      // approve 的播种发生在 send 节点存在之前——追加时从最近已批准闸门补种
      // （body/deliverables/body_ref），否则发送步永远空正文被守卫拒发。
      if (def.kind === 'send') {
        const gate = [...steps].reverse().find((s) => s.kind === 'gate' && s.status === 'completed');
        if (gate) {
          const insertedSteps = store.stepsForWorkflow(workflowId);
          seedSendFromGate(store, gate, insertedSteps[insertedSteps.length - 1]!);
        }
      }
      if (o.queue.activeIds.has(workflowId)) {
        await o.advanceLocked(workflowId);
      }
      // 返回调用方请求的那个节点（自动配对时链尾是 send，不能张冠李戴）。
      const fresh = store.stepsForWorkflow(workflowId);
      return fresh.find((s) => s.seq === lastSeq + 1) ?? fresh[fresh.length - 1]!;
    });
    if (!o.queue.activeIds.has(workflowId)) o.queue.enqueueFront(workflowId);
    return inserted;
  };

  /** 人工中止（running/queued 单的取消出口，2026-09-13 用户诉求"前端取消重开"；
   * 0920 收单台 review F2：queued 纳入——排队单的合法干预就是移出队列）：
   * 在跑步/等待闸门/排队未派的步骤全部 cancelled，审计全留——与 close 的
   * 区别：close 只收 failed 尸体，force 是活单的中止（用户明确说不做了）。 */
  const forceClose = async (workflowId: string, note: string, by: string): Promise<void> => {
    const w = store.getWorkflow(workflowId);
    if (!w) throw new Error(`workflow ${workflowId} not found`);
    if (!isActiveWorkflowStatus(w.status)) {
      throw new Error(`workflow ${workflowId} is not running or queued (status=${w.status})`);
    }
    for (const st of store.stepsForWorkflow(workflowId)) {
      if (isActiveStepStatus(st.status)) {
        store.setStepOutput(st.id, { cancelled_by: by, cancel_note: note });
        store.setStepStatus(st.id, 'cancelled');
        o.journal.stepEvent(st, 'step_cancelled', { by, note });
      }
    }
    store.setWorkflowStatus(workflowId, 'cancelled');
    store.appendEvent('workflow', workflowId, 'workflow_force_closed', { note, by, at: rfc3339(now()) });
    // review F1(P0) 修复：占位中的单被中止，链不再运行、evaluateSlot 不会再
    // 被触发——不显式放位 = 死槽（并发 1 下全队卡到重启）。
    o.queue.releaseSlotOnClose(workflowId);
  };

  /** 单步取消（2026-09-15 断点六③）：auto-pair 与手动 send 撞车后，多余的
   * 重复节点此前没有任何合规取消通道（gate 有 resolve、整单有 force-close，
   * 单个节点只能直改 SQLite——被权限层正确拦截的那个洞）。只许取消还没开跑
   * 的步（pending/waiting_human）：running 的在飞结果必须等结算（僵尸路径
   * 兜底），终态已成事实不可翻。与 forceClose 同款审计形态：output 标记 +
   * step_cancelled 事件，什么都不删。 */
  const cancelStep = async (stepId: string, note: string, by: string): Promise<void> => {
    const st0 = store.getStep(stepId);
    if (!st0) throw new Error(`step ${stepId} not found`);
    await o.withLock(st0.workflowId, async () => {
      // 锁内重读：等锁期间步可能已被推进/结算。
      const st = store.getStep(stepId);
      if (!st) throw new Error(`step ${stepId} not found`);
      // review F2：queued 单的步全 pending，逐个 cancel 会留下「单仍 queued
      // 却被泵照派」的残废执行——排队单的合法干预是整单中止（force-close）。
      const wq = store.getWorkflow(st.workflowId);
      if (wq && wq.status === 'queued') {
        throw new Error(`workflow ${st.workflowId} is queued — 用整单中止（force-close）移出队列，不逐段取消`);
      }
      if (st.status !== 'pending' && st.status !== 'waiting_human') {
        throw new Error(`step ${stepId} is ${st.status} — only pending/waiting_human steps can be cancelled`);
      }
      store.setStepOutput(st.id, { cancelled_by: by, cancel_note: note });
      store.setStepStatus(st.id, 'cancelled');
      o.journal.stepEvent(st, 'step_cancelled', { by, note });
      log.info(`[engine] step ${st.id} (${st.kind}/${st.title}) cancelled by ${by}`);
      // 推进语义（第 5 轮审查）：这里刻意不 advance——被取消步之后若还有
      // pending 步（历史撞车单的形态），链停在空档等下一次外部动作
      // （appendNode/hook/sweep），与 nodes「空档=等动作」语义一致；不自动
      // 续推，避免取消闸门后意外派发下游（如把 pending send 推进守卫）。
    });
  };

  // settle 实体（锁内语义）：守卫判定与置状态之间不容 appendNode/闸门动作
  // 插队（第 3 轮审查问题 4：锁外读-写窗口可把 pending 节点孤儿化）。
  // 调用方必须不持有本 workflow 锁——公开 settle 负责 withLock；引擎内
  // autoSettleAfterSend 从锁外进入同一公开入口，无锁内调用点（队列锁非
  // 可重入，锁内调用会排队等自己）。
  const settleLocked = async (workflowId: string, by: string): Promise<void> => {
    const w = store.getWorkflow(workflowId);
    if (!w) throw new Error(`workflow ${workflowId} not found`);
    // 已终态幂等返回：不重复追加 run_settled；cancelled/failed 各有显式
    // 收口动词（close/force-close），settle 不借道翻状态。
    if (w.status === 'completed' || w.status === 'cancelled' || w.status === 'failed') return;
    const steps = store.stepsForWorkflow(workflowId);
    const running = steps.some((s) => s.status === 'running');
    if (running) throw new Error('running node exists — settle it first');
    // waiting_human 闸门 / pending 步未了结就 settle → 闸门成孤儿（此后
    // approve 被 gateWorkflowActive 拒）。人审先 resolve/approve；要硬收口
    // 走显式动词 force-close（与 autoSettleAfterSend 的全终态守卫同口径，
    // 锁内为准）。
    const blocked = steps.find((s) => s.status === 'waiting_human' || s.status === 'pending');
    if (blocked) {
      throw new Error(`unsettled node exists (${blocked.status}: ${blocked.title}) — resolve/approve it first, or force-close`);
    }
    // 发送承诺未兑现拒结算（wf_505578377218：批准发送闸门 18 秒后单子被
    // settle 成 completed，事故无痕入土）：已批发送语义闸门（isSendGateDecision，
    // 与标题解耦——P2：非「发送」标题但申报了 envelope.to 同罪）而链上既无
    // 完成也无显式取消的 send 步 → settle 打回。真不发了走 force-close 留痕。
    const sendGate = steps.find((s) => s.kind === 'gate' && isSendGateDecision(s.title, s.input) && s.status === 'completed');
    if (sendGate !== undefined) {
      const sends = steps.filter((s) => s.kind === 'send');
      const honored = sends.some((s) => s.status === 'completed') ||
        sends.some((s) => s.status === 'cancelled');
      if (!honored) {
        throw new Error(`发送闸门「${sendGate.title}」已批准但从未发送（send 未完成也未取消）— 先让 send 完成，或 force-close 显式放弃`);
      }
    }
    store.setWorkflowStatus(workflowId, 'completed');
    store.appendEvent('workflow', workflowId, 'run_settled', { by, at: rfc3339(now()) });
    o.queue.releaseSlotOnClose(workflowId); // review F1(P0):settle 占位中的单必须放位,否则死槽
    // 收口兜底收编：settle 前最后扫一次 case-inbox（尽力而为，失败只记日志）。
    await finalSweepInbox(workflowId);
    // 结案流程图：2026-10-04 用户裁定彻底删除（wf_00a2a1339b3a）——settle
    // 路径这处才是主生成点（上单 a698bc9 只停 interpreter 一处漏了这里）。
  };

  const settle = async (workflowId: string, by: string): Promise<void> => {
    await o.withLock(workflowId, () => settleLocked(workflowId, by));
  };

  return { startFlow, startTask, appendNode, settle, closeWorkflow, forceClose, cancelStep, finalSweepInbox };
};
