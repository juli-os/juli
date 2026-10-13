// cli hook 子命令契约（2026-10-10 统一 CLI 收编）：`juli hook <verb> <session>`
// 分派到 runHook——与 node dist/cli/hook.js 存量入口同一条逻辑（零分叉）。
// usage 面静默 exit 0：hook 契约「永不阻塞 agent」。cli/juli.ts 有直跑守卫，
// import 零副作用；子进程用例走真实 argv 接线（cmd==='hook' 分支可达）。
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchHook, HOOK_VERBS } from '../cli/juli.ts';
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

  it('裸 verb 直通（defaultHookSpecs 模板形态 node <bin> notify）：exit 0 + usage——bin 是 hook.js 的 drop-in 替身', () => {
    const r = run(['notify']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('[juli-hook] usage:');
  });
});

describe('isStandaloneHookEntry 的 basename 限定（esbuild bundle 双跑防线，隐式不变量钉死）', () => {
  const hookSrc = join(root, 'src', 'cli', 'hook.ts');
  const runFile = (file: string, args: string[]): { status: number | null; stderr: string } => {
    const r = spawnSync(process.execPath, [join(root, 'node_modules', '.bin', 'tsx'), file, ...args], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr };
  };

  it('正例：hook.ts 直跑（argv[1] basename=hook.ts 且 realpath 同源）→ 自跑 hook 主流程（usage 可见）', () => {
    const r = runFile(hookSrc, ['notify']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('[juli-hook] usage:');
  });

  it('反例：同内容异名入口（realpath 同源但 basename≠hook.*，=bundle 后与 juli.js 同文件的形态）→ 不自跑', () => {
    const dir = mkdtempSync(join(root, '.hook-guard-tmp-'));
    try {
      const renamed = join(dir, 'juli-bundle-sim.ts');
      writeFileSync(renamed, readFileSync(hookSrc, 'utf8'));
      const r = runFile(renamed, ['notify']);
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('[juli-hook] usage:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('HOOK_VERBS × juli 子命令表不相交（新增子命令撞名即静默阴影的守卫）', () => {
  // 子命令表从源码扫描取真值（cmd === '...' 字面量即分派表，零手工维护）；
  // cli/juli.ts 随公开投影（include cli/**），公开树同样可测。
  const juliSrc = readFileSync(join(root, 'cli', 'juli.ts'), 'utf8');
  const subcommands = new Set([...juliSrc.matchAll(/cmd === '([a-z][a-z0-9:-]*)'/g)].map((m) => m[1]!));

  it('扫描 sanity：子命令表非空且含代表性命令（扫描器自身失灵即红）', () => {
    expect(subcommands.size).toBeGreaterThan(20);
    for (const c of ['start', 'setup', 'doctor', 'hook']) expect(subcommands.has(c)).toBe(true);
  });

  it('六个 hook verb 均不在子命令表内（verb 直通优先级最高，撞名=子命令不可达）', () => {
    expect(HOOK_VERBS.size).toBe(6);
    for (const v of HOOK_VERBS) expect(subcommands.has(v)).toBe(false);
  });
});
