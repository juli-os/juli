// 闸门自动批准（2026-10-07 用户裁定）：匹配器硬边界（问询/发送闸门）+
// 规则四维匹配 + sweep 行为（on 真批走 approve 正门带 by=juli-auto、
// shadow 只留痕、off 零动作、竞态逐步隔离）。
// 2026-11-24 审查修复中由协调者裁定红线②终版：自动批准只放行显式申报为 apply / artifact 的
// 审批；申报 email 的、没申报的，一律按发送审批处理（见文件末尾一组）。所以
// 本文件里凡是当「普通的可自动批准的闸」用的样例，都显式申报 artifact。
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime } from '../src/runtime.ts';
import { createHttpApp } from '../src/http/app.ts';
import { matchAutoApprove, projectAutoApprove, autoApproveSweep, ctxOf, type AutoApproveCtx, type AutoApproveConfig } from '../src/business/gates/index.ts';
import { isSendGateDecision } from '../src/business/send/sendSeed.ts';
import type { JsonRecord } from '../src/platform/shared/json.ts';
import type { Step } from '@juli-os/ledger';
import type { ArtifactPort } from '../src/contracts/ports.ts';
import { ladderEmail, makeEmail, makeEngine, until } from './helpers.ts';

/** 账本第二连接（ledger 0.5.0 句柄私有，白盒摆数/对账走这里）。 */
const probeOf = (rt: { config: { data_dir: string } }): import('node:sqlite').DatabaseSync =>
  new DatabaseSync(join(rt.config.data_dir, 'lifecycle.db'));

const ctx = (over: Partial<AutoApproveCtx> = {}): AutoApproveCtx => {
  const delivery = over.delivery ?? 'apply';
  return {
    kind: 'adhoc', title: '跟进单', session: 'juli-dev', sender: '', delivery, isQuestion: false,
    // isSend = ctxOf 算好的「是不是发送审批」：没显式申报 apply / artifact 的都是
    // （2026-11-24 裁定）。匹配器只读这个布尔；这里随合并后的 delivery 推导，
    // 显式传 isSend 可覆盖。判定本身在「ctxOf」一组里测。
    isSend: delivery !== 'apply' && delivery !== 'artifact',
    ...over,
  };
};

const cfg = (mode: AutoApproveConfig['mode'], rules: Record<string, unknown>[]): AutoApproveConfig =>
  projectAutoApprove({ mode, rules: rules.map((r, i) => ({ id: `r${i + 1}`, include_send: false, ...r })) });

describe('matchAutoApprove 硬边界', () => {
  it('问询闸门永不自动批（规则全匹配也不行）', () => {
    const r = matchAutoApprove(cfg('on', [{}]), ctx({ isQuestion: true }));
    expect(r).toBeNull();
  });

  it('发送闸门（delivery=email）默认不批；规则显式 include_send 才进自动面', () => {
    expect(matchAutoApprove(cfg('on', [{}]), ctx({ delivery: 'email' }))).toBeNull();
    expect(matchAutoApprove(cfg('on', [{ include_send: true }]), ctx({ delivery: 'email' }))?.id).toBe('r1');
    // 非发送闸门不受 include_send 影响
    expect(matchAutoApprove(cfg('on', [{}]), ctx({ delivery: 'artifact' }))?.id).toBe('r1');
  });

  // 2026-11-24 审查修复中由协调者裁定：没申报 delivery 的审批一律按发送审批处理（原因见文件
  // 末尾「红线②」一组的头注）。匹配器层：isSend=true 默认不批，include_send 才批。
  it('没申报 delivery 的审批（isSend=true）默认不批；规则显式 include_send 才进自动面', () => {
    expect(matchAutoApprove(cfg('on', [{}]), ctx({ delivery: '' }))).toBeNull();
    expect(matchAutoApprove(cfg('on', [{ include_send: true }]), ctx({ delivery: '' }))?.id).toBe('r1');
  });

  it('显式申报 apply / artifact 的审批（isSend=false）照旧可批，不受 include_send 影响', () => {
    expect(matchAutoApprove(cfg('on', [{}]), ctx({ delivery: 'artifact' }))?.id).toBe('r1');
    expect(matchAutoApprove(cfg('on', [{}]), ctx({ delivery: 'apply' }))?.id).toBe('r1');
    expect(matchAutoApprove(cfg('on', [{ include_send: true }]), ctx({ delivery: 'apply' }))?.id).toBe('r1');
  });

  it('off 模式与空规则零动作', () => {
    expect(matchAutoApprove(cfg('off', [{}]), ctx())).toBeNull();
    expect(matchAutoApprove(cfg('on', []), ctx())).toBeNull();
  });
});

describe('ctxOf：只有显式申报 apply / artifact 才不是发送审批', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-autoap-ctx-'));
    const rt = createRuntime(configSchema.parse({ data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-ctx' }));
    return rt;
  };

  it('没申报 / 申报了别的值 / email → 发送审批；apply / artifact → 不是。标题与收件人不再参与', () => {
    const rt = setup();
    const w = rt.store.createWorkflow({ kind: 'adhoc', title: '跟进单' });
    let seq = 0;
    const gateOf = (title: string, input: JsonRecord): string => {
      const st = rt.store.createStep({ workflowId: w.id, seq: ++seq, kind: 'gate', title, input });
      rt.store.setStepStatus(st.id, 'waiting_human');
      return st.id;
    };
    // [名称, 标题, input, 是不是发送审批, 申报值归一后的 delivery]
    const shapes: readonly [string, string, JsonRecord, boolean, string][] = [
      ['没申报（普通确认闸）', '确认闸门', {}, true, ''],
      ['没申报、带收件人', '确认闸门', { envelope: { to: 'casey@x.de' } }, true, ''],
      ['没申报、标题含「发送」', '发送答复', {}, true, ''],
      ['申报了 delivery 但不是认识的值', '确认', { delivery: 'review' }, true, ''],
      ['delivery 不是字符串', '确认', { delivery: 42 }, true, ''],
      ['申报 answer（问询）', '问询', { delivery: 'answer', question_options: ['A'] }, true, ''],
      ['已申报 artifact（标题含发送 + 带收件人也不算）', '发送答复', { delivery: 'artifact', envelope: { to: 'casey@x.de' } }, false, 'artifact'],
      ['已申报 apply', '确认', { delivery: 'apply' }, false, 'apply'],
      ['已申报 email', '请批', { delivery: 'email' }, true, 'email'],
    ];
    for (const [name, title, input, isSend, delivery] of shapes) {
      const c = ctxOf(rt.store.getWorkflow(w.id)!, rt.store.getStep(gateOf(title, input))!);
      expect(c.isSend, name).toBe(isSend);
      expect(c.delivery, name).toBe(delivery);
    }
    expect(ctxOf(rt.store.getWorkflow(w.id)!, rt.store.getStep(gateOf('问询', { delivery: 'answer', question_options: ['A'] }))!).isQuestion).toBe(true);
    // 逐值钉死（防表改坏后空转）。
    expect(shapes.map(([, , , isSend]) => isSend)).toEqual([true, true, true, true, true, true, false, false, true]);
    // 引擎自己的判据（isSendGateDecision）认不出「没申报的普通确认闸」——红线②
    // 故意比它严：没申报的闸门批准后可以再追加发信步骤，只看标题和收件人会漏。
    expect(isSendGateDecision('确认闸门', {})).toBe(false);
    expect(isSendGateDecision('发送答复', { delivery: 'artifact' })).toBe(false);
    rt.stop();
  });
});

describe('matchAutoApprove 规则四维', () => {
  it('kind/session/internal/title_contains 各维独立咬合，不匹配让位下一条', () => {
    const c = cfg('on', [
      { kind: 'email' },
      { session: 'project-a' },
      { internal: true },
      { title_contains: '试卷' },
    ]);
    expect(matchAutoApprove(c, ctx())?.id).toBe('r3');            // 内部单命中 r3
    expect(matchAutoApprove(c, ctx({ sender: 'casey@x.de' }))).toBeNull(); // 外部单全落空
    expect(matchAutoApprove(c, ctx({ title: '语文试卷优化' }))?.id).toBe('r3'); // r3 仍先命中（顺序优先）
    expect(matchAutoApprove(cfg('on', [{ session: 'project-a' }, { kind: 'adhoc' }]), ctx({ kind: 'feedback' }))).toBeNull();
    expect(matchAutoApprove(cfg('on', [{ title_contains: '试卷' }]), ctx({ title: '跟进单' }))).toBeNull();
  });

  it('title_contains 大小写不敏感', () => {
    expect(matchAutoApprove(cfg('on', [{ title_contains: 'PPT' }]), ctx({ title: '给客户出 ppt 介绍' }))?.id).toBe('r1');
  });
});

describe('projectAutoApprove 安全投影', () => {
  it('畸形输入回落 off+空规则；字段逐个收窄', () => {
    expect(projectAutoApprove(null).mode).toBe('off');
    expect(projectAutoApprove('x').rules).toEqual([]);
    expect(projectAutoApprove({ mode: 'bogus' }).mode).toBe('off');
    const p = projectAutoApprove({ mode: 'shadow', rules: [{}, { id: 'a', kind: 'adhoc', internal: true, include_send: true }, 'junk'] });
    expect(p.mode).toBe('shadow');
    expect(p.rules).toHaveLength(2);
    expect(p.rules[0]!.id).toBe('rule-1'); // 缺 id 自动补
    expect(p.rules[1]!.includeSend).toBe(true);
  });
});

describe('autoApproveSweep 行为（真实 store + 注入 approve）', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-autoap-'));
    const rt = createRuntime(configSchema.parse({ data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-ap' }));
    return rt;
  };
  /** 建一张带 waiting gate 的单：内部 adhoc 单落 juli-dev。返回 [单号, 闸门步号]。
   *  input 缺省申报 artifact——这一组测的是审计、shadow、容错这些与「是不是发送
   *  审批」无关的行为，样例闸必须是一张能被自动批准的闸；2026-11-24 起没申报的
   *  审批不再被自动批准，所以缺省不能是空 input（要没申报的样例就显式传 {}）。 */
  const makeWaitingGate = (rt: ReturnType<typeof createRuntime>, input: Record<string, unknown> = { delivery: 'artifact' }, title = '确认'): readonly [string, string] => {
    const w = rt.store.createWorkflow({ kind: 'adhoc', title: '跟进单：迭代优化' });
    probeOf(rt).prepare('UPDATE workflows SET session=? WHERE id=?').run('juli-dev', w.id);
    const st = rt.store.createStep({ workflowId: w.id, seq: 1, kind: 'gate', title });
    probeOf(rt).prepare('UPDATE workflow_steps SET status=?, input=? WHERE id=?')
      .run('waiting_human', JSON.stringify(input), st.id);
    return [w.id, st.id];
  };

  // 守 gates 域规则红线③（src/business/gates/rules.ts 权威注释）：自动批准
  // 一律 by='juli-auto' 全审计——正门+事件链。
  it('on：命中即走 approve 正门（by=juli-auto）+ 账本留 gate_auto_approved', async () => {
    const rt = setup();
    const [wId] = makeWaitingGate(rt);
    const calls: { id: string; note: string; by: string }[] = [];
    const n = await autoApproveSweep({
      store: rt.store, config: () => cfg('on', [{ session: 'juli-dev' }]),
      approve: async (id, note, by) => { calls.push({ id, note, by }); },
      log: console,
    });
    expect(n).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.by).toBe('juli-auto');
    expect(calls[0]!.note).toContain('规则 r1');
    const evts = probeOf(rt).prepare("SELECT type FROM events WHERE entity_id=? AND type LIKE 'gate_auto%'").all(wId) as { type: string }[];
    expect(evts.map((e) => e.type)).toContain('gate_auto_approved');
    rt.stop();
  });

  it('shadow：只留痕不批；off：零动作', async () => {
    const rt = setup();
    makeWaitingGate(rt);
    const calls: string[] = [];
    const ns = await autoApproveSweep({ store: rt.store, config: () => cfg('shadow', [{}]), approve: async (id) => { calls.push(id); }, log: console });
    expect(ns).toBe(1);
    expect(calls).toHaveLength(0);
    const no = await autoApproveSweep({ store: rt.store, config: () => cfg('off', [{}]), approve: async (id) => { calls.push(id); }, log: console });
    expect(no).toBe(0);
    expect(calls).toHaveLength(0);
    rt.stop();
  });

  it('per-order 免批不受 shadow 拦截：全局影子模式下人标记的单照批（2026-10-28 裁定）', async () => {
    const rt = setup();
    const [wId] = makeWaitingGate(rt);
    rt.store.updateWorkflowMeta(wId, { auto_approve: true });
    const calls: string[] = [];
    const n = await autoApproveSweep({ store: rt.store, config: () => cfg('shadow', [{}]), approve: async (id) => { calls.push(id); }, log: console });
    expect(n).toBe(1);
    expect(calls).toHaveLength(1); // 真批，不是 shadow 留痕
    const evts = probeOf(rt).prepare("SELECT type FROM events WHERE entity_id=? AND type LIKE 'gate_auto%'").all(wId) as { type: string }[];
    expect(evts.map((e) => e.type)).toContain('gate_auto_approved');
    expect(evts.map((e) => e.type)).not.toContain('gate_auto_approve_shadow');
    rt.stop();
  });

  // 守 gates 域规则红线①②（rules.ts 权威注释）：问询闸门永不自动批；
  // 发送闸门须规则显式 include_send=true。
  it('问询闸门与外发闸门在 sweep 层同样被硬边界拦住', async () => {
    const rt = setup();
    makeWaitingGate(rt, { question_options: ['A', 'B'] });
    makeWaitingGate(rt, { delivery: 'email' });
    const calls: string[] = [];
    const n = await autoApproveSweep({ store: rt.store, config: () => cfg('on', [{}]), approve: async (id) => { calls.push(id); }, log: console });
    expect(n).toBe(0); // 两个都被硬边界排除
    expect(calls).toHaveLength(0);
    rt.stop();
  });

  // 2026-11-24 裁定后的口径：没申报 delivery 的审批一律按发送审批处理（带收件人
  // 的、标题含「发送」的都算），规则路径与 shadow 都要拦；显式申报 artifact 的
  // 确认闸照旧可批（不许误伤）。
  it('没申报 delivery 的审批：规则路径不批、shadow 不留「将自动批准」痕；artifact 确认闸照批', async () => {
    const rt = setup();
    const [, gRecipient] = makeWaitingGate(rt, { envelope: { to: 'casey@x.de' } }, '确认闸门');
    const [, gTitled] = makeWaitingGate(rt, {}, '发送答复');
    const [, gArtifact] = makeWaitingGate(rt, { delivery: 'artifact' }, '确认');
    const calls: string[] = [];
    const n = await autoApproveSweep({ store: rt.store, config: () => cfg('on', [{}]), approve: async (id) => { calls.push(id); }, log: console });
    expect(n).toBe(1); // 只有 artifact 那张
    expect(calls).toEqual([gArtifact]);
    expect([gRecipient, gTitled].map((id) => rt.store.getStep(id)!.status)).toEqual(['waiting_human', 'waiting_human']);

    const rt2 = setup();
    const [w1, g1] = makeWaitingGate(rt2, { envelope: { to: 'casey@x.de' } });
    const [w2, g2] = makeWaitingGate(rt2, {}, '发送答复');
    const shadowCalls: string[] = [];
    const ns = await autoApproveSweep({ store: rt2.store, config: () => cfg('shadow', [{}]), approve: async (id) => { shadowCalls.push(id); }, log: console });
    expect(ns).toBe(0);
    expect(shadowCalls).toHaveLength(0);
    for (const [wId, gId] of [[w1, g1], [w2, g2]] as const) {
      const evts = probeOf(rt2).prepare("SELECT type FROM events WHERE entity_id=?").all(wId) as { type: string }[];
      expect(evts.map((e) => e.type).filter((t) => t.startsWith('gate_auto'))).toEqual([]);
      expect(rt2.store.getStep(gId)!.status).toBe('waiting_human');
    }
    rt.stop();
    rt2.stop();
  });

  it('approve 抛错逐步隔离不炸整轮（后面的闸门照批）', async () => {
    const rt = setup();
    const [w1] = makeWaitingGate(rt);
    makeWaitingGate(rt);
    const gates = probeOf(rt).prepare("SELECT id FROM workflow_steps WHERE kind='gate' AND status='waiting_human'").all() as { id: string }[];
    const n = await autoApproveSweep({
      store: rt.store, config: () => cfg('on', [{}]),
      approve: async (id) => { if (id === gates[0]!.id) throw new Error('already handled'); },
      log: console,
    });
    expect(n).toBe(1); // 第二个照批
    expect(w1).toBeTruthy();
    rt.stop();
  });
});

describe('单子级免批（meta.auto_approve，前端按单开关）', () => {
  const setupFlag = () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-autoap2-'));
    return createRuntime(configSchema.parse({ data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-ap2' }));
  };
  /** 同 makeWaitingGate：input 缺省申报 artifact（能被自动批准的样例闸）。 */
  const makeGate = (rt: ReturnType<typeof createRuntime>, input: Record<string, unknown> = { delivery: 'artifact' }, title = '确认'): readonly [string, string] => {
    const w = rt.store.createWorkflow({ kind: 'adhoc', title: '跟进单' });
    probeOf(rt).prepare('UPDATE workflows SET session=? WHERE id=?').run('juli-dev', w.id);
    const st = rt.store.createStep({ workflowId: w.id, seq: 1, kind: 'gate', title });
    probeOf(rt).prepare('UPDATE workflow_steps SET status=?, input=? WHERE id=?')
      .run('waiting_human', JSON.stringify(input), st.id);
    return [w.id, st.id];
  };

  it('meta 标记无视 config off 直达自动面（by=juli-auto，note 含「本单免批」）', async () => {
    const rt = setupFlag();
    const [wId] = makeGate(rt);
    rt.store.updateWorkflowMeta(wId, { auto_approve: true });
    const calls: { by: string; note: string }[] = [];
    const n = await autoApproveSweep({
      store: rt.store, config: () => cfg('off', []), // 全局配置关着
      approve: async (_id, note, by) => { calls.push({ by, note }); }, log: console,
    });
    expect(n).toBe(1);
    expect(calls[0]!.by).toBe('juli-auto');
    expect(calls[0]!.note).toContain('本单免批');
    rt.stop();
  });

  it('硬边界对单子级标记同样钉死：外发与问询闸门不自动批', async () => {
    const rt = setupFlag();
    const [w1] = makeGate(rt, { delivery: 'email' });
    const [w2] = makeGate(rt, { question_options: ['A'] });
    rt.store.updateWorkflowMeta(w1, { auto_approve: true });
    rt.store.updateWorkflowMeta(w2, { auto_approve: true });
    const calls: string[] = [];
    const n = await autoApproveSweep({ store: rt.store, config: () => cfg('off', []), approve: async (id) => { calls.push(id); }, log: console });
    expect(n).toBe(0);
    expect(calls).toHaveLength(0);
    rt.stop();
  });

  it('切换路由：POST auto-approve 落 meta+事件，on 时立即 sweep（在等闸门当轮清）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-autoap3-'));
    const rt = createRuntime(configSchema.parse({ data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-ap3' }));
    const app = createHttpApp(rt);
    const auth = { 'content-type': 'application/json', authorization: 'Bearer pw-ap3' };
    const [wId] = makeGate(rt);
    const r1 = await app.request(`/api/lifecycle/workflows/${wId}/auto-approve`, { method: 'POST', headers: auth, body: JSON.stringify({ on: true }) });
    expect(r1.status).toBe(200);
    const d1 = await r1.json() as { on: boolean; gates_acted: number };
    expect(d1.on).toBe(true);
    expect(d1.gates_acted).toBeGreaterThanOrEqual(1);
    const step = probeOf(rt).prepare('SELECT status FROM workflow_steps WHERE workflow_id=?').get(wId) as { status: string };
    expect(step.status).toBe('completed');
    const r2 = await app.request(`/api/lifecycle/workflows/${wId}/auto-approve`, { method: 'POST', headers: auth, body: JSON.stringify({ on: false }) });
    expect((await r2.json() as { on: boolean }).on).toBe(false);
    const w2 = rt.store.getWorkflow(wId);
    expect((w2?.meta?.['auto_approve'] ?? null) === true).toBe(false);
    const evts = probeOf(rt).prepare("SELECT type FROM events WHERE entity_id=? AND type='auto_approve_set' ORDER BY id").all(wId) as { type: string }[];
    expect(evts).toHaveLength(2);
    rt.stop();
  });

  // 2026-11-24 裁定：单子级免批路径同样把没申报 delivery 的审批按发送审批处理。
  // 人的「不用问」不能替人发信。
  it('硬边界对单子级标记同样钉死：没申报 delivery 的审批不自动批', async () => {
    const rt = setupFlag();
    const [w1, g1] = makeGate(rt, { envelope: { to: 'casey@x.de' } });
    const [w2, g2] = makeGate(rt, {}, '发送答复');
    const [w3, g3] = makeGate(rt, {}, '确认');
    for (const wId of [w1, w2, w3]) rt.store.updateWorkflowMeta(wId, { auto_approve: true });
    const calls: string[] = [];
    const n = await autoApproveSweep({ store: rt.store, config: () => cfg('off', []), approve: async (id) => { calls.push(id); }, log: console });
    expect(n).toBe(0);
    expect(calls).toHaveLength(0);
    // 三张闸（带收件人的 / 标题含发送的 / 普通确认闸）都还在等人，账本没有任何自动批准痕迹。
    expect([g1, g2, g3].map((id) => rt.store.getStep(id)!.status)).toEqual(['waiting_human', 'waiting_human', 'waiting_human']);
    for (const wId of [w1, w2, w3]) {
      const evts = probeOf(rt).prepare("SELECT type FROM events WHERE entity_id=? AND type LIKE 'gate_auto%'").all(wId) as { type: string }[];
      expect(evts).toEqual([]);
    }
    // 对照：同一个人标记下，显式申报 artifact 的确认闸照批（不许误伤）。
    const [w4, g4] = makeGate(rt, { delivery: 'artifact' });
    rt.store.updateWorkflowMeta(w4, { auto_approve: true });
    const n2 = await autoApproveSweep({ store: rt.store, config: () => cfg('off', []), approve: async (id) => { calls.push(id); }, log: console });
    expect(n2).toBe(1);
    expect(calls).toEqual([g4]);
    rt.stop();
  });

  // 规则路径的对照：include_send=true 的规则显式写明「包含发送」时，没申报
  // delivery 的发送审批才进自动面（宪法 §4：对外发信的自动面只能由显式规则开）。
  it('规则显式 include_send=true：没申报 delivery 的发送审批才可自动批', async () => {
    const rt = setupFlag();
    const [, g1] = makeGate(rt, { envelope: { to: 'casey@x.de' } });
    const [, g2] = makeGate(rt, {}, '发送答复');
    const calls: string[] = [];
    const n = await autoApproveSweep({ store: rt.store, config: () => cfg('on', [{ include_send: true }]), approve: async (id) => { calls.push(id); }, log: console });
    expect(n).toBe(2);
    expect(calls.sort()).toEqual([g1, g2].sort());
    rt.stop();
  });
});

// ---- 红线②终版（2026-11-24 审查修复中由协调者裁定）-------------------------------------------
// 自动批准只放行显式申报为 apply / artifact 的审批。申报 email 的、没申报的，一律
// 按发送审批处理，须命中的规则显式 include_send 才批。问询永不自动批不变。
// 为什么没申报的也不批（而不是只看「后面有没有发信步骤」）：
// · 回信流的审批收件人就是来信人（meta.from），常常既没申报收件人、标题也不含
//   「发送」，但批准后下一步就是发信——线上 222 个审批后面跟着发信步，138 个
//   是这形态，引擎的 isSendGateDecision 认不出它们；
// · 只看当下的结构会漏：nodes 模式下 agent 可以在任何一个已批准的闸门后面追加
//   发信节点（引擎只查「本单有已批准的闸门」），扫描的那一刻后面还没有发信步；
// · 代价为零：10 月起新建的审批全部申报了交付类型，没申报的只有 9 月的存量
//   （203 个）和 10 月初的 1 个。
describe('红线②（2026-11-24）：自动批准只放行显式申报 apply / artifact 的审批', () => {
  type Node = { readonly kind: Step['kind']; readonly title?: string; readonly input?: JsonRecord; readonly status?: Step['status'] };

  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-autoap-chain-'));
    return createRuntime(configSchema.parse({ data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-chain' }));
  };

  /** 建一张回信单（有来信人 meta.from），steps 按给定顺序落账。第一个闸门是
   *  「被扫的那张」：缺省 waiting_human。其余步缺省 pending，可用 status 指定。
   *  返回 [单号, 第一个闸门步号]。 */
  const makeChain = (rt: ReturnType<typeof createRuntime>, steps: readonly Node[]): readonly [string, string] => {
    const w = rt.store.createWorkflow({ kind: 'email', title: '帮忙统计上月销量', meta: { from: 'boss@example.com' } });
    let gateId = '';
    steps.forEach((n, i) => {
      const st = rt.store.createStep({ workflowId: w.id, seq: i + 1, kind: n.kind, title: n.title ?? n.kind, input: n.input ?? {} });
      if (n.kind === 'gate' && gateId === '') gateId = st.id;
      rt.store.setStepStatus(st.id, n.status ?? (st.id === gateId ? 'waiting_human' : 'pending'));
    });
    return [w.id, gateId];
  };

  /** 没申报的闸门——下面各种「后面是什么」都从它出发。 */
  const UNDECLARED = { kind: 'gate', title: '闸门：回信审批', input: { draft: '答复正文' } } as const;
  const SEND = { kind: 'send', title: 'SMTP 发送回信' } as const;
  const NEXT_GATE = { kind: 'gate', title: '闸门：回信审批' } as const;

  /** 没申报的审批 + 后面各种形态。新规则下后面是什么都不影响结论——这张表
   *  把上一版按结构区分过的形态全部收进来，逐个钉住。 */
  const SHAPES: readonly (readonly [string, readonly Node[]])[] = [
    ['后面什么都没有（nodes 模式的常态：发信节点是批准之后才追加的）', [UNDECLARED]],
    ['紧跟 pending 的 send（阶梯模板的「闸门：回信审批」→「SMTP 发送回信」）', [UNDECLARED, SEND]],
    ['紧跟 failed 的 send', [UNDECLARED, { ...SEND, status: 'failed' }]],
    ['紧跟已取消的 send', [UNDECLARED, { ...SEND, status: 'cancelled' }]],
    ['后面是 agent → 下一个闸门 → send（阶梯模板的「闸门：成品审批」）', [UNDECLARED, { kind: 'agent', title: '执行' }, NEXT_GATE, SEND]],
    ['中间的闸门已取消 → send', [UNDECLARED, { ...NEXT_GATE, status: 'cancelled' }, SEND]],
    ['中间的闸门已跳过 → send', [UNDECLARED, { ...NEXT_GATE, status: 'skipped' }, SEND]],
    ['中间的闸门已失败 → send', [UNDECLARED, { ...NEXT_GATE, status: 'failed' }, SEND]],
    ['中间的闸门带 _when 条件 → send', [UNDECLARED, { ...NEXT_GATE, input: { _when: '{{.Input.need_reply}}' } }, SEND]],
    ['没申报、带收件人', [{ kind: 'gate', title: '确认闸门', input: { envelope: { to: 'casey@x.de' } } }]],
    ['没申报、标题含「发送」', [{ kind: 'gate', title: '发送答复', input: {} }]],
    ['申报了 delivery 但不是认识的值（review）', [{ kind: 'gate', title: '确认', input: { delivery: 'review' } }]],
  ];

  /** 两条自动批准路径各扫一遍，返回各自批准的步号：规则路径（on + 无条件
   *  规则）与单子级免批（meta.auto_approve=true，全局配置关着）。approve 是
   *  假的（只记步号），所以两条路径互不影响。 */
  const sweepBothPaths = async (rt: ReturnType<typeof createRuntime>, wId: string): Promise<{ byRule: string[]; byPerOrder: string[] }> => {
    const byRule: string[] = [];
    await autoApproveSweep({ store: rt.store, config: () => cfg('on', [{}]), approve: async (id) => { byRule.push(id); }, log: console });
    rt.store.updateWorkflowMeta(wId, { auto_approve: true });
    const byPerOrder: string[] = [];
    await autoApproveSweep({ store: rt.store, config: () => cfg('off', []), approve: async (id) => { byPerOrder.push(id); }, log: console });
    return { byRule, byPerOrder };
  };
  const autoEvents = (rt: ReturnType<typeof createRuntime>, wId: string): string[] =>
    (probeOf(rt).prepare("SELECT type FROM events WHERE entity_id=? AND type LIKE 'gate_auto%'").all(wId) as { type: string }[]).map((e) => e.type);

  it('没申报的审批：无论后面是什么，规则路径与单子级免批路径都不批', async () => {
    expect(SHAPES.length).toBeGreaterThanOrEqual(12);
    for (const [name, steps] of SHAPES) {
      const rt = setup();
      const [wId, gId] = makeChain(rt, steps);
      // 前提：这张闸按引擎口径算「没申报」——没写 delivery，或写的不是认识的值。
      expect(ctxOf(rt.store.getWorkflow(wId)!, rt.store.getStep(gId)!).delivery, name).toBe('');
      const { byRule, byPerOrder } = await sweepBothPaths(rt, wId);
      expect(byRule, `${name}：规则路径不该批`).toEqual([]);
      expect(byPerOrder, `${name}：单子级免批路径不该批`).toEqual([]);
      expect(rt.store.getStep(gId)!.status, name).toBe('waiting_human');
      expect(autoEvents(rt, wId), name).toEqual([]);
      rt.stop();
    }
  });

  it('shadow 下没申报的审批不留「将被自动批准」痕', async () => {
    const rt = setup();
    const [wId] = makeChain(rt, [UNDECLARED, SEND]);
    const shadow: string[] = [];
    const ns = await autoApproveSweep({ store: rt.store, config: () => cfg('shadow', [{}]), approve: async (id) => { shadow.push(id); }, log: console });
    expect(ns).toBe(0);
    expect(shadow).toEqual([]);
    expect(autoEvents(rt, wId)).toEqual([]);
    rt.stop();
  });

  // 规则显式写明「包含发送」才算授权（宪法 §4：对外发信的自动面只能由显式规则
  // 开）。单子级免批的等价规则恒为 includeSend=false，没有这个口子。
  it('规则显式 include_send=true 命中时，没申报的审批可以被批（规则显式授权）；单子级免批没有这个口子', async () => {
    const rt = setup();
    const [wId, gId] = makeChain(rt, [UNDECLARED, SEND]);
    const withSend: string[] = [];
    await autoApproveSweep({ store: rt.store, config: () => cfg('on', [{ include_send: true }]), approve: async (id) => { withSend.push(id); }, log: console });
    expect(withSend).toEqual([gId]);
    rt.store.updateWorkflowMeta(wId, { auto_approve: true });
    const perOrder: string[] = [];
    await autoApproveSweep({ store: rt.store, config: () => cfg('off', []), approve: async (id) => { perOrder.push(id); }, log: console });
    expect(perOrder).toEqual([]);
    rt.stop();
  });

  it('显式申报 apply / artifact 的审批照旧可以自动批，后面跟着 send 步骤也一样', async () => {
    for (const delivery of ['artifact', 'apply']) {
      for (const tail of [[], [SEND]] as const) {
        const label = `${delivery} / 后面${tail.length === 0 ? '没有' : '跟着'} send`;
        const rt = setup();
        const [wId, gId] = makeChain(rt, [{ kind: 'gate', title: '闸门：回信审批', input: { delivery, draft: '交付物' } }, ...tail]);
        const { byRule, byPerOrder } = await sweepBothPaths(rt, wId);
        expect(byRule, `${label}：规则路径`).toEqual([gId]);
        expect(byPerOrder, `${label}：单子级免批路径`).toEqual([gId]);
        rt.stop();
      }
    }
  });

  it('显式申报 email 的审批行为不变：默认不批，规则显式 include_send 才批，单子级免批也不批', async () => {
    const rt = setup();
    const [wId, gId] = makeChain(rt, [{ kind: 'gate', title: '请批', input: { delivery: 'email', envelope: { to: 'casey@x.de' } } }]);
    // include_send 对照放在开免批标记之前：单子级免批一开，配置规则就不参与了
    // （sweepBothPaths 会把 meta.auto_approve 打开）。
    const withSend: string[] = [];
    await autoApproveSweep({ store: rt.store, config: () => cfg('on', [{ include_send: true }]), approve: async (id) => { withSend.push(id); }, log: console });
    expect(withSend).toEqual([gId]);
    const { byRule, byPerOrder } = await sweepBothPaths(rt, wId);
    expect(byRule).toEqual([]);
    expect(byPerOrder).toEqual([]);
    rt.stop();
  });

  // 端到端（真引擎、真阶梯模板、真 approve 正门）：回信流一路推到「闸门：
  // 回信审批」——没申报、没收件人、标题不含「发送」，下一步就是发信。自动
  // 批准扫过去必须一动不动、信发不出去；对照：人手动批准后信立刻发出，证明
  // 这不是一张无关紧要的闸。
  it('真引擎端到端：阶梯回信流的「闸门：回信审批」，规则路径与单子级免批都不碰它，信发不出去', async () => {
    const w = makeEngine();
    const wf = await ladderEmail(w.engine, makeEmail());
    const steps = () => w.store.stepsForWorkflow(wf.id);
    const replyGate = () => steps().find((s) => s.title === '闸门：回信审批');
    // 前面的闸由人批、agent 回合由人结算，推到回信审批等人。
    for (let i = 0; i < 80 && replyGate()?.status !== 'waiting_human'; i++) {
      const gate = steps().find((s) => s.kind === 'gate' && s.status === 'waiting_human' && s.title !== '闸门：回信审批');
      const agent = steps().find((s) => (s.kind === 'agent' || s.kind === 'verify') && s.status === 'running');
      if (gate !== undefined) await w.engine.approve(gate.id, '', 'boss');
      else if (agent !== undefined) await w.engine.onAgentStopped('agent-a', 'ok', '整理完毕，见正文');
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(replyGate()?.status).toBe('waiting_human');
    expect(replyGate()!.input['delivery']).toBeUndefined(); // 没申报
    expect(w.sent).toHaveLength(0);
    const sweep = (): Promise<number> => autoApproveSweep({
      store: w.store, config: () => cfg('on', [{}]), log: console,
      approve: (id, note, by) => w.engine.approve(id, note, by),
    });
    // 规则路径（on + 无条件规则）。
    expect(await sweep()).toBe(0);
    // 单子级免批（全局配置关着也直达自动面）。
    w.store.updateWorkflowMeta(wf.id, { auto_approve: true });
    expect(await autoApproveSweep({
      store: w.store, config: () => cfg('off', []), log: console,
      approve: (id, note, by) => w.engine.approve(id, note, by),
    })).toBe(0);
    expect(replyGate()?.status).toBe('waiting_human');
    expect(w.sent).toHaveLength(0);
    expect(w.store.listEvents(200).some((e) => e.type === 'gate_auto_approved')).toBe(false);
    // 对照：人一批，信就发——所以自动批准绝不能替人批这张闸。
    await w.engine.approve(replyGate()!.id, '可以发', 'boss');
    await until(() => w.sent.length === 1);
    expect(w.sent[0]!.to).toBe('boss@example.com');
  });

  // nodes 模式的那个口子（真引擎）：一张没申报的审批，后面还没有发信节点——
  // 只看「后面有没有发信步骤」会把它当普通审批批掉；批掉之后 agent 就能追加
  // 发信节点（引擎只查「本单有已批准的闸门」），信就发了。新规则下它根本不会
  // 被自动批准：扫描之后审批仍在等人。对照：人一批，agent 追加发信节点，信
  // 立刻发出——证明这个场景是真的。
  it('nodes 模式：没申报的审批后面还没有发信节点——两条路径扫过都仍在等人，agent 追加发信节点的口子堵住', async () => {
    const BODY = '交付物:banner-v3.html + 修订说明';
    const sha = createHash('sha256').update(BODY).digest('hex');
    const w = makeEngine({
      artifacts: {
        list: () => [], updateMeta: () => {},
        getContent: async (id) => id === 'art_body'
          ? { bytes: Buffer.from(BODY), sha256: sha, name: 'b.txt', viewRole: 'body' }
          : null,
        sweepCaseInbox: async () => ({ count: 0, entries: [], envelope: null, warnings: [], has_manifest: false }),
      } satisfies ArtifactPort,
      caseInboxDir: () => join(tmpdir(), 'juli-autoap-nodes-na'),
    });
    // 回信流（meta.from 在位）：agent 开了一张「交付审阅」闸，没申报 delivery、
    // 没申报收件人，带 body 工件；发信节点要等批准之后才追加。
    const wf = w.store.createWorkflow({
      kind: 'email', title: '节点任务', status: 'running', meta: { mode: 'nodes', from: 'casey@acme.de', subject: '报价' },
    });
    const gate = w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'gate', title: '交付审阅',
      input: { deliverables: [{ id: 'art_body', name: 'b.txt', view_role: 'body', sha256: sha }] },
    });
    w.store.setStepStatus(gate.id, 'waiting_human');
    expect(isSendGateDecision(gate.title, gate.input)).toBe(false); // 引擎的判据认不出它
    expect(w.store.stepsForWorkflow(wf.id).some((s) => s.kind === 'send')).toBe(false); // 后面还没有发信节点
    const sweep = (config: () => AutoApproveConfig): Promise<number> => autoApproveSweep({
      store: w.store, config, log: console, approve: (id, note, by) => w.engine.approve(id, note, by),
    });
    expect(await sweep(() => cfg('on', [{}]))).toBe(0); // 规则路径（on + 无条件规则）
    w.store.updateWorkflowMeta(wf.id, { auto_approve: true });
    expect(await sweep(() => cfg('off', []))).toBe(0); // 单子级免批
    expect(w.store.getStep(gate.id)!.status).toBe('waiting_human'); // 扫描之后审批仍在等人
    expect(w.sent).toHaveLength(0);
    expect(w.store.listEvents(200).some((e) => e.type === 'gate_auto_approved')).toBe(false);
    // 对照：这张闸一被批准，agent 追加发信节点就能把信发出去。
    await w.engine.approve(gate.id, '', 'boss');
    await w.engine.appendNode(wf.id, { kind: 'send', title: '发送' });
    await until(() => w.sent.length === 1);
    expect(w.sent[0]!.to).toBe('casey@acme.de');
    expect(w.sent[0]!.body).toContain('banner-v3.html');
  });
});
