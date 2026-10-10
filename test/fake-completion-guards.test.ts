// 假完成家族守卫（2026-09-13 案贰收尾，registry b17）：
// ① 零步骤禁 completed —— 无任何步骤的流水走到 advance，绝不许翻译成
//    completed（静默成功），必须显式 failed 留痕。
// ② 字母序兜底防复发 —— 未知模板键显式报错、零步 ladder 模板解析层即拒、
//    registry 的 sort() 仅加载/展示顺序而非选择器。兜底代码已随动态进件
//    裁决移除，本文件负责钉死「不许复活」。

import { describe, expect, it } from 'vitest';
import { createLedgerStore } from '../src/platform/ledger/store.ts';
import { createEngine, type EngineDeps } from '../src/business/workflow/engine.ts';
import { tryParseTemplate } from '../src/business/templates/template.ts';
import { ok } from '../src/platform/shared/result.ts';
import { makeClock, seqIds } from './helpers.ts';
import type { MailerPort, PusherPort } from '../src/contracts/ports.ts';

const makeWorld = (over: Partial<EngineDeps> = {}) => {
  const { clock, advance } = makeClock();
  const store = createLedgerStore(':memory:', { clock, ids: seqIds() });
  const failedPushes: string[] = [];
  const engine = createEngine({
    store,
    llm: null,
    model: 't',
    routing: { defaultSession: 'juli-reply', defaultProject: 'p' },
    dispatch: { async dispatch(_s, _session, _text) { return ok(undefined); } },
    syncDispatch: null,
    pusher: {
      async gateWaiting() {},
      async workflowDone() {},
      async workflowFailed(_w, summary) { failedPushes.push(summary); },
    } satisfies PusherPort,
    mailer: { async send() { return ok({ messageId: '<x@j>' }); } } satisfies MailerPort,
    captureOutput: async () => null,
    workspaceFor: null,
    availableSessions: ['juli-reply'],
    resolveSession: null,
    interruptSession: null,
    rebuildAgent: null,
    zombieFingerprint: null,
    clock,
    ids: seqIds(),
    templates: {}, // 空注册表：任何模板路由都不可能有米下锅
    authz: { mode: 'allowlist', allow: ['*@example.com'], deny: [] },
    ...over,
  } satisfies EngineDeps);
  return { engine, store, failedPushes, advanceClock: advance };
};

describe('零步骤禁完成（假完成案贰守卫）', () => {
  it('无任何步骤的流水 advance → failed + workflow_failed 事件留 zero_steps 原因，绝不 completed', async () => {
    const w = makeWorld();
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '空流水（事故形态）' });
    await w.engine.advance(wf.id);
    expect(w.store.getWorkflow(wf.id)!.status).toBe('failed');
    const ev = w.store.listEvents(50).find((e) => e.entityId === wf.id && e.type === 'workflow_failed');
    expect(ev).toBeDefined();
    expect(JSON.stringify(ev!.payload)).toContain('zero_steps');
    // 主动推送：守卫的全部意图是人工处置——workflowFailed 通道必须被调起（P2）。
    expect(w.failedPushes).toHaveLength(1);
    expect(w.failedPushes[0]).toContain('零步骤守卫');
  });

  it('nodes 模式空档不触发守卫：无节点 advance 后保持 running（等动作追加）', async () => {
    const w = makeWorld();
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: 'nodes 空档', meta: { mode: 'nodes' } });
    await w.engine.advance(wf.id);
    expect(w.store.getWorkflow(wf.id)!.status).toBe('running');
  });

  it('守卫不误伤正常完工：步骤存在且全部落定 → 照常 completed', async () => {
    const w = makeWorld();
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '正常完工' });
    const st = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'llm', title: 's', input: {} });
    w.store.setStepStatus(st.id, 'completed'); // 唯一步已落定 → currentStep 空但 steps.length===1
    await w.engine.advance(wf.id);
    expect(w.store.getWorkflow(wf.id)!.status).toBe('completed');
  });
});

describe('字母序兜底防复发（案贰根源钉死）', () => {
  it('startFlow 未知模板键 → 显式报错，绝不静默换模板', async () => {
    const w = makeWorld();
    await expect(w.engine.startFlow('no-such-tpl', '', {})).rejects.toThrow(/unknown flow template/);
  });

  it('零步 ladder 模板在解析层即拒（template needs at least one step）', () => {
    const yaml = 'key: empty-t\ntitle: 空模板\ntrigger: manual\nsteps: []\n';
    expect(tryParseTemplate(yaml)).toBeNull();
  });
});
