// 语音输入围栏（2026-10-21 拆页裁定后）：①样式锁值（VOICEIN_CSS 只引真实
// token、零裸 hex——chat-view-css 同款纪律）；②接线防回退（chat composer 挂
// 载、抽屉清理口、路由表无独立语音页——单页形态已废除，回潮即红）。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string): string => readFileSync(resolve(import.meta.dirname, rel), 'utf8');
const css = read('../web/src/style.css');
const inputSrc = read('../web/src/voice-input.ts');
const chatSrc = read('../web/src/views/chat.ts');
const orderfabSrc = read('../web/src/orderfab.ts');
// b44 R1 P1：views-registry.ts / nav.ts 被投影 exclude——「独立语音页不得回潮」
// 围栏迁至 test/nav-voice-guard.test.ts（manifest exclude，私仓照常跑），
// 本文件不再读任何被 exclude 路径。

const inputCss = inputSrc.match(/const VOICEIN_CSS = `([^`]*)`/)?.[1] ?? '';
const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:[^;]+;/g)].map((x) => x[1]));

describe('voice-input 样式锁值守卫（黑屏防复发，同 chat 先例）', () => {
  it('VOICEIN_CSS 模板存在且非空', () => {
    expect(inputCss.length).toBeGreaterThan(20);
  });

  it('var(--x) 引用的 token 必须在 style.css 有定义；零裸 hex', () => {
    const refs = [...inputCss.matchAll(/var\((--[\w-]+)/g)].map((x) => x[1]);
    expect(refs.length).toBeGreaterThan(0); // 组件瘦身只剩少量引用；断链检查才是真守卫
    const missing = [...new Set(refs)].filter((r) => !defined.has(r));
    expect(missing, `未定义 token：${missing.join(', ')}（回退值=事故）`).toEqual([]);
    expect(inputCss.match(/#[0-9a-fA-F]{3,8}\b/)).toBeNull();
  });
});

describe('语音输入接线围栏（模态非页面）', () => {
  it('chat composer 挂载：插槽 #c-voice + mountVoiceInput + 清理口随视图卸载', () => {
    expect(chatSrc).toContain('id="c-voice"');
    expect(chatSrc).toContain('mountVoiceInput(');
    expect(chatSrc).toContain('voiceCleanup();'); // chatView 返回的清理口里必须收语音件
  });

  it('orderfab 抽屉调用 chatView 清理口（否则语音 WS/计时器泄漏到抽屉外）', () => {
    expect(orderfabSrc).toContain('chatCleanup?.();');
    expect(orderfabSrc).toMatch(/chatView\(body\)\.then/);
  });

  // （「独立语音页不得回潮」围栏已迁 test/nav-voice-guard.test.ts——b44 R1 P1，
  // registry/nav 属投影 exclude 面。）

  it('协议判定留在协议机：会话层以 stt 模式驱动，输入/通话组件不自写握手/看门狗', () => {
    const sessionSrc = read('../web/src/voice-session.ts');
    expect(sessionSrc).toContain("mode: 'stt'");
    expect(sessionSrc).toContain("from './voice-protocol.ts'");
    expect(inputSrc).toContain("from './voice-session.ts'");
    for (const src of [inputSrc, sessionSrc, read('../web/src/voice-call.ts')]) {
      expect(src).not.toContain("'session.update'");
      expect(src).not.toContain('response.cancel');
    }
  });

  it('会话共享互斥：页面级单例（getSharedVoiceSession）一份会话，输入与通话都挂它（2026-10-27 后台保持：切页不 dispose）', () => {
    expect(chatSrc).toContain('getSharedVoiceSession()');
    expect((chatSrc.match(/getSharedVoiceSession\(\)/g) ?? []).length).toBe(1);
    expect(chatSrc).toContain('id="c-call"');
    // 视图清理口不再收口会话/通话（生命周期=页面；切页即断线的旧形态防回潮）
    const cleanupBlock = chatSrc.slice(chatSrc.indexOf('return () => {'), chatSrc.lastIndexOf('};'));
    expect(cleanupBlock).not.toContain('voiceSession.dispose()');
    expect(cleanupBlock).not.toContain('call.end()');
  });
});
