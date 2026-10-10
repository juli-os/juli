// 链尾可结算提示（0923 断点③，wf_fa36282cdf63：agent 完工后引擎静默，收口
// 全靠人自己想起来）：nodes 链全终态、无悬空报警、无人 settle → 一次性
// run_settleable 事件 + PusherPort.settleHint 尽力推送；闸门等待中不算。

import { describe, expect, it } from 'vitest';
import { createLedgerStore } from '@juli-os/ledger';
import { makeClock, seqIds } from './helpers.ts';
import { createEngine, type Engine, type EngineDeps } from '../src/business/workflow/engine.ts';
import { parseTemplate } from '../src/business/templates/template.ts';
import { ok } from '@juli-os/artifacts';
import type { LlmPort, MailerPort, PusherPort } from '../src/contracts/ports.ts';

const NODES_YAML = `key: adhoc-nodes
name: 人肉单容器
trigger: manual
mode: nodes
steps: []
`;

interface W {
  readonly engine: Engine;
  readonly store: ReturnType<typeof createLedgerStore>;
  readonly hints: string[];
}
const makeW = (): W => {
  const { clock } = makeClock();
  const store = createLedgerStore(':memory:', { clock, ids: seqIds() });
  const hints: string[] = [];
  const engine = createEngine({
    store,
    llm: { async complete() { return ok({ text: '{}', inputTokens: 1, outputTokens: 1 }); } } as unknown as LlmPort,
    model: 't',
    routing: { defaultSession: '', defaultProject: 'p' },
    dispatch: { async dispatch() { return ok(undefined); } },
    syncDispatch: null,
    pusher: {
      async gateWaiting() {}, async workflowDone() {}, async workflowFailed() {},
      async settleHint(_w, note) { hints.push(note); },
    } satisfies PusherPort,
    mailer: { async send() { return ok({ messageId: '<m@x>' }); } } satisfies MailerPort,
    captureOutput: async () => 'PANE',
    workspaceFor: null,
    sendToSession: null,
    availableSessions: ['agent-a'],
    resolveSession: null,
    interruptSession: null,
    rebuildAgent: null,
    zombieFingerprint: null,
    clock,
    ids: seqIds(),
    templates: { n: parseTemplate(NODES_YAML) },
    authz: { mode: 'allowlist', allow: ['*@example.com'], deny: [] },
  } satisfies EngineDeps);
  return { engine, store, hints };
};

describe('链尾可结算提示（0923 断点③）', () => {
  it('nodes 链全终态 → run_settleable 事件 + settleHint 推送一次（重放不重响）', async () => {
    const w = makeW();
    const wf = await w.engine.startFlow('n', '人工单', {});
    await w.engine.appendNode(wf.id, { kind: 'agent', title: '执行', input: { session: 'agent-a', plan: '干活' } });
    await w.engine.onAgentStopped('agent-a', 'done', '汇报：已办结');
    const events = w.store.listEvents(50).filter((e) => e.type === 'run_settleable');
    expect(events).toHaveLength(1);
    expect(w.hints).toHaveLength(1);
    expect(w.hints[0]).toContain(wf.id); // 提示直接给出 settle 命令行
    // 4s 轮询/续走重放：meta 防重，同一单只响一次。
    await w.engine.advance(wf.id);
    expect(w.store.listEvents(50).filter((e) => e.type === 'run_settleable')).toHaveLength(1);
    expect(w.hints).toHaveLength(1);
  });

  it('闸门等待中（waiting_human=活跃）不算可 settle；批准后链尾空档才提示，结算收口', async () => {
    const w = makeW();
    const wf = await w.engine.startFlow('n', '人工单', {});
    await w.engine.appendNode(wf.id, { kind: 'agent', title: '执行', input: { session: 'agent-a', plan: '干活' } });
    await w.engine.appendNode(wf.id, { kind: 'gate', title: '确认' });
    await w.engine.onAgentStopped('agent-a', 'done', '汇报');
    expect(w.store.listEvents(50).some((e) => e.type === 'run_settleable')).toBe(false);
    expect(w.hints).toHaveLength(0);
    // 批准闸门（sendToSession=null：无回流路径，纯链推进）→ 链全终态 → 提示。
    const gate = w.store.stepsForWorkflow(wf.id).find((x) => x.kind === 'gate')!;
    await w.engine.approve(gate.id, '', 'test');
    expect(w.store.listEvents(50).some((e) => e.type === 'run_settleable')).toBe(true);
    expect(w.hints).toHaveLength(1);
    await w.engine.settle(wf.id, 'test');
    expect(w.store.getWorkflow(wf.id)!.status).toBe('completed');
  });
});
