// cli/juli.ts 的参数解析（2026-11-23 全量审查修复）。cli/juli.ts 有直跑守卫，
// 被 import 时不执行主流程，纯函数可以在这里直接调。
//
// 此前 positional() 只去掉以 -- 开头的词，没去掉「选项的值」：
//   · `juli start --title 修一下登录`：标题被当成第一个位置参数（模板名），
//     程序去查模板、报「未知模板」——而帮助里写的用法恰恰是这一条；
//   · `juli session:send <name> 请跑 --verbose 模式`：正文里以 -- 开头的词
//     被丢掉，发出去的是「请跑 模式」。

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendKindOf, parsePositionals } from '../cli/juli.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('parsePositionals：argv → 位置参数列表', () => {
  const START = { value: ['title', 'input', 'relates-to', 'relatesTo', 'steps'] };

  it('带值的选项连同它的值一起跳过（修复前：--title 的值被当成模板名）', () => {
    expect(parsePositionals(['--title', '修一下登录'], START)).toEqual([]);
    expect(parsePositionals(['--title', '修一下登录', '--input', '{"a":1}'], START)).toEqual([]);
  });

  it('模板名仍是第一个位置参数，选项排在它前面或后面都一样', () => {
    expect(parsePositionals(['email-reply', '--input', '{"a":1}'], START)).toEqual(['email-reply']);
    expect(parsePositionals(['email-reply', '--title', '带 空格', '--input', '{"a":1}', '--steps', 'a,b'], START))
      .toEqual(['email-reply']);
    expect(parsePositionals(['--input', '{"a":1}', 'email-reply'], START)).toEqual(['email-reply']);
  });

  it('值本身以 -- 开头也照样算选项的值', () => {
    // arg('text') 取的就是下一个词，位置参数这边必须和它同一个口径。
    expect(parsePositionals(['wf_1', '--text', '--force 这样写'], { value: ['text'] })).toEqual(['wf_1']);
  });

  it('不带值的开关只跳过它自己，不吞下一个词', () => {
    const spec = { value: ['queue', 'status'], flags: ['json', 'sample', 'no-jev'] };
    expect(parsePositionals(['--json', 'fb_7', '--sample'], spec)).toEqual(['fb_7']);
    expect(parsePositionals(['--queue', '10', 'fb_7'], spec)).toEqual(['fb_7']);
  });

  it('没登记的选项：缺省丢弃（旧行为不变）；keepUnknown 时当正文保留', () => {
    expect(parsePositionals(['--nope', 'x'], {})).toEqual(['x']);
    expect(parsePositionals(['--nope', 'x'], { keepUnknown: true })).toEqual(['--nope', 'x']);
  });

  it('session:send 的正文原样：以 -- 开头的词一个不丢（包括别的命令认识的选项名）', () => {
    // 本命令没有选项可认：名字后面的一切都是要发的文本。
    const spec = { keepUnknown: true };
    expect(parsePositionals(['main', '请跑', '--verbose', '模式'], spec)).toEqual(['main', '请跑', '--verbose', '模式']);
    expect(parsePositionals(['main', '请用', '--text', '参数'], spec)).toEqual(['main', '请用', '--text', '参数']);
    expect(parsePositionals(['main', '你好，请回复 ok'], spec)).toEqual(['main', '你好，请回复 ok']);
  });

  it('带值选项是最后一个词：只跳过它自己，不越界', () => {
    expect(parsePositionals(['wf_1', '--note'], { value: ['note'] })).toEqual(['wf_1']);
  });
});

describe('backendKindOf：config 没写 agent_backend 时与引擎缺省一致', () => {
  it('没写 → herdr（schema 的 default；juli setup 不写这个键）', () => {
    expect(backendKindOf({})).toBe('herdr');
    expect(backendKindOf({ agent_backend: undefined })).toBe('herdr');
  });

  it('明确写了才认：tmux 用 tmux，herdr 用 herdr', () => {
    expect(backendKindOf({ agent_backend: 'tmux' })).toBe('tmux');
    expect(backendKindOf({ agent_backend: 'herdr' })).toBe('herdr');
  });

  it('写了名单外的值：按引擎缺省方向落 herdr（引擎侧 zod 会直接拒启，命令行不替它猜 tmux）', () => {
    expect(backendKindOf({ agent_backend: 'screen' })).toBe('herdr');
  });
});

// ---- 真入口接线：tsx 直跑 cli/juli.ts，打本地假引擎 -----------------------------

describe('juli start 真入口（tsx 直跑，本地假引擎）', () => {
  interface Req {
    readonly method: string;
    readonly url: string;
    readonly body: string;
  }
  let port = 0;
  let requests: Req[] = [];
  let close: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
      req.on('end', () => {
        requests.push({ method: req.method ?? '', url: req.url ?? '', body });
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify(req.url === '/api/pipelines'
          ? { templates: [{ key: 'email-reply', name: '邮件答复' }] }
          : { workflow: { id: 'wf_cli_test' } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
    close = () => new Promise<void>((r) => { server.close(() => r()); });
  });
  afterAll(async () => { await close(); });

  const run = (args: readonly string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, 'node_modules', '.bin', 'tsx'), join(root, 'cli', 'juli.ts'), ...args], {
        // JULI_PASSWORD 给定值：命令行就不会去读 ~/.juli-service/config.json 取密码。
        env: { ...process.env, JULI_SERVICE_URL: `http://127.0.0.1:${port}`, JULI_PASSWORD: 'cli-args-test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
      const timer = setTimeout(() => child.kill(), 30_000);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });

  it('juli start --title 修一下登录：走免模板起单，标题就是这四个字（修复前：报「未知模板」）', async () => {
    requests = [];
    const r = await run(['start', '--title', '修一下登录']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('已起单: wf_cli_test');
    // 没去查模板表，直接建任务单，标题原样。
    expect(requests.map((x) => `${x.method} ${x.url}`)).toEqual(['POST /api/lifecycle/tasks']);
    expect(JSON.parse(requests[0]!.body)).toEqual({ title: '修一下登录', input: {} });
  });

  it('juli start <模板名> --input ...：模板名仍是第一个位置参数（配方起流不受影响）', async () => {
    requests = [];
    const r = await run(['start', 'email-reply', '--input', '{"a":1}']);
    expect(r.status).toBe(0);
    expect(requests.map((x) => `${x.method} ${x.url}`)).toEqual(['GET /api/pipelines', 'POST /api/pipelines/start']);
    expect(JSON.parse(requests[1]!.body)).toEqual({ template: 'email-reply', title: '', input: { a: 1 } });
  });
});
