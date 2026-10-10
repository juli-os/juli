// tmux 二进制解析契约（2026-10-08 新机迁移 GUI 拉起引擎事故配套）：
// GUI 子进程默认 PATH=/usr/bin:/bin:/usr/sbin:/sbin，homebrew tmux 会
// spawn ENOENT——warmup 全失败、派发 2 秒 failed、服务本身正常。解析器
// 契约：PATH 命中用 PATH 名（尊重自装覆盖）；PATH 查不到按常见安装位
// 兜底绝对路径；哪里都没有保留原名让 ENOENT 显性可诊断。

import { describe, expect, it } from 'vitest';
import { resolveTmuxBin } from '@juli-os/agents';
import { tmuxAttachCommand } from '@juli-os/agents';

const existsIn = (paths: readonly string[]) => (p: string) => paths.includes(p);

describe('resolveTmuxBin（GUI 残缺 PATH 兜底）', () => {
  it('PATH 里查得到 → 用 PATH 名（尊重用户自装覆盖）', () => {
    expect(resolveTmuxBin('/usr/bin:/bin', existsIn(['/usr/bin/tmux']))).toBe('tmux');
  });

  it('PATH 查不到 → 落 homebrew 绝对路径（GUI 默认 PATH 场景，10-07 事故形态）', () => {
    expect(resolveTmuxBin('/usr/bin:/bin:/usr/sbin:/sbin', existsIn(['/opt/homebrew/bin/tmux'])))
      .toBe('/opt/homebrew/bin/tmux');
  });

  it('homebrew 没有 → 落 /usr/local/bin（Intel 位/symlink 位）', () => {
    expect(resolveTmuxBin('', existsIn(['/usr/local/bin/tmux']))).toBe('/usr/local/bin/tmux');
  });

  it('哪里都没有 → 保留 tmux 原名，ENOENT 原样显性', () => {
    expect(resolveTmuxBin('/usr/bin:/bin', existsIn([]))).toBe('tmux');
  });

  it('空 PATH 段/空 PATH 不误判（注意：显式传 undefined 会触发默认参取真实 env，用空串表达无 PATH）', () => {
    expect(resolveTmuxBin('::', existsIn([]))).toBe('tmux');
    expect(resolveTmuxBin('', existsIn([]))).toBe('tmux');
  });

  it('attach 命令可注入解析结果（残缺 PATH 下首元素=绝对路径）', () => {
    const cmd = tmuxAttachCommand('/run/x.sock', 'juli-reply', '/opt/homebrew/bin/tmux');
    expect(cmd).toEqual(['/opt/homebrew/bin/tmux', '-S', '/run/x.sock', 'attach', '-t', 'juli-reply']);
  });
});
