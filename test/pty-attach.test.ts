// web 终端 attach 的命令拼装契约（2026-09-28 专属 tmux socket 配套 +
// 2026-09-29 二进制回归修复）：
// ① 引擎 server 与 default socket 分家后，裸 `tmux attach` 会 attach 到错误
//   的 server——tmuxAttachCommand 必须携带 -S <path>；
// ② 首元素必须是 tmux 二进制——0216446 曾漏掉（sh -c exec 'attach'
//   → not found → pty 秒退，xterm attach 自 09-28 全灭）。命令形状契约显式
//   注入 'tmux'（与环境解耦）；默认参走启动期 TMUX_BIN 解析（2026-10-08 GUI
//   残缺 PATH 兜底：PATH 命中仍为 'tmux'，兜底为绝对路径），回归锚钉死。
//   本测试锁定两端都不再退。

import { describe, expect, it } from 'vitest';
import { TMUX_BIN, tmuxAttachCommand } from '@juli-os/agents';

describe('tmuxAttachCommand', () => {
  it('有 socketPath → tmux 打头 + -S 随行（专属 server 上的会话才 attach 得到）', () => {
    expect(tmuxAttachCommand('/Users/x/.juli-service/tmux-engine.sock', 'juli-reply', 'tmux')).toEqual([
      'tmux', '-S', '/Users/x/.juli-service/tmux-engine.sock', 'attach', '-t', 'juli-reply',
    ]);
  });
  it('无 socketPath（default）→ tmux 打头', () => {
    expect(tmuxAttachCommand(undefined, 'juli-reply', 'tmux')).toEqual(['tmux', 'attach', '-t', 'juli-reply']);
  });
  it('回归锚：首元素必须是二进制（丢二进制 = attach 全灭），默认参（不传 bin）走 TMUX_BIN 解析', () => {
    // 默认参（不传 bin）首元素 === TMUX_BIN——与被测默认参同 env 求值，任何
    // PATH 下都环境无关，把「首元素=启动期解析出的 tmux 二进制」新契约钉死
    // （PATH 命中时='tmux'，兜底时=绝对路径）。
    for (const cmd of [tmuxAttachCommand(undefined, 'x'), tmuxAttachCommand('/tmp/s.sock', 'x')]) {
      expect(cmd[0]).toBe(TMUX_BIN);
      expect(cmd.join(' ')).not.toMatch(/^tmux .*'attach'/); // 引号残留 = 又被当成了内层参数
    }
  });
});
