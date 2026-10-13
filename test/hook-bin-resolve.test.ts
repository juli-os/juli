// hook 入口解析围栏（2026-10-11 dist 清失事故的核心一行 src/runtime.ts:1042）：
// 引擎注入 CC hooks 时数据卷 bin（<data_dir>/bin/juli，juli setup 维护）优先，
// 缺席回退 checkout 内构建产物入口（vitest 形态 import.meta 在 src/ →
// src/cli/hook.ts）。两条不变量：注入命令必须打解析出的路径；注入日志必须带
// 实际路径（bin 缺席回退 / 陈旧 bin 服役的第一现场）。
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime } from '../src/runtime.ts';
import type { Logger } from '../src/platform/events/bus.ts';

const captureLogger = (): { lines: string[]; logger: Logger } => {
  const lines: string[] = [];
  return { lines, logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) } };
};

type Settings = { hooks?: Record<string, { hooks?: { command?: string }[] }[]> };
const injectedCommand = (claudeDir: string): string => {
  const s = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')) as Settings;
  return (s.hooks?.Stop ?? []).flatMap((g) => g?.hooks ?? []).map((h) => h.command ?? '').find((c) => c !== '') ?? '';
};

describe('引擎 CC hooks 注入的 hook 入口解析（数据卷 bin 优先，缺席回退 dist 入口）', () => {
  it('bin 缺席且 checkout 入口也不在（vitest/dist 未构建形态）：拒绝注入死路径，错误日志带解析出的回退路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-hookbin-'));
    const { lines, logger } = captureLogger();
    const claudeDir = join(dir, 'claude');
    mkdirSync(claudeDir, { recursive: true });
    let rt: ReturnType<typeof createRuntime> | null = null;
    try {
      rt = createRuntime(configSchema.parse({ data_dir: dir, claude_dir: claudeDir, password: 'pw-hookbin' }), {}, logger);
      rt.start();
      // bin 缺席 → 回退臂解析到 checkout 内 cli/hook.*；该文件不在（等价 dist
      // 被清的事故形态）→ 注入跳过 + 路径上日志（0923「注入死路径」守卫）。
      expect(lines.some((l) => l.includes('CC hooks 注入跳过') && l.includes('/cli/hook.') && l.includes('npm run build'))).toBe(true);
      expect(lines.some((l) => l.includes('CC hooks 已注入'))).toBe(false);
      expect(existsSync(join(claudeDir, 'settings.json'))).toBe(false);
    } finally {
      rt?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bin 在位：注入命令指向 <data_dir>/bin/juli（与 checkout 解耦），日志同名', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-hookbin-'));
    const { lines, logger } = captureLogger();
    const claudeDir = join(dir, 'claude');
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'juli'), '#!/usr/bin/env node\n');
    let rt: ReturnType<typeof createRuntime> | null = null;
    try {
      rt = createRuntime(configSchema.parse({ data_dir: dir, claude_dir: claudeDir, password: 'pw-hookbin' }), {}, logger);
      rt.start();
      const bin = `${dir}/bin/juli`;
      expect(injectedCommand(claudeDir)).toContain(bin);
      expect(lines.some((l) => l.includes('CC hooks 已注入') && l.includes(`hook=${bin}`))).toBe(true);
    } finally {
      rt?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
