// 工件 / 客户文档内联直开的浏览器安全头（2026-11-23 全量审查修复）。html、svg
// 此前同源内联返回且不带任何限制——工件里的脚本就在引擎的源上运行，持密码的
// 页面能调的 API 它都能调。本文件钉纯函数的边界：哪些类型加 CSP sandbox、哪些
// 只加 nosniff。HTTP 面的断言在 ios-compat.test.ts（工件取件）与
// customers.test.ts（合同文档下载）。

import { describe, expect, it } from 'vitest';
import { inlineContentSecurityHeaders } from '../src/http/helpers.ts';

// sandbox 之内脚本一律不许；内联样式与内嵌图片放行（样式不是脚本入口，全挡
// 会让直接打开的工件没了样式），网络加载不放。
const SANDBOX = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:";
const NOSNIFF_ONLY = { 'x-content-type-options': 'nosniff' };
const NOSNIFF_AND_SANDBOX = { ...NOSNIFF_ONLY, 'content-security-policy': SANDBOX };

describe('inlineContentSecurityHeaders', () => {
  it('浏览器会当「可执行文档」渲染的类型：nosniff + CSP sandbox（html / xhtml / svg / xml）', () => {
    for (const t of ['text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/xml', 'text/xml']) {
      expect(inlineContentSecurityHeaders(t), t).toEqual(NOSNIFF_AND_SANDBOX);
    }
  });

  it('xml 两种写法（带 charset、大小写不同）同样加 sandbox——xml 里能嵌 xhtml 脚本，也是脚本执行面', () => {
    for (const t of ['application/xml; charset=utf-8', 'TEXT/XML', 'text/xml ;charset=utf-8']) {
      expect(inlineContentSecurityHeaders(t), t).toEqual(NOSNIFF_AND_SANDBOX);
    }
  });

  it('类型判断只看主类型：带 charset 参数、大小写不同、参数前有空白都算同一种', () => {
    for (const t of ['text/html; charset=utf-8', 'TEXT/HTML', 'image/svg+xml; charset=utf-8', 'text/html ;charset=x']) {
      expect(inlineContentSecurityHeaders(t), t).toEqual(NOSNIFF_AND_SANDBOX);
    }
  });

  it('其它类型只加 nosniff，不加 CSP——PDF / 图片 / Office / JSON / 纯文本 / 视频的预览不受影响', () => {
    for (const t of [
      'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
      'application/json', 'text/plain; charset=utf-8', 'text/markdown', 'text/csv',
      'video/mp4', 'video/quicktime', 'application/octet-stream',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
    ]) {
      expect(inlineContentSecurityHeaders(t), t).toEqual(NOSNIFF_ONLY);
    }
  });

  it('不误伤相近类型：text/html-something 不是 text/html', () => {
    expect(inlineContentSecurityHeaders('text/html-sandboxed')).toEqual(NOSNIFF_ONLY);
  });
});
