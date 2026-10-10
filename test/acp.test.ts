// ACP 执行器契约测试：真子进程（Python 假 app-server）走完整 JSON-RPC
// 协议——thread/start、turn/start → agentMessage → turn/completed，
// 失败状态透传为 error，子进程死亡时在途调用立即失败不挂死。

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createAcpExecutor } from '@juli-os/agents';
import { ok } from '@juli-os/artifacts';
import { ladderEmail, makeEngine, makeEmail, until } from './helpers.ts';

const serverJs = join(import.meta.dirname, 'fixtures', 'fake-app-server.py');

const makeExecutor = () =>
  createAcpExecutor({
    command: ['python3', serverJs],
    model: '',
    apiKey: '',
    log: () => undefined,
  });

describe('ACP 执行器（真子进程协议）', () => {
  it('dispatchSync：协议级完成，最终消息直接返回', async () => {
    const acp = makeExecutor();
    const res = await acp.dispatchSync('email', 'agent-a', '请执行任务');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe('假 agent 的最终汇报');
    expect(acp.alive()).toBe(true);
    acp.stop();
  });

  it('turn/completed status=failed → 透传为 error（步进 failed 可重试）', async () => {
    const acp = makeExecutor();
    const res = await acp.dispatchSync('email', 'agent-a', '请失败');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain('failed');
    acp.stop();
  });

});

// syncDispatch 在引擎层的 settle-once 路径（复用 mock 引擎，不走真子进程）：
describe('引擎 × syncDispatch（ACP 路径）', () => {
  it('闸门批准后 agent 步由协议级完成信号直接结算，无需 hook', async () => {
    const w = makeEngine({
      syncDispatch: {
        async dispatchSync(_source, session, text) {
          return ok(`汇报：${text.slice(0, 12)}`);
        },
      },
    });
    await ladderEmail(w.engine, makeEmail());
    const wfId = w.store.listWorkflows()[0]!.id;
    await until(() => w.store.stepsForWorkflow(wfId)[1]!.status === 'waiting_human');
    await w.engine.approve(w.store.stepsForWorkflow(wfId)[1]!.id, '', 'boss');
    await until(() => w.store.stepsForWorkflow(wfId)[2]!.status === 'completed');
    const agentStep = w.store.stepsForWorkflow(wfId)[2]!;
    expect(agentStep.output['via']).toBe('acp');
    expect(String(agentStep.output['output'])).toContain('汇报');
    // 下一步（verify）被播种了 output + session，继续走 ACP。
    await until(() => w.store.stepsForWorkflow(wfId)[3]!.status === 'completed');
    await until(() => w.store.stepsForWorkflow(wfId)[4]!.status === 'waiting_human');
  });
});
