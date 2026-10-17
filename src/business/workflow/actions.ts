// 闸门动作：approve（批准绑定哈希+定档+回流原会话+按下一步 kind 播种）、
// deny（人工否决）、resolve（已在别处处理收口）、rework（驳回回修环）、
// align（对齐修正升工件）。全部走 gateAction 公共壳（锁内校验+落账+播种）。

import { rfc3339 } from '@juli-os/artifacts';
import { asString } from '../../platform/shared/json.ts'
import type { JsonValue } from '@juli-os/artifacts'
import type { Logger } from '../../platform/events/bus.ts';
import type { LifecycleStore } from '@juli-os/ledger';
import { type Step } from '@juli-os/ledger';
import { AGENT_STEP_KINDS, INSTRUCTABLE_STEP_KINDS } from '@juli-os/ledger';
import { deliverablesBody, gateDelivery, isEffectDelivery, isSendGateDecision, seedSendFromGate } from '../send/sendSeed.ts';
import { feedbackRefsOf } from './support.ts';
import type { EngineDeps } from './engine.ts';
import type { Journal } from './journal.ts';
import type { Queue } from './queue.ts';
import type { Relay } from './relay.ts';
import type { Steps } from './steps.ts';

export interface GateActions {
  approve(stepId: string, note: string, by: string, sendAt?: string): Promise<void>;
  deny(stepId: string, note: string, by: string): Promise<void>;
  resolve(stepId: string, note: string, by: string): Promise<void>;
  rework(gateId: string, feedback: string, by: string): Promise<void>;
  align(gateId: string, amendment: string, by: string): Promise<void>;
}

export const makeGateActions = (o: {
  readonly deps: EngineDeps;
  readonly store: LifecycleStore;
  readonly now: () => Date;
  readonly log: Logger;
  readonly withLock: <T>(workflowId: string, fn: () => Promise<T>) => Promise<T>;
  readonly journal: Journal;
  readonly queue: Pick<Queue, 'continueWorkflow'>;
  readonly relay: Pick<Relay, 'deliverRelay'>;
  readonly steps: Pick<Steps, 'gateWorkflowActive'>;
}): GateActions => {
  const { deps, store, log } = o;
  const now = o.now;

  const requireGateWaiting = (stepId: string): Step | string => {
    const st = store.getStep(stepId);
    if (!st) return `step ${stepId} not found`;
    if (st.kind !== 'gate' || st.status !== 'waiting_human') {
      return `step ${stepId} is not an actionable gate in waiting_human (status=${st.status} kind=${st.kind})`;
    }
    return st;
  };

  /** 闸门动作公共壳（approve/deny/resolve/rework/align 统一走流锁）：校验+
   * 落账+播种在锁内一气呵成（播种已落账 → 推进晚一拍也无空窗）；锁内重读
   * 校验——等锁期间 hook/对账可能已把闸门结算掉。壳尾推进是 void advance
   * （fire-and-forget）：advance 自带 withLock，排到本锁之后串行（不 await
   * 故不自锁），下游 LLM/SMTP 长链绝不串进 HTTP 请求等待；锁内的 awaited
   * 续推仍一律 advanceLocked（await advance 会排队等自己——静默死锁）。 */
  const gateAction = async <T>(stepId: string, fn: (st: Step) => Promise<T>): Promise<T> => {
    const st0 = store.getStep(stepId);
    if (!st0) throw new Error(`step ${stepId} not found`);
    return o.withLock(st0.workflowId, async () => {
      const stR = requireGateWaiting(stepId);
      if (typeof stR === 'string') throw new Error(stR);
      return fn(stR);
    });
  };

  const approve = async (stepId: string, note: string, by: string, sendAt?: string): Promise<void> => {
    await gateAction(stepId, async (st) => {
      const inactive = o.steps.gateWorkflowActive(st.workflowId);
      if (inactive) throw new Error(inactive);
      // 定时发（时差礼仪）：批准=决定已做，执行可定档。send_at 只许未来。
      let sendAtIso = '';
      if (sendAt !== undefined && sendAt.trim() !== '') {
        const t = new Date(sendAt).getTime();
        if (!Number.isFinite(t)) throw new Error(`send_at 不可解析: ${sendAt}`);
        if (t <= now().getTime()) throw new Error('send_at 必须是未来时刻');
        sendAtIso = new Date(t).toISOString();
      }
      // 发送闸门的 fail 级前置检查未过 → 批准无效（批了 send 也必拒）——留在
      // 闸门上走驳回回修才是正路，不放行"批准了却发不出"的僵尸态。
      const checks = st.input['checks'];
      // fail 级前置检查只拦发送决定（板 A 交付显式化）：红线/披露/契约是
      // 客户邮件的检查——apply/artifact 闸门（feedback 工单/内部交付）批准
      // 不因它们被拦。
      if (Array.isArray(checks) && isSendGateDecision(st.title, st.input)) {
        const failed = checks.filter((c): c is { name?: unknown } =>
          c !== null && typeof c === 'object' && (c as { status?: unknown }).status === 'fail');
        if (failed.length > 0) {
          const names = failed.map((c) => String(c['name'] ?? '?')).join(', ');
          throw new Error(`发送前置检查 fail（${names}）——请驳回回修，不要批准`);
        }
      }

      const steps = store.stepsForWorkflow(st.workflowId);
      const next = steps[st.seq]; // seq 1-based → index == seq
      // 批准绑定：闸门展示的 body 工件哈希随决定落账——"看的就是批的就是发的"。
      const bodyRef = deliverablesBody(st.input);
      const approveOut: Record<string, JsonValue> = { approved: true, note, by, at: rfc3339(now()) };
      if (sendAtIso !== '') approveOut['send_at'] = sendAtIso;
      if (bodyRef !== null) {
        approveOut['body_sha256'] = bodyRef.sha256;
        approveOut['body_artifact'] = bodyRef.id;
      }
      store.setStepOutput(st.id, approveOut);
      o.journal.recordDecision(st.workflowId, st.seq, 'approved', note, by);
      store.setStepStatus(st.id, 'completed');
      o.journal.stepEvent(st, 'gate_approved', { note, by, ...(bodyRef !== null ? { body_sha256: bodyRef.sha256 } : {}) });

      // 交付显式化（板 A）：apply/artifact 闸门批准=生效，不播种发送——
      // 存量单里 auto-pair 留下的配对 send 步显式取消留痕，不留给
      // no_recipient 守卫炸成 failed、再堵住 settle。
      const del = gateDelivery(st.input);
      if (isEffectDelivery(del) && next !== undefined &&
          next.kind === 'send' && next.status === 'pending') {
        store.setStepStatus(next.id, 'cancelled');
        o.journal.stepEvent(next, 'send_retracted_delivery', { delivery: del, gate: st.title, by });
        log.info(`[engine] ${st.workflowId} 闸门「${st.title}」交付=${del}：批准即生效，配对 send 已取消`);
      }

      // 批准=触发下一个（动态模型核心机关，2026-09-13）：nodes 流没有预制
      // 下一步，批准必须回流原会话——否则 agent 在等对齐答案、流水在等
      // 动作，两边互等到天荒地老（PPT 流卡死事故）。ladder 流有自己的
      // 推进机关（approve 播种下一步），不回话防双重驱动。
      const wfNow = store.getWorkflow(st.workflowId);
      if (wfNow !== null && wfNow.meta['mode'] === 'nodes' && deps.sendToSession) {
        const sess = wfNow.session !== '' ? wfNow.session : asString(wfNow.meta['assigned_session']);
        if (sess !== '') {
          const marker = `[relay:${st.id.slice(-6)}]`;
          // 问询闸门（2026-09-28 选择题回答）：note=人选的选项（菜单编号）
          // 或自定义回答——原样回流，agent 收到答案继续；不是「批准」语义。
          const isAnswerGate = asString(st.input['delivery']) === 'answer';
          let relay = isAnswerGate
            ? `${marker} [问询回答] 你在「${st.title.replace(/^问询：/, '')}」等人的回答：${note.trim() !== '' ? note.trim() : '（人未给具体回答——请按你的判断选择安全路径继续）'}。收到后继续执行原任务。`
            : `${marker} [闸门已批准] ${st.title}${note.trim() !== '' ? ` · 批注：${note.trim()}` : ''}。请按你上一轮汇报的计划继续执行；完成后按契约追加下一节点或闸门（需要人审就开闸门，任务完成则汇报并等待 settle）。`;
          // 拍板=状态翻转（0923 断点④：feedback 处理完面板仍停「新建」）：
          // 闸门批准即用户拍板——回流指令明确要求把关联 feedback 记录翻到
          // 「已完成」。此前契约把状态流转全部留给用户手点，处理闭环了
          // 面板却永远停在新建（0921 三条至今卡死）。翻转动作在 agent 会话
          // 执行（它持有 PB 写入面，答复回挂同路）；引擎镜像只读。
          const fbRefs = feedbackRefsOf(st.input);
          if (fbRefs.length > 0) {
            relay += `【反馈状态收尾】本闸关联 feedback 记录 ${fbRefs.join(' / ')} 已获批准（=用户拍板）：到反馈面板把这些记录状态翻转为「已完成」。注意面板 entity-gate 不允许「新建→已完成」直达——分两步：先「已采纳」再「已完成」。完成后汇报收尾。`;
          }
          // 持久外发箱：先落库再投递——批准这个事实一旦成立，回流就是
          // 欠款，投递循环（sweepRelays）确认送达才销账。进程崩/tmux 死
          // 都不丢，下个周期自动补投；readPane 标记验证防重复。
          const relayId = store.insertRelay({
            workflowId: st.workflowId, stepId: st.id, session: sess, text: relay, marker,
          });
          const delivered = await o.relay.deliverRelay(relayId, sess, relay, marker);
          store.appendEvent('workflow', st.workflowId, delivered ? 'gate_relayed' : 'gate_relay_queued', {
            session: sess, gate: st.title, by, relay_id: relayId,
          });
        }
      }

      if (next) {
        // 按【下一个步的 kind】（而非位置）播种——阶梯布局是每模板的数据，
        // 闸门可能坐在任何 seq。
        if (next.kind === 'agent' || next.kind === 'verify') {
          // 邮件时代语义：steps[0] 是 triage，其 output 携带路由记录。模板流
          // 携带自己的结构配置，所以只合并真正存在的值——绝不许空串盖掉
          // 模板钉死的会话（那次写入曾让僵尸扫描致盲，它读 input.session）。
          const first = steps[0];
          if (first && first.kind === 'triage') {
            const session = asString(first.output['session']);
            let plan = asString(first.output['summary']);
            const planFromGate = asString(st.input['plan']);
            if (planFromGate !== '' && plan === '') plan = planFromGate;
            const seed: Record<string, JsonValue> = {};
            if (plan !== '') seed['plan'] = plan;
            if (session !== '') {
              const cur = asString(next.input['session']);
              if (cur === '' && !('_session' in next.input)) seed['session'] = session;
            }
            if (Object.keys(seed).length > 0) store.setStepInput(next.id, seed);
          }
        } else if (next.kind === 'draft') {
          // 闸门审的是成品 → 让它起草回信。对齐 Go 语义：output 键存在即胜
          // （哪怕空串——审批人有权交白卷），缺键才退回 plan。
          const work = 'output' in st.input ? asString(st.input['output']) : asString(st.input['plan']);
          store.setStepInput(next.id, { output: work });
        } else if (next.kind === 'send') {
          // 发送步播种（契约哈希/内联回退 + meta 信封）——与 appendNode 的
          // send 补种共用 seedSendFromGate，两处语义一致。apply/artifact
          // 闸门不播种（send 已被上方 retract 取消）。
          if (isEffectDelivery(del)) {
            store.appendEvent('step', next.id, 'send_seed_skipped_delivery', { delivery: del });
          } else {
            seedSendFromGate(store, st, next);
          }
        }
      }
      // 推进 fire-and-forget：落账与播种已定，void advance 排到本锁之后
      // 串行——下游整链（LLM 最长 180s/发送闸门探活/SMTP）不进 HTTP 等待。
      o.queue.continueWorkflow(st.workflowId);
    });
  };

  /** 回修(HITL 回环):审阅不满意 → 前一步带着 feedback 重做,闸门退回
   * pending 待再次开启;轮次 +1,上一轮成本留账(价目表"含 3 轮"的工程形态)。
   * 重开时 openGate 检测 input.feedback 强制重算 checks——新正文的红线状态
   * 不许沿用上一轮的绿灯。 */
  const rework = async (gateId: string, feedback: string, by: string): Promise<void> => {
    // 空驳回 = agent 只知"被打回"不知"改什么"（0913 PPT v3 事故：重导出
    // 同内容再交）。驳回必须携带修正意见。
    if (feedback.trim() === '') {
      throw new Error('驳回必须写明修改意见（哪里不对/怎么改）——空 feedback 让重修变成重掷骰子');
    }
    await gateAction(gateId, async (st) => {
      const steps = store.stepsForWorkflow(st.workflowId);
      const prev = steps[st.seq - 2];
      store.setStepInput(st.id, { feedback });
      o.journal.recordDecision(st.workflowId, st.seq, 'rework', feedback, by);
      store.setStepStatus(st.id, 'pending');
      if (prev && INSTRUCTABLE_STEP_KINDS.includes(prev.kind)) {
        const hist = Array.isArray(prev.input['feedback_history']) ? prev.input['feedback_history'] : [];
        store.setStepInput(prev.id, {
          feedback,
          feedback_history: [...hist, feedback] as JsonValue[],
        });
        store.setStepStatus(prev.id, 'pending');
      }
      const w = store.getWorkflow(st.workflowId);
      const round = Number(w?.meta['round'] ?? 1) + 1;
      store.updateWorkflowMeta(st.workflowId, { round });
      store.appendEvent('workflow', st.workflowId, 'gate_rework', { gate: st.title, feedback, by, round });
      o.journal.stepEvent(st, 'gate_rework', { feedback, by, round });
      // 推进 fire-and-forget（同 approve）：重做链的派发不进 HTTP 等待。
      o.queue.continueWorkflow(st.workflowId);
    });
  };

  /** 对齐修正(align):审阅人看到理解偏差 → 修正成为新工件(actor=人),
   * 下游 agent 步锚定人定稿版本执行——修正文本以最高优先级注入任务卡,
   * 同时留档(amendment_ref)。与 rework 的区别:align 不重做上一步,修正后即推进。
   * 工件登记在锁内 await——requireGateWaiting 与落账之间没有空窗。 */
  const align = async (gateId: string, amendment: string, by: string): Promise<void> => {
    const text = amendment.trim();
    if (text === '') throw new Error('amendment required');
    await gateAction(gateId, async (st) => {
      const inactive = o.steps.gateWorkflowActive(st.workflowId);
      if (inactive) throw new Error(inactive);

      // The correction itself is an artifact: actor=human, ensuring auditability and downstream reproducibility.
      let amendmentRef: { id: string; sha256: string } | null = null;
      if (deps.artifacts?.putAndRegister) {
        const row = await deps.artifacts.putAndRegister({
          workflowId: st.workflowId, role: 'amendment', name: `amendment-${st.seq}.md`,
          bytes: Buffer.from(`# 对齐修正(${st.title})\n\n${text}\n\n— ${by}, ${rfc3339(now())}\n`),
          stepId: st.id,
          meta: { actor: by, view_role: 'report', gate_seq: st.seq },
        }).catch(() => null);
        if (row !== null) amendmentRef = { id: row.id, sha256: row.sha256 };
      }
      const out: Record<string, JsonValue> = { aligned: true, amendment: text, by, at: rfc3339(now()) };
      if (amendmentRef !== null) out['amendment_ref'] = { ...amendmentRef, name: `amendment-${st.seq}.md` };
      store.setStepOutput(st.id, out);
      o.journal.recordDecision(st.workflowId, st.seq, 'aligned', text, by);
      store.setStepStatus(st.id, 'completed');
      o.journal.stepEvent(st, 'gate_aligned', { by, amendment_artifact: amendmentRef?.id ?? null });

      const steps = store.stepsForWorkflow(st.workflowId);
      const next = steps[st.seq];
      if (next && AGENT_STEP_KINDS.includes(next.kind)) {
        // 下游锚定：修正以最高优先级指令进任务卡（与 rework feedback 同级），
        // 原 plan 保留——agent 看到"原始理解 + 人修正"。
        const plan0 = asString(next.input['plan']) || asString(st.input['plan']);
        const plan = `${plan0}\n\n[对齐修正（人定稿，最高优先执行）]\n${text}`;
        store.setStepInput(next.id, { plan, amendment: text });
      }
      // 推进 fire-and-forget（同 approve）：下游执行链不进 HTTP 等待。
      o.queue.continueWorkflow(st.workflowId);
    });
  };

  const deny = async (stepId: string, note: string, by: string): Promise<void> => {
    await gateAction(stepId, async (st) => {
      const inactive = o.steps.gateWorkflowActive(st.workflowId);
      if (inactive) throw new Error(inactive);

      store.setStepOutput(st.id, { denied: true, note, by, at: rfc3339(now()) });
      o.journal.recordDecision(st.workflowId, st.seq, 'denied', note, by);
      store.setStepStatus(st.id, 'failed');
      o.journal.stepEvent(st, 'gate_denied', { note, by });
      store.setWorkflowStatus(st.workflowId, 'failed');
      // 拒绝记进 meta——Retry 靠它拒绝绕过人工否决。
      store.updateWorkflowMeta(st.workflowId, { denied_reason: note });
      store.appendEvent('workflow', st.workflowId, 'workflow_denied', { note, by });
    });
  };

  const resolve = async (stepId: string, note: string, by: string): Promise<void> => {
    await gateAction(stepId, async (st) => {
      // “已在别处处理”：非失败语义。闸门以 resolved 标记收场（被审内容留在
      // input 里供追溯），下游未跑的步全部 cancelled，审计全留，什么都不删。
      store.setStepOutput(st.id, { resolved: true, note, by, at: rfc3339(now()) });
      o.journal.recordDecision(st.workflowId, st.seq, 'resolved', note, by);
      store.setStepStatus(st.id, 'cancelled');
      o.journal.stepEvent(st, 'gate_resolved', { note, by });

      for (const s of store.stepsForWorkflow(st.workflowId)) {
        if (s.seq > st.seq && (s.status === 'pending' || s.status === 'running')) {
          store.setStepStatus(s.id, 'cancelled');
        }
      }
      store.setWorkflowStatus(st.workflowId, 'cancelled');
      store.appendEvent('workflow', st.workflowId, 'workflow_resolved', {
        note, by, at_step: st.seq, via: 'resolve',
      });
    });
  };

  return { approve, deny, resolve, rework, align };
};

