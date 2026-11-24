// workflow 域定时器全链（b56-R1 P1-1 测试缺口）：ledger_retention_days 热改后
// prune 行为跟着变。此前 settings.test 只断言 applied 回报，装配断线（prune
// tick 域内快照）重启才生效这类断裂测不出来——本文件用 fake timers 驱动
// 24h prune tick，真 runtime + 真账本，断言「热改前不修剪 / 热改后按新值修剪」。
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@juli-os/basin';
import type { TmuxClient } from '@juli-os/agents';
import type { LifecycleStore } from '@juli-os/ledger';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime } from '../src/runtime.ts';
import type { Logger } from '../src/platform/events/bus.ts';
import { startWorkflowTimers } from '../src/business/workflow/timers.ts';
import type { Engine } from '../src/business/workflow/engine.ts';
import { ok } from '../src/platform/shared/result.ts';

const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** env 清场（与 settings.test 同理）：数据卷定位双认键不吃开发者本机 env。
 * 返回恢复函数。 */
const withoutDataDirEnv = (): (() => void) => {
  const saved = [process.env['JULI_DATA_DIR'], process.env['MAKRO_DATA_DIR']];
  delete process.env['JULI_DATA_DIR'];
  delete process.env['MAKRO_DATA_DIR'];
  return () => {
    saved.forEach((v, i) => {
      const k = i === 0 ? 'JULI_DATA_DIR' : 'MAKRO_DATA_DIR';
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  };
};

/** tmux 后端的最小假终端：会话名单里只有 agent-a，其余都是空操作。配
 * agent_backend='tmux' 注入 runtime，整条用例不碰真的 tmux / herdr。 */
const fakeTerminal = (): TmuxClient => ({
  foregroundCommandOf: async () => 'claude',
  panePathOf: async () => '/w',
  sessionBirthsOf: async () => new Map(),
  hasSession: async () => true,
  listSessions: async () => ['agent-a'],
  listSessionsDetailed: async () => ok([]),
  newSession: async () => ok(undefined),
  killSession: async () => ok(undefined),
  interrupt: async () => ok(undefined),
  capturePane: async () => ok(''),
  sendKey: async () => ok(undefined),
  sendText: async () => ok(undefined),
  sendTextConfirmed: async () => ok({ enters: 1, repasted: false, elapsedMs: 0 }),
  sendTextQueued: async () => ok({ enters: 1, repasted: false, elapsedMs: 0, finalState: 'cleared' }),
  setEnv: async () => ok(undefined),
}) as unknown as TmuxClient;

describe('workflow 定时器：ledger_retention_days 热改 → prune 行为跟着变', () => {
  it('缺省 retention=0：24h tick 不动数据；热改为 30 后：超龄事件被删、新事件保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-wf-timers-'));
    // env 清场（与 settings.test 同理）：数据卷定位双认键不吃开发者本机 env。
    const restoreEnv = withoutDataDirEnv();
    let rt: ReturnType<typeof createRuntime> | null = null;
    const eventsDb = openDatabase(join(dir, 'lifecycle.db'));
    const countOf = (entityId: string): number => Number((eventsDb.prepare(
      'SELECT COUNT(*) AS n FROM events WHERE entity_id=?',
    ).get(entityId) as { n: number })['n']);
    vi.useFakeTimers();
    try {
      rt = createRuntime(configSchema.parse({
        data_dir: dir,
        password: 'pw-wf-timers',
        claude_dir: join(dir, 'claude'), // 不指向真 ~/.claude——CC hooks 注入路径缺席即跳过
        // 终端后端钉 tmux，并换成假终端（2026-11-24）：缺省是 herdr，start() 之后
        // 后台会去连 herdr 服务。CI 机器上没有 herdr，启动失败的错误没人接住，
        // 整套测试被判失败（#35 第三次 CI）。这条用例测的是保留天数热改，和
        // 终端后端无关。下面那个用例早就这么写了，这里漏了。
        agent_backend: 'tmux',
      }), { tmux: fakeTerminal() }, noopLogger);
      rt.start(); // 真 workflowTimers 句柄在位（prune tick 24h，fake 驱动）

      // 种一老一新事件：老的改 ts 到 2020（远超任何保留期），新的≈当下。
      const oldId = rt.store.appendEvent('workflow', 'wf-prune-old', 'test').id;
      rt.store.appendEvent('workflow', 'wf-prune-new', 'test');
      eventsDb.prepare(`UPDATE events SET ts='2020-01-01T00:00:00.000Z' WHERE id=?`).run(oldId);
      eventsDb.prepare(`UPDATE events SET ts='2020-01-01T00:00:00.000Z' WHERE id=?`).run(oldId);
      expect(countOf('wf-prune-old')).toBe(1);
      expect(countOf('wf-prune-new')).toBe(1);

      // 缺省 retention=0（schema 缺省 = 不修剪）：一轮 24h tick 过去，数据原样。
      vi.advanceTimersByTime(86_400_000 + 1);
      expect(countOf('wf-prune-old')).toBe(1);
      expect(countOf('wf-prune-new')).toBe(1);

      // 热改 retention=30：不重启，下一轮 24h tick 即按新值修剪——
      // 2020 年事件超龄必删；新事件（≈当下）远未到期必留。
      expect(rt.applySettings({ ledger_retention_days: 30 }).applied).toContain('ledger_retention_days');
      vi.advanceTimersByTime(86_400_000);
      expect(countOf('wf-prune-old')).toBe(0);
      expect(countOf('wf-prune-new')).toBe(1);
    } finally {
      eventsDb.close();
      rt?.stop();
      vi.useRealTimers();
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('workflow 定时器：hold 放行心跳（2026-11-23 全量审查）', () => {
  // 4a654bc（2026-10-07）加自动批准巡检时顺手删掉了 `setInterval(holdSweep, 60s)`，
  // 此后 src/ 里没人定时调它——贵时段压着的单窗口关了也没人放行。
  it('贵时段压着的单，窗口关后不用人手动调 holdSweep——60 秒心跳自己把它放出去', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-wf-hold-'));
    const restoreEnv = withoutDataDirEnv();
    const dispatched: { session: string; text: string }[] = [];
    let rt: ReturnType<typeof createRuntime> | null = null;
    vi.useFakeTimers();
    try {
      // 起点 2026-09-07T08:00Z = 北京 16:00，在窗口（14:00–17:00）之内。
      vi.setSystemTime(new Date('2026-09-07T08:00:00Z'));
      rt = createRuntime(configSchema.parse({
        data_dir: dir,
        password: 'pw-wf-hold',
        claude_dir: join(dir, 'claude'),
        agent_backend: 'tmux', // 配下面的假终端；缺省的 herdr 会去连真的 herdr
        work_hours: { mode: 'on', start: '14:00', end: '17:00', timezone: 'Asia/Shanghai', scope: 'all', aggregate_throttle_min: 120 },
      }), {
        home: join(dir, 'home'),
        tmux: fakeTerminal(),
        dispatch: {
          async dispatch(_source, session, text) {
            dispatched.push({ session, text });
            return ok(undefined);
          },
        },
      }, noopLogger);
      rt.start();
      const wf = await rt.engine.startTask('压在贵时段的单', { brief: '窗口关了再派', session: 'agent-a' });
      expect(rt.store.getWorkflow(wf.id)!.status).toBe('queued'); // 被窗口压住，还没派
      expect(rt.engine.queueStatus().held).toContain(wf.id);
      expect(dispatched).toHaveLength(0);

      vi.setSystemTime(new Date('2026-09-07T09:00:00Z')); // 17:00 北京，窗口关了
      // 这里不手动调 holdSweep，只让定时器走一轮。
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(1);
      expect(dispatched).toHaveLength(1);
      expect(rt.store.getWorkflow(wf.id)!.status).toBe('running');
    } finally {
      rt?.stop();
      vi.useRealTimers();
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('workflow 定时器：巡检出错要留日志（2026-11-23 全量审查）', () => {
  it('引擎方法 reject（holdSweep 同步抛错）→ log.error 带上巡检名和错误信息；没有未捕获异常', async () => {
    const errors: string[] = [];
    const boom = new Error('账本被锁');
    const failing = (): never => { throw boom; };
    // 假引擎：五条巡检全部 reject，holdSweep 同步抛错——每一条出错都该留一行日志。
    const engine = {
      reconcileInflight: async () => failing(),
      sweepSchedules: async () => failing(),
      sweepRelays: async () => failing(),
      autoSettleApprovedRuns: async () => failing(),
      sweepZombies: async () => failing(),
      holdSweep: (): void => failing(),
    } as unknown as Engine;
    const unhandled: unknown[] = [];
    const uncaught: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    const onUncaught = (e: unknown): void => { uncaught.push(e); };
    process.on('unhandledRejection', onUnhandled);
    process.on('uncaughtException', onUncaught);
    vi.useFakeTimers();
    let timers: readonly NodeJS.Timeout[] = [];
    try {
      timers = startWorkflowTimers({
        engine,
        store: {} as LifecycleStore, // prune 是 24h 才跑，这一轮碰不到账本
        retentionDays: () => 0,
        log: { ...noopLogger, error: (m) => { errors.push(m); } },
      }).timers;
      await vi.advanceTimersByTimeAsync(60_000);
      for (const name of ['reconcileInflight', 'sweepSchedules', 'sweepRelays', 'autoSettleApprovedRuns', 'sweepZombies', 'holdSweep']) {
        expect(errors.some((m) => m.includes(name) && m.includes('账本被锁')), `巡检 ${name} 出错没有留日志`).toBe(true);
      }
      expect(unhandled).toEqual([]);
      expect(uncaught).toEqual([]);
    } finally {
      for (const t of timers) clearInterval(t);
      process.off('unhandledRejection', onUnhandled);
      process.off('uncaughtException', onUncaught);
      vi.useRealTimers();
    }
  });
});
