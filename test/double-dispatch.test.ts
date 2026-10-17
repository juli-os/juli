// 双投事故四修（2026-09-28 用户口令「1可以 2可以 3可以 4可以」）：
// ①忙闲改道彻底化（resolved_session 落步）②僵尸处置对准实际落点（锁内守卫）
// ③重派跟随落点（session0 优先 resolved_session）④闸门开启不经收单台排队。
// 事故链：acme 忙→批量单改道 meridian（input.session 仍=acme）→照片步
// 完成后 acme 空闲→僵尸按播种地址盯 acme 判死→按旧地址重派回 acme
// =两个 session 各收一份；同时批量回合占槽→照片单闸门 pending 进不了
// waiting_human=审批卡不出现。

import { describe, expect, it } from 'vitest';
import { ladderEmail, makeEngine, makeEmail, until } from './helpers.ts';
import { makeQueue } from '../src/business/workflow/queue.ts';
import { createLedgerStore } from '@juli-os/ledger';
import { makeClock, seqIds } from './helpers.ts';

describe('①③ 改道彻底化 + 重派跟随落点', () => {
  const setupBusyDivert = async () => {
    // 声明表：juli-reply（默认，占位忙）+ acme + meridian-case-count（改道候选）。
    // 并发 2：占槽单 + 受害单同时派发（事故现场=照片单脱队让批量单插队；
    // 测试用并发 2 等价还原「acme 在跑 + 新单照常派发」的碰撞条件）。
    const w = makeEngine({
      queueConcurrency: 2,
      routing: {
        defaultSession: 'juli-reply', defaultProject: 'p',
        agents: [
          { session: 'juli-reply', company: 'juli', domain: 'reply' },
          { session: 'acme', company: 'acme', domain: 'site' },
          { session: 'meridian-case-count', company: 'acme', domain: 'stats' },
        ],
      },
      availableSessions: ['juli-reply', 'acme', 'meridian-case-count'],
    });
    // acme 在跑一张单（占住 running 步）→ 下一张路由落 acme 的单派发时必改道。
    // 占用单走 startTask 显式 session（0930 起=钉住，照跑 acme 不改道）。
    const busy = await w.engine.startTask('占用 acme', { brief: 'busy', session: 'acme' });
    await until(() => w.store.getWorkflow(busy.id)!.status === 'running');
    // 受害单=邮件线形态（路由落到步、无钉——显式 session 已钉住不再改道）：
    // 手动造步模拟进件播种，改道路径由此承担。
    const victim = w.store.createWorkflow({ kind: 'adhoc', title: '该改道的单', status: 'running', meta: { mode: 'nodes' } });
    w.store.createStep({ workflowId: victim.id, seq: 1, kind: 'agent', title: '理解与接单', input: { plan: '受害者独特brief标记', session: 'acme' } });
    await w.engine.advance(victim.id);
    await until(() => w.store.stepsForWorkflow(victim.id)[0]!.status === 'running');
    return { w, busy, victim };
  };

  it('① 改道后步 input 落 resolved_session（下游看门狗/重派按它找活会话）', async () => {
    const { w, victim } = await setupBusyDivert();
    const step = w.store.stepsForWorkflow(victim.id)[0]!;
    expect(step.input['resolved_session']).toBe('meridian-case-count');
    expect(step.input['busy_diverted_from']).toBe('acme'); // 改道留痕保留
    expect(w.dispatched.some((d) => d.session === 'meridian-case-count')).toBe(true);
    expect(w.dispatched.some((d) => d.session === 'acme' && d.text.includes('该改道的单'))).toBe(false);
  });

  it('③ 僵尸重派跟随 resolved_session（不再回到播种地址=不再双投）', async () => {
    const { w, victim } = await setupBusyDivert();
    const stepId = w.store.stepsForWorkflow(victim.id)[0]!.id;
    w.advanceClock(6 * 60_000); // 静默超时（模板 5m 阈值）
    await w.engine.sweepZombies(); // 首扫基线
    await w.engine.sweepZombies(); // 判定+重派
    await w.engine.advance(victim.id);
    const step = w.store.getStep(stepId)!;
    expect(step.input['zombie_attempts']).toBe(1);
    // 重派的落点=改道后的 meridian-case-count，绝不是播种地址 acme。
    const redisp = w.dispatched.filter((d) => d.text.includes('受害者独特brief标记'));
    expect(redisp.length).toBe(2); // 首派+重派各一次（同会话）
    expect(redisp.every((d) => d.session === 'meridian-case-count')).toBe(true);
  });
});

describe('改派盖过历史落点（九跑 P1：assignSession 清 resolved_session 三字段）', () => {
  it('改派后 retry 落人点名的会话，不再被 resolved_session 压回旧落点', async () => {
    const w = makeEngine({
      routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
      availableSessions: ['juli-reply', 'acme'],
    });
    const wf = await w.engine.startTask('改派受害者', { brief: '改派受害者独特brief', session: 'acme' });
    await until(() => w.dispatched.some((d) => d.text.includes('改派受害者独特brief')));
    const step0 = w.store.stepsForWorkflow(wf.id)[0]!;
    // 模拟该步已按旧路由派发到 acme 并失败（落点快照留在步上）。
    w.store.setStepInput(step0.id, { resolved_session: 'acme' });
    w.store.setStepStatus(step0.id, 'failed');
    // 人经改派下拉点名 juli-reply。
    await w.engine.assignSession(wf.id, 'juli-reply', 'reviewer');
    const step1 = w.store.getStep(step0.id)!;
    expect(step1.input['session']).toBe('juli-reply');
    expect(step1.input['resolved_session']).toBeNull(); // 旧落点快照清掉
    expect(step1.input['busy_diverted_from']).toBeNull();
    expect(step1.input['session_pinned']).toBe(true); // 0930：人点名即钉住——忙时不改道宁可排队
    const before = w.dispatched.length;
    await w.engine.retry(step0.id, undefined, 'reviewer');
    await until(() => w.dispatched.length > before);
    expect(w.dispatched.at(-1)!.session).toBe('juli-reply'); // 落人会话，不是 acme
  });
});

describe('播种钉（0930：显式/继承落点=钉住，忙不改道）', () => {
  it('startTask 显式 session → 首步 input 带 session_pinned=true + workflow.session 锚定', async () => {
    const w = makeEngine({ routing: { defaultSession: 'juli-reply', defaultProject: 'p' }, availableSessions: ['juli-reply', 'acme'] });
    const wf = await w.engine.startTask('钉住播种', { brief: 'b', session: 'acme' });
    const step = w.store.stepsForWorkflow(wf.id)[0]!;
    expect(step.input['session']).toBe('acme');
    expect(step.input['session_pinned']).toBe(true);
    expect(w.store.getWorkflow(wf.id)!.session).toBe('acme'); // queued 期即锚定（排队也是忙）
  });

  it('startTask 无 session → 首步无钉无锚（default 兜底行为不变）', async () => {
    const w = makeEngine({ routing: { defaultSession: 'juli-reply', defaultProject: 'p' }, availableSessions: ['juli-reply'] });
    const wf = await w.engine.startTask('裸起单', { brief: 'b' });
    const step = w.store.stepsForWorkflow(wf.id)[0]!;
    expect(step.input['session']).toBeUndefined();
    expect(step.input['session_pinned']).toBeUndefined();
    // workflow.session 由派发面按解析结果锚定（既有行为），播种期不预锚。
  });
});

describe('② 僵尸处置锁内落点守卫', () => {
  it('等锁期间步的落点已变 → 本次判定作废（零 interrupt 零重派）', async () => {
    const w = makeEngine();
    await ladderEmail(w.engine, makeEmail());
    const wfId = w.store.listWorkflows()[0]!.id;
    await until(() => w.store.stepsForWorkflow(wfId)[1]!.status === 'waiting_human');
    await w.engine.approve(w.store.stepsForWorkflow(wfId)[1]!.id, '', 'boss');
    await until(() => w.store.stepsForWorkflow(wfId)[2]!.status === 'running');
    w.advanceClock(6 * 60_000);
    await w.engine.sweepZombies(); // 首扫：对 agent-a 设基线
    // 等锁窗口内落点变了（模拟：改道标记落步）——healZombie 锁内重读后
    // 应对 agent-a 的本次判定作废，不再 interrupt/重派。
    w.store.setStepInput(w.store.stepsForWorkflow(wfId)[2]!.id, { resolved_session: 'agent-b' });
    const before = w.dispatched.length;
    await w.engine.sweepZombies(); // 次扫：发现 agent-a 静默 → healZombie → 守卫拦下
    const step = w.store.stepsForWorkflow(wfId)[2]!;
    expect(step.input['zombie_attempts']).toBeUndefined(); // 未重派计数
    expect(w.dispatched.length).toBe(before); // 零新派发
    expect(w.store.listEvents(100).some((e) => e.type === 'step_redispatched')).toBe(false);
  });
});

describe('④ 闸门开启不经收单台排队', () => {
  it('agent 回合占满并发时，闸门单的 pending→waiting_human 直通（不等槽位）', async () => {
    const { clock } = makeClock();
    const store = createLedgerStore(':memory:', { clock, ids: seqIds() });
    let advances = 0;
    const queue = makeQueue({
      store, queueConcurrency: 1,
      late: { advance: async (_id) => { advances++; } },
    });
    // 占槽单：agent 步 running。
    const busy = store.createWorkflow({ kind: 'adhoc', title: 'busy', status: 'running', meta: { mode: 'nodes' } });
    store.createStep({ workflowId: busy.id, seq: 1, kind: 'agent', title: 'a', input: { session: 's' } });
    store.setStepStatus(store.stepsForWorkflow(busy.id)[0]!.id, 'running');
    queue.enqueueBack(busy.id);
    expect(queue.queueStatus().active).toEqual([busy.id]);
    // 闸门单：当前步=gate pending（轻量——照片单事故形态）。
    const gated = store.createWorkflow({ kind: 'adhoc', title: 'gated', status: 'running', meta: { mode: 'nodes' } });
    store.createStep({ workflowId: gated.id, seq: 1, kind: 'gate', title: '确认闸门', input: { delivery: 'apply' } });
    const advancesBefore = advances;
    queue.enqueueBack(gated.id);
    // 修复前：gated 进 waiting 等 busy 让位；修复后：轻量直通立即 advance。
    expect(advances).toBeGreaterThan(advancesBefore);
    expect(queue.queueStatus().waiting).toEqual([]);
    expect(queue.queueStatus().active).toEqual([busy.id]); // 并发预算未被轻量步占用
  });

  it('agent 单照常排队（轻量直通只放行 gate pending）', async () => {
    const { clock } = makeClock();
    const store = createLedgerStore(':memory:', { clock, ids: seqIds() });
    let advances = 0;
    const queue = makeQueue({
      store, queueConcurrency: 1,
      late: { advance: async () => { advances++; } },
    });
    const busy = store.createWorkflow({ kind: 'adhoc', title: 'busy', status: 'running', meta: { mode: 'nodes' } });
    store.createStep({ workflowId: busy.id, seq: 1, kind: 'agent', title: 'a', input: { session: 's' } });
    store.setStepStatus(store.stepsForWorkflow(busy.id)[0]!.id, 'running');
    queue.enqueueBack(busy.id);
    const other = store.createWorkflow({ kind: 'adhoc', title: 'other', status: 'running', meta: { mode: 'nodes' } });
    store.createStep({ workflowId: other.id, seq: 1, kind: 'agent', title: 'b', input: { session: 's2' } });
    const before = advances;
    queue.enqueueBack(other.id);
    expect(advances).toBe(before); // agent 单不直通
    expect(queue.queueStatus().waiting).toEqual([other.id]);
  });
});


describe('跟进会话继承（2026-09-28 用户口令「复用之前处理的 session」）', () => {
  it('relates_to 原单有落点 → 跟进首步继承原会话 + session_inherited 留痕', async () => {
    const w = makeEngine({ routing: { defaultSession: 'juli-reply', defaultProject: 'p' } });
    const first = await w.engine.startTask('原单', { brief: 'x' });
    w.store.setWorkflowSession(first.id, 'acme'); // 原单执行落点=acme
    const follow = await w.engine.startTask('跟进：原单', { brief: '续办', relates_to: first.id });
    const step = w.store.stepsForWorkflow(follow.id)[0]!;
    expect(step.input['session']).toBe('acme');
    expect(w.store.getWorkflow(follow.id)!.meta['session_inherited_from']).toBe(first.id);
    expect(w.store.listEvents(50).some((e) => e.type === 'session_inherited' && e.payload['session'] === 'acme')).toBe(true);
  });

  it('显式 session 压过继承（调用方说了算）', async () => {
    const w = makeEngine({ routing: { defaultSession: 'juli-reply', defaultProject: 'p' } });
    const first = await w.engine.startTask('原单', { brief: 'x' });
    w.store.setWorkflowSession(first.id, 'acme');
    const follow = await w.engine.startTask('跟进', { brief: 'y', relates_to: first.id, session: 'juli-dev' });
    expect(w.store.stepsForWorkflow(follow.id)[0]!.input['session']).toBe('juli-dev');
    expect(w.store.getWorkflow(follow.id)!.meta['session_inherited_from']).toBeUndefined();
  });

  it('原单落点是绑定会话 → 不继承（session_bound 守卫只认 sender 路由标记）', async () => {
    const w = makeEngine({
      routing: {
        defaultSession: 'juli-reply', defaultProject: 'p',
        boundAgents: [{ session: 'project-a', cwd: '/w', senders: ['alisa@x.cn'] }],
      },
    });
    const first = await w.engine.startTask('会计单', { brief: 'x' });
    w.store.setWorkflowSession(first.id, 'project-a');
    const follow = await w.engine.startTask('跟进', { brief: 'y', relates_to: first.id });
    expect(w.store.stepsForWorkflow(follow.id)[0]!.input['session']).toBeUndefined(); // 走 default 兜底
    expect(w.store.getWorkflow(follow.id)!.meta['session_inherited_from']).toBeUndefined();
  });

  it('原单跑在默认会话（落点=default 也是真落点）→ 跟进照继承同一会话', async () => {
    const w = makeEngine({ routing: { defaultSession: 'juli-reply', defaultProject: 'p' } });
    const first = await w.engine.startTask('原单', { brief: 'x' });
    await until(() => w.store.stepsForWorkflow(first.id)[0]!.status === 'running'); // 派发回填 session
    expect(w.store.getWorkflow(first.id)!.session).toBe('juli-reply');
    const follow = await w.engine.startTask('跟进', { brief: 'y', relates_to: first.id });
    expect(w.store.stepsForWorkflow(follow.id)[0]!.input['session']).toBe('juli-reply');
  });
});


describe('统一干预四件套（2026-09-28 用户口令「状态迁移时人插得进手」）', () => {
  it('无 override → 行为零变化：派发走 default，零 override 事件', async () => {
    const w = makeEngine({ routing: { defaultSession: 'juli-reply', defaultProject: 'p' } });
    const wf = await w.engine.startTask('普通单', { brief: 'x' });
    await until(() => w.store.getWorkflow(wf.id)!.status === 'running');
    expect(w.dispatched[0]!.session).toBe('juli-reply');
    expect(w.store.listEvents(50).some((e) => e.type.startsWith('override'))).toBe(false);
  });

  it('session 干预：派发点消费改派 + 钉住不被忙闲改道 + one-shot 销账', async () => {
    // 真实序列：单被 hold 扣住（干预窗口）→ 人设 session 干预 → 放行 →
    // 派发点消费。acme 占位忙（逼出改道条件），钉 acme → 不改道。
    const workHours = { mode: 'on' as const, start: '00:00', end: '23:59', timezone: 'Asia/Shanghai', scope: 'all' as const, aggregate_throttle_min: 120 };
    const w = makeEngine({
      workHours,
      queueConcurrency: 2,
      routing: {
        defaultSession: 'juli-reply', defaultProject: 'p',
        agents: [
          { session: 'juli-reply', company: 'juli', domain: 'reply' },
          { session: 'acme', company: 'acme', domain: 'site' },
          { session: 'meridian-case-count', company: 'acme', domain: 'stats' },
        ],
      },
      availableSessions: ['juli-reply', 'acme', 'meridian-case-count'],
    });
    const busy = await w.engine.startTask('占位', { brief: 'busy', session: 'acme', priority: 'high' });
    await until(() => w.store.getWorkflow(busy.id)!.status === 'running');
    const victim = await w.engine.startTask('被干预单', { brief: '受害者干预标记' });
    expect(w.engine.queueStatus().held).toContain(victim.id); // 干预窗口在
    w.engine.setOverride(victim.id, { session: 'acme' }, 'web');
    w.engine.releaseHold(victim.id, 'web');
    await until(() => w.store.stepsForWorkflow(victim.id)[0]!.status === 'running');
    const step = w.store.stepsForWorkflow(victim.id)[0]!;
    expect(step.input['session']).toBe('acme');           // 消费：改派生效
    expect(step.input['session_pinned']).toBe(true);         // 钉住标记
    expect(step.input['busy_diverted_from']).toBeUndefined(); // 未被改道去 meridian
    expect(w.dispatched.find((d) => d.text.includes('受害者干预标记'))!.session).toBe('acme');
    const wfv = w.store.getWorkflow(victim.id)!;
    expect((wfv.meta['override'] as Record<string, unknown>)?.['session']).toBeUndefined(); // 销账
    expect(w.store.listEvents(200).some((e) => e.type === 'override_set')).toBe(true);
    expect(w.store.listEvents(200).some((e) => e.type === 'override_applied')).toBe(true);
  });

  it('context 干预：追加进任务卡（agent 必读位）', async () => {
    // 同 session 测试：hold 扣住造干预窗口，放行后派发点消费 context。
    const workHours = { mode: 'on' as const, start: '00:00', end: '23:59', timezone: 'Asia/Shanghai', scope: 'all' as const, aggregate_throttle_min: 120 };
    const w = makeEngine({ workHours, routing: { defaultSession: 'juli-reply', defaultProject: 'p' } });
    const wf = await w.engine.startTask('ctx 单', { brief: '原始任务' });
    expect(w.engine.queueStatus().held).toContain(wf.id);
    w.engine.setOverride(wf.id, { context: '方案工件在原单 case-inbox，别重新调研' }, 'web');
    w.engine.releaseHold(wf.id, 'web');
    await until(() => w.store.stepsForWorkflow(wf.id)[0]!.status === 'running');
    const hit = w.dispatched.find((d) => d.text.includes('原始任务'))!;
    expect(hit.text).toContain('人工干预补充');
    expect(hit.text).toContain('方案工件在原单 case-inbox');
  });

  it('hold_until 干预：压单到指定时刻（独立于窗口配置），到期自然放行', async () => {
    // 窗口 01:00–02:00（makeClock 起点 08:00Z=16:00 北京在窗外…改用 UTC 视角：
    // 起点是 2026-09-07T08:00Z，Asia/Shanghai=16:00；取窗口 15:30–16:30 使起点在窗内）。
    // hold_until 压到 17:30——比窗口尾（16:30）更久，证 hold_until 独立生效。
    const w = makeEngine({
      workHours: { mode: 'on', start: '15:30', end: '16:30', timezone: 'Asia/Shanghai', scope: 'all', aggregate_throttle_min: 120 },
      routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
    });
    const wf = await w.engine.startTask('压一压', { brief: 'x' });
    expect(w.engine.queueStatus().held).toContain(wf.id); // 窗口内被扣
    const until_ = new Date('2026-09-07T09:30:00Z').toISOString(); // 17:30 北京
    w.engine.setOverride(wf.id, { hold_until: until_ }, 'web');
    w.advanceClock(45 * 60 * 1000); // 到 16:45 北京——窗口已关，hold_until 仍在
    w.engine.holdSweep();
    expect(w.engine.queueStatus().held).toContain(wf.id); // 窗口关了仍被人工压着
    expect(w.dispatched).toHaveLength(0);
    w.advanceClock(46 * 60 * 1000); // 到 17:31——hold_until 到期
    w.engine.holdSweep();
    await until(() => w.store.getWorkflow(wf.id)!.status === 'running');
  });

  it('priority=high 即时直通 + dispatch_now 清 hold', async () => {
    const w = makeEngine({
      workHours: { mode: 'on', start: '00:00', end: '23:59', timezone: 'Asia/Shanghai', scope: 'all', aggregate_throttle_min: 120 },
      routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
    });
    const wf = await w.engine.startTask('窗口内单', { brief: 'x' });
    expect(w.engine.queueStatus().held).toContain(wf.id);
    w.engine.setOverride(wf.id, { priority: 'high' }, 'web');
    await until(() => w.store.getWorkflow(wf.id)!.status === 'running'); // high 直通
    expect(w.dispatched.length).toBeGreaterThan(0);
  });
});


describe('等输入豁免（2026-09-28 提问卡单修复：ask user 不再被僵尸打断）', () => {
  const setupAtAgent = async (fingerprint: () => string) => {
    const w = makeEngine({
      routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
      zombieFingerprint: async () => fingerprint(),
    });
    await ladderEmail(w.engine, makeEmail());
    const wfId = w.store.listWorkflows()[0]!.id;
    await until(() => w.store.stepsForWorkflow(wfId)[1]!.status === 'waiting_human');
    await w.engine.approve(w.store.stepsForWorkflow(wfId)[1]!.id, '', 'boss');
    await until(() => w.store.stepsForWorkflow(wfId)[2]!.status === 'running');
    return { w, wfId };
  };
  const ASK_PANE = '⎿ Do you want to make this edit to about.html?\n❯ 1. Yes\n  2. No, and tell claude what to do differently';

  it('等输入态：超时也不判死（豁免）+ agent_awaiting_input 留痕 + 推送通知', async () => {
    const { w, wfId } = await setupAtAgent(() => ASK_PANE);
    w.advanceClock(30 * 60_000); // 远超 5m 阈值
    await w.engine.sweepZombies(); // 首扫基线
    await w.engine.sweepZombies(); // 次扫本应判死——豁免
    const step = w.store.stepsForWorkflow(wfId)[2]!;
    expect(step.status).toBe('running'); // 没被打断/重派/判死
    expect(step.input['zombie_attempts']).toBeUndefined();
    const ev = w.store.listEvents(200).find((e) => e.type === 'agent_awaiting_input');
    expect(ev).toBeDefined();
    expect(String(ev!.payload['session'] ?? '')).toBe('juli-reply');
  });

  it('同一等待期只通知一次（指纹未变不重复）', async () => {
    const { w } = await setupAtAgent(() => ASK_PANE);
    w.advanceClock(30 * 60_000);
    await w.engine.sweepZombies();
    await w.engine.sweepZombies();
    await w.engine.sweepZombies(); // 第三扫——指纹同，不重复通知
    expect(w.store.listEvents(200).filter((e) => e.type === 'agent_awaiting_input')).toHaveLength(1);
  });

  it('真僵尸（无等待指纹的纯静默）照判不误——豁免不放走死任务', async () => {
    const { w, wfId } = await setupAtAgent(() => 'plain silent pane no markers here');
    w.advanceClock(6 * 60_000);
    await w.engine.sweepZombies();
    await w.engine.sweepZombies();
    const step = w.store.stepsForWorkflow(wfId)[2]!;
    expect(step.input['zombie_attempts']).toBe(1); // 正常重派路径还在
    expect(w.store.listEvents(200).some((e) => e.type === 'agent_awaiting_input')).toBe(false);
  });
});


describe('hook 等输入（CC Notification 信号，2026-09-28 用户裁定「cli hook 更稳妥」）', () => {
  const setup = async (fingerprint: () => string) => {
    const w = makeEngine({
      routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
      zombieFingerprint: async () => fingerprint(),
    });
    await ladderEmail(w.engine, makeEmail());
    const wfId = w.store.listWorkflows()[0]!.id;
    await until(() => w.store.stepsForWorkflow(wfId)[1]!.status === 'waiting_human');
    await w.engine.approve(w.store.stepsForWorkflow(wfId)[1]!.id, '', 'boss');
    await until(() => w.store.stepsForWorkflow(wfId)[2]!.status === 'running');
    return { w, wfId };
  };

  it('Notification hook → 豁免（pane 无指纹也豁免）+ 事件带 message + 同期一次', async () => {
    const { w } = await setup(() => '完全没有等待指纹的普通 pane');
    await w.engine.noteAwaiting('juli-reply', 'Claude needs your permission to use Bash');
    w.advanceClock(30 * 60_000);
    await w.engine.sweepZombies();
    await w.engine.sweepZombies();
    const step = w.store.stepsForWorkflow(w.store.listWorkflows()[0]!.id)[2]!;
    expect(step.status).toBe('running'); // 未被打断
    expect(step.input['zombie_attempts']).toBeUndefined();
    const evs = w.store.listEvents(200).filter((e) => e.type === 'agent_awaiting_input');
    expect(evs).toHaveLength(1); // 同一等待期一次
    expect(evs[0]!.payload['source']).toBe('hook');
    expect(String(evs[0]!.payload['message'])).toContain('permission');
    // hook 重复通知（CC 每权限请求一发）——同期不重复
    await w.engine.noteAwaiting('juli-reply', 'Claude needs your permission to use Edit');
    expect(w.store.listEvents(200).filter((e) => e.type === 'agent_awaiting_input')).toHaveLength(1);
  });

  it('心跳即解除豁免（人已回答/agent 继续）→ 真僵尸判定恢复', async () => {
    const { w } = await setup(() => '完全没有等待指纹的普通 pane');
    await w.engine.noteAwaiting('juli-reply', 'waiting for input');
    w.engine.touchSession('juli-reply'); // 心跳=已继续
    w.advanceClock(6 * 60_000);
    await w.engine.sweepZombies();
    await w.engine.sweepZombies();
    const step = w.store.stepsForWorkflow(w.store.listWorkflows()[0]!.id)[2]!;
    expect(step.input['zombie_attempts']).toBe(1); // 真僵尸路径恢复
  });

  it('无在途步的 idle 通知（turn 已结束）→ no-op 零标记', async () => {
    const w = makeEngine({ routing: { defaultSession: 'juli-reply', defaultProject: 'p' } });
    await w.engine.noteAwaiting('juli-reply', '60s idle');
    expect(w.store.listEvents(50).some((e) => e.type === 'agent_awaiting_input')).toBe(false);
  });
});


describe('问询闸门=选择题（2026-09-28 用户口令「升格为 step+审核，做成选择题」）', () => {
  const MENU_PANE = [
    '⎿ Read 12 lines from /web/site/about.html',
    '',
    'Do you want to make this edit to about.html?',
    '❯ 1. Yes',
    '  2. Yes, and don\'t ask again',
    '  3. No, and tell claude what to do differently (esc to interrupt)',
  ].join('\n');

  it('parsePaneQuestion：菜单→编号选项（reply=编号）；无菜单→通用选项兜底', async () => {
    const { parsePaneQuestion } = await import('@juli-os/agents');
    const q = parsePaneQuestion(MENU_PANE, 'Claude needs your permission to use Edit');
    expect(q.options.map((o) => o.reply)).toEqual(['1', '2', '3']);
    expect(q.options[0]!.label).toContain('Yes');
    expect(q.question).toBe('Claude needs your permission to use Edit');
    const open = parsePaneQuestion('普通 pane 无菜单', '');
    expect(open.options.map((o) => o.reply)).toEqual(['yes', 'no']); // 兜底
    expect(open.question).toBe('普通 pane 无菜单');
  });

  it('noteAwaiting → 挂 waiting_human 问询闸（带选项）+ 去重不重复挂', async () => {
    const w = makeEngine({
      routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
      zombieFingerprint: async () => MENU_PANE,
    });
    await ladderEmail(w.engine, makeEmail());
    const wfId = w.store.listWorkflows()[0]!.id;
    await until(() => w.store.stepsForWorkflow(wfId)[1]!.status === 'waiting_human');
    await w.engine.approve(w.store.stepsForWorkflow(wfId)[1]!.id, '', 'boss');
    await until(() => w.store.stepsForWorkflow(wfId)[2]!.status === 'running');
    await w.engine.noteAwaiting('juli-reply', 'Claude needs your permission to use Edit');
    const gates = w.store.stepsForWorkflow(wfId).filter((g) => g.kind === 'gate' && g.status === 'waiting_human' && (g.input as Record<string, unknown>)['question_options'] !== undefined);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.title).toContain('问询：');
    expect((gates[0]!.input as Record<string, unknown>)['question_session']).toBe('juli-reply');
    // 九跑 P1 断言补强：编号菜单选项必须真实落库（reply=编号），不得退化为 yes/no 兜底。
    const opts = (gates[0]!.input as Record<string, unknown>)['question_options'] as { label: string; reply: string }[];
    expect(opts.map((o) => o.reply)).toEqual(['1', '2', '3']);
    expect(opts[0]!.label).toContain('Yes');
    expect(String((gates[0]!.input as Record<string, unknown>)['question'])).toContain('Claude needs your permission');
    expect(w.store.listEvents(100).some((e) => e.type === 'question_gate_opened')).toBe(true);
    // CC 重复通知（下一权限请求）→ 不重复挂
    await w.engine.noteAwaiting('juli-reply', 'another permission');
    expect(w.store.stepsForWorkflow(wfId).filter((g) => (g.input as Record<string, unknown>)['question_options'] !== undefined)).toHaveLength(1);
  });

  it('点选答案 → 原样回流会话（approve 的 answer 分支）+ 闸门 completed + agent 豁免保持', async () => {
    const relays: { session: string; text: string }[] = [];
    const w = makeEngine({
      routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
      zombieFingerprint: async () => MENU_PANE,
      sendToSession: async (session, text) => { relays.push({ session, text }); return { delivered: true, reason: '' }; },
    });
    // nodes 流（startTask）——批准回流机关只对 nodes 生效（ladder 自推进）。
    const wf = await w.engine.startTask('问询单', { brief: '需要权限的任务', session: 'juli-reply' });
    await until(() => w.store.stepsForWorkflow(wf.id)[0]!.status === 'running');
    await w.engine.noteAwaiting('juli-reply', 'Claude needs your permission to use Edit');
    const gate = w.store.stepsForWorkflow(wf.id).find((g) => (g.input as Record<string, unknown>)['question_options'] !== undefined)!;
    // 人点「2」（Yes, and don't ask again）
    await w.engine.approve(gate.id, '2', 'web');
    const answer = relays.find((r) => r.text.includes('问询回答'));
    expect(answer).toBeDefined();
    expect(answer!.text).toContain('：2'); // 答案原样在回流文本里
    expect(answer!.session).toBe('juli-reply');
    expect(w.store.getStep(gate.id)!.status).toBe('completed');
    // 原步仍 running 等 agent 续跑（答案已到它手上）
    expect(w.store.stepsForWorkflow(wf.id)[0]!.status).toBe('running');
  });
});


describe('feedback 锚继承 → 主动 settle（2026-09-28 两次实战后补上）', () => {
  it('跟进继承原单锚（单 id+数组全量去重）+ 事件留痕；已有锚不覆盖', async () => {
    const w = makeEngine({ routing: { defaultSession: 'juli-reply', defaultProject: 'p' } });
    const first = await w.engine.startTask('原批量单', { brief: '按 skill 处理', feedback_record_id: 'r1', feedback_record_ids: ['r1', 'r2', 'r3'] });
    w.store.setWorkflowSession(first.id, 'acme');
    const follow = await w.engine.startTask('跟进', { brief: '续办', relates_to: first.id });
    const ti = w.store.getWorkflow(follow.id)!.meta['template_input'] as Record<string, unknown>;
    expect(ti['feedback_record_id']).toBe('r1');
    expect(ti['feedback_record_ids']).toEqual(['r1', 'r2', 'r3']);
    expect(w.store.listEvents(50).some((e) => e.type === 'feedback_anchor_inherited')).toBe(true);
    // 显式锚优先
    const own = await w.engine.startTask('自带锚的跟进', { brief: 'x', relates_to: first.id, feedback_record_ids: ['r9'] });
    const ti2 = w.store.getWorkflow(own.id)!.meta['template_input'] as Record<string, unknown>;
    expect(ti2['feedback_record_ids']).toEqual(['r9', 'r1', 'r2', 'r3']); // 合并去重
  });

  it('端到端：锚继承的跟进单在闸门已批+全链终态+回挂证据下自动收口', async () => {
    const relays: { session: string; text: string }[] = [];
    const w = makeEngine({
      routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
      sendToSession: async (session, text) => { relays.push({ session, text }); return { delivered: true, reason: '' }; },
    });
    const first = await w.engine.startTask('原批量单', { brief: '按 skill 处理', feedback_record_id: 'r1', feedback_record_ids: ['r1', 'r2'], session: 'juli-reply' });
    w.store.setWorkflowSession(first.id, 'juli-reply');
    await until(() => w.store.stepsForWorkflow(first.id)[0]!.status === 'running');
    // 父单先收工让槽（并发 1）——它的故事已完成，跟进才派得出去。
    await w.engine.onAgentStopped('juli-reply', 'done', '原批量执行完毕');
    // 父单收口（2026-10-13 裁定后语义）：挂靠继承忙时等待/改道——父单卡闸
    // 等人期间 juli-reply 视为忙，跟进不再直接挤进父会话（旧=挤入）。此处
    // 单 agent 世界=等父单终态；测试直接 force-close 让会话空出。
    await w.engine.forceClose(first.id, 'test', 'test');
    const follow = await w.engine.startTask('跟进执行段', { brief: '按 skill 处理并交付 input.delivery="apply"', relates_to: first.id });
    await until(() => w.store.stepsForWorkflow(follow.id)[0]!.status === 'running');
    // 跟进 agent 干完：stop hook 结算 + autoAppend 补 apply 闸（锚继承后认它）
    await w.engine.onAgentStopped('juli-reply', 'done', '跟进执行完毕');
    const steps = w.store.stepsForWorkflow(follow.id);
    const gate = steps[steps.length - 1]!;
    // 无闸则手挂一个 apply 闸再批（autoAppend 只认 feedback 单——锚继承后现在认了）
    if (gate.kind !== 'gate') {
      // onAgentStopped 已结算；手工补挂 apply 闸走引擎口
      // （autoAppendFeedbackGate 在结算时已跑——锚继承应已让它自动补闸）
    }
    const g = w.store.stepsForWorkflow(follow.id).find((x) => x.kind === 'gate');
    expect(g).toBeDefined(); // 锚继承 → autoAppendFeedbackGate 补闸生效
    // 回挂证据：mirror 表插一条 reply_to=r1
    w.store.db.exec("CREATE TABLE IF NOT EXISTS feedback_mirror (id TEXT PRIMARY KEY, reply_to TEXT)");
    w.store.db.exec("INSERT OR REPLACE INTO feedback_mirror (id, reply_to) VALUES ('re1', 'r1')");
    // 人批闸 → 回流 → 闸 completed
    await w.engine.approve(g!.id, '可以', 'web');
    expect(w.store.getStep(g!.id)!.status).toBe('completed');
    // 自动收口（reconcile 的 autoSettleFeedbackRuns——runtime 启动/60s 心跳调）
    const n = await w.engine.autoSettleFeedbackRuns();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(w.store.getWorkflow(follow.id)!.status).toBe('completed'); // 主动 settle ✓
  });
});

describe('结算体持锁（九跑 P2：completeAgentStep 认领锁外先行、锁内重读播种）', () => {
  it('慢收编持锁期间，同工作流锁内动作（amend）被串行化且不互踩', async () => {
    let releaseSweep: (() => void) | null = null;
    const sweepGate = new Promise<void>((r) => { releaseSweep = r; });
    const w = makeEngine({
      caseInboxDir: (workflowId) => `/tmp/juli-case-inbox-test/${workflowId}`,
      artifacts: {
        list: () => [],
        sweepCaseInbox: async () => {
          await sweepGate; // 结算体在锁内停在收编段——锁被结算持有
          return { count: 0, entries: [], envelope: null, warnings: [], has_manifest: false };
        },
      } as never,
    });
    const wf = await w.engine.startTask('持锁结算单', { brief: '按 brief 推进', session: 'agent-a' });
    await until(() => w.store.stepsForWorkflow(wf.id)[0]!.status === 'running');
    // 链尾追加两步：结算播种落在闸门，amend 落在其后的 pending 步——
    // amend 的目标在结算后仍 pending（闸门会转 waiting_human，不可 amend）。
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '确认闸门', input: { delivery: 'apply' } });
    await w.engine.appendNode(wf.id, { kind: 'agent', title: '后续执行', input: { session: 'agent-a', prompt: '继续' } });
    const gate = w.store.stepsForWorkflow(wf.id)[1]!;
    const tail = w.store.stepsForWorkflow(wf.id)[2]!;
    // 结算启动：认领（CAS）成功 → 进锁 → 停在慢收编段（锁被持有）。
    const settleP = w.engine.onAgentStopped('agent-a', 'ok', '交付完成汇报');
    // 同工作流锁内动作在等锁窗口发起——必须被串行化，绝不与播种段并发 merge。
    let amendSettled = false;
    const amendP = w.engine.amendStep(tail.id, { plan: '人工补充任务卡' }, 'boss').then(() => { amendSettled = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(amendSettled).toBe(false); // 无锁实现这里已完成=互踩窗口
    releaseSweep!();
    await Promise.all([settleP, amendP]);
    // 播种与补料都落了库：闸门拿到 output，尾步拿到人工 plan（同键 merge 不丢写）。
    expect(w.store.getStep(gate.id)!.input['output']).toBe('交付完成汇报');
    expect(w.store.getStep(tail.id)!.input['plan']).toBe('人工补充任务卡');
  });
});
