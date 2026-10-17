// 对话（Thread）一等建模二期（2026-09-21）契约锁定：
// ①in_reply_to 反查 meta.message_id → 继承老单线程（「回复的回复」链式同线程）；
// ②兜底：归一化主题（回复：/Re:/转发： 混着剥）+ 同发件人 30 天内 → 同线程；
// ③全不命中 → 自立线程根（thread_id = 本单 id），无 thread_matched 事件；
// ④命中①②必留 thread_matched 事件（matched_by / matched_workflow 留因）。

import { describe, expect, it } from 'vitest';
import { createLedgerStore } from '@juli-os/ledger';
import { createEngine, type EngineDeps } from '../src/business/workflow/engine.ts';
import { ok } from '@juli-os/artifacts';
import { makeClock, makeEmail, seqIds } from './helpers.ts';
import type { MailerPort, PusherPort } from '../src/contracts/ports.ts';

const makeWorld = (over: Partial<EngineDeps> = {}) => {
  const { clock, advance } = makeClock();
  const store = createLedgerStore(':memory:', { clock, ids: seqIds() });
  const engine = createEngine({
    store,
    llm: null, model: 't',
    routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
    dispatch: {
      async dispatch() { return ok(undefined); },
    },
    syncDispatch: null,
    pusher: { async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {} } satisfies PusherPort,
    mailer: { async send() { return ok({ messageId: '<x@j>' }); } } satisfies MailerPort,
    captureOutput: async () => null,
    workspaceFor: null,
    availableSessions: ['juli-reply'],
    resolveSession: null,
    interruptSession: null, rebuildAgent: null, zombieFingerprint: null,
    clock, ids: seqIds(),
    templates: {},
    ...over,
  } satisfies EngineDeps);
  return { engine, store, advanceClock: advance };
};

/** 某工作流的 thread_matched 事件（没有 = 空数组）。 */
const matchedEvents = (w: ReturnType<typeof createLedgerStore>, wfId: string) =>
  w.entityEvents('workflow', wfId, 'thread_matched');

describe('Thread 进件匹配①：in_reply_to 因果锚', () => {
  it('回信挂老单线程，matched_by=in_reply_to + matched_workflow 留痕', async () => {
    const w = makeWorld();
    const root = await w.engine.startEmailWorkflow(makeEmail({
      from: 'casey@example.com', subject: 'PPT 制作需求', messageId: '<a@example.com>',
    }));
    expect(root.threadId).toBe(root.id); // 首封 = 自立线程根
    expect(matchedEvents(w.store, root.id)).toHaveLength(0); // 自立根无需因

    const reply = await w.engine.startEmailWorkflow(makeEmail({
      from: 'casey@example.com', subject: '回复：PPT 制作需求',
      messageId: '<b@example.com>', inReplyTo: '<a@example.com>',
    }));
    expect(reply.threadId).toBe(root.id); // 继承老单线程
    const evs = matchedEvents(w.store, reply.id);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload['thread_id']).toBe(root.id);
    expect(evs[0]!.payload['matched_by']).toBe('in_reply_to');
    expect(evs[0]!.payload['matched_workflow']).toBe(root.id);
  });

  it('回复的回复链式继承：C 的 in_reply_to 指向 B，线程仍 = 根 A', async () => {
    const w = makeWorld();
    const a = await w.engine.startEmailWorkflow(makeEmail({ messageId: '<a@example.com>', subject: '需求' }));
    const b = await w.engine.startEmailWorkflow(makeEmail({
      messageId: '<b@example.com>', inReplyTo: '<a@example.com>', subject: '回复：需求',
    }));
    const c = await w.engine.startEmailWorkflow(makeEmail({
      messageId: '<c@example.com>', inReplyTo: '<b@example.com>', subject: '回复：回复：需求',
    }));
    expect(a.threadId).toBe(a.id);
    expect(b.threadId).toBe(a.id);
    expect(c.threadId).toBe(a.id); // B 自己没有根 → B 的线程就是 A；C 经 B 链到 A
    const evs = matchedEvents(w.store, c.id);
    expect(evs[0]!.payload['matched_by']).toBe('in_reply_to');
    expect(evs[0]!.payload['matched_workflow']).toBe(b.id); // 因果锚是 B，线程是 A
  });

  it('in_reply_to 无主（库里没有那封）→ 落主题兜底，不落 in_reply_to', async () => {
    const w = makeWorld();
    const root = await w.engine.startEmailWorkflow(makeEmail({
      from: 'casey@example.com', subject: 'Banner 重做', messageId: '<a@example.com>',
    }));
    const reply = await w.engine.startEmailWorkflow(makeEmail({
      from: 'casey@example.com', subject: 'Re: Banner 重做',
      messageId: '<b@example.com>', inReplyTo: '<missing@example.com>', // 引用的信不在库
    }));
    expect(reply.threadId).toBe(root.id);
    const evs = matchedEvents(w.store, reply.id);
    expect(evs[0]!.payload['matched_by']).toBe('subject'); // 二级兜底接住了
  });
});

describe('Thread 进件匹配②：归一化主题 + 同发件人（30 天窗）', () => {
  it('多语言前缀变体混着来都同线程（回复：/Re:/转发：/嵌套剥）', async () => {
    const w = makeWorld();
    const root = await w.engine.startEmailWorkflow(makeEmail({
      from: 'casey@example.com', subject: 'PPT 制作需求', messageId: '<a@example.com>',
    }));
    const variants = [
      { mid: '<b@example.com>', subject: '回复：PPT 制作需求' },
      { mid: '<c@example.com>', subject: 'Re: PPT 制作需求' },
      { mid: '<d@example.com>', subject: 'RE: PPT 制作需求' },
      { mid: '<e@example.com>', subject: '转发: PPT 制作需求' },
      { mid: '<f@example.com>', subject: '回复：Re: PPT 制作需求' },
    ];
    for (const v of variants) {
      const wf = await w.engine.startEmailWorkflow(makeEmail({
        from: 'casey@example.com', subject: v.subject, messageId: v.mid,
      }));
      expect(wf.threadId, v.subject).toBe(root.id);
      expect(matchedEvents(w.store, wf.id)[0]!.payload['matched_by'], v.subject).toBe('subject');
    }
  });

  it('发件人大小写不敏感；不同发件人同主题 ≠ 同线程', async () => {
    const w = makeWorld();
    const root = await w.engine.startEmailWorkflow(makeEmail({
      from: 'Casey@Example.com', subject: '合同评审', messageId: '<a@example.com>',
    }));
    const same = await w.engine.startEmailWorkflow(makeEmail({
      from: 'casey@example.com', subject: '回复：合同评审', messageId: '<b@example.com>',
    }));
    expect(same.threadId).toBe(root.id);
    const other = await w.engine.startEmailWorkflow(makeEmail({
      from: 'bob@example.com', subject: '回复：合同评审', messageId: '<c@example.com>',
    }));
    expect(other.threadId).toBe(other.id); // 别人的同名信是新事
    expect(matchedEvents(w.store, other.id)).toHaveLength(0);
  });

  it('超 30 天窗口：同主题同发件人也算新事', async () => {
    const w = makeWorld();
    const _root = await w.engine.startEmailWorkflow(makeEmail({
      from: 'casey@example.com', subject: '季度对账', messageId: '<a@example.com>',
    }));
    w.advanceClock(31 * 86_400_000); // 窗外
    const late = await w.engine.startEmailWorkflow(makeEmail({
      from: 'casey@example.com', subject: '回复：季度对账', messageId: '<b@example.com>',
      date: '2026-10-08T08:00:00Z',
    }));
    expect(late.threadId).toBe(late.id);
    expect(matchedEvents(w.store, late.id)).toHaveLength(0);
  });
});

describe('Thread 进件匹配③：全不命中 → 新线程根', () => {
  it('陌生信各自立根，零 thread_matched 事件，thread_id = 本单 id', async () => {
    const w = makeWorld();
    const a = await w.engine.startEmailWorkflow(makeEmail({
      from: 'x@example.com', subject: '事情一', messageId: '<a@example.com>',
    }));
    const b = await w.engine.startEmailWorkflow(makeEmail({
      from: 'y@example.com', subject: '事情二', messageId: '<b@example.com>',
    }));
    expect(a.threadId).toBe(a.id);
    expect(b.threadId).toBe(b.id);
    expect(a.threadId).not.toBe(b.threadId);
    expect(matchedEvents(w.store, a.id)).toHaveLength(0);
    expect(matchedEvents(w.store, b.id)).toHaveLength(0);
    // 全库无 thread_matched 留痕
    expect(w.store.listEvents(100).some((e) => e.type === 'thread_matched')).toBe(false);
  });

  it('主题只剩前缀噪音（如「Re:」）不参与兜底匹配，自立根', async () => {
    const w = makeWorld();
    const root = await w.engine.startEmailWorkflow(makeEmail({
      from: 'casey@example.com', subject: '报价', messageId: '<a@example.com>',
    }));
    const noise = await w.engine.startEmailWorkflow(makeEmail({
      from: 'casey@example.com', subject: 'Re:', messageId: '<b@example.com>',
    }));
    expect(noise.threadId).not.toBe(root.id);
    expect(noise.threadId).toBe(noise.id);
  });
});
