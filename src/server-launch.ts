// listen 门控（2026-11-08 审查 P1「启动副作用全量后置」）：
// 全部 server listen 成功才恰调一次 start()；任一台启动期监听失败走 onFatal
// （生产=非 0 快速退出——systemd Restart=on-failure 视 exit 0 为正常退出不
// 重拉，端口被占即永久停摆，绝不吃成 0）；listen 成功后的运行期 server 级
// error（accept EMFILE/ENFILE 等）在成功回调里摘除 fail-fast 监听、换挂
// onRuntimeError——启动期处理器若不摘，运行期错误会被吃成同一语义（日志谎
// 报「副作用尚未启动」+ systemd 不重拉）。抽成可测函数：
// index.ts 用真 server 调用，测试用假 server 断言门控与监听换挂。
//
// boot 合同：不得同步触发 onListening（node listen 回调恒异步）——门控在
// boot 返回后才拿到 server 引用，监听换挂发生在首个 onListening 内。
//
// 停机与信号接线：makeShutdown / wireSignals 同居本模块、exit 注入
// 可测——信号监听器首参是信号名，直挂 shutdown 会把信号名当退出码（详见
// wireSignals 头注）。

import type { Logger } from './platform/events/bus.ts';

/** 门控所需的最小 server 面：node http/https Server 与 @hono serve() 返回
 * 值的结构交集（测试用假对象即可，不必起真端口）。 */
export interface LaunchServer {
  on(event: 'error', listener: (err: Error) => void): unknown;
  off(event: 'error', listener: (err: Error) => void): unknown;
  close(cb?: () => void): void;
}

export interface ListenSpec {
  label: string;
  proto: 'http' | 'https';
  host: string;
  port: number;
  /** 创建 server、挂 onError、启动 listen；listening 事件经 hooks.onListening
   * 回门控（恒异步触发）。 */
  boot(hooks: { onListening: () => void; onError: (err: Error) => void }): LaunchServer;
}

export interface StartServersOpts {
  readonly log: Logger;
  /** 每台 listen 成功后的接线（生产=rt.attachWs + upgrade fallback；可空）。 */
  readonly onListening?: (server: LaunchServer) => void;
  /** 副作用启动点（生产=rt.start）——全部 listen 成功后恰调一次。 */
  readonly start: () => void;
  /** 启动期监听失败（生产=process.exit(1)）。 */
  readonly onFatal: (err: Error) => void;
  /** 运行期 server 级 error（生产=记日志 + 走停机、非 0 退出）。 */
  readonly onRuntimeError: (err: Error) => void;
}

export const startServers = (specs: readonly ListenSpec[], opts: StartServersOpts): LaunchServer[] => {
  const started: LaunchServer[] = [];
  let pending = specs.length;
  let fatal = false;
  const failFast = (err: Error): void => {
    fatal = true;
    opts.log.error(`[instance] server 监听失败：${err.message}——副作用尚未启动，非 0 退出`);
    opts.onFatal(err);
  };
  const onRuntimeError = (err: Error): void => {
    opts.log.error(`[instance] server 运行期错误：${err.message}——走停机、非 0 退出`);
    opts.onRuntimeError(err);
  };
  for (const spec of specs) {
    const holder: { server: LaunchServer | null } = { server: null };
    const onListening = (): void => {
      const server = holder.server;
      if (server === null || fatal) return; // boot 合同保证 server 已在；fatal 后不再计数
      // 启动期 fail-fast 摘除，换挂运行期处理——运行期 server 级
      // error（accept EMFILE/ENFILE 等）不被启动语义吃掉。
      server.off('error', failFast);
      server.on('error', onRuntimeError);
      opts.log.info(`juli-service 监听 ${spec.proto}://${spec.host}:${spec.port}（${spec.label}）`);
      opts.onListening?.(server);
      pending -= 1;
      if (pending === 0) opts.start();
    };
    const server = spec.boot({ onListening, onError: failFast });
    holder.server = server;
    started.push(server);
  }
  return started;
};

/** 停机依赖（exit 注入，测试不真退出进程）。 */
export interface ShutdownDeps {
  readonly log: Logger;
  /** 停副作用（生产=rt.stop）。 */
  readonly stop: () => void;
  /** 需收尽的 server（生产=startServers 的返回）。 */
  readonly servers: readonly LaunchServer[];
  /** 进程退出（生产=process.exit）。 */
  readonly exit: (code: number) => void;
  /** 收尽兜底时限，缺省 2000ms。 */
  readonly graceMs?: number;
}

/** 优雅停机。退出码参数必填 number：信号停机 0，运行期 server
 * 错误 1（systemd Restart=on-failure 依赖非 0 码重拉）——绝不可把返回的函数
 * 直挂成信号监听器（信号名会被当退出码，见 wireSignals）。
 *
 * 实例锁不在此提前释放：stop 只清定时器/停 mailSource，在途
 * advance 链（await provision/LLM/SMTP）与在途 HTTP 请求仍会写账；此刻手起
 * 的新实例可拿锁且 listen 成功（close() 已释放监听口）并跑 reconcileStartup，
 * 与旧进程尾写交错（账 failed 而信已发，重试即双发）。释放交 exit 钩子——
 * exit 时按内容释放（single-instance.ts），进程真正退出才松锁。
 * 等所有 server 收完再退——TLS 模式有两台，任一台 close 回调里直接 exit
 * 会把另一台的在途连接（keep-alive/SSE）拦腰掐断；收不尽时 graceMs 兜底。 */
export const makeShutdown = (deps: ShutdownDeps): ((exitCode: number) => void) => (exitCode) => {
  deps.log.info('收到退出信号，停机中…');
  deps.stop();
  void Promise.all(deps.servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
    .then(() => deps.exit(exitCode));
  setTimeout(() => deps.exit(exitCode), deps.graceMs ?? 2000).unref();
};

/** 信号源最小面（process 与 EventEmitter 皆满足）。 */
export interface SignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/** 信号接线：Node 以信号名为首参调用信号监听器（v22 内嵌源码
 * `wrap.onsignal = FunctionPrototypeBind(process.emit, process, type, type)`）
 * ——直挂 `process.on('SIGTERM', shutdown)` 即执行 `shutdown('SIGTERM')`，
 * `process.exit('SIGTERM')` 在给 exitCode 赋值时抛 ERR_INVALID_ARG_TYPE，每次
 * 优雅停机都以未捕获异常 exit 1 收场。@types/node 对这种误挂回落到
 * `(...args: any[]) => void` 兜底重载，tsc 照样放行——故一律包一层固定退出
 * 码 0 的监听器，不把信号名透传给 shutdown。 */
export const wireSignals = (source: SignalSource, shutdown: (exitCode: number) => void): void => {
  source.on('SIGINT', () => shutdown(0));
  source.on('SIGTERM', () => shutdown(0));
};
