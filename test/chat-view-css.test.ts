// js-261006-s0msv9 守卫：chat 视图样式只准引用 style.css 里真实存在的
// token——黑屏事故根因正是 CHAT_CSS 引了不存在的 var(--panel, #23241f)，
// 悄悄回退硬编码近黑、字色又继承近黑 → 助手回复黑底黑字（--accent 同病，
// 用户气泡回退成绿）。锁值纪律（颜色零裸 hex）在这里落成机械面：视图
// 样式住在 chat.ts 的 CHAT_CSS 模板里，静态契约检查即可，无需 DOM 环境。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('web/src/style.css', 'utf8');
const chatSrc = readFileSync('web/src/views/chat.ts', 'utf8');

const chatCss = chatSrc.match(/const CHAT_CSS = `([^`]*)`/)?.[1] ?? '';
// style.css 全部自定义属性名（:root 24 色 + 旧名别名表，都在同一文件里）。
const defined = new Set(
  [...css.matchAll(/(--[\w-]+)\s*:[^;]+;/g)].map((x) => x[1]),
);

describe('chat 视图样式锁值守卫（js-261006-s0msv9 黑屏防复发）', () => {
  it('CHAT_CSS 模板存在且非空（模板被重构掉时本守卫要跟着重写，不许静默失效）', () => {
    expect(chatCss.length).toBeGreaterThan(100);
  });

  it('var(--x) 引用的 token 必须在 style.css 有定义——断链回退是黑屏根因', () => {
    const refs = [...chatCss.matchAll(/var\((--[\w-]+)/g)].map((x) => x[1]);
    // 有基本引用量才有守卫意义（全部删光=样式搬家了，上面长度断言兜着）。
    expect(refs.length).toBeGreaterThan(4);
    const missing = [...new Set(refs)].filter((r) => !defined.has(r));
    expect(missing, `未定义 token：${missing.join(', ')}（回退值=事故）`).toEqual([]);
  });

  it('CHAT_CSS 零裸 hex——颜色一律 token（锁值纪律）', () => {
    expect(chatCss.match(/#[0-9a-fA-F]{3,8}\b/)).toBeNull();
  });
});
