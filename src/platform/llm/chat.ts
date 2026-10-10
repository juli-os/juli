// 对话式 LLM 端口（orchestrator 的 tool-calling 用）：完整消息数组 + 工具
// 定义，返回 content + toolCalls。与引擎的 single-shot complete 分开——
// 两者对供应商协议的要求不同，不硬塞一个接口。

import { err, ok, toResult, type Result } from '../shared/result.ts';

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  /** JSON Schema（parameters）。 */
  readonly parameters: Record<string, unknown>;
}

export interface ToolCallRequest {
  /** {role, content, toolCalls?, toolResults?} 的完整消息历史。 */
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolSchema[];
  readonly model?: string;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface ChatMessage {
  readonly role: 'user' | 'assistant' | 'tool' | 'system';
  readonly content: string;
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly arguments: string }[];
  /** role=tool 时：上一轮 assistant toolCalls 的结果。 */
  readonly toolResults?: readonly { readonly id: string; readonly name: string; readonly content: string; readonly isError?: boolean }[];
  readonly system?: string;
}

export interface ChatResult {
  readonly content: string;
  readonly thinking?: string;
  readonly stopReason?: string;
  readonly toolCalls: readonly { readonly id: string; readonly name: string; readonly arguments: string }[];
}

export interface ChatLlmPort {
  readonly name: string;
  chat(req: ToolCallRequest): Promise<Result<ChatResult, Error>>;
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;
const defaultFetch: FetchImpl = (url, init) => fetch(url, init);

export interface ProviderOpts {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: FetchImpl;
}

const errorFrom = async (res: Response): Promise<Error> => {
  const body = await res.text().catch(() => '');
  return new Error(`llm http ${res.status}: ${body.slice(0, 300)}`);
};

// ---- Anthropic Messages 协议 ----------------------------------------------------

export const createAnthropicChat = (opts: ProviderOpts, doFetch: FetchImpl = defaultFetch): ChatLlmPort => ({
  name: 'anthropic',
  async chat(req) {
    const url = opts.baseUrl && opts.baseUrl !== ''
      ? `${opts.baseUrl.replace(/\/$/, '')}/v1/messages` : 'https://api.anthropic.com/v1/messages';
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const body: Record<string, unknown> = {
      model: req.model ?? opts.model ?? '',
      max_tokens: req.maxTokens ?? 4096,
      messages: req.messages
        .filter((m) => m.role !== 'system')
        .map((m) => {
          if (m.role === 'assistant') {
            const content: Record<string, unknown>[] = [];
            if (m.content !== '') content.push({ type: 'text', text: m.content });
            for (const tc of m.toolCalls ?? []) {
              content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: safeJson(tc.arguments) });
            }
            return { role: 'assistant', content };
          }
          if (m.role === 'tool') {
            return {
              role: 'user',
              content: (m.toolResults ?? []).map((tr) => ({
                type: 'tool_result', tool_use_id: tr.id,
                content: tr.content, is_error: tr.isError ?? false,
              })),
            };
          }
          return { role: 'user', content: m.content };
        }),
    };
    if (system !== '') body['system'] = system;
    if (req.tools && req.tools.length > 0) {
      body['tools'] = req.tools.map((t) => ({
        name: t.name, description: t.description, input_schema: t.parameters,
      }));
    }
    const res = await toResult(doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: req.signal ?? null,
    }), 'anthropic chat failed');
    if (!res.ok) return res;
    if (res.value.status !== 200) return err(await errorFrom(res.value));
    const dataRes = await toResult(res.value.json() as Promise<Record<string, unknown>>, 'anthropic chat json');
    if (!dataRes.ok) return dataRes;
    const data = dataRes.value;
    const content = Array.isArray(data['content']) ? data['content'] : [];
    let text = '';
    let thinking = '';
    const toolCalls: { id: string; name: string; arguments: string }[] = [];
    for (const block of content) {
      const b = block as { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') text += b.text;
      else if (b.type === 'thinking' && typeof b.thinking === 'string') thinking += b.thinking;
      else if (b.type === 'tool_use' && typeof b.name === 'string') {
        toolCalls.push({ id: b.id ?? '', name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      }
    }
    return ok({ content: text, thinking, toolCalls, stopReason: String(data['stop_reason'] ?? '') });
  },
});

// ---- OpenAI Chat Completions 协议（BigModel/GLM 兼容）---------------------------

export const createOpenAiChat = (opts: ProviderOpts, doFetch: FetchImpl = defaultFetch): ChatLlmPort => ({
  name: 'openai',
  async chat(req) {
    const url = opts.baseUrl && opts.baseUrl !== ''
      ? `${opts.baseUrl.replace(/\/$/, '')}/chat/completions` : 'https://api.openai.com/v1/chat/completions';
    const messages: Record<string, unknown>[] = [];
    for (const m of req.messages) {
      if (m.role === 'system') messages.push({ role: 'system', content: m.content });
      else if (m.role === 'assistant') {
        messages.push({
          role: 'assistant', content: m.content,
          ...(m.toolCalls && m.toolCalls.length > 0
            ? { tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id, type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })) } : {}),
        });
      } else if (m.role === 'tool') {
        for (const tr of m.toolResults ?? []) {
          messages.push({ role: 'tool', tool_call_id: tr.id, content: tr.content });
        }
      } else messages.push({ role: 'user', content: m.content });
    }
    const body: Record<string, unknown> = {
      model: req.model ?? opts.model ?? '',
      max_tokens: req.maxTokens ?? 4096,
      messages,
    };
    if (req.tools && req.tools.length > 0) {
      body['tools'] = req.tools.map((t) => ({
        type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    const res = await toResult(doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(body),
      signal: req.signal ?? null,
    }), 'openai chat failed');
    if (!res.ok) return res;
    if (res.value.status !== 200) return err(await errorFrom(res.value));
    const dataRes = await toResult(res.value.json() as Promise<Record<string, unknown>>, 'openai chat json');
    if (!dataRes.ok) return dataRes;
    const choice = (dataRes.value['choices'] as { message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[] | undefined)?.[0];
    const msg = choice?.message;
    return ok({
      content: msg?.content ?? '',
      toolCalls: (msg?.tool_calls ?? []).map((tc, i) => ({
        id: tc.id ?? `call_${i}`, name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '{}',
      })),
      stopReason: choice?.finish_reason ?? '',
    });
  },
});

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};
