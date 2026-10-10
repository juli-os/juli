// HTML 转义（独立模块：dialog 与各视图共用，避免 view ↔ dialog 的循环
// 导入）。任何拼进 innerHTML 的动态文本（元素或属性上下文）都必须先过这里
// ——服务端/会话名字段可携带任意字符，不转义即存储型 XSS。

export const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * href scheme 白名单（九跑 P0 双保险·前端侧，2026-09-28）：外部可控 page 会
 * 被渲染成 `<a href>`，esc() 只转义不判 scheme——`javascript:` 等带 scheme 的
 * 值经 esc 原样通过即存储型 XSS（写入面 /__fb/* 无鉴权）。白名单=无 scheme 的
 * 相对引用（fb.js 的 pathname、裸词 'default'、#/route、wf_ 单号）+ http(s)
 * 绝对地址；false → 调用方降级纯文本，不渲染成链接（兜住存量脏数据）。
 * scheme 判定按 WHATWG URL 口径先剔首尾 C0/空格与全串 tab/LF/CR——否则
 * `java\tscript:` 是真实绕过。与服务端 fbPageSafe（src/http/routes/feedback.ts）
 * 同规则，对齐测试 test/feedback-page-scheme.test.ts 锁定。
 */
export const hrefSafe = (url: string): boolean => {
  const u = url.replace(/^[\0-\x20]+/, '').replace(/[\0-\x20]+$/, '').replace(/[\t\n\r]/g, '');
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u) || /^https?:/i.test(u);
};
