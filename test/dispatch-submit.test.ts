// sendTextConfirmed 提交确认契约（2026-09-21 冷启动吞 Enter 事故）：
// 热会话一次确认；Enter 被吞补 Enter（绝不重发文本）；粘贴丢失补一次完整
// 粘贴；总预算内未消费显性失败（submit_unconfirmed / submit_lost）。生产默认 20s
// （4s 实测产假阴性：agent 忙时 prompt 入队稍后才消费），测试注入 1.2s 窗口。
import { describe, expect, it } from 'vitest';
import {
  createTmuxClient,
  inputBoxState,
  promptFingerprints,
  type TmuxClient,
} from '@juli-os/agents';
import { ok } from '@juli-os/artifacts';

const PROMPT = ['【feedback 工单】record x', '■ 原文：轮播图太快了', '执行完成后给出简要汇报'].join('\n');
const TAIL = '执行完成后给出简要汇报';
const inBoxPane = (): string => ['❯ ' + TAIL, 'ctx:0%'].join('\n');
const clearedPane = (): string => ['❯ ' + TAIL + '（已入记录）', '⎿ …', '❯', 'ctx:1%'].join('\n');
const absentPane = (): string => ['❯', 'ctx:0%'].join('\n');

describe('promptFingerprints', () => {
  it('首/末非空行各取 40 字符，空白行跳过', () => {
    const fp = promptFingerprints(PROMPT);
    expect(fp.head).toBe('【feedback 工单】record x');
    expect(fp.tail).toBe(TAIL);
    const long = promptFingerprints('ab ' + 'x'.repeat(60));
    expect(long.head).toHaveLength(40);
  });
  it('空文本 → 空 tail（调用方降级为普通 sendText）', () => {
    expect(promptFingerprints('\n  \n').tail).toBe('');
  });
});

describe('inputBoxState', () => {
  it('未提交：tail 在底部输入框区、下方无重置 ❯ → in-box', () => {
    expect(inputBoxState(inBoxPane(), TAIL)).toBe('in-box');
  });
  it('已提交：tail 进入对话记录、下方出现重置的空 ❯ → cleared', () => {
    expect(inputBoxState(clearedPane(), TAIL)).toBe('cleared');
  });
  it('tail 不在 pane → absent（调用方结合「曾见指纹」区分滚出/丢失）', () => {
    expect(inputBoxState(absentPane(), TAIL)).toBe('absent');
  });
  it('同文本多处出现时取最后一处（框内副本才是判定对象）', () => {
    const pane = ['❯ ' + TAIL, '（历史）', '❯ ' + TAIL, 'ctx:0%'].join('\n');
    expect(inputBoxState(pane, TAIL)).toBe('in-box');
  });
});

/** 真实现 + 可脚本化假 tmux：用桩的 capturePane/exec/sendText 驱动确认循环。 */
const realImplWith = (stub: {
  capturePane: TmuxClient['capturePane'];
  exec: TmuxClient['exec'];
  sendText: TmuxClient['sendText'];
}): TmuxClient => {
  const real = createTmuxClient({ submitConfirmMs: 1_200 });
  return { ...real, capturePane: stub.capturePane, exec: stub.exec, sendText: stub.sendText };
};

describe('sendTextConfirmed（行为契约，真实现+桩 tmux）', () => {
  it('Enter 被吞一次后生效 → 补一发 Enter 即确认，绝不重发文本', async () => {
    const state = { enters: 0, pastes: 0 };
    const tmux = realImplWith({
      capturePane: async () => ok(state.enters >= 1 ? clearedPane() : inBoxPane()),
      exec: async (args) => { if (args.includes('Enter')) state.enters += 1; return ok(''); },
      sendText: async () => { state.pastes += 1; return ok(undefined); },
    });
    const r = await tmux.sendTextConfirmed('s1', PROMPT);
    expect(r.ok).toBe(true);
    expect(state.enters).toBe(1);
    expect(state.pastes).toBe(1); // 只有最初一次粘贴
  });

  it('始终未确认 → 预算内 submit_unconfirmed 显性失败（最多补 3 发 Enter）', async () => {
    const state = { enters: 0, pastes: 0 };
    const tmux = realImplWith({
      capturePane: async () => ok(inBoxPane()),
      exec: async (args) => { if (args.includes('Enter')) state.enters += 1; return ok(''); },
      sendText: async () => { state.pastes += 1; return ok(undefined); },
    });
    const r = await tmux.sendTextConfirmed('s1', PROMPT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('submit_unconfirmed');
    expect(state.enters).toBe(3);
    expect(state.pastes).toBe(1); // 文本绝不重发
  }, 10_000);

  it('粘贴丢失（指纹从未入框）→ 补一次完整粘贴后确认', async () => {
    const state = { enters: 0, pastes: 0 };
    const tmux = realImplWith({
      capturePane: async () => ok(state.pastes >= 2 && state.enters >= 1 ? clearedPane() : absentPane()),
      exec: async (args) => { if (args.includes('Enter')) state.enters += 1; return ok(''); },
      sendText: async () => { state.pastes += 1; return ok(undefined); },
    });
    const r = await tmux.sendTextConfirmed('s1', PROMPT);
    expect(r.ok).toBe(true);
    expect(state.pastes).toBe(2); // 原始粘贴 + 恰好一次补粘贴
  }, 10_000);
});
