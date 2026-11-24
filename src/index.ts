// 服务入口：加载配置 → 单实例锁 → 组合运行时 → 挂 HTTP(S) → listen 全成功才
// 启动副作用（rt.start）；listen 失败/运行期 server 错误均非 0 退出（systemd
// Restart=on-failure 依赖），仅「锁被活实例持有」的拒启保留 exit(0)。
// systemd / docker /
// 本机前台皆可跑（服务端部署形态：无 Electron、无 GUI 依赖，API + SSE 即产品面）。
// TLS（iOS App 兼容）：tls.enabled 时额外开 tls_port 服务 HTTPS（缺省
// listen_port+1；受信证书优先，否则自签生成，App 端 TOFU 钉扎公钥），
// listen_port 恒为明文（LAN/Web 用），公网入口指向 tls_port。

import { serve, getRequestListener } from '@hono/node-server';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from './platform/config/schema.ts';
import { acquireInstanceLock, inspectInstanceLock } from './single-instance.ts';
import { createRuntime } from './runtime.ts';
import { createHttpApp } from './http/app.ts';
import { ensureSelfSignedCert } from './http/tlscert.ts';
import { attachUpgradeFallback } from './platform/ws/wirehubs.ts';
import { consoleLogger } from './platform/events/bus.ts';
import { makeShutdown, startServers, wireSignals, type LaunchServer, type ListenSpec } from './server-launch.ts';

const config = loadConfig({ env: process.env, home: homedir() });
// 单实例保证（2026-11-08 审查 P1）：任何账本副作用（createRuntime 装配）
// 之前确立 data_dir 独占——重复实例在 EADDRINUSE 崩溃前曾对共享账本跑完
// 一轮重启对账，是 11-06 两次事故步被杀的实证机制。拿不到锁即退。
// 拒启日志打出锁路径与持有方 pid/startedAt——人工处置不再盲找。
// 此处保留 exit(0)（启动期唯一以 0 退出的出口；listen 失败、运行期错误都
// 非 0）：「已有存活实例」是正常拒启而非故障——launchd KeepAlive=true 不看
// 退出码照拉；systemd Restart=on-failure 不拉也不该拉（在位实例才是正确形态）。
if (acquireInstanceLock(config.data_dir, consoleLogger) === null) {
  const holder = inspectInstanceLock(config.data_dir);
  const holderDesc = holder === null
    ? ''
    : `，持有方 pid=${holder.pid}${holder.startedAt !== '' ? `，startedAt=${holder.startedAt}` : ''}`;
  consoleLogger.error(`[instance] data_dir 已有存活实例（${config.data_dir}${holderDesc}）——本进程退出`);
  process.exit(0);
}
const rt = createRuntime(config, {}, consoleLogger);
const app = createHttpApp(rt);

const tlsEnabled = config.tls_enabled;
const tlsPort = config.tls_port ?? config.listen_port + 1;
const requestListener = getRequestListener(app.fetch);

const bootTlsServer: ListenSpec['boot'] = ({ onListening, onError }) => {
  // 受信证书优先（mkcert：iPhone 已装 CA、SAN 含中转 IP——零重配迁移）；
  // 缺省回退自签（本机调试形态）。
  const trusted = config.tls_cert_path !== '' && config.tls_key_path !== ''
    && existsSync(config.tls_cert_path) && existsSync(config.tls_key_path)
    ? { cert: readFileSync(config.tls_cert_path), key: readFileSync(config.tls_key_path) }
    : null;
  const { cert, key } = trusted ?? ensureSelfSignedCert(config.data_dir, config.listen_host);
  const httpsServer = createHttpsServer({ cert, key }, (req, res) => { void requestListener(req, res); });
  httpsServer.on('error', onError);
  httpsServer.listen(tlsPort, config.listen_host, onListening);
  return httpsServer;
};

// 启动副作用全量后置（2026-11-08 审查 P1）：全部 server listen 成功才
// rt.start()（内含 engine.boot 启动救援 / reconcileStartup / CC hooks 改写 /
// 「已启动」日志）；任一台 listen 失败先于一切副作用退出。
// listen 失败非 0 退出（systemd Restart=on-failure 依赖非 0 码重拉——
// 端口被任一进程占用时 exit 0 = 服务永久停摆，改前未捕获异常 exit 1 反而
// 3s 自愈）；launchd KeepAlive=true / docker restart: unless-stopped 不看退出
// 码，不受影响。运行期 server 级 error（accept EMFILE/ENFILE 等）在门控内
// 已换挂 onRuntimeError（记日志 + 走停机、非 0 退出），不再被启动语义吃掉。
const servers: LaunchServer[] = startServers(
  tlsEnabled
    ? [
      {
        label: 'TLS（iOS 公网入口）', proto: 'https', host: config.listen_host, port: tlsPort,
        boot: bootTlsServer,
      },
      {
        label: 'API + Web 壳 + SSE + WS（LAN/Web）', proto: 'http', host: config.listen_host, port: config.listen_port,
        boot: ({ onListening, onError }) => {
          const plainServer = createHttpServer((req, res) => { void requestListener(req, res); });
          plainServer.on('error', onError);
          plainServer.listen(config.listen_port, config.listen_host, onListening);
          return plainServer;
        },
      },
    ]
    : [
      {
        label: 'API + Web 壳 + SSE + WS', proto: 'http', host: config.listen_host, port: config.listen_port,
        boot: ({ onListening, onError }) => {
          // serve() 自行 listen——listening 回调经 onListening 回门控计数。
          const server = serve(
            { fetch: app.fetch, hostname: config.listen_host, port: config.listen_port },
            () => onListening(),
          );
          const httpServer = server as import('node:http').Server;
          httpServer.on('error', onError);
          return httpServer;
        },
      },
    ],
  {
    log: consoleLogger,
    onListening: (server) => {
      const httpServer = server as import('node:http').Server;
      rt.attachWs(httpServer);
      // 兜底必须挂在 hub 的 upgrade 监听之后（attachWs 内部注册）——未被任何
      // hub 认领的 upgrade（如 /ws/unknown）直接销毁 socket，绝不悬挂泄漏。
      attachUpgradeFallback(httpServer);
    },
    start: () => rt.start(),
    onFatal: () => process.exit(1),
    onRuntimeError: (err) => {
      consoleLogger.error(`[instance] 运行期 server 错误进入停机：${err.message}`);
      shutdown(1);
    },
  },
);

// 优雅停机（锁不在停机途中提前释放，交 exit 钩子；停机逻辑抽进 server-launch.ts 便于测试）：
// 退出码由调用方给——信号停机 0、运行期 server 错误 1。信号接线必须经
// wireSignals：Node 以信号名为首参调用监听器，直挂 shutdown 会把信号名当
// 退出码，每次优雅停机都以未捕获异常 exit 1 收场。
const shutdown = makeShutdown({
  log: consoleLogger,
  stop: () => rt.stop(),
  servers,
  exit: (code) => process.exit(code),
});
wireSignals(process, shutdown);
// rt.start 不在此直调：由 startServers 在全部 server listen 成功后触发。
