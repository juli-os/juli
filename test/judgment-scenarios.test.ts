// 判定场景本体直测（R8 批4 刀1 随下放补齐）：runtime 时代 gradeAlert/taskTier
// 只能靠 createRuntime 全链（model-tier.test.ts 覆盖 taskTier；gradeAlert 采用
// 闸零直测）——本体进 business/workflow/judgmentScenarios 后用假网关 + 真
// ledger 直钉：判据全文（prompt 判据一字不许变）、采用闸边界、留痕事件形状、
// 两场景留痕容错语义差异（taskTier 容留痕失败 / gradeAlert 上抛）。

import { describe, expect, it } from 'vitest';
import { createLedgerStore, type LifecycleStore } from '@juli-os/ledger';
import type { JudgmentGateway, JudgmentOutcome } from '@juli-os/routing';
import {
  judgmentEventOf, makeGradeAlert, makeTaskTier, type JudgmentScenarioDeps,
} from '../src/business/workflow/judgmentScenarios.ts';

/** 假网关：固定回吐 outcome，同时捕获 ask 实参（判据全文的观测点）。 */
const gatewayOf = (outcome: JudgmentOutcome | null) => {
  const asks: { scenario: string; state: unknown; questions: Record<string, unknown> }[] = [];
  const judgment: JudgmentGateway = {
    threshold: () => 0.7,
    ask: async (scenario, state, questions) => {
      asks.push({ scenario, state, questions });
      return outcome;
    },
  };
  return { judgment, asks };
};

const outcome = (over: Partial<JudgmentOutcome> = {}): JudgmentOutcome => ({
  mode: 'on', ok: true, threshold: 0.7, answer: 'info', confidence: 0.9,
  provider: 'cli', ...over,
});

/** 真账本留痕面（judgment_made 事件断言用）+ 降噪日志捕获。 */
const harnessOf = (judgment: JudgmentGateway): JudgmentScenarioDeps & {
  store: LifecycleStore;
  lines: string[];
} => {
  const store = createLedgerStore(':memory:');
  const lines: string[] = [];
  return { judgment, store, log: { info: (m) => { lines.push(m); } }, lines };
};

/** 留痕面必炸的假依赖（appendEvent 抛 db locked）：钉 gradeAlert 上抛 /
 * taskTier 容错这对留痕语义分叉。 */
const throwingDepsOf = (judgment: JudgmentGateway): JudgmentScenarioDeps =>
  ({ judgment, store: { appendEvent: () => { throw new Error('db locked'); } }, log: { info: () => {} } });

describe('makeGradeAlert（alert_grade 判定本体）', () => {
  it('ask→null（场景 off/网关缺席）→ 照推且零留痕', async () => {
    const { judgment } = gatewayOf(null);
    const d = harnessOf(judgment);
    await expect(makeGradeAlert(d)('告警', '正文')).resolves.toBe(true);
    expect(d.store.listEvents(10, ['judgment_made'])).toHaveLength(0);
  });

  it('on + ok + info + 置信度达标 → false 静默 + judgment_made 留痕 + 降噪日志', async () => {
    const { judgment, asks } = gatewayOf(outcome());
    const d = harnessOf(judgment);
    await expect(makeGradeAlert(d)('例行噪音', 'x')).resolves.toBe(false);
    expect(asks[0]!.scenario).toBe('alert_grade');
    const evs = d.store.listEvents(10, ['judgment_made']);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.entityId).toBe('alert_grade:例行噪音');
    expect(evs[0]!.payload['scenario']).toBe('alert_grade');
    expect(evs[0]!.payload['mode']).toBe('on');
    expect(evs[0]!.payload['answer']).toBe('info');
    expect(d.lines[0]).toContain('[judgment] alert_grade 降噪');
  });

  it('on + critical / ok=false / 置信度不足 / shadow → 一律照推（fail-open，照推也留痕）', async () => {
    for (const o of [outcome({ answer: 'critical' }), outcome({ ok: false }), outcome({ confidence: 0.5 }), outcome({ mode: 'shadow' })]) {
      const { judgment } = gatewayOf(o);
      const d = harnessOf(judgment);
      await expect(makeGradeAlert(d)('t', 'b')).resolves.toBe(true);
      expect(d.store.listEvents(10, ['judgment_made'])).toHaveLength(1);
    }
  });

  it('判据全文钉死（choice prompt 逐字）+ state 截断 300', async () => {
    const { judgment, asks } = gatewayOf(outcome());
    const d = harnessOf(judgment);
    await makeGradeAlert(d)('t', 'x'.repeat(500));
    expect((asks[0]!.state as { body: string }).body).toHaveLength(300);
    const severity = asks[0]!.questions['severity'] as Record<string, unknown>;
    expect(severity['type']).toBe('choice');
    expect(severity['instructions']).toBe('Grade this system alert for an operator: critical needs immediate action, warning should be seen soon, info is routine noise.');
    expect(severity['criteria']).toEqual({
      critical: 'Failure/stuck/loss of customer-facing capability — act now.',
      warning: 'Degraded but self-healing or bounded — check soon.',
      info: 'Routine/status noise — no action needed.',
    });
  });

  it('留痕抛错上抛（无 try/catch——推送路径 fire-and-forget 面兜底=照推）', async () => {
    const { judgment } = gatewayOf(outcome());
    const d = throwingDepsOf(judgment);
    await expect(makeGradeAlert(d)('t', 'b')).rejects.toThrow('db locked');
  });
});

describe('makeTaskTier（task_tier 判定本体）', () => {
  it('ask→null → null 且零留痕', async () => {
    const { judgment } = gatewayOf(null);
    const d = harnessOf(judgment);
    await expect(makeTaskTier(d)('t', 'b')).resolves.toBeNull();
    expect(d.store.listEvents(10, ['judgment_made'])).toHaveLength(0);
  });

  it('on + high + 置信度达标 → high；standard/低置信/shadow/ok=false → null（采用与否都留痕）', async () => {
    const cases: readonly [JudgmentOutcome, 'high' | null][] = [
      [outcome({ answer: 'high' }), 'high'],
      [outcome({ answer: 'standard' }), null],
      [outcome({ answer: 'high', confidence: 0.5 }), null],
      [outcome({ answer: 'high', mode: 'shadow' }), null],
      [outcome({ answer: 'high', ok: false }), null],
    ];
    for (const [o, want] of cases) {
      const { judgment } = gatewayOf(o);
      const d = harnessOf(judgment);
      await expect(makeTaskTier(d)('t', 'b')).resolves.toBe(want);
      expect(d.store.listEvents(10, ['judgment_made'])).toHaveLength(1);
    }
  });

  it('留痕失败不阻断档位判定（try/catch 容错——与 gradeAlert 语义差异）', async () => {
    const { judgment } = gatewayOf(outcome({ answer: 'high' }));
    const d = throwingDepsOf(judgment);
    await expect(makeTaskTier(d)('t', 'b')).resolves.toBe('high');
  });

  it('判据全文钉死（choice prompt 逐字）+ state 截断 600', async () => {
    const { judgment, asks } = gatewayOf(outcome({ answer: 'high' }));
    const d = harnessOf(judgment);
    await makeTaskTier(d)('t', 'x'.repeat(900));
    expect((asks[0]!.state as { brief: string }).brief).toHaveLength(600);
    const tier = asks[0]!.questions['tier'] as Record<string, unknown>;
    expect(tier['type']).toBe('choice');
    expect(tier['instructions']).toBe('Does this task need the high-intelligence model tier, or is the standard tier enough? The high tier costs several times more — default to standard unless the task clearly demands depth.');
    expect(tier['criteria']).toEqual({
      standard: 'Routine, well-scoped work: content edits, translations, data lookups and simple reports, formatting, scripts with clear specs, straightforward fixes. The standard model handles these reliably and much cheaper.',
      high: 'Genuinely hard work: multi-file architecture changes with subtle interactions, debugging with unclear cause, novel design decisions with trade-offs, security-sensitive changes, cross-system integration with hidden failure modes, heavy reasoning over images or unstructured data.',
    });
  });
});

describe('judgmentEventOf（judgment_made 事件形状）', () => {
  it('12 字段全集 + 缺省收口（answer/confidence/token 用量兜底）', () => {
    const ev = judgmentEventOf('task_tier', {
      mode: 'shadow', ok: false, threshold: 0.7, provider: 'cloud', error: 'boom',
    });
    expect(ev).toEqual({
      scenario: 'task_tier', mode: 'shadow', provider: 'cloud', ok: false,
      answer: '', confidence: 0, threshold: 0.7, error: 'boom',
      model: '', input_tokens: 0, output_tokens: 0, duration_ms: 0,
    });
  });
});
