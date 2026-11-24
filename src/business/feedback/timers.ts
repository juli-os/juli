// 公开投影桩：与私仓同形，双侧投影导出面一致防漂移。
// 私仓本文件是 feedback 域后台定时器（镜像 sweep → 进件起单 → villa 源 →
// apply 链收口，60s 一轮）；b56 step3 定时器归域（从 runtime.business.ts 搬入），
// 2026-11-13 R2-F 将 exclude 更新到域真实路径（src/business/feedback/**）后，
// 本桩承接 runtime.ts 组合根对该定时器的唯一直连。
// 语义：公开投影 feedback 域整体砍面（镜像域/进件链均不投影）——恒空集、
// 零定时器，与 platform/ops/timers.ts 财务巡检桩同款。参数名与私仓逐一相同；
// mirrorDb / feedbackIntake 收放宽形态（公开调用点实参恒 null——runtime.business
// 桩；同 mailer: unknown 放宽先例）；导出面漂移（私仓改签名忘同步桩）即
// 公开树 typecheck 红灯。
import type { LifecycleStore } from '@juli-os/ledger';
import type { Engine } from '../workflow/engine.ts';
import type { Logger } from '../../platform/events/bus.ts';

export const startFeedbackTimers = (deps: {
  readonly mirrorDb: unknown;
  readonly dataDir: string;
  readonly store: Pick<LifecycleStore, 'listWorkflows'>;
  readonly engine: Pick<Engine, 'recordActivity' | 'startTask' | 'autoSettleFeedbackRuns'>;
  /** feedback 进件（可空——公开投影未含进件链，恒 null）。 */
  readonly feedbackIntake: { readonly startForNewRecords: unknown } | null;
  readonly log: Logger;
}): readonly NodeJS.Timeout[] => {
  void deps;
  return []; // 公开投影未含 feedback 域——恒空集
};
