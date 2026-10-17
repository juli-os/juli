#!/usr/bin/env node
// CC hook 转发器（对应 Go 根 main.go 的 notify/permission/capture/claude-start）。
// 服务端形态用 HTTP 替代 Unix socket：转发到 juli-service 的
// /api/agents/{session}/stopped|heartbeat|activity。
//
// 契约（与 Go 版一致）：服务不在时静默退出 0，绝不阻塞 agent。
//
// 两条入口共享本文件（2026-10-10 统一 CLI 收编）：
//   1. node dist/cli/hook.js <verb> <session> [status]   —— 存量注册面（保留兼容）
//   2. juli hook <verb> <session> [status]                —— cli/juli.ts 子命令（dispatchHook）
// 逻辑收口在 runHook(argv)（argv = [verb, session, extra]）——两个入口零分叉。
// 环境变量：JULI_SERVICE_URL（默认 http://127.0.0.1:7070）、JULI_PASSWORD。
//
// notify（Stop）：CC 把 hook payload（含 transcript_path）写进 stdin——
// 从 transcript 提取最后一条 assistant 消息随上报（PORTING#3 结构化输出），
// 服务端不再需要抓屏幕。读不到 transcript 时退化到无 output 上报。

import { basename } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractFinalMessage, parseHookStdin, parseSkillUsedStdin } from '@juli-os/agents';

const fail = (msg: string): never => {
  console.error(`[juli-hook] ${msg}`);
  process.exit(0); // 永不阻塞 agent
};

const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) return ''; // 手动调用：无 payload，不等待
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), 2000); // 挂起 stdin 防阻塞
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
};

/** hook 转发主流程。argv 形态 [verb, session, extra?]——与两条入口的命令行
 * 一一对应；行为与原 dist/cli/hook.js 直跑形态完全一致（静默 exit 0 契约）。 */
export const runHook = async (argv: readonly string[]): Promise<void> => {
  const verb = argv[0] ?? '';
  const session = argv[1] ?? '';
  const extra = argv[2] ?? '';

  if (verb === '' || session === '') fail(`usage: hook <notify|permission|claude-start|capture|awaiting|skill-used> <session> [status]`);

  const base = process.env['JULI_SERVICE_URL'] ?? 'http://127.0.0.1:7070';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const password = process.env['JULI_PASSWORD'];
  if (password) headers['authorization'] = `Bearer ${password}`;

  let path = '';
  let body: Record<string, unknown> = {};
  switch (verb) {
    case 'notify': {
      const payload = parseHookStdin(await readStdin());
      body = { status: extra === '' ? 'done' : extra };
      if (payload?.transcript_path) {
        const msg = extractFinalMessage(payload.transcript_path);
        if (msg !== null) body['final_message'] = msg;
      }
      path = `/api/agents/${encodeURIComponent(session)}/stopped`;
      break;
    }
    case 'claude-start':
      path = `/api/agents/${encodeURIComponent(session)}/heartbeat`;
      body = {};
      break;
    case 'permission':
    case 'capture': {
      // 精确映射（wf_e8d6984ba09e 三断点）：CC 每回合 stdin 带 session_id
      // （=transcript 文件名）——顺带给引擎登记「该 claude 会话跑在本 tmux
      // 会话」，prompt_usage 归由此精确回填（目录扫描兜底只插不覆盖）。
      // 十四跑 R1（P2-5）：await + 3s 超时——此前 void fetch 会被 activity
      // 后的 process.exit(0) 截杀（精确登记竞态丢失）；鉴权走 Bearer header
      // （headers 与兄弟请求一致），token 不进 URL。失败/超时静默——hook
      // 整体绝不阻塞 agent。
      const cp = parseHookStdin(await readStdin());
      if (typeof cp?.session_id === 'string' && cp.session_id !== '') {
        const cs = new AbortController();
        const cst = setTimeout(() => cs.abort(), 3000);
        try {
          await fetch(`${base}/api/agents/${encodeURIComponent(session)}/claude-session`, {
            method: 'POST', headers,
            body: JSON.stringify({ claude_session_id: cp.session_id }),
            signal: cs.signal,
          });
        } catch { /* 服务不在/超时 = 静默 */ }
        clearTimeout(cst);
      }
      path = `/api/agents/${encodeURIComponent(session)}/activity`;
      body = { event: verb === 'permission' ? 'permission' : 'capture' };
      break;
    }
    case 'awaiting': {
      // CC Notification payload（stdin JSON）带 message——「需要权限/等输入」的
      // 人话原因，透传给引擎做通知正文。
      const payload = parseHookStdin(await readStdin()) as { message?: string } | null;
      body = { message: typeof payload?.message === 'string' ? payload.message : '' };
      path = `/api/agents/${encodeURIComponent(session)}/awaiting`;
      break;
    }
    case 'skill-used': {
      // PostToolUse(matcher ^skill__)：stdin 契约抽在 parseSkillUsedStdin
      // （transcript.ts，可单测）——非 skill__ 工具名/坏 stdin 返回 null =
      // 静默丢弃，hook 永不阻塞 agent；非 null 即上报负载原样转发。
      const parsed = parseSkillUsedStdin(await readStdin());
      if (parsed === null) process.exit(0);
      body = parsed;
      path = `/api/agents/${encodeURIComponent(session)}/skill-used`;
      break;
    }
    default:
      return fail(`unknown verb ${verb}`);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 3000);
  fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .then(() => process.exit(0))
    .catch(() => process.exit(0)); // 服务不在 = 静默，绝不阻塞
};

// 直跑守卫：仅 node dist/cli/hook.js（或 tsx 源码态 hook.ts）形态自跑主
// 流程；被 import（juli 子命令/测试）零副作用。文件名限定是 esbuild 单文件
// bundle 的防线：bundle 后本模块与 cli/juli.ts 同文件、共享 import.meta.url
// ——没有它，`node dist-cli/juli.js ...` 会在 import 期双跑 hook。
const entryBase = process.argv[1] !== undefined ? basename(process.argv[1]) : '';
const isStandaloneHookEntry = process.argv[1] !== undefined
  && (entryBase === 'hook.js' || entryBase === 'hook.ts')
  && (() => {
    // realpath 两侧比对（符号路径部署下 URL 字面比对永不相等）；异常路径
    // 回退 URL 字面比对。
    try {
      return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
      return pathToFileURL(process.argv[1]).href === import.meta.url;
    }
  })();
if (isStandaloneHookEntry) void runHook(process.argv.slice(2));
