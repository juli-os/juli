// 单实例保证（2026-11-08 审查 P1）：
// 重复实例在端口独占确立前已对共享账本跑完一轮重启对账（live 日志实证：
// 「已启动」3668 次 / EADDRINUSE 3655 次，两次事故步均死于重复实例的
// reconcileStartup）。防线放在任何账本副作用之前——loadConfig 之后、
// createRuntime 之前对 data_dir 取独占锁。
//
// 实现选锁文件（而非独立 lock.db BEGIN EXCLUSIVE）：纯 node:fs 零新依赖，
// 陈旧锁回收路径显式可测。锁内容为 JSON {"pid","startedAt","bootId"}——
// startedAt 是写入方的进程启动时刻，bootId 是写入方所在 boot 的标识
// （Linux /proc/sys/kernel/random/boot_id，非 Linux 恒空）。两者合起来识别
// 「pid 被无关进程复用」（只探活不验身时，机器重启/pid 回绕后旧
// pid 落到无关进程头上，真实例被永久拒启）与「跨 boot 的同 pid 同启动
// tick」（systemd 确定性开机下 pid 易复现、Docker 下 node 恒为
// PID 1，断电重启后 /proc starttime 若恰同即误判活锁；bootId 独立成字段
// 而非拼进 startedAt——拼进会让新读方把旧格式（无 bootId 前缀）在途活锁
// 误判 pidReuse 而回收，独立字段则新旧读写方双向兼容、缺字段自动降级）。
// 持锁进程死亡后锁文件成为陈旧遗留，下次启动按「判活 + 验身」判死回收。
// 回收走 rename 而非 unlink：unlink 先删后建不是原子的，竞速下 A 的 unlink
// 会抹掉 B 刚建的新锁，造成双持锁。rename 是原子的，但它搬走的是路径上
// 「此刻」那把锁，不一定是判读过的那把。所以 rename 之前先重读，内容仍等于
// 判读值才动手——判读里的验身要跑 ps，可达数十毫秒；重读把窗口收窄到
// 「重读」与「rename」两次系统调用之间。rename 之后再对搬来的锁验身，不符
// 就用 link 放回原位；原位已被别人新建则绝不覆盖。
// 残余窗口（已知、未消除）：重读与 rename 之间，另一个回收者完成整轮「回收
// + 建锁」；放回之前，又有第三个启动者在空出的原位建锁成功。这时放回撞
// EEXIST，第二个回收者的锁文件丢失，它和第三者同时持锁（回收方打一行 error
// 供人工排查）。触发需要事先有陈旧锁，且三个启动者在微秒级交错；当前部署
// 拓扑（单一监管者串行拉起：launchd / systemd 单 job）下不可达。彻底消除要
// 换内核锁（例如 SQLite 独占锁，持锁进程一死内核即放锁），属架构决策，留给
// 人定。
// 建锁走「写满内容的临时文件 + linkSync」（wx 建空文件后补内容有可观测
// 空窗——并发读方读到空串判 stale 误回收，先到者把内容写进已被移走的
// inode 仍报成功 → 双持锁；link 原子且带内容，EEXIST 即被占）。data_dir
// 所在文件系统不支持硬链接（exFAT/FAT、多数 SMB/CIFS、部分 FUSE）时建锁降级
// 为 wx 直建 + 写入，其空内容窗口由空内容锁宽限兜住。
// 拿不到锁由调用方打日志后 exit(0)（exit 不在本模块——返回 null 便于锁级
// 真校验测试）。
//
// 边界：本锁只在同一 pid 命名空间内成立。多容器共享
// data_dir 卷时，对方容器的 pid 在本容器探活会命中同名 pid 的本地进程
// （Docker 里 node 恒为 PID 1，互相探活命中的甚至可能是自己）——该部署
// 形态不受本锁保护，共享卷的容器组必须由编排层保证单副本。

import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Logger } from './platform/events/bus.ts';

const LOCK_FILE = 'instance.lock';

/** 进程启动时刻：Linux /proc/<pid>/stat 的 starttime（clock ticks；comm 可
 * 含空格与括号——从最后一个 ')' 之后取剩余字段，starttime 是其中第 20 个）；
 * macOS 走 `ps -p <pid> -o lstart=`。取不到（平台不支持/ps 缺失/pid 刚死）
 * 返回空串——验身随之降级为纯探活（见 judgeHolderState）。降级窗口内 pid
 * 复用仍会误判为真持有，但那仅发生在取不到启动时刻的环境，与旧版行为
 * 一致（不比旧版更差）。
 *
 * ps 的输出随【读取方】的 LANG、LC_* 族与 TZ 变化（本机实证：LANG=C.UTF-8
 * 得 "Mon Nov  9 00:27:36 2026"，LANG=zh_CN.UTF-8 得 "一 11月/ 9 00:27:36
 * 2026"）——同一进程，读写双方环境不同即互不认识，活着的一方会被判
 * pidReuse 回收 → 双持锁。故 spawn 固定环境（C locale + UTC），读写双方
 * 恒同串；Linux /proc 分支本就与 locale 无关，不受影响。 */
const startedAtOf = (pid: number): string => {
  if (process.platform !== 'darwin') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = fields[19];
      if (ticks !== undefined && ticks !== '') return ticks;
    } catch { /* 非 linux 或进程已死——落到 ps */ }
  }
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
    }).trim();
  } catch {
    return '';
  }
};

/** 本机 boot 标识：Linux 读 /proc/sys/kernel/random/boot_id；非
 * Linux / 读不到返回空串——boot 维度验身随之降级（与 startedAt 降级语义
 * 相同：缺哪个维度就只比哪个维度，不比旧版更差）。 */
const bootIdOf = (): string => {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return '';
  }
};

// 本进程启动时刻 / boot 标识——进程生命周期内恒定，各取一次缓存（验身基准）。
let selfStartedAtCache: string | null = null;
const selfStartedAt = (): string => {
  if (selfStartedAtCache === null) selfStartedAtCache = startedAtOf(process.pid);
  return selfStartedAtCache;
};
let selfBootIdCache: string | null = null;
const selfBootId = (): string => {
  if (selfBootIdCache === null) selfBootIdCache = bootIdOf();
  return selfBootIdCache;
};

// 本进程写入锁文件的确切内容（退出清理/显式释放按字节比对，只删自己的锁）。
const ownLockContent = (): string =>
  JSON.stringify({ pid: process.pid, startedAt: selfStartedAt(), bootId: selfBootId() });

interface LockContent { pid: number; startedAt: string; bootId: string }

/** 锁内容解析：新格式 JSON {"pid","startedAt","bootId"}（bootId 可缺——旧
 * 版锁无此字段）；旧格式裸 pid（startedAt 记空串 → 验身降级为纯探活，向后
 * 兼容）；完全无法解析 → pid=NaN（判陈旧）。 */
const parseLockContent = (raw: string): LockContent => {
  try {
    const j = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown; bootId?: unknown };
    if (Number.isInteger(j.pid) && (j.pid as number) > 0 && typeof j.startedAt === 'string') {
      return {
        pid: j.pid as number,
        startedAt: j.startedAt,
        bootId: typeof j.bootId === 'string' ? j.bootId : '',
      };
    }
  } catch { /* 旧格式裸 pid 或损坏内容 */ }
  const pid = Number.parseInt(raw.trim(), 10);
  return { pid: Number.isInteger(pid) && pid > 0 ? pid : Number.NaN, startedAt: '', bootId: '' };
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // EPERM=活但无权限，同样视为占用
  }
};

/** 持锁人状态（纯判定，文件读失败由调用方处理）：
 * 'alive'    真被持有——pid 活，且各维度验身一致或任一侧对应维度取不到（降级纯探活）；
 * 'pidReuse' pid 活但启动时刻与锁内记录不符——锁是同 pid 上一世进程的遗留；
 * 'stale'    pid 已死/跨 boot/内容损坏/锁内 pid 是本进程自己（本进程
 *            未持锁时锁内出现自身 pid，必是上一世的遗留——每进程只 acquire 一次）。 */
type HolderState = 'alive' | 'pidReuse' | 'stale';
const judgeHolderState = (raw: string): HolderState => {
  const { pid, startedAt, bootId } = parseLockContent(raw);
  if (!Number.isInteger(pid) || pid <= 0) return 'stale';
  if (pid === process.pid) return 'stale'; // self-pid：Docker PID 1 / systemd 确定性 pid 的遗留锁识别
  if (!pidAlive(pid)) return 'stale';
  if (bootId !== '' && selfBootId() !== '' && bootId !== selfBootId()) return 'stale'; // 跨 boot：pid/tick 即便全同也是别人
  const holderStartedAt = startedAtOf(pid);
  if (startedAt !== '' && holderStartedAt !== '' && startedAt !== holderStartedAt) return 'pidReuse';
  return 'alive';
};

// 「文件系统不支持硬链接」类错误码：exFAT/FAT（Linux vfat 回
// EPERM）、多数 SMB/CIFS 挂载（EOPNOTSUPP/ENOTSUP）、部分 FUSE（ENOSYS）。
const LINK_UNSUPPORTED_CODES: ReadonlySet<string> = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);
const linkUnsupported = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException).code;
  return code !== undefined && LINK_UNSUPPORTED_CODES.has(code);
};

/** wx 直建 + 写入（无硬链接时的降级路径）：已存在即 EEXIST 返回 false，绝不
 * 覆盖；建出到写完之间有空内容窗口——由读方的空内容锁宽限
 *（emptyLockStillBeingWritten）兜住，不判陈旧、不回收。 */
const createLockDirect = (path: string, content: string): boolean => {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
};

/** 每次 acquire 至多一行的降级告警——单次 acquire 内可能多次
 * 建锁/放回，告警不刷屏；按 acquire 计而非模块级一次性，测试可确定性断言。 */
const makeLinkFallbackWarner = (log: Logger): ((e: unknown) => void) => {
  let warned = false;
  return (e) => {
    if (warned) return;
    warned = true;
    log.warn(`[instance] data_dir 文件系统不支持硬链接（${(e as NodeJS.ErrnoException).code ?? '?'}）——实例锁降级为 wx 直建（空内容窗口由宽限兜住）`);
  };
};

/** 带内容原子建锁：写满内容的临时文件 linkSync 到锁路径——link
 * 原子且目标已存在即 EEXIST，绝无「空文件先落盘、内容后补」的可观测窗口。
 * 返回 false = 路径已被占（调用方走判读/回收分支）。
 * data_dir 所在文件系统不支持硬链接（link 回 LINK_UNSUPPORTED_CODES）
 * 时降级为 wx 直建 + 写入，绝不原样抛出致启动即崩。 */
const createLockWithContent = (path: string, content: string, onLinkFallback: (e: unknown) => void): boolean => {
  const incoming = `${path}.incoming.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  const fd = openSync(incoming, 'wx');
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(incoming, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    if (linkUnsupported(e)) {
      onLinkFallback(e);
      return createLockDirect(path, content);
    }
    throw e;
  } finally {
    unlinkSync(incoming);
  }
};

// 空内容锁的写入中宽限：旧版（或外部工具）「wx 建空文件、后补内
// 容」的窗口内读到空串不判 stale 不回收；mtime 距今在宽限内视为「正在写入」，
// 睡眠重试。超宽限仍是空 = 写入者已死半个进程，照旧回收。
const EMPTY_LOCK_GRACE_MS = 2000;
const EMPTY_LOCK_RETRY_MS = 50;

// 同步睡眠（acquire 是同步 API，锁级测试要求确定性——Atomics.wait 是主线程
// 唯一不烧 CPU 的同步等待面）。仅用于空内容锁重试的短间隔。
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** 空内容 + mtime 在写入宽限内 = 疑似正在建锁（读失败/路径消失按不在窗口算，
 * 交回正常判读流程）。 */
const emptyLockStillBeingWritten = (path: string, raw: string): boolean => {
  if (raw.trim() !== '') return false;
  try {
    return Date.now() - statSync(path).mtimeMs < EMPTY_LOCK_GRACE_MS;
  } catch {
    return false;
  }
};

/** rename 支配的陈旧锁回收。'won'=已建好自己的新锁；'lost'=并发
 * 让位（调用方返回 null）；'retry'=回循环下一轮。content 由调用方在进循环
 * 前算好传入（建锁前不再现算——原实参求值时点在 open 与判读之间，
 * 是空窗缺陷的一半）。 */
const recycleViaRename = (
  path: string, judgedRaw: string, content: string, onLinkFallback: (e: unknown) => void, log: Logger,
): 'won' | 'lost' | 'retry' => {
  // 动手前重读：判读之后（验身要跑 ps）锁可能已被别人回收重建。内容变了就
  // 不碰它，回循环重新判读——rename 只搬此刻仍是判读值的那把锁。
  let currentRaw: string;
  try {
    currentRaw = readFileSync(path, 'utf8');
  } catch {
    return 'retry'; // 已被并发收走——下一轮全新 acquire
  }
  if (currentRaw !== judgedRaw) return 'retry';
  const recycled = `${path}.recycled.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  try {
    renameSync(path, recycled);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // 陈旧锁已被并发回收者收走（rename 原子，第二个竞速者得 ENOENT）——
      // 绝不 unlink 任何现存文件（旧码双持锁正来自这一步），转全新 acquire。
      return 'retry';
    }
    throw e;
  }
  // 战利品验身：搬走的必须还是当初判死的那把锁。内容已变 = 竞速者在「我
  // 重读」与「我 rename」之间完成了一轮回收+重建——绝不能带着别人的活锁
  // 建自己的锁（否则两方同时持锁）：path 空缺则把别人的锁原样放回，path 已
  // 被第三方新建则不覆盖（见头注「残余窗口」）；无论如何本进程让位。
  let movedRaw = '';
  try { movedRaw = readFileSync(recycled, 'utf8'); } catch { /* 读不到按外锁处理，保守让位 */ }
  if (movedRaw !== judgedRaw) {
    // 放回改 linkSync——旧 statSync 判空 → renameSync 覆盖之间，竞速
    // 者可建新锁被 rename 无声抹掉（TOCTOU）；link 已占位即 EEXIST，绝不
    // clobber。两个出口都清自己的战利品：放回成功时 unlink 只摘本名链接，
    // path 上的硬链接仍在。
    let restored = false;
    try {
      linkSync(recycled, path);
      restored = true;
    } catch (e) {
      // 不支持硬链接的文件系统降级为 wx 不覆盖放回（内容取
      // movedRaw；读不到即空串时不放回——不凭空种空锁）。EEXIST 等：竞速者
      // 已占位——不放回。
      if (linkUnsupported(e) && movedRaw !== '') {
        onLinkFallback(e);
        try { restored = createLockDirect(path, movedRaw); } catch { /* 放回尽力而为 */ }
      }
    }
    if (!restored) {
      // 头注「残余窗口」被触发：被搬走的锁若属于一个活着的实例，它已失去锁
      // 文件，会与原位的新持锁方同时持锁——无法自动挽回，留一行 error 供排查。
      log.error(`[instance] 回收陈旧锁时搬走了别人刚建的锁，原位又已被他人新建，无法放回（被搬走的锁内容：${movedRaw === '' ? '（空）' : movedRaw}）——若其持有方仍在运行，将与当前持锁方同时持锁，请人工排查`);
    }
    try { unlinkSync(recycled); } catch { /* 并发清理 */ }
    return 'lost';
  }
  // rename 成功者建新锁：被占 = 竞速者抢先建了活锁——验活：活则让位；
  // 又成陈旧/复用/已消失则回回收分支。自己的回收文件无论走哪条出口都清掉。
  let created = false;
  try {
    created = createLockWithContent(path, content, onLinkFallback);
  } catch (e) {
    try { unlinkSync(recycled); } catch { /* 并发清理 */ }
    throw e;
  }
  if (!created) {
    try { unlinkSync(recycled); } catch { /* 并发清理 */ }
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return 'retry'; // 又消失——下一轮全新 acquire
    }
    return judgeHolderState(raw) === 'alive' ? 'lost' : 'retry';
  }
  try { unlinkSync(recycled); } catch { /* 并发清理 */ }
  return 'won';
};

// 退出清理钩子按路径去重（多次 acquire/release 循环不叠加监听器）。
const exitCleanupPaths = new Set<string>();

// 本进程当前持有的锁路径：每进程只 acquire 一次，已持锁的二次
// acquire 让位返回 null——「同进程重复取锁」的语义由集合表达，不再依赖
// judgeHolderState 对自身 pid 的探活（那样会把二次 acquire 变成回收自己的活锁）。
const heldLockPaths = new Set<string>();

/** 退出清理钩子：unlink 前先读文件确认内容仍是自己写的——内容已
 * 换人（后来者建了新锁）绝不删。'exit' 处理器只能跑同步代码，
 * readFileSync/unlinkSync 合规。 */
const installExitCleanup = (path: string): void => {
  if (exitCleanupPaths.has(path)) return;
  exitCleanupPaths.add(path);
  process.on('exit', () => {
    try {
      if (readFileSync(path, 'utf8') === ownLockContent()) unlinkSync(path);
    } catch { /* 读不到/删不掉——退出路径尽力而为 */ }
  });
};

/** 对 data_dir 取进程独占锁。成功返回锁路径（并注册 exit 清理钩子）；
 * data_dir 已有存活实例（锁被持有——验身一致或无法验身）或本进程已持锁
 * 时返回 null——调用方打一行日志后 exit(0)，日志可用
 * inspectInstanceLock 带上持有方 pid/startedAt。陈旧锁（持锁 pid 已死/pid
 * 复用/跨 boot/内容损坏/self-pid 遗留）按 rename 支配回收后重取，有界重试
 * 防并发互踢死循环。 */
export const acquireInstanceLock = (dataDir: string, log: Logger): string | null => {
  // 全新部署 data_dir 不存在时，旧码在 openSync('wx') 处 ENOENT 直接
  // throw（index.ts 顶层无 try → 进程崩，launchd KeepAlive 下成崩溃循环——
  // 唯一建目录的 createRuntime 永远走不到）。入口先建目录，已存在时 no-op
  // 幂等；与 runtime.ts createRuntime 的建目录同语义。
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, LOCK_FILE);
  if (heldLockPaths.has(path)) return null; // 本进程已持有——让位
  const content = ownLockContent(); // 内容先进循环前算好（建锁原子化的前提）
  const onLinkFallback = makeLinkFallbackWarner(log); // 本次 acquire 至多一行降级告警
  for (let attempt = 0; attempt < 3; attempt++) {
    // 带内容原子建锁——「wx 建空文件、后写内容」的空窗不复存在。
    if (createLockWithContent(path, content, onLinkFallback)) {
      log.info(`[instance] 实例锁已获取 ${path}（pid=${process.pid}）`);
      heldLockPaths.add(path);
      installExitCleanup(path);
      return path;
    }
    // EEXIST：读锁内容判定持有者——alive 让位；stale/pidReuse 走 rename 支配回收。
    let judgedRaw: string;
    try {
      judgedRaw = readFileSync(path, 'utf8');
    } catch {
      continue; // 刚被并发收走——下一轮全新 acquire
    }
    if (emptyLockStillBeingWritten(path, judgedRaw)) {
      // 空内容近 mtime = 疑似旧版在写——不回收（回收会把在写者变成
      // 无锁孤儿），睡眠后重试。
      sleepSync(EMPTY_LOCK_RETRY_MS);
      continue;
    }
    if (judgeHolderState(judgedRaw) === 'alive') return null; // 存活实例在位——本进程让位
    const outcome = recycleViaRename(path, judgedRaw, content, onLinkFallback, log);
    if (outcome === 'lost') return null;
    if (outcome === 'won') {
      log.info(`[instance] 实例锁已获取 ${path}（pid=${process.pid}，陈旧锁已回收）`);
      heldLockPaths.add(path);
      installExitCleanup(path);
      return path;
    }
    continue; // retry
  }
  return null;
};

/** 读取当前锁的持有方信息（拒启日志取证用）：读不到/解析不出返回 null。
 * 与 acquireInstanceLock 无同步关系——只用于日志取证，不用于判定。 */
export const inspectInstanceLock = (dataDir: string): { pid: number; startedAt: string } | null => {
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, LOCK_FILE), 'utf8');
  } catch {
    return null;
  }
  const { pid, startedAt } = parseLockContent(raw);
  return Number.isInteger(pid) && pid > 0 ? { pid, startedAt } : null;
};

/** 显式释放本进程持有的锁——仅供测试与显式工具使用。生产释放走 exit 钩子
 *（installExitCleanup，进程真正退出才松锁）；勿在停机路径提前调用：rt.stop
 * 之后在途 advance 链与 HTTP 请求仍会写账，提前松锁会让新实例拿锁跑
 * reconcileStartup，与旧进程的尾写交错。锁文件不存在或内容不是自己
 * 写的（被并发换人）时不删，返回 false。 */
export const releaseInstanceLock = (dataDir: string, log: Logger): boolean => {
  const path = join(dataDir, LOCK_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  if (raw !== ownLockContent()) return false;
  try {
    unlinkSync(path);
  } catch {
    return false;
  }
  heldLockPaths.delete(path);
  log.info(`[instance] 实例锁已释放 ${path}（pid=${process.pid}）`);
  return true;
};
