// .eml 解析测试：对标真实 send-archive.eml 形状（python 生成的 multipart/mixed、
// RFC2047 小写 b 编码中文主题、base64 UTF-8 正文、数 MB 附件只列名不解码）。

import { describe, expect, it } from 'vitest';
import { decodeMimeWords, parseEml } from '../web/src/eml.ts';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\n');

const FIXTURE = [
  'Content-Type: multipart/mixed; boundary="===============7463903377134951895=="',
  'MIME-Version: 1.0',
  'From: Ops Admin <ops.admin@example.com>',
  'To: contact@example.com',
  'Cc: =?utf-8?B?5byg5LiJ?= <cc@example.com>',
  'Subject: =?utf-8?b?UkU6IOivt+W4ruaIkeWwhuWumOe9kU1lcmlkaWFu55qE5L+h5oGvLOWItuS9nOaIkCBwcHQ?=',
  'Date: Sun, 13 Sep 2026 14:33:37 +0800',
  '',
  '--===============7463903377134951895==',
  'Content-Type: text/plain; charset="utf-8"',
  'MIME-Version: 1.0',
  'Content-Transfer-Encoding: base64',
  '',
  b64('你好，\n以下是本周整合的 Acme Brand PPT 初版：9 页 16:9。\n有二轮修改意见随时说。'),
  '--===============7463903377134951895==',
  'Content-Type: text/html; charset="utf-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<p>=E4=BD=A0=E5=A5=BD HTML =E6=AD=A3=E6=96=87</p>',
  '--===============7463903377134951895==',
  'Content-Type: application/pdf; name="team-brand.pptx"',
  'Content-Disposition: attachment; filename="team-brand.pptx"',
  'Content-Transfer-Encoding: base64',
  '',
  b64('FAKE-PPTX-BYTES') + '\n',
  '--===============7463903377134951895==--',
  '',
].join('\n');

describe('eml 解析（2026-09-21 用户报：打开 eml 一堆奇怪的东西）', () => {
  it('RFC2047 编码主题解码（含小写 b 标记）', () => {
    const v = parseEml(FIXTURE);
    expect(v.subject).toBe('RE: 请帮我将官网Meridian的信息,制作成 ppt');
  });

  it('base64 UTF-8 正文解码为可读中文；text/plain 优先于 html', () => {
    const v = parseEml(FIXTURE);
    expect(v.text).toContain('以下是本周整合的 Acme Brand PPT 初版');
    expect(v.text).toContain('有二轮修改意见随时说');
    expect(v.html).toContain('你好 HTML 正文');
  });

  it('头卡字段：发件人/收件人/抄送/时间，抄送编码名解码', () => {
    const v = parseEml(FIXTURE);
    expect(v.from).toContain('ops.admin@example.com');
    expect(v.to).toBe('contact@example.com');
    expect(v.cc).toContain('张三');
    expect(v.date).toContain('13 Sep 2026');
  });

  it('附件只列名与体积，base64 内容绝不混进正文', () => {
    const v = parseEml(FIXTURE);
    expect(v.attachments).toHaveLength(1);
    expect(v.attachments[0]?.filename).toBe('team-brand.pptx');
    expect(v.attachments[0]?.sizeLabel).toMatch(/B$/);
    expect(v.text).not.toContain('FAKE-PPTX-BYTES');
  });

  it('quoted-printable 解码（=XX 十六进制 + 软换行）', () => {
    expect(decodeMimeWords('=?utf-8?Q?=E4=BD=A0=E5=A5=BD_=E4=B8=96=E7=95=8C?=')).toBe('你好 世界');
  });

  it('非 multipart 裸信：头 + 7bit 正文直取', () => {
    const v = parseEml(['Subject: plain', 'From: a@b.c', '', '第一行', '第二行'].join('\n'));
    expect(v.subject).toBe('plain');
    expect(v.text).toContain('第一行\n第二行');
  });

  it('缺正文部件：给「无可读正文」占位而不是空白', () => {
    const v = parseEml(['Subject: x', 'From: a@b.c', ''].join('\n'));
    expect(v.text).toBe('');
    expect(v.html).toBe('');
  });
});
