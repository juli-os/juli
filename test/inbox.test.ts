// 入站邮件契约测试：MIME 解析（正文兜底链/附件上限/无 Message-ID 身份）、
// 去重中间件、宽松兜底。

import { describe, expect, it } from 'vitest';
import {
  inboxDedupKey, parseFullMessage, withDedupe, type InboxMessage,
} from '../src/platform/email/inbox.ts';

const rawMail = (_over: Record<string, string> = {}, body = '正文内容'): Buffer =>
  Buffer.from(
    [
      `From: Boss <boss@example.com>`,
      `To: juli@example.com`,
      `Subject: =?UTF-8?B?${Buffer.from('季度数据求助').toString('base64')}?=`,
      `Date: Mon, 7 Sep 2026 08:00:00 +0000`,
      `Message-ID: <m-1@example.com>`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=UTF-8`,
      ``,
      body,
    ].join('\r\n'),
    'utf8',
  );

describe('parseFullMessage', () => {
  it('解析出头事实与正文（RFC 2047 主题解码）', async () => {
    const res = await parseFullMessage(rawMail());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.from).toBe('boss@example.com');
    expect(res.value.subject).toBe('季度数据求助');
    expect(res.value.messageId).toBe('<m-1@example.com>');
    expect(res.value.body).toContain('正文内容');
  });

  it('text/html 邮件回退到剥标签正文；multipart/alternative 取 plain', async () => {
    const html = Buffer.from(
      [
        `From: a@b.com`, `Subject: html`, `MIME-Version: 1.0`,
        `Content-Type: multipart/alternative; boundary=xy`,
        ``, `--xy`, `Content-Type: text/plain`, ``, `纯文本正文`, `--xy`,
        `Content-Type: text/html`, ``, `<p>HTML <b>正文</b></p>`, `--xy--`,
      ].join('\r\n'),
    );
    const res = await parseFullMessage(html);
    if (!res.ok) throw res.error;
    expect(res.value.body).toBe('纯文本正文');
  });

  it('无 Message-ID 的邮件给出稳定的 nosuchid- 身份', async () => {
    const noId = Buffer.from(
      ['From: x@y.com', 'Subject: s', 'Date: Mon, 7 Sep 2026 08:00:00 +0000', '', 'b'].join('\r\n'),
    );
    const res = await parseFullMessage(noId);
    if (!res.ok) throw res.error;
    expect(res.value.messageId).toBe('');
    const key = inboxDedupKey(res.value);
    expect(key.startsWith('nosuchid-')).toBe(true);
    expect(inboxDedupKey(res.value)).toBe(key);
  });

  it('畸形 MIME 走宽松兜底，不丢邮件', async () => {
    const res = await parseFullMessage(Buffer.from('From: x@y.com\r\nSubject: broken\r\n\r\nhello'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.body).toContain('hello');
  });
});

describe('inboxDedupKey / withDedupe', () => {
  const msg = (over: Partial<InboxMessage> = {}): InboxMessage => ({
    uid: 1, from: 'a@b.com', subject: 's', date: '2026-09-07T00:00:00Z',
    body: 'b', messageId: '<id-1>', attachments: [], ...over,
  });

  it('Message-ID 相同 = 同一身份；不同 ID = 不同身份', () => {
    expect(inboxDedupKey(msg())).toBe('<id-1>');
    expect(inboxDedupKey(msg({ messageId: '<id-2>' }))).not.toBe(inboxDedupKey(msg()));
  });

  it('withDedupe：已见跳过，未见放行，探针故障放行（链会再探）', async () => {
    const seen: string[] = [];
    const delivered: InboxMessage[] = [];
    const probe = async (key: string): Promise<boolean> => {
      if (key === 'boom') throw new Error('ledger down');
      return seen.includes(key);
    };
    const chain = withDedupe(probe, async (m) => { delivered.push(m); });
    await chain(msg());
    expect(delivered.length).toBe(1);
    seen.push('<id-1>');
    await chain(msg());
    expect(delivered.length).toBe(1); // 二次投递被去重门挡下
    await chain(msg({ messageId: 'boom' }));
    expect(delivered.length).toBe(2); // 探针故障 → 放行
  });
});
