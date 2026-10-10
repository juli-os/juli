// 发件人显示名贯通 + 称呼一致性对账（2026-10-01 陈莉君事故）：
// ①RFC2047 编码的 From 显示名（陈义芳）在摄取层解码透传——meta/案卷/任务卡
//   三处都得见到，agent 不再被逼对着地址起名；
// ②发送闸门称呼对账：编造姓名（陈莉君）标黄进人裁决，真名一致放行。

import { describe, expect, it } from 'vitest';
import { decodeRfc2047, parseFullMessage } from '../src/platform/email/inbox.ts';
import { createEngine } from '../src/business/workflow/engine.ts';
import { greetingNameIn, runSendChecks } from '../src/business/send/sendChecks.ts';
import type { EngineDeps } from '../src/business/workflow/engine.ts';
import type { MailerPort, PusherPort } from '../src/contracts/ports.ts';
import { makeClock, makeEmail, seqIds } from './helpers.ts';
import { createLedgerStore } from '../src/platform/ledger/store.ts';

const makeWorld = (over: Partial<EngineDeps> = {}) => {
  const { clock } = makeClock();
  const store = createLedgerStore(':memory:', { clock, ids: seqIds() });
  const engine = createEngine({
    store,
    llm: null, model: 't',
    routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
    dispatch: { async dispatch() { return { ok: true, value: undefined } as const; } },
    syncDispatch: null,
    pusher: { async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {} } satisfies PusherPort,
    mailer: { async send() { return { ok: true, value: { messageId: '<o@j>' } } as const; } } satisfies MailerPort,
    captureOutput: async () => null, workspaceFor: null,
    availableSessions: ['juli-reply'], resolveSession: null, interruptSession: null,
    rebuildAgent: null, zombieFingerprint: null, clock, ids: seqIds(), templates: {},
    authz: { mode: 'allowlist', allow: ['*@example.com'], deny: [] },
    ...over,
  } satisfies EngineDeps);
  return { engine, store };
};

describe('RFC2047 显示名解码（摄取层不再丢名）', () => {
  it('decodeRfc2047：B/Q 编码与混排', () => {
    expect(decodeRfc2047('=?UTF-8?B?6ZmI5LmJ6Iqz?=')).toBe('陈义芳');
    expect(decodeRfc2047('=?utf-8?Q?Chen_Yifang?=')).toBe('Chen Yifang');
    expect(decodeRfc2047('裸名')).toBe('裸名');
  });

  it('parseFullMessage：编码 From 头 → fromName=陈义芳（mailparser 主路）', async () => {
    const eml = [
      'From: "=?UTF-8?B?6ZmI5LmJ6Iqz?=" <alice.chen@example.com>',
      'To: <juli@example.com>',
      'Subject: =?UTF-8?B?5L2g5aW9?=', // 「测试」
      'Message-ID: <n-1@j>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '正文一句。',
    ].join('\r\n');
    const r = await parseFullMessage(Buffer.from(eml));
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.from).toBe('alice.chen@example.com');
    expect(r.ok && r.value.fromName).toBe('陈义芳');
  });
});

describe('显示名贯通进件（meta/案卷/任务卡）', () => {
  it('startEmailWorkflow：from_name 落 meta + 案卷原档 + 步1 input', async () => {
    const w = makeWorld();
    const wf = await w.engine.startEmailWorkflow(makeEmail({
      from: 'alice.chen@example.com',
      fromName: '陈义芳',
      subject: '制作 HTML 作业',
    }));
    expect(wf.meta['from_name']).toBe('陈义芳');
    const step = w.store.stepsForWorkflow(wf.id)[0]!;
    expect(step.input['from_name']).toBe('陈义芳');
    expect(String(step.input['prompt'])).toContain('发件人姓名：{{.Input.from_name}}');
    expect(String(step.input['prompt'])).toContain('称呼纪律');
    expect(String(step.input['prompt'])).toContain('绝不搜索');
  });

  it('无显示名 → meta 无键、步 input 落空串（模板渲染不炸缺失键）', async () => {
    const w = makeWorld();
    const wf = await w.engine.startEmailWorkflow(makeEmail());
    expect(wf.meta['from_name']).toBeUndefined();
    expect(w.store.stepsForWorkflow(wf.id)[0]!.input['from_name']).toBe('');
  });
});

describe('发送闸门称呼一致性（陈莉君事故面）', () => {
  const OPTS = { redlineWords: [], hasManifest: true, feedbackRefs: [], probeUrls: false };

  it('greetingNameIn：只认「XXX 你好/您好」形态', () => {
    expect(greetingNameIn('陈莉君 你好：\n\n试卷')).toBe('陈莉君');
    expect(greetingNameIn('Chen Yifang 您好')).toBe('Chen Yifang');
    expect(greetingNameIn('关于试卷的说明：\n\n……')).toBeUndefined();
    expect(greetingNameIn('你好，已经完成。')).toBeUndefined();
  });

  it('编造姓名（陈莉君 vs 显示名陈义芳）→ warn 标黄进人裁决', async () => {
    const checks = await runSendChecks('陈莉君 你好：\n\n试卷已完成。', {
      ...OPTS, senderName: '陈义芳', senderAddress: 'alice.chen@example.com',
    });
    const g = checks.find((c) => c.name === 'greeting')!;
    expect(g.status).toBe('warn');
    expect(g.detail).toContain('陈义芳');
  });

  it('真名一致 / localpart 对上 / 无显示名 / 无称呼 → 不误伤', async () => {
    const a = await runSendChecks('陈义芳 你好：', { ...OPTS, senderName: '陈义芳', senderAddress: 'alice.chen@example.com' });
    expect(a.find((c) => c.name === 'greeting')!.status).toBe('pass');
    const b = await runSendChecks('Alisa 您好', { ...OPTS, senderName: 'Alisa Chen', senderAddress: 'alice.chen@example.com' });
    expect(b.find((c) => c.name === 'greeting')!.status).toBe('pass');
    const c = await runSendChecks('陈莉君 你好：', { ...OPTS, senderAddress: 'alice.chen@example.com' });
    expect(c.find((x) => x.name === 'greeting')!.status).toBe('warn'); // 无法对账也标黄
    const d = await runSendChecks('你好，已完成。', { ...OPTS, senderName: '陈义芳', senderAddress: 'a@b.c' });
    expect(d.find((x) => x.name === 'greeting')).toBeUndefined(); // 无称呼不意见
  });
});
