// CC transcript 扫描规则纯函数直测（R8 批4 刀3 随抽出补齐）：人机混仓防线
// （mtime 新于会话出生点才映射）此前长在 runtime 摄取定时器闭包里零直测。
// 边界钉死：mtime 相等/早于/晚于出生点、会话无出生点（保守回落全映射）、
// 出生点表解析的坏行剔除。

import { describe, expect, it } from 'vitest';
import { autoMapPairs, sessionBirthOf, transcriptMappable } from '../src/platform/llm/transcripts.ts';

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

// ---- autoMapPairs（b51 R1 P1-2：herdr 目录级自动映射停用 + tmux 出生点门）----
// 场景与原定时器闭包逐值对齐：herdr 下人用 CC 的旧 transcript（不在 hook 精确
// 登记链里的）必须不被映射给 agent 会话；tmux 下出生点门原语义保留。

describe('autoMapPairs（后端 × 目录级自动映射）', () => {
  const BORN = 1_760_000_000_000;
  const sessions = [
    { name: 'juli-a', path: '/repo/x' },   // 出生点已知
    { name: 'juli-b', path: '/repo/y' },   // 出生点未知（保守回落全映射）
    { name: 'no-cwd', path: '' },          // cwd 空跳过
  ];
  const files: Record<string, { stem: string; mtimeMs: number | undefined; path: string }[]> = {
    '/repo/x': [
      { stem: 'c-new', mtimeMs: BORN + 1, path: '/p/x/c-new.jsonl' },
      { stem: 'c-old', mtimeMs: BORN - 1, path: '/p/x/c-old.jsonl' },
      { stem: 'c-equal', mtimeMs: BORN, path: '/p/x/c-equal.jsonl' },      // 相等算旧
      { stem: 'c-stat-miss', mtimeMs: undefined, path: '/p/x/c-miss.jsonl' }, // stat 失败
    ],
    '/repo/y': [{ stem: 'c-y', mtimeMs: BORN + 5, path: '/p/y/c-y.jsonl' }],
  };
  const filesOf = (cwd: string) => files[cwd] ?? [];
  const births = new Map([['juli-a', BORN]]);

  it('herdr：目录级自动映射停用——有会话有候选也恒零映射（人机混仓收口本体）', () => {
    // 人用 CC 同仓的旧 transcript 与 agent 的候选同目录在列，herdr 一律不建映射
    // ——归属只走 hook 精确登记链（recordClaudeSessionPrecise）。
    expect(autoMapPairs({ kind: 'herdr', sessions, births: new Map(), filesOf })).toEqual([]);
    // 即使出生点在表（未来协议补出生点的前瞻），herdr 也不走目录级自动映射。
    expect(autoMapPairs({ kind: 'herdr', sessions, births, filesOf })).toEqual([]);
  });

  it('tmux：出生点门原语义——新映射、旧/相等/stat 失败不映射、无出生点全映射、空 cwd 跳过', () => {
    const pairs = autoMapPairs({ kind: 'tmux', sessions, births, filesOf });
    // juli-a（出生点已知）：只 c-new 过门；juli-b（无出生点）：全映射；no-cwd：跳过。
    expect(pairs.map((p) => `${p.session}/${p.claudeId}`)).toEqual(['juli-a/c-new', 'juli-b/c-y']);
    // 映射对字段：claudeId=stem、transcriptPath/cwd 原样回带（usage.recordClaudeSession 的入参合同）。
    expect(pairs[0]).toEqual({ claudeId: 'c-new', session: 'juli-a', transcriptPath: '/p/x/c-new.jsonl', cwd: '/repo/x' });
    expect(pairs[1]).toEqual({ claudeId: 'c-y', session: 'juli-b', transcriptPath: '/p/y/c-y.jsonl', cwd: '/repo/y' });
  });

  it('tmux：目录缺席（filesOf 回空）→ 无映射', () => {
    expect(autoMapPairs({ kind: 'tmux', sessions: [{ name: 'x', path: '/missing' }], births: new Map(), filesOf: () => [] })).toEqual([]);
  });
});
