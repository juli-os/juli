// 静态托管契约：SPA 壳服务、资源解析、路径穿越拒绝，以及那条用事故换来
// 的铁律——未注册的 /api/* 绝不被 SPA 回退吞成 200 HTML（262fe94 同类）。

import { describe, expect, it, afterAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime } from '../src/runtime.ts';
import { createHttpApp } from '../src/http/app.ts';

const dir = mkdtempSync(join(tmpdir(), 'juli-web-'));
const rt = createRuntime(configSchema.parse({ data_dir: dir }), {});
const mkApp = () => createHttpApp(rt);

const SHELL_HTML = '<!doctype html><title>JULI-SHELL-MARKER</title>';

// 部署位护栏（b43 R1）：判据=目录级。web-dist 目录在场（live 部署位；其唯一合法
// 产出口 = webapp/scripts/swap-web-dist.sh 换装）⇒ 只读直用，绝不造假壳、绝不删
// 目录——测试套件自身不得成为部署位的写入/清除面；仅当目录整体缺席（CI 沙箱）
// 才自建假壳，收尾只清自建件。
const provisionShell = (shellDir: string): boolean => {
  if (existsSync(shellDir)) return false;
  mkdirSync(shellDir, { recursive: true });
  writeFileSync(join(shellDir, 'index.html'), SHELL_HTML);
  return true;
};

const shellDir = 'web-dist';
const selfMade = provisionShell(shellDir);

describe('静态托管 + SPA 回退', () => {
  it('部署位护栏：web-dist 目录在场 ⇒ 不造假壳不删目录、现场零写入（b43 R1）', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'juli-web-guard-'));
    try {
      const live = join(sandbox, 'web-dist');
      mkdirSync(live);
      writeFileSync(join(live, 'index.html'), '<!doctype html><title>LIVE-SHELL</title>');
      const before = readFileSync(join(live, 'index.html'), 'utf8');
      expect(provisionShell(live)).toBe(false);
      expect(readFileSync(join(live, 'index.html'), 'utf8')).toBe(before);
      expect(existsSync(live)).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('部署位护栏：目录缺席 ⇒ 仅自建假壳、收尾只清自建件（b43 R1）', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'juli-web-guard-'));
    try {
      const fresh = join(sandbox, 'web-dist');
      expect(provisionShell(fresh)).toBe(true);
      expect(readFileSync(join(fresh, 'index.html'), 'utf8')).toBe(SHELL_HTML);
      // afterAll 的清理判据与自建判定同源（selfMade）——沙箱内自演一遍收尾语义。
      expect(existsSync(fresh)).toBe(true);
      rmSync(fresh, { recursive: true, force: true });
      expect(existsSync(fresh)).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('壳一致性红路径钉子：换装窗口态真壳读取必 ENOENT 抛错（b43 R2-FX）', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'juli-shell-red-'));
    try {
      // 兜底态沙箱复刻：web-dist 目录在场但 index.html 缺席（换装 rm→cp 窗口），
      // 旧壳兜底位 web/dist 在场——resolveWebDist 此态命中候选 3（旧壳）。
      mkdirSync(join(sandbox, 'web-dist'));
      mkdirSync(join(sandbox, 'web', 'dist'), { recursive: true });
      writeFileSync(join(sandbox, 'web', 'dist', 'index.html'), '<title>OLD-FALLBACK</title>');
      // 上一用例断言式的真壳读取端：此态必 ENOENT 抛错 ⇒ 用例红，绝无静默通过；
      // 与 served 内容无关（右操作数先抛），「served 旧壳」与「纯 ENOENT」同一红。
      expect(() => readFileSync(join(sandbox, 'web-dist', 'index.html'), 'utf8')).toThrow(/ENOENT/);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('API-only / Web 壳两态自洽；/api 未注册路径绝不被壳吞（262fe94 铁律）', async () => {
    const app = mkApp();
    const root = await app.request('/');
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');

    // 壳内容一致性（b43 R2-FX）：served 壳正文必须与 web-dist/index.html 逐字相等。
    // live 态（真壳直用）与 CI 自建假壳态均绿；换装窗口态（web-dist 在场而真壳缺席，
    // resolveWebDist 静默兜底旧壳 web/dist）⇒ 真壳读取 ENOENT 抛错，本用例必红——
    // 「兜底在场时静默伪装健康」由此响亮化（R1-FX「响亮失败」承诺的收口）。
    expect(await root.text()).toBe(readFileSync(join(shellDir, 'index.html'), 'utf8'));

    // 深链（无扩展名）回退壳。
    const deep = await app.request('/lifecycle/anything');
    expect(deep.status).toBe(200);

    // 铁律：未注册 API 路径必须 404，绝不被壳吞掉。
    const apiMiss = await app.request('/api/nonexistent');
    expect(apiMiss.status).toBe(404);

    // 路径穿越拒绝。
    const evil = await app.request('/..%2F..%2Fpackage.json');
    expect(evil.status).toBe(404);
  });

  it('SSE 路由注册序铁律：/api/events/stream 命中 SSE 处理器而非壳吞/404（r1-P2-11）', async () => {
    const app = mkApp();
    const res = await app.request('/api/events/stream?since=0');
    // 流式响应只断言头部（content-type 即「命中 SSE 处理器」的判据），
    // 勿 await 全流；断言完 cancel 触发 onAbort → clearInterval 干净收尾。
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
    await res.body?.cancel();
  });

  afterAll(() => {
    if (selfMade) rmSync(shellDir, { recursive: true, force: true }); // 只清自建件
    rt.stop();
  });
});
