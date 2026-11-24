// listen 门控真校验：全部 listen 成功才恰调一次 start()；任一
// 台启动期监听失败不调 start 且走 onFatal（生产=非 0 退出）；listen 成功后
// 的运行期 server 级 error 走 onRuntimeError 不走 onFatal（错误监听已换挂）。
// 全部用假 server（门控所需最小面），不起真端口。
// 停机与信号接线：按 Node 真实派发形态 emit(type, type)（监听器
// 首参=信号名）调监听器，断言 exit 恒收到数字 0；旧码直挂 shutdown 即
// exit('SIGTERM')，这些用例必红。

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  makeShutdown, startServers, wireSignals,
  type LaunchServer, type ListenSpec, type StartServersOpts,
} from '../src/server-launch.ts';

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** 假 server：记录 error 监听，可手动 emit；listen 回调经微任务异步触发
 *（门控的 boot 合同：listening 恒异步）。 */
const makeFakeServer = (opts: { fail?: boolean } = {}) => {
  const errorListeners = new Map<(_: Error) => void, true>();
  const server: LaunchServer & { emitError(err: Error): void } = {
    on(event, listener) {
      if (event === 'error') errorListeners.set(listener, true);
      return server;
    },
    off(event, listener) {
      if (event === 'error') errorListeners.delete(listener);
      return server;
    },
    close(_cb) { /* 假件不收连接 */ },
    emitError(err: Error) {
      for (const l of [...errorListeners.keys()]) l(err);
    },
  };
  return {
    server,
    spec: {
      label: '假件', proto: 'http' as const, host: '127.0.0.1', port: 0,
      boot({ onListening, onError }: { onListening: () => void; onError: (err: Error) => void }): LaunchServer {
        server.on('error', onError);
        if (opts.fail === true) {
          onError(new Error('listen EADDRINUSE: 端口已被占用'));
          return server;
        }
        queueMicrotask(onListening);
        return server;
      },
    } satisfies ListenSpec,
  };
};

const makeOpts = (over: Partial<StartServersOpts> = {}): StartServersOpts => ({
  log: silentLog,
  start: vi.fn(),
  onFatal: vi.fn(),
  onRuntimeError: vi.fn(),
  ...over,
});

describe('listen 门控（副作用全量后置）', () => {
  it('全部 listen 成功 → start 恰调一次，接线每台各一次', async () => {
    const a = makeFakeServer();
    const b = makeFakeServer();
    const onListening = vi.fn();
    const opts = makeOpts({ onListening });
    startServers([a.spec, b.spec], opts);
    await new Promise((r) => setTimeout(r, 0)); // 微任务排空 listening 回调
    expect(opts.start).toHaveBeenCalledTimes(1);
    expect(opts.onFatal).not.toHaveBeenCalled();
    expect(onListening).toHaveBeenCalledTimes(2);
  });

  it('任一台启动期监听失败 → 不调 start、onFatal 恰一次，他台迟到成功也不触发', async () => {
    const bad = makeFakeServer({ fail: true });
    const good = makeFakeServer();
    const opts = makeOpts();
    startServers([bad.spec, good.spec], opts);
    await new Promise((r) => setTimeout(r, 0));
    expect(opts.start).not.toHaveBeenCalled(); // 副作用零启动
    expect(opts.onFatal).toHaveBeenCalledTimes(1);
  });

  it('listen 成功后运行期 server 级 error → 走 onRuntimeError，不再走启动期 onFatal（错误监听已换挂）', async () => {
    const only = makeFakeServer();
    const opts = makeOpts();
    startServers([only.spec], opts);
    await new Promise((r) => setTimeout(r, 0));
    expect(opts.start).toHaveBeenCalledTimes(1);
    // 运行期错误（accept EMFILE/ENFILE 同类）：启动期监听已被摘除。
    only.server.emitError(new Error('accept EMFILE'));
    expect(opts.onRuntimeError).toHaveBeenCalledTimes(1);
    expect(opts.onFatal).not.toHaveBeenCalled();
    // start 也不因运行期错误二次触发（门控只认启动期计数）。
    expect(opts.start).toHaveBeenCalledTimes(1);
  });
});

describe('优雅停机与信号接线', () => {
  /** 收尽回调立即触发的假 server。 */
  const closingServer = (): LaunchServer => ({ on: () => undefined, off: () => undefined, close: (cb) => { cb?.(); } });
  /** 永不回调 close 的假 server（在途长连接收不尽）。 */
  const hangingServer = (): LaunchServer => ({ on: () => undefined, off: () => undefined, close: () => { /* 永不回调 */ } });

  it('信号监听器以信号名为首参被调用 → shutdown 恒收到数字 0（不透传信号名）', () => {
    const source = new EventEmitter();
    const shutdown = vi.fn();
    wireSignals(source, shutdown);
    // Node 派发信号的真实形态：process.emit(type, type)——监听器首参是信号名。
    source.emit('SIGTERM', 'SIGTERM');
    source.emit('SIGINT', 'SIGINT');
    expect(shutdown.mock.calls).toEqual([[0], [0]]);
  });

  it("端到端：emit('SIGTERM','SIGTERM') → stop 一次、server 收尽后 exit(0)", async () => {
    const source = new EventEmitter();
    const exit = vi.fn();
    const stop = vi.fn();
    wireSignals(source, makeShutdown({
      log: silentLog, stop, servers: [closingServer(), closingServer()], exit, graceMs: 60_000,
    }));
    source.emit('SIGTERM', 'SIGTERM');
    await new Promise((r) => setTimeout(r, 0));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls).toEqual([[0]]); // 旧码：[['SIGTERM']]——process.exit 抛 ERR_INVALID_ARG_TYPE
  });

  it("端到端：server 收不尽 → graceMs 兜底同样 exit(0)（emit('SIGINT','SIGINT')）", async () => {
    const source = new EventEmitter();
    const exit = vi.fn();
    wireSignals(source, makeShutdown({
      log: silentLog, stop: () => undefined, servers: [hangingServer()], exit, graceMs: 5,
    }));
    source.emit('SIGINT', 'SIGINT');
    await new Promise((r) => setTimeout(r, 30));
    expect(exit.mock.calls).toEqual([[0]]);
  });

  it('运行期错误路径显式 shutdown(1) → exit(1)（非 0 码供 systemd 重拉）', async () => {
    const exit = vi.fn();
    const shutdown = makeShutdown({
      log: silentLog, stop: () => undefined, servers: [closingServer()], exit, graceMs: 60_000,
    });
    shutdown(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(exit.mock.calls).toEqual([[1]]);
  });
});
