// 邮件通知（PusherPort 的邮件实现）：闸门等待/完成/失败/链尾悬空/步骤失败
// 五事件全量进邮箱——这些全是「要人动手或知道」的事，与设备推送（APNs/Bark，
// 仅前三事件）平行，不互斥不互替。复用回信 SMTP 通道（同一 MailerPort），
// 不另起连接池；收件人（to/cc）热改生效——runtime 闭包注入 getter，这里
// 每次发送现读，不快照启动值。尽力而为：内部自捕获，绝不 reject 阻塞引擎
// （与 pushAll 的 .catch(() => undefined) 同语义，只是收口在自己这层）。

import type { MailerPort, PusherPort } from '../../contracts/ports.ts';

// 类型经端口反取（与「pipeline 定义 port 类型」的既有依赖语义一致）——
// push 不直连 ledger，围栏白名单维持 [pipeline, shared]。
type Workflow = Parameters<PusherPort['gateWaiting']>[0];
type Step = Parameters<PusherPort['gateWaiting']>[1];

export interface EmailNotifyDeps {
  readonly mailer: MailerPort;
  /** 现行收件人（热改落点在 runtime 闭包变量——每次发送现读）。 */
  readonly recipients: () => { readonly to: readonly string[]; readonly cc: readonly string[] };
  /** 跳转深链基址（如 http://192.168.1.10:7170）；空 = 正文不带链接。 */
  readonly baseUrl: string;
  /** 被轮询邮箱自身地址（config email.username）：收件人命中即剔除，全中
   *  则整封跳过——发给轮询账号自己的通知必然落回被轮询的 INBOX 形成自回环
   *  （2026-09-21 断根：失败/闸门告警走设备推送/站内 SSE，不发这封信）。
   *  空/未传 = 不设防（未配 IMAP 轮询时无回环可言）。 */
  readonly selfAddress?: string;
  readonly log?: (m: string) => void;
}

const clean = (list: readonly string[]): readonly string[] =>
  list.filter((x) => typeof x === 'string' && x.trim() !== '');

/** 截断（shared/json.ts truncate 同款风格）：邮件容量比设备推送（30/200）
 * 大——主题 80 / 正文 1500，startTask 允许的 120 字标题与超长摘要不撑爆
 * 主题行；超长以…收尾。 */
const trunc = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;

export const SUBJECT_MAX = 80;
export const BODY_MAX = 1500;

// ---- 设备推送组合（事件→结构化深链）--------------------------------------------
//
// 2026-09-20 深链契约修复：iOS AppDelegate（ios/Makro/Makro/AppDelegate.swift
// didReceive）读 userInfo 的 workflow_id/step_id 字符串路由 DeepLinkRouter——
// 事件到字段的映射在这里钉死，runtime 只负责传输。三事件口径不变（热键/
// 悬空这类「要人动手」的低频警报走邮箱，设备不扩面）。

/** 设备推送发送面：传输实现（APNs/Bark）由 runtime 注入。 */
export type DevicePushSend = (title: string, body: string, link: {
  readonly workflowId: string;
  readonly stepId?: string;
}) => Promise<void>;

export const createDevicePusher = (send: DevicePushSend): PusherPort => ({
  async gateWaiting(w: Workflow, st: Step, summary: string) {
    await send(`待审批：${trunc(st.title, 30)}`, trunc(summary, 200), { workflowId: w.id, stepId: st.id });
  },
  async workflowDone(w: Workflow, summary: string) {
    await send(`业务流完成：${trunc(w.title, 30)}`, trunc(summary, 200), { workflowId: w.id });
  },
  async workflowFailed(w: Workflow, summary: string) {
    await send(`流水失败：${trunc(w.title, 30)}`, trunc(summary, 200), { workflowId: w.id });
  },
});

export const createEmailNotifier = (deps: EmailNotifyDeps): PusherPort => {
  const log = deps.log ?? (() => undefined);
  const send = async (subject: string, body: string, wfId: string): Promise<void> => {
    try {
      const { to, cc } = deps.recipients();
      const toList = clean(to);
      if (toList.length === 0) return; // 未配收件人 = 静默跳过（等同未启用）
      // 自址断根（2026-09-21）：先取原始名单判空，再剔除自身地址——全中则
      // 整封不发（发了必落回被轮询的 INBOX），混合名单只摘掉自己那份。
      const self = deps.selfAddress?.trim().toLowerCase() ?? '';
      const isSelf = (a: string): boolean => self !== '' && a.trim().toLowerCase() === self;
      const filtered = toList.filter((a) => !isSelf(a));
      if (filtered.length === 0) {
        log(`[notify-email] ${subject}: 收件人即被轮询邮箱自身，跳过发信（自回环断根；告警走设备推送/站内）`);
        return;
      }
      const ccList = clean(cc).filter((a) => !isSelf(a));
      const base = deps.baseUrl.replace(/\/+$/, '');
      const link = base !== '' ? `${base}/#/lifecycle?w=${wfId}` : '';
      // 正文先截断再拼链接——处理入口永不因截断丢失。
      const text = link !== '' ? `${trunc(body, BODY_MAX)}\n\n处理入口：${link}` : trunc(body, BODY_MAX);
      const res = await deps.mailer.send({
        to: filtered.join(', '),
        cc: ccList.length > 0 ? ccList : undefined,
        subject: trunc(subject, SUBJECT_MAX), body: text, inReplyTo: '',
      });
      if (!res.ok) log(`[notify-email] ${subject}: ${res.error.message}`);
    } catch (e) {
      log(`[notify-email] ${subject}: ${String(e).slice(0, 160)}`);
    }
  };
  const wf = (w: Workflow): string => w.title;
  return {
    async gateWaiting(w: Workflow, st: Step, summary: string) {
      await send(`[juli] 待审批：${st.title}`, `单：${wf(w)}\n${summary}`, w.id);
    },
    async workflowDone(w: Workflow, summary: string) {
      await send(`[juli] 业务流完成：${wf(w)}`, summary, w.id);
    },
    async workflowFailed(w: Workflow, summary: string) {
      await send(`[juli] 流水失败：${wf(w)}`, summary, w.id);
    },
    async chainDangling(w: Workflow, note: string) {
      await send(`[juli] 链尾悬空：${wf(w)}`, note, w.id);
    },
    async stepFailed(w: Workflow, st: Step, reason: string) {
      await send(`[juli] 步骤失败：${st.title}`, `单：${wf(w)}\n${reason}`, w.id);
    },
    async settleHint(w: Workflow, note: string) {
      await send(`[juli] 可结算：${wf(w)}`, note, w.id);
    },
    async awaitingInput(w: Workflow, _st: Step, note: string) {
      // agent 等输入（2026-09-28 提问卡单）：人回答前单子按设计停等——
      // 通知是唯一让「等」可见的通道，深链直达终端去回答。
      await send(`[juli] agent 在等你回答：${wf(w)}`, `${note}\n\n打开 web 终端（会话面板）回复即续跑；或用「干预」面板改派/补指示。`, w.id);
    },
  };
};

/** 双通道组合器（设备推送 + 邮件通知）：三个共享事件并行双发；可选事件
 * （chainDangling/stepFailed）按 PusherPort 可选语义——某一侧实现了才在
 * 组合体上存在（只调实现侧），两侧都缺则为 undefined。全部 fire-and-forget：
 * 方法立即返回 resolved promise，实际发送后台跑、错误收口在本层——引擎在
 * withLock 内 await 这些方法，SMTP 的 30s 级最坏延迟绝不能串进持锁路径
 * （对齐引擎 stepFailed 调用点的尽力而为形态）。 */
export const combinePushers = (a: PusherPort | null, b: PusherPort | null): PusherPort => {
  // 未捕获 rejection 是红线：任一侧失败只吞不冒（与 pushAll 的 .catch 同语义），
  // 且不影响另一侧的发送。
  const fire = (p: PusherPort | null, work: (p: PusherPort) => Promise<void>): void => {
    if (p) void work(p).catch(() => undefined);
  };
  return {
    gateWaiting(w, st, summary) {
      fire(a, (p) => p.gateWaiting(w, st, summary));
      fire(b, (p) => p.gateWaiting(w, st, summary));
      return Promise.resolve();
    },
    workflowDone(w, summary) {
      fire(a, (p) => p.workflowDone(w, summary));
      fire(b, (p) => p.workflowDone(w, summary));
      return Promise.resolve();
    },
    workflowFailed(w, summary) {
      fire(a, (p) => p.workflowFailed(w, summary));
      fire(b, (p) => p.workflowFailed(w, summary));
      return Promise.resolve();
    },
    chainDangling: a?.chainDangling !== undefined || b?.chainDangling !== undefined
      ? (w: Workflow, note: string): Promise<void> => {
          fire(a, (p) => (p.chainDangling ? p.chainDangling(w, note) : Promise.resolve()));
          fire(b, (p) => (p.chainDangling ? p.chainDangling(w, note) : Promise.resolve()));
          return Promise.resolve();
        }
      : undefined,
    stepFailed: a?.stepFailed !== undefined || b?.stepFailed !== undefined
      ? (w: Workflow, st: Step, reason: string): Promise<void> => {
          fire(a, (p) => (p.stepFailed ? p.stepFailed(w, st, reason) : Promise.resolve()));
          fire(b, (p) => (p.stepFailed ? p.stepFailed(w, st, reason) : Promise.resolve()));
          return Promise.resolve();
        }
      : undefined,
    settleHint: a?.settleHint !== undefined || b?.settleHint !== undefined
      ? (w: Workflow, note: string): Promise<void> => {
          fire(a, (p) => (p.settleHint ? p.settleHint(w, note) : Promise.resolve()));
          fire(b, (p) => (p.settleHint ? p.settleHint(w, note) : Promise.resolve()));
          return Promise.resolve();
        }
      : undefined,
    awaitingInput: a?.awaitingInput !== undefined || b?.awaitingInput !== undefined
      ? (w: Workflow, st: Step, note: string): Promise<void> => {
          fire(a, (p) => (p.awaitingInput ? p.awaitingInput(w, st, note) : Promise.resolve()));
          fire(b, (p) => (p.awaitingInput ? p.awaitingInput(w, st, note) : Promise.resolve()));
          return Promise.resolve();
        }
      : undefined,
  };
};

/** 告警分级降噪包装（alert_grade 挂点，2026-09-27）：在真实推送面外挂语义
 * 分级——grade 返回 false（info 高置信）则静默跳过本次推送，其余情况（含
 * grade 抛错=分级挂了照推）全部放行。与 combinePushers 同款 fire-and-forget：
 * 分级判定在后台跑——provider 黑洞最坏 +30s（网关 clamp 上界）只延迟这条
 * 通知本身，绝不串进引擎持锁路径。每条推送只问一次分级，设备/邮件两通道
 * 同享裁断。title/body 按事件形状给：workflow 类事件取 w.title+摘要/reason。 */
export const withAlertGrade = (
  inner: PusherPort,
  grade: (title: string, body: string) => Promise<boolean>,
): PusherPort => {
  const graded = (work: () => Promise<void>, title: string, body: string): void => {
    void (async () => {
      let pass = true;
      try {
        pass = await grade(title, body);
      } catch { pass = true; }
      if (!pass) return;
      await work();
    })().catch(() => undefined);
  };
  return {
    gateWaiting: (w, st, summary) => {
      graded(() => inner.gateWaiting(w, st, summary), w.title, summary);
      return Promise.resolve();
    },
    workflowDone: (w, summary) => {
      graded(() => inner.workflowDone(w, summary), w.title, summary);
      return Promise.resolve();
    },
    workflowFailed: (w, summary) => {
      graded(() => inner.workflowFailed(w, summary), w.title, summary);
      return Promise.resolve();
    },
    chainDangling: inner.chainDangling !== undefined
      ? (w: Workflow, note: string): Promise<void> => {
          graded(() => (inner.chainDangling ? inner.chainDangling(w, note) : Promise.resolve()), w.title, note);
          return Promise.resolve();
        }
      : undefined,
    stepFailed: inner.stepFailed !== undefined
      ? (w: Workflow, st: Step, reason: string): Promise<void> => {
          graded(() => (inner.stepFailed ? inner.stepFailed(w, st, reason) : Promise.resolve()), w.title, reason);
          return Promise.resolve();
        }
      : undefined,
    settleHint: inner.settleHint !== undefined
      ? (w: Workflow, note: string): Promise<void> => {
          graded(() => (inner.settleHint ? inner.settleHint(w, note) : Promise.resolve()), w.title, note);
          return Promise.resolve();
        }
      : undefined,
    awaitingInput: inner.awaitingInput !== undefined
      ? (w: Workflow, st: Step, note: string): Promise<void> => {
          graded(() => (inner.awaitingInput ? inner.awaitingInput(w, st, note) : Promise.resolve()), w.title, note);
          return Promise.resolve();
        }
      : undefined,
  };
};
