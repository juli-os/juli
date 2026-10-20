// 会话路由器（复用优先）：点名不存在 → 落回 default；存在 → 原样；
// 空名单首刷不误改道；available 返回真实名单。

import { describe, expect, it } from 'vitest';
import { createSessionRouter } from '@juli-os/agents';

const fakeList = (names: string[]) => (): readonly string[] => names;

describe('createSessionRouter（复用优先）', () => {
  it('存在的会话原样复用；不存在的落回 default——绝不凭空新造', () => {
    const r = createSessionRouter({
      listSync: fakeList(['juli-reply', 'juli-demo-card', 'dev']),
      defaultSession: 'juli-reply', ttlMs: 60_000,
    });
    expect(r.resolve('juli-demo-card')).toBe('juli-demo-card'); // 复用第一
    expect(r.resolve('typo-or-new-name')).toBe('juli-reply');  // 兜底，不新建
    expect(r.resolve('')).toBe('juli-reply');
  });

  it('名单尚未刷出（首刷同步挡板）：default 也不在名单 → 原样放行不误改道', () => {
    const r = createSessionRouter({
      listSync: fakeList([]), defaultSession: 'juli-reply', ttlMs: 60_000,
    });
    expect(r.resolve('brand-new')).toBe('brand-new'); // 冷启动不拦
  });

  it('available() = 真实活会话名单（triage 只能点真名）', () => {
    const names = ['juli-reply', 'car', 'dev'];
    const r = createSessionRouter({ listSync: fakeList(names), defaultSession: 'juli-reply', ttlMs: 60_000 });
    r.resolve('x'); // 触发快照
    expect([...r.available()].sort()).toEqual([...names].sort());
  });

  it('default 未配置：只透传不兜底', () => {
    const r = createSessionRouter({ listSync: fakeList(['a']), defaultSession: '', ttlMs: 60_000 });
    expect(r.resolve('anything')).toBe('anything');
  });
});
