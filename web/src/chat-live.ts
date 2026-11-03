// 发单对话实时帧 reducer（2026-10-21「call 效果」：异步思考/工具调用/开单边
// 发生边上屏）。服务端早已逐帧镜像（intake.turn onEvent → chatHub；routes/chat.ts
// 注释：憋到回合结束才镜像=全程死机感），iOS ChatViewModel 一直靠 /ws/chat
// 渲染；web 此前只吃 POST 整包。本模块=零 DOM 判定层：流式 thinking、assistant
// chunk 原位合并（照 iOS 语义）、intake-plan 块剥离、计划卡/相位/开单回执，
// 以及「本次操作期间 WS 已渲染过」的去重标记——POST 回包据此降级为兜底
// （WS 没通时整包渲染）与终稿校正（chunk 边界切断围栏时以服务端剥净的 reply
// 为准）。vitest 直接可测（views/chat.ts 只做执行）。

/** /ws/chat 下行帧（wirehubs.toWireEvent 口径：chat: 前缀已剥）。 */
export interface WireFrame {
  readonly type: string;
  readonly data?: string;
}

export interface LivePlan {
  readonly title: string;
  readonly summary: string;
  readonly brief: string;
  readonly pinnedSession?: string;
  readonly landing?: { readonly session: string; readonly note: string };
}

export type LiveOp =
  /** 累计 thinking 文本（流式，整段重绘）。 */
  | { readonly kind: 'thinking'; readonly text: string }
  /** assistant 文本块；fresh=新开气泡，否则追加到流式中的气泡。 */
  | { readonly kind: 'assistant_chunk'; readonly text: string; readonly fresh: boolean }
  /** 回合收口：清 thinking、流式气泡定稿（Markdown 重绘+落档）。 */
  | { readonly kind: 'turn_done' }
  | { readonly kind: 'tool'; readonly name: string }
  /** 计划卡（null=服务端帧 JSON 变形，显性告警不静默）。 */
  | { readonly kind: 'plan'; readonly plan: LivePlan | null }
  | { readonly kind: 'phase'; readonly phase: string }
  | { readonly kind: 'system'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string }
  | { readonly kind: 'dispatched'; readonly id: string };

/** 剥 ```intake-plan / ```plan 围栏块（iOS stripPlanBlocks 同款正则）——计划
 * 经 plan 帧走卡片，原始 JSON 不进气泡。围栏名带词边界（b45 R1-FX P2）：
 * ```plaintext/```plantuml 等前缀撞名块不误吃（服务端/webapp 同批同法）。 */
export const stripPlanBlocks = (text: string): string =>
  text.replace(/```(?:intake-)?plan(?![a-z0-9-])[\s\S]*?```\s*/g, '');

/** tool_call 帧 data 实测是 JSON `{"tool":"list_tasks","args":{…}}`（2026-10-21
 * 对 live 引擎探针）——活动行只露工具名，参数原文不进界面（只读白名单查询的
 * 透明化纪律）；非 JSON/无 tool 键时退回原串（截断）。 */
export const toolNameOf = (data: string): string => {
  try {
    const p = JSON.parse(data) as { tool?: unknown; name?: unknown };
    if (typeof p.tool === 'string' && p.tool !== '') return p.tool;
    if (typeof p.name === 'string' && p.name !== '') return p.name;
  } catch { /* 非 JSON */ }
  return data.length > 40 ? `${data.slice(0, 40)}…` : data;
};

/** 朗读用文本（通话开单）：去 Markdown 形态（代码块占位/去行内码/链接取锚文
 * 本/去强调符号）、去 wf_ 单号（念出来是灾难）、空白折叠、超长截断。 */
export const speechText = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, '（代码）')
    .replace(/\bwf_[0-9a-f]{12}\b/g, '') // 先于强调符号剥离（wf_ 的下划线会被吃掉）
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)[^)]+\)/g, '$1')
    .replace(/[*_#>~|`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);

// ---- 语音确认分类（零 DOM；通话开单）-----------------------------------------------

export type ConfirmIntent = 'confirm' | 'deny' | 'revise';

/** 计划卡在场时的语音裁决：只认「纯确认/纯否决」短句，其余一律当修订轮次进
 * 对话——误触发开单的代价远大于多说一轮。 */
export const classifyConfirmUtterance = (text: string): ConfirmIntent => {
  const t = text.trim().replace(/[。.!！?？\s]+$/g, '');
  if (t.length > 0 && t.length <= 6 && /^(确认|确认开单|开单|开吧|就这么开|好的?|可以|行|没问题|对|对的|就这样|就这么办)(吧|了|啊|呀)?$/.test(t)) return 'confirm';
  if (t.length > 0 && t.length <= 6 && /^(取消|算了|先不开|不开|不改了|不要|不用了?|再想想|等等|不对)(吧|了|啊|呀)?$/.test(t)) return 'deny';
  return 'revise';
};

/** 帧流地址：conv 分线程 + token 走 query（wirehubs.acceptWithToken 口径）。 */
export const chatWsUrl = (proto: 'ws' | 'wss', host: string, conv: string, token: string): string =>
  `${proto}://${host}/ws/chat?conv=${encodeURIComponent(conv)}${token !== '' ? `&token=${encodeURIComponent(token)}` : ''}`;

/** 断线退避：1s 起倍增封顶 15s（iOS 封顶 60s；桌面常驻页面更勤一点）。 */
export const chatReconnectDelayMs = (attempt: number): number =>
  Math.min(15_000, 1_000 * 2 ** Math.max(0, Math.min(attempt, 6)));

export interface LiveChat {
  /** 帧 → 操作列表；[] 表示忽略（ping/未知）。 */
  handle(frame: WireFrame): LiveOp[];
  /** 一次操作（turn/confirm/deny）开始：此后到的帧记作该操作的实时渲染。 */
  beginOp(): void;
  /** 本次操作期间收到过帧（POST 回包据此只校正、不重渲染）。 */
  liveSeen(): boolean;
  /** 本次操作期间流式渲染过 assistant 气泡。 */
  streamed(): boolean;
  sawDone(): boolean;
  /** 操作结束（POST 回包已消费），标记归零。 */
  endOp(): void;
  /** 连接断掉：流式中的气泡立即定稿（done 帧无缓冲无回放，已丢）。 */
  disconnected(): LiveOp[];
}

export const createLiveChat = (): LiveChat => {
  let streaming = false;
  let thinking = '';
  let opActive = false;
  let seen = false;
  let streamed = false;
  let done = false;

  const parsePlan = (raw: string): LivePlan | null => {
    try {
      const p = JSON.parse(raw) as Partial<LivePlan>;
      if (typeof p.title !== 'string' || typeof p.brief !== 'string') return null;
      return { title: p.title, summary: typeof p.summary === 'string' ? p.summary : '', brief: p.brief, ...(p.pinnedSession !== undefined ? { pinnedSession: p.pinnedSession } : {}), ...(p.landing !== undefined ? { landing: p.landing } : {}) };
    } catch {
      return null;
    }
  };

  return {
    handle(frame) {
      const data = frame.data ?? '';
      if (frame.type === 'ping') return [];
      if (opActive) seen = true;
      switch (frame.type) {
        case 'thinking':
          thinking += data;
          return [{ kind: 'thinking', text: thinking }];
        case 'assistant': {
          thinking = '';
          const chunk = stripPlanBlocks(data);
          if (chunk === '') return [];
          // 已知残差（接受不修，与 voicechat R3 披露残差 #3 同族）：HTTP 回包与
          // WS 帧双连接乱序、endOp 之后 chunk 才迟到时，fresh=true 会新开一条
          // 残缺气泡——极窄时序，transcript 重载后自愈。
          const fresh = !streaming;
          streaming = true;
          if (opActive) streamed = true;
          return [{ kind: 'assistant_chunk', text: chunk, fresh }];
        }
        case 'done':
          thinking = '';
          streaming = false;
          if (opActive) done = true;
          return [{ kind: 'turn_done' }];
        case 'tool_call':
          return data === '' ? [] : [{ kind: 'tool', name: toolNameOf(data) }];
        case 'plan':
          return [{ kind: 'plan', plan: parsePlan(data) }];
        case 'phase':
          return [{ kind: 'phase', phase: data === '' ? 'discuss' : data }];
        case 'system':
          return data === '' ? [] : [{ kind: 'system', text: data }];
        case 'error':
          thinking = '';
          streaming = false;
          return [{ kind: 'error', text: data === '' ? 'unknown error' : data }];
        case 'dispatched':
          return data === '' ? [] : [{ kind: 'dispatched', id: data }];
        default:
          return [];
      }
    },
    beginOp() {
      opActive = true;
      seen = false;
      streamed = false;
      done = false;
    },
    liveSeen() { return seen; },
    streamed() { return streamed; },
    sawDone() { return done; },
    endOp() {
      opActive = false;
      seen = false;
      streamed = false;
      done = false;
    },
    disconnected() {
      thinking = '';
      if (!streaming) return [];
      streaming = false;
      return [{ kind: 'turn_done' }];
    },
  };
};
