// triage_classify 判定场景（2026-09-27 用户口令，jev 第三场景）：
// shadow=并排判定+对账留痕（LLM 全量抽取原样）；on+高置信=采纳判定答案
// +LLM 瘦身只写 summary/session；on+低置信/失败=拒绝采纳回退全量抽取。

import { describe, expect, it } from 'vitest';
import { type JudgmentGateway, type JudgmentOutcome } from '@juli-os/routing';
import { ladderEmail, makeEmail, makeEngine, until } from './helpers.ts';

const gw = (
  mode: 'shadow' | 'on',
  cat: { answer: string; confidence: number },
  rep: { answer: string; confidence: number },
  ok = true,
  align: { answer: string; confidence: number } = { answer: 'true', confidence: 0.95 },
): JudgmentGateway => ({
  threshold: () => 0.7,
  // 显式标注返回类型：两条 return 分支的 answers 形状不同，联合推断出的
  // optional 属性不满足 answers 的索引签名（tsc 门禁 TS2322，2026-09-27 审查）。
  ask: async (scenario): Promise<JudgmentOutcome | null> => {
    const base = { mode, threshold: 0.7, provider: 'test', model: 'jev-test', inputTokens: 7, outputTokens: 3, durationMs: 12 };
    if (!ok) return { ...base, ok: false, error: 'down' };
    if (scenario === 'align_needed') {
      return { ...base, ok: true, answer: align.answer, confidence: align.confidence, answers: { fidelity: align } };
    }
    return {
      ...base, ok: true,
      answer: cat.answer, confidence: cat.confidence,
      answers: { category: cat, needs_reply: rep },
    };
  },
});

const runTriageFlow = async (judgment?: JudgmentGateway) => {
  const w = makeEngine(judgment === undefined ? {} : { judgment });
  const wf = await ladderEmail(w.engine, makeEmail());
  await w.engine.advance(wf.id);
  const steps = w.store.stepsForWorkflow(wf.id);
  return {
    w, wf,
    triage: steps[0]!,
    events: w.store.listEvents(200),
    llm: w.llmCalls[0]!,
  };
};

describe('triage_classify 判定场景', () => {
  it('shadow → LLM 全量抽取原样 + triage_judgment 对账留痕（含一致旗与用量）', async () => {
    const { triage, events, llm } = await runTriageFlow(
      gw('shadow', { answer: '任务', confidence: 0.9 }, { answer: 'true', confidence: 0.9 }));
    expect(llm.system).toContain('邮件信息抽取'); // 影子不动 LLM 提示词
    expect(triage.status).toBe('completed');
    expect(triage.output['category']).toBe('任务'); // 来自 LLM
    const ev = events.find((e) => e.type === 'triage_judgment');
    expect(ev).toBeDefined();
    expect(ev!.payload['mode']).toBe('shadow');
    expect(ev!.payload['jev_category']).toBe('任务');
    expect(ev!.payload['llm_category']).toBe('任务');
    expect(ev!.payload['agree_category']).toBe(true);
    expect(ev!.payload['agree_needs_reply']).toBe(true);
    expect(ev!.payload['input_tokens']).toBe(7);
    expect(ev!.payload['model']).toBe('jev-test');
  });

  it('on + 双题过阈值 → 采纳判定答案 + LLM 瘦身只写 summary/session', async () => {
    const { triage, events, llm } = await runTriageFlow(
      gw('on', { answer: '咨询', confidence: 0.9 }, { answer: 'false', confidence: 0.9 }));
    expect(llm.system).toContain('邮件摘要助手'); // 瘦身提示词（判定已答分类/回复）
    expect(llm.system).not.toContain('邮件信息抽取');
    expect(triage.output['category']).toBe('咨询'); // 来自判定，非 LLM
    expect(triage.output['needs_reply']).toBe(false);
    const ev = events.find((e) => e.type === 'triage_judgment_applied');
    expect(ev).toBeDefined();
    expect(ev!.payload['category']).toBe('咨询');
    expect(ev!.payload['needs_reply']).toBe('false');
  });

  it('on + 类别低于阈值 → 拒绝采纳，回退 LLM 全量抽取', async () => {
    const { triage, events, llm } = await runTriageFlow(
      gw('on', { answer: '咨询', confidence: 0.5 }, { answer: 'true', confidence: 0.9 }));
    expect(llm.system).toContain('邮件信息抽取'); // fail-open：全量提示词
    expect(triage.output['category']).toBe('任务'); // 来自 LLM
    const ev = events.find((e) => e.type === 'triage_judgment_rejected');
    expect(ev).toBeDefined();
    expect(ev!.payload['category_confidence']).toBe(0.5);
  });

  it('on + 判定失败 → 留痕 error，流程原样（fail-open 平凡）', async () => {
    const { triage, events, llm } = await runTriageFlow(
      gw('on', { answer: '咨询', confidence: 0.9 }, { answer: 'true', confidence: 0.9 }, false));
    expect(llm.system).toContain('邮件信息抽取');
    expect(triage.status).toBe('completed');
    const ev = events.find((e) => e.type === 'triage_judgment');
    expect(ev).toBeDefined();
    expect(ev!.payload['error']).toBe('down');
  });

  it('无网关（off）→ 零判定零留痕，行为与主干一致', async () => {
    const { triage, events } = await runTriageFlow(undefined);
    expect(triage.status).toBe('completed');
    expect(triage.output['category']).toBe('任务');
    expect(events.some((e) => e.type.startsWith('triage_judgment'))).toBe(false);
  });

  it('align_needed shadow → align_judgment 留痕；on+不忠实过阈值 → 闸门播种 align_flag', async () => {
    const shadow = await runTriageFlow(
      gw('shadow', { answer: '任务', confidence: 0.9 }, { answer: 'true', confidence: 0.9 }));
    expect(shadow.events.some((e) => e.type === 'align_judgment')).toBe(true);
    const flagged = await runTriageFlow(
      gw('on', { answer: '任务', confidence: 0.9 }, { answer: 'true', confidence: 0.9 }, true, { answer: 'false', confidence: 0.9 }));
    expect(flagged.events.some((e) => e.type === 'align_flagged')).toBe(true);
    const gate = flagged.w.store.stepsForWorkflow(flagged.wf.id)[1]!;
    expect(gate.input['align_flag']).toBe(true);
    expect(gate.input['align_confidence']).toBe(0.9);
  });

  it('output_quality：agent 停止后产出预检留痕（output_judgment/flagged）', async () => {
    const qualityGw: JudgmentGateway = {
      threshold: () => 0.7,
      ask: async (scenario) => ({
        mode: 'on', ok: true, threshold: 0.7, provider: 'test', model: 'jev-test',
        inputTokens: 7, outputTokens: 3, durationMs: 12,
        answer: scenario === 'output_quality' ? 'false' : 'true', confidence: 0.9,
      }),
    };
    const w = makeEngine({ judgment: qualityGw });
    const wf = await ladderEmail(w.engine, makeEmail());
    await w.engine.advance(wf.id);
    const steps = () => w.store.stepsForWorkflow(wf.id);
    await w.engine.approve(steps()[1]!.id, '可以', 'boss');
    await until(() => steps()[2]!.status === 'running');
    await w.engine.onAgentStopped('agent-a', 'ok', '抱歉，我没能完成这个任务');
    await until(() => steps()[3]!.status === 'running' || steps()[4]!.status === 'waiting_human');
    expect(w.store.listEvents(100).some((e) => e.type === 'output_quality_flagged')).toBe(true);
  });

  it('redline_semantic：send 步出门前语义体检留痕（redline_judgment）', async () => {
    const redlineGw: JudgmentGateway = {
      threshold: () => 0.7,
      ask: async () => ({
        mode: 'shadow', ok: true, threshold: 0.7, provider: 'test', model: 'jev-test',
        inputTokens: 7, outputTokens: 3, durationMs: 12,
        answer: 'false', confidence: 0.95,
      }),
    };
    const w = makeEngine({ judgment: redlineGw });
    const wf = await ladderEmail(w.engine, makeEmail());
    await w.engine.advance(wf.id);
    const steps = () => w.store.stepsForWorkflow(wf.id);
    await w.engine.approve(steps()[1]!.id, '计划可以', 'boss');
    await until(() => steps()[2]!.status === 'running');
    await w.engine.onAgentStopped('agent-a', 'ok', '销量数据已整理完毕');
    await until(() => steps()[3]!.status === 'running');
    await w.engine.onAgentStopped('agent-a', 'ok', '复核完毕：数据无误');
    await until(() => steps()[4]!.status === 'waiting_human');
    await w.engine.approve(steps()[4]!.id, '产出合格', 'boss');
    await until(() => steps()[6]!.status === 'waiting_human');
    await w.engine.approve(steps()[6]!.id, '回信可以发', 'boss');
    await until(() => steps()[7]!.status === 'completed');
    expect(w.store.listEvents(100).some((e) => e.type === 'redline_judgment')).toBe(true);
  });
});
