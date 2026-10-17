// 进件：邮件（onEmailReceived→startEmailWorkflow 全链：自回环守卫/授权/
// 线程三级建档/Party 指针/工件物证/绑定路由/route_decision 留痕/首节点
// 任务卡）与泛化渠道（onInbound：按渠道路由模板的动态进件）。

import { type Clock } from '@juli-os/artifacts';
import { truncate } from '../../platform/shared/json.ts'
import { normalizeEmail } from '../../platform/shared/email.ts';
import type { Logger } from '../../platform/events/bus.ts';
import type { LifecycleStore } from '@juli-os/ledger';
import { type Workflow } from '@juli-os/ledger';
import {
  parseCaseFile, withOriginal,
} from '@juli-os/ledger';
import { DEDUP_META_KEY, dedupKey, type EmailMessage } from '../../contracts/ports.ts';
import type { InboundMessage } from '../../contracts/channels.ts';
import { checkAuthz, type AuthzPolicy } from '../../contracts/authz.ts';
import type { PartyMatch } from '../party/party.ts';
import { decideRoute, isInternalSender } from '@juli-os/routing';
import { INTAKE_PROMPT } from './support.ts';
import type { EngineDeps } from './engine.ts';
import type { Queue } from './queue.ts';

export interface Intake {
  onEmailReceived(m: EmailMessage): Promise<void>;
  /** 泛化入站：按渠道名路由到 trigger 匹配的模板（email 渠道走专用路径）。 */
  onInbound(m: InboundMessage): Promise<void>;
  startEmailWorkflow(m: EmailMessage): Promise<Workflow>;
}

/** references 归一化（九跑 P2 类型翻转修复）：进件 meta 统一存 id 数组
 * （原实现存空格分隔原文 string，首封回信经 growReferences 整体替换成数组
 * 抹掉进件原链、线程扫描又只认数组——跨代线程只能靠 30 天主题窗兜底）。
 * 读取侧新旧两态都收：数组（现行）+ string（修复前存量落库）。 */
const refsOf = (v: unknown): string[] => {
  if (typeof v === 'string') return v.split(/\s+/).filter(Boolean);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x !== '');
  return [];
};

export const makeIntake = (o: {  readonly deps: EngineDeps;
  readonly store: LifecycleStore;
  readonly clock: Clock;
  readonly now: () => Date;
  readonly log: Logger;
  readonly getAuthz: () => AuthzPolicy;
  readonly queue: Pick<Queue, 'enqueueBack'>;
}): Intake => {
  const { deps, store, log } = o;
  const now = o.now;

  const onInbound = async (m: InboundMessage): Promise<void> => {
    if (m.channel === 'email') {
      await onEmailReceived({
        from: m.from, to: '', subject: m.subject, body: m.body,
        messageId: m.messageId ?? '', date: m.ts, uid: 0, attachments: [],
      });
      return;
    }
    // 泛化渠道：按 trigger 选模板（无匹配模板 = 渠道未启用，记日志忽略）。
    if (store.hasActiveDedup(m.dedupKey)) return;
    const reason = checkAuthz(o.getAuthz(), m.from);
    if (reason !== null) {
      log.info(`[inbound:${m.channel}] rejected ${m.from}: ${reason}`);
      return;
    }
    // 动态模型：泛化渠道同 email——无 trigger 路由，事件直达 nodes。
    const t = title0(m.subject, m.channel);
    const w = store.createWorkflow({
      kind: m.channel, title: truncate(t, 120), status: 'queued',
      meta: { from: m.from, channel: m.channel, subject: m.subject, dedup_key: m.dedupKey, mode: 'nodes' },
    });
    store.appendEvent('workflow', w.id, 'flow_started', { channel: m.channel, from: m.from });
    store.appendEvent('workflow', w.id, 'task_queued', { via: `inbound:${m.channel}` });
    let cf0 = parseCaseFile(null, now());
    cf0 = withOriginal(cf0, {
      from: m.from, subject: m.subject, body: m.body, messageId: m.messageId ?? '',
    }, now());
    store.saveCaseFile(w.id, cf0);
    store.createStep({
      workflowId: w.id, seq: 1,
      kind: 'agent', title: '理解（读原文）',
      input: {
        from: m.from, from_name: '',
        subject: m.subject,
        body: truncate(m.body, 8000), prompt: INTAKE_PROMPT,
      },
    });
    log.info(`[inbound:${m.channel}] 工作流 ${w.id} 已建（动态进件）`);
    o.queue.enqueueBack(w.id);
  };
  const title0 = (subject: string, fallback: string): string =>
    subject.trim() !== '' ? subject : fallback;

  // ---- 对话（Thread）一等建模（2026-09-21 二期）---------------------------------
  /** 回复/转发主题前缀（中英混排，半/全角冒号都收；大小写不敏感）。 */
  const THREAD_SUBJECT_PREFIX = /^(?:回复|答复|回覆|转发|re|fw|fwd|aw|sv)\s*[:：]\s*/i;
  /** 主题归一化：循环剥前缀（「回复：Re: PPT 需求」与「PPT 需求」同键）+ trim + 小写。
   * 纯函数；web 看板的展示侧去噪持有一份对齐副本（web 不引 src，见 kanban.ts）。 */
  const normalizeThreadSubject = (subject: string): string => {
    let cur = subject.trim();
    for (;;) {
      const next = cur.replace(THREAD_SUBJECT_PREFIX, '').trim();
      if (next === cur || next === '') break;
      cur = next;
    }
    return cur.toLowerCase();
  };
  /** 主题兜底窗（二级匹配）：30 天内的同键邮件才算同一对话——更早的算新事。 */
  const THREAD_SUBJECT_WINDOW_MS = 30 * 86_400_000;

  /** 三级线程匹配：①in_reply_to 反查 meta.message_id（因果锚，不限状态/时限）
   * → 继承其线程（它没建档则它即线程根）；②归一化主题+同发件人，窗内最新同键
   * （在途或已结单；rejected 不入候选）→ 同线程；③都未命中 → null（自立根）。
   * 查询面全在 store（json_extract），本函数只做比对与裁决。候选集排除本单
   * （selfId）——匹配跑在建行之后，不排除 newest-first 会命中自己。 */
  const matchThread = (
    m: EmailMessage, selfId: string,
  ): { threadId: string; by: 'in_reply_to' | 'subject'; workflowId: string } | null => {
    const irt = m.inReplyTo ?? '';
    if (irt !== '') {
      const parent = store.latestByMessageId(irt, selfId);
      if (parent !== null) {
        return { threadId: parent.threadId ?? parent.id, by: 'in_reply_to', workflowId: parent.id };
      }
    }
    const key = normalizeThreadSubject(m.subject);
    if (key === '') return null;
    const cutoff = new Date(o.clock.now().getTime() - THREAD_SUBJECT_WINDOW_MS).toISOString();
    const cand = store.recentBySender(m.from, cutoff, selfId)
      .find((w) => normalizeThreadSubject(w.meta['subject'] === undefined ? '' : String(w.meta['subject'])) === key);
    if (cand !== undefined) {
      return { threadId: cand.threadId ?? cand.id, by: 'subject', workflowId: cand.id };
    }
    return null;
  };

  /** 进件层自回环守卫（2026-09-20 断点十三收口）：引擎给轮询邮箱自身发的
   * 信，投递副本会以新 uid 回灌 IMAP——dedup_key 防重不防自产，authz 域模式
   * 还可能放行。message_id 命中本引擎已发送记录（completed send 步）→ 不建
   * 单，self_echo_ignored 事件留痕（不烧 agent turn、不污染绑定会话、不产
   * 「拒埋葬人工清偿队列」）。onEmailReceived 与 startEmailWorkflow 两个入口
   * 都过这道闸——/api/email/simulate 走 onEmailReceived，同被覆盖。 */
  const selfEchoHit = (m: EmailMessage): boolean => {
    if (m.messageId === '' || !store.sentMessageIdExists(m.messageId)) return false;
    store.appendEvent('workflow', '', 'self_echo_ignored', {
      from: m.from, subject: truncate(m.subject, 120), message_id: m.messageId,
    });
    log.info(`[engine] self-echo 进件已忽略：message_id=${m.messageId} 命中本引擎已发送记录（不建单）`);
    return true;
  };

  // ---- Party 指针（第三期：当事人=Twenty CRM 引用）-----------------------------
  // 身份在 CRM（Twenty），juli 只存引用不建档：命中 → meta.party={contact_id,
  // company_id, source:'twenty'} + party_matched 事件（有因才留痕；internal/
  // unmatched 不发事件）；内部地址 → {internal:true} 不查 CRM；陌生外部 →
  // 默认 {unmatched:true} 不建档（party.auto_create 开了才顺路建，先查再建
  // 幂等）。铁律：目录调用全在 try+超时（≤2s）兜底里——Twenty 挂了邮件进件
  // 照常走，party 字段缺省即可，绝不阻断收件。
  const partyTimeoutMs = deps.partyTimeoutMs ?? 2_000;

  /** 目录调用统一兜底：抛错/超时 → 'fault'（party 缺省）；null = 确认查无。 */
  const partyCall = async (fn: () => Promise<PartyMatch | null>): Promise<PartyMatch | null | 'fault'> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<'fault'>((resolve) => { timer = setTimeout(() => resolve('fault'), partyTimeoutMs); }),
      ]);
    } catch {
      return 'fault';
    } finally {
      clearTimeout(timer);
    }
  };

  const attachPartyPointer = async (m: EmailMessage, workflowId: string): Promise<void> => {
    const dir = deps.partyDirectory;
    const email = normalizeEmail(m.from);
    if (isInternalSender(email, deps.routing)) {
      store.updateWorkflowMeta(workflowId, { party: { internal: true } });
      return;
    }
    if (dir == null || !email.includes('@')) return; // 未接 Twenty / 无地址：party 缺省
    let hit = await partyCall(() => dir.findByEmail(email));
    const create = dir.createContact;
    if (hit === null && deps.partyAutoCreate === true && create) {
      hit = await partyCall(() => create({ email }));
    }
    if (hit === 'fault') return; // CRM 故障/超时：party 缺省，进件照常
    if (hit === null) {
      store.updateWorkflowMeta(workflowId, { party: { unmatched: true } });
      return;
    }
    store.updateWorkflowMeta(workflowId, {
      party: { contact_id: hit.contactId, company_id: hit.companyId, source: 'twenty' },
    });
    store.appendEvent('workflow', workflowId, 'party_matched', {
      contact_id: hit.contactId, company_id: hit.companyId,
    });
  };

  const onEmailReceived = async (m: EmailMessage): Promise<void> => {
    // 自回环先于一切：这是我们自己发出的信的回灌，不是新事件。
    if (selfEchoHit(m)) return;
    // 活跃去重：同 dedup_key 且已有在途工作流 → 幂等跳过（对齐 Go 的
    // HasWorkflowMetaActive；被拒/已结算的不算在途，允许重新触发）。
    if (store.hasActiveDedup(dedupKey(m))) return;
    // 发件人授权先于一切 LLM/agent 开销。被拒邮件仍建 workflow
    // （status=rejected，原邮件进 meta）——可审计、可人工恢复。
    const reason = checkAuthz(o.getAuthz(), m.from);
    if (reason !== null) {
      const w = store.createWorkflow({
        kind: 'email',
        status: 'rejected',
        title: `[rejected] ${truncate(m.subject, 120)}`,
        meta: {
          from: m.from, subject: m.subject, message_id: m.messageId,
          date: m.date, uid: String(m.uid), [DEDUP_META_KEY]: dedupKey(m),
          rejected_reason: reason,
          in_reply_to: m.inReplyTo ?? '', references: refsOf(m.references),
        },
      });
      store.appendEvent('workflow', w.id, 'email_rejected', { from: m.from, reason });
      log.error(`rejected mail from ${m.from}: ${reason} (workflow ${w.id})`);
      return;
    }
    await startEmailWorkflow(m);
  };

  const startEmailWorkflow = async (m: EmailMessage): Promise<Workflow> => {
    // 自回环守卫同款盖直接调用方（tests/内部路径）：onEmailReceived 已闸过，
    // 这里再闸一次是纵深防御——命中即抛错（无工作流可返，调用方须感知）。
    if (selfEchoHit(m)) {
      throw new Error(`self-echo 邮件不建单：message_id=${m.messageId} 命中本引擎已发送记录（断点十三守卫）`);
    }
    // 线程链:references 里有已知 message_id → 关联到那条流水(因果锚)。
    const refs = refsOf(m.references);
    let related: string | null = null;
    if (refs.length > 0 || m.inReplyTo !== '') {
      const needles = new Set([...refs, m.inReplyTo].filter((x) => x !== ''));
      for (const cand of store.listWorkflows(200)) {
        const mid = cand.meta['message_id'];
        if (typeof mid === 'string' && mid !== '' && needles.has(mid)) {
          related = cand.id;
          break;
        }
        // 我们发出的回信 ID 只增长在 references 数组——客户的下一封回信
        // 引用的是它。不查 references，第二轮起回信就接不上线（无主新邮件）。
        // 九跑 P2：读取兼容存量 string（修复前进件存的是空格分隔原文）。
        const candRefs = refsOf(cand.meta['references']);
        if (candRefs.some((r) => needles.has(r))) {
          related = cand.id;
          break;
        }
      }
    }
    const w = store.createWorkflow({
      kind: 'email',
      title: truncate(m.subject, 120),
      parentId: related ?? undefined,
      status: 'queued',
      meta: {
        from: m.from, ...(m.fromName !== undefined && m.fromName !== '' ? { from_name: m.fromName } : {}),
        subject: m.subject, message_id: m.messageId,
        date: m.date, uid: String(m.uid), [DEDUP_META_KEY]: dedupKey(m),
        in_reply_to: m.inReplyTo ?? '', references: refs,
        ...(related !== null ? { related_workflow: related } : {}),
      },
    });
    store.appendEvent('workflow', w.id, 'task_queued', { via: 'email' });
    store.appendEvent('workflow', w.id, 'email_received', {
      from: m.from, subject: m.subject, message_id: m.messageId,
      attachments: m.attachments.map((a) => ({ name: a.name, bytes: a.bytes })),
    });
    // 对话（Thread）三级建档（2026-09-21 二期）：邮件回复链不再各开新卡。
    // 命中①②留 thread_matched 事件（事件纪律：创建必有因）；③自立根只建档
    // 不留痕——「自己开线程」不是因果，无需因。
    const matched = matchThread(m, w.id);
    store.assignThread(w.id, matched !== null ? matched.threadId : w.id);
    if (matched !== null) {
      store.appendEvent('workflow', w.id, 'thread_matched', {
        thread_id: matched.threadId, matched_by: matched.by, matched_workflow: matched.workflowId,
      });
    }
    // Party 指针（第三期）：当事人=Twenty CRM 引用，接在 thread 匹配之后。
    // 全兜底（try+超时≤2s），CRM 故障绝不阻断进件。
    await attachPartyPointer(m, w.id);
    // 邮件 bucket:原始 eml 与附件持久化 + 登记为工件——run 的 Input 物证。
    if (deps.artifacts?.putAndRegister) {
      if (m.raw) {
        await deps.artifacts.putAndRegister({
          workflowId: w.id, role: 'email_original', name: 'original.eml', bytes: Buffer.from(m.raw),
        }).catch(() => undefined);
      }
      for (const [i, a] of m.attachments.entries()) {
        if (!a.content) continue;
        await deps.artifacts.putAndRegister({
          workflowId: w.id, role: 'email_attachment',
          name: `att-${i + 1}-${a.name}`, bytes: Buffer.from(a.content),
        }).catch(() => undefined);
      }
    }
    // 初始化案卷：每步都读的持久上下文文档。原邮件不可变；后续步只追加。
    let cf = parseCaseFile(null, now());
    cf = withOriginal(cf, {
      from: m.from, fromName: m.fromName ?? '', subject: m.subject, body: m.body, messageId: m.messageId,
    }, now());
    store.saveCaseFile(w.id, cf);
    // 绑定会话路由（专用 agent 隔离，只开邮件口）：发件人命中 bound_agents
    // 白名单 → 本单钉死绑定会话（meta.session_bound 标记 + 首步 session 钉），
    // 其余发件人零变化走默认。确定性映射，不经 LLM triage。
    const bound = (deps.routing.boundAgents ?? []).find((b) =>
      b.senders.some((s) => normalizeEmail(s) === normalizeEmail(m.from)));
    if (bound) {
      store.updateWorkflowMeta(w.id, { session_bound: bound.session });
      store.appendEvent('workflow', w.id, 'session_bound_route', { from: m.from, session: bound.session });
    }
    // route_decision 留痕（板D：链路 + 每跳原因进账本；同写 meta 供案卷
    // 详情渲染链路卡——判定只在引擎做一次，视图全是投影）。meta 落两份：
    // route_decision 对象给 web；iOS 的 JSONValue 只解 string/number，
    // 平铺键（chain/company/domain/session/reasons）给链路卡。route_reasons
    // 是四跳判定原因按链路顺序用 \n join（板F「每跳判断原因」行）。
    let route = decideRoute(m.from, deps.routing);
    // jev 内容判定腿（route_intake，2026-09-28 用户裁定「路由不该在规则层」）：
    // 非绑定邮件首跳落点由语义判定从声明表里选——规则腿（company/domain 发件
    // 域匹配）降为兜底与对账基准。纪律同派发面 route_fallback 腿（steps.ts）：
    // ①绑定/authz 永不经判定（隔离与安全红线）；②shadow=留痕不改行为；
    // on+过阈值+答案在非绑定声明表内才采纳；③fail-open（判定挂/低置信
    // /off=规则腿结果，即既有行为）。判定 await 在建单之后（dedup 键已随
    // createWorkflow 落库）——无双建单窗口；延迟只作用于播种步。
    let jevSession = '';
    if (bound === undefined && deps.judgment !== undefined) {
      const boundNames = new Set((deps.routing.boundAgents ?? []).map((b) => b.session));
        const declared = (deps.routing.agents ?? [])
          .filter((a) => !boundNames.has(a.session))
          .map((a) => ({ session: a.session, company: a.company, domain: a.domain, senders: a.senders ?? [], description: a.description ?? '' }));
      if (declared.length > 0) {
        const criteria: Record<string, string> = {};
        for (const d of declared) {
          const doms = d.senders.map((x) => x.split('@')[1] ?? '').filter((x) => x !== '').join(',');
          criteria[d.session] = `company=${d.company} domain=${d.domain}${doms !== '' ? ` senderDomains=${doms}` : ''}`
            + (d.description !== undefined && d.description !== '' ? ` desc=${d.description}` : '');
        }
        const outcome = await deps.judgment.ask('route_intake',
          { from: m.from, subject: m.subject, body: m.body.slice(0, 600), rule_session: route.session },
          { target_session: { type: 'choice', instructions: 'Which declared session (by company/domain) should own this inbound email?', criteria } });
        if (outcome !== null && outcome.ok) {
          const p = { mode: outcome.mode, scenario: 'route_intake', provider: outcome.provider, model: outcome.model ?? '', confidence: outcome.confidence ?? 0, answer: outcome.answer ?? '', rule_session: route.session, input_tokens: outcome.inputTokens ?? 0, output_tokens: outcome.outputTokens ?? 0, duration_ms: outcome.durationMs ?? 0 };
          const valid = declared.some((d) => d.session === outcome.answer);
          if (outcome.mode === 'shadow') {
            store.appendEvent('workflow', w.id, 'route_judgment', { ...p, agree: outcome.answer === route.session });
          } else if (valid && (outcome.confidence ?? 0) >= outcome.threshold) {
            jevSession = outcome.answer!;
            store.appendEvent('workflow', w.id, 'route_judgment_applied', { ...p, resolved: jevSession });
            route = {
              ...route, session: jevSession,
              chain: [...route.chain, 'jev'],
              reasons: { ...route.reasons, jev: `内容判定 → ${jevSession}（置信 ${(outcome.confidence ?? 0).toFixed(2)}，规则腿 ${route.session} 被内容覆盖）` },
            };
          } else {
            store.appendEvent('workflow', w.id, 'route_judgment_rejected', { ...p, reason: !valid ? '非声明会话' : '低于阈值' });
          }
        } else if (outcome !== null) {
          store.appendEvent('workflow', w.id, 'route_judgment', { mode: outcome.mode, scenario: 'route_intake', error: outcome.error ?? '', rule_session: route.session });
        }
      }
    }
    store.appendEvent('workflow', w.id, 'route_decision', { ...route });
    store.updateWorkflowMeta(w.id, {
      route_decision: { ...route },
      route_chain: route.chain.join('>'),
      route_company: route.company,
      route_domain: route.domain,
      route_session: route.session,
      route_reasons: route.chain.map((k) => route.reasons[k] ?? '').join('\n'),
    });
    // 动态模型（2026-09-13 裁决）：进件不查模板/trigger——manifest 路由的
    // 静默劫持事故类别整体消灭。事件本身就是第一条节点：原文直读进任务卡
    // 派默认会话做理解；此后每步由 agent/skill/人按需追加，闸门/发送是
    // 引擎原语谁需要谁调。
    store.updateWorkflowMeta(w.id, { mode: 'nodes' });
    // 播种即锚定（0930 忙闲重定义）：route.session（bound/jev/域认领/default
    // 的最终值）直接钉进步 1 并回写 workflow.session——queued 期即占住会话，
    // 「排队也是忙」判定得到。default 也显式写（与留空等价，账本更诚实）。
    if (route.session !== '') store.setWorkflowSession(w.id, route.session);
    store.createStep({
      workflowId: w.id, seq: 1,
      kind: 'agent', title: '理解（读原文）',
      input: {
        from: m.from, from_name: m.fromName ?? '',
        subject: m.subject, date: m.date,
        body: truncate(m.body, 8000), message_id: m.messageId,
        corrections: '', prompt: INTAKE_PROMPT,
        ...(route.session !== '' ? { session: route.session } : {}),
      },
    });
    o.queue.enqueueBack(w.id);
    return store.getWorkflow(w.id) ?? w;
  };

  return { onEmailReceived, onInbound, startEmailWorkflow };
};

