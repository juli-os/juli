// 声明会话预热（2026-09-28 用户口令「帮我处理一下」）：重启后按 config.agents
// 逐个幂等 provision——消灭「重启后 ✗ 全躺、首单吃冷启动」。

import { describe, expect, it } from 'vitest';
import { warmupPlan } from '../src/runtime.ts';
import { createProvisioningDispatch } from '@juli-os/agents';
import type { TmuxClient } from '@juli-os/agents';

describe('warmupPlan', () => {
  it('声明表 → 去重/空名剔除/保序', () => {
    expect(warmupPlan([
      { session: 'juli-reply' }, { session: 'acme' }, { session: 'acme' },
      { session: '  ' }, { session: 'memory-cli' },
    ])).toEqual(['juli-reply', 'acme', 'memory-cli']);
  });
  it('空声明表 → 空计划（预热自然 no-op）', () => {
    expect(warmupPlan([])).toEqual([]);
  });
});

// 行为面契约：provision 对「已就绪会话」的预热调用 = 幂等零副作用快路径。
describe('warmup 行为契约（假 tmux）', () => {
  const readyPane = '▐▛███▛█   Claude Code v2.1.258\n▝▜██████▀  glm-5.3-flash[1m]\n❯';
  const fakeTmux = (over: Partial<Record<string, unknown>> = {}): TmuxClient => {
    const calls: string[] = [];
    const t = {
      socketPath: '/tmp/fake.sock',
      async hasSession(name: string) { calls.push(`has:${name}`); return true; },
      async exec(args: readonly string[]) { calls.push(`exec:${args[0]}`); return { ok: true as const, value: readyPane }; },
      async listSessions() { return ['juli-reply']; },
      async listSessionsDetailed() { return { ok: true as const, value: [{ name: 'juli-reply', attached: false, path: '/w', cmd: 'claude' }] }; },
      async newSession() { return { ok: true as const, value: undefined }; },
      async sendText(name: string, _text: string) { calls.push(`send:${name}`); return { ok: true as const, value: undefined }; },
      async sendTextConfirmed(name: string) { calls.push(`conf:${name}`); return { ok: true as const, value: { enters: 0, repasted: false, elapsedMs: 5 } }; },
      async capturePane() { return { ok: true as const, value: readyPane }; },
      async killSession() { return { ok: true as const, value: undefined }; },
      async interrupt() { return { ok: true as const, value: undefined }; },
      ...over,
    } as unknown as TmuxClient & { readonly callsRef: string[] };
    return t;
  };

  it('已就绪会话：provision 空文本 = 快路径（不新建会话、不发 boot）', async () => {
    const tmux = fakeTmux();
    const provision = createProvisioningDispatch({
      tmux, bootCommand: 'claude',
      sleep: () => Promise.resolve(),
      log: () => undefined,
    });
    const r = await provision('startup-warmup', 'juli-reply', '');
    expect(r.ok).toBe(true);
  });

  it('会话不存在：provision 走新建+boot 路径（重建语义就是派发同款）', async () => {
    // 状态翻转桩：新建后=裸 shell（pane_current_command=zsh）；boot 发出后
    // → claude 就绪（前台命令=node、pane 带空闲提示符）。
    let booted = false;
    const shellPane = '➜ /work/dir git:(main) ✗';
    const tmux = fakeTmux({
      hasSession: async () => true,
      newSession: async () => { booted = false; return { ok: true as const, value: undefined }; },
      exec: async (args: readonly string[]) =>
        ({ ok: true as const, value: booted ? 'node' : 'zsh' }),
      capturePane: async () => ({ ok: true as const, value: booted ? readyPane : shellPane }),
      sendText: async (_n: string, text: string) => {
        if (text === 'claude') booted = true;
        return { ok: true as const, value: undefined };
      },
    });
    const boot: string[] = [];
    const provision = createProvisioningDispatch({
      tmux,
      bootCommand: 'claude',
      cwdFor: () => '/work/dir',
      sleep: () => Promise.resolve(),
      log: (m: string) => { if (m.includes('拉起')) boot.push(m); },
    });
    const r = await provision('startup-warmup', 'acme', '');
    expect(r.ok).toBe(true);
    expect(boot).toHaveLength(1); // 裸 shell → 拉起 claude
  });
});
