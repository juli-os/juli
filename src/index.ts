// 服务入口：加载配置 → 组合运行时 → 挂 HTTP(S) → 启动。systemd / docker /
// 本机前台皆可跑（服务端部署形态：无 Electron、无 GUI 依赖，API + SSE 即产品面）。
// TLS（iOS App 兼容）：tls.enabled 时主口服务 HTTPS（自签证书自动生成，
// App 端 TOFU 钉扎自签公钥），明文 HTTP 退到 plain_port（默认主口+1，LAN/Web 用）。

import { serve, getRequestListener } from '@hono/node-server';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from './platform/config/schema.ts';
import { createRuntime } from './runtime.ts';
import { createHttpApp } from './http/app.ts';
import { ensureSelfSignedCert } from './http/tlscert.ts';
import { attachUpgradeFallback } from './platform/ws/wirehubs.ts';
import { consoleLogger } from './platform/events/bus.ts';

const config = loadConfig({ env: process.env, home: homedir() });
const rt = createRuntime(config, {}, consoleLogger);
const app = createHttpApp(rt);

const tlsEnabled = config.tls_enabled;
const tlsPort = config.tls_port ?? config.listen_port + 1;
const requestListener = getRequestListener(app.fetch);
const servers: Array<{ close(cb?: () => void): void }> = [];

const onListen = (label: string, proto: string, port: number, server: { close(cb?: () => void): void }): void => {
  consoleLogger.info(`juli-service 监听 ${proto}://${config.listen_host}:${port}（${label}）`);
  const httpServer = server as import('node:http').Server;
  rt.attachWs(httpServer);
  // 兜底必须挂在 hub 的 upgrade 监听之后（attachWs 内部注册）——未被任何
  // hub 认领的 upgrade（如 /ws/unknown）直接销毁 socket，绝不悬挂泄漏。
  attachUpgradeFallback(httpServer);
};

if (tlsEnabled) {
  // 受信证书优先（mkcert：iPhone 已装 CA、SAN 含中转 IP——零重配迁移）；
  // 缺省回退自签（本机调试形态）。
  const trusted = config.tls_cert_path !== '' && config.tls_key_path !== ''
    && existsSync(config.tls_cert_path) && existsSync(config.tls_key_path)
    ? { cert: readFileSync(config.tls_cert_path), key: readFileSync(config.tls_key_path) }
    : null;
  const { cert, key } = trusted ?? ensureSelfSignedCert(config.data_dir, config.listen_host);
  const httpsServer = createHttpsServer({ cert, key }, (req, res) => { void requestListener(req, res); });
  httpsServer.listen(tlsPort, config.listen_host, () =>
    onListen('TLS（iOS 公网入口）', 'https', tlsPort, httpsServer));
  const plainServer = createHttpServer((req, res) => { void requestListener(req, res); });
  plainServer.listen(config.listen_port, config.listen_host, () =>
    onListen('API + Web 壳 + SSE + WS（LAN/Web）', 'http', config.listen_port, plainServer));
  servers.push(httpsServer, plainServer);
} else {
  const server = serve(
    { fetch: app.fetch, hostname: config.listen_host, port: config.listen_port },
    (info) => onListen('API + Web 壳 + SSE + WS', 'http', info.port, server),
  );
  servers.push(server);
}

const shutdown = (): void => {
  consoleLogger.info('收到退出信号，停机中…');
  rt.stop();
  for (const s of servers) s.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

rt.start();
