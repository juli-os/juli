// CC hooks 注入契约测试（自 69e3f02 重写前的 hooks.test.ts 迁回——HTTP E2E
// 另立门户后，installClaudeHooks 的幂等注入/用户 hook 保留锁定测试被误删）：
// settings.json 幂等注入（认 juli-service 标记清理旧条目、保留用户自有 hook）
// + defaultHookSpecs 的密码/服务地址内嵌契约（缺密码 = Stop 结算永远 401）。

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultHookSpecs, installClaudeHooks } from '@juli-os/agents';
import { TMUX_BIN } from '@juli-os/agents';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'juli-hooks-inject-'));

interface HookGroup {
  readonly hooks?: readonly { readonly type?: string; readonly command?: string }[];
  readonly matcher?: string;
}
type Settings = { hooks?: Record<string, HookGroup[]> };

describe('installClaudeHooks 幂等注入', () => {
  it('注入 hook 事件；重跑幂等不翻倍；用户自有 hook 保留', () => {
    const dir = tmp();
    try {
      const foreign: Settings = {
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'echo user-own-hook' }] }],
        },
      };
      writeFileSync(join(dir, 'settings.json'), JSON.stringify(foreign));
      expect(installClaudeHooks(dir, defaultHookSpecs('/opt/juli-service/cli/hook.js')).ok).toBe(true);
      const first = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Settings;
      const stopAfterFirst = first.hooks?.Stop ?? [];
      expect(stopAfterFirst.length).toBe(2); // 用户的 1 条 + 我们的 1 条
      expect(stopAfterFirst.some((g) => g.hooks?.some((h) => h.command === 'echo user-own-hook'))).toBe(true);
      // 重跑：我们的旧条目被清掉再注入 → 数量不变，命令指向最新路径。
      expect(installClaudeHooks(dir, defaultHookSpecs('/new/path/hook.js')).ok).toBe(true);
      const second = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Settings;
      const stopGroups = second.hooks?.Stop ?? [];
      expect(stopGroups.length).toBe(2); // 不翻倍
      const ours = stopGroups.flatMap((g) => g.hooks ?? []).find((h) => h.command?.includes('hook.js'));
      expect(ours?.command).toContain('/new/path/hook.js'); // 命令更新到最新路径
      expect(ours?.command).toContain(`${TMUX_BIN} display-message`); // 会话名内嵌（二进制跟引擎 TMUX_BIN 解析走，环境无关）
      expect(stopGroups.some((g) => g.hooks?.some((h) => h.command === 'echo user-own-hook'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('settings.json 不存在时从零创建', () => {
    const dir = tmp();
    try {
      expect(installClaudeHooks(dir, defaultHookSpecs('hook.js')).ok).toBe(true);
      const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Settings;
      expect(Object.keys(settings.hooks ?? {})).toContain('Stop');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 0923 事故回放（wf_fa36282cdf63 三连派根因）：settings 里躺着旧端口 7472
  // 的跨仓条目（skill-dash 工作树 dist——命令不含 'juli-service' 子串，旧清
  // 逻辑咬不到）×2、死路径 e2e 残留（src/cli/hook.js → loader:1386）。要求：
  // 重装后全部 JULI 条目重写为现行值，跨仓/重复/死路径条目清空，用户 hook 保留；
  // 再改端口重装（=重启）全部跟随新端口。
  it('端口/路径变更重装：跨仓陈旧条目+死路径+重复全清，全部条目=新值，用户 hook 保留', () => {
    const dir = tmp();
    try {
      const juliCmd = (url: string, pw: string, path: string, verb: string): string =>
        `JULI_SERVICE_URL=${JSON.stringify(url)} JULI_PASSWORD=${JSON.stringify(pw)} node ${JSON.stringify(path)} ${verb} "$(tmux display-message -p '#{session_name}')"`;
      const stale: Settings = {
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'echo user-own-hook' }] },
            { hooks: [{ type: 'command', command: juliCmd('http://127.0.0.1:7472', 'pw', '/Users/x/Code/juli-skill-dash/dist/cli/hook.js', 'notify done') }] },
            { hooks: [{ type: 'command', command: juliCmd('http://127.0.0.1:7472', 'pw', '/Users/x/Code/juli-skill-dash/dist/cli/hook.js', 'notify done') }] },
          ],
          SessionStart: [
            { hooks: [{ type: 'command', command: juliCmd('http://127.0.0.1:7473', 'e2e-test', '/Users/x/Code/juli-service-ts/src/cli/hook.js', 'claude-start') }] },
          ],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: juliCmd('http://127.0.0.1:7472', 'pw', '/Users/x/Code/juli-skill-dash/dist/cli/hook.js', 'capture') }] },
          ],
        },
      };
      writeFileSync(join(dir, 'settings.json'), JSON.stringify(stale));

      const specs = defaultHookSpecs('/srv/juli/dist/cli/hook.js', 'pw2', 'http://127.0.0.1:7170');
      expect(installClaudeHooks(dir, specs).ok).toBe(true);
      const all = (s: Settings): string[] =>
        Object.values(s.hooks ?? {}).flatMap((groups) => groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command ?? '')));
      const first = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Settings;
      const cmds1 = all(first);
      const juli1 = cmds1.filter((c) => c.includes('JULI_SERVICE_URL='));
      expect(juli1).toHaveLength(specs.length); // 每事件一条：重复与陈旧全清
      for (const c of juli1) {
        expect(c).toContain('http://127.0.0.1:7170');
        expect(c).toContain('/srv/juli/dist/cli/hook.js');
      }
      expect(cmds1.some((c) => c.includes('7472') || c.includes('7473') || c.includes('skill-dash') || c.includes('src/cli/hook.js'))).toBe(false);
      expect(cmds1.some((c) => c === 'echo user-own-hook')).toBe(true);

      // 端口再变（=重启）：全部条目整体重写为新端口，不残留旧值、不翻倍。
      expect(installClaudeHooks(dir, defaultHookSpecs('/srv/juli/dist/cli/hook.js', 'pw2', 'http://127.0.0.1:7272')).ok).toBe(true);
      const cmds2 = all(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Settings);
      const juli2 = cmds2.filter((c) => c.includes('JULI_SERVICE_URL='));
      expect(juli2).toHaveLength(specs.length);
      for (const c of juli2) expect(c).toContain('http://127.0.0.1:7272');
      expect(cmds2.some((c) => c.includes('7170'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('defaultHookSpecs 凭据内嵌契约', () => {
  it('密码非空 → 命令行内嵌 JULI_PASSWORD=；空 → 不含（不给 shell 留空赋值噪声）', () => {
    const withPw = defaultHookSpecs('/opt/h.js', 's3cret');
    expect(withPw.length).toBeGreaterThan(0);
    for (const s of withPw) {
      expect(s.command).toContain('JULI_PASSWORD=');
      // POSIX 单引号（agents 0.1.5 安全修复）：旧 JSON.stringify 双引号会让
      // 密码/URL 值里的 $/反引号/$() 被 shell 展开当命令跑——断言跟随修复。
      expect(s.command).toContain("'s3cret'");
      expect(s.command).not.toContain('"s3cret"');
    }
    // 敌意字符面：$()/反引号原样落命令行（单引号包裹），不参与 shell 展开。
    const hostile = defaultHookSpecs('/opt/h.js', 'p$w`x`$(boom)');
    for (const s of hostile) {
      expect(s.command).toContain("'p$w`x`$(boom)'");
    }
    const bare = defaultHookSpecs('/opt/h.js', '');
    for (const s of bare) expect(s.command).not.toContain('JULI_PASSWORD=');
  });

  it('服务地址同理：非空内嵌 JULI_SERVICE_URL=，空则不含', () => {
    const withUrl = defaultHookSpecs('/opt/h.js', '', 'https://juli.example.com:7170');
    for (const s of withUrl) expect(s.command).toContain('JULI_SERVICE_URL=');
    const bare = defaultHookSpecs('/opt/h.js', '', '');
    for (const s of bare) expect(s.command).not.toContain('JULI_SERVICE_URL=');
  });
});
