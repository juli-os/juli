// CC context 门判定（wf_a79a6fcbf7ef）：切单 clear / 阈值 compact / 其余不动。
// 纯函数 decideContextAction 的行为契约。

import { describe, expect, it } from 'vitest';
import { decideContextAction, DEFAULT_COMPACT_THRESHOLD, DEFAULT_COMPACT_COOLDOWN_MS } from '@juli-os/agents';

describe('context gate 判定', () => {
  it('切换 workflow → clear', () => {
    expect(decideContextAction({ wf: 'wf_aaa', lastInputTokens: 100 }, 'wf_bbb', 50)).toBe('clear');
  });
  it('同一 workflow 且膨胀超阈值 → compact', () => {
    expect(decideContextAction({ wf: 'wf_aaa', lastInputTokens: 0 }, 'wf_aaa', DEFAULT_COMPACT_THRESHOLD)).toBe('compact');
    expect(decideContextAction({ wf: 'wf_aaa', lastInputTokens: 0 }, 'wf_aaa', 900_000)).toBe('compact');
  });
  it('同一 workflow 未达阈值 → 不动', () => {
    expect(decideContextAction({ wf: 'wf_aaa', lastInputTokens: 0 }, 'wf_aaa', DEFAULT_COMPACT_THRESHOLD - 1)).toBeNull();
    expect(decideContextAction({ wf: 'wf_aaa', lastInputTokens: 0 }, 'wf_aaa', 5_000)).toBeNull();
  });
  it('首见会话（无状态）→ 不动（宁少 clear 不误清）', () => {
    expect(decideContextAction(undefined, 'wf_aaa', 900_000)).toBeNull();
  });
  it('当前无单（空 wf）→ 不动', () => {
    expect(decideContextAction({ wf: 'wf_aaa', lastInputTokens: 900_000 }, '', 900_000)).toBeNull();
  });
  it('自定义阈值生效', () => {
    expect(decideContextAction({ wf: 'wf_aaa', lastInputTokens: 0 }, 'wf_aaa', 100_000, 100_000)).toBe('compact');
    expect(decideContextAction({ wf: 'wf_aaa', lastInputTokens: 0 }, 'wf_aaa', 99_999, 100_000)).toBeNull();
  });
  it('切单判定优先于阈值（切了单先 clear，不 compact）', () => {
    expect(decideContextAction({ wf: 'wf_aaa', lastInputTokens: 900_000 }, 'wf_bbb', 900_000)).toBe('clear');
  });
});

describe('context gate 判定（十四跑 R1 P2-4 补案）', () => {
  it('prev.wf=""（热身/无单派发后首个带单派发）→ clear：有状态可比，按切单清场；区别于首见（undefined）不动', () => {
    expect(decideContextAction({ wf: '', lastInputTokens: 0 }, 'wf_aaa', 0)).toBe('clear');
    // 膨胀值在场也一样先 clear（切单优先），不 compact
    expect(decideContextAction({ wf: '', lastInputTokens: 900_000 }, 'wf_aaa', 900_000)).toBe('clear');
  });

  it('compact 冷却：compact 后 10 分钟内不重判（stale 膨胀值），窗满恢复 compact', () => {
    const t0 = 1_000_000_000;
    const prev = { wf: 'wf_aaa', lastInputTokens: 0, compactAt: t0 };
    expect(decideContextAction(prev, 'wf_aaa', DEFAULT_COMPACT_THRESHOLD, DEFAULT_COMPACT_THRESHOLD, t0 + 60_000)).toBeNull();
    expect(decideContextAction(prev, 'wf_aaa', DEFAULT_COMPACT_THRESHOLD, DEFAULT_COMPACT_THRESHOLD, t0 + DEFAULT_COMPACT_COOLDOWN_MS - 1)).toBeNull();
    expect(decideContextAction(prev, 'wf_aaa', DEFAULT_COMPACT_THRESHOLD, DEFAULT_COMPACT_THRESHOLD, t0 + DEFAULT_COMPACT_COOLDOWN_MS)).toBe('compact');
  });

  it('compact 冷却不拦切单 clear；nowMs 缺省维持旧语义（无冷却，兼容既有签名）', () => {
    const prev = { wf: 'wf_aaa', lastInputTokens: 0, compactAt: 1_000_000_000 };
    expect(decideContextAction(prev, 'wf_bbb', 900_000, DEFAULT_COMPACT_THRESHOLD, 1_000_000_001)).toBe('clear');
    expect(decideContextAction({ wf: 'wf_aaa', lastInputTokens: 0 }, 'wf_aaa', 900_000)).toBe('compact');
  });
});
