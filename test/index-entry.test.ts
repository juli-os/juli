// 真入口 src/index.ts 的子进程级校验：退出码契约与「先取锁、后装配」都只接线在
// index.ts。server-launch.test.ts 注入 exit/onFatal，只能验证函数本身，验证不到
// 入口实际传进去的退出码；这里用 tsx 拉起真实入口来看。
// 隔离：HOME / JULI_DATA_DIR / TMUX_TMPDIR 全指临时目录，不碰真实
// ~/.juli-service；PATH 首位放一个假 tmux（只记调用、exit 1）。只把 tmux 所在
// 目录移出 PATH 挡不住真 tmux——@juli-os/agents 在 PATH 里找不到 tmux 时会退到
// /opt/homebrew/bin/tmux、/usr/local/bin/tmux；假 tmux 放在 PATH 首位就一定先
// 被选中，还能顺带断言「一次都没调」。

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 与实现同口径取进程启动时刻（linux /proc starttime；其余走 ps lstart，钉
 * C locale + UTC）——持锁方的锁内容按它写，子进程里的入口才会判「存活且验身
 * 一致」而拒启。 */
const startedAtOf = (pid: number): string => {
  if (process.platform !== 'darwin') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      if (ticks !== undefined && ticks !== '') return ticks;
    } catch { /* 落到 ps */ }
  }
  return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
  }).trim();
};

interface Sandbox {
  readonly dataDir: string;
  readonly tmuxLog: string;
  readonly env: NodeJS.ProcessEnv;
}

const sandboxDirs: string[] = [];
const cleanups: (() => void)[] = [];

const makeSandbox = (): Sandbox => {
  const dir = mkdtempSync(join(tmpdir(), 'juli-entry-'));
  sandboxDirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const tmuxLog = join(dir, 'fake-tmux.log');
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\necho "$@" >> '${tmuxLog}'\nexit 1\n`);
  chmodSync(join(bin, 'tmux'), 0o755);
  const dataDir = join(dir, 'data');
  return {
    dataDir,
    tmuxLog,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, JULI_DATA_DIR: dataDir, TMUX_TMPDIR: dir, LANG: 'C.UTF-8' },
  };
};

const runEntry = (env: NodeJS.ProcessEnv): { status: number | null; signal: NodeJS.Signals | null; out: string; err: string } => {
  const r = spawnSync(process.execPath, [join(root, 'node_modules', '.bin', 'tsx'), join(root, 'src', 'index.ts')], {
    cwd: root, env, encoding: 'utf8', timeout: 30_000,
  });
  return { status: r.status, signal: r.signal, out: r.stdout ?? '', err: r.stderr ?? '' };
};

afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  for (const d of sandboxDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('真入口 src/index.ts（子进程）', () => {
  it('拒启：data_dir 锁被存活实例持有 → exit 0、日志带持有方 pid、锁字节不变、未装配 runtime、未碰 tmux', () => {
    const sb = makeSandbox();
    mkdirSync(sb.dataDir);
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
    cleanups.push(() => { holder.kill(); });
    const pid = holder.pid ?? 0;
    const lock = JSON.stringify({ pid, startedAt: startedAtOf(pid), bootId: '' });
    writeFileSync(join(sb.dataDir, 'instance.lock'), lock);
    const r = runEntry(sb.env);
    expect(r.signal).toBeNull();
    expect(r.status).toBe(0);
    expect(r.err).toContain(`持有方 pid=${pid}`);
    expect(readFileSync(join(sb.dataDir, 'instance.lock'), 'utf8')).toBe(lock);
    // 取锁先于 createRuntime：拒启后 data_dir 里没有任何账本文件。
    expect(readdirSync(sb.dataDir)).toEqual(['instance.lock']);
    expect(existsSync(sb.tmuxLog)).toBe(false);
  }, 60_000);

  it('listen 失败：端口已被占 → exit 1、日志「副作用尚未启动」、rt.start 未跑、未碰 tmux、锁随进程退出释放', async () => {
    const sb = makeSandbox();
    const blocker = createServer();
    await new Promise<void>((resolve) => { blocker.listen(0, '127.0.0.1', () => resolve()); });
    cleanups.push(() => { blocker.close(); });
    const port = (blocker.address() as { port: number }).port;
    const r = runEntry({ ...sb.env, JULI_LISTEN_HOST: '127.0.0.1', JULI_LISTEN_PORT: String(port) });
    expect(r.signal).toBeNull();
    expect(r.status).toBe(1);
    expect(r.err).toContain('server 监听失败');
    expect(r.err).toContain('副作用尚未启动');
    // rt.start 没跑：没有「已启动」，也没有 CC hooks 注入日志。
    expect(r.out + r.err).not.toContain('已启动');
    expect(r.out + r.err).not.toContain('CC hooks');
    expect(existsSync(sb.tmuxLog)).toBe(false);
    // 取锁成功过（日志为证）；进程退出时 exit 钩子把锁删掉，监管者重拉能直接取锁。
    expect(r.out).toContain('实例锁已获取');
    expect(existsSync(join(sb.dataDir, 'instance.lock'))).toBe(false);
  }, 60_000);
});
