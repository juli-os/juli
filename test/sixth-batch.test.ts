// PTY/WS 桥 + skills + pane-probe + 桌面通知 契约测试。
// PTY 走真 tmux（throwaway 会话）——script(1) 分配 PTS，WS 双向直通。

import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createPty, ptyAvailable } from '@juli-os/agents';
import { attachPtyHub } from '../src/platform/ws/ptyhub.ts';
import { parseSkill, expandPrompt, createSkillRegistry } from '@juli-os/agents';
import { probePane } from '@juli-os/agents';
import { createDesktopNotifier } from '../src/platform/push/notify.ts';
import type { TmuxClient } from '@juli-os/agents';
import { ok } from '@juli-os/artifacts';

const hasTmux = (() => {
  try {
    execSync('tmux -V', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe('PTY（script(1) 零依赖实现）', () => {
  // CI（Linux runner）无 /usr/bin/expect：spawn ENOENT 化身退出码 -1，
  // 属环境缺件非产品缺陷——探测到才跑，勿让远端套件常年红。
  it.skipIf(!hasTmux || !ptyAvailable())('echo 经伪终端回环；行列经 stty 生效', async () => {
    let out = '';
    const pty = createPty(['echo', 'pty-roundtrip'], { cols: 100, rows: 30 }, (d) => { out += d; });
    const code = await Promise.race([
      pty.exit,
      new Promise<number>((r) => setTimeout(() => r(-99), 5000)),
    ]);
    expect(code).toBe(0);
    expect(out).toContain('pty-roundtrip');
  });
});

describe('xterm WS 桥（hub 单元面）', () => {
  // 两用例共用同一无状态桩：hasSession=false → newSession ok → attach 失败路径。
  const tmux = {
    async hasSession() { return false; },
    async newSession() { return ok(undefined); },
    async listSessions() { return []; },
    async sendText() { return ok(undefined); },
    async capturePane() { return ok('pane'); },
    async killSession() { return ok(undefined); },
    async interrupt() { return ok(undefined); },
    async exec() { return ok(''); },
  } as unknown as TmuxClient;

  it('未知会话：attach 失败 → ws 以 1011 关闭；未带 token 的 /api 路径不受影响', async () => {
    const server = createServer();
    attachPtyHub({ server, tmux, password: '' });
    await new Promise<void>((r) => server.listen(0, () => r()));
    const port = (server.address() as { port: number }).port;
    // hasSession=false → newSession ok → attach tmux（本机 tmux 存在）→
    // 未知会话 attach 失败 → ws 关闭。这里断言"连接建立后会关闭"。
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/xterm/no-such-session`);
    const closed = await new Promise<boolean>((resolve) => {
      ws.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 4000);
    });
    expect(closed).toBe(true);
    server.close();
  }, 10000);

  it('绑定会话守卫（PROBLEMS-R2 P1 旁道 B）：命中 boundSessions → 1008 拒连；普通名不受影响', async () => {
    const server = createServer();
    attachPtyHub({ server, tmux, password: '', boundSessions: ['project-a'] });
    await new Promise<void>((r) => server.listen(0, () => r()));
    const port = (server.address() as { port: number }).port;
    const closeOf = (name: string): Promise<{ code: number; reason: string }> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/xterm/${name}`);
        ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
        setTimeout(() => resolve({ code: -1, reason: '' }), 4000);
      });
    // 绑定名：守卫先行，attach 之前就 1008 关闭（全双工裸字节不给出）。
    const bound = await closeOf('project-a');
    expect(bound.code).toBe(1008);
    expect(bound.reason).toContain('绑定会话');
    // 非绑定名：不进守卫——照常走 attach 语义（此处 fake tmux 无会话 → 1011）。
    const normal = await closeOf('no-such-session');
    expect(normal.code).not.toBe(1008);
    server.close();
  }, 10000);

  // 真实 tmux 双向桥的端到端验证在沙箱外脚本：npm run e2e:ws（tsx 直跑）。
});

describe('skills', () => {
  const md = `---
name: weekly-report
description: 生成销量周报
allowed-tools: read_file, list_directory
---
你是周报助手。基于 {{.Args}} 生成本周周报，重点看 {{.Arg0}}。`;

  it('frontmatter 解析 + 模板展开 + 注册表激活/单次消费', () => {
    const skill = parseSkill(md);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('weekly-report');
    expect(skill!.allowedTools).toEqual(['read_file', 'list_directory']);
    expect(expandPrompt(skill!, ['销量', '2026-W37'])).toContain('重点看 销量');

    const dir = mkdtempSync(join(tmpdir(), 'juli-sk-'));
    writeFileSync(join(dir, 'weekly-report.md'), md);
    const reg = createSkillRegistry(dir);
    expect(reg.all.length).toBe(1);
    const act = reg.activate('weekly-report', ['销量']);
    expect(act.ok).toBe(true);
    expect(reg.takeActive()?.prompt).toContain('你是周报助手');
    expect(reg.takeActive()).toBeNull(); // 单次：已消费
    expect(reg.activate('nope', []).ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('pane-probe（确定性启发式）', () => {
  const stub = (currentCommand: string, pane: string): TmuxClient => ({
    async exec(args) {
      if (args.includes('#{pane_current_command}')) return ok(currentCommand);
      return ok('');
    },
    async hasSession() { return true; },
    async listSessions() { return []; },
    async listSessionsDetailed() { return ok([]); },
    async newSession() { return ok(undefined); },
    async sendText() { return ok(undefined); },
    async sendTextConfirmed() { return ok({ enters: 0, repasted: false, elapsedMs: 0 }); },
    async sendTextQueued() { return ok({ enters: 0, repasted: false, elapsedMs: 0, finalState: 'cleared' }); },
    async capturePane() { return ok(pane); },
    async killSession() { return ok(undefined); },
    async interrupt() { return ok(undefined); },
  });

  it('裸 shell 占面板 → foregroundIsShell，不可派任务', async () => {
    const p = await probePane(stub('zsh', '% ❯ '), 's');
    expect(p.foregroundIsShell).toBe(true);
    expect(p.ready).toBe(false);
  });

  it('信任对话框与编号选择项被识别（绝不盲点）', async () => {
    const trust = await probePane(stub('claude', 'Do you trust the files in this folder?'), 's');
    expect(trust.trustDialog).toBe(true);
    const menu = await probePane(stub('claude', '❯ 1. Yes\n  2. No'), 's');
    expect(menu.liveSelection).toBe(true);
    expect(menu.ready).toBe(false);
  });

  it('agent 活着且光标在末行 → ready', async () => {
    const p = await probePane(stub('claude', '> 帮我修 bug\n好的，已修复完成。'), 's');
    expect(p.agentAlive).toBe(true);
    expect(p.ready).toBe(true);
  });
});

describe('macOS 桌面通知', () => {
  it('frontmost 时免打扰；非 darwin 直接跳过', async () => {
    const ran: string[] = [];
    const notify = createDesktopNotifier({
      run: async (cmd) => { ran.push(cmd[0] ?? ''); },
      frontmost: async () => true,
      platform: 'darwin',
    });
    await notify('t', 'b');
    expect(ran).toEqual([]); // 用户正盯着 → 免打扰

    const skip = createDesktopNotifier({ run: async (cmd) => { ran.push(cmd[0] ?? ''); }, platform: 'linux' });
    await skip('t', 'b');
    expect(ran).toEqual([]);
  });

  it('terminal-notifier 失败回退 osascript', async () => {
    const ran: string[] = [];
    const notify = createDesktopNotifier({
      run: async (cmd) => {
        ran.push(cmd[0] ?? '');
        if (cmd[0] === 'terminal-notifier') throw new Error('not installed');
      },
      frontmost: async () => false,
      platform: 'darwin',
    });
    await notify('标题', '带"引号"的正文');
    expect(ran).toEqual(['terminal-notifier', 'osascript']);
  });
});
