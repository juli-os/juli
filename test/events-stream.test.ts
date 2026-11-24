// SSE 事件流轮询的容错（2026-11-23 全量审查修复）。/api/events/stream 的
// setInterval 回调里直接调 store.eventsSince，没有 try/catch：数据库一抛错
// 就是未捕获异常，引擎整个进程退出（没有全局兜底）。另外
// `void stream.writeSSE(...)` 的 rejection 也没人接，是未处理的 rejection。
// 修后：轮询出错记一行 console.error，然后关掉这条流——清掉定时器、结束内层
// Promise。客户端 EventSource 会自动重连，进程不退。
//
// 节拍用 fake timers 精确推进：只接管 setInterval / clearInterval（setTimeout
// 还是真的，读流的超时保护照常工作），「定时器被清掉」直接查 getTimerCount()。
// 未捕获异常 / 未处理的 rejection 自己挂监听记下来断言——vitest 遇到会让整个
// 文件红，但不会指到具体哪条用例。

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LedgerEvent, LifecycleStore } from '@juli-os/ledger';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime } from '../src/runtime.ts';
import { createHttpApp } from '../src/http/app.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'juli-events-stream-'));
const rt = createRuntime(configSchema.parse({
  data_dir: dataDir,
  // 死 socket（与 tenant-isolation 同理）：tmux 面恒空/恒失败，测试密闭不读宿主 tmux。
  agent_backend: 'tmux',
  tmux_socket_path: join(dataDir, 'tmux.sock'),
}));

type App = ReturnType<typeof createHttpApp>;
type Reader = ReadableStreamDefaultReader<Uint8Array>;

/** 换掉 eventsSince 的账本视图：其余方法照旧委托真账本。 */
const appWithEventsSince = (eventsSince: LifecycleStore['eventsSince']): App =>
  createHttpApp({ ...rt, store: { ...rt.store, eventsSince } });

/** 等条件成立（真 macrotask 轮询：setImmediate 没被 fake）。 */
const until = async (pred: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('等待超时：条件一直不成立');
    await new Promise<void>((r) => setImmediate(r));
  }
};

// 真 setTimeout 做超时保护（没被 fake）：流该结束却不结束时用例失败，不挂死。
const within = async <T>(p: Promise<T>): Promise<T | null> =>
  Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 3000))]);

const decode = (chunk: Uint8Array | undefined): string => new TextDecoder().decode(chunk);

describe('SSE 事件流：轮询出错不拖垮进程', () => {
  const uncaught: string[] = [];
  const onUncaught = (e: unknown): void => { uncaught.push(`uncaught: ${e instanceof Error ? e.message : String(e)}`); };
  const onRejected = (reason: unknown): void => { uncaught.push(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`); };
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    uncaught.length = 0;
    errors.mockClear();
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejected);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejected);
  });
  afterAll(() => {
    rt.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** 开流 → 等 hello 帧写出、轮询定时器挂上（恰好 1 个）。 */
  const open = async (app: App): Promise<Reader> => {
    const res = await app.request('/api/events/stream?since=0');
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await until(() => vi.getTimerCount() === 1);
    return reader;
  };
  const readFrame = async (reader: Reader): Promise<string> => {
    const chunk = await within(reader.read());
    if (chunk === null || chunk.done) throw new Error('读帧超时，或流提前结束');
    return decode(chunk.value);
  };
  /** 一直读到流结束；流不结束 = 超时失败。 */
  const drain = async (reader: Reader): Promise<void> => {
    for (;;) {
      const chunk = await within(reader.read());
      if (chunk === null) throw new Error('SSE 流没有结束：定时器没清掉，或内层 Promise 没结束');
      if (chunk.done) return;
    }
  };

  it('正常路径不变：事件照推；客户端断开后定时器清掉', async () => {
    const reader = await open(createHttpApp(rt));
    expect(await readFrame(reader)).toContain('event: hello');
    rt.store.appendEvent('workflow', 'wf-stream-probe', 'stream_probe');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await readFrame(reader)).toContain('event: stream_probe');
    expect(vi.getTimerCount()).toBe(1); // 流还开着，继续轮询
    await reader.cancel(); // 客户端断开 → onAbort → 清定时器、流收尾
    await until(() => vi.getTimerCount() === 0);
    expect(errors).not.toHaveBeenCalled();
    expect(uncaught).toEqual([]);
  });

  it('eventsSince 抛错：不冒泡；记一行 console.error；定时器清掉；流结束；不再轮询', async () => {
    const calls: number[] = [];
    const app = appWithEventsSince((afterId: number): readonly LedgerEvent[] => {
      calls.push(afterId);
      throw new Error('database is locked');
    });
    const reader = await open(app);
    expect(await readFrame(reader)).toContain('event: hello');

    await vi.advanceTimersByTimeAsync(1000); // 第一跳：eventsSince 抛错
    expect(vi.getTimerCount()).toBe(0); // 定时器被清
    await drain(reader); // 内层 Promise 结束 → 流收尾

    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(1); // 流关掉后不再轮询
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0])).toContain('database is locked');
    expect(uncaught).toEqual([]); // 没有未捕获异常，也没有未处理的 rejection
  });

  it('writeSSE 的 rejection 被接住：同样记日志、清定时器、关流，不留未处理的 rejection', async () => {
    // writeSSE 对含换行的 event 名抛错（hono 的帧校验）——账本里混进一条这样的
    // 事件类型就能触发。修前是 void 掉的 Promise，rejection 没人接。
    const dirty: LedgerEvent = {
      id: 1, entityType: 'agent', entityId: 'juli-stream', type: 'bad\ntype', payload: {}, ts: '2026-11-23T00:00:00.000Z',
    };
    const reader = await open(appWithEventsSince(() => [dirty]));

    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
    await drain(reader);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0])).toContain('must not contain');
    expect(uncaught).toEqual([]);
  });
});
