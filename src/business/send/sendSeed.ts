// 发送步播种（从引擎抽出的独立模块）：approve 与 nodes 模式 appendNode 两处
// 共用同一语义——deliverables 有唯一 body → body_ref 契约路径（批的是哪个
// 版本，发的就是哪个）。2026-09-15 断点九①铁律：nodes 模式（动态进件/任务
// 单/nodes 模板——会话汇报可能直接冲正文的事故面）无 body 工件时 seed 不带
// body 键，send 步将以 body_contract_missing 拒发——宁可拒发；内联回退只
// 保留给 ladder 模板流（draft 步产出无 manifest 的既有契约，见 review-chain
// 锁定测试）。收件人：任务流=闸门申报 envelope.to，回信流=meta.from；
// 主题/抄送同构（2026-09-20 P1 回信流收口）：判据是 meta.from 在位与否——
// 不是 mode（现代邮件进件全是 nodes，mode 已不能区分回信流）。回信流一律
// Re: 原题 + 无抄送（申报值只作展示+审计，envelope_cc_override_ignored 留痕）；
// 任务流维持 nodes 才认申报（断点十）。

import { asString } from '../../platform/shared/json.ts'
import type { JsonRecord, JsonValue } from '@juli-os/artifacts'
import type { LifecycleStore } from '@juli-os/ledger';
import { type Step } from '@juli-os/ledger';
import { type DeliverableRef, isDeliverableRef, parseEnvelope } from '@juli-os/artifacts';

export const replySubject = (subject: string): string => {
  if (subject === '') return 'Re: (无主题)';
  return subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`;
};

/** 闸门 input.deliverables 中唯一的 body 工件指针；无契约/多重 body → null。
 * 指针形状复用账本 DeliverableRef 判型（id/sha256/name 齐备才算数）。 */
export const deliverablesBody = (input: JsonRecord): DeliverableRef | null => {
  const dl = input['deliverables'];
  if (!Array.isArray(dl)) return null;
  const bodies = dl.filter((x): x is DeliverableRef => isDeliverableRef(x) && x.view_role === 'body');
  if (bodies.length !== 1) return null;
  return bodies[0]!;
};

/** 申报单信封的 feedback 指针（判型与解析复用账本 parseEnvelope）。 */
export const envelopeRefs = (env: JsonValue | undefined): readonly string[] =>
  parseEnvelope(env)?.feedback_refs ?? [];

/** 申报单信封本体（纯 object 才算数；标量/数组/null → null）——
 * to/subject/cc 三处读取共用同一形状判定。 */
const envelopeOf = (input: JsonRecord): JsonRecord | null => {
  const env = input['envelope'];
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return null;
  return env as JsonRecord;
};

/** 申报单信封的收件人（任务流主动发信，wf_505578377218 事故后一等字段）。 */
export const envelopeTo = (input: JsonRecord): string => {
  const env = envelopeOf(input);
  return env === null ? '' : asString(env['to']).trim();
};

/** 申报单信封的主题（任务流新线程用原题，不套 Re:）。 */
export const envelopeSubject = (input: JsonRecord): string => {
  const env = envelopeOf(input);
  return env === null ? '' : asString(env['subject']).trim();
};

/** 闸门交付方式（2026-09-21 板 A「交付显式化」）：申报单一等字段——
 * email=批准真发；apply=批准即生效（agent 按 plan 动 site/账本，答复走
 * feedback 面板/工件，无邮件）；artifact=纯确认（交付物已是工件，无下游
 * 动作）。未申报 → 旧判据兜底（标题「发送」/envelope.to），存量单零放松。 */
export type GateDelivery = 'email' | 'apply' | 'artifact';
export const gateDelivery = (input: JsonRecord | undefined): GateDelivery | '' => {
  const d = input?.['delivery'];
  const s = typeof d === 'string' ? d.trim() : '';
  return s === 'email' || s === 'apply' || s === 'artifact' ? s : '';
};

/** 生效类交付（apply=批准即生效 / artifact=纯确认）：不是邮件决定——
 * 不配 send、不查收件人、不被客户邮件词表拦。openGate 跳过邮件检查 /
 * approve 撤回配对 send / approve 播种跳过三处统一读这里，加第四种
 * delivery 时只改 gateDelivery 判型 + 这里一次归类。 */
export const isEffectDelivery = (d: GateDelivery | ''): boolean => d === 'apply' || d === 'artifact';

/** 发送语义闸门判定（单一事实源，五处统一读：建闸 400 / auto-pair / 链尾
 * 悬空 / settle 拒埋葬 / web 卡）：显式 delivery 优先——apply/artifact 永远
 * 不是发送决定（不配 send、不查收件人、不被客户邮件词表拦）；未申报回退
 * 旧判据（标题「发送」或申报 envelope.to）——三道闸对存量行为零放松。 */
export const isSendGateDecision = (title: string, input: JsonRecord | undefined): boolean => {
  const d = gateDelivery(input);
  if (d !== '') return d === 'email';
  return /发送/.test(title) || envelopeTo(input ?? {}) !== '';
};

/** 收件人解析结果：to=将发信地址；overrideIgnored=回信流里被忽略的申报值
 * （非空时闸门卡标黄提示、引擎留 envelope_override_ignored 审计事件）。 */
export interface ResolvedRecipient {
  readonly to: string;
  readonly source: 'meta_from' | 'envelope' | '';
  readonly overrideIgnored: string;
}

/** 收件人单一事实源（2026-09-20 P0 收件人劫持）：回信流（meta.from 在位）
 * 收件人锁定原发件人——申报 envelope.to 与之不同即忽略，agent 无劫持通道；
 * 任务流（from 空）收件人=闸门申报 envelope.to。发送侧（seedSendFromGate /
 * runSendStep）与展示侧（web 闸门卡，web/src/views/lifecycle.ts 同序镜像）
 * 必须复用同一优先级——「人批卡所见=发信地址」的结构保证。 */
export const resolveSendRecipient = (from: string, envTo: string): ResolvedRecipient => {
  const f = from.trim();
  const e = envTo.trim();
  if (f !== '') {
    return { to: f, source: 'meta_from', overrideIgnored: e !== '' && e !== f ? e : '' };
  }
  return { to: e, source: e !== '' ? 'envelope' : '', overrideIgnored: '' };
};

/** 发送步播种：见模块头注释。多轮线程回复会话里【最新】一封（references
 * 链尾优先），申报单 in_reply_to_hint 只是提示——线程真相在引擎 meta，
 * agent 声明不作数。 */
export const seedSendFromGate = (store: LifecycleStore, gate: Step, sendStep: Step): void => {
  // 重读闸门：调用方(approve/appendNode)手里的 gate 是落库前的快照，
  // send_at/body_sha256 等 approve 刚写进 output 的字段只在库里。
  gate = store.getStep(gate.id) ?? gate;
  const meta = store.getWorkflow(gate.workflowId)?.meta ?? {};
  let msgId = asString(meta['message_id']);
  const refs = meta['references'];
  // 九跑 P2：读取兼容存量 string（修复前进件存的是空格分隔原文）。
  const refIds = Array.isArray(refs)
    ? refs.filter((x): x is string => typeof x === 'string' && x !== '')
    : (typeof refs === 'string' ? refs.split(/\s+/).filter(Boolean) : []);
  if (refIds.length > 0) msgId = refIds[refIds.length - 1]!;
  const bodyRef = deliverablesBody(gate.input);
  // meta 已在上方读出，两次读取之间无写入——mode 直接取，不重复回库。
  const isNodes = meta['mode'] === 'nodes';
  const from = asString(meta['from']).trim();
  // 收件人（单一事实源 resolveSendRecipient，P0）：任务流（无原始发件人）
  // 收件人=闸门申报 envelope.to——人批卡看到的地址就是发信地址；回信流
  // （meta.from 在位）锁定原发件人，申报 envelope.to 不同即忽略（审计事件
  // 留痕）——被提示注入/妥协的 agent 改投任意地址的通道就此关死。
  const rcpt = resolveSendRecipient(from, envelopeTo(gate.input));
  if (rcpt.overrideIgnored !== '') {
    store.appendEvent('step', gate.id, 'envelope_override_ignored', {
      declared_to: rcpt.overrideIgnored, locked_to: rcpt.to,
      note: '回信流收件人锁定原发件人（meta.from），申报 envelope.to 已忽略',
    });
  }
  const envSubject = envelopeSubject(gate.input);
  const reSubject = replySubject(asString(meta['subject']));
  // 主题（2026-09-20 P1 回信流收口）：判据与收件人同一维度——meta.from 在位
  // =回信流，一律 Re: 原题（线程语义），申报 envelope.subject 不盖原题；
  // 任务流维持「nodes 才认申报」的既有模式门。
  const subject = from !== ''
    ? reSubject
    : (isNodes && envSubject !== '' ? envSubject : reSubject);
  const seed: Record<string, JsonValue> = {
    to: rcpt.to,
    subject,
    in_reply_to: msgId,
  };
  const dl = gate.input['deliverables'];
  if (Array.isArray(dl)) seed['deliverables'] = dl;
  // 定时发：批准时定档的时刻随种子流转（决定已做，执行等钟）。
  const sendAt = asString(gate.output['send_at']);
  if (sendAt !== '') seed['send_at'] = sendAt;
  if (bodyRef !== null) {
    seed['body_ref'] = { id: bodyRef.id, sha256: bodyRef.sha256, name: bodyRef.name };
  } else if (!isNodes) {
    // ladder 模板流旧链路兼容：draft 步产出无 manifest，内联播种照旧。
    // nodes 模式（断点九①铁律）不播 body——send 步以 body_contract_missing
    // 拒发（会话汇报文本一律不得作正文，宁可拒发）。
    const draft = asString(gate.input['draft']) || asString(gate.output['draft']);
    seed['body'] = draft;
    seed['body_source'] = 'inline';
  }
  // 抄送（断点十）+ 回信流收口（2026-09-20 P1）：闸门申报单 envelope.cc
  // 声明随种子流转到 send 步。判据与收件人/主题同一维度——meta.from 在位
  // =回信流，申报 cc 一律不进种子（与 to 同一优先级锁；envelope.cc 申报只
  // 作展示+审计，envelope_cc_override_ignored 留痕）——被注入的 agent 借
  // 抄送外泄的通道就此关死。任务流维持 nodes 才认申报。
  const env = envelopeOf(gate.input);
  if (env !== null) {
    const cc = env['cc'];
    const addrs = Array.isArray(cc) ? cc.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
    if (from !== '') {
      if (addrs.length > 0 || envSubject !== '') {
        store.appendEvent('step', gate.id, 'envelope_cc_override_ignored', {
          ...(addrs.length > 0 ? { declared_cc: addrs } : {}),
          ...(envSubject !== ''
            ? { declared_subject: envSubject, locked_subject: reSubject }
            : {}),
          note: '回信流信封锁定原线程（meta.from 在位）：申报 cc/subject 不进实发',
        });
      }
    } else if (isNodes && addrs.length > 0) {
      seed['cc'] = addrs;
    }
  }
  store.setStepInput(sendStep.id, seed);
};
