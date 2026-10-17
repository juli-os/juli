// 语义判定场景注册表（R8 批4 刀1，自 runtime.ts 组合根下放）：runtime 此前
// 长着的两段判定本体——alert_grade（推送告警分级降噪）与 task_tier（进件
// 无键路径的难度分档）。场景定义（choice 型 prompt 判据全文）、judgment_made
// 留痕事件形状与采用闸全部在此；runtime 只注入 judgmentGateway + 账本 +
// 日志（判定本体下放后可脱离组合根直测，公开投影 overlay 桩零涉及——本
// 模块只依赖 npm 包类型）。判据文本与采用口径一字未改：全链行为由
// test/model-tier.test.ts（createRuntime 真口）钉死，本体直测由
// test/judgment-scenarios.test.ts 钉死。

import type { JudgmentGateway, JudgmentOutcome } from '@juli-os/routing';
import type { LifecycleStore } from '@juli-os/ledger';

/** 场景装配依赖：判定网关（ask）+ judgment 流留痕 + 日志。 */
export interface JudgmentScenarioDeps {
  readonly judgment: JudgmentGateway;
  readonly store: Pick<LifecycleStore, 'appendEvent'>;
  readonly log: { readonly info: (msg: string) => void };
}

/** judgment_made 留痕事件形状（alert_grade/task_tier 同款——shadow 期的
 * 观察面与离线对账源；字段序即留痕 schema，两场景不得各自漂移）。 */
export const judgmentEventOf = (scenario: string, outcome: JudgmentOutcome) => ({
  scenario, mode: outcome.mode, provider: outcome.provider,
  ok: outcome.ok === true, answer: outcome.answer ?? '', confidence: outcome.confidence ?? 0,
  threshold: outcome.threshold, error: outcome.error ?? '',
  model: outcome.model ?? '', input_tokens: outcome.inputTokens ?? 0,
  output_tokens: outcome.outputTokens ?? 0, duration_ms: outcome.durationMs ?? 0,
});

/** alert_grade 判定本体：true=照推，false=info 静默（降噪）。只在 mode=on 且
 * 高置信 info 时静默；网关未装配/场景 off（ask→null）、判定链挂（ok=false）、
 * 其余档位一律照推——分级挂了绝不吞通知。留痕不裹 try/catch（推送路径本就
 * fire-and-forget，留痕抛错沿 grade 面上抛=照推，与 task_tier 的容留痕语义
 * 刻意不同）。 */
export const makeGradeAlert = (deps: JudgmentScenarioDeps) =>
  async (title: string, body: string): Promise<boolean> => {
    const outcome = await deps.judgment.ask('alert_grade',
      { title, body: body.slice(0, 300) },
      {
        severity: {
          type: 'choice',
          instructions: 'Grade this system alert for an operator: critical needs immediate action, warning should be seen soon, info is routine noise.',
          criteria: {
            critical: 'Failure/stuck/loss of customer-facing capability — act now.',
            warning: 'Degraded but self-healing or bounded — check soon.',
            info: 'Routine/status noise — no action needed.',
          },
        },
      });
    if (outcome === null) return true;
    deps.store.appendEvent('judgment', `alert_grade:${title.slice(0, 24)}`, 'judgment_made',
      judgmentEventOf('alert_grade', outcome));
    if (outcome.mode === 'on' && outcome.ok && outcome.answer === 'info'
        && (outcome.confidence ?? 0) >= outcome.threshold) {
      deps.log.info(`[judgment] alert_grade 降噪：${title}（info@${(outcome.confidence ?? 0).toFixed(2)}）`);
      return false;
    }
    return true;
  };

/** task_tier 判定本体（2026-10-12「按任务类型选模型」）：进件无键路径的难度
 * 分类。采用口径与 routeTask 的 menuHit 同构（mode=on + ok + answer + 置信度
 * ≥阈值），shadow 期只记账不采用；判不准 = standard（成本纪律：花便宜的
 * 钱）。判定留痕 judgment 流（gradeAlert 同款）——留痕失败不阻断档位判定。 */
export const makeTaskTier = (deps: JudgmentScenarioDeps) =>
  async (title: string, brief: string): Promise<'high' | null> => {
    const outcome = await deps.judgment.ask('task_tier',
      { title, brief: brief.slice(0, 600) },
      {
        tier: {
          type: 'choice',
          instructions: 'Does this task need the high-intelligence model tier, or is the standard tier enough? The high tier costs several times more — default to standard unless the task clearly demands depth.',
          criteria: {
            standard: 'Routine, well-scoped work: content edits, translations, data lookups and simple reports, formatting, scripts with clear specs, straightforward fixes. The standard model handles these reliably and much cheaper.',
            high: 'Genuinely hard work: multi-file architecture changes with subtle interactions, debugging with unclear cause, novel design decisions with trade-offs, security-sensitive changes, cross-system integration with hidden failure modes, heavy reasoning over images or unstructured data.',
          },
        },
      });
    if (outcome === null) return null;
    try {
      deps.store.appendEvent('judgment', `task_tier:${title.slice(0, 24)}`, 'judgment_made',
        judgmentEventOf('task_tier', outcome));
    } catch { /* 留痕失败不阻断档位判定 */ }
    if (!outcome.ok || outcome.mode !== 'on' || outcome.answer !== 'high') return null;
    return (outcome.confidence ?? 0) >= outcome.threshold ? 'high' : null;
  };
