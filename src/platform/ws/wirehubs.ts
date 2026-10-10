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
    case 'text': return toWireEvent('text', typeof e['content'] === 'string' ? e['content'] : '');
    case 'thinking': return toWireEvent('thinking', typeof e['content'] === 'string' ? e['content'] : '');
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
  wss: WebSocketServer, handle: (ws: WebSocket, url: URL) => void,
): void => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith(prefix)) return; // 交给其它 upgrade 处理方
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
  readonly log?: (m: string) => void;
}): void => {
  const wss = new WebSocketServer({ noServer: true });
  deps.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    acceptWithToken(req, socket, head, '/ws/chat', deps.password, wss, (ws) => {
      const send = (frame: { type: string; data: string }): void => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
      };
      const unsub = deps.chatHub.subscribe((e) => {
        const w = toWireEvent(e.type, e.data);
        send(w);
      });
      const ping = setInterval(() => send({ type: 'ping', data: '' }), 30_000);
      deps.log?.('[ws] chat wire attach');
      ws.on('close', () => {
        clearInterval(ping);
        unsub();
        deps.log?.('[ws] chat wire detach');
      });
    });
  });
};

export const attachSnapshotWireWs = (deps: {
  readonly server: Server;
  readonly tmux: TmuxClient;
  readonly password: string;
  readonly log?: (m: string) => void;
}): void => {
  const wss = new WebSocketServer({ noServer: true });
  deps.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    acceptWithToken(req, socket, head, '/ws/snapshot/', deps.password, wss, (ws, url) => {
      const session = decodeURIComponent(url.pathname.slice('/ws/snapshot/'.length));
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
