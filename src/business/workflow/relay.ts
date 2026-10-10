// 回流与定档扫描：批准后的会话回流（持久外发箱+送达验证+补投）、卡死告警、
// 定时发送到点续推。runtime 周期调用的三兄弟（sweepRelays/sweepSchedules/
// 由 reconcile 持有的其他 sweep）。

import type { Logger } from '../../platform/events/bus.ts';
import type { LifecycleStore } from '@juli-os/ledger';
import { type Step } from '@juli-os/ledger';
import { asString } from '../../platform/shared/json.ts'
import type { EngineDeps } from './engine.ts';
import type { Journal } from './journal.ts';

export interface Relay {
  /** 回流投递（带送达验证）：pane 已含标记=已送达（防重）；发送后读回
   * 确认；失败记尝试次数留在外发箱等下轮。 */
  deliverRelay(relayId: string, sess: string, text: string, marker: string): Promise<boolean>;
  /** 外发箱扫描：欠款必还——60s 周期补投未送达回流；卡超 5 分钟推送告警
   * （批准后的静默不可容忍，失败必须响）。 */
  sweepRelays(): Promise<void>;
  /** 定档扫描：到点的 pending 发送步续推（批准已生效，执行等钟——钟到即走）。
   * 收单台（0920）review F5：此处有意豁免队列——send_at 是对人的时间承诺，
   * 绕行排队（发送本身廉价，非机器重活）；若也走 enqueueFront，长队会击穿
   * 承诺时点。豁免面仅此一条 60s 定时路径。 */
  sweepSchedules(): Promise<void>;
}

export const makeRelay = (o: {
  readonly deps: EngineDeps;
  readonly store: LifecycleStore;
  readonly now: () => Date;
  readonly log: Logger;
  readonly journal: Journal;
  /** 晚绑 advance：定档到点续推整机链（engine.advance 是带尽力而为壳的公开面）。 */
  readonly late: { advance: (workflowId: string) => Promise<void> };
}): Relay => {
  const { deps, store, log } = o;
  const now = o.now;

  const deliverRelay = async (relayId: string, sess: string, text: string, marker: string): Promise<boolean> => {
    if (!deps.sendToSession) return false;
    try {
      if (deps.readPane) {
        const pane = await deps.readPane(sess).catch(() => null);
        if (pane !== null && pane.includes(marker)) {
          store.markRelayDelivered(relayId);
          return true; // 已送达（补投场景防重复）
        }
      }
      const sent = await deps.sendToSession(sess, text);
      if (!sent.delivered) {
        store.markRelayAttempt(relayId, `send failed: ${sent.reason}`);
        return false;
      }
      if (deps.readPane) {
        const pane = await deps.readPane(sess).catch(() => null);
        if (pane === null || !pane.includes(marker)) {
          store.markRelayAttempt(relayId, 'sent but marker not found in pane');
          return false; // 发了没到——留在外发箱补投
        }
      }
      store.markRelayDelivered(relayId);
      return true;
    } catch (e) {
      store.markRelayAttempt(relayId, e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const sweepRelays = async (): Promise<void> => {
    for (const r of store.pendingRelays()) {
      const delivered = await deliverRelay(r.id, r.session, r.text, r.marker);
      if (delivered) {
        store.appendEvent('workflow', r.workflowId, 'gate_relay_delivered', {
          relay_id: r.id, session: r.session, attempts: r.attempts + 1,
        });
        continue;
      }
      const ageMs = now().getTime() - new Date(r.createdAt).getTime();
      if (ageMs > 5 * 60_000 && r.attempts >= 3) {
        const w = store.getWorkflow(r.workflowId);
        // 一次性告警（chain_dangling_notified 同款 meta 防重）：sweep 是 60s
        // 周期，不拦则同一卡死 relay 每轮重记事件+重推 gateWaiting——邮件接入
        // 后即每分钟一封轰炸。响过一次就落标记，处置由人接手。
        if (!w || w.meta['relay_stuck_notified'] === true) continue;
        store.appendEvent('workflow', r.workflowId, 'gate_relay_stuck', {
          relay_id: r.id, session: r.session, attempts: r.attempts, error: r.lastError,
        });
        store.updateWorkflowMeta(r.workflowId, { relay_stuck_notified: true });
        if (deps.pusher) {
          const fake: Step = {
            id: r.id, workflowId: r.workflowId, seq: 0, kind: 'gate',
            title: `回流投递失败：${r.session}`, status: 'waiting_human',
            input: {}, output: {}, summary: '', updatedAt: '',
            startedAt: '', completedAt: null,
          };
          await o.journal.pushBestEffort('gateWaiting', () => deps.pusher!.gateWaiting(w, fake,
            `批准后的回流投不进会话 ${r.session}（${r.attempts} 次尝试）——需要人工查看`));
        }
      }
    }
  };

  const sweepSchedules = async (): Promise<void> => {
    for (const st of store.listSteps('pending', 200)) {
      if (st.kind !== 'send') continue;
      const sched = asString(st.input['send_at']);
      if (sched === '' || new Date(sched).getTime() > now().getTime()) continue;
      log.info(`[schedule] ${st.workflowId} 定档到点(${sched})，续推发送`);
      await o.late.advance(st.workflowId);
    }
  };

  return { deliverRelay, sweepRelays, sweepSchedules };
};
