// ptyhub：attach 在途时连接断开，落地后的 PTY 必须有人关（2026-11-11 R&F R1
// A-P2-1）。close 回调跑的时候 pty 还是 null；attach 落地后若不看连接还在不在，
// 这块 PTY（生产上是一个 `herdr agent attach --takeover` 进程）就没人关了。
// ready-attach 之后 attach 要先等 agent 拉起（最长四分钟），「点开终端等几秒
// 切走」每次漏一个。全假件：不触 tmux / herdr。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { ok, type Result } from '../src/platform/shared/result.ts';
import type { PtySession } from '@juli-os/agents';
import { attachPtyHub } from '../src/platform/ws/ptyhub.ts';
import { until } from './helpers.ts';

describe('ptyhub attach 在途时连接断开（A-P2-1）', () => {
  let server: Server;
  let port = 0;
  const logs: string[] = [];
  let attaches = 0;
  let kills = 0;
  let release: (r: Result<PtySession, Error>) => void = () => undefined;
  const fakePty = (): PtySession => ({
    write: () => undefined,
    kill: () => { kills += 1; },
    exit: new Promise<number>(() => undefined),
  });

  beforeAll(async () => {
    server = createServer();
    attachPtyHub({
      server, password: '',
      // attach 挂起，放行时机由用例控制——这段挂起就是生产里的预热等待窗。
      attach: () => {
        attaches += 1;
        return new Promise<Result<PtySession, Error>>((resolve) => { release = resolve; });
      },
      log: (m) => logs.push(m),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const open = async (session: string): Promise<WebSocket> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/xterm/${session}`);
    await new Promise<void>((r) => ws.once('open', () => r()));
    return ws;
  };
  const detached = (session: string): boolean => logs.includes(`[ws] xterm detach ${session}`);

  it('attach 落地前客户端已断开：落地的 PTY 立即被 kill，不留孤儿', async () => {
    attaches = 0; kills = 0; logs.length = 0;
    const ws = await open('p21-inflight');
    await until(() => attaches === 1); // 服务端 create() 已停在 attach 上
    ws.close();
    await until(() => detached('p21-inflight')); // 服务端 close 回调已跑完——此刻 pty 仍是 null
    expect(kills).toBe(0);
    release(ok(fakePty())); // attach 这才落地
    await until(() => kills === 1);
    // 没有把这块 PTY 当成在役终端登记（attach 日志只在登记后打）。
    expect(logs.some((l) => l.startsWith('[ws] xterm attach p21-inflight'))).toBe(false);
  });

  it('对照：attach 落地后才断开，走原有 close 回调，同样恰好 kill 一次', async () => {
    attaches = 0; kills = 0; logs.length = 0;
    const ws = await open('p21-settled');
    await until(() => attaches === 1);
    release(ok(fakePty()));
    await until(() => logs.some((l) => l.startsWith('[ws] xterm attach p21-settled')));
    expect(kills).toBe(0);
    ws.close();
    await until(() => kills === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(kills).toBe(1);
  });
});
