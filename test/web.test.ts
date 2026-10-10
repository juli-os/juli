// 静态托管契约：SPA 壳服务、资源解析、路径穿越拒绝，以及那条用事故换来
// 的铁律——未注册的 /api/* 绝不被 SPA 回退吞成 200 HTML（262fe94 同类）。

import { describe, expect, it, afterAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime } from '../src/runtime.ts';
import { createHttpApp } from '../src/http/app.ts';

const dir = mkdtempSync(join(tmpdir(), 'juli-web-'));
const rt = createRuntime(configSchema.parse({ data_dir: dir }), {});
const mkApp = () => createHttpApp(rt);

describe('静态托管 + SPA 回退', () => {
  // 预构建存在（npm run web 已跑）→ 直接用真壳；缺席 → 造假壳并在收尾清理。
  const preBuilt = existsSync('web-dist/index.html');
  if (!preBuilt) {
    mkdirSync('web-dist', { recursive: true });
    writeFileSync('web-dist/index.html', '<!doctype html><title>JULI-SHELL-MARKER</title>');
  }

  it('API-only / Web 壳两态自洽；/api 未注册路径绝不被壳吞（262fe94 铁律）', async () => {
    const app = mkApp();
    const root = await app.request('/');
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');

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
    if (!preBuilt) rmSync('web-dist', { recursive: true, force: true });
    rt.stop();
  });
});
