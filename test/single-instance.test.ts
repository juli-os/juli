// 单实例锁真校验（2026-11-08 审查 P1 起）：同一 data_dir 第二次取锁必须失败、
// 陈旧锁（持锁 pid 已死/文件损坏）必须回收、data_dir 不存在必须建出、pid 复用
// 必须验身识别、退出清理不误删他人锁；验身基准对读取方 LANG/TZ 免疫、
// self-pid 遗留锁回收、held 集合语义（同进程二次 acquire 让位且绝不动自己的
// 活锁）；回收前重读与放回失败告警（三方交错的收窄与残余窗口）。
// 锁级校验，不起两个完整引擎进程竞速。真实入口的拒启（exit 0）与 listen 失败
// （exit 1）走子进程，见 index-entry.test.ts。全部用临时目录，不碰真实
// ~/.juli-service 数据面。
//
// 交错注入说明：真实并行竞态（两进程在毫秒窗内同时回收同一把陈旧锁）
// 在 vitest 内不可确定性搭建——用 vi.mock 对 node:fs 的 renameSync /
// openSync('wx') / linkSync 挂单发钩子（判读期的探活另用 spyOn 钩
// process.kill），在实现的关键 syscall 边界上手工扮演「竞速者」的文件级
// 动作（删锁 / 建活锁），交错分支可确定性复现。
// linkSync 注错钩子扮演不支持硬链接的文件系统（降级路径真校验）；
// self-pid 用例锁内写实测自身 startedAt（判别 self-pid 分支本身）；空内容锁
// 宽限分支用例。跨 boot 分支见 single-instance-bootid.test.ts（模块级缓存隔离）。

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireInstanceLock, releaseInstanceLock } from '../src/single-instance.ts';
import type { Logger } from '../src/platform/events/bus.ts';

const silentLog: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

// —— 交错注入钩子（单发；beforeEach 复位。vi.hoisted 供 vi.mock 工厂
// 提升 后仍可引用；renameConsumed 门控：attempt 0 的 wx 直建不得触发
// onWxOpen——它只在 rename 之后的下一轮 wx 建锁处生效）——
// onPutBack：有人把 .recycled.* 放回锁路径时，先在空出的原位扮演第三方建锁。
// linkError（非单发）：置位期间 linkSync 一律抛该 errno，模拟
// 不支持硬链接的文件系统。
const hooks = vi.hoisted(() => ({
  onRename: null as null | ((src: string) => void),
  onWxOpen: null as null | ((path: string) => void),
  onPutBack: null as null | ((path: string) => void),
  renameConsumed: false,
  linkError: null as null | string,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (src: string, dest: string) => {
      if (hooks.onRename) {
        const h = hooks.onRename;
        hooks.onRename = null;
        hooks.renameConsumed = true;
        h(src);
      }
      return actual.renameSync(src, dest);
    },
    openSync: (path: string, flags: string | number, mode?: number) => {
      if (flags === 'wx' && hooks.onWxOpen && hooks.renameConsumed) {
        const h = hooks.onWxOpen;
        hooks.onWxOpen = null;
        h(path);
      }
      return actual.openSync(path, flags, mode);
    },
    linkSync: (existingPath: string, newPath: string) => {
      if (hooks.linkError !== null) {
        throw Object.assign(
          new Error(`${hooks.linkError}: operation not supported on this filesystem, link '${existingPath}' -> '${newPath}'`),
          { code: hooks.linkError },
        );
      }
      if (hooks.onPutBack && existingPath.includes('.recycled.')) {
        const h = hooks.onPutBack;
        hooks.onPutBack = null;
        h(newPath);
      }
      return actual.linkSync(existingPath, newPath);
    },
  };
});

/** 与实现同序取某进程启动时刻：linux 优先 /proc 第 22 字段（ticks），其余
 * 走 ps -o lstart=（macOS）。验身语义测试用它构造/断言锁内 startedAt——
 * 与实现同步钉环境：两边读同一进程必须恒同串，读取方本地化
 * （zh_CN 的「一 11月/ 9 …」）不得改变结果。 */
const measuredStartedAt = (pid: number): string => {
  if (process.platform !== 'darwin') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const t = fields[19];
      if (t !== undefined && t !== '') return t;
    } catch { /* 落到 ps */ }
  }
  return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
  }).trim();
};

/** 一个确定已死的 pid：同步拉起立即退出的 node 子进程，返回即死。 */
const deadPid = (): number => {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return r.pid ?? 0;
};

/** 一个确定存活的 pid：拉起长驻 node 子进程，返回 pid 与清理函数。 */
const liveProcess = (): { pid: number; stop: () => void } => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  child.unref();
  return { pid: child.pid ?? 0, stop: () => child.kill() };
};

const lockContent = (pid: number, startedAt: string): string => JSON.stringify({ pid, startedAt });

const readLockPid = (path: string): number =>
  (JSON.parse(readFileSync(path, 'utf8')) as { pid: number }).pid;

/** 目录里残留的 .recycled.* 回收文件（应为空——回收者负责清掉自己的）。 */
const recycledFiles = (dir: string): string[] =>
  readdirSync(dir).filter((n) => n.includes('.recycled.'));

const dirs: string[] = [];
const freshDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'juli-instance-lock-'));
  dirs.push(d);
  return d;
};

// 测试卫生：每次成功 acquire 都按锁路径挂一个 exit 钩子（每用例新临时
// 目录 = 新路径），用例数增长后越过默认 10 个监听器上限即报
// MaxListenersExceededWarning——每例结束卸掉本例新增的 exit 钩子（临时目录
// 由下方 rmSync 清理，钩子本无用武之地）。
const exitBaseline = { listeners: process.listeners('exit') };

beforeEach(() => {
  hooks.onRename = null;
  hooks.onWxOpen = null;
  hooks.onPutBack = null;
  hooks.renameConsumed = false;
  hooks.linkError = null;
  exitBaseline.listeners = process.listeners('exit');
});

afterEach(() => {
  for (const l of process.listeners('exit')) {
    if (!exitBaseline.listeners.includes(l)) process.removeListener('exit', l);
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('单实例锁', () => {
  it('首次取锁成功：锁文件落 {pid, startedAt}（验身用的锁格式）', () => {
    const dir = freshDir();
    const path = acquireInstanceLock(dir, silentLog);
    expect(path).not.toBeNull();
    expect(readLockPid(path!)).toBe(process.pid);
    expect(readFileSync(path!, 'utf8')).toContain('startedAt');
    expect(measuredStartedAt(process.pid)).not.toBe('');
    expect(JSON.parse(readFileSync(path!, 'utf8')).startedAt).toBe(measuredStartedAt(process.pid));
  });

  it('同一 data_dir 第二次取锁必须失败（存活实例在位）', () => {
    const dir = freshDir();
    expect(acquireInstanceLock(dir, silentLog)).not.toBeNull();
    // held 集合：二次 acquire 由集合让位，绝不得判「self-pid 遗留」
    // 回收自己的活锁——锁文件字节不变是这条语义的直接观测点。
    const before = readFileSync(join(dir, 'instance.lock'), 'utf8');
    expect(acquireInstanceLock(dir, silentLog)).toBeNull();
    expect(readFileSync(join(dir, 'instance.lock'), 'utf8')).toBe(before);
  });

  it('验身本地化免疫：写锁后切换读取方 LANG/TZ 再 acquire → 仍判 alive 拒启', () => {
    const dir = freshDir();
    const child = liveProcess();
    const prevLcAll = process.env['LC_ALL'];
    const prevLang = process.env['LANG'];
    const prevTz = process.env['TZ'];
    try {
      // 锁内容用与实现同基准（钉环境）的实测 startedAt——即「真实在位实例」
      // 的锁形态。随后把读取方环境切到本地化配置（本机实证：zh_CN 下 ps
      // lstart 变「一 11月/ 9 …」、TZ 漂移时刻也变）——旧实现据此把活着的
      // 持锁实例误判 pidReuse 并回收 → 双持锁；实现钉环境后必须仍判 alive。
      writeFileSync(join(dir, 'instance.lock'), lockContent(child.pid, measuredStartedAt(child.pid)));
      process.env['LC_ALL'] = 'zh_CN.UTF-8';
      process.env['LANG'] = 'zh_CN.UTF-8';
      process.env['TZ'] = 'Asia/Shanghai';
      expect(acquireInstanceLock(dir, silentLog)).toBeNull();
      // 活锁原封未动（未被回收重取）
      expect(JSON.parse(readFileSync(join(dir, 'instance.lock'), 'utf8')).pid).toBe(child.pid);
    } finally {
      if (prevLcAll === undefined) delete process.env['LC_ALL']; else process.env['LC_ALL'] = prevLcAll;
      if (prevLang === undefined) delete process.env['LANG']; else process.env['LANG'] = prevLang;
      if (prevTz === undefined) delete process.env['TZ']; else process.env['TZ'] = prevTz;
      child.stop();
    }
  });

  it('self-pid 遗留：锁内 pid 是本进程但本进程未持锁 → 判上一世遗留回收重取', () => {
    const dir = freshDir();
    const lockPath = join(dir, 'instance.lock');
    // Docker PID 1 / systemd 确定性开机下 pid 易复现：锁内 pid 恰为自身且
    // 本进程从未 acquire 过——必是上一世遗留，绝不判 alive 拒启。
    // startedAt 写实测自身值（验身全一致）——判别的是 self-pid 分支
    // 本身：删掉该分支则 pid 活 + 验身一致判 alive 拒启，用例变红（写错值
    // 时会被 pidReuse 分支同样回收，不判别）。
    writeFileSync(lockPath, lockContent(process.pid, measuredStartedAt(process.pid)));
    expect(acquireInstanceLock(dir, silentLog)).not.toBeNull();
    expect(readLockPid(lockPath)).toBe(process.pid);
    expect(recycledFiles(dir)).toEqual([]);
  });

  it('空内容锁宽限：近 mtime 视为写入中 → 不回收、拒启、锁原封；mtime 拨旧后 → 判陈旧回收', () => {
    const dir = freshDir();
    const lockPath = join(dir, 'instance.lock');
    // 旧版（或无硬链接降级路径）「wx 建空文件、后补内容」的写入中形态。
    writeFileSync(lockPath, '');
    expect(acquireInstanceLock(dir, silentLog)).toBeNull();
    expect(readFileSync(lockPath, 'utf8')).toBe(''); // 在写者的锁未被 rename 回收
    expect(recycledFiles(dir)).toEqual([]);
    // 超宽限仍是空 = 写入者已死半个进程——照旧判陈旧回收。
    const old = new Date(Date.now() - 10_000);
    utimesSync(lockPath, old, old);
    expect(acquireInstanceLock(dir, silentLog)).not.toBeNull();
    expect(readLockPid(lockPath)).toBe(process.pid);
    expect(recycledFiles(dir)).toEqual([]);
  });

  it.each(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])(
    '不支持硬链接的 FS（link 回 %s）：降级 wx 直建取锁成功、告警恰一行、无临时件残留',
    (code) => {
      const dir = freshDir();
      hooks.linkError = code;
      const warns: string[] = [];
      const log: Logger = { ...silentLog, warn: (m) => { warns.push(m); } };
      const path = acquireInstanceLock(dir, log);
      expect(path).not.toBeNull();
      expect(readLockPid(path!)).toBe(process.pid);
      expect(warns.length).toBe(1);
      expect(warns[0]).toContain(code);
      expect(readdirSync(dir).filter((n) => n.includes('.incoming.'))).toEqual([]);
    },
  );

  it('不支持硬链接的 FS 下陈旧锁回收：降级建锁照常回收重取', () => {
    const dir = freshDir();
    const lockPath = join(dir, 'instance.lock');
    writeFileSync(lockPath, lockContent(deadPid(), ''));
    hooks.linkError = 'EOPNOTSUPP';
    expect(acquireInstanceLock(dir, silentLog)).not.toBeNull();
    expect(readLockPid(lockPath)).toBe(process.pid);
    expect(recycledFiles(dir)).toEqual([]);
  });

  it('不支持硬链接的 FS 下交错③：放回降级 wx 不覆盖放回竞速者活锁 → 拒启', () => {
    const dir = freshDir();
    const lockPath = join(dir, 'instance.lock');
    const child = liveProcess();
    try {
      writeFileSync(lockPath, lockContent(deadPid(), ''));
      const racerLock = lockContent(child.pid, '');
      hooks.linkError = 'ENOTSUP';
      // 竞速者在重读与 rename 之间完成整轮回收+重建：删陈旧锁、建自己的活锁
      hooks.onRename = () => {
        rmSync(lockPath);
        writeFileSync(lockPath, racerLock);
      };
      expect(acquireInstanceLock(dir, silentLog)).toBeNull();
      // link 放回不可用时降级 wx 放回——竞速者的活锁回到原位（不降级则路径空缺）
      expect(readFileSync(lockPath, 'utf8')).toBe(racerLock);
      expect(recycledFiles(dir)).toEqual([]);
    } finally {
      child.stop();
    }
  });

  it('陈旧锁回收：持锁 pid 已死 → 重取成功，回收文件清干净', () => {
    const dir = freshDir();
    const lockPath = join(dir, 'instance.lock');
    writeFileSync(lockPath, lockContent(deadPid(), '任意时刻'));
    expect(acquireInstanceLock(dir, silentLog)).not.toBeNull();
    expect(readLockPid(lockPath)).toBe(process.pid);
    expect(recycledFiles(dir)).toEqual([]);
  });

  it('陈旧锁回收：锁文件损坏（非 pid 内容）→ 重取成功', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'instance.lock'), 'not-a-pid');
    expect(acquireInstanceLock(dir, silentLog)).not.toBeNull();
  });

  it('data_dir 不存在 → 取锁成功且目录被建出（recursive）', () => {
    const parent = freshDir();
    const deep = join(parent, 'nested', 'data'); // 连父目录都不存在
    expect(existsSync(deep)).toBe(false);
    const path = acquireInstanceLock(deep, silentLog);
    expect(path).not.toBeNull();
    expect(existsSync(deep)).toBe(true);
    expect(readLockPid(path!)).toBe(process.pid);
  });

  it('pid 复用验身：活 pid + 错误 startedAt → 判复用，回收重取成功', () => {
    const dir = freshDir();
    const lockPath = join(dir, 'instance.lock');
    const child = liveProcess();
    try {
      // 锁写的是「活着的 pid」，但 startedAt 与该 pid 实测启动时刻不符——
      // 即锁是同 pid 上一世进程的遗留（pid 复用），必须回收而非拒启。
      writeFileSync(lockPath, lockContent(child.pid, 'WRONG-STARTED-AT'));
      const path = acquireInstanceLock(dir, silentLog);
      expect(path).not.toBeNull();
      expect(readLockPid(lockPath)).toBe(process.pid);
      expect(recycledFiles(dir)).toEqual([]);
    } finally {
      child.stop();
    }
  });

  it('验身一致：活 pid + 实测自身 startedAt → 真被持有，拒启', () => {
    const dir = freshDir();
    const child = liveProcess();
    try {
      // 活 pid 改用子进程——锁内 pid 是本进程自己的情况已改判「上一世
      // 遗留」回收（self-pid 分支），「同进程二次 acquire 让位」由 held 集合
      // 表达（见 held 集合用例）；本用例锁定的是对真·第三方活锁的拒启。
      writeFileSync(
        join(dir, 'instance.lock'),
        lockContent(child.pid, measuredStartedAt(child.pid)),
      );
      expect(acquireInstanceLock(dir, silentLog)).toBeNull();
      // 活锁原封未动（未被回收重取）
      expect(JSON.parse(readFileSync(join(dir, 'instance.lock'), 'utf8')).pid).toBe(child.pid);
    } finally {
      child.stop();
    }
  });

  it('释放：releaseInstanceLock 后锁文件消失、二次 acquire 成功', () => {
    const dir = freshDir();
    expect(acquireInstanceLock(dir, silentLog)).not.toBeNull();
    expect(releaseInstanceLock(dir, silentLog)).toBe(true);
    expect(existsSync(join(dir, 'instance.lock'))).toBe(false);
    expect(acquireInstanceLock(dir, silentLog)).not.toBeNull();
  });

  it('退出清理钩子不误删他人锁：锁内容被换后触发钩子 → 文件仍在', () => {
    const dir = freshDir();
    const lockPath = join(dir, 'instance.lock');
    const before = process.listeners('exit').length;
    expect(acquireInstanceLock(dir, silentLog)).not.toBeNull();
    const added = process.listeners('exit').slice(before);
    expect(added.length).toBe(1);
    const hook = added[0];
    expect(hook).toBeDefined();
    // 锁被并发换人（模拟后来者建锁）——钩子必须认出「这不是我的锁」
    writeFileSync(lockPath, lockContent(deadPid(), 'someone-else'));
    (hook as unknown as () => void)();
    expect(existsSync(lockPath)).toBe(true);
    if (hook) process.removeListener('exit', hook); // 测试卫生：卸掉钩子
  });

  it('交错①：判读后锁被并发收走（rename ENOENT）且无人再建 → 全新 acquire 成功', () => {
    const dir = freshDir();
    const lockPath = join(dir, 'instance.lock');
    writeFileSync(lockPath, lockContent(deadPid(), ''));
    // 竞速者在我判读与 rename 之间把陈旧锁收走（只删，尚未建新锁）
    hooks.onRename = () => { rmSync(lockPath); };
    expect(acquireInstanceLock(dir, silentLog)).not.toBeNull();
    expect(readLockPid(lockPath)).toBe(process.pid);
    expect(recycledFiles(dir)).toEqual([]);
  });

  it('交错②：rename ENOENT 后竞速者抢先建活锁 → 拒启，竞速者锁原封不动', () => {
    const dir = freshDir();
    const lockPath = join(dir, 'instance.lock');
    const child = liveProcess();
    try {
      writeFileSync(lockPath, lockContent(deadPid(), ''));
      const racerLock = lockContent(child.pid, ''); // startedAt 空 → 验身降级纯探活（活 pid → 真持有）
      hooks.onRename = () => { rmSync(lockPath); }; // 竞速者第一步：收走陈旧锁
      hooks.onWxOpen = () => { writeFileSync(lockPath, racerLock); }; // 竞速者第二步：抢先建活锁
      expect(acquireInstanceLock(dir, silentLog)).toBeNull();
      // 回归断言：竞速者的锁没被我们动过（旧码 unlink 会抹掉它，造成双持锁）
      expect(readFileSync(lockPath, 'utf8')).toBe(racerLock);
      expect(recycledFiles(dir)).toEqual([]);
    } finally {
      child.stop();
    }
  });

  it('交错③：rename 搬走的是竞速者新建的活锁（战利品验身不符）→ 放回 + 拒启', () => {
    const dir = freshDir();
    const lockPath = join(dir, 'instance.lock');
    const child = liveProcess();
    try {
      writeFileSync(lockPath, lockContent(deadPid(), ''));
      const racerLock = lockContent(child.pid, '');
      // 竞速者在重读与 rename 之间完成整轮回收+重建：删陈旧锁、建自己的活锁
      hooks.onRename = () => {
        rmSync(lockPath);
        writeFileSync(lockPath, racerLock);
      };
      expect(acquireInstanceLock(dir, silentLog)).toBeNull();
      // 我们的 rename 把竞速者的活锁搬进了 .recycled.*——验身发现内容不符后原样放回
      expect(readFileSync(lockPath, 'utf8')).toBe(racerLock);
      expect(recycledFiles(dir)).toEqual([]);
    } finally {
      child.stop();
    }
  });

  it('判读后、回收前锁已被别人回收重建 → 回收前重读发现内容已变：不搬动不放回，他人活锁原封，第三方无空位可钻', () => {
    const dir = freshDir();
    const lockPath = join(dir, 'instance.lock');
    const a = liveProcess();
    const c = liveProcess();
    try {
      const stalePid = deadPid();
      writeFileSync(lockPath, lockContent(stalePid, ''));
      const lockA = lockContent(a.pid, measuredStartedAt(a.pid));
      const lockC = lockContent(c.pid, measuredStartedAt(c.pid));
      // 竞速者 A 在「我判读」期间完成整轮回收 + 建锁：钩在判读对陈旧 pid 的探活上。
      const realKill = process.kill.bind(process);
      let racedA = false;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
        if (pid === stalePid && signal === 0 && !racedA) {
          racedA = true;
          rmSync(lockPath);
          writeFileSync(lockPath, lockA);
        }
        return realKill(pid, signal);
      });
      // 第三方 C：一旦有人往原位放回，就抢先在空位上建锁。
      hooks.onPutBack = () => { writeFileSync(lockPath, lockC); };
      try {
        expect(acquireInstanceLock(dir, silentLog)).toBeNull();
      } finally {
        killSpy.mockRestore();
      }
      expect(racedA).toBe(true);
      // A 的锁原封：没被 rename 搬走，原位从未空出，C 也就无从建锁。
      // （不重读时：A 的锁被搬走、C 在放回空窗占位，A 与 C 同时持锁。）
      expect(readFileSync(lockPath, 'utf8')).toBe(lockA);
      expect(recycledFiles(dir)).toEqual([]);
    } finally {
      a.stop();
      c.stop();
    }
  });

  it('残余窗口（头注已披露）：重读后、rename 前锁被别人回收重建，放回前原位又被第三方新建 → 不覆盖、删战利品、让位并打一行 error', () => {
    const dir = freshDir();
    const lockPath = join(dir, 'instance.lock');
    const a = liveProcess();
    const c = liveProcess();
    try {
      writeFileSync(lockPath, lockContent(deadPid(), ''));
      const lockA = lockContent(a.pid, measuredStartedAt(a.pid));
      const lockC = lockContent(c.pid, measuredStartedAt(c.pid));
      // A 的整轮回收 + 建锁落在重读与 rename 之间（onRename 在真正 rename 之前触发）。
      hooks.onRename = () => {
        rmSync(lockPath);
        writeFileSync(lockPath, lockA);
      };
      // rename 把 A 的锁搬走后原位空出；C 抢在放回之前建锁。
      hooks.onPutBack = () => { writeFileSync(lockPath, lockC); };
      const errors: string[] = [];
      const log: Logger = { ...silentLog, error: (m) => { errors.push(m); } };
      expect(acquireInstanceLock(dir, log)).toBeNull();
      // C 的锁不被覆盖；A 的锁文件已丢失——A 与 C 同时持锁，正是头注披露的残余窗口。
      expect(readFileSync(lockPath, 'utf8')).toBe(lockC);
      expect(recycledFiles(dir)).toEqual([]);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('无法放回');
      expect(errors[0]).toContain(`"pid":${a.pid}`);
    } finally {
      a.stop();
      c.stop();
    }
  });
});
