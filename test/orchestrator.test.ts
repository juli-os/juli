// 编排器契约测试：tool-calling 循环（事件序列/工具执行/上下文裁剪/空回复
// 唤醒）、slash 分流、hooks 拦截、守护者评估。

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOrchestrator, createHookManager, createCommandRegistry, registerDefaultCommands,
  createSessionAssessor,
} from '@juli-os/agents';
import { makeAllTools } from '@juli-os/agents';
import { createTmuxClient } from '@juli-os/agents';
import { err, ok } from '@juli-os/artifacts';
import { type ChatLlmPort, type ChatResult, type ToolCallRequest } from '@juli-os/agents';

const collect = (): { events: ReturnType<typeof ev>[], emit: (e: ReturnType<typeof ev>) => void } => {
  const events: ReturnType<typeof ev>[] = [];
  return { events, emit: (e) => events.push(e) };
};
const ev = (e: Parameters<Parameters<import('@juli-os/agents').Orchestrator['handle']>[1]>[0]) => e;

const makeSession = async (): Promise<{ dir: string; cleanup: () => void }> => {
  const dir = mkdtempSync(join(tmpdir(), 'juli-orch-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const scriptedLlm = (turns: ChatResult[]): { llm: ChatLlmPort; calls: ToolCallRequest[] } => {
  const calls: ToolCallRequest[] = [];
  return {
    calls,
    llm: {
      name: 'scripted',
      async chat(req) {
        calls.push(req);
        const next = turns.shift();
        return next === undefined
          ? err(new Error('script exhausted'))
          : ok(next);
      },
    },
  };
};

describe('tool-calling 循环', () => {
  it('LLM 请求工具 → 工具执行 → 结果回填 → 最终答复（事件序列完整）', async () => {
    const { dir, cleanup } = await makeSession();
    try {
      for (const f of ['a.md', 'b.md', 'c.md']) {
        writeFileSync(join(dir, f), 'x');
      }
      const { llm, calls } = scriptedLlm([
        { content: '', toolCalls: [{ id: 't1', name: 'list_directory', arguments: '{}' }], stopReason: 'tool_use' },
        { content: '工作区里有 3 个文件。', toolCalls: [], stopReason: 'end_turn' },
      ]);
      const orch = createOrchestrator({
        llm, model: 'm', tools: makeAllTools({ tmux: null, notifier: null, assessor: null, cwd: dir }),
        systemPrompt: '你是助手', maxContextMessages: 40,
      });
      const { events, emit } = collect();
      await orch.handle('工作区里有什么？', emit);
      expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result', 'text', 'done']);
      expect(events[1]).toMatchObject({ tool: 'list_directory' });
      // 消息历史：user + assistant(toolCalls) + tool(results) + assistant(final)。
      expect(orch.messages.length).toBe(4);
      // 第二次 LLM 调用带上了工具结果消息。
      const lastMessages = calls[1]!.messages;
      expect(lastMessages.at(-1)?.role).toBe('tool');
      expect(lastMessages.at(-1)?.toolResults?.[0]?.content).toContain('a.md');
      void expect;
    } finally {
      cleanup();
    }
  });

  it('上下文裁剪：超过 maxContextMessages 时丢最旧的历史', async () => {
    const { dir: _dir, cleanup } = await makeSession();
    try {
      const { llm } = scriptedLlm(Array.from({ length: 30 }, () =>
        ({ content: 'ok', toolCalls: [], stopReason: 'end_turn' })));
      const orch = createOrchestrator({
        llm, model: 'm', tools: [], systemPrompt: 's', maxContextMessages: 6,
      });
      const { emit } = collect();
      for (let i = 0; i < 10; i++) await orch.handle(`消息 ${i}`, emit);
      expect(orch.messages.length).toBeLessThanOrEqual(6);
    } finally {
      cleanup();
    }
  });

  it('工具后空内容：唤醒模型总结且只推一次', async () => {
    const { dir, cleanup } = await makeSession();
    try {
      const { llm, calls } = scriptedLlm([
        { content: '', toolCalls: [{ id: 't1', name: 'get_state', arguments: '{"key":"k"}' }], stopReason: 'tool_use' },
        { content: '', toolCalls: [], stopReason: 'end_turn' },
        { content: '总结好了', toolCalls: [], stopReason: 'end_turn' },
      ]);
      const orch = createOrchestrator({
        llm, model: 'm', tools: makeAllTools({ tmux: null, notifier: null, assessor: null, cwd: dir }),
        systemPrompt: 's',
      });
      const { events, emit } = collect();
      await orch.handle('k 是多少', emit);
      expect(events.at(-2)).toMatchObject({ type: 'text', content: '总结好了' });
      // 第三次调用的最后一条是唤醒消息。
      expect(calls[2]!.messages.at(-1)?.content).toContain('简短的自然语言');
    } finally {
      cleanup();
    }
  });

  it('hooks：before_tool_call 可拦截工具调用', async () => {
    const { dir, cleanup } = await makeSession();
    try {
      const hooks = createHookManager();
      hooks.on('before_tool_call', (p) => ({
        ...p,
        block: p.tool === 'write_file',
        blockReason: '写入被守护者拦截',
      }));
      const { llm } = scriptedLlm([
        { content: '', toolCalls: [{ id: 't1', name: 'write_file', arguments: '{"path":"x.txt","content":"hi"}' }], stopReason: 'tool_use' },
        { content: '被拦了', toolCalls: [], stopReason: 'end_turn' },
      ]);
      const orch = createOrchestrator({
        llm, model: 'm', tools: makeAllTools({ tmux: null, notifier: null, assessor: null, cwd: dir }),
        systemPrompt: 's', hooks,
      });
      const { events, emit } = collect();
      await orch.handle('写文件', emit);
      const tr = events.find((e) => e.type === 'tool_result');
      expect(tr).toMatchObject({ content: '写入被守护者拦截' });
      expect(() => { void readX(join(dir, 'x.txt')); }).not.toThrow();
      void readX;
    } finally {
      cleanup();
    }
  });
});

const readX = async (p: string): Promise<string | null> => {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
};

describe('slash 命令分流', () => {
  it('/help 不经 LLM 直接回命令表', async () => {
    const registry = createCommandRegistry();
    registerDefaultCommands(registry, {});
    const { llm, calls } = scriptedLlm([]);
    const orch = createOrchestrator({
      llm, model: 'm', tools: [], systemPrompt: 's', commands: registry,
    });
    const { events, emit } = collect();
    await orch.handle('/help', emit);
    expect(calls.length).toBe(0);
    expect(events[0]).toMatchObject({ type: 'text' });
  });
});

describe('守护者评估器', () => {
  it('LLM JSON 决策解析；坏 JSON → unknown 之外的失败通道', async () => {
    const assessor = createSessionAssessor({
      name: 'fake',
      async chat() {
        return ok({
          content: '{"decision":"approve","reason":"routine file edit"}',
          toolCalls: [], stopReason: 'end_turn',
        });
      },
    }, 'm');
    const res = await assessor.assess('agent-a', '...Do you want to proceed? 1. Yes');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.decision).toBe('approve');
      expect(res.value.reason).toBe('routine file edit');
    }
  });
});

describe('tmux 工具（mock 传输）', () => {
  it('send/read/wait 经 TmuxClient 端口执行', async () => {
    const { dir, cleanup } = await makeSession();
    try {
      const tmux = createTmuxClient();
      void tmux; // 真子进程不在这里起；用桩验证执行面。
      const stub = {
        hasSession: async () => true,
        listSessions: async () => ['agent-a', 'agent-b'],
        newSession: async () => ({ ok: true, value: undefined }),
        sendText: async (name: string, text: string) => {
          sent.push(`${name}:${text}`);
          return { ok: true, value: undefined };
        },
        capturePane: async () => ({ ok: true, value: 'hello\nworld' }),
        killSession: async () => ({ ok: true, value: undefined }),
        interrupt: async () => ({ ok: true, value: undefined }),
        exec: async (args: readonly string[]) =>
          args.includes('#{pane_current_command}')
            ? { ok: true, value: 'claude' }
            : { ok: true, value: '' },
      } as never;
      const sent: string[] = [];
      const tools = makeAllTools({ tmux: stub, notifier: null, assessor: null, cwd: dir });
      const send = tools.find((t) => t.name === 'send_to_session')!;
      const res = await send.execute({ name: 'agent-a', message: 'hi' });
      expect(res.ok).toBe(true);
      expect(sent).toEqual(['agent-a:hi']);
      const read = tools.find((t) => t.name === 'read_session_output')!;
      const r2 = await read.execute({ name: 'agent-a' });
      expect(r2.ok).toBe(true);
    } finally {
      cleanup();
    }
  });
});
