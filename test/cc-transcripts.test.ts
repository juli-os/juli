// CC transcript 扫描规则纯函数直测（R8 批4 刀3 随抽出补齐）：人机混仓防线
// （mtime 新于会话出生点才映射）此前长在 runtime 摄取定时器闭包里零直测。
// 边界钉死：mtime 相等/早于/晚于出生点、会话无出生点（保守回落全映射）、
// 出生点表解析的坏行剔除。

import { describe, expect, it } from 'vitest';
import { sessionBirthOf, transcriptMappable } from '../src/platform/llm/transcripts.ts';

describe('transcriptMappable（人机混仓防线）', () => {
  it('mtime 晚于出生点 → 映射（会话内新产的 transcript）', () => {
    expect(transcriptMappable(1_760_000_000_000, 1_759_999_000_000)).toBe(true);
  });

  it('mtime 早于出生点 → 不映射（人用 CC 同仓的旧 transcript 不划给 agent）', () => {
    expect(transcriptMappable(1_759_000_000_000, 1_759_999_000_000)).toBe(false);
  });

  it('mtime 相等 → 不映射（相等算旧——边界从严）', () => {
    expect(transcriptMappable(1_760_000_000_000, 1_760_000_000_000)).toBe(false);
  });

  it('会话无出生点（undefined）→ 保守回落旧行为：全映射', () => {
    expect(transcriptMappable(0, undefined)).toBe(true);
    expect(transcriptMappable(1_760_000_000_000, undefined)).toBe(true);
  });
});

describe('sessionBirthOf（tmux list-sessions -F 输出解析）', () => {
  it('name\\tepoch 秒 → ms 表；名字两端空白剔除', () => {
    const m = sessionBirthOf('juli-dev\t1760000000\n  juli-fin \t1760000500');
    expect(m.get('juli-dev')).toBe(1_760_000_000_000);
    expect(m.get('juli-fin')).toBe(1_760_000_500_000);
  });

  it('坏行静默剔除：空名/非数字/0/负数/缺列', () => {
    const m = sessionBirthOf([
      '\t1760000000',        // 空名
      'juli-x\tnot-a-num',   // 非数字
      'juli-zero\t0',        // 非正数（epoch 0）
      'juli-neg\t-5',        // 负数
      'juli-nocol',          // 缺 created 列（undefined → NaN）
      'juli-mid\ta\t1760000000', // created 位非数字（多列取前两列）
      'juli-ok\t1760000000', // 唯一合法行
      '',                    // 空行
    ].join('\n'));
    expect(m.size).toBe(1);
    expect(m.get('juli-ok')).toBe(1_760_000_000_000);
  });

  it('空输出 → 空表（exec 成功但零会话）', () => {
    expect(sessionBirthOf('').size).toBe(0);
  });
});
