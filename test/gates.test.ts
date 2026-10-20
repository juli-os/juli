// 闸门语义 web 副本对齐测试（statuses.ts 同款纪律）：web/src/gates.ts 与
// src/business/send/sendSeed.ts 双侧同判——web 不引 src（结构宪法），测试引两侧
// 强制同步。收口动因：dashboard 曾持残缺 isSendGate（只认标题「发送」），
// delivery=email 的闸门在总览被直批绕过确认卡（安全路径分叉）。

import { describe, expect, it } from 'vitest';
import {
  envelopeTo as srcEnvelopeTo, gateDelivery as srcGateDelivery, isSendGateDecision as srcIsSendGateDecision,
  resolveSendRecipient as srcResolve,
  isEffectDelivery as srcIsEffectDelivery,
} from '../src/business/send/sendSeed.ts';
import {
  envelopeToOf, gateDeliveryOf, isSendGate, resolveRecipientOf, type GateStepLike,
} from '../web/src/gates.ts';
import type { JsonRecord } from '@juli-os/artifacts'

describe('gates：判型与引擎对齐', () => {
  const cases: ReadonlyArray<readonly [string, JsonRecord | undefined]> = [
    ['email 显式', { delivery: 'email' }],
    ['apply 显式', { delivery: 'apply' }],
    ['artifact 显式', { delivery: 'artifact' }],
    ['带空白', { delivery: '  email  ' }],
    ['未知值', { delivery: 'review' }],
    ['非字符串', { delivery: 42 }],
    ['未申报', {}],
    ['undefined', undefined],
  ];
  for (const [name, input] of cases) {
    it(`gateDeliveryOf(${name}) === 引擎 gateDelivery`, () => {
      expect(gateDeliveryOf(input)).toBe(srcGateDelivery(input));
    });
  }
  it('isEffectDelivery 生效类二分：apply/artifact=true，email/空=false', () => {
    expect(srcIsEffectDelivery('apply')).toBe(true);
    expect(srcIsEffectDelivery('artifact')).toBe(true);
    expect(srcIsEffectDelivery('email')).toBe(false);
    expect(srcIsEffectDelivery('')).toBe(false);
  });
});

describe('gates：isSendGate 与引擎 isSendGateDecision 同判（无结构后继面）', () => {
  const cases: ReadonlyArray<readonly [string, string, JsonRecord]> = [
    ['标题含发送·未申报', '发送答复', {}],
    ['标题不含·未申报', '确认闸门', {}],
    ['标题不含·申报收件人', '确认闸门', { envelope: { to: 'a@b.c' } }],
    ['标题含·apply（生效类，永不发送）', '发送修复', { delivery: 'apply' }],
    ['标题含·artifact', '发送归档', { delivery: 'artifact' }],
    ['标题不含·email（恒发送）', '请批', { delivery: 'email' }],
    ['空标题', '', {}],
  ];
  for (const [name, title, input] of cases) {
    it(`${name}：web（steps=[]) === 引擎`, () => {
      const webStep: GateStepLike = { kind: 'gate', title, seq: undefined, input };
      expect(isSendGate(webStep, [])).toBe(srcIsSendGateDecision(title, input));
    });
  }
  it('结构判据（web 展示层独有）：后继是 send → 发送闸门', () => {
    const steps: readonly GateStepLike[] = [
      { kind: 'agent', title: '执行', seq: 1 },
      { kind: 'gate', title: '确认', seq: 2 },
      { kind: 'send', title: '发送答复', seq: 3 },
    ];
    expect(isSendGate(steps[1]!, steps)).toBe(true);
    // 未申报 + 无 send 后继 + 标题不带「发送」= 非发送闸门（可直批）
    expect(isSendGate({ kind: 'gate', title: '确认闸门', seq: 0, input: {} }, [
      { kind: 'gate', title: '确认闸门', seq: 0 },
    ])).toBe(false);
  });
});

describe('gates：收件人解析与引擎 resolveSendRecipient 同序', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['casey@acme.de', 'casey@acme.de'],   // 一致
    ['casey@acme.de', 'evil@x.io'],          // 劫持申报 → 忽略留痕
    ['casey@acme.de', ''],                   // 回信流无申报
    ['', 'declared@example.com'],              // 任务流申报生效
    ['', ''],                                  // 双空（引擎 no_recipient 守卫接手）
    ['  spaced@x.io  ', '  spaced@x.io  '],    // 空白容忍
  ];
  for (const [from, envTo] of cases) {
    it(`from=${JSON.stringify(from)} envTo=${JSON.stringify(envTo)}：to/overrideIgnored 同判`, () => {
      const src = srcResolve(from, envTo);
      const web = resolveRecipientOf(from, envTo);
      expect(web.to).toBe(src.to);
      expect(web.overrideIgnored).toBe(src.overrideIgnored);
    });
  }
});

describe('gates：envelopeToOf 与引擎 envelopeTo 同判', () => {
  it('envelope 形状变体', () => {
    for (const input of [
      { envelope: { to: 'a@b.c' } },
      { envelope: { to: '  a@b.c  ' } },
      { envelope: { to: '' } },
      { envelope: null },
      { envelope: 'not-object' },
      { envelope: ['array'] },
      {},
    ] as JsonRecord[]) {
      expect(envelopeToOf(input)).toBe(srcEnvelopeTo(input));
    }
  });
});

// 注：replySubject 的 web 副本住在 ui.ts（DOM 模块）——node 侧 tsc 无 DOM lib，
// 测试不引（既定纪律：测试只引 web 纯模块）。引擎侧 replySubject 由
// review-chain/send 系测试锁行为；展示侧对齐作为残留项记录在收口报告。
