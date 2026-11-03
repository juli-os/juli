// ptyhub closeReason 字节截断契约（R1 P2#6：自报 P0 修复补测试钉住）：
// ws 8.x 对 close reason > 123 字节直接抛 RangeError，ptyhub 两处 reason 含
// 中文 + 客户端可控会话名——截断必须按字节口径，且截出的串经 Node/ws 的
// UTF-8 编码后线上序列合法（孤代理重编码为 U+FFFD，3 字节，Reviewer 已裁定
// 的线上语义）。

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { closeReason } from '../src/platform/ws/ptyhub.ts';

const isValidUtf8 = (s: string): boolean => Buffer.from(s, 'utf8').toString('utf8') === s;

describe('closeReason：close reason ≤ 123 字节硬上限（R1 P2#6）', () => {
  it('恰 124 字节 ASCII → 截到 123 字节，结果合法 UTF-8', () => {
    const s = 'x'.repeat(124);
    const out = closeReason(s);
    expect(Buffer.byteLength(s)).toBe(124);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(123);
    expect(out).toBe('x'.repeat(123)); // 只削尾，原文其余不动
    expect(isValidUtf8(out)).toBe(true);
  });

  it('≤123 字节原样透传（41 个「你」= 123 字节，绝不改动现网不越界原文）', () => {
    const s = '你'.repeat(41);
    expect(Buffer.byteLength(s)).toBe(123);
    expect(closeReason(s)).toBe(s);
  });

  it('多字节中文越界（42 个「你」= 126 字节）→ 截回 123 字节且合法 UTF-8，不孤字', () => {
    const s = '你'.repeat(42);
    const out = closeReason(s);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(123);
    expect(isValidUtf8(out)).toBe(true);
    expect(out).toBe('你'.repeat(41)); // 整字符截断，不留半个字
  });

  it('截断劈开 surrogate pair（120×x + 😀 = 124B）→ ≤123B 且线上序列合法', () => {
    const s = 'x'.repeat(120) + '\u{1F600}';
    expect(Buffer.byteLength(s)).toBe(124);
    const out = closeReason(s);
    // 字节上限保证（ws RangeError 判定同口径）
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(123);
    // 线上语义：尾部孤代理经 Node/ws 编码为 U+FFFD（3B）——编码后的串必须
    // 合法 UTF-8 且再编码不超限（wire 序列合法，Reviewer P2#6 裁定口径）。
    const wire = Buffer.from(out, 'utf8').toString('utf8');
    expect(isValidUtf8(wire)).toBe(true);
    expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(123);
  });

  it('真实形态：attach 失败消息带长会话名（中文 + 客户端可控串）不越界', () => {
    const msg = `会话 ${'sess-'.repeat(10)}是绑定会话（专用 agent 隔离）——PTY 桥不开放，只读观察走 /ws/snapshot`;
    expect(Buffer.byteLength(msg)).toBeGreaterThan(123); // 前置：原文确实越界
    const out = closeReason(msg);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(123);
    expect(isValidUtf8(out)).toBe(true);
  });
});
