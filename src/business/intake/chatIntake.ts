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

import { createOrchestrator, type Orchestrator, type OrchestratorEvent } from '@juli-os/agents';
import type { Tool } from '@juli-os/agents';
import { type ChatLlmPort } from '@juli-os/agents';
import type { Result } from '@juli-os/artifacts';

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

const INTAKE_PLAN_RE = /```intake-plan\s*([\s\S]*?)\s*```/;

export const extractIntakePlanBlock = (text: string): StagedIntakePlan | null => {
  const m = INTAKE_PLAN_RE.exec(text);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]!.trim()) as Record<string, unknown>;
    const title = typeof v['title'] === 'string' ? v['title'] : '';
    const brief = typeof v['brief'] === 'string' ? v['brief'] : '';
    if (title === '' || brief === '') return null;
    return {
      title,
      summary: typeof v['summary'] === 'string' ? v['summary'] : '',
      brief,
      pinnedSession: typeof v['pinned_session'] === 'string' ? v['pinned_session'] : '',
    };
  } catch {
    return null;
  }
};

/** 摘要面剥掉计划块（朗读 / 回显不念 JSON）。 */
export const stripIntakePlanBlock = (text: string): string =>
  text.replace(INTAKE_PLAN_RE, '').trim();

export const INTAKE_SYSTEM_PROMPT = [
  '你是 juli 的开单助手。用户（juli 的运营者）会用一段话——常是语音转写——说出想做的事；你的唯一目标：把这一单聊清楚，然后提议开单。',
  '',
  '纪律：',
  '1. 只读查询：你可以调用这五个工具——lookup_customer（查客户归属 / 历史单数）、list_tasks（查在办 / 最近单）、get_task（按单子 ID 查全息：步骤进展 / 等谁批准 / 结果工件 / 成本）、list_sessions（会话清单与在办分布）、service_info（juli-service 自身：版本号 / 模型 / 端口 / 单量 / 今日用量）。查到的结论用来回答与提问，引用单子时给出完整 ID。你没有其它任何工具，也没有任何写操作——开单只走用户的确认按钮。',
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
   * 层判定的落点（0930）——input.session 钉死起点，引擎侧零新机制。 */
  readonly startTask: (title: string, brief: string, session?: string, autoApprove?: boolean) => Promise<Result<{ readonly id: string }, Error>>;
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
  /** autoApprove=计划卡「本单免批」勾选（人的决定，随 confirm 进 meta）。 */
  confirm(opts?: { autoApprove?: boolean }): Promise<ChatIntakeConfirm>;
  deny(): ChatIntakeTurn;
  state(): ChatIntakeState;
  reset(): void;
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
      push(e);
      if (e.type === 'text' && e.content !== '') lastText = e.content;
    });
    const plan = extractIntakePlanBlock(lastText);
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

  const doConfirm = async (opts?: { autoApprove?: boolean }): Promise<ChatIntakeConfirm> => {
    const events: ChatIntakeEvent[] = [];
    const plan = staged;
    staged = null;
    phase = 'discuss';
    if (!plan) return { events, runId: null };
    // 注入口径（十一跑 P1-1，与 HTTP 线 lifecycle.ts 同款）：只有「真判定」
    // （jev 采纳 / 忙闲改道）或用户显式钉住才随 input.session 播种（播种即
    // session_pinned，忙时只排队）；fail-open default 落空不注——计划卡照常
    // 显示落点（display 与注入分离，web/iOS 只读 session/note 两键）。
    const pinned = plan.pinnedSession !== undefined && plan.pinnedSession !== ''
      && plan.pinnedSession === (plan.landing?.session ?? '');
    const routed = plan.landing?.via === 'jev' || plan.landing?.diverted === true;
    const session = pinned || routed ? (plan.landing?.session ?? '') : '';
    const res = await deps.startTask(plan.title, plan.brief, session !== '' ? session : undefined, opts?.autoApprove === true);
    if (!res.ok) {
      // 开单失败显性报错回到讨论——单没开出去，对话不能装作成功。
      events.push({ type: 'chat:error', data: `开单失败: ${res.error.message}` });
      return { events, runId: null };
    }
    events.push({ type: 'chat:dispatched', data: res.value.id });
    events.push({ type: 'chat:phase', data: 'discuss' });
    events.push({ type: 'chat:system', data: `已开单 ✓ ${res.value.id}${opts?.autoApprove === true ? '（本单免批：非发送闸门将自动批准）' : ''}` });
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
    reset() {
      staged = null;
      phase = 'discuss';
      orch.reset();
    },
  };
};
