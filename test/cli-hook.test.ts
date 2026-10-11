// cli hook 子命令契约（2026-10-10 统一 CLI 收编）：`juli hook <verb> <session>`
// 分派到 runHook——与 node dist/cli/hook.js 存量入口同一条逻辑（零分叉）。
// usage 面静默 exit 0：hook 契约「永不阻塞 agent」。cli/juli.ts 有直跑守卫，
// import 零副作用；子进程用例走真实 argv 接线（cmd==='hook' 分支可达）。
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchHook } from '../cli/juli.ts';
import { runHook } from '../src/cli/hook.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('juli hook 子命令 → runHook 分派（进程内，usage 面 exit 0）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    try { delete (process.stdin as { isTTY?: boolean }).isTTY; } catch { /* 无自有属性 */ }
  });

  const setUp = () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 防真网络：usage 路径本不触网，stub 兜底（mock exit 后控制流会继续走）。
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    // readStdin 视作手动调用（无 payload 不等待），防挂 2s stdin 计时。
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    return { exit, err };
  };

  it('dispatchHook 无参：usage 提示 + exit 0', async () => {
    const { exit, err } = setUp();
    await dispatchHook(['hook']);
    expect(String(err.mock.calls[0]?.[0] ?? '')).toContain('[juli-hook] usage:');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('runHook 有 verb 缺 session：usage 提示 + exit 0', async () => {
    const { exit, err } = setUp();
    await runHook(['notify']);
    expect(String(err.mock.calls[0]?.[0] ?? '')).toContain('[juli-hook] usage:');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('未知 verb：unknown verb 提示 + exit 0（不阻塞不报错退出码）', async () => {
    const { exit, err } = setUp();
    await dispatchHook(['hook', 'frobnicate', 'sess']);
    expect(String(err.mock.calls[0]?.[0] ?? '')).toContain('unknown verb frobnicate');
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('juli hook 真入口（tsx 直跑 cli/juli.ts，真实 argv 接线）', () => {
  const run = (args: string[]): { status: number | null; stderr: string } => {
    const r = spawnSync(process.execPath, [join(root, 'node_modules', '.bin', 'tsx'), join(root, 'cli', 'juli.ts'), ...args], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr };
  };

  it('juli hook（无参）：exit 0 + [juli-hook] usage（证 cmd=hook 分支真接线）', () => {
    const r = run(['hook']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('[juli-hook] usage:');
  });

  it('juli hook notify（缺 session）：exit 0 + usage', () => {
    const r = run(['hook', 'notify']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('[juli-hook] usage:');
  });
});
