// xterm PTY WebSocket 桥（对应 Go cmd/gui 的 /ws/xterm + creack/pty）：
// /ws/xterm/{session}?token= —— 原始字节双向（按键上行、pane 下行），
// 认证走 token 常量时间比较。每连接独占一个 PTY attach。

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { safeEqual } from '../shared/secure.ts';
import { attachTmuxPty, type PtySession } from '@juli-os/agents';
import type { TmuxClient } from '@juli-os/agents';

export interface PtyHubDeps {
  readonly server: Server;
  readonly tmux: TmuxClient;
  readonly password: string;
  /** 绑定会话名清单（config.email.bound_agents 的 session 列）。PTY 桥是
   * 全双工裸字节——比 send-keys 更彻底的注入且无账本；与 HTTP 旁道守卫
   * （app.ts /api/sessions/:name/send，同信任级）同判据：命中绑定会话一律
   * 1008 拒连。合法的「人要看会计终端」走只读快照 /ws/snapshot/{session}。 */
  readonly boundSessions?: readonly string[];
  readonly log?: (m: string) => void;
}

export const attachPtyHub = (deps: PtyHubDeps): void => {
  const wss = new WebSocketServer({ noServer: true });
  deps.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/ws/xterm/')) return; // 交给其它 upgrade 处理方
    // 标记已认领（index.ts 兜底销毁的依据，与 wirehubs.acceptWithToken 同语义）。
    (socket as unknown as { __juliWs?: boolean }).__juliWs = true;
    socket.on('error', () => undefined);
    const session = decodeURIComponent(url.pathname.slice('/ws/xterm/'.length));
    const token = url.searchParams.get('token') ?? '';
    if (deps.password !== '' && !safeEqual(token, deps.password)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void serveSession(deps, ws, session);
    });
  });
};

/** ws close reason 硬上限 123 字节（RFC 6455 控制帧）：超限 ws.close 直接抛
 * RangeError（ws 8.21.3 实证），而本文件两处 reason 含中文 + 客户端可控的
 * 会话名——attach 失败消息带 19+ 字符会话名即越界（135 字节实测），抛点又都
 * 在 void 丢弃的 async 里，不拦就是未处理 rejection，Node 默认直接退出进程。
 * 只按字节回退截断：≤123 字节的原样透传，绝不改动现网不越界的原文。 */
const closeReason = (s: string): string => {
  let out = s;
  while (Buffer.byteLength(out) > 123) out = out.slice(0, -1);
  return out;
};

const serveSession = async (deps: PtyHubDeps, ws: WebSocket, session: string): Promise<void> => {
  const log = deps.log ?? (() => undefined);
  if (session.trim() === '') {
    ws.close(1008, 'session required');
    return;
  }
  // 心跳（2026-09-29 泄漏实证）：客户端进程暴死（浏览器被杀/断网）时不发
  // FIN——服务端 ws 'close' 永不触发，attach expect 变僵尸、tmux 客户端
  // 永久挂靠（实测三孤儿 ttys）。15s ping + 两轮无 pong 即 terminate，
  // terminate 触发 close → pty.kill 收尾。
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const hb = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    if (!alive) { ws.terminate(); return; }
    alive = false;
    ws.ping();
  }, 15_000);
  // 绑定会话守卫（2026-09-20 P1 旁道 B，与 /api/sessions/:name/send 同判据）：
  // 绑定会话（专用 agent 隔离）只开邮件口——全双工 PTY 是比裸 send-keys 更强
  // 的注入面，无闸门、无账本，一律拒（1008）。只读观察走 /ws/snapshot。
  if ((deps.boundSessions ?? []).includes(session)) {
    log(`[ws] xterm 拒连绑定会话 ${session}（专用 agent 隔离：PTY 桥不开放，只读观察走 /ws/snapshot）`);
    ws.close(1008, closeReason(`会话 ${session} 是绑定会话（专用 agent 隔离）——PTY 桥不开放，只读观察走 /ws/snapshot`));
    return;
  }
  let pty: PtySession | null = null;
  let cols = 120;
  let rows = 32;
  // 建连仲裁（2026-09-29 泄漏根因）：首建 create 在途（hasSession 要跑一次
  // tmux CLI，几十 ms），客户端 onopen 立刻发来的 size 帧就到了——处理器看
  // pty=null 再建一个 → 双建，先建者永不被 kill 成孤儿（实测 120x32 残留
  // attach）。seq 仲裁 + 建后复查：输家即杀、期间变尺寸立即跟上。
  let createSeq = 0;
  let creating = false;

  const create = async (): Promise<void> => {
    const seq = ++createSeq;
    creating = true;
    const usedCols = cols;
    const res = await attachTmuxPty(deps.tmux, session, { cols, rows }, (chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    });
    creating = false;
    if (seq !== createSeq) {
      // 等待期间有更新的 create 入场：这条作废——kill 掉，绝不留双 attach。
      if (res.ok) res.value.kill();
      return;
    }
    if (!res.ok) {
      ws.close(1011, closeReason(res.error.message.slice(0, 120)));
      return;
    }
    const me = res.value;
    pty = me;
    log(`[ws] xterm attach ${session} (${cols}x${rows})`);
    void me.exit.then(() => {
      // 只认「当前 PTY」退出才收连接：resize 交换会 kill 旧 PTY（pty=null
      // →建新），旧 PTY 的 exit 回调随后异步到达——若不验身份，任何一次
      // cols 变化都自毁连接（xterm 打开必发首帧 size ≠ 默认 120 列 →
      // attach 秒死，交互终端全灭——2026-09-29 e2e 实证 396 字节后 1000）。
      if (pty === me && ws.readyState === ws.OPEN) ws.close(1000, 'pty exited');
    });
    // 建连期间 cols 变了（size 帧只更新了变量）：立即按新尺寸重建。
    if (cols !== usedCols) {
      me.kill();
      pty = null;
      void create();
    }
  };

  ws.on('message', (data) => {
    const text = data.toString('utf8');
    // 控制帧：{"type":"size","cols":N,"rows":M}——cols 变化才重建 PTY。
    // rows-only（手机键盘弹起/收起、地址栏伸缩）绝不重建：每次重建丢弃渲染
    // 状态并重放全屏，是移动端"终端狂刷、输入卡死"的元凶。
    if (text.startsWith('{"type"')) {
      try {
        const v = JSON.parse(text) as { type?: string; cols?: number; rows?: number };
        const inCols = v.cols ?? 0;
        const inRows = v.rows ?? 0;
        if (v.type === 'size' && inCols > 20 && inRows > 10) {
          const nextCols = Math.min(400, Math.trunc(inCols));
          const nextRows = Math.min(200, Math.trunc(inRows));
          if (nextCols !== cols) {
            cols = nextCols;
            rows = nextRows;
            // 建连在途时只更新变量（create 完成后的复查会跟上新尺寸）；
            // 已建才走 kill+重建。
            if (!creating) {
              pty?.kill();
              pty = null;
              void create();
            }
          } else if (nextRows !== rows) {
            rows = nextRows; // 仅行数变化：记录，不重建
          }
          return;
        }
      } catch { /* 非 JSON，按键入处理 */ }
    }
    pty?.write(text);
  });
  ws.on('close', () => {
    clearInterval(hb);
    pty?.kill(); // 分离即 detach+杀掉 attach 进程（tmux 会话本身不受影响）
    log(`[ws] xterm detach ${session}`);
  });
  void create();
};
