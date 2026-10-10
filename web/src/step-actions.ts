// 步动作矩阵（kind × status → 可用动词）：lifecycle 决定区、kanban/dashboard
// 卡片动作的单一判定源（2026-09-22 收口）。此前矩阵编码在 lifecycle actions()
// 的 if-else 梯里（8 kind × 7 status），加一个动作要人肉找全条件分支——本模块
// 把判定变数据，视图只负责渲染按钮。零 DOM 依赖，vitest 直接可测。
//
// 与引擎动词面的对应：approve/deny/resolve/rework/align → 闸门动作；
// retry/amend/rework-send → 步修复动词；intervene/intervene2 → 会话插话；
// cancel → 单步取消。可干预口径与 src/contracts/entities.ts AGENT_STEP_KINDS 对齐
// （web 不引 src，测试锁定）；失败分支额外含 llm（干预重试=带补丁重臂）。

/** 动词 id（视图按 id 渲染按钮文案/图标/绑定，不在此拼 HTML）。 */
export type StepActionId =
  | 'approve' | 'approve-send' | 'deny' | 'resolve' | 'schedule' | 'amend' | 'align' | 'rework'
  | 'rework-send' | 'retry' | 'intervene' | 'intervene2' | 'cancel';

/** 失败步可干预集（agent/verify/llm）。 */
export const FAILED_INTERVENABLE_KINDS: readonly string[] = ['agent', 'verify', 'llm'];

/** 决策分支：视图按分支选渲染模板（gate=闸门决定区 / failed=失败修复行 /
 * running-agent=插话行 / cancellable=取消行）。 */
export type StepActionBranch = 'gate' | 'failed' | 'running-agent' | 'cancellable' | 'none';

export interface StepActionDecision {
  readonly branch: StepActionBranch;
  /** gate 分支：是否发送语义闸门（决定主动作文案与次级动作集）。 */
  readonly send: boolean;
  /** 按渲染序排列的动词。 */
  readonly actions: readonly StepActionId[];
  /** failed+send：内容守卫名（非空=守卫拒发形态，盲重试不出现）。 */
  readonly guard: string;
  /** running-agent：插话目标会话（空=无会话可插话，动词集为空）。 */
  readonly interveneSession: string;
}

export interface ActionStepLike {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly output?: Readonly<Record<string, unknown>>;
}

/** kind × status → 动作决策。sessionOf 由调用方注入（lifecycle 从步
 * input/output 解会话名，按实际步类型收窄）；opts.sendGate 为闸门分支的
 * 发送语义（调用方经 gates.isSendGate 判——需要全步骤上下文，见该模块）。 */
export const decideStepActions = <T extends ActionStepLike>(
  s: T,
  sessionOf: (s: T) => string,
  opts: { readonly sendGate?: boolean } = {},
): StepActionDecision => {
  if (s.kind === 'gate' && s.status === 'waiting_human') {
    const send = opts.sendGate === true;
    return {
      branch: 'gate', send, guard: '', interveneSession: '',
      actions: send
        ? ['approve-send', 'deny', 'resolve', 'schedule', 'amend', 'rework']
        : ['approve', 'deny', 'resolve', 'align', 'rework'],
    };
  }
  if (s.status === 'failed') {
    const guard = typeof s.output?.['guard'] === 'string' ? s.output['guard'] as string : '';
    if (s.kind === 'send' && guard !== '') {
      return { branch: 'failed', send: false, actions: ['rework-send', 'amend'], guard, interveneSession: '' };
    }
    const canIntervene = FAILED_INTERVENABLE_KINDS.includes(s.kind);
    return {
      branch: 'failed', send: false, guard: '', interveneSession: '',
      actions: canIntervene ? ['retry', 'amend', 'intervene'] : ['retry', 'amend'],
    };
  }
  if (s.status === 'running' && (s.kind === 'agent' || s.kind === 'verify')) {
    return { branch: 'running-agent', send: false, actions: ['intervene2'], guard: '', interveneSession: sessionOf(s) };
  }
  if (s.status === 'pending' || s.status === 'waiting_human') {
    return { branch: 'cancellable', send: false, actions: ['cancel'], guard: '', interveneSession: '' };
  }
  return { branch: 'none', send: false, actions: [], guard: '', interveneSession: '' };
};
