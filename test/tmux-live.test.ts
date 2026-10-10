// 真 tmux 回归：hasSession 布尔契约（恒真 bug 的防复发锚）。
// hasSession 曾因 Result 双包恒真——派发跳过建会话直发 send-keys。这条
// 测试只在有 tmux 的本机跑（CI 跳过）：mock 世界测不出 execFile 真实
// 退出码语义——review loop 的教训：mock 全绿 ≠ 链路活着。

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createTmuxClient } from '@juli-os/agents';

const hasTmux = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

describe.skipIf(!hasTmux)('真 tmux：hasSession 契约', () => {
  it('不存在=false；建后=true；删后=false（绝无恒真）', async () => {
    const tmux = createTmuxClient({});
    const name = `juli-test-has-${Date.now()}`;
    expect(await tmux.hasSession(name)).toBe(false); // bug 形态：这里曾是 true
    expect((await tmux.newSession(name)).ok).toBe(true);
    expect(await tmux.hasSession(name)).toBe(true);
    await tmux.killSession(name);
    expect(await tmux.hasSession(name)).toBe(false);
  });
});
