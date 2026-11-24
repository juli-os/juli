// 2026-11-07 审查 P1 契约锁定：write-ahead 时序——prompt 意图先落
// 账再发送；发送确定性失败回写 failed；submit_unconfirmed/submit_lost 保持
// submitted 交 zombie 看门狗兜底。（登记与回写由引擎 runAgentStep
// 保证——runtime dispatch 闭包已回归纯适配。）
// 本文件以 fake tmux 走真实 advance→runAgentStep→createPrompt→provision 链
//（fake 面沿 ios-compat.test.ts 同款），不经 dispatch 接缝覆盖，时序断言锚在
// sendTextConfirmed 执行点。
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import { err, ok, type Result } from '../src/platform/shared/result.ts';
import type { TmuxClient } from '@juli-os/agents';

/** 账本第二连接（ledger 0.5.0 句柄私有，白盒摆数/对账走这里）。 */
const probeOf = (rt: { config: { data_dir: string } }): import('node:sqlite').DatabaseSync =>
  new DatabaseSync(join(rt.config.data_dir, 'lifecycle.db'));


type SendResult = Result<{ enters: number; repasted: boolean; elapsedMs: number }>;
type StepLike = ReturnType<Runtime['store']['createStep']>;

/** 组装最小运行时（fake tmux，dispatch 走产线闭包）并驱动一张 agent 步
 * 派发到发送执行点。promptAtSend 记录 sendTextConfirmed 执行时刻账上的
 * submitted prompt——write-ahead 时序的直接观测点。 */
const drive = async (sendResult: SendResult): Promise<{
  rt: Runtime;
  st: StepLike;
  promptAtSend: unknown[];
}> => {
  let rtRef: Runtime | null = null;
  const promptAtSend: unknown[] = [];
  const tmux: TmuxClient = {
    async hasSession() { return true; },
    async listSessions() { return ['agent-a']; },
    async listSessionsDetailed() {
      return ok([{ name: 'agent-a', attached: true, path: '/tmp/proj-a', cmd: 'claude' }]);
    },
    async newSession() { return ok(undefined); },
    async sendText() { return ok(undefined); },
    async sendKey() { return ok(undefined); },
    async foregroundCommandOf() { return 'claude'; },
    async panePathOf() { return '/tmp/proj-a'; },
    async sessionBirthsOf() { return new Map(); },
    async setEnv() { return ok(undefined); },
    async capturePane() { return ok('agent ready\n'); },
    async killSession() { return ok(undefined); },
    async interrupt() { return ok(undefined); },
    async sendTextConfirmed(_session, _text) {
      promptAtSend.push(rtRef !== null ? rtRef.store.latestPromptForSession('agent-a', ['submitted']) : null);
      return sendResult;
    },
    async sendTextQueued() { return ok({ enters: 0, repasted: false, elapsedMs: 0, finalState: 'cleared' as const }); },
  };
  const rt = createRuntime(configSchema.parse({
    data_dir: mkdtempSync(join(tmpdir(), 'juli-wa-')),
    email: { default_session: 'agent-a', default_project: 'demo' },
  }), { tmux });
  rtRef = rt;
  const wf = rt.store.createWorkflow({ kind: 'adhoc', title: 'write-ahead', status: 'running' });
  const st = rt.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: '执行' });
  rt.store.setStepInput(st.id, { plan: '做单', session: 'agent-a' });
  await rt.engine.advance(wf.id);
  return { rt, st, promptAtSend };
};

describe('write-ahead（引擎侧登记）', () => {
  it('发送执行点之前 prompt 已落账（write-ahead 时序）；成功后步 running、账留 submitted', async () => {
    const { rt, st, promptAtSend } = await drive(ok({ enters: 1, repasted: false, elapsedMs: 1 }));
    // 发送执行点上账上已有 submitted prompt——restart 守卫的放行凭证先于
    // 发送存在，provision 窗口（herdr 下秒~分钟级）不再有账空窗。
    expect(promptAtSend[0]).toMatchObject({ status: 'submitted' });
    expect(rt.store.getStep(st.id)!.status).toBe('running');
    expect(rt.store.latestPromptForSession('agent-a', ['submitted'])).not.toBeNull();
  });

  it('确定性发送失败：prompt 回写 failed（账上不留幽灵在途）', async () => {
    const { rt, st } = await drive(err(new Error('tmux: paste 落地失败')));
    expect(rt.store.getStep(st.id)!.status).toBe('failed');
    expect(rt.store.latestPromptForSession('agent-a', ['submitted'])).toBeNull();
    // 步 failed → workflow 级联 failed（既有语义），latestPromptForSession
    // 的 active-run JOIN 不再可见——回写以账本行直查为准。
    const row = probeOf(rt).prepare('SELECT status FROM prompts ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as { status: string };
    expect(row.status).toBe('failed');
  });

  it('submit_unconfirmed：prompt 保持 submitted（不判死裁定），步保持 running 等看门狗', async () => {
    const { rt, st } = await drive(err(new Error('submit_unconfirmed: prompt 已入框但连续补 Enter 未被消费——任务未确认提交')));
    expect(rt.store.getStep(st.id)!.status).toBe('running');
    expect(rt.store.latestPromptForSession('agent-a', ['submitted'])).not.toBeNull();
  });
});
