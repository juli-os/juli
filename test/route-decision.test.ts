// route_decision 留痕 + agents 声明路由（板D/B apply，2026-09-20）：
// 判定只在引擎做一次（decideRoute 纯函数），事件进账本、meta 供案卷详情，
// 视图全是投影。落回（resolveSession 改道）单独留 route_fallback 审计事件。

import { describe, expect, it } from 'vitest';
import { createLedgerStore } from '@juli-os/ledger';
import { createEngine } from '../src/business/workflow/engine.ts';
import { decideRoute } from '@juli-os/routing';
import type { EngineDeps } from '../src/business/workflow/engine.ts';
import type { MailerPort, PusherPort } from '../src/contracts/ports.ts';
import { makeClock, makeEmail, seqIds } from './helpers.ts';

const makeWorld = (over: Partial<EngineDeps> = {}) => {
  const { clock, advance } = makeClock();
  const store = createLedgerStore(':memory:', { clock, ids: seqIds() });
  const engine = createEngine({
    store,
    llm: null, model: 't',
    routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
    dispatch: { async dispatch() { return { ok: true, value: undefined } as const; } },
    syncDispatch: null,
    pusher: { async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {} } satisfies PusherPort,
    mailer: { async send() { return { ok: true, value: { messageId: '<out-1@juli.local>' } } as const; } } satisfies MailerPort,
    captureOutput: async () => null, workspaceFor: null,
    availableSessions: ['juli-reply'], resolveSession: null, interruptSession: null,
    rebuildAgent: null, zombieFingerprint: null, clock, ids: seqIds(), templates: {},
    authz: { mode: 'allowlist', allow: ['*@example.com'], deny: [] },
    ...over,
  } satisfies EngineDeps);
  return { engine, store, advanceClock: advance };
};

describe('decideRoute 纯函数（可回放）', () => {
  const routing = {
    defaultSession: 'juli-reply', defaultProject: 'p',
    boundAgents: [{ session: 'project-a', cwd: '~/project-b', senders: ['alice.chen@example.com'] }],
    agents: [
      { session: 'project-a', company: 'juli', domain: 'accounting', senders: [], cwd: '' },
      { session: 'juli-reply', company: 'juli', domain: 'reply', senders: [], cwd: '' },
      { session: 'meridian-case-count', company: 'acme', domain: 'research', senders: ['casey.li@acme.de'], cwd: '' },
    ],
  };

  it('绑定发件人 → chain=bound，company/domain 来自声明', () => {
    const r = decideRoute('alice.chen@example.com', routing);
    expect(r.chain).toEqual(['authz', 'company', 'domain', 'bound']);
    expect(r.session).toBe('project-a');
    expect(r.company).toBe('juli');
    expect(r.domain).toBe('accounting'); // 来自 agents 声明（升格后的结构源）
  });

  it('发件域命中声明（acme.de）→ 真改道：落认领该域的非绑定声明会话（0930）', () => {
    const r = decideRoute('casey.li@acme.de', routing);
    expect(r.company).toBe('acme'); // 发件域命中声明 senders 的域
    expect(r.session).toBe('meridian-case-count'); // 认领 acme.de 的非绑定声明会话，不再滑向 default
    expect(r.chain[3]).toBe('sender_domain');
    expect(r.reasons['company']).toContain('acme.de');
    expect(r.reasons['sender_domain']).toContain('claimed by');
  });

  it('发件域只被绑定会话认领（example.com→project-a）→ 跳过绑定落默认（守卫会拒派）', () => {
    const r = decideRoute('ops.admin@example.com', routing);
    expect(r.session).toBe('juli-reply'); // 绑定会话不在域改道候选内
    expect(r.chain[3]).toBe('default');
  });

  it('未知发件人 → 默认公司 + 默认会话，原因如实写「默认」', () => {
    const r = decideRoute('stranger@example.com', routing);
    // P2① 修复后：无声明=如实留空，账本不造「juli」假数据。
    expect(r.company).toBe('');
    expect(r.reasons['company']).toContain('no declaration');
  });
});

describe('引擎留痕：route_decision 进事件 + meta', () => {
  it('进件即留 route_decision（视图/案卷详情读同一份）', async () => {
    const w = makeWorld();
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    const ev = w.store.listEvents(50).find((e) => e.type === 'route_decision');
    expect(ev).toBeDefined();
    expect(ev!.entityId).toBe(wf.id);
    expect(ev!.payload['session']).toBe('juli-reply');
    expect(ev!.payload['chain']).toEqual(['authz', 'company', 'domain', 'default']);
    expect(ev!.payload['company']).toBe(''); // 无声明如实留空
    const meta = w.store.getWorkflow(wf.id)!.meta['route_decision'] as Record<string, unknown>;
    expect(meta['session']).toBe('juli-reply'); // iOS 链路卡数据源
  });

  it('meta 平铺 route_reasons：四跳原因按链路顺序 \\n join（板F 每跳原因行）', async () => {
    const w = makeWorld();
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    const raw = w.store.getWorkflow(wf.id)!.meta['route_reasons'];
    expect(typeof raw).toBe('string');
    const lines = (raw as string).split('\n');
    expect(lines).toHaveLength(4); // authz → company → domain → default
    expect(lines[0]).toContain('boss@example.com');
    expect(lines[1]).toContain('no declaration'); // 无 agents 声明 → 如实写默认
    expect(lines[3]).toContain('juli-reply'); // 终点跳 = 默认会话
  });

  it('绑定进件的 route_reasons 终点跳写直通（绑定无落回）', async () => {
    const w = makeWorld({
      routing: {
        defaultSession: 'juli-reply', defaultProject: 'p',
        boundAgents: [{ session: 'project-a', cwd: '~/project-b', senders: ['alisa@example.com'] }],
        agents: [{ session: 'project-a', company: 'juli', domain: 'accounting', senders: [], cwd: '' }],
      },
    });
    const wf = await w.engine.startEmailWorkflow(makeEmail({ from: 'alisa@example.com' }));
    const lines = (w.store.getWorkflow(wf.id)!.meta['route_reasons'] as string).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain('direct');
  });

  it('绑定发件人进件 → route_decision chain=bound + session_bound_route 双留痕', async () => {
    const w = makeWorld({
      routing: {
        defaultSession: 'juli-reply', defaultProject: 'p',
        boundAgents: [{ session: 'project-a', cwd: '~/project-b', senders: ['alisa@example.com'] }],
        agents: [{ session: 'project-a', company: 'juli', domain: 'accounting', senders: [], cwd: '' }],
      },
    });
    const wf = await w.engine.startEmailWorkflow(makeEmail({ from: 'alisa@example.com' }));
    const ev = w.store.listEvents(50).find((e) => e.type === 'route_decision')!;
    expect(ev.payload['chain']).toEqual(['authz', 'company', 'domain', 'bound']);
    expect(ev.payload['session']).toBe('project-a');
    expect(w.store.listEvents(50).some((e) => e.type === 'session_bound_route')).toBe(true);
    expect(wf.meta['session_bound']).toBe('project-a');
  });

  it('resolveSession 改道 → route_fallback 审计事件（requested→resolved）', async () => {
    // 手动造单驱动 runAgentStep（进件单在 startEmailWorkflow 内即已派发，
    // 事后改 input 不会再触发——bound-agent.test 同款造法）：步钉不存在名。
    const w = makeWorld({
      resolveSession: (s) => (s === 'juli-reply-9' ? 'juli-reply' : s),
      availableSessions: ['juli-reply'],
      dispatch: {
        async dispatch(_text, session) {
          expect(session).toBe('juli-reply');
          return { ok: true, value: undefined } as const;
        },
      },
    });
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '落回', status: 'running', meta: { mode: 'nodes' } });
    w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'agent', title: '试探',
      input: { plan: '点名一个不存在的会话', session: 'juli-reply-9' },
    });
    await w.engine.advance(wf.id);
    const ev = w.store.listEvents(50).find((e) => e.type === 'route_fallback');
    expect(ev).toBeDefined();
    expect(ev!.payload['requested']).toBe('juli-reply-9');
    expect(ev!.payload['resolved']).toBe('juli-reply');
  });
});

describe('忙闲选枝（板D/G dispatcher 选枝函数）', () => {
  const busyWorld = (available: string[], over: Partial<Parameters<typeof makeWorld>[0]> = {}) => {
    const w = makeWorld({
      availableSessions: available,
      dispatch: {
        async dispatch(_text, session) {
          (w as unknown as { dispatchedTo: string[] }).dispatchedTo.push(session);
          return { ok: true, value: undefined } as const;
        },
      },
      ...over,
    });
    (w as unknown as { dispatchedTo: string[] }).dispatchedTo = [];
    return w;
  };

  it('基会话忙 → 改道其他声明 agent（同公司优先）+ route_busy_divert 留痕 + workflow.session 回填', async () => {
    // 2026-09-27 用户裁决：忙闲改道不再克隆（clone 会让其他 agent 永远没忙
    // 过），负载摊给真实声明 agent——同公司空闲优先（juli-dev 先于 acme）。
    const w = busyWorld(['juli-reply', 'juli-dev', 'acme'], {
      routing: {
        defaultSession: 'juli-reply', defaultProject: 'p',
        agents: [
          { session: 'juli-reply', company: 'juli', domain: 'reply', senders: [], cwd: '' },
          { session: 'juli-dev', company: 'juli', domain: 'dev', senders: [], cwd: '' },
          { session: 'acme', company: 'acme', domain: 'feedback', senders: [], cwd: '' },
        ],
      },
    }) as ReturnType<typeof makeWorld> & { dispatchedTo: string[] };
    // 占住 juli-reply：一条 running 的 agent 步挂在这个会话上。
    const other = w.store.createWorkflow({ kind: 'adhoc', title: '占坑', status: 'running', meta: { mode: 'nodes' } });
    const occ = w.store.createStep({ workflowId: other.id, seq: 1, kind: 'agent', title: '在跑', input: { session: 'juli-reply' } });
    w.store.setStepStatus(occ.id, 'running');
    w.store.createRun(other.id, 'juli-reply');
    w.store.createRun(other.id, 'juli-reply'); // busy 反查主路走 runs JOIN，占坑必须建 run
    // 新单默认路由 juli-reply → 应改道 juli-dev（同公司空闲，先于 acme）。
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '新单', status: 'running', meta: { mode: 'nodes' } });
    w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '干活', input: { session: 'juli-reply', plan: '别挤' } });
    await w.engine.advance(wf.id);
    expect((w as { dispatchedTo: string[] }).dispatchedTo).toEqual(['juli-dev']);
    const ev = w.store.listEvents(50).find((e) => e.type === 'route_busy_divert');
    expect(ev).toBeDefined();
    expect(ev!.payload['from']).toBe('juli-reply');
    expect(ev!.payload['to']).toBe('juli-dev');
    expect(ev!.payload['by']).toBe('busy_agent');
    expect(w.store.getWorkflow(wf.id)!.session).toBe('juli-dev');
  });

  it('声明 agent 不在 tmux → 跳过；全忙 → 回队等待不挤入，不留改道事件', async () => {
    const w = busyWorld(['juli-reply'], {
      routing: {
        defaultSession: 'juli-reply', defaultProject: 'p',
        agents: [
          { session: 'juli-reply', company: 'juli', domain: 'reply', senders: [], cwd: '' },
          { session: 'juli-dev', company: 'juli', domain: 'dev', senders: [], cwd: '' },
        ],
      },
    }) as ReturnType<typeof makeWorld> & { dispatchedTo: string[] };
    const other = w.store.createWorkflow({ kind: 'adhoc', title: '占坑', status: 'running', meta: { mode: 'nodes' } });
    const occ = w.store.createStep({ workflowId: other.id, seq: 1, kind: 'agent', title: '在跑', input: { session: 'juli-reply' } });
    w.store.setStepStatus(occ.id, 'running');
    w.store.createRun(other.id, 'juli-reply');
    w.store.createRun(other.id, 'juli-reply'); // busy 反查主路走 runs JOIN，占坑必须建 run
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '新单', status: 'running', meta: { mode: 'nodes' } });
    w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '干活', input: { session: 'juli-reply', plan: '排队' } });
    await w.engine.advance(wf.id);
    // 全忙（唯一候选 juli-dev 不在 tmux）→ 回队等待：不派发、无改道事件
    // （2026-10-13 裁定「忙时优先空闲 agent，全忙排队」；旧=原路挤入忙会话
    // ——双落点事故形态，已废除）。
    expect((w as { dispatchedTo: string[] }).dispatchedTo).toEqual([]);
    expect(w.store.getWorkflow(wf.id)!.status).toBe('queued');
    expect(w.store.listEvents(50).some((e) => e.type === 'route_busy_wait')).toBe(true);
    expect(w.store.listEvents(50).some((e) => e.type === 'route_busy_divert')).toBe(false);
  });

  it('停在闸门等批准的会话也算忙（0930 重定义）→ 新单改道空闲声明 agent', async () => {
    const w = busyWorld(['juli-reply', 'acme'], {
      routing: {
        defaultSession: 'juli-reply', defaultProject: 'p',
        agents: [
          { session: 'juli-reply', company: 'juli', domain: 'reply', senders: [], cwd: '' },
          { session: 'acme', company: 'acme', domain: 'feedback', senders: [], cwd: '' },
        ],
      },
    }) as ReturnType<typeof makeWorld> & { dispatchedTo: string[] };
    // 占住 juli-reply：无在跑步——单子 running、步停在 waiting_human（闸门
    // 等人批）。旧谓词（runningAgentStepForSession）判闲，新谓词必须判忙。
    const other = w.store.createWorkflow({ kind: 'adhoc', title: '等批准', status: 'running', meta: { mode: 'nodes' } });
    const occ = w.store.createStep({ workflowId: other.id, seq: 1, kind: 'agent', title: '审', input: { session: 'juli-reply' } });
    w.store.setStepStatus(occ.id, 'waiting_human');
    w.store.setWorkflowSession(other.id, 'juli-reply');
    expect(w.store.runningAgentStepForSession('juli-reply')).toBeNull(); // 旧口径确实闲
    expect(w.store.sessionHasOpenWork('juli-reply')).toBe(true); // 新口径忙
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '新单', status: 'running', meta: { mode: 'nodes' } });
    w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '干活', input: { session: 'juli-reply', plan: '别堆' } });
    await w.engine.advance(wf.id);
    expect((w as { dispatchedTo: string[] }).dispatchedTo).toEqual(['acme']);
    expect(w.store.getWorkflow(wf.id)!.session).toBe('acme');
  });

  it('钉住的落点再忙也不改道（session_pinned——宁可慢不换人，0930 修）', async () => {
    const w = busyWorld(['juli-reply', 'juli-dev'], {
      routing: {
        defaultSession: 'juli-reply', defaultProject: 'p',
        agents: [
          { session: 'juli-reply', company: 'juli', domain: 'reply', senders: [], cwd: '' },
          { session: 'juli-dev', company: 'juli', domain: 'dev', senders: [], cwd: '' },
        ],
      },
    }) as ReturnType<typeof makeWorld> & { dispatchedTo: string[] };
    // 占住 juli-reply（在跑）；新单显式钉 juli-reply（chat 钉住/CLI/渠道规则
    // 播种形态）→ 排队等空闲，绝不换人。
    const other = w.store.createWorkflow({ kind: 'adhoc', title: '占坑', status: 'running', meta: { mode: 'nodes' } });
    const occ = w.store.createStep({ workflowId: other.id, seq: 1, kind: 'agent', title: '在跑', input: { session: 'juli-reply' } });
    w.store.setStepStatus(occ.id, 'running');
    w.store.createRun(other.id, 'juli-reply');
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '钉住单', status: 'running', meta: { mode: 'nodes' } });
    w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '干活', input: { session: 'juli-reply', plan: '排队等', session_pinned: true } });
    await w.engine.advance(wf.id);
    expect((w as { dispatchedTo: string[] }).dispatchedTo).toEqual(['juli-reply']);
    expect(w.store.listEvents(50).some((e) => e.type === 'route_busy_divert')).toBe(false);
    expect(w.store.getWorkflow(wf.id)!.session).toBe('juli-reply');
  });

  it('改道候选跳过 high 档孪生（非必要不高智能，0930 与 routeTaskMenu 对齐）', async () => {
    const w = busyWorld(['juli-reply', 'juli-dev-hi', 'acme'], {
      routing: {
        defaultSession: 'juli-reply', defaultProject: 'p',
        agents: [
          { session: 'juli-reply', company: 'juli', domain: 'reply', senders: [], cwd: '' },
          { session: 'juli-dev-hi', company: 'juli', domain: 'dev', senders: [], cwd: '', model_tier: 'high' as const },
          { session: 'acme', company: 'acme', domain: 'feedback', senders: [], cwd: '' },
        ],
      },
    }) as ReturnType<typeof makeWorld> & { dispatchedTo: string[] };
    const other = w.store.createWorkflow({ kind: 'adhoc', title: '占坑', status: 'running', meta: { mode: 'nodes' } });
    const occ = w.store.createStep({ workflowId: other.id, seq: 1, kind: 'agent', title: '在跑', input: { session: 'juli-reply' } });
    w.store.setStepStatus(occ.id, 'running');
    w.store.createRun(other.id, 'juli-reply');
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '新单', status: 'running', meta: { mode: 'nodes' } });
    w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '干活', input: { session: 'juli-reply', plan: '别上高档' } });
    await w.engine.advance(wf.id);
    // juli-dev-hi 空闲且在 tmux 也不做目标——改道跨公司落 acme。
    expect((w as { dispatchedTo: string[] }).dispatchedTo).toEqual(['acme']);
  });

  it('绑定会话再忙也不改道（隔离纪律）', async () => {
    const w = makeWorld({
      availableSessions: ['project-a', 'project-a-2'],
      routing: {
        defaultSession: 'juli-reply', defaultProject: 'p',
        boundAgents: [{ session: 'project-a', cwd: '~/x', senders: ['a@example.com'] }],
      },
      dispatch: {
        async dispatch(_text: string, session: string) {
          (w as unknown as { dispatchedTo: string[] }).dispatchedTo.push(session);
          return { ok: true, value: undefined } as const;
        },
      },
    } as never) as ReturnType<typeof makeWorld> & { dispatchedTo: string[] };
    (w as unknown as { dispatchedTo: string[] }).dispatchedTo = [];
    const other = w.store.createWorkflow({ kind: 'adhoc', title: '占坑', status: 'running', meta: { mode: 'nodes', session_bound: 'project-a' } });
    const occ = w.store.createStep({ workflowId: other.id, seq: 1, kind: 'agent', title: '在跑', input: { session: 'project-a' } });
    w.store.setStepStatus(occ.id, 'running');
    w.store.createRun(other.id, 'project-a');
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '正道', status: 'running', meta: { mode: 'nodes', session_bound: 'project-a' } });
    w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '排队也进绑定', input: { session: 'project-a', plan: '录一笔' } });
    await w.engine.advance(wf.id);
    expect((w as { dispatchedTo: string[] }).dispatchedTo).toEqual(['project-a']);
  });
});
