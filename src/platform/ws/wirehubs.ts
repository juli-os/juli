// iOS 兼容 WS 集（对应 Go cmd/gui handlers_ws.go）：
//   /ws/chat          —— 聊天事件流（服务端→客户端单向 + 30s ping；不回放历史）
//   /ws/snapshot/{n}  —— 终端快照流（capture-pane 周期推送，FNV 去重）
// 帧形状与 Go 逐字对齐：chat 帧 {type,data}（data 恒字符串）；snapshot 帧
// {type:'snapshot',content,ts 毫秒}；capture 失败 {type:'error',message} 即断。
// 内部事件名 → 线上名的映射：chat:X → X；编排器 text → assistant。

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { safeEqual } from '../shared/secure.ts';
import { sanitizeConv } from '../shared/conv.ts';
import { closeReason } from './ptyhub.ts';
import type { ChatHub } from './chathub.ts';
import type { TmuxClient } from '@juli-os/agents';

/** 事件对象 → wire 帧（唯一映射事实源）：语音/路由侧的 chat:X 带字符串
 * data；编排器原始事件带 content/tool/args。未知类型透传。 */
export const toWireFrame = (e: Record<string, unknown>): { readonly type: string; readonly data: string } | null => {
  const type = typeof e['type'] === 'string' ? e['type'] : '';
  if (type === '') return null;
  const data = typeof e['data'] === 'string' ? e['data'] : '';
  if (type.startsWith('chat:')) return toWireEvent(type, data);
  switch (type) {
    case 'text':
    case 'thinking':
      return toWireEvent(type, typeof e['content'] === 'string' ? e['content'] : '');
    case 'tool_call': return { type: 'tool_call', data: JSON.stringify({ tool: e['tool'] ?? '', args: e['args'] ?? {} }) };
    case 'tool_result': return { type: 'tool_result', data: JSON.stringify({ tool: e['tool'] ?? '', result: e['content'] ?? '' }) };
    case 'done': return { type: 'done', data: '' };
    default: return { type, data };
  }
};

/** 内部事件名 → iOS 线上名（Go chat_service.go:221-251 的映射语义）。 */
export const toWireEvent = (type: string, data: string): { readonly type: string; readonly data: string } => {
  if (type.startsWith('chat:')) return { type: type.slice('chat:'.length), data };
  switch (type) {
    case 'text': return { type: 'assistant', data };
    case 'thinking': return { type: 'thinking', data };
    default: return { type, data };
  }
};

const acceptWithToken = (
  req: IncomingMessage, socket: Duplex, head: Buffer, prefix: string, password: string,
  exact: boolean, wss: WebSocketServer, handle: (ws: WebSocket, url: URL) => void,
): void => {
  // llhttp 接受 `//[`、`/\` 这类请求目标，new URL 对其同步抛 TypeError——
  // 不拦则异常从 upgrade 监听直穿 uncaughtException，单条免认证畸形请求即
  // 打死进程（R1 P0#1）。畸形 URL 一律销毁 socket 且不标记 __juliWs：兜底
  // 监听按未认领再 destroy 一次，双 destroy 幂等无害。
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }
  // b44 R2 NEW-α：chat 前缀精确匹配——startsWith 会把 /ws/chatter 等任意
  // /ws/chat* 路径认领进 chat hub 挂连（现役客户端只连精确路径，实害零，
  // hygiene）。snapshot 前缀带尾斜杠、session 取自其后缀，必须前缀匹配——
  // `=== prefix || startsWith(prefix + '/')` 对带尾斜杠前缀反而漏配
  // /ws/snapshot/x，故 exact 由调用方按前缀形状声明，不用统一公式。
  const hit = exact ? url.pathname === prefix : url.pathname.startsWith(prefix);
  if (!hit) return; // 交给其它 upgrade 处理方
  // 标记本 socket 已被 hub 认领——index.ts 的兜底监听据此放过/销毁
  //（标记必须在 prefix 判定通过之后、auth 之前，保证 401 路径也不会被兜底误伤重写）。
  (socket as unknown as { __juliWs?: boolean }).__juliWs = true;
  socket.on('error', () => undefined);
  const token = url.searchParams.get('token') ?? '';
  if (password !== '' && !safeEqual(token, password)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => handle(ws, url));
};

/** upgrade 兜底：未被任何 hub 认领（__juliWs 未标记）的 upgrade 一律销毁 socket，
 * 防止连接悬挂泄漏。必须在所有 hub 的 upgrade 监听注册之后调用（index.ts 在
 * rt.attachWs 之后挂）——EventEmitter 按注册顺序派发。 */
export const attachUpgradeFallback = (server: Server): void => {
  server.on('upgrade', (_req: IncomingMessage, socket: Duplex) => {
    if (!(socket as unknown as { __juliWs?: boolean }).__juliWs) socket.destroy();
  });
};

export const attachChatWireWs = (deps: {
  readonly server: Server;
  readonly chatHub: ChatHub;
  readonly password: string;
  /** conv → 租户登记（2026-11-08 提案 A2）：租户订阅按本表逐帧过滤——one
   * 只见同租户 conv，未登记 conv 只进 all。逐帧求值让「先订阅后开线程」
   * 的时序成立；解析与登记表在 runtime（本文件不 import business 层）。
   * 缺省不接 = 全视角（旧行为零变化）。 */
  readonly convTenantOf?: (conv: string) => string | null;
  /** X-Juli-Tenant 解析（header 或同名 query）：one=按租户收口、all=全视角、
   * null=非法值（拒连，HTTP 面 400 的等价）。 */
  readonly resolveScope?: (raw: string | undefined) =>
    { readonly kind: 'one'; readonly tenant: string } | { readonly kind: 'all' } | null;
  readonly log?: (m: string) => void;
}): void => {
  const wss = new WebSocketServer({ noServer: true });
  deps.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    acceptWithToken(req, socket, head, '/ws/chat', deps.password, true, wss, (ws, url) => {
      // conv 分线程（2026-10-17）：客户端带 ?conv= 只收该线程帧；不带=旧
      // 客户端，只收 main（旧单线程语义）——并行使用/诊断注入不再串台。
      // 清洗与 HTTP 侧同口径（sanitizeConv，R1-F2）：空串/非法 id 一律归
      // main，不会订阅永不存在的线程静默零帧。
      const conv = sanitizeConv(url.searchParams.get('conv'));
      // 租户订阅（A2）：解析失败（未声明的租户 id）= HTTP 面 400 的等价——
      // 销毁 socket 不降级。解析体在 runtime，本文件零租户知识。
      const scope = deps.resolveScope !== undefined
        ? deps.resolveScope((Array.isArray(req.headers['x-juli-tenant'])
          ? req.headers['x-juli-tenant'][0]
          : req.headers['x-juli-tenant']) ?? url.searchParams.get('X-Juli-Tenant') ?? undefined)
        : { kind: 'all' as const };
      if (scope === null) {
        socket.destroy();
        return;
      }
      const send = (frame: { type: string; data: string }): void => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
      };
      const unsub = deps.chatHub.subscribe((e) => {
        if (e.conv !== conv) return;
        if (scope.kind === 'one' && (deps.convTenantOf?.(e.conv) ?? null) !== scope.tenant) return;
        const w = toWireEvent(e.type, e.data);
        send(w);
      });
      const ping = setInterval(() => send({ type: 'ping', data: '' }), 30_000);
      deps.log?.(`[ws] chat wire attach (conv=${conv})`);
      ws.on('close', () => {
        clearInterval(ping);
        unsub();
        deps.log?.(`[ws] chat wire detach (conv=${conv})`);
      });
    });
  });
};

export const attachSnapshotWireWs = (deps: {
  readonly server: Server;
  readonly tmux: TmuxClient;
  readonly password: string;
  /** 租户握手（2026-11-08 提案 A2，与 ptyhub 同款）：resolve 解析
   * X-Juli-Tenant（header 或同名 query）——返回 one=按租户收口（会话不属
   * 该租户 1008 拒）、all=全视角、null=非法值（拒连）。解析本体在 runtime
   * 装配侧注入。缺省不接 = 全视角（旧行为零变化）。 */
  readonly tenants?: {
    readonly resolve: (headerValue: string | undefined) =>
      { readonly kind: 'one'; readonly tenant: string } | { readonly kind: 'all' } | null;
    readonly tenantOfSession: (session: string) => string | undefined;
  };
  readonly log?: (m: string) => void;
}): void => {
  const wss = new WebSocketServer({ noServer: true });
  deps.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    acceptWithToken(req, socket, head, '/ws/snapshot/', deps.password, false, wss, (ws, url) => {
      // session 提取的 decodeURIComponent 同型杀进程缺口（b44 P0）：带正确
      // 密码的畸形 percent-encoding 路径（/ws/snapshot/%E0%A4%A）在此同步抛
      // URIError 直穿 uncaughtException。已过 handleUpgrade（ws 为 OPEN）——
      // terminate 即毁（握手未完成的畸形会话不走 close 握手等待，与
      // acceptWithToken 401 路径的 socket.destroy 同「立即拒」语义）。
      let session: string;
      try {
        session = decodeURIComponent(url.pathname.slice('/ws/snapshot/'.length));
      } catch {
        ws.terminate();
        return;
      }
      // 租户握手（A2，与 ptyhub 同款）：本 hub 的租户闸在 handleUpgrade 之后
      //（acceptWithToken 内），非法租户与越租户都以 close 1008 拒（HTTP 面
      // 400 的 WS 等价——upgrade 已完成，不能再写裸 400 响应行）。
      if (deps.tenants !== undefined) {
        const raw = req.headers['x-juli-tenant'];
        const scope = deps.tenants.resolve((Array.isArray(raw) ? raw[0] : raw)
          ?? url.searchParams.get('X-Juli-Tenant') ?? undefined);
        if (scope === null) {
          ws.close(1008, 'unknown tenant');
          return;
        }
        if (scope.kind === 'one' && deps.tenants.tenantOfSession(session) !== scope.tenant) {
          ws.close(1008, closeReason(`cross-tenant session（会话 ${session} 不属于租户 ${scope.tenant}）`));
          return;
        }
      }
      const historyLines = Math.max(0, Math.trunc(Number(url.searchParams.get('history') ?? '0')) || 0);
      const intervalMs = Math.max(30, Math.min(5000, Math.trunc(Number(url.searchParams.get('interval') ?? '100')) || 100));
      if (session.trim() === '') {
        ws.close(1008, 'session required');
        return;
      }
      let lastHash = 0;
      let inFlight = false; // 重叠闸：上一轮 capture 在途时跳过本轮 tick
      // FNV-1a 32 位足够做"未变化不重发"的内容指纹（Go 版 FNV64 同语义）。
      const fnv = (s: string): number => {
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 0x01000193);
        }
        return h >>> 0;
      };
      const tick = async (): Promise<void> => {
        if (inFlight) return;
        inFlight = true;
        try {
          const res = await deps.tmux.capturePane(session, historyLines > 0 ? historyLines : undefined);
          if (ws.readyState !== ws.OPEN) return;
          if (!res.ok) {
            ws.send(JSON.stringify({ type: 'error', message: res.error.message.slice(0, 200) }));
            ws.close(1011, 'capture failed');
            return;
          }
          const content = res.value;
          const h = fnv(content);
          if (h === lastHash) return; // 未变化不重发
          lastHash = h;
          ws.send(JSON.stringify({ type: 'snapshot', content, ts: Date.now() }));
        } finally {
          inFlight = false;
        }
      };
      deps.log?.(`[ws] snapshot attach ${session} (interval=${intervalMs}ms)`);
      void tick(); // 首帧立即推
      const timer = setInterval(() => void tick(), intervalMs);
      ws.on('close', () => {
        clearInterval(timer);
        deps.log?.(`[ws] snapshot detach ${session}`);
      });
    });
  });
};
