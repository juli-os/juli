// fetch 客户端：Bearer token 来自 localStorage（header 首选，避免 ?token= 泄进日志）。

const TOKEN_KEY = 'juli_token';

export const getToken = (): string => localStorage.getItem(TOKEN_KEY) ?? '';

export const setToken = (t: string): void => {
  if (t === '') localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, t);
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const authHeaders = (): Record<string, string> => ({
  'content-type': 'application/json',
  ...(getToken() !== '' ? { authorization: `Bearer ${getToken()}` } : {}),
});

const handle = async <T>(res: Response): Promise<T> => {
  const data = (await res.json().catch(() => null)) as T | { error?: string } | null;
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error?: string }).error) : `http ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
};

const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(path, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handle<T>(res);
};

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  patch: <T>(p: string, b?: unknown) => request<T>('PATCH', p, b ?? {}),
  put: <T>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {}),
  del: <T>(p: string) => request<T>('DELETE', p),
  /** 工件内容取件（text）：闸门审核页渲染 deliverables 本体用。 */
  getText: async (p: string): Promise<string> => {
    const res = await fetch(p, { headers: authHeaders() });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(res.status, data?.['error'] ?? `http ${res.status}`);
    }
    return res.text();
  },
  /** multipart 上传（FormData 自带 content-type 边界，不得手工覆盖）。 */
  upload: async <T>(p: string, form: FormData): Promise<T> => {
    const res = await fetch(p, {
      method: 'POST',
      headers: getToken() !== '' ? { authorization: `Bearer ${getToken()}` } : {},
      body: form,
    });
    return handle<T>(res);
  },
};

/** <a href> 下载链接的鉴权面：token 走查询串（fetch 场景仍走 header）。 */
export const authQuery = (p: string): string =>
  getToken() === '' ? p : `${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(getToken())}`;

// ---- 领域类型（与后端 API 契约对齐，全部 readonly）---------------------------------

export interface Workflow {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly status: string;
  readonly session: string;
  readonly project: string;
  /** 对话（Thread）归组键；listWorkflows 的 JSON 实际携带（workflows2 端点
   * 同义键 thread_id），此处补声明——任务锚点（task-model.taskKeyOf）消费。 */
  readonly threadId?: string | null;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface Step {
  readonly id: string;
  readonly seq: number;
  readonly kind: string;
  readonly title: string;
  readonly status: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: Readonly<Record<string, unknown>>;
}

export interface LedgerEvent {
  readonly id: number;
  readonly entityType: string;
  readonly entityId: string;
  readonly type: string;
  readonly ts: string;
}

export interface TemplateInfo {
  readonly key: string;
  readonly name: string;
  readonly trigger: string;
  readonly hash: string;
  readonly file: string;
  readonly steps: readonly { readonly id: string; readonly kind: string; readonly title: string }[];
}
