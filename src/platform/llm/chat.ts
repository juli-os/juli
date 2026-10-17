// 对话式 LLM 供应商适配器。端口类型（ToolSchema/ChatMessage/ChatLlmPort 等）
// 的事实源已收编 npm 包 @juli-os/agents（10-10 影子清除）——本文件只留
// Anthropic/OpenAI 两个协议实现（引擎装配面）。

import { err, ok, toResult } from '@juli-os/artifacts';
import type { ChatLlmPort } from '@juli-os/agents';


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
    // 三步收口照 providers.ts parseJsonResponse 先例：unknown → 非 null object 检查 → 才 cast
    const dataRes = await toResult(res.value.json() as Promise<unknown>, 'anthropic chat json');
    if (!dataRes.ok) return dataRes;
    if (typeof dataRes.value !== 'object' || dataRes.value === null) {
      return err(new Error('anthropic chat: non-object response'));
    }
    const data = dataRes.value as Record<string, unknown>;
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
    // 三步收口照 providers.ts parseJsonResponse 先例：unknown → 非 null object 检查 → 才 cast
    const dataRes = await toResult(res.value.json() as Promise<unknown>, 'openai chat json');
    if (!dataRes.ok) return dataRes;
    if (typeof dataRes.value !== 'object' || dataRes.value === null) {
      return err(new Error('openai chat: non-object response'));
    }
    const data = dataRes.value as Record<string, unknown>;
    const choice = (data['choices'] as { message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[] | undefined)?.[0];
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
