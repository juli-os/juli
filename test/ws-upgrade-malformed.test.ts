// 畸形 upgrade 请求目标不崩进程回归（R1 P0#1）：llhttp 放行 `//[`、`/\` 这
// 类请求目标，wirehubs/ptyhub 监听内的裸 new URL() 对其同步抛 TypeError——
// 异常从 upgrade 监听直穿 uncaughtException，单条免认证畸形请求即打死整个
// 服务（Reviewer PoC /tmp/r1-upgrade-poc.mjs 实证 exit 1、2s 探针不打印）。
// 修复后畸形 socket 必须被销毁、服务存活（随后正常 WS 仍能建连）。

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { connect } from 'node:net';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { attachChatWireWs, attachSnapshotWireWs, attachUpgradeFallback } from '../src/platform/ws/wirehubs.ts';
import { attachPtyHub } from '../src/platform/ws/ptyhub.ts';
import { createChatHub } from '../src/platform/ws/chathub.ts';
import { createTmuxClient } from '@juli-os/agents';

/** 原生 socket 发畸形 upgrade 请求，断言连接被服务端关闭（3s 不关即败）。
 * data 监听必须有：无监听时 socket 停在 paused 态，服务端优雅 end（FIN）永不
 * 被处理、close 事件不触发（destroy/RST 路径不受影响）——纯测试基建口径。 */
const sendRaw = (port: number, target: string, extraHeaders = ''): Promise<'closed'> =>
  new Promise((resolve, reject) => {
    const c = connect(port, '127.0.0.1', () => {
      c.on('data', () => undefined);
      c.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade${extraHeaders}\r\n\r\n`);
    });
    const done = (): void => { c.destroy(); resolve('closed'); };
    c.on('close', done);
    c.on('error', done); // destroy 可表现为 ECONNRESET——close/error 都算「被关闭」
    setTimeout(() => reject(new Error(`畸形请求 ${target} 3s 未被服务端关闭`)), 3000);
  });

describe('畸形 upgrade 请求目标不崩进程（R1 P0#1 回归锚）', () => {
  const server: Server = createServer();
  // 四监听全挂（镜像 index.ts：两 wirehub + ptyhub + 兜底）——EventEmitter
  // 把同一 upgrade 派给所有监听器，任一处裸抛即崩，必须同场覆盖。
  beforeAll(async () => {
    const tmux = createTmuxClient({ socketPath: '/tmp/juli-upgrade-test-unused.sock' });
    attachChatWireWs({ server, chatHub: createChatHub(), password: '', log: () => undefined });
    attachSnapshotWireWs({ server, tmux, password: '', log: () => undefined });
    attachPtyHub({ server, tmux, password: '', log: () => undefined });
    attachUpgradeFallback(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterAll(() => {
    server.close();
  });

  // b44 P0 补刀：畸形 percent-encoding——new URL 解析成功（原样保留 % 序列）、
  // 紧随其后的 decodeURIComponent 同步抛 URIError。xterm 提取在 auth 之前（免
  // 认证即可达，裸请求即可）；snapshot 提取在 auth 之后——须带齐 Sec-WebSocket-
  // Key/Version 让 handleUpgrade 走到 handle 回调才触达缺口（无 key 的请求死在
  // ws 库的 400 abort，到不了业务代码），故两组请求形状不同。
  const WS_HANDSHAKE = '\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13';
  it.each([
    ['//[', ''],
    ['/\\', ''],
    ['/ws/xterm/%E0%A4%A', ''],
    ['/ws/xterm/%ZZ', ''],
    ['/ws/snapshot/%E0%A4%A', WS_HANDSHAKE],
    ['/ws/snapshot/%ZZ', WS_HANDSHAKE],
  ] as const)('GET %s + Upgrade 头：畸形 socket 被销毁、进程存活', async (target, extra) => {
    const port = (server.address() as { port: number }).port;
    expect(await sendRaw(port, target, extra)).toBe('closed');
    // 存活探针：畸形请求之后，正常 WS 仍能建连（进程没被打死）。
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat`);
    const opened = await Promise.race([
      new Promise<string>((r) => ws.on('open', () => r('open'))),
      new Promise<string>((r) => setTimeout(() => r('timeout'), 3000)),
    ]);
    ws.close();
    expect(opened, `畸形请求 ${target} 后服务不再接受正常 WS 建连`).toBe('open');
  });

  // b44 R2 NEW-α：/ws/chat 前缀误认领回归。/ws/chatter URL 合法（非畸形请求），
  // 但 startsWith('/ws/chat') 会把它认领进 chat hub——本服务器 password='' 直
  // 接过 token 校验、带握手头即 WS 建连成功挂连（3s 不关即败=未修必红；无握手
  // 头时 ws 库 400 abort 也关连接、钉不住未修态，故必须带 WS_HANDSHAKE）。
  // 修复后精确匹配不认领 → 兜底监听销毁 socket，随后正常 /ws/chat 照常建连。
  it('GET /ws/chatter：chat hub 不认领（精确匹配），兜底销毁、服务存活', async () => {
    const port = (server.address() as { port: number }).port;
    expect(await sendRaw(port, '/ws/chatter', WS_HANDSHAKE)).toBe('closed');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat`);
    const opened = await Promise.race([
      new Promise<string>((r) => ws.on('open', () => r('open'))),
      new Promise<string>((r) => setTimeout(() => r('timeout'), 3000)),
    ]);
    ws.close();
    expect(opened, '/ws/chatter 处理后正常 /ws/chat 不再能建连').toBe('open');
  });
});
