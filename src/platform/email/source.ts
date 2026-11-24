// 轮询骨架 + makro 适配（对应 Go inbox/poller.go + source.go 的合并体）。
// 模板方法：唤醒 → 拨号（每轮新建）→ 信封全列（阶段一）→ 过滤（渠道授权 +
// 账本去重）→ 拉正文（阶段二）→ 处理链（去重再探 → 发布）→ \Seen 提示。
// 一次坏轮询绝不停止循环；一条坏消息绝不拖垮一批。
//
// 投递语义 at-most-once：拉取即处理，崩溃的那封记日志不重投——重复的
// agent 运行比一封有完整 workflow/事件留档的丢失更糟。\Seen 打给每一封
// 过了处理链的信（摄取与被丢弃的都算「过了手」）；「处理与否」的权威仍在
// 账本探针（阶段一），\Seen 只是人侧视觉提示、不是闸门。

import { checkAuthz, type AuthzPolicy } from '../../contracts/authz.ts';
import { inboxDedupKey, withDedupe, type InboxMessage, type MessageHandler } from './inbox.ts';
import { dialImap, type ImapParams } from './imap.ts';
import { type Clock } from '../shared/clock.ts';

export interface SourceStatus {
  readonly enabled: boolean;
  readonly lastPoll: string | null;
  readonly lastOk: string | null;
  readonly lastError: string;
  readonly processed: number;
}

export interface SourceDeps {
  readonly params: ImapParams;
  readonly password: string;
  /** 阶段一过滤 + 处理链共用的账本去重探针：true = 该身份已知（已在途/
   *  已摄取/本引擎已发出的回灌）——跳过，不再拉正文不再处理。 */
  readonly ledgerSeen: (key: string) => Promise<boolean>;
  /** 渠道级发件人授权（config email.authz_allow/deny；全局层在引擎）。 */
  readonly channelAuthz: AuthzPolicy;
  /** 摄取出口：通常接 engine.onEmailReceived（authz 引擎层再兜一道）。 */
  readonly onMessage: (m: InboxMessage) => Promise<void>;
  /** 传输注入口（测试假 IMAP）；缺省真拨号。 */
  readonly dial?: typeof dialImap;
  readonly intervalSec?: number;
  readonly clock?: Clock;
  readonly log: (msg: string) => void;
}

export interface MailSource {
  readonly name: string;
  pollOnce(): Promise<void>;
  start(): void;
  stop(): void;
  status(): SourceStatus;
  /** 热改轮询间隔（Settings 页）；未启动时只记值，下次 start 生效。
   *  返回是否接受（非法值拒绝——调用方据此如实上报，不谎报已生效）。 */
  setIntervalSec(sec: number): boolean;
  /** 热改渠道授权策略（授权面板 / Settings 页，2026-11-23）：下一轮轮询起按
   *  新策略过滤。渠道闸是收信的第一步，被它挡掉的邮件不建单也不留痕——
   *  策略改了它不跟着变，面板上新加的地址就还是被挡在外面。 */
  setAuthzPolicy(policy: AuthzPolicy): void;
}

export const createMailSource = (deps: SourceDeps): MailSource => {
  let lastPoll: string | null = null;
  let lastOk: string | null = null;
  let lastError = '';
  let processed = 0;
  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let polling = false; // 一轮在途不并发再入：同邮箱双拉=同一封双摄取竞态
  // 间隔放闭包变量而非常量——Settings 页热改时 tick 重排读到的就是新值。
  let intervalSec = deps.intervalSec && deps.intervalSec > 0 ? deps.intervalSec : 60;
  // 渠道策略同样放闭包变量：初值取自 deps，热改只改这里——deps 是调用方的
  // 对象，这里不改它。
  let channelAuthz: AuthzPolicy = deps.channelAuthz;
  const now = (): Date => deps.clock?.now() ?? new Date();

  // 发布 = 记数（\Seen 提示由本源依据账本探针的最终判定统一处理）。
  const core: MessageHandler = async (m) => {
    await deps.onMessage(m);
    processed++;
    deps.log(`[inbox] 已摄取 "${m.subject}" 来自 ${m.from}`);
  };
  const handler = withDedupe(deps.ledgerSeen, core);

  const pollOnce = async (): Promise<void> => {
    lastPoll = now().toISOString();
    const conn = await (deps.dial ?? dialImap)(deps.params, deps.password);
    if (!conn.ok) {
      lastError = conn.error.message;
      deps.log(`[inbox] ${conn.error.message}`);
      return;
    }
    const clt = conn.value;
    try {
      // 阶段一：轻信封全列。
      const envelopes = await clt.listEnvelopes();
      if (!envelopes.ok) {
        lastError = envelopes.error.message;
        deps.log(`[inbox] ${envelopes.error.message}`);
        return;
      }
      // 本轮用的渠道策略在每轮开头取一次：一轮之内不会前后用两份策略，热改
      // 从下一轮开始算。
      const authz = channelAuthz;
      // 阶段二门：渠道授权 + 账本去重（被拒的不算已摄取——策略放行时邮件必须能流）。
      const newUids: number[] = [];
      for (const e of envelopes.value) {
        const reason = checkAuthz(authz, e.from);
        if (reason !== null) {
          deps.log(`[inbox] 渠道拒绝发件人 ${e.from}: ${reason}`);
          continue;
        }
        if (e.uid === 0) continue; // 无 UID 的信封无法定点拉取
        // 探针故障按未见过放行（errs-open，与链尾 withDedupe 同极性）：
        // 不设防的异常会把整轮轮询炸掉——账本抖动即摄取停摆。
        let seen = false;
        try {
          seen = await deps.ledgerSeen(inboxDedupKey({
            uid: e.uid, from: e.from, subject: e.subject, date: e.date,
            messageId: e.messageId, body: '', attachments: [],
          }));
        } catch (ex) {
          deps.log(`[inbox] 阶段一去重探针失败（放行）: ${String(ex)}`);
        }
        if (!seen) newUids.push(e.uid);
      }
      const bodies = await clt.fetchBodies(newUids);
      if (!bodies.ok) {
        lastError = bodies.error.message;
        deps.log(`[inbox] ${bodies.error.message}`);
        return;
      }
      // 逐条处理；一条坏消息不拖垮一批。\Seen 打给每一封过了处理链的信：
      // 摄取的与被丢弃的（账本去重再探/引擎守卫）都算过了手——丢弃的不标
      // 会在下轮全量信封里再被拉起（2026-09-21 自回环洪水的放大器）。只有
      // 处理链抛错的不标，留给下轮重试（at-most-once 的「重试」边界）。
      const handled: number[] = [];
      for (const m of bodies.value) {
        try {
          await handler(m);
        } catch (e) {
          deps.log(`[inbox] 处理 "${m.subject}": ${String(e)}`);
          continue;
        }
        if (m.uid !== 0) handled.push(m.uid);
      }
      await clt.markProcessed(handled);
      lastError = '';
      lastOk = now().toISOString();
    } finally {
      await clt.close();
    }
  };

  // 节拍入口：上一轮仍在途则跳过本拍（公共 pollOnce 不受此限，直调即真跑）。
  const tickPoll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      await pollOnce();
    } finally {
      polling = false;
    }
  };

  return {
    name: 'email',
    pollOnce,

    start() {
      if (!stopped) return;
      stopped = false;
      deps.log(`[inbox] 轮询启动（interval=${intervalSec}s, host=${deps.params.host}）`);
      // 启动即轮询一次（积压清空），此后按节拍。
      void tickPoll().catch((e) => deps.log(`[inbox] poll: ${String(e)}`));
      const tick = (): void => {
        if (stopped) return;
        void tickPoll().catch((e) => deps.log(`[inbox] poll: ${String(e)}`));
        timer = setTimeout(tick, intervalSec * 1000);
      };
      timer = setTimeout(tick, intervalSec * 1000);
    },

    setIntervalSec(sec: number): boolean {
      // 拒到整数秒为止：0 < sec < 1 经 Math.trunc 会得 0——0ms 节拍等于
      // 全速轮询自打，且返回 true 谎报已生效（接口契约：非法值拒绝）。
      if (!Number.isFinite(sec) || sec < 1) return false;
      intervalSec = Math.trunc(sec);
      return true;
    },

    setAuthzPolicy(policy: AuthzPolicy): void {
      channelAuthz = policy;
    },

    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },

    status(): SourceStatus {
      return {
        enabled: !stopped, lastPoll, lastOk, lastError, processed,
      };
    },
  };
};
