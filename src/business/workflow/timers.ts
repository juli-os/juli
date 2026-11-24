// workflow 域后台活（2026-11-12 第 7 步从 runtime.ts 搬入）：在途对账、
// hold 放行、定档扫描、回流外发箱、已批静默收口、僵尸扫描、账本修剪。
// 热改参数（retentionDays）留组合根——域经注入 getter 每轮现读（b56-R1 修复：
// 原先域内快照 initialRetentionDays 让 Settings 热改断线，重启才生效）。
import type { LifecycleStore } from '@juli-os/ledger';
import type { Logger } from '../../platform/events/bus.ts';
import type { Engine } from './engine.ts';

export interface WorkflowTimers {
  /** 启动的定时器（runtime 聚合统一 clear）。 */
  readonly timers: readonly NodeJS.Timeout[];
}

export const startWorkflowTimers = (deps: {
  readonly engine: Engine;
  readonly store: LifecycleStore;
  /** 当前保留天数（组合根持有，Settings 热改即变——每轮现读，不收快照）。 */
  readonly retentionDays: () => number;
  readonly log: Logger;
}): WorkflowTimers => {
  const { engine, store, log } = deps;
  /** 巡检出错只记日志、绝不外抛（2026-11-23 全量审查）：定时器回调里同步
   * 抛出去的异常是未捕获异常，会打死整个进程；返回的 promise 没人接是未捕获
   * 拒绝。此前五条巡检都是 `.catch(() => undefined)`——对账、hold 放行、定档
   * 发送、补投、自动收口、卡死巡检一旦出错就悄悄停掉，日志里没有痕迹。 */
  const guarded = (name: string, run: () => void | Promise<unknown>): void => {
    const fail = (e: unknown): void => {
      log.error(`[engine] 巡检 ${name} 出错：${e instanceof Error ? e.message : String(e)}`);
    };
    try {
      const r = run();
      if (r instanceof Promise) void r.catch(fail);
    } catch (e) {
      fail(e);
    }
  };
  return {
    timers: [
      // 在途对账安全网：丢 hook 的 agent 步 10 分钟宽限后收口。
      setInterval(() => guarded('reconcileInflight', () => engine.reconcileInflight()), 60_000),
      // hold 放行泵（2026-09-28 工作时间窗）：窗口关闭后把 hold 中的单按原队序
      // 放行——收单台纯事件驱动，没有这条心跳就没人叫醒 hold 单。
      // 2026-11-23 全量审查补回：4a654bc（2026-10-07）加自动批准巡检时把它误删，
      // 此后贵时段压着的单窗口关了也只能等人手动放行。
      setInterval(() => guarded('holdSweep', () => engine.holdSweep()), 60_000),
      // 定档扫描：到点的定时发送续推（60s 精度足够——定档单位是小时）。
      setInterval(() => guarded('sweepSchedules', () => engine.sweepSchedules()), 60_000),
      // 回流外发箱：欠款必还（60s 补投 + 卡死告警）。
      setInterval(() => guarded('sweepRelays', () => engine.sweepRelays()), 60_000),
      // 已批闸门静默收口（wf_be61c3a55842，2026-10-09）：60s 一轮扫「闸已批
      // +全链终态」的单，双静默（事件链+会话用量行）超 5 分钟即 settle——
      // agent 自 settle 被其会话权限层拦（实测），引擎兜底收口。
      setInterval(() => guarded('autoSettleApprovedRuns', () => engine.autoSettleApprovedRuns()), 60_000),
      // 僵尸扫描：30s tick。
      setInterval(() => guarded('sweepZombies', () => engine.sweepZombies()), 30_000),
      // 账本修剪：retention_days 可被 Settings 热改，定时器常驻、每轮现读 getter。
      setInterval(() => {
        const days = deps.retentionDays();
        if (days <= 0) return;
        try {
          const r = store.prune(days);
          if (r.events + r.workflows > 0) log.info(`[prune] 清理 ${r.events} 事件 / ${r.workflows} 终态工作流`);
        } catch (e) { log.error(`[prune] ${String(e).slice(0, 100)}`); }
      }, 86_400_000),
    ],
  };
};
