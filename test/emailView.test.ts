import { describe, expect, it } from 'vitest';
import { composeTextBody, renderEmailHtml, SIGNATURE_TEXT, stripSignature } from '../src/business/send/emailView.ts';

describe('落款所有权：引擎拼装，LLM 残留剥除', () => {
  it('composeTextBody：正文 + 引擎落款，文字一字不变', () => {
    const out = composeTextBody('你好：\n\n上月销量表已完成。');
    expect(out).toBe('你好：\n\n上月销量表已完成。\n\n' + SIGNATURE_TEXT);
  });
  it('stripSignature：LLM 写了落款（哪怕是「举例科技」）也整块剥掉，不留双落款', () => {
    const out = composeTextBody('你好：\n\n正文。\n此致\n敬礼\n\n举例科技（上海juli）\n旧人格\n旧披露行');
    expect(out).toContain('juli Labs');
    expect(out).not.toContain('举例科技');
    expect(out.match(/此致/g)?.length).toBe(1);
  });
});

describe('邮件 HTML 渲染（组装后正文 → 客户可见形态）', () => {
  const BODY = '你好，Casey：\n\n上月销量表已完成，结论是：3C 类同比 +12%。\n\n' + SIGNATURE_TEXT;

  it('正文段落化：空行分段、段内单换行转 <br>', () => {
    const html = renderEmailHtml(BODY);
    expect((html.match(/<p /g) ?? []).length).toBe(6); // 称呼/正文/此致敬礼/juli Labs/Ethan/披露行
    expect(html).toContain('此致<br>敬礼');
  });
  it('签名档定式：Ethan 行品牌色、披露行 12px 小字灰', () => {
    const html = renderEmailHtml(BODY);
    expect(html).toContain('color:#d97c26'); // 品牌色标注
    expect(html).toContain('font-size:12px;color:#9ca3af'); // 披露行小字
    expect(html).toContain('border-top:1px solid #ecd9c4'); // 签名区分隔线
  });
  it('HTML 转义：正文里的 <b>、& 不变成标签', () => {
    const html = renderEmailHtml('含 <b>标签</b> 和 & 符号\n\n' + SIGNATURE_TEXT);
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('&amp;');
    expect(html).not.toContain('<b>');
  });
  it('无落款输入（裸渲染）：整封按正文处理，不猜签名', () => {
    const html = renderEmailHtml('只有正文，没有落款。');
    expect(html).not.toContain('border-top:1px solid #ecd9c4');
    expect(html).toContain('只有正文，没有落款。');
  });
});
