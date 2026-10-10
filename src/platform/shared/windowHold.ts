// 工作时间窗 hold 策略（2026-09-28 用户需求③）：北京时间高价时段（默认
// 14:00–17:00，用户口径「这个时候 token 很贵」）非 high 任务 hold——hold
// 必须放在判定/派发**之前**（进件落账零 token，jev 判定与 agent 派发都挪
// 到放行后才真省钱），紧急项走零成本规则直通（关键词/发件人白名单，不靠
// LLM 判）。纯函数零依赖：时钟由调用方注入（引擎 clock 可拨，测试确定性）。
// 层级：platform/shared（engine 与 intake 两侧消费，intake 只准 import 本包）。

export interface HoldWindowConfig {
  /** off=不启用（旧行为）；shadow=只记「本应 hold」不改行为；on=真 hold。 */
  readonly mode: 'off' | 'shadow' | 'on';
  /** 窗口起点 "HH:MM"（含）。默认 "14:00"。 */
  readonly start: string;
  /** 窗口终点 "HH:MM"（不含）。默认 "17:00"。支持跨午夜（start>end）。 */
  readonly end: string;
  /** IANA 时区，默认 Asia/Shanghai——与宿主机时区无关（部署机漂移不影响口径）。 */
  readonly timezone: string;
  /** hold 生效面：feedback（v1 默认，只圈 feedback 进件单——客户对话邮件
   * 时效性不同，先不圈）| all（全队列任务）。 */
  readonly scope: 'feedback' | 'all';
  /** 同渠道聚合 flush 节流（分钟）：mirror 高频 sweep 下没有它就是「每
   * sweep 一张批量单」，「一段时间攒一条 Message」失效。 */
  readonly aggregate_throttle_min: number;
}

export const DEFAULT_HOLD_WINDOW: HoldWindowConfig = {
  mode: 'off', start: '14:00', end: '17:00', timezone: 'Asia/Shanghai',
  scope: 'feedback', aggregate_throttle_min: 120,
};

/** "HH:MM" → 当日分钟数（0–1440）。非法格式返回 null（配置面拼写保护）。 */
export const parseHM = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
};

/** 配置可执行性：两端合法且不重合（重合窗=零长度窗，按坏配置处理）。 */
export const validHoldWindow = (c: HoldWindowConfig): boolean => {
  const s = parseHM(c.start);
  const e = parseHM(c.end);
  return s !== null && e !== null && s !== e;
};

/** now 在该时区的当日钟表分钟（0–1439）。非法时区返回 null（按不在窗口
 * 处理——坏配置 fail-open，绝不能因为时区串拼错把队列永久 hold 死）。 */
export const localMinutesOfDay = (now: Date, timezone: string): number | null => {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const h = parts.find((x) => x.type === 'hour')?.value;
    const m = parts.find((x) => x.type === 'minute')?.value;
    if (h === undefined || m === undefined) return null;
    return Number(h) * 60 + Number(m);
  } catch {
    return null;
  }
};

export interface HoldVerdict {
  /** 当前时点窗口是否生效（与 mode 无关——mode 决定「生效了之后做不做」。 */
  readonly inWindow: boolean;
  readonly mode: 'off' | 'shadow' | 'on';
  /** 不可执行的坏配置原因（空串=配置健康）。 */
  readonly reason: string;
}

/** 裁定 now 是否落在 hold 窗口内。坏配置/坏时区一律 inWindow=false（fail-open：
 * hold 失效的代价是多花 token，hold 误生效的代价是全队列停摆——两个方向
 * 只许前者）。 */
export const holdVerdict = (now: Date, cfg: HoldWindowConfig | undefined): HoldVerdict => {
  if (cfg === undefined || cfg.mode === 'off') return { inWindow: false, mode: cfg?.mode ?? 'off', reason: '' };
  const s = parseHM(cfg.start);
  const e = parseHM(cfg.end);
  if (s === null || e === null || s === e) return { inWindow: false, mode: cfg.mode, reason: 'bad-window' };
  const m = localMinutesOfDay(now, cfg.timezone);
  if (m === null) return { inWindow: false, mode: cfg.mode, reason: 'bad-timezone' };
  const inWindow = s < e ? m >= s && m < e : m >= s || m < e;
  return { inWindow, mode: cfg.mode, reason: '' };
};
