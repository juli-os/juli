// CC transcript 摄取定时器出错不再静默（2026-11-23 全量审查，问题 4）。
// 此前 usageIngest.ts 的 `try { … } catch { /* 目录缺失容忍 */ }` 把整段都包了
// 进去：终端名单、映射登记（写库）、重放判定、摄取。任何一步出错都被当成
// 「目录不存在」吞掉，日志里没有痕迹。这个 catch 最早只包摄取一行；后来
// （wf_9658ce9225e0）往 try 里加了写库，容忍范围没跟着收窄。
//
// 现在：只有「文件/目录不存在」（ENOENT）才容忍，其余错误记 error。

import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TmuxClient } from '@juli-os/agents';
import type { UsageStore } from '@juli-os/ledger';
import { ok } from '../src/platform/shared/result.ts';
import { startUsageIngestTimers } from '../src/business/workflow/usageIngest.ts';

/** 「文件/目录不存在」形态的错误。 */
const enoent = (what: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`ENOENT: no such file or directory, ${what}`), { code: 'ENOENT' });

type World = {
  readonly errors: string[];
  readonly recorded: string[];
  run: () => Promise<void>;
  cleanup: () => void;
};

/** 起一轮摄取：claude/projects 下有一个 transcript，tmux 后端有一个 cwd 对得
 * 上的会话——所以每轮都会走到「映射登记写库」那一步。 */
const make = (over: {
  recordClaudeSession?: UsageStore['recordClaudeSession'];
  listSessionsDetailed?: TmuxClient['listSessionsDetailed'];
}): World => {
  const dir = mkdtempSync(join(tmpdir(), 'juli-usage-ingest-'));
  const claudeDir = join(dir, 'claude');
  mkdirSync(join(claudeDir, 'projects', '-w'), { recursive: true });
  writeFileSync(join(claudeDir, 'projects', '-w', 'sess-1.jsonl'), '{}\n');
  const errors: string[] = [];
  const recorded: string[] = [];
  const timers = startUsageIngestTimers({
    usage: {
      recordClaudeSession: over.recordClaudeSession ?? ((claudeId) => { recorded.push(claudeId); }),
      needsClaudeReplay: () => false,
      resetClaudeIngest: () => {},
      ingestProjectTranscripts: () => 0,
    },
    tmux: {
      listSessionsDetailed: over.listSessionsDetailed
        ?? (async () => ok([{ name: 'agent-a', attached: false, path: '/w', cmd: 'claude' }])),
      sessionBirthsOf: async () => new Map(),
    },
    agentBackend: { kind: 'tmux' },
    claudeDir,
    log: { info: () => {}, warn: () => {}, error: (m) => { errors.push(m); } },
  });
  return {
    errors,
    recorded,
    run: async () => { await vi.advanceTimersByTimeAsync(60_000); },
    cleanup: () => {
      for (const t of timers) clearInterval(t);
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

describe('usage 摄取定时器：出错要留日志', () => {
  it('映射登记写库抛错 → 记 error，不再被「目录缺失容忍」吞掉', async () => {
    vi.useFakeTimers();
    let w: World | null = null;
    try {
      w = make({
        recordClaudeSession: () => { throw new Error('SQLITE_BUSY: database is locked'); },
      });
      await w.run();
      expect(w.errors.some((m) => m.includes('SQLITE_BUSY'))).toBe(true);
    } finally {
      w?.cleanup();
      vi.useRealTimers();
    }
  });

  it('终端后端报其它错（不是 ENOENT）→ 记 error', async () => {
    vi.useFakeTimers();
    let w: World | null = null;
    try {
      w = make({
        listSessionsDetailed: async () => { throw new Error('pane list: workspace not found'); },
      });
      await w.run();
      expect(w.errors.some((m) => m.includes('workspace not found'))).toBe(true);
    } finally {
      w?.cleanup();
      vi.useRealTimers();
    }
  });

  it('错误是「文件/目录不存在」（ENOENT）→ 照旧容忍，不记日志', async () => {
    vi.useFakeTimers();
    let w: World | null = null;
    try {
      w = make({
        listSessionsDetailed: async () => { throw enoent('connect'); },
      });
      await w.run();
      expect(w.errors).toEqual([]);
    } finally {
      w?.cleanup();
      vi.useRealTimers();
    }
  });

  it('一切正常时照常登记映射、不记 error（行为没变）', async () => {
    vi.useFakeTimers();
    let w: World | null = null;
    try {
      w = make({});
      await w.run();
      expect(w.recorded).toEqual(['sess-1']);
      expect(w.errors).toEqual([]);
    } finally {
      w?.cleanup();
      vi.useRealTimers();
    }
  });
});
