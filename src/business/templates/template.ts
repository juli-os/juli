// 管线模板：阶梯是数据，不是代码。模板 YAML 声明有序步骤（id/kind/title
// 及步级策略），引擎是通用解释器。默认模板随包内嵌（零配置）；磁盘目录
// ~/.juli-service/pipelines/ 的同名文件优先（覆盖内嵌）。工作流创建时快照
// 阶梯，之后的模板编辑绝不影响在途流程。

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { yamlParse } from '../../platform/shared/yamlparse.ts';
import { STEP_KINDS } from '@juli-os/ledger';
import { type StepKind } from '@juli-os/ledger';
import type { JsonRecord, JsonValue } from '@juli-os/artifacts'

// enum 从账本的 StepKind 派生：两处词汇表漂移 = 编译错，不是运行时惊喜。
export const stepKindSchema = z.enum([...STEP_KINDS] as [StepKind, ...StepKind[]]);
export type StepKindName = z.infer<typeof stepKindSchema>;

const templateStepSchema = z.object({
  id: z.string().default(''),
  kind: stepKindSchema,
  title: z.string().default(''),
  session: z.string().optional().default(''),
  prompt: z.string().optional().default(''),
  system: z.string().optional().default(''),
  max_tokens: z.number().int().optional().default(0),
  model: z.string().optional().default(''),
  when: z.string().optional().default(''),
  zombie: z.object({
    timeout: z.string().default(''),
    max_attempts: z.number().int().default(0),
  }).optional(),
});

export const templateSchema = z.object({
  key: z.string().default(''),
  name: z.string().default(''),
  trigger: z.string().default('manual'),
  /** nodes = 动作生节点（无预建阶梯，节点由 CLI/触发动作追加）；缺省 = ladder */
  mode: z.enum(['ladder', 'nodes']).optional().default('ladder'),
  /** 起流必需的 input key——缺了当场退回，不许残缺单子进流水线后冻死在渲染
   * （2026-09-14 wf_994b0eb399ab：reply-manual 缺 in_reply_to，任务卡渲染
   * 抛错飞出 advance，步骤 pending 永冻且账本零痕迹）。 */
  requires: z.array(z.string()).optional().default([]),
  zombie: z.object({
    timeout: z.string().default(''),
    max_attempts: z.number().int().default(0),
  }).optional(),
  steps: z.array(templateStepSchema).default([]),
});

export interface ZombiePolicy {
  readonly timeout: string;
  readonly maxAttempts: number;
}

export interface TemplateStep {
  readonly id: string;
  readonly kind: StepKindName;
  readonly title: string;
  readonly session: string;
  readonly prompt: string;
  readonly system: string;
  readonly maxTokens: number;
  /** 步骤级模型覆盖（空 = 引擎全局 model）。 */
  readonly model: string;
  /** 语义跳过条件：对 flow context 渲染，假值 → 该步 skipped 并继续。gate 禁用。 */
  readonly when: string;
  readonly zombie?: ZombiePolicy;
}

export interface Template {
  readonly key: string;
  readonly name: string;
  readonly trigger: string;
  /** nodes = 动作生节点（阶梯由 CLI 动作追加）；ladder = 预建阶梯。 */
  readonly mode: 'ladder' | 'nodes';
  /** 起流必需的 input key（快照进校验，缺参起流当场退回）。 */
  readonly requires: readonly string[];
  readonly zombie?: ZombiePolicy;
  readonly steps: readonly TemplateStep[];
  /** 模板内容 sha256 前 12 位——创建工作流时钉进 meta，快照可审计。 */
  readonly hash: string;
}

export const TRIGGER_EMAIL = 'email';

/** 模板步的声明式配置物化进持久 input：创建出来的步行就是该流水的快照——
 * 之后的模板编辑绝不改在途流，靠的就是这里把配置抄进步 input。步级 zombie
 * 同样物化（存声明原文：timeout 字符串 + max_attempts）；流级策略由引擎侧
 * 物化进 meta——两级各自快照，模板热更谁都不许跟随。 */
export const carryStepConfig = (ts: {
  readonly id: string; readonly when?: string; readonly session?: string; readonly prompt?: string;
  readonly system?: string; readonly maxTokens?: number; readonly model?: string;
  readonly zombie?: ZombiePolicy;
}): JsonRecord => {
  const input: Record<string, JsonValue> = { _ref: ts.id };
  if (ts.session) {
    input['session'] = ts.session;
    input['_session'] = ts.session;
  }
  if (ts.prompt) input['prompt'] = ts.prompt;
  if (ts.system) input['system'] = ts.system;
  if (ts.maxTokens && ts.maxTokens > 0) input['max_tokens'] = ts.maxTokens;
  if (ts.model) input['model'] = ts.model;
  if (ts.when) input['_when'] = ts.when;
  if (ts.zombie) input['_zombie'] = { timeout: ts.zombie.timeout, max_attempts: ts.zombie.maxAttempts };
  return input;
};

// ---- 时长解析 ---------------------------------------------------------------------

const DUR_UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** Go 风格时长解析（zombie.timeout 用）：复合式（1h30m）逐段累加，非法
 * 片段整体判 0（调用方回落默认值）。 */
export const parseDur = (s: string): number => {
  let total = 0;
  let matched = false;
  for (const m of s.trim().matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    matched = true;
    total += Number(m[1]) * (DUR_UNIT_MS[m[2]!] ?? 0);
  }
  return matched ? total : 0;
};

/** 解析并校验模板 YAML。校验的是解释器赖以生存的不变量。 */
export const parseTemplate = (data: string): Template => {
  const raw = templateSchema.parse(yamlParse(data));
  if (raw.key.trim() === '') throw new Error('template key is required');
  if (raw.mode !== 'nodes' && raw.steps.length === 0) throw new Error('template needs at least one step');
  const seen = new Set<string>();
  const steps: TemplateStep[] = raw.steps.map((s, i) => {
    if (s.id.trim() === '') throw new Error(`step ${i + 1}: id is required`);
    if (seen.has(s.id)) throw new Error(`step ${i + 1}: duplicate id "${s.id}"`);
    seen.add(s.id);
    if (s.title.trim() === '') throw new Error(`step ${s.id}: title is required`);
    if (s.when && s.kind === 'gate') throw new Error(`step ${s.id}: gate steps cannot have when（人审不可语义跳过）`);
    return {
      id: s.id, kind: s.kind, title: s.title,
      session: s.session ?? '', prompt: s.prompt ?? '', system: s.system ?? '',
      model: s.model ?? '', when: s.when ?? '',
      maxTokens: s.max_tokens ?? 0,
      zombie: s.zombie ? { timeout: s.zombie.timeout, maxAttempts: s.zombie.max_attempts } : undefined,
    };
  });
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 12);
  return {
    key: raw.key,
    name: raw.name,
    trigger: raw.trigger,
    mode: raw.mode,
    requires: raw.requires,
    zombie: raw.zombie
      ? { timeout: raw.zombie.timeout, maxAttempts: raw.zombie.max_attempts }
      : undefined,
    steps,
    hash,
  };
};

/** 解析失败 → null（调用方决定降级；registry 逐文件容忍坏模板）。 */
export const tryParseTemplate = (data: string): Template | null => {
  try {
    return parseTemplate(data);
  } catch {
    return null;
  }
};
