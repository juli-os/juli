// usage 账本核心函数回归网（十四跑 R1 P2-3）：perSessionWindows /
// latestInputTokens / needsClaudeReplay / resetClaudeIngest /
// recordClaudeSession（precise vs scan）/ ingest 归属链全是裸 SQL，
// 此前零测试。临时 db + 注入 now。
// claude_code 行经第二连接直插构造（UsageStore.record 端口不带
// tmux_session，直插是既有行形状的诚实构造，列集与 ingestFile 一致）。

import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageStore } from '../src/platform/ledger/usage.ts';

/** 与 ingestFile 插入形状一致的 claude_code 行直插。 */
const insertClaudeRow = (
  db: DatabaseSync,
  r: { session?: string; input?: number; output?: number; at: string },
): void => {
  db.prepare(`INSERT INTO prompt_usage (source, note, model, input_tokens, output_tokens, cached_tokens, duration_ms, error, created_at, tmux_session)
    VALUES ('claude_code', '', 'claude-test', ?, ?, 0, 0, '', ?, ?)`)
    .run(r.input ?? 100, r.output ?? 10, r.at, r.session ?? '');
};

describe('perSessionWindows（步窗口并集聚合）', () => {
  it('多窗 OR 单 WHERE：重叠窗口不双计；他席行不计；空窗/无行零值', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-usage-win-'));
    try {
      const dbPath = join(dir, 'usage.db');
      const store = createUsageStore(dbPath);
      const db = new DatabaseSync(dbPath);
      insertClaudeRow(db, { session: 'juli-a', input: 10, output: 1, at: '2026-10-01T00:00:01.000Z' });
      insertClaudeRow(db, { session: 'juli-a', input: 20, output: 2, at: '2026-10-01T00:00:02.000Z' });
      insertClaudeRow(db, { session: 'juli-b', input: 40, output: 4, at: '2026-10-01T00:00:02.000Z' }); // 他席
      insertClaudeRow(db, { session: 'juli-a', input: 80, output: 8, at: '2026-10-02T00:00:00.000Z' }); // 窗外
      // 两窗重叠在 00:00:02 那行——OR 并集只计一次
      expect(store.perSessionWindows('juli-a', [
        ['2026-10-01T00:00:00.000Z', '2026-10-01T00:00:02.000Z'],
        ['2026-10-01T00:00:02.000Z', '2026-10-01T00:00:03.000Z'],
      ])).toEqual({ count: 2, inputTokens: 30, outputTokens: 3 });
      expect(store.perSessionWindows('juli-c', [['2026-10-01T00:00:00.000Z', '2026-10-01T00:00:03.000Z']]))
        .toEqual({ count: 0, inputTokens: 0, outputTokens: 0 });
      expect(store.perSessionWindows('juli-a', [])).toEqual({ count: 0, inputTokens: 0, outputTokens: 0 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('latestInputTokens（context 门 compact 判据）', () => {
  it('取最新一回合（id 最大）的 input；他席/无记录为 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-usage-lit-'));
    try {
      const dbPath = join(dir, 'usage.db');
      const store = createUsageStore(dbPath);
      const db = new DatabaseSync(dbPath);
      expect(store.latestInputTokens('juli-a')).toBe(0);
      insertClaudeRow(db, { session: 'juli-a', input: 111, at: '2026-10-01T00:00:01.000Z' });
      insertClaudeRow(db, { session: 'juli-a', input: 222, at: '2026-10-01T00:00:02.000Z' });
      insertClaudeRow(db, { session: 'juli-b', input: 999, at: '2026-10-01T00:00:03.000Z' });
      expect(store.latestInputTokens('juli-a')).toBe(222);
      expect(store.latestInputTokens('juli-b')).toBe(999);
      expect(store.latestInputTokens('juli-zz')).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('needsClaudeReplay / resetClaudeIngest（含十四跑 R1 P1-2 冷却）', () => {
  it('50% 边界：恰好过半空归属不触发；空归属过半且映射在场才触发；无映射不触发', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-usage-replay-'));
    try {
      const dbPath = join(dir, 'usage.db');
      let fakeNow = new Date('2026-10-05T00:00:00.000Z');
      const store = createUsageStore(dbPath, () => fakeNow);
      const db = new DatabaseSync(dbPath);
      // 无映射（claude_sessions 0 行）：即使全空也不触发
      insertClaudeRow(db, { session: '', input: 1, at: '2026-10-04T00:00:00.000Z' });
      insertClaudeRow(db, { session: '', input: 1, at: '2026-10-04T00:00:01.000Z' });
      expect(store.needsClaudeReplay()).toBe(false);
      // 有映射：4 行 2 空 → filled*2 = 4，不小于 total=4 → 恰好一半不触发
      db.prepare(`INSERT INTO claude_sessions (claude_session_id, tmux_session) VALUES ('c1', 'juli-a')`).run();
      insertClaudeRow(db, { session: 'juli-a', input: 1, at: '2026-10-04T00:00:02.000Z' });
      insertClaudeRow(db, { session: 'juli-a', input: 1, at: '2026-10-04T00:00:03.000Z' });
      expect(store.needsClaudeReplay()).toBe(false);
      // 5 行 3 空：filled*2 = 4 < 5 → 触发
      insertClaudeRow(db, { session: '', input: 1, at: '2026-10-04T00:00:04.000Z' });
      expect(store.needsClaudeReplay()).toBe(true);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P1-2 冷却：重放后立即不再触发，24h 窗满恢复；重放只清 claude_code 行与 offset，映射/他源行保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-usage-cool-'));
    try {
      const dbPath = join(dir, 'usage.db');
      const DAY = 86_400_000;
      let fakeNow = new Date('2026-10-05T00:00:00.000Z');
      const store = createUsageStore(dbPath, () => fakeNow);
      const db = new DatabaseSync(dbPath);
      db.prepare(`INSERT INTO claude_sessions (claude_session_id, tmux_session) VALUES ('c1', 'juli-a')`).run();
      db.prepare(`INSERT INTO claude_ingest_offset (claude_session_id, byte_offset, last_ingested_at) VALUES ('c1', 10, 'x')`).run();
      insertClaudeRow(db, { session: 'juli-a', input: 1, at: '2026-10-04T00:00:00.000Z' });
      insertClaudeRow(db, { session: '', input: 1, at: '2026-10-04T00:00:01.000Z' });
      insertClaudeRow(db, { session: '', input: 1, at: '2026-10-04T00:00:02.000Z' });
      store.record({ source: 'other', inputTokens: 7, outputTokens: 7 }); // 非 claude_code 行
      expect(store.needsClaudeReplay()).toBe(true);
      store.resetClaudeIngest();
      // reset 副作用先验：claude_code 清光、offset 清光、映射与他源行保留、标记落库
      const cc = db.prepare(`SELECT COUNT(*) AS c FROM prompt_usage WHERE source='claude_code'`).get() as { c: number };
      expect(Number(cc.c)).toBe(0);
      const off = db.prepare(`SELECT COUNT(*) AS c FROM claude_ingest_offset`).get() as { c: number };
      expect(Number(off.c)).toBe(0);
      const mp = db.prepare(`SELECT tmux_session FROM claude_sessions WHERE claude_session_id='c1'`).get() as { tmux_session: string };
      expect(mp.tmux_session).toBe('juli-a');
      const other = db.prepare(`SELECT input_tokens FROM prompt_usage WHERE source='other'`).get() as { input_tokens: number };
      expect(Number(other.input_tokens)).toBe(7);
      const mark = db.prepare(`SELECT value FROM usage_meta WHERE key='last_claude_replay_at'`).get() as { value: string };
      expect(Date.parse(mark.value)).not.toBeNaN();
      // 重放后：行已清空 → false；新回合继续累积（比率仍差），冷却期内依旧不触发
      expect(store.needsClaudeReplay()).toBe(false);
      insertClaudeRow(db, { session: 'juli-a', input: 1, at: '2026-10-05T00:10:00.000Z' });
      insertClaudeRow(db, { session: '', input: 1, at: '2026-10-05T00:10:01.000Z' });
      insertClaudeRow(db, { session: '', input: 1, at: '2026-10-05T00:10:02.000Z' });
      fakeNow = new Date(fakeNow.getTime() + DAY - 60_000);
      expect(store.needsClaudeReplay()).toBe(false);
      fakeNow = new Date(fakeNow.getTime() + 2 * 60_000); // 跨过 24h 冷却窗
      expect(store.needsClaudeReplay()).toBe(true); // 冷却窗满，比率仍差 → 次日再判（保留自愈）
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('recordClaudeSession / recordClaudeSessionPrecise（映射读写序）', () => {
  it('兜底只填空白行：precise 在先 scan 不抢；scan 在先二次 scan 也不抢', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-usage-map-'));
    try {
      const dbPath = join(dir, 'usage.db');
      const store = createUsageStore(dbPath);
      const db = new DatabaseSync(dbPath);
      store.recordClaudeSessionPrecise('c1', 'juli-a');
      store.recordClaudeSession('c1', 'juli-b', '/t/c1.jsonl', '/w'); // scan 不抢 precise
      let row = db.prepare(`SELECT tmux_session FROM claude_sessions WHERE claude_session_id='c1'`).get() as { tmux_session: string };
      expect(row.tmux_session).toBe('juli-a');
      store.recordClaudeSession('c2', 'juli-x', '/t/c2.jsonl', '/w');
      store.recordClaudeSession('c2', 'juli-y', '/t/c2.jsonl', '/w'); // 同 cwd 多会话/二次扫描不互相抢
      row = db.prepare(`SELECT tmux_session FROM claude_sessions WHERE claude_session_id='c2'`).get() as { tmux_session: string };
      expect(row.tmux_session).toBe('juli-x');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('precise 覆盖既有映射；未登记过的插占位行（空路径空 cwd）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-usage-prec-'));
    try {
      const dbPath = join(dir, 'usage.db');
      const store = createUsageStore(dbPath);
      const db = new DatabaseSync(dbPath);
      store.recordClaudeSession('c3', 'juli-x', '/t/c3.jsonl', '/w');
      store.recordClaudeSessionPrecise('c3', 'juli-z'); // 精确来源可覆盖
      const row3 = db.prepare(`SELECT tmux_session FROM claude_sessions WHERE claude_session_id='c3'`).get() as { tmux_session: string };
      expect(row3.tmux_session).toBe('juli-z');
      store.recordClaudeSessionPrecise('c4', 'juli-z'); // hook 先于扫描：占位行
      const row4 = db.prepare(`SELECT tmux_session, transcript_path, cwd FROM claude_sessions WHERE claude_session_id='c4'`).get() as { tmux_session: string; transcript_path: string; cwd: string };
      expect(row4.tmux_session).toBe('juli-z');
      expect(row4.transcript_path).toBe('');
      expect(row4.cwd).toBe('');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recordClaudeSession：空 session id / 空 transcript 路径 no-op', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-usage-noop-'));
    try {
      const dbPath = join(dir, 'usage.db');
      const store = createUsageStore(dbPath);
      const db = new DatabaseSync(dbPath);
      store.recordClaudeSession('', 'juli-a', '/t/x.jsonl', '/w');
      store.recordClaudeSession('c5', 'juli-a', '', '/w');
      const c = db.prepare('SELECT COUNT(*) AS c FROM claude_sessions').get() as { c: number };
      expect(Number(c.c)).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ingestProjectTranscripts（归属链 + offset 续传）', () => {
  it('映射在场回合带 tmux_session；未映射 transcript 留空归属；offset 续传不重读', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-usage-ing-'));
    try {
      const dbPath = join(dir, 'usage.db');
      const store = createUsageStore(dbPath);
      const db = new DatabaseSync(dbPath);
      const projDir = join(dir, 'projects', '-tmp-w');
      mkdirSync(projDir, { recursive: true });
      const line = (uuid: string): string => JSON.stringify({
        type: 'assistant', uuid, timestamp: '2026-10-05T01:00:00.000Z',
        message: { model: 'claude-test', usage: { input_tokens: 10, output_tokens: 5 } },
      });
      writeFileSync(join(projDir, 'c9.jsonl'), `${line('u1')}\n${line('u2')}\n`);
      // 噪声行（非 assistant）不被摄取
      writeFileSync(join(projDir, 'c10.jsonl'), `${JSON.stringify({ type: 'user', message: {} })}\n`);
      // 未映射 transcript：照常摄取，归属留空（待登记后的新回合补齐）
      writeFileSync(join(projDir, 'c11.jsonl'), `${line('u3')}\n`);
      store.recordClaudeSession('c9', 'juli-a', join(projDir, 'c9.jsonl'), '/tmp/w');
      const n1 = store.ingestProjectTranscripts(join(dir, 'projects'));
      expect(n1).toBe(3); // c9 两回合 + c11 一回合；c10 无 assistant 用量行不计
      const rows = db.prepare(`SELECT tmux_session, input_tokens FROM prompt_usage WHERE source='claude_code' ORDER BY id`).all() as { tmux_session: string; input_tokens: number }[];
      expect(rows).toHaveLength(3);
      // 不依赖目录枚举序：按归属分组断言
      expect(rows.filter((r) => r.tmux_session === 'juli-a')).toHaveLength(2); // 映射在场 → 精确归属
      expect(rows.filter((r) => r.tmux_session === '')).toHaveLength(1); // 未映射 → 留空
      for (const r of rows) expect(Number(r.input_tokens)).toBe(10);
      // offset 续传：文件没新增量 → 零重复行
      const n2 = store.ingestProjectTranscripts(join(dir, 'projects'));
      expect(n2).toBe(0);
      const total = db.prepare(`SELECT COUNT(*) AS c FROM prompt_usage WHERE source='claude_code'`).get() as { c: number };
      expect(Number(total.c)).toBe(3);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
