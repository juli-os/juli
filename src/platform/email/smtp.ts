// SMTP 回信（对应 Go pipeline/mailer.go）。465 隐式 TLS，587 STARTTLS，
// loopback 免 TLS（测试假 SMTP）。nodemailer 承担线格式；结构性约束
// （收件人只认 meta.from）在引擎层，不在这里。

import nodemailer from 'nodemailer';
import { err, ok, toResult, type Result } from '@juli-os/artifacts';
import type { MailSendCommand, MailerPort } from '../../contracts/ports.ts';

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly from: string;
}

const hostPart = (host: string): string => {
  const h = host.includes(':') && !host.startsWith('[') ? host : host.split(':')[0] ?? host;
  return h;
};

export const createSmtpMailer = (cfg: SmtpConfig): MailerPort | null => {
  if (cfg.host === '') return null; // 未配置 → send 步以明确错误失败，不静默
  const port = cfg.port === 0 ? 587 : cfg.port;
  const host = hostPart(cfg.host);
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port,
    secure: port === 465,
    // loopback（测试假 SMTP）跳过 TLS；587 生产路径 nodemailer 默认 STARTTLS。
    ignoreTLS: host === '127.0.0.1' || host === 'localhost' || host === '::1',
    auth: cfg.username !== '' ? { user: cfg.username, pass: cfg.password } : undefined,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 180_000, // 与引擎 llm/send 步的 180s 预算对齐，慢管道不占死锁链
  });
  return {
    async send(cmd: MailSendCommand): Promise<Result<{ messageId: string }, Error>> {
      if (cfg.from === '') {
        return err(new Error('smtp from not configured'));
      }
      const domain = cfg.from.includes('@') ? cfg.from.slice(cfg.from.lastIndexOf('@') + 1) : cfg.from;
      const messageId = `<juli-${Date.now()}${Math.floor(Math.random() * 1000)}@${domain}>`;
      const res = await toResult(transport.sendMail({
        from: cfg.from,
        to: cmd.to,
        subject: cmd.subject,
        text: cmd.body,
        // 2026-09-14 起携带渲染版：nodemailer 自动装配 multipart/alternative，
        // text 件仍逐字节 = 审批文本（哈希取件不变式）。
        ...(cmd.html !== undefined && cmd.html !== '' ? { html: cmd.html } : {}),
        // 抄送（断点十）：申报单 envelope 声明 → 种子 → send 步 → 这里。
        // bcc 不支持（第 5 轮审查：MailSendCommand 死字段已删，见 ports.ts）。
        ...(cmd.cc !== undefined && cmd.cc.length > 0 ? { cc: [...cmd.cc] } : {}),
        // 交付契约附件：字节直挂（宣称"见附件"必须真附——0913 事故）。
        ...(cmd.attachments !== undefined && cmd.attachments.length > 0 ? {
          attachments: cmd.attachments.map((a) => ({ filename: a.name, content: a.bytes })),
        } : {}),
        // 线程串联：In-Reply-To + References 指向原邮件。
        inReplyTo: cmd.inReplyTo || undefined,
        references: cmd.inReplyTo || undefined,
        messageId,
      }), 'smtp send failed');
      if (!res.ok) return res;
      return ok({ messageId });
    },
  };
};
