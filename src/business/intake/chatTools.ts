// 开单对话（chat intake）的白名单只读工具：loop 的全部查询面。
// 设计裁定（2026-09-29 对话定案）：发单对话 = clarify 循环 + 只读查询 +
// 收敛成单。这里是那张封闭清单——清单之外的事模型「看不见」而不是「被拒
// 绝」；写语义工具在测试里硬断言不存在（test/chat-intake.test.ts）。
// 工具本体是对 runtime 注入的读函数的薄封装：无业务逻辑，只有参数说明
// 与 JSON 序列化；数据能力来自 party 域 / 账本的现成查询。

import { err, ok } from '@juli-os/artifacts';
import type { Tool } from '@juli-os/agents';

/** 客户行（runtime 从 party 域 CustomerSummary 投影注入）。 */
export interface ChatCustomerRow {
  readonly email: string;
  readonly displayName: string;
  readonly company: string;
  readonly workflows: number;
  readonly lastContactAt: string;
}

/** 任务行（runtime 从账本 Workflow 投影注入）。 */
export interface ChatTaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: string;
}

/** 单子全息（get_task，2026-10-07 用户裁定扩容）：查单子结果与长时进展用。 */
export interface ChatTaskDetail {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly session: string;
  readonly steps: readonly { readonly seq: number; readonly kind: string; readonly title: string; readonly status: string; readonly updatedAt: string }[];
  /** 当前等人批准的闸门步标题（无=不在等人）。 */
  readonly waitingOn: string;
  /** 已登记产物（名称 × 角色；结果工件查这里）。 */
  readonly deliverables: readonly { readonly name: string; readonly role: string }[];
  /** 该单归属 CC 回合数与 API 等效成本（无归属/无用量=0；costCny null=含无价目模型不出价）。 */
  readonly prompts: number;
  readonly costCny: number | null;
}

/** 会话行（list_sessions）：声明表 × 在办分布。 */
export interface ChatSessionRow {
  readonly session: string;
  readonly company: string;
  readonly domain: string;
  readonly description: string;
  /** 名下非终态在办单数。 */
  readonly inflight: number;
}

/** juli-service 自身信息（service_info，2026-10-07 用户裁定新增）：版本号、
 * 模型、端口、单量、今日用量、hold 队列——全部非敏感只读面，零密钥零口令。 */
export interface ChatServiceInfo {
  readonly version: string;
  readonly startedAt: string;
  readonly model: string;
  readonly ports: { readonly http: number; readonly tls: number | null };
  readonly workflows: { readonly total: number; readonly inflight: number; readonly today: number };
  readonly todayTokens: { readonly input: number; readonly output: number; readonly calls: number };
  /** 工作窗 hold 中的单数（高价时段暂停派发）。 */
  readonly heldTasks: number;
}

export interface ChatToolDeps {
  /** 客户模糊查询（邮箱 / 姓名 / 公司名片段）。 */
  readonly lookupCustomer: (query: string) => Promise<readonly ChatCustomerRow[]>;
  /** 任务清单：inflight=非终态在办；recent=最近全部（含终态）；q=标题/ID
   * 关键词过滤（空串=不过滤）——recent+q 由 runtime 放深窗检索（「找单子」
   * 要跨历史，不止最近一批）。 */
  readonly listTasks: (scope: 'inflight' | 'recent', limit: number, q: string) => readonly ChatTaskRow[];
  /** 单子全息（不存在返回 null——工具层转 found:false 回给模型）。 */
  readonly getTask: (wfId: string) => Promise<ChatTaskDetail | null>;
  /** 会话清单（声明表 × 在办）。 */
  readonly listSessions: () => readonly ChatSessionRow[];
  /** 服务自信息。 */
  readonly serviceInfo: () => ChatServiceInfo;
}

/** 白名单唯一事实源：开单 loop 能看见的全部工具名。 */
export const CHAT_TOOL_NAMES = ['lookup_customer', 'list_tasks', 'get_task', 'list_sessions', 'service_info'] as const;

// 上限 100（2026-10-14 用户裁定「找单子只能找 20 太少」；首版 20 窗在多单
// 月份连要跟进的上周单都罩不住）。行是小 JSON（id/标题/状态/时间），100 行
// 仍在单回合预算内；更老的靠 q 关键词深窗检索，不靠拉更大清单。
const clampLimit = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 20;
  return Math.min(Math.max(Math.trunc(v), 1), 100);
};

export const makeChatTools = (deps: ChatToolDeps): readonly Tool[] => [
  {
    name: 'lookup_customer',
    description:
      '按邮箱 / 姓名 / 公司名片段查客户档案（所属公司、历史单数、最近联系时间）。开单前用来确认客户是谁。',
    parameters: [
      { name: 'query', type: 'string', description: '邮箱地址、姓名或公司名片段', required: true },
    ],
    async execute(args) {
      const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
      if (query === '') return ok('[]');
      try {
        return ok(JSON.stringify(await deps.lookupCustomer(query)));
      } catch (e) {
        // 读函数抖动降级为工具错误回给模型——绝不炸穿整个回合（审查 P2）。
        return err(new Error(`lookup_customer: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  },
  {
    name: 'list_tasks',
    description: '查任务单（id / 标题 / 状态）。scope=inflight 只看非终态在办；scope=recent 看最近的全部（含终态）。要找以前的老单子（跟进 / 查重 / 关联）时带 q 关键词按标题或单号搜——比拉最近清单可靠。',
    parameters: [
      { name: 'scope', type: 'string', description: 'inflight=非终态在办单；recent=最近全部（含终态）', required: true },
      { name: 'q', type: 'string', description: '关键词：按标题或单号（wf_ 片段）过滤，大小写不敏感；空=不过滤', required: false },
      { name: 'limit', type: 'number', description: '最多返回条数（1-100，默认 20）', required: false },
    ],
    async execute(args) {
      const scope = args['scope'] === 'recent' ? 'recent' : 'inflight';
      const q = typeof args['q'] === 'string' ? args['q'].trim() : '';
      try {
        return ok(JSON.stringify(deps.listTasks(scope, clampLimit(args['limit']), q)));
      } catch (e) {
        return err(new Error(`list_tasks: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  },
  {
    name: 'get_task',
    description:
      '按单子 ID（wf_ 开头）查单子全息：步骤阶梯与各自状态、当前等谁批准的闸门、已产出的结果工件（名称×角色）、归属回合数与 API 等效成本。查「那单做得怎么样了 / 结果出来没有 / 卡在哪」用它。',
    parameters: [
      { name: 'wf_id', type: 'string', description: '单子 ID（wf_ + 12 位十六进制）', required: true },
    ],
    async execute(args) {
      const id = typeof args['wf_id'] === 'string' ? args['wf_id'].trim() : '';
      if (id === '') return ok('{"found":false,"note":"wf_id required"}');
      try {
        const t = await deps.getTask(id);
        return ok(t === null ? '{"found":false}' : JSON.stringify(t));
      } catch (e) {
        return err(new Error(`get_task: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  },
  {
    name: 'list_sessions',
    description: '查 agent 会话清单（声明表）：每个会话管哪家公司/哪个域、名下在办单数。答「有哪些会话 / 这单会派给谁 / 谁在忙」用它。',
    parameters: [],
    async execute() {
      try {
        return ok(JSON.stringify(deps.listSessions()));
      } catch (e) {
        return err(new Error(`list_sessions: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  },
  {
    name: 'service_info',
    description: '查 juli-service 自身信息：软件版本号、启动时间、所用模型、监听端口、单子总量/在办/今日新增、今日 token 用量、工作窗 hold 中的单数。答「现在什么版本 / 服务跑了多久 / 今天用了多少」用它。',
    parameters: [],
    async execute() {
      try {
        return ok(JSON.stringify(deps.serviceInfo()));
      } catch (e) {
        return err(new Error(`service_info: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  },
];
