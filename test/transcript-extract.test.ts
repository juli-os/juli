// extractFinalMessage 提取加固测试（2026-09-15）：二段式扫描——尾窗
// （1MB）被 tool 记录洪流淹没时，按整个文件兜底反查仍能取到最后答复。

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFinalMessage } from '@juli-os/agents';

/** 一条 assistant 记录的 JSONL 行；blocks 缺省 = 无 text（模拟 tool 洪流）。 */
const assistantLine = (text: string | null, pad = ''): string =>
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: text === null
        ? [{ type: 'tool_use', id: 't', name: 'Bash', input: { out: pad } }]
        : [{ type: 'text', text }],
    },
  });

describe('extractFinalMessage 二段式提取', () => {
  it('(a) 尾窗 1MB+ 全是无 text 的 assistant 记录（tool 洪流），文本在更早位置 → 仍能提取', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-tx-'));
    try {
      const p = join(dir, 'heavy-tools.jsonl');
      // 尾部铺 ~2MB 的 tool_use 记录（每行 ~2KB）：1MB 尾窗内没有任何 text。
      const lines: string[] = [];
      lines.push(assistantLine('PPT 已生成完毕，三份交付物见附件。')); // 真正的最终答复
      for (let i = 0; i < 1000; i++) {
        lines.push(assistantLine(null, 'x'.repeat(2000)));
      }
      writeFileSync(p, lines.join('\n') + '\n');
      // 健全性检查：文件确实超过尾窗且窗口内无答复（否则测试失真）。
      expect(statSync(p).size).toBeGreaterThan(1024 * 1024);
      expect(extractFinalMessage(p)).toBe('PPT 已生成完毕，三份交付物见附件。');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(b) 正常尾部提取不受影响：最后一条 assistant text 即答复', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-tx-'));
    try {
      const p = join(dir, 'normal.jsonl');
      writeFileSync(p, [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
        assistantLine('中间汇报'),
        assistantLine(null), // tool_use 不算答复
        assistantLine('最终答复文本'),
      ].join('\n') + '\n');
      expect(extractFinalMessage(p)).toBe('最终答复文本');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('空文件/缺失文件/全 tool 记录 → null（语义不变）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-tx-'));
    try {
      const empty = join(dir, 'empty.jsonl');
      writeFileSync(empty, '');
      expect(extractFinalMessage(empty)).toBeNull();
      expect(extractFinalMessage(join(dir, 'nope.jsonl'))).toBeNull();
      const toolsOnly = join(dir, 'tools.jsonl');
      writeFileSync(toolsOnly, [assistantLine(null), assistantLine(null)].join('\n') + '\n');
      expect(extractFinalMessage(toolsOnly)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
