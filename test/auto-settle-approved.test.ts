// 已批闸门静默收口（wf_be61c3a55842 缺陷二，2026-10-09）：adhoc/nodes 单
// 「闸已批+全链终态」后 agent 回流执行（organic 回合）跑完即自动 settle——
// 此前唯一路径是 agent 自己 POST settle，实测被其会话权限层拦截
// （wf_e62eff8ddba1「by=operator 属冒用操作员身份」），单子永远挂 running。
// 守卫面：全终态/非问询已批闸/无未送达回流/事件静默超阈值（5 分钟）。

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime } from '../src/runtime.ts';
import type { JsonValue } from '../src/platform/shared/json.ts';

/** 一张「agent 已完成 + 闸门已批」的 nodes 单（时间戳默认 10 分钟前——
 * 静默判据①过线）。gateAt/agentAt 传 'now' 造新鲜事件测静默守卫。 */
const makeApprovedRun = (
  rt: ReturnType<typeof createRuntime>,
  o: { gateInput?: Record<string, JsonValue>; gateStatus?: string; mode?: string; staleMin?: number; withRelay?: boolean } = {},
): string => {
  const staleMin = o.staleMin ?? 10;
  const shift = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();
  const w = rt.store.createWorkflow({
    kind: 'adhoc', title: '回流执行单', status: 'running',
    meta: { mode: o.mode ?? 'nodes' },
  });
  rt.store.db.prepare('UPDATE workflows SET session=?, created_at=?, updated_at=? WHERE id=?')
    .run('juli-a', shift(staleMin + 30), shift(staleMin), w.id);
  const st = rt.store.createStep({ workflowId: w.id, seq: 1, kind: 'agent', title: '理解与接单' });
  rt.store.db.prepare('UPDATE workflow_steps SET status=?, started_at=?, updated_at=? WHERE id=?')
    .run('completed', shift(staleMin + 20), shift(staleMin + 10), st.id);
  const g = rt.store.createStep({
    workflowId: w.id, seq: 2, kind: 'gate', title: '确认闸门',
    input: o.gateInput ?? { delivery: 'apply' },
  });
  rt.store.db.prepare('UPDATE workflow_steps SET status=?, started_at=?, updated_at=? WHERE id=?')
    .run(o.gateStatus ?? 'completed', shift(staleMin + 5), shift(staleMin), g.id);
  // 事件链：闸门批准留痕 + 回流回合 turn_done（ts 均造 staleMin 分钟前）。
  rt.store.appendEvent('workflow', w.id, 'gate_approved', { note: '', by: 'iphone' });
  rt.store.appendEvent('workflow', w.id, 'session_turn', { session: 'juli-a', event: 'turn_done' });
  rt.store.db.prepare(
    `UPDATE events SET ts=? WHERE entity_type='workflow' AND entity_id=?`,
  ).run(shift(staleMin), w.id);
  if (o.withRelay === true) {
    rt.store.insertRelay({
      workflowId: w.id, stepId: g.id, session: 'juli-a',
      text: '[relay:xx] [闸门已批准] …', marker: '[relay:xx]',
    });
  }
  return w.id;
};

const statusOf = (rt: ReturnType<typeof createRuntime>, id: string): string =>
  rt.store.getWorkflow(id)?.status ?? '';

describe('autoSettleApprovedRuns 已批闸门静默收口', () => {
  it('闸已批+全终态+事件静默超阈值 → settle（by=auto-approve 留痕）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-asapr-'));
    try {
      const rt = createRuntime(configSchema.parse({ data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-asa' }));
      const wid = makeApprovedRun(rt);
      const n = await rt.engine.autoSettleApprovedRuns();
      expect(n).toBe(1);
      expect(statusOf(rt, wid)).toBe('completed');
      const settled = rt.store.entityEvents('workflow', wid, 'run_settled', 5);
      expect(settled.length).toBe(1);
      expect(String(settled[0]!.payload['by'])).toBe('auto-approve');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('事件新鲜（回流回合刚结束）→ 不收——静默判据①', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-asapr2-'));
    try {
      const rt = createRuntime(configSchema.parse({ data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-asa' }));
      const wid = makeApprovedRun(rt, { staleMin: -10 }); // 未来时间戳 = 距今 -10 分钟 = 新鲜
      await rt.engine.autoSettleApprovedRuns();
      expect(statusOf(rt, wid)).toBe('running');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('会话用量行还在涨（事件静默但 agent 仍在执行）→ 不收——静默判据②', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-asapr3-'));
    try {
      const rt = createRuntime(configSchema.parse({ data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-asa' }));
      const wid = makeApprovedRun(rt); // 事件链 10 分钟前
      const udb = new DatabaseSync(join(dir, 'prompt_usage.db'));
      udb.prepare(`INSERT INTO prompt_usage (source, note, model, input_tokens, output_tokens, cached_tokens, duration_ms, error, created_at, tmux_session)
        VALUES ('claude_code', '', 'glm-5.3', 100, 10, 0, 0, '', ?, 'juli-a')`)
        .run(new Date().toISOString()); // 用量行 = 现在：长任务 turn 仍在产出行
      udb.close();
      await rt.engine.autoSettleApprovedRuns();
      expect(statusOf(rt, wid)).toBe('running');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('闸门还在等人（waiting_human）→ 不收；问询闸（answer）已答也不算批准依据', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-asapr4-'));
    try {
      const rt = createRuntime(configSchema.parse({ data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-asa' }));
      const waiting = makeApprovedRun(rt, { gateStatus: 'waiting_human' });
      const answer = makeApprovedRun(rt, { gateInput: { delivery: 'answer', question_options: ['a', 'b'] } });
      await rt.engine.autoSettleApprovedRuns();
      expect(statusOf(rt, waiting)).toBe('running');
      expect(statusOf(rt, answer)).toBe('running');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('回流指令未送达（pendingRelays）→ 不收；ladder 单不在收口面 → 不收', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-asapr5-'));
    try {
      const rt = createRuntime(configSchema.parse({ data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-asa' }));
      const relayed = makeApprovedRun(rt, { withRelay: true });
      const ladder = makeApprovedRun(rt, { mode: 'flow' });
      await rt.engine.autoSettleApprovedRuns();
      expect(statusOf(rt, relayed)).toBe('running');
      expect(statusOf(rt, ladder)).toBe('running');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('幂等：已终态单不重复收口', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-asapr6-'));
    try {
      const rt = createRuntime(configSchema.parse({ data_dir: dir, claude_dir: join(dir, 'claude'), password: 'pw-asa' }));
      makeApprovedRun(rt);
      expect(await rt.engine.autoSettleApprovedRuns()).toBe(1);
      expect(await rt.engine.autoSettleApprovedRuns()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
