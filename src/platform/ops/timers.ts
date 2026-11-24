// 公开投影桩：与私仓同形，双侧投影导出面一致防漂移。
// 私仓本文件是财务备份巡检定时器（b56 step7 从 runtime.business.ts 搬入
// platform/ops）；公开投影未含巡检模块（MVP 砍面），桩提供同形空实现——
// 恒空集、零定时器。runtime.ts 组合根零改动即可在两侧编译；导出面漂移
// （私仓改签名忘同步桩）即公开树 typecheck 红灯。
import type { Config } from '../config/schema.ts';
import type { Logger } from '../events/bus.ts';

export const startFinanceBackupTimers = (deps: {
  readonly config: Pick<Config, 'finance_backup_check'>;
  readonly mailer: unknown;
  readonly recipients: () => { readonly to: readonly string[]; readonly cc: readonly string[] };
  readonly log: Logger;
}): readonly NodeJS.Timeout[] => {
  void deps;
  return []; // 公开投影未含财务备份巡检——恒空集
};
