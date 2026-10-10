// IMAP 传输策略（对应 Go inbox/imap.go → imapflow 实现）。每轮轮询新建
// 连接是刻意的：长连 IMAP 会静默断（重连不是浪费，是自愈）。"处理与否"
// 不是邮件服务器的业务——账本去重说了算；\Seen 只是人心侧的视觉提示，
// 在完整摄取一轮之后才打。

import { ImapFlow, type FetchMessageObject, type MailboxLockObject } from 'imapflow';
import { err, ok, toResult, type Result } from '@juli-os/artifacts';
import { decodeRfc2047, parseFullMessage, type InboxMessage } from './inbox.ts';

export interface ImapParams {
  /** imaps://host:993、imap://host:port（明文，本地/测试）、或裸 host:port（TLS） */
  readonly host: string;
  readonly username: string;
  readonly mailbox: string; // '' → INBOX
  readonly timeoutMs?: number;
}

interface EnvelopeItem {
  readonly uid: number;
  readonly from: string;
  readonly fromName?: string;
  readonly subject: string;
  readonly date: string;
  readonly messageId: string;
}

export interface ImapTransport {
  /** 轻量信封全列（阶段一）：全邮箱每轮可跑，不触碰服务器的 fetch 限制。 */
  listEnvelopes(): Promise<Result<readonly EnvelopeItem[], Error>>;
  /** UID FETCH 全量 RFC 822（阶段二，UID 稳定对抗轮询中的序号漂移）。 */
  fetchBodies(uids: readonly number[]): Promise<Result<readonly InboxMessage[], Error>>;
  /** 已摄取消息的 \Seen 视觉提示；失败只记日志，正确性在账本。 */
  markProcessed(uids: readonly number[]): Promise<void>;
  close(): Promise<void>;
}

const connect = (p: ImapParams, password: string): ImapFlow => {
  const plain = p.host.startsWith('imap://');
  const bare = p.host.replace(/^imaps?:\/\//, '');
  const host = bare.split(':')[0] ?? bare;
  const portFromUrl = bare.includes(':') ? Number(bare.split(':')[1]) : undefined;
  return new ImapFlow({
    host,
    port: portFromUrl ?? (plain ? 143 : 993),
    secure: !plain,
    auth: { user: p.username, pass: password },
    maxIdleTime: p.timeoutMs ?? 30_000,
    logger: false,
  });
};

const envelopeOf = (m: FetchMessageObject): EnvelopeItem => ({
  uid: m.uid,
  from: m.envelope?.from?.[0]?.address ?? '',
  fromName: decodeRfc2047(m.envelope?.from?.[0]?.name ?? ''),
  subject: m.envelope?.subject ?? '',
  date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : '',
  messageId: (m.envelope?.messageId ?? '').trim(),
});

export const dialImap = async (p: ImapParams, password: string): Promise<Result<ImapTransport, Error>> => {
  if (p.host === '') return err(new Error('imap: host not configured'));
  const conn = connect(p, password);
  let lock: MailboxLockObject | null = null;
  const connected = await toResult((async () => {
    await conn.connect();
    const mailbox = p.mailbox === '' ? 'INBOX' : p.mailbox;
    lock = await conn.getMailboxLock(mailbox);
    return true;
  })(), 'imap: connect failed');
  if (!connected.ok) {
    void conn.logout().catch(() => undefined);
    return err(connected.error);
  }

  return ok({
    async listEnvelopes() {
      return toResult((async () => {
        const found = await conn.search({ all: true }, { uid: true });
        const uids = Array.isArray(found) ? found : [];
        const out: EnvelopeItem[] = [];
        if (uids.length > 0) {
          const seq = uids.join(',');
          for await (const m of conn.fetch(seq, { uid: true, envelope: true }, { uid: true })) {
            out.push(envelopeOf(m));
          }
        }
        return out;
      })(), 'imap: list envelopes failed');
    },

    async fetchBodies(uids) {
      if (uids.length === 0) return ok([]);
      return toResult((async () => {
        const seq = uids.join(',');
        const out: InboxMessage[] = [];
        for await (const m of conn.fetch(
          seq, { uid: true, envelope: true, source: true }, { uid: true },
        )) {
          const base = envelopeOf(m);
          const source = m.source ?? Buffer.alloc(0);
          if (source.length === 0) {
            out.push({ ...base, body: '', attachments: [] });
            continue;
          }
          // 50MB 封顶：超大的邮件不值这个内存（ sane 的由附件上限管）。
          const capped = source.length > 50 << 20 ? source.subarray(0, 50 << 20) : source;
          const parsed = await parseFullMessage(capped);
          if (parsed.ok) {
            // 正文头是权威：部分服务器 ENVELOPE 是 NIL，回信线程依赖它。
            out.push({
              uid: m.uid,
              from: parsed.value.from !== '' ? parsed.value.from : base.from,
              fromName: parsed.value.fromName ?? base.fromName,
              subject: parsed.value.subject !== '' ? parsed.value.subject : base.subject,
              date: parsed.value.date !== '' ? parsed.value.date : base.date,
              messageId: parsed.value.messageId !== '' ? parsed.value.messageId : base.messageId,
              body: parsed.value.body,
              attachments: parsed.value.attachments,
              inReplyTo: parsed.value.inReplyTo,
              references: parsed.value.references,
              raw: capped,
            });
          } else {
            out.push({ ...base, body: '', attachments: [] });
          }
        }
        return out;
      })(), 'imap: fetch bodies failed');
    },

    async markProcessed(uids) {
      if (uids.length === 0) return;
      try {
        await conn.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true });
      } catch (e) {
        console.error(`[inbox] mark processed: ${String(e)}`);
      }
    },

    async close() {
      try {
        lock?.release();
      } catch { /* 已释放的锁无害 */ }
      try {
        await conn.logout();
      } catch {
        void conn.close();
      }
    },
  });
};
