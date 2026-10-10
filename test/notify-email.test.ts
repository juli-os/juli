// 邮件通知通道（push/email.ts）：五事件全量进邮箱、收件人热改现读、
// 深链拼装、无收件人静默跳过、mailer 失败自捕获不阻塞引擎；
// combinePushers 双通道组合（fire-and-forget，0917 P1-2）。

import { describe, expect, it } from 'vitest';
import { createEmailNotifier, combinePushers, SUBJECT_MAX, BODY_MAX } from '../src/platform/push/email.ts';
import type { MailerPort, MailSendCommand, PusherPort } from '../src/contracts/ports.ts';
import type { Result } from '../src/platform/shared/result.ts';
import { ok } from '../src/platform/shared/result.ts';
import type { Step, Workflow } from '../src/contracts/entities.ts';

const wf = (id: string, title: string): Workflow => ({ id, title } as unknown as Workflow);
const st = (title: string): Step => ({ id: `st-${title}`, title } as unknown as Step);

interface Sent extends MailSendCommand { /* 记录形态即命令本身 */ }

const recorder = (fail = false): { mailer: MailerPort; sent: Sent[] } => {
  const sent: Sent[] = [];
  const mailer: MailerPort = {
    async send(cmd: MailSendCommand): Promise<Result<{ messageId: string }, Error>> {
      sent.push(cmd);
      if (fail) throw new Error('smtp down');
      return ok({ messageId: '<m@x>"' });
    },
  };
  return { mailer, sent };
};

const deps = (over: Partial<Parameters<typeof createEmailNotifier>[0]> = {}) => {
  const rec = recorder();
  const state = { to: ['boss@example.com'] as readonly string[], cc: [] as readonly string[] };
  const notifier = createEmailNotifier({
    mailer: rec.mailer,
    baseUrl: 'http://192.168.1.10:7170/',
    recipients: () => ({ to: state.to, cc: state.cc }),
    ...over,
  });
  return { notifier, rec, state };
};

describe('createEmailNotifier', () => {
  it('五事件全量进邮箱：主题带事件名，正文带单名+摘要，深链指到 lifecycle', async () => {
    const { notifier, rec } = deps();
    await notifier.gateWaiting(wf('wf-1', 'Meridian答 Casey'), st('发送闸门'), '等批准');
    await notifier.workflowDone(wf('wf-1', 'Meridian答 Casey'), '回信已发出');
    await notifier.workflowFailed(wf('wf-2', 'PPT 制作'), '零步骤');
    await notifier.chainDangling?.(wf('wf-3', 'banner'), '链尾悬空');
    await notifier.stepFailed?.(wf('wf-4', '报价'), st('生成初稿'), '渲染失败');

    expect(rec.sent.map((s) => s.subject)).toEqual([
      '[juli] 待审批：发送闸门',
      '[juli] 业务流完成：Meridian答 Casey',
      '[juli] 流水失败：PPT 制作',
      '[juli] 链尾悬空：banner',
      '[juli] 步骤失败：生成初稿',
    ]);
    expect(rec.sent[0]!.body).toContain('单：Meridian答 Casey');
    expect(rec.sent[0]!.body).toContain('等批准');
    expect(rec.sent[0]!.body).toContain('http://192.168.1.10:7170/#/lifecycle?w=wf-1');
  });

  it('抄送走 cc；base_url 空 = 正文不带链接；尾斜杠不翻车', async () => {
    const { notifier, rec, state } = deps();
    state.cc = ['a@x.com', '  ', 'b@x.com'];
    await notifier.workflowDone(wf('wf-9', 'T'), 'done');
    expect(rec.sent[0]!.to).toBe('boss@example.com');
    expect(rec.sent[0]!.cc).toEqual(['a@x.com', 'b@x.com']); // 空白项已滤

    const bare = deps({ baseUrl: '' });
    await bare.notifier.workflowDone(wf('wf-9', 'T'), 'done');
    expect(bare.rec.sent[0]!.body).not.toContain('lifecycle');
    expect(bare.rec.sent[0]!.cc).toBeUndefined(); // 空抄送不带 cc 字段
  });

  it('未配收件人 = 静默跳过；热改收件人下一次发送即生效', async () => {
    const { notifier, rec, state } = deps();
    state.to = [];
    await notifier.gateWaiting(wf('wf-1', 'T'), st('闸'), 's');
    expect(rec.sent.length).toBe(0);
    state.to = ['late@example.com'];
    await notifier.gateWaiting(wf('wf-1', 'T'), st('闸'), 's');
    expect(rec.sent.length).toBe(1);
    expect(rec.sent[0]!.to).toBe('late@example.com');
  });

  it('mailer 抛异常也绝不向引擎冒泡（尽力而为语义）', async () => {
    const rec = recorder(true);
    const notifier = createEmailNotifier({
      mailer: rec.mailer, baseUrl: '',
      recipients: () => ({ to: ['boss@example.com'], cc: [] }),
    });
    await expect(notifier.workflowDone(wf('wf-1', 'T'), 's')).resolves.toBeUndefined();
  });

  it('自址断根（2026-09-21）：收件人全为被轮询邮箱自身 → mailer 不被调用', async () => {
    const rec = recorder();
    const notifier = createEmailNotifier({
      mailer: rec.mailer, baseUrl: '',
      recipients: () => ({ to: ['  ops.admin@EXAMPLE.com  '], cc: [] }), // 大小写/空白不敏感
      selfAddress: 'ops.admin@example.com',
      log: () => undefined,
    });
    await notifier.workflowFailed(wf('wf-1', 'PPT 制作'), '零步骤');
    await notifier.gateWaiting(wf('wf-1', 'T'), st('发送闸门'), '等批准');
    expect(rec.sent.length).toBe(0);
  });

  it('自址断根：混合名单只剔除自己，其余照发', async () => {
    const rec = recorder();
    const notifier = createEmailNotifier({
      mailer: rec.mailer, baseUrl: '',
      recipients: () => ({
        to: ['ops.admin@example.com', 'boss@example.com'],
        cc: ['a@x.com', 'ops.admin@example.com'],
      }),
      selfAddress: 'ops.admin@example.com',
    });
    await notifier.workflowDone(wf('wf-2', 'T'), 'done');
    expect(rec.sent.length).toBe(1);
    expect(rec.sent[0]!.to).toBe('boss@example.com');
    expect(rec.sent[0]!.cc).toEqual(['a@x.com']);
  });

  it('超长内容截断：主题 80 / 正文 1500（…收尾，深链在截断后仍完整）', async () => {
    const { notifier, rec } = deps();
    const long = 'x'.repeat(3000);
    await notifier.workflowDone(wf('wf-1', long), long); // workflowDone 正文=摘要原样
    const s = rec.sent[0]!;
    expect(s.subject.length).toBe(SUBJECT_MAX);
    expect(s.subject.endsWith('…')).toBe(true);
    const link = 'http://192.168.1.10:7170/#/lifecycle?w=wf-1';
    expect(s.body.startsWith('x'.repeat(BODY_MAX - 1) + '…')).toBe(true); // 正文截到 1500
    expect(s.body.endsWith(link)).toBe(true); // 链接拼在截断之后，永不丢失
  });
});

describe('combinePushers（设备+邮件双通道组合，fire-and-forget）', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  /** 假通道：记录收到的事件；chainDangling/stepFailed 按 opts 决定是否实现。 */
  const fakePusher = (opts: { chainDangling?: boolean; stepFailed?: boolean } = {}):
    { pusher: PusherPort; calls: string[] } => {
    const calls: string[] = [];
    const pusher: PusherPort = {
      async gateWaiting(_w, st) { calls.push(`gateWaiting:${st.title}`); },
      async workflowDone() { calls.push('workflowDone'); },
      async workflowFailed() { calls.push('workflowFailed'); },
      ...(opts.chainDangling
        ? { async chainDangling(_w: Workflow, note: string) { calls.push(`chainDangling:${note}`); } }
        : {}),
      ...(opts.stepFailed
        ? { async stepFailed(_w: Workflow, st: Step, reason: string) { calls.push(`stepFailed:${st.title}:${reason}`); } }
        : {}),
    };
    return { pusher, calls };
  };

  it('三共享事件双通道都收到', async () => {
    const dev = fakePusher();
    const mail = fakePusher();
    const combined = combinePushers(dev.pusher, mail.pusher);
    await combined.gateWaiting(wf('wf-1', 'T'), st('发送闸门'), '等批准');
    await combined.workflowDone(wf('wf-1', 'T'), '完成');
    await combined.workflowFailed(wf('wf-1', 'T'), '失败');
    await tick(); // fire-and-forget：等后台发送落定
    for (const ch of [dev, mail]) {
      expect(ch.calls).toEqual(['gateWaiting:发送闸门', 'workflowDone', 'workflowFailed']);
    }
  });

  it('可选事件只有实现了的一侧收到；两侧都缺 = 组合体上 undefined（可选语义）', async () => {
    const dev = fakePusher(); // 设备侧三事件现状：无 chainDangling/stepFailed
    const mail = fakePusher({ chainDangling: true, stepFailed: true }); // 邮件五事件
    const combined = combinePushers(dev.pusher, mail.pusher);
    expect(combined.chainDangling).toBeDefined();
    expect(combined.stepFailed).toBeDefined();
    await combined.chainDangling?.(wf('wf-1', 'T'), '链尾悬空');
    await combined.stepFailed?.(wf('wf-1', 'T'), st('初稿'), '渲染失败');
    await tick();
    expect(mail.calls).toEqual(['chainDangling:链尾悬空', 'stepFailed:初稿:渲染失败']);
    expect(dev.calls).toEqual([]); // 设备侧不扩面

    const devHas = fakePusher({ chainDangling: true }); // 反向：只有设备侧实现
    const onlyDev = combinePushers(devHas.pusher, fakePusher().pusher);
    await onlyDev.chainDangling?.(wf('wf-2', 'T'), 'n');
    await tick();
    expect(devHas.calls).toEqual(['chainDangling:n']);
    expect(combinePushers(dev.pusher, null).chainDangling).toBeUndefined();
    expect(combinePushers(null, dev.pusher).stepFailed).toBeUndefined();
  });

  it('一侧抛错不影响另一侧，组合方法本身照常 resolve（尽力而为）', async () => {
    const bad: PusherPort = {
      async gateWaiting() { throw new Error('apns down'); },
      async workflowDone() { throw new Error('apns down'); },
      async workflowFailed() { throw new Error('apns down'); },
    };
    const mail = fakePusher();
    const combined = combinePushers(bad, mail.pusher);
    await expect(combined.gateWaiting(wf('wf-1', 'T'), st('闸'), 's')).resolves.toBeUndefined();
    await tick();
    expect(mail.calls).toEqual(['gateWaiting:闸']); // 坏的一侧没拖死好的一侧
  });

  it('慢通道不阻塞：方法返回时慢通道尚未完成（引擎持锁路径不等 SMTP）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let sent = false;
    const slow: PusherPort = {
      async gateWaiting() { await gate; sent = true; },
      async workflowDone() {},
      async workflowFailed() {},
    };
    const combined = combinePushers(slow, null);
    const p = combined.gateWaiting(wf('wf-1', 'T'), st('闸'), 's');
    await expect(p).resolves.toBeUndefined(); // 方法已 resolve，慢通道还在后台跑
    expect(sent).toBe(false);
    release();
    await tick();
    expect(sent).toBe(true); // 后台最终送达
  });
});
