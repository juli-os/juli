// 引擎测试的公共脚手架：固定时钟 + 顺序 ID + 内存 SQLite + mock 端口，
// 全流程确定性断言。

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLedgerStore } from '@juli-os/ledger';
import { createEngine, type Engine, type EngineDeps } from '../src/business/workflow/engine.ts';
import { parseTemplate } from '../src/business/templates/template.ts';
import { EMAIL_REPLY_YAML } from '../src/business/templates/defaultTemplates.ts';
import { ok } from '../src/platform/shared/result.ts';
import { type Clock, type IdGen } from '../src/platform/shared/clock.ts';
import type { CompletionRequest, EmailMessage, LlmPort, MailerPort, PusherPort } from '../src/contracts/ports.ts';

/** 可拨动的假时钟：僵尸心跳/对账这类"沉默时长"断言需要它。 */
export const makeClock = (): { clock: Clock; advance: (ms: number) => void } => {
  let t = new Date('2026-09-07T08:00:00Z');
  return {
    clock: { now: () => new Date(t) },
    advance: (ms: number) => { t = new Date(t.getTime() + ms); },
  };
};

export const fixedClock: Clock = { now: () => new Date('2026-09-07T08:00:00Z') };

export const seqIds = (): IdGen => {
  let n = 0;
  return { newId: (p: string) => `${p}_${String(++n).padStart(4, '0')}` };
};

// 镜像域的回挂答复计数——本地内联（b58 P0-1）：feedback 域在公开投影被整体
// exclude（export/manifest.yaml），helpers 留投影就不能 import 域内模块。
// 实现与私仓 src/business/feedback/mirror.ts replyCountOf 逐字同款：镜像表
// 不存在（内存库未建表/老库）= 无回挂证据 = 计 0。
const replyCountOf = (db: DatabaseSync, recordId: string): number => {
  try {
    const r = db.prepare('SELECT COUNT(*) AS n FROM feedback_mirror WHERE reply_to=?')
      .get(recordId) as { readonly n: number | bigint } | undefined;
    return Number(r?.['n'] ?? 0);
  } catch { return 0; }
};

/** 阶梯起流（配方路径）：邮件类测试走 startFlow('email-reply')——与旧
 * manifest 进件等价的阶梯形态。动态进件（无模板）见 templateless 测试。 */
export const ladderEmail = (engine: Engine, m: EmailMessage): Promise<import('@juli-os/ledger').Workflow> =>
  engine.startFlow('email-reply', m.subject, {
    from: m.from, subject: m.subject, body: m.body, in_reply_to: m.messageId,
  });

export const makeEmail = (over: Partial<EmailMessage> = {}): EmailMessage => ({
  from: 'boss@example.com',
  to: 'juli@example.com',
  subject: '帮忙统计上月销量',
  body: '请把上月的销量数据整理成表格发我。',
  messageId: '<orig-1@example.com>',
  date: '2026-09-07T08:00:00Z',
  uid: 1,
  attachments: [],
  ...over,
});

export interface SentMail {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo: string;
}

export interface MockWorld {
  readonly engine: Engine;
  readonly store: ReturnType<typeof createLedgerStore>;
  readonly llmCalls: CompletionRequest[];
  readonly dispatched: { readonly source: string; readonly session: string; readonly text: string }[];
  readonly sent: SentMail[];
  readonly pushes: string[];
  readonly agentOutputs: Map<string, string>;
  /** feedback 域镜像库（内存）：回挂证据 seed 面——engine 的
   * feedbackReplyCount 从这里计数（2026-11-12 ledger 关门后镜像表不再住
   * lifecycle.db，测试同款搬家）。 */
  readonly feedbackMirrorDb: import('node:sqlite').DatabaseSync;
  /** 账本第二连接（白盒摆数/对账）：0.5.0 起 store 不再暴露 db。 */
  readonly probeDb: import('node:sqlite').DatabaseSync;
  readonly advanceClock: (ms: number) => void;
}

/** 组装确定性引擎：mock LLM（按 system 提示词识别 triage/draft）、mock 派发、
 * mock SMTP、记录型推送。 */
export const makeEngine = (over: Partial<EngineDeps> = {}): MockWorld => {
  const { clock, advance } = makeClock();
  // ledger 0.5.0 句柄私有：白盒摆数/对账走第二连接（文件库；:memory: 各连接独立拿不到同一库）
  const ledgerFile = join(tmpdir(), `juli-test-ledger-${Math.random().toString(36).slice(2)}.db`);
  const store = createLedgerStore(ledgerFile, { clock, ids: seqIds() });
  const probeDb = new DatabaseSync(ledgerFile);
  const llmCalls: CompletionRequest[] = [];
  const dispatched: { source: string; session: string; text: string }[] = [];
  const sent: SentMail[] = [];
  const pushes: string[] = [];
  const agentOutputs = new Map<string, string>();
  const feedbackMirrorDb = new DatabaseSync(':memory:');

  const llm: LlmPort = {
    async complete(req) {
      llmCalls.push(req);
      if (req.system.includes('邮件信息抽取')) {
        return ok({ text: JSON.stringify({
          category: '任务', summary: '请整理上月销量数据表', session: 'agent-a', needs_reply: true,
        }), inputTokens: 1, outputTokens: 1 });
      }
      if (req.system.includes('邮件摘要助手')) {
        // triage_classify on 采纳后的瘦身提示词：分类/回复已由判定给出。
        return ok({ text: JSON.stringify({
          summary: '请整理上月销量数据表', session: 'agent-a',
        }), inputTokens: 1, outputTokens: 1 });
      }
      if (req.system.includes('商务邮件助理')) {
        // fixture 对齐 2026-09-14 二轮契约：落款由引擎拼装（emailView.composeTextBody
        // 在 send 步必经），草稿只写正文——残留落款会被 stripSignature 剥掉再拼引擎版。
        // 正文不宣称附件：宣称附件而无交付契约会撞 declared_attachments_missing 守卫。
        return ok({ text: JSON.stringify({ draft: '您好，上月销量表已完成，请查收。' }), inputTokens: 1, outputTokens: 1 });
      }
      return ok({ text: 'generic-llm-response', inputTokens: 1, outputTokens: 1 });
    },
  };

  const engine = createEngine({
    store,
    feedbackReplyCount: (rid) => replyCountOf(feedbackMirrorDb, rid),
    llm,
    model: 'test-model',
    routing: { defaultSession: '', defaultProject: 'proj-x' },
    dispatch: {
      async dispatch(source, session, text) {
        dispatched.push({ source, session, text });
        return ok(undefined);
      },
    },
    pusher: {
      async gateWaiting(_w, _st, summary) { pushes.push(`gate:${summary}`); },
      async workflowDone(_w, summary) { pushes.push(`done:${summary}`); },
      async workflowFailed(_w, summary) { pushes.push(`failed:${summary}`); },
    } satisfies PusherPort,
    mailer: {
      async send(cmd) {
        sent.push(cmd);
        return ok({ messageId: '<reply-1@juli.local>' });
      },
    } satisfies MailerPort,
    captureOutput: async (session) => agentOutputs.get(session) ?? `pane-of-${session}`,
    workspaceFor: null,
    availableSessions: ['agent-a', 'agent-b'],
    resolveSession: null,
    interruptSession: null,
    rebuildAgent: null,
    zombieFingerprint: null,
    clock,
    ids: seqIds(),
    templates: { 'email-reply': parseTemplate(EMAIL_REPLY_YAML) },
    authz: { mode: 'allowlist', allow: ['*@example.com'], deny: [] },
    ...over,
  });
  return { engine, store, llmCalls, dispatched, sent, pushes, agentOutputs, feedbackMirrorDb, probeDb, advanceClock: advance };
};

export const until = async (predicate: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('until timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};
