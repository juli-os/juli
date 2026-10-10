// 轮询源处置语义（2026-09-21 自回环洪水收口）：\Seen 打给每一封过了处理链
// 的信——摄取的与被丢弃的（账本去重再探命中）都算「过了手」；只有处理链
// 抛错的不标，留给下轮重试。正常摄取路径行为不变（回归锚）。

import { describe, expect, it } from 'vitest';
import { createMailSource } from '../src/platform/email/source.ts';
import type { ImapTransport } from '../src/platform/email/imap.ts';
import type { InboxMessage } from '../src/platform/email/inbox.ts';
import { ok } from '../src/platform/shared/result.ts';

interface Env {
  readonly uid: number;
  readonly messageId: string;
}

const msg = (uid: number, messageId: string): InboxMessage => ({
  uid, from: 'c@example.com', subject: `s-${uid}`, date: '2026-09-21T00:00:00Z',
  body: 'b', messageId, attachments: [],
});

interface Harness {
  readonly pollOnce: () => Promise<void>;
  /** markProcessed 收到的每批 uid（fake IMAP 的断言面）。 */
  readonly marked: number[][];
  readonly ingested: string[];
}

const build = (opts: {
  readonly envelopes: readonly Env[];
  /** 账本已摄取键（阶段一与 withDedupe 共用同一探针——与生产接线一致）。 */
  readonly seenKeys?: Set<string>;
  /** 摄取出口；缺省记录 message_id（= 摄取成功）。 */
  readonly onMessage?: (m: InboxMessage, seen: Set<string>) => Promise<void>;
}): Harness => {
  const seen = opts.seenKeys ?? new Set<string>();
  const marked: number[][] = [];
  const ingested: string[] = [];
  const transport: ImapTransport = {
    async listEnvelopes() {
      return ok(opts.envelopes.map((e) => ({
        uid: e.uid, from: 'c@example.com', subject: `s-${e.uid}`,
        date: '2026-09-21T00:00:00Z', messageId: e.messageId,
      })));
    },
    async fetchBodies(uids) {
      return ok(uids.map((uid) => {
        const mid = opts.envelopes.find((e) => e.uid === uid)?.messageId ?? '';
        return msg(uid, mid);
      }));
    },
    async markProcessed(uids) { marked.push([...uids]); },
    async close() {},
  };
  const source = createMailSource({
    params: { host: 'imap.test:993', username: 'u', mailbox: '' },
    password: 'p',
    dial: async () => ok(transport),
    ledgerSeen: async (key) => seen.has(key),
    channelAuthz: { mode: 'open', allow: [], deny: [] },
    onMessage: opts.onMessage
      ? (m) => opts.onMessage!(m, seen)
      : async (m) => { ingested.push(m.messageId); seen.add(m.messageId); },
    log: () => undefined,
  });
  return { pollOnce: source.pollOnce, marked, ingested };
};

describe('createMailSource 的 \\Seen 处置（2026-09-21 洪水收口）', () => {
  it('正常摄取路径不变：两封新信都拉、都摄取、都标 \\Seen（一次批量）', async () => {
    const h = build({
      envelopes: [
        { uid: 11, messageId: '<a@x>' },
        { uid: 12, messageId: '<b@x>' },
      ],
    });
    await h.pollOnce();
    expect(h.ingested).toEqual(['<a@x>', '<b@x>']);
    expect(h.marked).toEqual([[11, 12]]);
  });

  it('同批重复信：第二封被账本去重丢弃（不摄取）也必须标 \\Seen', async () => {
    const ingestedIds: string[] = [];
    const h = build({
      envelopes: [
        { uid: 11, messageId: '<dup@x>' },
        { uid: 12, messageId: '<dup@x>' },
      ],
      // 状态化账本：首封摄取落账后，同 key 即判已_seen（模拟摄取建单）。
      onMessage: async (m, seen) => {
        ingestedIds.push(`${m.uid}:${m.messageId}`);
        seen.add(m.messageId);
      },
    });
    await h.pollOnce();
    expect(ingestedIds).toEqual(['11:<dup@x>']); // 只有首封过了摄取口
    expect(h.marked).toEqual([[11, 12]]); // 丢弃的 uid=12 也标了
  });

  it('处理链抛错：不标 \\Seen（留给下轮重试），也不拖垮同批其余信', async () => {
    const h = build({
      envelopes: [
        { uid: 11, messageId: '<boom@x>' },
        { uid: 12, messageId: '<ok@x>' },
      ],
      onMessage: async (m) => {
        if (m.messageId === '<boom@x>') throw new Error('engine down');
      },
    });
    await h.pollOnce();
    expect(h.marked).toEqual([[12]]); // 抛错的不标，好信照标
    expect(h.ingested).toEqual([]);
  });
});
