// 详情页 promptStats 归属（十四跑 R1 P2-1）：转派/改道单（meta.assigned_session）
// 的回合落在实际执行会话名下——双键聚合后计数非零；步窗口外回合不计；双键不双计。

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime } from '../src/runtime.ts';
import { createHttpApp } from '../src/http/app.ts';

const insertTurn = (db: DatabaseSync, session: string, input: number, output: number, at: string): void => {
  db.prepare(`INSERT INTO prompt_usage (source, note, model, input_tokens, output_tokens, cached_tokens, duration_ms, error, created_at, tmux_session)
    VALUES ('claude_code', '', 'claude-test', ?, ?, 0, 0, '', ?, ?)`).run(input, output, at, session);
};

describe('GET /api/lifecycle/workflows/:id promptStats（P2-1 双键归属）', () => {
  it('转派单：session=juli-a、assigned=juli-b——执行会话 juli-b 的窗内回合计数，窗外不计，无双计', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-pstat-'));
    try {
      const rt = createRuntime(configSchema.parse({
        data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-ps',
      }));
      const app = createHttpApp(rt);
      const w = rt.store.createWorkflow({
        kind: 'adhoc', title: '转派单', meta: { assigned_session: 'juli-b' },
      });
      rt.store.db.prepare('UPDATE workflows SET session=? WHERE id=?').run('juli-a', w.id);
      // agent 步窗口 [01:00, 02:00]
      const st = rt.store.createStep({ workflowId: w.id, seq: 1, kind: 'agent', title: '执行' });
      rt.store.db.prepare('UPDATE workflow_steps SET started_at=?, updated_at=? WHERE id=?')
        .run('2026-10-05T01:00:00Z', '2026-10-05T02:00:00Z', st.id);
      const udb = new DatabaseSync(join(dir, 'prompt_usage.db'));
      insertTurn(udb, 'juli-b', 100, 10, '2026-10-05T01:10:00.000Z'); // 执行会话窗内
      insertTurn(udb, 'juli-b', 200, 20, '2026-10-05T01:20:00.000Z'); // 执行会话窗内
      insertTurn(udb, 'juli-b', 400, 40, '2026-10-05T03:30:00.000Z'); // 窗外：不计
      insertTurn(udb, 'juli-a', 500, 50, '2026-10-05T01:40:00.000Z'); // 原会话窗内（双键另一臂）
      const res = await app.request(`/api/lifecycle/workflows/${w.id}`, {
        headers: { authorization: 'Bearer pw-ps' },
      });
      expect(res.status).toBe(200);
      const d = await res.json() as { promptStats: { count: number; inputTokens: number; outputTokens: number } };
      // 修复前：单键只认 w.session=juli-a → count=1；修复后双键 → 3
      expect(d.promptStats).toEqual({ count: 3, inputTokens: 800, outputTokens: 80 });
      udb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('普通单（无 assigned_session）：行为与单键时代逐字一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-pstat2-'));
    try {
      const rt = createRuntime(configSchema.parse({
        data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-ps',
      }));
      const app = createHttpApp(rt);
      const w = rt.store.createWorkflow({ kind: 'adhoc', title: '普通单' });
      rt.store.db.prepare('UPDATE workflows SET session=? WHERE id=?').run('juli-a', w.id);
      const st = rt.store.createStep({ workflowId: w.id, seq: 1, kind: 'agent', title: '执行' });
      rt.store.db.prepare('UPDATE workflow_steps SET started_at=?, updated_at=? WHERE id=?')
        .run('2026-10-05T01:00:00Z', '2026-10-05T02:00:00Z', st.id);
      const udb = new DatabaseSync(join(dir, 'prompt_usage.db'));
      insertTurn(udb, 'juli-a', 100, 10, '2026-10-05T01:10:00.000Z');
      const res = await app.request(`/api/lifecycle/workflows/${w.id}`, {
        headers: { authorization: 'Bearer pw-ps' },
      });
      const d = await res.json() as { promptStats: { count: number; inputTokens: number } };
      expect(d.promptStats.count).toBe(1);
      expect(d.promptStats.inputTokens).toBe(100);
      udb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
