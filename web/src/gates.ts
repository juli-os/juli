// 闸门语义纯函数（web 副本）：单一事实源在 src/business/send/sendSeed.ts（引擎
// 建闸 400 / auto-pair / settle 拒埋葬同款判定），web 不引 src（结构宪法）——
// 本模块持对齐副本，test/gates.test.ts 引两侧强制同判（statuses.ts 同款纪律）。
//
// 收口动因（2026-09-22）：总览与流水详情各持一份 isSendGate——总览是残缺版
// （只认标题「发送」），delivery=email 而标题不带「发送」的闸门在总览被
// 「直批」绕过确认卡；delivery=apply/artifact 而标题带「发送」的闸门又被
// 误标不可撤销。判据统一后：发送闸门只点穿进确认卡，非发送闸门直批。
//
// 本模块零 DOM 依赖（statuses.ts 同款纪律），vitest 直接可测。

import { esc } from './esc.ts';

/** 步/闸门最小形状：蛇形 API 行（step.kind/seq）与驼形对象都能喂。 */
export interface GateStepLike {
  readonly kind?: string;
  readonly title?: string;
  readonly seq?: number;
  readonly input?: Readonly<Record<string, unknown>>;
}

/** 闸门交付方式（与引擎 gateDelivery 对齐）：email=批准真发；apply=批准即
 * 生效（无邮件）；artifact=纯确认；''=未申报（回退旧判据）。 */
export type GateDelivery = 'email' | 'apply' | 'artifact' | '';

export const gateDeliveryOf = (input: Readonly<Record<string, unknown>> | undefined): GateDelivery => {
  const d = input?.['delivery'];
  const s = typeof d === 'string' ? d.trim() : '';
  return s === 'email' || s === 'apply' || s === 'artifact' ? s : '';
};

/** 申报单信封收件人（与引擎 envelopeTo 对齐）。 */
export const envelopeToOf = (input: Readonly<Record<string, unknown>> | undefined): string => {
  const env = input?.['envelope'];
  if (env === null || env === undefined || typeof env !== 'object' || Array.isArray(env)) return '';
  const to = (env as { to?: unknown })['to'];
  return typeof to === 'string' ? to.trim() : '';
};

/** 发送闸门判定（与引擎 isSendGateDecision 同判据 + web 展示层的结构判据）：
 * delivery 显式申报优先（email=恒发送；apply/artifact=恒不是）；未申报回退
 * ——结构后继是 send、标题含「发送」、申报了 envelope.to，三者其一。
 * steps 契约：该流水全步骤按 seq 升序的数组（steps[s.seq] = 结构后继）。 */
export const isSendGate = (s: GateStepLike, steps: readonly GateStepLike[]): boolean => {
  const d = gateDeliveryOf(s.input);
  if (d === 'apply' || d === 'artifact') return false;
  if (d === 'email') return true;
  const next = s.seq !== undefined ? steps[s.seq] : undefined;
  if (next !== undefined && next.kind === 'send') return true;
  return /发送/.test(s.title ?? '') || envelopeToOf(s.input) !== '';
};

/** 收件人解析（与引擎 resolveSendRecipient 同序——改一侧必须同步另一侧，
 * test/gates.test.ts 对齐锁定）：回信流（meta.from 在位）锁定原发件人，申报
 * envelope.to 不同即忽略；任务流收件人=申报值。 */
export interface ResolvedRecipient {
  readonly to: string;
  readonly overrideIgnored: string;
}

export const resolveRecipientOf = (from: string, envTo: string): ResolvedRecipient => {
  const f = from.trim();
  const e = envTo.trim();
  if (f !== '') {
    return { to: f, overrideIgnored: e !== '' && e !== f ? e : '' };
  }
  return { to: e, overrideIgnored: '' };
};

/** 自检芯片（引擎 checks 行渲染，dashboard 移动主卡与 lifecycle 闸门卡共用；
 * 此前两视图各持一份三元梯）。 */
export const checkChip = (c: { readonly name: string; readonly status: string; readonly detail?: string }): string => {
  const cls = c.status === 'pass' ? 'pass' : c.status === 'warn' ? 'warn' : 'fail';
  const icon = c.status === 'pass' ? '✓' : c.status === 'warn' ? '⚠' : '✗';
  return `<span class="chip ${cls}" title="${esc(c.detail ?? '')}">${icon} ${esc(c.name)}</span>`;
};
