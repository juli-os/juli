// 邮件组装与渲染（2026-09-14 裁决二轮：落款所有权归引擎，LLM 只写正文）。
// 「举例科技」复活事故证明落款交模型写必漂移——名字、颜色、字号从此由代码
// 钉死：文本一字不变（composeTextBody），HTML 样式（renderEmailHtml）。
// 不变式：审批文本=正文部分逐字节（哈希取件）；落款是引擎自有常量，同附件
// 地位，不进审批回路。全内联样式，不依赖外部 CSS（邮件客户端约束）。

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---- 落款常量（唯一事实源；skill §4 与 draft prompt 均引用此处文字）----------

export const SIGNATURE_TEXT =
  '此致\n敬礼\n\njuli Labs\nAI 助理\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。';

export const DISCLOSURE_LINE = '本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。';

/** 剥离草稿里可能混入的落款（旧 prompt 残留/模型自由发挥），正文到要点为止：
 * 「此致」块整块剥；无块的孤立披露行（旧式输出）也剥——落款归引擎后，正文
 * 末尾出现披露行只能是模型残留。长度上限防误吃提到「本邮件由」的正文长句。 */
export const stripSignature = (body: string): string => {
  let s = body.trimEnd();
  const i = s.indexOf('\n此致');
  if (i >= 0) s = s.slice(0, i).trimEnd();
  else if (s.startsWith('此致')) return '';
  const j = s.lastIndexOf('\n本邮件由');
  if (j >= 0) {
    const tail = s.slice(j + 1);
    if (tail.startsWith('本邮件由') && tail.length < 60) s = s.slice(0, j).trimEnd();
  }
  return s;
};

/** 组装对外正文：审批正文（剥掉残留落款）+ 引擎拼装落款。 */
export const composeTextBody = (approved: string): string =>
  `${stripSignature(approved)}\n\n${SIGNATURE_TEXT}`;

// ---- HTML 渲染 ----------------------------------------------------------------

/** 段落化：空行分段，段内单换行 → <br>。 */
const paragraphs = (text: string): string =>
  text.split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;">${esc(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('');

const BODY_STYLE = 'font-family:-apple-system,\'PingFang SC\',\'Segoe UI\',sans-serif;font-size:15px;line-height:1.75;color:#1f2937;max-width:640px;';

// 落款固定块识别标记：落款以「此致」行开头（composeTextBody 拼装保证存在；
// 裸渲染时找不到就整封按正文处理，不猜）。
const SIG_MARK = '\n此致';

const SPLIT = (body: string): { main: string; sig: string } => {
  const i = body.indexOf(SIG_MARK);
  if (i < 0) return { main: body, sig: '' };
  return { main: body.slice(0, i), sig: body.slice(i + 1) };
};

/** 签名档逐行定式：juli Labs=品牌橙粗体；署名行=墨灰粗体（与品牌色分层）；
 * 披露行=12px 小字灰。 */
const sigLineHtml = (line: string): string => {
  if (line.startsWith('本邮件由')) {
    return `<p style="margin:6px 0 0;font-size:12px;color:#9ca3af;">${esc(line)}</p>`;
  }
  if (line.includes('juli Labs')) {
    return `<p style="margin:10px 0 0;font-size:14px;font-weight:600;color:#d97c26;">${esc(line)}</p>`;
  }
  return `<p style="margin:10px 0 0;font-size:14px;font-weight:600;color:#374151;">${esc(line)}</p>`;
};

/** 签名档 HTML：此致/敬礼一组，其余行按定式上样式。 */
const sigHtml = (sig: string): string => {
  const lines = sig.trim().split('\n').filter((l) => l.trim() !== '');
  const parts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l === '此致') {
      parts.push(`<p style="margin:0;">此致<br>敬礼</p>`);
      if (lines[i + 1] === '敬礼') i++;
      continue;
    }
    parts.push(sigLineHtml(l));
  }
  return parts.join('\n');
};

/** 组装后的正文 → 客户可见 HTML（text 件的渲染镜像）。 */
export const renderEmailHtml = (body: string): string => {
  const { main, sig } = SPLIT(body);
  const sigBlock = sig === ''
    ? ''
    : `\n<div style="margin-top:28px;padding-top:14px;border-top:1px solid #ecd9c4;">\n${sigHtml(sig)}\n</div>`;
  return `<div style="${BODY_STYLE}">\n${paragraphs(main.trim())}${sigBlock}\n</div>`;
};
