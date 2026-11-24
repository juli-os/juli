// 跨 boot 验身分支真校验：judgeHolderState 的 bootId 维度——锁内
// bootId 与本机 boot 不符即判陈旧（pid/startedAt 即便全同也是上一个 boot 的
// 别人，Docker PID 1 / systemd 确定性 pid 断电重启的形态）。
// 独立成文件：selfBootId 是模块级缓存（进程内恒定），与 single-instance.test.ts
// 同模块实例时会被先行用例缓存成空串（macOS 无 /proc，该分支不可达）。vitest
// 每个测试文件独立模块实例——本文件经 vi.mock('node:fs') 把
// /proc/sys/kernel/random/boot_id 的读数桩成固定值，首个 acquire 即以桩值落缓存。

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireInstanceLock } from '../src/single-instance.ts';
import type { Logger } from '../src/platform/events/bus.ts';

const stub = vi.hoisted(() => ({
  bootIdPath: '/proc/sys/kernel/random/boot_id',
  selfBootId: 'boot-self-0000',
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
      args[0] === stub.bootIdPath ? `${stub.selfBootId}\n` : actual.readFileSync(...args),
  };
});

const silentLog: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** 一个确定存活的 pid：拉起长驻 node 子进程，返回 pid 与清理函数。 */
const liveProcess = (): { pid: number; stop: () => void } => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  child.unref();
  return { pid: child.pid ?? 0, stop: () => child.kill() };
};

/** startedAt 留空（该维度降级）——判定只剩「pid 活」与 bootId 两维，用例
 * 判别的就是 bootId 分支本身：删掉它则活 pid 判 alive 拒启。 */
const lockWithBoot = (pid: number, bootId: string): string => JSON.stringify({ pid, startedAt: '', bootId });

const readLock = (path: string): { pid: number; bootId?: string } =>
  JSON.parse(readFileSync(path, 'utf8')) as { pid: number; bootId?: string };

const dirs: string[] = [];
const freshDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'juli-instance-bootid-'));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('单实例锁 · 跨 boot 验身', () => {
  it('前提：本进程写入的锁携带桩值 bootId（桩生效，跨 boot 分支可达）', () => {
    const dir = freshDir();
    const path = acquireInstanceLock(dir, silentLog);
    expect(path).not.toBeNull();
    expect(readLock(path!).bootId).toBe(stub.selfBootId);
  });

  it('活 pid + 他 boot 的 bootId → 判跨 boot 陈旧，回收重取', () => {
    const dir = freshDir();
    const lockPath = join(dir, 'instance.lock');
    const child = liveProcess();
    try {
      writeFileSync(lockPath, lockWithBoot(child.pid, 'boot-other-9999'));
      expect(acquireInstanceLock(dir, silentLog)).not.toBeNull();
      expect(readLock(lockPath).pid).toBe(process.pid);
      expect(readLock(lockPath).bootId).toBe(stub.selfBootId);
    } finally {
      child.stop();
    }
  });

  it('对照：活 pid + 同 boot 的 bootId → 真被持有，拒启且锁原封（分支只在 boot 不符时生效）', () => {
    const dir = freshDir();
    const lockPath = join(dir, 'instance.lock');
    const child = liveProcess();
    try {
      const held = lockWithBoot(child.pid, stub.selfBootId);
      writeFileSync(lockPath, held);
      expect(acquireInstanceLock(dir, silentLog)).toBeNull();
      expect(readFileSync(lockPath, 'utf8')).toBe(held);
    } finally {
      child.stop();
    }
  });
});
