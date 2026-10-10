// .eml 工件解析渲染（2026-09-21 用户报「打开 eml 一堆奇怪的东西」= MIME 原文怼 pre）。
// 零依赖纯 TS：头展开+RFC2047 解码+multipart 递归+base64/QP 解码。
// 性能铁律：**只解码 text/\* 部件**，附件（常是数 MB base64）只列名与近似体积。
// 纪律：正文原样呈现（审的就是发出的每个字）；html 正文走 iframe 沙箱。

export interface EmlAttachment {
  readonly filename: string;
  readonly sizeLabel: string;
}

export interface EmlView {
  readonly subject: string;
  readonly from: string;
  readonly to: string;
  readonly cc: string;
  readonly date: string;
  readonly text: string;
  readonly html: string;
  readonly attachments: readonly EmlAttachment[];
  readonly rawSizeLabel: string;
  readonly raw: string;
}

const decoderFor = (charset: string): InstanceType<typeof TextDecoder> => {
  const cs = charset.trim().toLowerCase().replace(/["']/g, '');
  try {
    return new TextDecoder(cs === 'gb2312' || cs === 'gbk' ? 'gb18030' : cs || 'utf-8');
  } catch {
    return new TextDecoder('utf-8');
  }
};

const bytesToString = (bytes: Uint8Array, charset: string): string => decoderFor(charset).decode(bytes);

const b64ToBytes = (b64: string): Uint8Array => {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const qpToBytes = (s: string): Uint8Array => {
  const noSoft = s.replace(/=\r?\n/g, '');
  const out = new Uint8Array(noSoft.length);
  let n = 0;
  for (let i = 0; i < noSoft.length; i++) {
    const c = noSoft[i]!;
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(noSoft.slice(i + 1, i + 3))) {
      out[n++] = parseInt(noSoft.slice(i + 1, i + 3), 16);
      i += 2;
    } else {
      out[n++] = c.charCodeAt(0);
    }
  }
  return out.slice(0, n);
};

/** RFC 2047 编码头解码：=?charset?B/Q?text?=（大小写不敏感，可连续多段）。 */
export const decodeMimeWords = (s: string): string =>
  s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, cs: string, enc: string, text: string) => {
    try {
      if (enc.toLowerCase() === 'b') return bytesToString(b64ToBytes(text), cs);
      return bytesToString(qpToBytes(text.replace(/_/g, ' ')), cs);
    } catch {
      return text;
    }
  }).trim();

interface ParsedHeader {
  readonly name: string;
  readonly value: string;
}

const parseHeaders = (block: string): ParsedHeader[] => {
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  const out: ParsedHeader[] = [];
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out.push({ name: line.slice(0, i).trim().toLowerCase(), value: line.slice(i + 1).trim() });
  }
  return out;
};

const headerParam = (value: string, param: string): string => {
  const m = new RegExp(`${param}\\s*=\\s*"?([^";]+)"?`, 'i').exec(value);
  return m !== null ? m[1]!.trim() : '';
};

const decodePartBody = (body: string, encoding: string, charset: string): string => {
  const enc = encoding.trim().toLowerCase();
  try {
    if (enc === 'base64') return bytesToString(b64ToBytes(body), charset);
    if (enc === 'quoted-printable') return bytesToString(qpToBytes(body), charset);
  } catch { /* 解码失败回退原文 */ }
  return body;
};

const humanSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;

interface LeafAcc {
  text: string;
  html: string;
  attachments: EmlAttachment[];
}

/** 递归收集叶子部件：text/* 解码进 acc，附件只记名与近似体积。 */
const collect = (headers: ParsedHeader[], body: string, acc: LeafAcc, depth: number): void => {
  if (depth > 8) return;
  const h = (name: string): string => headers.find((x) => x.name === name)?.value ?? '';
  const contentType = h('content-type') || 'text/plain; charset=utf-8';
  const encoding = h('content-transfer-encoding') || '7bit';
  const disposition = h('content-disposition');
  const boundary = headerParam(contentType, 'boundary');
  if (boundary !== '') {
    const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\s*(?:\r?\n|$)`));
    for (const part of parts) {
      const trimmed = part.replace(/^\s*\r?\n/, '');
      if (trimmed.trim() === '' || trimmed.trim() === '--') continue;
      const cut = trimmed.search(/\r?\n\r?\n/);
      const ph = cut === -1 ? trimmed : trimmed.slice(0, cut);
      const pb = cut === -1 ? '' : trimmed.slice(cut).replace(/^\r?\n\r?\n/, '');
      collect(parseHeaders(ph), pb, acc, depth + 1);
    }
    return;
  }
  const ctype = contentType.split(';')[0]!.trim().toLowerCase();
  const filename = headerParam(disposition, 'filename') || headerParam(contentType, 'name')
    || (/^message\//.test(ctype) ? 'forwarded.eml' : '');
  if (ctype === 'text/plain' && disposition.toLowerCase().indexOf('attachment') !== 0) {
    const decoded = decodePartBody(body, encoding, headerParam(contentType, 'charset') || 'utf-8');
    acc.text = acc.text === '' ? decoded : `${acc.text}\n\n${decoded}`;
    return;
  }
  if (ctype === 'text/html' && disposition.toLowerCase().indexOf('attachment') !== 0) {
    if (acc.html === '') acc.html = decodePartBody(body, encoding, headerParam(contentType, 'charset') || 'utf-8');
    return;
  }
  if (ctype === 'text/plain' || ctype === 'text/html' || filename !== '') {
    // text 部件按 attachment 处置 / 显式附件：只报名不计内容（base64 不解码）。
    const approx = encoding.trim().toLowerCase() === 'base64'
      ? Math.floor(body.replace(/[^A-Za-z0-9+/=]/g, '').length * 3 / 4)
      : body.length;
    acc.attachments.push({ filename: decodeMimeWords(filename) || ctype, sizeLabel: humanSize(approx) });
  }
};

export const parseEml = (raw: string): EmlView => {
  const cut = raw.search(/\r?\n\r?\n/);
  const headerBlock = cut === -1 ? raw : raw.slice(0, cut);
  const bodyBlock = cut === -1 ? '' : raw.slice(cut).replace(/^\r?\n\r?\n/, '');
  const headers = parseHeaders(headerBlock);
  const h = (name: string): string => headers.find((x) => x.name === name)?.value ?? '';
  const acc: LeafAcc = { text: '', html: '', attachments: [] };
  collect(headers, bodyBlock, acc, 0);
  return {
    subject: decodeMimeWords(h('subject')) || '(无主题)',
    from: decodeMimeWords(h('from')),
    to: decodeMimeWords(h('to')),
    cc: decodeMimeWords(h('cc')),
    date: h('date'),
    text: acc.text,
    html: acc.html,
    attachments: acc.attachments,
    rawSizeLabel: humanSize(raw.length),
    raw,
  };
};

const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 渲染进容器：头卡 + 正文（原样优先）+ 附件清单 + 原文物证折叠（截断）。 */
export const renderEml = (container: { innerHTML: string; append: (n: never) => void }, raw: string): void => {
  const v = parseEml(raw);
  const rows: string[] = [];
  const row = (k: string, val: string): void => {
    if (val !== '') rows.push(`<span class="k">${k}</span><span class="v">${escHtml(val)}</span>`);
  };
  row('主题', v.subject);
  row('发件人', v.from);
  row('收件人', v.to);
  row('抄送', v.cc);
  row('时间', v.date);
  const atts = v.attachments.length > 0
    ? `<div class="eml-atts">${v.attachments.map((a) => `<span class="chip">📎 ${escHtml(a.filename)} · ${escHtml(a.sizeLabel)}</span>`).join('')}</div>`
    : '';
  let bodyHtml = '';
  if (v.text !== '') {
    bodyHtml = `<pre class="dl-body body-text">${escHtml(v.text)}</pre>`;
  } else if (v.html !== '') {
    bodyHtml = `<iframe sandbox class="dl-frame" srcdoc="${escHtml(v.html)}"></iframe>`;
  } else {
    bodyHtml = '<div class="muted" style="font-size:12px">(无可读正文部件)</div>';
  }
  const RAW_CAP = 400_000;
  const rawShown = v.raw.length > RAW_CAP;
  const rawPreview = escHtml(rawShown ? v.raw.slice(0, RAW_CAP) : v.raw);
  container.innerHTML = `
    <div class="eml-card">
      <div class="gc-rows">${rows.join('')}</div>
      ${atts}
      <div class="eml-body">${bodyHtml}</div>
      <details style="margin-top:8px"><summary class="muted" style="font-size:12px">查看原始 eml（物证 · ${escHtml(v.rawSizeLabel)}${rawShown ? ' · 已截断' : ''}）</summary><pre class="dl-body">${rawPreview}</pre></details>
    </div>`;
};
