// 收单台（0920 定案）守卫：队列六语义的钉子。
// ①入队即返（创建=queued，不立即跑）②FIFO 串行（并发=1 一次一张）
// ③闸门放队位（停在人工闸门的单不占位，队尾能进）
// ④续走插队头（闸门批准后优先恢复，不重新排队）
// ⑤重启落库（新引擎实例按 created_at 升序重排 queued）
// ⑥dedup 在途含 queued（同信第二封不再建单）。

import { describe, expect, it } from 'vitest';
import { createLedgerStore } from '@juli-os/ledger';
import { createEngine, type EngineDeps } from '../src/business/workflow/engine.ts';
import { makeClock, seqIds, makeEmail } from './helpers.ts';
import { ok } from '@juli-os/artifacts';
import type { MailerPort, PusherPort } from '../src/contracts/ports.ts';

const makeWorld = (over: Partial<EngineDeps> = {}, sharedStore?: ReturnType<typeof createLedgerStore>) => {
  const { clock } = makeClock();
  const store = sharedStore ?? createLedgerStore(':memory:', { clock, ids: seqIds() });
  const engine = createEngine({
    store,
    llm: null,
    model: 't',
    routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
    dispatch: {
      async dispatch() {
        return ok(undefined);
      },
    },
    syncDispatch: null,
    pusher: {
      async gateWaiting() {},
      async workflowDone() {},
      async workflowFailed() {},
    } satisfies PusherPort,
    mailer: { async send() { return ok({ messageId: '<x@j>' }); } } satisfies MailerPort,
    captureOutput: async () => null,
    workspaceFor: null,
    availableSessions: ['juli-reply'],
    resolveSession: null,
    interruptSession: null,
    rebuildAgent: null,
    zombieFingerprint: null,
    clock,
    ids: seqIds(),
    templates: {},
    authz: { mode: 'allowlist', allow: ['*@example.com'], deny: [] },
    ...over,
  } satisfies EngineDeps);
  return { engine, store };
};

const drain = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 10)); };

describe('收单台', () => {
  it('① 入队即返:邮件进件建单=queued+task_queued 事件,派发后转 running', async () => {
    const w = makeWorld();
    void w.engine.onEmailReceived(makeEmail());
    await drain();
    const wf = w.store.listWorkflows(10)[0]!;
    // 派发是同步泵——进件返回后已转 running（并发 1、队首即派）
    expect(wf.status).toBe('running');
    const events = w.store.listEvents(50).map((e) => e.type);
    expect(events).toContain('task_queued');
    expect(events).toContain('task_dispatched');
    // 队列快照:此单正占位
    expect(w.engine.queueStatus().active).toContain(wf.id);
  });

  it('② FIFO 串行:占位单在跑时第二张留 queued(DB 断言),占位结束才进', async () => {
    const w = makeWorld();
    void w.engine.onEmailReceived(makeEmail({ messageId: '<m-1@x>' }));
    await drain();
    const first = w.store.listWorkflows(10)[0]!;
    expect(w.engine.queueStatus().active).toContain(first.id); // 第一张真占位
    void w.engine.onEmailReceived(makeEmail({ messageId: '<m-2@x>' }));
    await drain();
    // review F3:必须钉住第二张的 DB 状态——释放路径烂掉(死槽)时此处会红
    const second = w.store.listWorkflows(10).find((x) => x.id !== first.id)!;
    expect(second.status).toBe('queued');
    expect(w.engine.queueStatus().waiting).toContain(second.id);
  });

  it('③ 闸门放队位(真链):占位单链收尾→evaluateSlot 释放→后续单可派', async () => {
    const w = makeWorld();
    void w.engine.onEmailReceived(makeEmail({ messageId: '<hold@x>' }));
    await drain();
    const hold = w.store.listWorkflows(10)[0]!;
    expect(w.engine.queueStatus().active).toContain(hold.id); // 真占位
    // Stop hook 收尾 → 链 end → evaluateSlot 释放
    await w.engine.onAgentStopped('juli-reply', 'done', '理解完成');
    await drain();
    expect(w.engine.queueStatus().active).not.toContain(hold.id);
    // 占位单卡闸等人=仍占会话（2026-10-13 裁定后：闸门等待中的会话算忙，
    // 下张同会话单排队不放行）；收口让 juli-reply 空出再验「释放后可派」。
    await w.engine.forceClose(hold.id, 'test', 'test');
    await drain();
    // 释放后新单立即可派
    void w.engine.onEmailReceived(makeEmail({ messageId: '<next@x>' }));
    await drain();
    const next = w.store.listWorkflows(10).find((x) => x.id !== hold.id)!;
    expect(next.status).toBe('running');
  });

  it('⑤ 重启落库:queued 行按 created_at 升序重排(先到先跑)', async () => {
    const w = makeWorld();
    // 每张单播种一个 pending 首步(裸单会被零步骤守卫打成 failed——那是另一个守卫的活)
    const seed = (title: string): { id: string } => {
      const wf = w.store.createWorkflow({ kind: 'adhoc', title, status: 'queued' });
      w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '首步', input: { plan: `做${title}`, session: 'juli-reply' } });
      return { id: wf.id };
    };
    const a = seed('A');
    const b = seed('B');
    const c = seed('C');
    // 新引擎实例 = 「重启」:queued 按到达序回队,并发 1 → A 先派
    const w2 = makeWorld({ queueConcurrency: 1 }, w.store);
    await drain();
    const aWf = w2.store.getWorkflow(a.id)!;
    if (aWf.status === 'failed') {
      const ev = w2.store.listEvents(50).find((e) => e.entityId === a.id && (e.type === 'workflow_failed' || e.type === 'step_failed'));
      throw new Error(`A 变 failed: ${JSON.stringify(ev?.payload ?? 'no-event')}`);
    }
    expect(aWf.status).toBe('running');
    expect(w2.store.getWorkflow(b.id)!.status).toBe('queued');
    expect(w2.store.getWorkflow(c.id)!.status).toBe('queued');
    expect(w2.engine.queueStatus().waiting).toEqual([b.id, c.id]);
  });

  it('⑥ dedup 在途含 queued:首封在队里,同信第二封静默跳过', async () => {
    const w = makeWorld({ queueConcurrency: 1 });
    // 两封同信:dedup_key 相同
    void w.engine.onEmailReceived(makeEmail({ messageId: '<same@x>', uid: 1 }));
    void w.engine.onEmailReceived(makeEmail({ messageId: '<same@x>', uid: 2 }));
    await drain();
    const mails = w.store.listWorkflows(10).filter((x) => x.kind === 'email');
    expect(mails).toHaveLength(1);
  });

  it('⑦ 人工收口的单不被派发:cancel 后的 queued 行不再跑', async () => {
    const w1 = makeWorld();
    const wf = w1.store.createWorkflow({ kind: 'adhoc', title: '将被取消', status: 'queued' });
    w1.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '首步' });
    // 人工收口为 cancelled → 重启扫描/pump 均不派
    w1.store.setWorkflowStatus(wf.id, 'cancelled');
    const w2 = makeWorld({}, w1.store);
    await drain();
    expect(w2.store.getWorkflow(wf.id)!.status).toBe('cancelled');
    expect(w2.engine.queueStatus().active).not.toContain(wf.id);
  });

  it('④ 续走插队头:闸门批准时槽被占→单挂队头;槽释放后被先派(review F3)', async () => {
    const w = makeWorld();
    // 占位单(真占槽)
    void w.engine.onEmailReceived(makeEmail({ messageId: '<busy@x>' }));
    await drain();
    const busy = w.store.listWorkflows(10)[0]!;
    expect(w.engine.queueStatus().active).toContain(busy.id);
    // 闸门单(running、停在人工闸门——不占位)+ 队尾单
    const gateWf = w.store.createWorkflow({
      kind: 'email', status: 'running', title: '停在闸门', meta: { mode: 'nodes' },
    });
    w.store.createStep({ workflowId: gateWf.id, seq: 1, kind: 'gate', title: '发送决定' });
    const gateStep = w.store.stepsForWorkflow(gateWf.id)[0]!;
    w.store.setStepStatus(gateStep.id, 'waiting_human');
    void w.engine.onEmailReceived(makeEmail({ messageId: '<tail@x>' }));
    await drain();
    const tail = w.store.listWorkflows(10).find((x) => x.id !== busy.id && x.id !== gateWf.id)!;
    expect(tail.status).toBe('queued');
    // 批准 → continueWorkflow → 插队头(在 tail 之前)
    await w.engine.approve(gateStep.id, '批', 'tester');
    expect(w.engine.queueStatus().waiting.indexOf(gateWf.id)).toBeGreaterThanOrEqual(0);
    expect(w.engine.queueStatus().waiting.indexOf(gateWf.id))
      .toBeLessThan(w.engine.queueStatus().waiting.indexOf(tail.id));
    // 占位释放 → 队头(闸门单)先被泵走,tail 仍 queued
    await w.engine.onAgentStopped('juli-reply', 'done', '理解完成');
    await drain();
    expect(w.engine.queueStatus().active).not.toContain(busy.id);
    expect(tail.status).toBe('queued');
  });

  it('⑧ F1 回归:中止占位单必须放位,队尾单立即被派(死槽守卫)', async () => {
    const w = makeWorld();
    void w.engine.onEmailReceived(makeEmail({ messageId: '<victim@x>' }));
    await drain();
    const victim = w.store.listWorkflows(10)[0]!;
    expect(w.engine.queueStatus().active).toContain(victim.id);
    void w.engine.onEmailReceived(makeEmail({ messageId: '<behind@x>' }));
    await drain();
    const behind = w.store.listWorkflows(10).find((x) => x.id !== victim.id)!;
    expect(behind.status).toBe('queued');
    // 占位中被人工中止 → 槽位必须立刻释放并泵下一张;否则并发1全队卡死
    await w.engine.forceClose(victim.id, '不做了', 'tester');
    await drain();
    expect(w.store.getWorkflow(victim.id)!.status).toBe('cancelled');
    expect(w.engine.queueStatus().active).not.toContain(victim.id);
    expect(w.store.getWorkflow(behind.id)!.status).toBe('running');
  });

  it('⑨ F2:queued 单可整单中止移出队列;逐段取消被拒', async () => {
    const w = makeWorld();
    // 占住槽
    void w.engine.onEmailReceived(makeEmail({ messageId: '<slot@x>' }));
    await drain();
    // 排队单(带 pending 步)
    void w.engine.onEmailReceived(makeEmail({ messageId: '<q@x>' }));
    await drain();
    const q = w.store.listWorkflows(10).find((x) => x.meta['message_id'] === '<q@x>')!;
    expect(q.status).toBe('queued');
    const qStep = w.store.stepsForWorkflow(q.id)[0]!;
    // 逐段取消 → 拒(排队单的唯一干预是整单移出)
    await expect(w.engine.cancelStep(qStep.id, '试', 'tester')).rejects.toThrow(/force-close/);
    // 整单中止 → cancelled 且出队
    await w.engine.forceClose(q.id, '移出队列', 'tester');
    await drain();
    expect(w.store.getWorkflow(q.id)!.status).toBe('cancelled');
    expect(w.engine.queueStatus().waiting).not.toContain(q.id);
    expect(w.engine.queueStatus().active).not.toContain(q.id);
  });
});
