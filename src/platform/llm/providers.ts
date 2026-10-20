// LLM 供应商抽象（对应 Go internal/ai/llm）。fetch 直连 REST，零 SDK 依赖；
// 注入 fetchImpl 即可全链 mock。两个实现：Anthropic Messages、
// OpenAI Chat Completions（兼容 BigModel/GLM 的 OpenAI 协议端点）。

import { err, ok, toResult, type Result } from '@juli-os/artifacts';
import type { CompletionRequest, CompletionResult, LlmPort } from '../../contracts/ports.ts';

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;
const defaultFetch: FetchImpl = (url, init) => fetch(url, init);

export interface ProviderOpts {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: FetchImpl;
  readonly timeoutMs?: number;
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export const createAnthropicProvider = (opts: ProviderOpts): LlmPort => {
  const doFetch = opts.fetchImpl ?? defaultFetch;
  const url = opts.baseUrl && opts.baseUrl !== '' ? `${opts.baseUrl.replace(/\/$/, '')}/v1/messages` : ANTHROPIC_URL;
  return {
    async complete(req: CompletionRequest): Promise<Result<CompletionResult, Error>> {
      const body = {
        model: req.model || opts.model || '',
        max_tokens: req.maxTokens,
        system: req.system || undefined,
        messages: [{ role: 'user', content: req.user }],
      };
      const res = await toResult(doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: req.signal ?? null,
      }), 'anthropic request failed');
      if (!res.ok) return res;
      return parseJsonResponse(res.value, 200, (data) => {
        const content = data['content'];
        if (!Array.isArray(content)) throw new Error('anthropic: no content array');
        const text = content
          .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null)
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('');
        if (text === '') throw new Error('anthropic: empty response');
        const u = (data['usage'] ?? {}) as Record<string, unknown>;
        return { text, inputTokens: Number(u['input_tokens'] ?? 0) || undefined, outputTokens: Number(u['output_tokens'] ?? 0) || undefined,
          // z.ai 计费口径（wf_66a9b632154d）：缓存命中 token——openai 兼容
          // prompt_tokens_details.cached_tokens；智谱原生 usage.cached_tokens。
          cachedTokens: Number((u['prompt_tokens_details'] as Record<string, unknown> | undefined)?.['cached_tokens']
            ?? u['cached_tokens'] ?? 0) || undefined };
      });
    },
  };
};

export const createOpenAiProvider = (opts: ProviderOpts): LlmPort => {
  const doFetch = opts.fetchImpl ?? defaultFetch;
  const url = opts.baseUrl && opts.baseUrl !== ''
    ? `${opts.baseUrl.replace(/\/$/, '')}/chat/completions`
    : OPENAI_URL;
  return {
    async complete(req: CompletionRequest): Promise<Result<CompletionResult, Error>> {
      const messages: { role: string; content: string }[] = [];
      if (req.system !== '') messages.push({ role: 'system', content: req.system });
      messages.push({ role: 'user', content: req.user });
      const res = await toResult(doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({ model: req.model || opts.model || '', max_tokens: req.maxTokens, messages }),
        signal: req.signal ?? null,
      }), 'openai request failed');
      if (!res.ok) return res;
      return parseJsonResponse(res.value, 200, (data) => {
        const choices = data['choices'];
        if (!Array.isArray(choices) || choices.length === 0) throw new Error('openai: no choices');
        const first = choices[0] as { message?: { content?: string } };
        const text = first?.message?.content ?? '';
        if (text === '') throw new Error('openai: empty response');
        const usage = (data['usage'] ?? {}) as Record<string, unknown>;
        return { text, inputTokens: Number(usage['prompt_tokens'] ?? 0) || undefined, outputTokens: Number(usage['completion_tokens'] ?? 0) || undefined };
      });
    },
  };
};

/** 共用收口：HTTP 状态检查 + JSON 解析 + 业务提取，错误消息带状态码
 * （引擎的 429 退避靠消息里的 "429" 判定）。 */
const parseJsonResponse = async <T>(
  res: Response,
  expectStatus: number,
  extract: (data: Record<string, unknown>) => T,
): Promise<Result<T, Error>> => {
  if (res.status !== expectStatus) {
    const body = await res.text().catch(() => '');
    return err(new Error(`llm http ${res.status}: ${body.slice(0, 300)}`));
  }
  const jsonRes = await toResult(res.json() as Promise<unknown>, 'llm json parse');
  if (!jsonRes.ok) return jsonRes;
  if (typeof jsonRes.value !== 'object' || jsonRes.value === null) {
    return err(new Error('llm: non-object response'));
  }
  try {
    return ok(extract(jsonRes.value as Record<string, unknown>));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
};
