// 入站邮件（对应 Go internal/channel/inbox 的 message.go + handler.go）：
// Message 身份 + RFC 822 解析 + 去重中间件。纯函数为主，传输无关。

import { createHash } from 'node:crypto';
import { simpleParser, type ParsedMail } from 'mailparser';
import { ok, toResult, type Result } from '../shared/result.ts';

export const MAX_ATTACHMENT_BYTES = 25 << 20; // 超限附件保留身份（名字/大小）不留字节
export const MAX_SOURCE_BYTES = 50 << 20; // 整封邮件的读取上限

export interface Attachment {
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly content?: Buffer;
  readonly tooLarge: boolean;
}

/** 入站邮件：任何能产出 RFC 5322 的来源都映射到它（handler/轮询与传输解耦）。 */
export interface InboxMessage {
  readonly uid: number;
  readonly from: string;
  /** 发件人显示名（RFC2047 已解码）；信封/宽松路径缺失时空串。 */
  readonly fromName?: string;
  readonly subject: string;
  readonly date: string; // RFC3339
  readonly body: string;
  readonly messageId: string;
  readonly attachments: readonly Attachment[];
  /** 线程链:解析自 In-Reply-To / References——run 之间因果关系的锚。 */
  readonly inReplyTo?: string;
  readonly references?: string;
  /** 原始 RFC 822(intake 归档 bucket 用;信封路径可缺)。 */
  readonly raw?: Buffer;
}

/**
 * 去重身份：RFC 5322 Message-ID 优先，缺省用 nosuchid- 前缀的稳定哈希
 * （有服务器发无 Message-ID 邮件，且每连接 \Seen 状态会无限重投同一封——
 * 这个守卫就是为那场洪水而生的）。
 */
export const inboxDedupKey = (m: InboxMessage): string => {
  if (m.messageId !== '') return m.messageId;
  const sum = createHash('sha1').update(`${m.from}|${m.subject}|${m.date}`).digest('hex');
  return `nosuchid-${sum.slice(0, 8)}`;
};

/** RFC 822 全量解析：首个 text/plain 是正文，text/html 兜底，文件部件进
 * 附件（超限保留身份不留字节）。malformed 的兜底走宽松头解析。 */
export const parseFullMessage = async (raw: Buffer): Promise<Result<InboxMessage, Error>> => {
  const res = await toResult(parseWithMailparser(raw), 'mime parse failed');
  if (res.ok) return res;
  return parseLenient(raw);
};

const decodeAddress = (parsed: ParsedMail): string => {
  const first = parsed.from?.value?.[0];
  return typeof first?.address === 'string' ? first.address : '';
};

/** RFC 2047 encoded-word 解码（=?charset?B|Q?...?= 连缀）：mailparser 主路已
 * 解好；信封（imapflow envelope 原样返回编码头）与宽松兜底路径用它补齐
 * 发件人显示名——「陈义芳」不该在摄取层变成乱码被丢掉（陈莉君事故根因）。 */
export const decodeRfc2047 = (raw: string): string => {
  if (!raw.includes('=?')) return raw.trim();
  return raw.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, _cs: string, enc: string, data: string) => {
    try {
      if (enc.toUpperCase() === 'B') return Buffer.from(data, 'base64').toString('utf8');
      return decodeURIComponent(data.replace(/=/g, '%').replace(/%2C/gi, ',').replace(/_/g, ' '));
    } catch {
      return '';
    }
  }).replace(/\s+/g, ' ').trim();
};

const parseWithMailparser = async (raw: Buffer): Promise<InboxMessage> => {
  const parsed = await simpleParser(raw);
  const attachments: Attachment[] = (parsed.attachments ?? []).map((a) => ({
    filename: a.filename || 'attachment',
    mime: a.contentType || 'application/octet-stream',
    size: a.size ?? a.content?.length ?? 0,
    content: (a.size ?? 0) > MAX_ATTACHMENT_BYTES ? undefined : a.content,
    tooLarge: (a.size ?? 0) > MAX_ATTACHMENT_BYTES,
  }));
  const date = parsed.date ?? new Date(0);
  const headerOf = (name: string): string => {
    const v = parsed.headers.get(name);
    if (typeof v === 'string') return v.trim();
    if (v === undefined || v === null || typeof v === 'boolean') return '';
    return String(v).trim();
  };
  const text = (parsed.text ?? '').trim();
  // 正文兜底链：text/plain → 剥标签的 text/html → 空。
  const body = text !== '' ? text : stripHtml(typeof parsed.html === 'string' ? parsed.html : '');
  const firstFrom = parsed.from?.value?.[0];
  return {
    uid: 0, // UID 由传输层（imapflow fetch）回填
    from: decodeAddress(parsed),
    fromName: typeof firstFrom?.name === 'string' && firstFrom.name !== '' ? firstFrom.name : undefined,
    subject: parsed.subject ?? '',
    inReplyTo: headerOf('in-reply-to'),
    references: headerOf('references'),
    date: date.getTime() === 0 ? '' : date.toISOString(),
    body,
    messageId: (parsed.messageId ?? '').trim(),
    attachments,
  };
};

const stripHtml = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();

/** 宽松兜底：只要头事实与体文本，不提附件（对齐 Go parseLenient）。 */
const parseLenient = async (raw: Buffer): Promise<Result<InboxMessage, Error>> =>
  toResult((async () => {
    const text = raw.toString('utf8');
    const sep = text.indexOf('\r\n\r\n');
    const head = sep >= 0 ? text.slice(0, sep) : text;
    const header = (name: string): string => {
      const m = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(head);
      return m?.[1]?.trim() ?? '';
    };
    const body = sep >= 0 ? text.slice(sep + 4) : '';
    const dateRaw = header('Date');
    const d = dateRaw !== '' ? new Date(dateRaw) : new Date(0);
    const fromRaw = header('From');
    const lenientName = fromRaw.includes('<')
      ? decodeRfc2047(fromRaw.slice(0, fromRaw.indexOf('<')))
      : '';
    return {
      uid: 0,
      from: fromRaw.replace(/^.*</, '').replace(/>.*$/, '').trim(),
      fromName: lenientName !== '' ? lenientName : undefined,
      subject: header('Subject'),
      date: Number.isNaN(d.getTime()) ? '' : d.toISOString(),
      body: body.trim(),
      messageId: header('Message-ID'),
      attachments: [],
    };
  })(), 'lenient parse failed');

// ---- 处理链（FP 组合子，对齐 Go handler.go）----------------------------------

export type MessageHandler = (m: InboxMessage) => Promise<void>;

/** 去重门：probe(key) 回 true = 已见过 → 跳过。探针故障按未见过放行
 * （对齐 Go 的 errs-open：链尾还会再探，绝不因账本抖动丢邮件）。 */
export const withDedupe = (
  probe: (key: string) => Promise<boolean>,
  next: MessageHandler,
): MessageHandler =>
  async (m) => {
    let seen = false;
    try {
      seen = await probe(inboxDedupKey(m));
    } catch (e) {
      console.error(`[inbox] dedup probe 失败（放行）: ${String(e)}`);
    }
    if (seen) return;
    await next(m);
  };
