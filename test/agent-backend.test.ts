// agent 终端后端接线（2026-11-04 herdr 下沉后的 service 消费面）：config 键、
// hook 命令组随 backend 换血（幂等清旧）、runtime 以 herdr 配置构造零 IO
// （createHerdrClient 懒连接——首用才触 socket）。适配层契约/工厂细节的
// 测试在 @juli-os/agents 包内（test/herdr-client / test/backend），这里只锚
// 引擎侧的接线事实。
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/platform/config/schema.ts';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime } from '../src/runtime.ts';
import { createAgentBackend, installClaudeHooks } from '@juli-os/agents';

describe('config：agent_backend / herdr_session（死键 tmux_mode 已撤）', () => {
  it('缺省 = tmux（live 零行为变化）+ namespace 默认 juli', () => {
    const cfg = loadConfig({ env: {}, home: '/home/test', readFile: () => null });
    expect(cfg.agent_backend).toBe('tmux');
    expect(cfg.herdr_session).toBe('juli');
    expect('tmux_mode' in cfg).toBe(false);
  });
  it('读文件接受 herdr；非法值被 zod 拒', () => {
    const cfg = loadConfig({
      env: {}, home: '/home/test',
      readFile: () => JSON.stringify({ agent_backend: 'herdr', herdr_session: 'juli-engine' }),
    });
    expect(cfg.agent_backend).toBe('herdr');
    expect(cfg.herdr_session).toBe('juli-engine');
    expect(() => loadConfig({
      env: {}, home: '/home/test',
      readFile: () => JSON.stringify({ agent_backend: 'screen' }),
    })).toThrow();
  });
});

describe('hook 命令组随 backend 换血（installClaudeHooks 幂等清旧）', () => {
  const tmuxSpecs = createAgentBackend({ backend: 'tmux' }).hookSpecs('/new/hook.js', 'pw', 'http://127.0.0.1:7070');
  const herdrSpecs = createAgentBackend({ backend: 'herdr' }).hookSpecs('/new/hook.js', 'pw', 'http://127.0.0.1:7070');

  it('两后端六事件同面；会话名解析随后端（display-message vs JULI_HERDR_SESSION）', () => {
    const events = ['Stop', 'SessionStart', 'PermissionRequest', 'UserPromptSubmit', 'Notification', 'PostToolUse'];
    expect(tmuxSpecs.map((s) => s.event)).toEqual(events);
    expect(herdrSpecs.map((s) => s.event)).toEqual(events);
    expect(tmuxSpecs[0]!.command).toContain('display-message');
    expect(herdrSpecs[0]!.command).not.toContain('display-message');
    expect(herdrSpecs[0]!.command).toContain('"$JULI_HERDR_SESSION"');
  });

  it('tmux 式 juli 旧 hook 被清、herdr 新 hook 只剩一份、用户自有 hook 不动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-hooks-'));
    try {
      const settings = join(dir, 'settings.json');
      writeFileSync(settings, JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: `JULI_SERVICE_URL='http://127.0.0.1:7070' node /old/hook.js notify "$(tmux display-message -p '#{session_name}')" done` }] },
            { hooks: [{ type: 'command', command: 'echo user-own-hook' }] },
          ],
        },
      }));
      const res = installClaudeHooks(dir, herdrSpecs);
      expect(res.ok).toBe(true);
      const after = JSON.parse(readFileSync(settings, 'utf8')) as {
        hooks: { Stop: { hooks: { command: string }[] }[] };
      };
      const commands = after.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
      expect(commands.some((c) => c.includes('user-own-hook'))).toBe(true);
      expect(commands.filter((c) => c.includes('JULI_HERDR_SESSION')).length).toBe(1);
      expect(commands.some((c) => c.includes('display-message'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同后端 specs 连注两次 → hook 恰一份（引擎重启的真实路径，R2 #5）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-hooks-idem-'));
    try {
      expect(installClaudeHooks(dir, herdrSpecs).ok).toBe(true);
      expect(installClaudeHooks(dir, herdrSpecs).ok).toBe(true);
      const after = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
        hooks: { Stop: { hooks: { command: string }[] }[] };
      };
      const commands = after.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
      expect(commands.filter((c) => c.includes('JULI_HERDR_SESSION')).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runtime：agent_backend=herdr 构造零 IO（懒连接）', () => {
  it('createRuntime 构造不触 socket、不抛（herdr server 缺席也不炸）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-backend-rt-'));
    mkdirSync(join(dir, '.claude'), { recursive: true });
    try {
      const cfg = configSchema.parse({ data_dir: dir, agent_backend: 'herdr', claude_dir: join(dir, '.claude') });
      const rt = createRuntime(cfg, {});
      expect(rt).toBeTruthy();
      // tmux 默认分支同场对照（零行为变化）。
      const rt2 = createRuntime(configSchema.parse({ data_dir: dir, claude_dir: join(dir, '.claude') }), {});
      expect(rt2).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
