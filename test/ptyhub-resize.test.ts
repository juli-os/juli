// ptyhub resize 交换不自毁回归（2026-09-29 xterm「打开即死」根因锚）：
// 客户端首帧 size（cols≠默认 120）会 kill 旧 PTY 重建——旧 PTY 的 exit
// 回调必须验身份（pty === me），否则任何 cols 变化都把整条 WS 连接带走
// （实测形态：首屏 396 字节后 close 1000 'pty exited'，交互终端全灭）。
// 真 tmux 端到端（本机跑、CI 跳过，与 tmux-live.test.ts 同模式）。

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import WebSocket from 'ws';
import { attachPtyHub } from '../src/platform/ws/ptyhub.ts';
import { createTmuxClient } from '../src/platform/agents/tmux.ts';
import { ptyAvailable } from '../src/platform/agents/pty.ts';

// 守卫必须双查：CI（ubuntu runner）预装 tmux 但没有 /usr/bin/expect——pty
// 桥是 expect 脚本，缺它 createPty spawn 即错、pty 秒退 → 全测试挂
// 「pty exited」（2026-09-29 main CI 实证红）。只查 tmux 防不住。
const canRunPtyE2E = (() => {
  if (!ptyAvailable()) return false;
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

// 隔离 socket（2026-10-09 幽灵会话事故锚）：裸 tmux 命令落宿主 default
// socket——此前全量跑在用户默认 socket 真建会话/孵化 server 并留残留
// （agent-a/normal-session 幽灵来源之一）。本套件所有 tmux 调用走专属
// 临时 socket，afterAll kill-server+清文件——宿主两个 socket 零污染。
// 纯路径计算不建目录：CI 跳过路径上无任何文件系统副作用。
const e2eSock = join(tmpdir(), `juli-pty-e2e-${process.pid}-${Date.now()}.sock`);

describe.skipIf(!canRunPtyE2E)('ptyhub resize 交换不自毁', () => {
  const tmux = createTmuxClient({ socketPath: e2eSock });
  const session = `juli-ptyhub-test-${Date.now()}`;
  const server: Server = createServer();
  const logs: string[] = [];
  attachPtyHub({ server, tmux, password: 'pw', log: (m) => logs.push(m) });

  it('size 帧抢跑（onopen 立发，双建竞态回归）：连接不断、无双建孤儿', async () => {
    try { execFileSync('tmux', ['-S', e2eSock, 'kill-session', '-t', session], { stdio: 'ignore' }); } catch { /* 不在 */ }
    execFileSync('tmux', ['-S', e2eSock, 'new-session', '-d', '-s', session, '-x', '120', '-y', '32', 'sh'], { stdio: 'ignore' });

    const port = (server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/xterm/${session}?token=pw`);
    const closed: { code: number; reason: string }[] = [];
    let got = '';
    ws.on('message', (m) => { got += typeof m === 'string' ? m : Buffer.from(m as ArrayBuffer).toString('utf8'); });
    ws.on('close', (code, reason) => closed.push({ code, reason: reason.toString() }));

    // 打开即发 size（不等首建完成——首建 hasSession 在途，正是双建竞态窗）。
    await new Promise<void>((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'size', cols: 100, rows: 30 }));
    await new Promise((r) => setTimeout(r, 1200));
    ws.send('echo RACE_OK\n');
    await new Promise((r) => setTimeout(r, 1800));

    expect(closed, `连接被关闭：${JSON.stringify(closed)}`).toEqual([]);
    expect(got).toContain('RACE_OK');
    // 双建孤儿锁：全程只有一次有效 attach 尺寸链（120 初始 + 100 重建），
    // 会话结束时挂靠客户端必须清零。
    ws.close();
    await new Promise((r) => setTimeout(r, 800));
    let clients = '';
    try { clients = execFileSync('tmux', ['-S', e2eSock, 'list-clients', '-t', session], { encoding: 'utf8' }); } catch { clients = ''; }
    expect(clients, '孤儿 attach 残留（双建竞态）').toBe('');
  }, 12000);

  beforeAll(async () => { await new Promise<void>((r) => server.listen(0, () => r())); });
  afterAll(() => {
    try { execFileSync('tmux', ['-S', e2eSock, 'kill-session', '-t', session], { stdio: 'ignore', env: { ...process.env } }); } catch { /* 已不在 */ }
    try { execFileSync('tmux', ['-S', e2eSock, 'kill-server'], { stdio: 'ignore', env: { ...process.env } }); } catch { /* 已不在 */ }
    try { rmSync(e2eSock); } catch { /* socket 文件非 server 退出残留时忽略 */ }
    server.close();
  });

  it('首帧 size（cols≠默认）不杀连接：重建后连接仍在、双向仍通', async () => {
    logs.length = 0; // describe 级共享：按测试清零，只数本测试的 attach
    try { execFileSync('tmux', ['-S', e2eSock, 'kill-session', '-t', session], { stdio: 'ignore' }); } catch { /* 不在 */ }
    execFileSync('tmux', ['-S', e2eSock, 'new-session', '-d', '-s', session, '-x', '120', '-y', '32', 'sh'], { stdio: 'ignore' });

    const port = (server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/xterm/${session}?token=pw`);

    const closed: { code: number; reason: string }[] = [];
    let got = '';
    ws.on('message', (m) => { got += typeof m === 'string' ? m : Buffer.from(m as ArrayBuffer).toString('utf8'); });
    ws.on('close', (code, reason) => closed.push({ code, reason: reason.toString() }));

    await new Promise<void>((r) => ws.once('open', r));
    // 首屏后立即发 size（xterm 打开的真实行为）：cols 80 ≠ 默认 120 → 触发重建。
    await new Promise((r) => setTimeout(r, 400));
    ws.send(JSON.stringify({ type: 'size', cols: 80, rows: 24 }));
    // 重建完成后键入一行命令，回环验证双向仍在（pane 执行并回显）。
    await new Promise((r) => setTimeout(r, 1000));
    ws.send('echo INTEROP_OK\n');
    await new Promise((r) => setTimeout(r, 2000));

    // 旧 bug 形态：size 帧 → close 1000 'pty exited'（或 0216446 的 attach
    // not found 秒退）。修复后 3.4s 观察窗内不得关闭。
    expect(closed, `连接被关闭：${JSON.stringify(closed)}`).toEqual([]);
    expect(logs.filter((l) => l.includes('attach'))).toHaveLength(2); // 120x32 → 80x24 两次 attach
    expect(got).toContain('INTEROP_OK'); // 键入上行→pane 执行→回显下行，双向活着
    ws.close();
    // 进程收口锁（2026-09-29 双建孤儿根因）：连接关闭后，本会话的 attach
    // 进程必须全数退出——首建在途时 size 帧曾引发双建，先建者成孤儿
    // （120x32 残留 attach）。给 kill/SIGKILL 一点传播时间再点名清点。
    await new Promise((r) => setTimeout(r, 800));
    const alive = (() => {
      try { return execFileSync('pgrep', ['-f', `attach -t ${session}`], { encoding: 'utf8' }); } catch { return ''; }
    })();
    // pgrep 匹配的是 expect 内层 argv（'attach' '-t' 分列带引号），模式对不上
    // 进程列表时以 tmux 客户端数为准：本会话不得再挂任何 attach 客户端。
    let clients = '';
    try { clients = execFileSync('tmux', ['-S', e2eSock, 'list-clients', '-t', session], { encoding: 'utf8' }); } catch { clients = ''; }
    expect(clients, `孤儿 attach 残留：${alive}`).toBe('');
  }, 12000);
});
