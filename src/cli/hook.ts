#!/usr/bin/env node
// CC hook 转发器（对应 Go 根 main.go 的 notify/permission/capture/claude-start）。
// 服务端形态用 HTTP 替代 Unix socket：转发到 juli-service 的
// /api/agents/{session}/stopped|heartbeat|activity。
//
// 契约（与 Go 版一致）：服务不在时静默退出 0，绝不阻塞 agent。
//
// 用法：node hook.js <notify|permission|claude-start|capture> <session> [status]
// 环境变量：JULI_SERVICE_URL（默认 http://127.0.0.1:7070）、JULI_PASSWORD。
//
// notify（Stop）：CC 把 hook payload（含 transcript_path）写进 stdin——
// 从 transcript 提取最后一条 assistant 消息随上报（PORTING#3 结构化输出），
// 服务端不再需要抓屏幕。读不到 transcript 时退化到无 output 上报。

import { extractFinalMessage, parseHookStdin, parseSkillUsedStdin } from '../platform/agents/transcript.ts';

const verb = process.argv[2] ?? '';
const session = process.argv[3] ?? '';
const extra = process.argv[4] ?? '';

const fail = (msg: string): never => {
  console.error(`[juli-hook] ${msg}`);
  process.exit(0); // 永不阻塞 agent
};

if (verb === '' || session === '') fail(`usage: hook.js <notify|permission|claude-start|capture> <session> [status]`);

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

const base = process.env['JULI_SERVICE_URL'] ?? 'http://127.0.0.1:7070';
const headers: Record<string, string> = { 'content-type': 'application/json' };
const password = process.env['JULI_PASSWORD'];
if (password) headers['authorization'] = `Bearer ${password}`;

const main = async (): Promise<void> => {
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
      const cp = parseHookStdin(await readStdin()) as { session_id?: string } | null;
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
  const timer = setTimeout(() => controller.abort(), 3000);
  fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .then(() => process.exit(0))
    .catch(() => process.exit(0)); // 服务不在 = 静默，绝不阻塞
};

void main();
