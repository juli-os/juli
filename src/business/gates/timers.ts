// gates 域后台活（2026-11-12 第 7 步从 runtime.ts 搬入）：自动批准 sweep
// 30s 心跳 + boot 即扫。域持有热改配置（auto_approve）——runtime 只递初值，
// Settings 热改经句柄 set，sweep 每轮现读（规则改动下轮即生效）。
import type { Logger } from '../../platform/events/bus.ts';
import { autoApproveSweep, projectAutoApprove, type AutoApproveConfig, type AutoApproveSweepDeps } from './index.ts';

export interface GatesTimers {
  readonly timers: readonly NodeJS.Timeout[];
  /** Settings 热改入口：替换现行自动批准配置。 */
  setAutoApprove: (cfg: AutoApproveConfig) => void;
  /** 现行配置（liveOverrides 上报消费）。 */
  autoApprove: () => AutoApproveConfig;
}

export const startGatesTimers = (deps: Omit<AutoApproveSweepDeps, 'config'> & {
  readonly initial: AutoApproveConfig;
  readonly log: Logger;
}): GatesTimers => {
  let cfg = deps.initial;
  const config = (): AutoApproveConfig => cfg;
  // boot 即扫（原 runtime start() 内联段）：配置已开时存量在等闸门不等第一个 30s。
  if (cfg.mode !== 'off') {
    void autoApproveSweep({ ...deps, config })
      .then((n) => { if (n > 0) deps.log.info(`[auto-approve] boot 扫描处理 ${n} 个闸门`); })
      .catch((e) => deps.log.warn(`[auto-approve] boot 扫描失败：${e instanceof Error ? e.message : String(e)}`));
  }
  return {
    timers: [
      // 自动批准 sweep（2026-10-07）：30s 一轮——新到闸门与存量在等闸门同一条
      // 路径兜住（配置经闭包每轮现读，热改下轮生效）。
      setInterval(() => void autoApproveSweep({ ...deps, config })
        .catch((e) => deps.log.warn(`[auto-approve] sweep 失败：${e instanceof Error ? e.message : String(e)}`)), 30_000),
    ],
    setAutoApprove: (next) => { cfg = next; },
    autoApprove: () => cfg,
  };
};

/** 便捷：从 config 原始对象投影初值（装配侧一行用）。 */
export const initialAutoApproveOf = projectAutoApprove;
