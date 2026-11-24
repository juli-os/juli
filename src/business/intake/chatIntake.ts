// 开单对话（chat intake）loop 本体：把「一句模糊想法」碾成「context 足够
// 的 brief」再走标准进件。设计裁定（2026-09-29 对话定案）：
//   · loop 只做文本理解 + 只读查询（白名单见 chatTools.ts），零写工具；
//   · 收敛 = 回复末尾的 ```intake-plan 块（title/summary/brief），用户点
//     确认才开单——创建动词是人，机器只申报（事件纪律原样吃到新渠道）；
//   · confirm 直调 startTask（与 #/trigger 表单同一正门，chat-born 单零
//     特权）；对话 transcript 不进账，是表单草稿的待遇。
// 循环机械复用编排器（platform/agents/orchestrator），本模块只叠进件纪律
// （system prompt + 计划块暂存 + 确认派发），事件形状沿用 voice.ts 的
// chat:X 线上协议——/ws/chat 的 iOS 客户端零改动吃到。

import { createOrchestrator, type ChatLlmPort, type Orchestrator, type OrchestratorEvent, type Tool } from '@juli-os/agents';
import { type Result } from '../../platform/shared/result.ts';

export interface IntakeLanding {
  readonly session: string;
  readonly note: string;
  /** 判定来源（routeTask 透传，runtime.resolveLanding 带过）：jev=内容判定
   * 采纳；default=fail-open 兜底。注入口径与 HTTP 线同款（十一跑 P1-1）：
   * 只有 jev 采纳或忙闲改道才算「真判定」随 confirm 注入——fail-open default
   * 只供计划卡显示，注入会把 default 当显式钉住（播种即 session_pinned），
   * 忙时只排队挤死既有改道。缺省（钉住转述的 landing/旧调用方）按 fail-open
   * 处理，钉住走自己的注入通道。 */
  readonly via?: 'jev' | 'default';
  /** 忙闲改道发生过（真判定）。 */
  readonly diverted?: boolean;
}

export interface StagedIntakePlan {
  readonly title: string;
  readonly summary: string;
  readonly brief: string;
  /** 用户在对话中显式点名会话（LLM 原样转述用户指令，非其自行判断）——
   * 经 pinnableSessions 校验后才生效（钉住=显式路由，不改道宁可排队）。 */
  readonly pinnedSession?: string;
  /** 路由层判定的落点（0930「所有的都走路由」）：chat 层不自选会话，
   * resolveLanding 由 runtime 接 routeTask。 */
  readonly landing?: IntakeLanding;
}

export type IntakePhase = 'discuss' | 'proposed';

export interface ChatIntakeEvent {
  readonly type: 'chat:plan' | 'chat:phase' | 'chat:dispatched' | 'chat:system' | 'chat:error';
  readonly data: string;
}

/** 回合事件流 = 编排器原事件（text/thinking/tool_call/tool_result/done，
 * 路由层镜像进 chatHub 供 /ws/chat 客户端渲染）+ 进件事件（chat:X 计划卡相位）。 */
export type ChatIntakeStreamEvent = ChatIntakeEvent | OrchestratorEvent;

// 2026-10-27 手机「JSON 堆 + 卡不弹」事故：glm-5.3-flash 四次提议三次漏写闭合
// 围栏（JSON 完整、结尾断在 `"}`）。提取/在场只认闭合围栏 → 卡永不弹，且
// 半开形态连 hasIntakePlanBlock 都不认 →「JSON 炸了」告警也被静默吞。半开
// 容差：在场 = 围栏起笔在场；提取 = 从围栏后第一个括号配平的 JSON 对象取
// （闭合围栏在不在都行）。
// 提取/在场只认 intake-plan 单名（进件语义要「第一处 intake-plan 内容」，不随
// 剥除显示面的双名走）；名字带词边界（b45 R1-FX P2：```intake-plans 是别的
// 代码块，不许被误认）。
const INTAKE_PLAN_RE = /```intake-plan(?![a-z0-9-])/;

// ---- intake-plan 剥除（服务端与 webapp 逐字符同构，含分号；chat-strip-parity.test.ts 钉两侧同文）----
// 摘要面剥除与 webapp 客户端 stripPlanFences（chat-live.ts）必须同法（b44 R2
// NEW-γ）：全局、双名（intake-plan|plan）、半开围栏也剥。否则 LLM 输出 ```plan
// 围栏或双 intake-plan 时服务端 reply 残留围栏 ≠ 客户端剥净稿，heal 把围栏
// JSON 原文写回显示面。
// 2026-11-23 修「brief 里带 ``` 时确认卡不弹、屏幕上漏 JSON」：旧实现靠非贪婪
// 正则 ```intake-plan…``` 找结尾，brief 的字符串里只要出现三个反引号（比如写了
// 一条命令），正则就停在正文内部——取出来是半截 JSON（解析失败，卡不弹），
// 剥除也只剥到那里（后面的 JSON 留在屏幕上）。2026-10-27 修过同类事故（模型
// 漏写闭合围栏），没覆盖这种写法。
// 现在按「JSON 对象括号配平」找结尾：从围栏后第一个能解析的 {...} 起算，数
// 花括号时认得字符串（字符串里的括号、转义引号、反引号都不影响），对象结束
// 就是计划块结束；对象之后【紧跟着】的光杆 ``` 才是闭合围栏，一并剥掉。
// 2026-11-24 修「计划块剥除多删正文」（R1 审查 P2-③）：此前按「对象之后第一个
// 光杆围栏」找闭合，模型漏写闭合围栏、后面的正文里又有代码块、第二块计划或
// 错位的围栏时，中间的正文被一起删掉了。现在闭合围栏只有紧跟着才算（见
// intakePlanBlockEndAfter）。
/** 围栏起点：```intake-plan 或 ```plan（只用于剥除——提取/在场仍只认 intake-plan）。
 *  名字后不许再跟小写字母/数字/连字符：```plaintext / ```plantuml / ```intake-plans
 *  是别的代码块（b45 R1-FX P2）。 */
const INTAKE_PLAN_FENCE_RE = /```(?:intake-plan|plan)(?![a-z0-9-])/g;
/** text 里 from 起第一个「光杆 ```」的下标；找不到返回 -1。后面还跟着字母数字的
 *  是别的代码块的开栏（```bash），不算闭合围栏。 */
const intakePlanCloseFence = (text: string, from: number): number => {
  for (let at = text.indexOf('```', from); at >= 0; at = text.indexOf('```', at + 3)) {
    if (!/[A-Za-z0-9]/.test(text.charAt(at + 3))) return at;
  }
  return -1;
};
/** 从 open（一个 `{`）起字符串-aware 地数花括号，返回对象结束下标（不含）；
 *  扫到 upto（缺省文末）还没配平返回 -1。字符串里的括号不计，`\"` 不翻字符串态。 */
const jsonEndOf = (text: string, open: number, upto = text.length): number => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < upto; i++) {
    const ch = text.charAt(i);
    if (escaped) {
      escaped = false;
    } else if (ch === '\\') {
      if (inString) escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return i + 1;
    }
  }
  return -1;
};
/** text 里 from 起第一个「括号配平且能 JSON.parse」的对象，返回 [起点, 结束)；
 *  找不到返回 null。括号配平但解析不了的跳过往后找（围栏里的散文花括号、
 *  夹进来的别的 JSON）；扫到文末都没配平（JSON 截断）就是找不到。 */
const intakePlanObject = (text: string, from: number): readonly [number, number] | null => {
  let at = from;
  for (;;) {
    const open = text.indexOf('{', at);
    if (open < 0) return null;
    const end = jsonEndOf(text, open);
    if (end < 0) return null;
    try {
      JSON.parse(text.slice(open, end));
      return [open, end];
    } catch {
      at = end;
    }
  }
};
/** text[at] 起是不是一个括号配平、能 JSON.parse 的对象；是就返回它的结束下标
 *  （不含），不是返回 -1。只认「正好从 at 起头」的，不往后找。 */
const jsonObjectAt = (text: string, at: number): number => {
  if (text.charAt(at) !== '{') return -1;
  const end = jsonEndOf(text, at);
  if (end < 0) return -1;
  try {
    JSON.parse(text.slice(at, end));
    return end;
  } catch {
    return -1;
  }
};
/** 从 from（围栏起点之后）算计划块的结束下标（不含）。
 *  · 有能解析的对象：交给 intakePlanBlockEndAfter（闭合围栏只有紧跟着才算）。
 *  · 没有能解析的对象（JSON 截断、围栏里没 JSON）：候选闭合围栏之前 JSON 还
 *    没结束（引号/花括号没合上）→ 它是 brief 里的反引号，往后找；都没有就
 *    剥到文末（流式半开的旧口径）。 */
const intakePlanBlockEnd = (text: string, from: number): number => {
  const obj = intakePlanObject(text, from);
  if (obj !== null) return intakePlanBlockEndAfter(text, obj[1]);
  const open = text.indexOf('{', from);
  for (let at = intakePlanCloseFence(text, from); at >= 0; at = intakePlanCloseFence(text, at + 3)) {
    if (open >= 0 && open < at && jsonEndOf(text, open, at) < 0) continue;
    return at + 3;
  }
  return text.length;
};
/** 对象结束后「可以紧跟着」的填充：空白，以及手抖多打的 `;` 和 `}`。 */
const INTAKE_PLAN_TAIL_RE = /^[\s;}]*/;
/** 从对象结束处（end）算计划块的结束下标（不含）——闭合围栏只有【紧跟着】才
 *  算（R1 审查 P2-③，2026-11-24）。模型漏写闭合围栏时，后面正文里的代码块、
 *  第二块计划、错位的围栏都不是这一块的；按「后面第一个围栏」去找会把中间
 *  的正文一起删掉。所以从 end 起只认三种紧挨着的东西，一格一格往后挪：
 *  ① 空白和手抖多打的 `;` `}`；
 *  ② 又一个能解析的 JSON 对象（围栏里混进两个对象的形态——都是计划块的 JSON，
 *     不是正文，留一个在屏幕上就是漏 JSON）；
 *  ③ 光杆的闭合围栏（后面不跟字母数字——跟了名字的是别的代码块的开栏）。
 *  遇到别的字符就停：计划块到最后一个对象结束为止，后面的正文照留。 */
const intakePlanBlockEndAfter = (text: string, end: number): number => {
  let last = end;
  for (let at = end; ; ) {
    const padding = INTAKE_PLAN_TAIL_RE.exec(text.slice(at));
    at += padding === null ? 0 : padding[0].length;
    if (text.startsWith('```', at) && !/[A-Za-z0-9]/.test(text.charAt(at + 3))) return at + 3;
    const next = jsonObjectAt(text, at);
    if (next < 0) return last;
    last = next;
    at = next;
  }
};
/** 剥掉计划块（朗读 / 回显不念 JSON）。全局：一块文本里多个计划块都剥；
 *  围栏起点落在已剥的块里（brief 里写了围栏名）不再当新块。 */
const stripPlanFences = (text: string): string => {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(INTAKE_PLAN_FENCE_RE)) {
    if (m.index === undefined || m.index < last) continue;
    const end = intakePlanBlockEnd(text, m.index + m[0].length);
    out += text.slice(last, m.index);
    last = end;
  }
  return (out + text.slice(last)).trim();
};
// ---- intake-plan 剥除结束 ----

/** 摘要面剥掉计划块（朗读 / 回显不念 JSON）。 */
export const stripIntakePlanBlock = stripPlanFences;

/** 提取计划：围栏后第一个括号配平且能解析的 JSON 对象，取 title/summary/brief。
 * 宽容边界（LLM 输出=外部数据，尾巴带 `};`/换行废话等手抖属常态——
 * 2026-10-17「开单卡不弹」事故：严格 JSON.parse 撞 `"}"};` 尾巴直接炸，catch
 * 静默 null，计划无声丢弃、相位永停 discuss，而 LLM 可见文本还在承诺「我按
 * 这个提议开单」）。 */
export const extractIntakePlanBlock = (text: string): StagedIntakePlan | null => {
  const m = INTAKE_PLAN_RE.exec(text);
  if (m === null) return null;
  const span = intakePlanObject(text, m.index + m[0].length);
  if (span === null) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text.slice(span[0], span[1])) as Record<string, unknown>;
  } catch {
    return null; // intakePlanObject 已验过可解析；这里只是不让解析异常外溢
  }
  const title = typeof v['title'] === 'string' ? v['title'] : '';
  const brief = typeof v['brief'] === 'string' ? v['brief'] : '';
  if (title === '' || brief === '') return null;
  return {
    title,
    summary: typeof v['summary'] === 'string' ? v['summary'] : '',
    brief,
    pinnedSession: typeof v['pinned_session'] === 'string' ? v['pinned_session'] : '',
  };
};

/** 计划块是否在场（与解析成败无关）——2026-10-27 起半开围栏也算在场：turn
 * 侧用它区分「没提议」和「提议了但 JSON 炸了」（后者必须显性告警，不能再无声吞）。 */
export const hasIntakePlanBlock = (text: string): boolean => INTAKE_PLAN_RE.test(text);

export const INTAKE_SYSTEM_PROMPT = [
  '你是 juli 的开单助手。用户（juli 的运营者）会用一段话——常是语音转写——说出想做的事；你的唯一目标：把这一单聊清楚，然后提议开单。',
  '',
  '纪律：',
  '1. 只读查询：你可以调用这五个工具——lookup_customer（查客户归属 / 历史单数）、list_tasks（查在办 / 最近单；找以前的老单子带 q 关键词按标题或单号搜，别只翻最近清单）、get_task（按单子 ID 查全息：步骤进展 / 等谁批准 / 结果工件 / 成本）、list_sessions（会话清单与在办分布）、service_info（juli-service 自身：版本号 / 模型 / 端口 / 单量 / 今日用量）。查到的结论用来回答与提问，引用单子时给出完整 ID。你没有其它任何工具，也没有任何写操作——开单只走用户的确认按钮。',
  '2. 不清楚就问：每轮只问当前最关键的 1-2 个问题，按这个顺序补齐——这单是给哪个客户的？要什么产出（给谁 / 什么格式）？有没有时间点或背景要注意？用户消息可能带语音转写噪音，关键名词（人名 / 公司 / 数字）拿不准就复述确认。',
  '3. 足够清楚就提议：先用一两句话复述这一单要做什么，然后在回复的最末尾输出计划块，格式严格如下，输出后停下等确认：',
  '```intake-plan',
  '{"title":"一句话标题","summary":"一句话概述","brief":"完整 brief：背景 / 要做什么 / 产出与收件人 / 时限等已确认事实"}',
  '```',
  '4. brief 里只写用户确认过或工具查到的事实，绝不编造；宁可短，不可假。',
  '5. 你绝不自己开单——开单只能由用户确认完成。',
  '6. 闲聊、提问或只是查状态的消息：正常简短回答，不要强行提议开单。',
  '7. 落点（这单派给哪个会话）由系统路由判定，你不要自行挑选、也不要在回复里承诺落点。唯一例外：用户在对话中明确指定了会话名（如「这单给 juli-dev」）时，把该会话名原样填进计划块的 pinned_session 字段——这是转述用户的指令，不是你的判断。用户指定的会话不在可用会话清单里时，如实说明清单里有哪些并询问。',
].join('\n');

/** 可钉会话清单附录（runtime 从声明表拼）：转述钉住/答「有哪些会话」用。 */
export const sessionRosterSection = (roster: string): string =>
  `${INTAKE_SYSTEM_PROMPT}\n\n可用会话清单（仅用于转述用户指定或回答「有哪些会话」；落点由系统判定，你不要自行挑选）：\n${roster}`;

/** 语音回合前缀：本轮输入来自通话转写，回复会被朗读。 */
const VOICE_TURN_PREFIX =
  '[语音输入] 本轮用户消息来自语音转写（可能有同音字 / 断句噪音）。你的回复将被朗读：口语短句，不用 markdown、表格、列表符号；计划块仍按原格式输出在末尾。\n\n';

export interface ChatIntakeTurnOpts {
  readonly voice?: boolean;
  /** 事件实时回调（路由层接 chatHub：LLM 多轮回合 30s+，憋到回合结束才
   * 镜像=客户端全程死机感——实测 0929 TestFlight 首用即弃）。 */
  readonly onEvent?: (e: ChatIntakeStreamEvent) => void;
}

export interface ChatIntakeDeps {
  readonly llm: ChatLlmPort;
  readonly model: string;
  readonly tools: readonly Tool[];
  /** 确认后的开单正门（与 #/trigger 表单同一个 startTask）；session 为路由
   * 层判定的落点（0930），input.session 钉死起点，引擎侧零新机制；tenant
   * 为确认卡显式租户（A3 写侧打标记，HTTP 边界校验过才进来），空缺省 =
   * 引擎按进件信号自行判定。 */
  readonly startTask: (title: string, brief: string, session?: string, autoApprove?: boolean, tenant?: string) => Promise<Result<{ readonly id: string }, Error>>;
  /** 路由层落点判定（runtime 接 routeTask）——chat 层不自选会话。缺省 =
   * 无落点（落 default，测试/降级用）。 */
  readonly resolveLanding?: (title: string, brief: string) => Promise<IntakeLanding>;
  /** 可钉会话名单（声明表非绑定项）：pinned_session 转述校验，非路由判断。 */
  readonly pinnableSessions?: readonly string[];
  /** 可钉会话清单文本（系统提示词附录）。 */
  readonly sessionRoster?: string;
  /** 开单留痕（runtime 接 store.appendEvent route_decision——落点进账本，
   * 路由图 recent 消费同款事件）。 */
  readonly onDispatched?: (info: { id: string; session: string; note: string; pinned: boolean }) => void;
  readonly usage?: (r: { model: string; note: string }) => void;
  readonly log?: (m: string) => void;
}

export interface ChatIntakeTurn {
  readonly events: ChatIntakeStreamEvent[];
  readonly reply: string;
}

export interface ChatIntakeConfirm {
  readonly events: ChatIntakeEvent[];
  readonly runId: string | null;
}

export interface ChatIntakeState {
  readonly phase: IntakePhase;
  readonly plan: StagedIntakePlan | null;
}

export interface ChatIntake {
  turn(input: string, opts?: ChatIntakeTurnOpts): Promise<ChatIntakeTurn>;
  /** autoApprove=计划卡「本单免批」勾选（人的决定，随 confirm 进 meta）；
   * tenant=确认卡显式租户（A3，人的决定，HTTP 边界校验过才进来）。 */
  confirm(opts?: { autoApprove?: boolean; tenant?: string }): Promise<ChatIntakeConfirm>;
  deny(): ChatIntakeTurn;
  state(): ChatIntakeState;
}

export const createChatIntake = (deps: ChatIntakeDeps): ChatIntake => {
  const orch: Orchestrator = createOrchestrator({
    llm: deps.llm,
    model: deps.model,
    tools: deps.tools,
    systemPrompt: deps.sessionRoster !== undefined && deps.sessionRoster !== ''
      ? sessionRosterSection(deps.sessionRoster)
      : INTAKE_SYSTEM_PROMPT,
    maxContextMessages: 60,
    usage: deps.usage,
    log: deps.log,
  });
  let staged: StagedIntakePlan | null = null;
  let phase: IntakePhase = 'discuss';

  // 回合串行化（审查 P1-3）：orchestrator 是单实例（消息历史 + staged 各一
  // 份）；通话插话 / 双端在线会产生并发 turn，交错写入会污染上下文并让
  // staged 计划被静默丢弃。排队执行，后者等前者完成。
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(job: () => Promise<T>): Promise<T> => {
    const next = chain.then(job, job);
    chain = next.catch(() => undefined);
    return next;
  };

  const doTurn = async (input: string, opts: ChatIntakeTurnOpts | undefined): Promise<ChatIntakeTurn> => {
    // 编排器事件原样进流（客户端靠 /ws/chat 的 assistant/done 帧渲染回
    // 复），进件事件（chat:X）追加在其后；onEvent 让每一帧实时出闸。
    const events: ChatIntakeStreamEvent[] = [];
    const push = (e: ChatIntakeStreamEvent): void => {
      events.push(e);
      opts?.onEvent?.(e);
    };
    // 已提议阶段的再输入 = 修订 / 继续讨论：丢弃暂存重新聊（确认只走
    // confirm 端点 / 按钮，文字里说「确认」不算——闸门语义不进对话）。
    if (staged !== null) {
      staged = null;
      phase = 'discuss';
      push({ type: 'chat:phase', data: 'discuss' });
    }
    let lastText = '';
    await orch.handle((opts?.voice === true ? VOICE_TURN_PREFIX : '') + input, (e) => {
      // b44 R1 P1：累积而非赋值——orchestrator 每个 LLM 回合发一个独立完整
      // text 事件（text→tool_call→text 是常态），赋值让 reply 只剩末段：
      // 客户端 heal 以 reply 为权威会把多段合并稿改写成只剩末段（DOM+transcript
      // 双丢前段）。'\n\n' 连接与客户端 mergeAssistant 分段口一致，heal 后
      // last.text === reply 恒成立（幂等 no-op）。单段回复字节级不变。
      // 2026-10-27 手机 JSON 堆事故：展示面净稿出闸——流式 text 事件剥掉计划
      // 块再进流（旧 iOS 客户端逐 chunk 剥不掉跨段/半开围栏，围栏+JSON 原文
      // 直接糊屏）；lastText 累积仍用原文（提取语义见 INTAKE_PLAN_OPEN_RE 注）。
      if (e.type === 'text' && e.content !== '') {
        lastText = lastText === '' ? e.content : `${lastText}\n\n${e.content}`;
        push({ ...e, content: stripIntakePlanBlock(e.content) });
        return;
      }
      push(e);
    });
    const plan = extractIntakePlanBlock(lastText);
    if (plan === null && hasIntakePlanBlock(lastText)) {
      // 2026-10-17 事故形态：块在场但连宽容解析都救不回——显性告警，
      // 绝不再无声吞（用户端表现=LLM 说要开单但卡永不出现）。
      deps.log?.(`[chat-intake] ⚠ 计划块解析失败已丢弃（LLM JSON 严重变形）——用户需再发一轮触发重提议`);
    }
    if (plan !== null) {
      // 落点（0930「所有的都走路由」）：钉住（用户点名的转述，校验过才认）
      // > 路由层判定（routeTask）> 无落点（default）。钉住不改道宁可排队
      // ——与 CLI --session 同语义。判定失败 fail-open（落空=default）。
      const pin = (plan.pinnedSession ?? '').trim();
      const pinned = pin !== '' && (deps.pinnableSessions ?? []).includes(pin);
      let landing: IntakeLanding = { session: '', note: '' };
      if (pinned) {
        landing = { session: pin, note: '按你指定的会话（不改道，忙则排队）' };
      } else {
        try {
          landing = await (deps.resolveLanding?.(plan.title, plan.brief)
            ?? Promise.resolve({ session: '', note: '' }));
        } catch (e) {
          deps.log?.(`[chat-intake] 落点判定失败（fail-open → default）：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      staged = { ...plan, pinnedSession: pinned ? pin : '', landing };
      phase = 'proposed';
      push({ type: 'chat:plan', data: JSON.stringify(staged) });
      push({ type: 'chat:phase', data: 'proposed' });
    }
    return { events, reply: stripIntakePlanBlock(lastText) };
  };

  const doConfirm = async (opts?: { autoApprove?: boolean; tenant?: string }): Promise<ChatIntakeConfirm> => {
    const events: ChatIntakeEvent[] = [];
    const plan = staged;
    staged = null;
    phase = 'discuss';
    if (!plan) return { events, runId: null };
    // 注入口径（十一跑 P1-1 收窄，2026-10-13 判定收敛执行层）：只有用户
    // 显式钉住（pinnedSession 与落点一致）才随 input.session 播种（播种即
    // session_pinned，忙时真排队）——机器判定（jev 采纳/忙闲改道）不再注入：
    // 计划卡落点降级为展示预测，真判定在派发时刻（engine steps 三无腿）对
    // 实时忙闲做。display 与注入分离（web/iOS 只读 session/note 两键）。
    const pinned = plan.pinnedSession !== undefined && plan.pinnedSession !== ''
      && plan.pinnedSession === (plan.landing?.session ?? '');
    const session = pinned ? (plan.landing?.session ?? '') : '';
    // 任务档位（task_tier）第二跳口径（R1-2 定，2026-10-12）：chat 确认线
    // 暂不判档、恒 standard——53c3cc8 有意收窄在 /tasks 无键路径（lifecycle.ts
    // 第二跳），chat 线未收。采用口径唯一事实源 = runtime taskTier；若裁定
    // chat 线也要判档，走共享进件助手收编（扩功能待人裁，勿在此悄悄补）。
    const res = await deps.startTask(
      plan.title, plan.brief,
      session !== '' ? session : undefined,
      opts?.autoApprove === true,
      opts?.tenant !== undefined && opts.tenant !== '' ? opts.tenant : undefined,
    );
    if (!res.ok) {
      // 开单失败显性报错回到讨论——单没开出去，对话不能装作成功。
      events.push({ type: 'chat:error', data: `开单失败: ${res.error.message}` });
      return { events, runId: null };
    }
    events.push({ type: 'chat:dispatched', data: res.value.id });
    events.push({ type: 'chat:phase', data: 'discuss' });
    events.push({ type: 'chat:system', data: `已开单 ✓ ${res.value.id}${opts?.autoApprove === true ? '（本单免批：申报为 apply / artifact 的审批会自动批准；发送审批和问询仍等你）' : ''}` });
    if (session !== '') {
      // 留痕只记「注过」的落点（十一跑 P1-1 次生症状）：fail-open 不注就不留
      // route_decision——裸会话名当 reason 会把「没判」记成「判过」（HTTP 侧
      // 0930 已修，chat 侧对齐）。留痕抛错不推翻已成功的开单（十一跑 P2-2）
      // ——staged 已清，报错只会让双端 UI 无感知，只记日志。
      try {
        deps.onDispatched?.({ id: res.value.id, session, note: plan.landing?.note ?? '', pinned });
      } catch (e) {
        deps.log?.(`[chat-intake] 开单留痕失败（单 ${res.value.id} 已开）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    deps.log?.(`[chat-intake] 开单 ${res.value.id}: ${plan.title}${session !== '' ? ` → ${session}` : ''}`);
    return { events, runId: res.value.id };
  };

  return {
    turn: (input, opts) => serialized(() => doTurn(input, opts)),
    confirm: (opts) => serialized(() => doConfirm(opts)),
    deny() {
      const events: ChatIntakeEvent[] = [];
      staged = null;
      phase = 'discuss';
      events.push({ type: 'chat:phase', data: 'discuss' });
      return { events, reply: '' };
    },
    state() {
      return { phase, plan: staged };
    },
  };
};
