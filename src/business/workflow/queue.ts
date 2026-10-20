// 收单台（0920 定案，docs/designs/intake-queue-and-twenty-architecture.md §二）
// 六语义：入队即返（创建置 queued）/ FIFO 并发=1（可调）/ 闸门放队位 /
// 队列落库（queued 在 SQLite，重启由启动扫描按到达序重排）/ 纯事件驱动
// （入队与释放各泵一次，无定时器）/ 续走口统一（创建走队尾；闸门批准等
// 续走插队头——人刚花过注意力，不重新排队）。
// 占队位的是「机器在干活」：当前步 running（含已派发 tmux 等 Stop hook 的
// 异步执行）即占位；停在人工闸门 / 终态 / nodes 空档即放位。不改 per-workflow
// 锁；派发器发起 advance 不持任何锁，无锁序倒置。
//
// 队列状态（activeIds/waitingIds）按引用共享给需要直查的模块（appendNode
// 判占位、reconcile 自愈放位）——与拆分前同一份闭包状态等价。

import type { LifecycleStore } from '@juli-os/ledger';
import { isActiveWorkflowStatus } from '../../contracts/statuses.ts';

export interface Queue {
  readonly queueConcurrency: number;
  readonly activeIds: Set<string>;
  readonly waitingIds: string[];
  machineBusy(workflowId: string): boolean;
  evaluateSlot(workflowId: string): void;
  releaseSlotOnClose(workflowId: string): void;
  pump(): void;
  enqueueBack(workflowId: string): void;
  enqueueFront(workflowId: string): void;
  continueWorkflow(workflowId: string): void;
  queueStatus(): { concurrency: number; active: readonly string[]; waiting: readonly string[]; held: readonly string[] };
}

export const makeQueue = (o: {
  readonly store: LifecycleStore;
  readonly queueConcurrency: number;
  /** 晚绑 advance（runChain 续推整机链）：引擎装配完毕后才指向真身。 */
  readonly late: { advance: (workflowId: string) => Promise<void> };
  /** hold gate（2026-09-28 工作时间窗）：返回 true=该单暂缓派发。pump 对它
   * 扫描跳过、**保队位不 shift**——窗口关后由 holdSweep/pump 自然放行，不造
   * 幽灵槽（收单台 F1 教训）。缺省=永不 hold（旧行为）。 */
  readonly holdGate?: (workflowId: string) => boolean;
}): Queue => {
  const { store, queueConcurrency, late, holdGate } = o;
  const activeIds = new Set<string>(); // 正占队位的机器执行链
  const waitingIds: string[] = []; // FIFO 等待（队头在前）

  /** 共用探测：workflow 在跑（非 queued/终态）才取当前步，否则 null。 */
  const runningStep = (workflowId: string) => {
    const w = store.getWorkflow(workflowId);
    if (!w || w.status !== 'running') return null;
    return store.currentStep(workflowId);
  };

  const machineBusy = (workflowId: string): boolean => {
    const st = runningStep(workflowId);
    return st !== null && st.status === 'running';
  };

  /** 链跑完的统一收口：仍在机器执行（异步 agent 在跑）保留队位；停放即放位并泵下一张。 */
  const evaluateSlot = (workflowId: string): void => {
    if (!activeIds.has(workflowId)) return;
    if (machineBusy(workflowId)) return;
    activeIds.delete(workflowId);
    pump();
  };

  /** 人工收口配套（review F1/F8 修复）：置终态后必须调用——单已死，链不再运行，
   * evaluateSlot 不会再被触发；不显式放位 = 死槽（并发 1 下全队卡到重启）。
   * 同时从等待队列摘除，快照不再展示已收口的单。 */
  const releaseSlotOnClose = (workflowId: string): void => {
    const wi = waitingIds.indexOf(workflowId);
    if (wi >= 0) waitingIds.splice(wi, 1);
    if (activeIds.delete(workflowId)) pump();
  };

  const runChain = (workflowId: string): void => {
    void late.advance(workflowId).finally(() => evaluateSlot(workflowId));
  };

  /** 轻量步（2026-09-28 闸门不排队④）：当前步=确认闸门 pending。advance
   * 对它只做纯账本转变（置 waiting_human）+推送即停，无机器执行——这类
   * 推进不占并发预算、不等 agent 回合让位（照片单闸门被批量回合串行阻塞、
   * 审批卡迟迟不出的形态）。闸门被批准后的后续（send/agent）照常过队列。 */
  const lightweightGate = (workflowId: string): boolean => {
    const st = runningStep(workflowId);
    return st !== null && st.kind === 'gate' && st.status === 'pending';
  };

  const pump = (): void => {
    // 轻量先行：闸门开启直通（不进 activeIds——advance 完自停在
    // waiting_human；runChain 的 evaluateSlot 对不在册者零操作）。
    for (let i = 0; i < waitingIds.length;) {
      if (lightweightGate(waitingIds[i]!)) {
        const id = waitingIds.splice(i, 1)[0]!;
        runChain(id);
      } else i++;
    }
    while (activeIds.size < queueConcurrency && waitingIds.length > 0) {
      // hold 感知（2026-09-28）：跳过被窗口 hold 的单取第一张可派单；全队
      // 被 hold 则整体留在原序等放行（holdSweep 到点再泵）。绝不 shift 后
      // 丢回——队位即到达序，丢了就是脱队幽灵槽（F1 教训的 hold 变体）。
      const idx = holdGate ? waitingIds.findIndex((id) => !holdGate(id)) : 0;
      if (idx < 0) break;
      const id = waitingIds.splice(idx, 1)[0]!;
      const w = store.getWorkflow(id);
      // 非在途（人工收口后的终态残留）跳过并保持摘除——正常路径
      // 收口时已由 releaseSlotOnClose 摘除，这里是兜底（review F8）。
      if (!w || !isActiveWorkflowStatus(w.status)) continue;
      if (w.status === 'queued') {
        store.setWorkflowStatus(id, 'running');
        store.appendEvent('workflow', id, 'task_dispatched', { from: 'queued' });
      }
      activeIds.add(id);
      runChain(id);
    }
  };

  /** 入队（队尾）：创建路径专用——新单按到达序排。 */
  const enqueueBack = (workflowId: string): void => {
    if (!waitingIds.includes(workflowId) && !activeIds.has(workflowId)) waitingIds.push(workflowId);
    pump();
  };

  /** 续走（队头）：闸门批准 / 补正 / 重试 / 追加节点——轮到它优先恢复机器链。 */
  const enqueueFront = (workflowId: string): void => {
    if (activeIds.has(workflowId)) return;
    const i = waitingIds.indexOf(workflowId);
    if (i >= 0) waitingIds.splice(i, 1);
    waitingIds.unshift(workflowId);
    pump();
  };

  /** 统一续走口：占位中直接续跑（机器链未断）；已放位则插队头重取槽位。 */
  const continueWorkflow = (workflowId: string): void => {
    if (activeIds.has(workflowId)) runChain(workflowId);
    else enqueueFront(workflowId);
  };

  /** 队列快照（GET /api/queue 与 CLI 的数据面）。held=窗口 hold 中的等待单
   * （派生状态：holdGate 重算，不落库不加状态机——「单去哪了」的 UI 答案）。 */
  const queueStatus = (): { concurrency: number; active: readonly string[]; waiting: readonly string[]; held: readonly string[] } => ({
    concurrency: queueConcurrency,
    active: [...activeIds],
    waiting: [...waitingIds],
    held: holdGate ? waitingIds.filter(holdGate) : [],
  });

  return {
    queueConcurrency, activeIds, waitingIds,
    machineBusy, evaluateSlot, releaseSlotOnClose, pump,
    enqueueBack, enqueueFront, continueWorkflow, queueStatus,
  };
};
