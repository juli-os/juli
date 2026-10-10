// 发送前置对账（从引擎抽出的独立模块）：词表硬拦 + URL 探活（best-effort
// 警示）+ 契约缺位标黄。网络 IO 全部经参数注入——引擎不内嵌 fetch，测试
// 注入 mock 探活即可确定性跑完全部检查（不再依赖真实网络与 3s 超时）。

/** 发送红线词表（正文硬守卫）：内部账务/工单词汇绝不出现在客户邮件里。
 * 词表是有限集且必须保守——宁可漏报走人审标黄，不可误报拦死正常回复。
 * 2026-09-15 断点九②：词表升级为 juli-reply skill §2 禁词全集的机器化
 * （wf_f4abf29e4e28 事故——内部工作笔记含「闸门/收编/简要汇报」直接出门）：
 * 新增中文词子串判据 + 英文词 \b 词边界判据（见 redlineHit）。'send' 一词
 * 太常见（客户语汇合法）刻意不入表。 */
export const DEFAULT_REDLINE_WORDS: readonly string[] = [
  'run号', '扣例', '预扣', '记账不计费', 'triage', 'credits_ledger', '内部测试工单',
  // skill §2 禁词全集（内部工作词汇）：闸门/收编/进件/工作流/工单与英文对应面。
  '闸门', '收编', '进件', '工作流', '工单', 'case-inbox', 'intake',
  'workflow', 'feedback_id', 'needs_reply',
];

/** AI 披露行标记（落款固定块的核心句，juli-reply skill §0/§4）：机械强制的
 * 判据——LLM 漏写/截断/改写落款时，宁可拒发也不许无披露的信出门。标记取
 * 披露句的稳定前缀，逗号全半角差异、纠错入口后半句的改写都不影响命中。 */
export const DISCLOSURE_MARK = '本邮件由 AI 助理答复';

/** 披露行缺失判别（发送步最后守卫与闸门 checks 共用同一判据，与 redlineHit
 * 同构）。适用面：send 步收件人结构性只认 meta.from（原发件人，缺失即拒发）
 * ——引擎不存在非回复类发送，凡客户答复按 skill 均有落款义务。 */
export const disclosureMissing = (body: string): boolean => !body.includes(DISCLOSURE_MARK);

export interface SendCheck {
  readonly name: string;
  readonly status: 'pass' | 'warn' | 'fail';
  readonly detail: string;
}

/** 纯 ASCII 词（字母/数字/下划线/连字符）——用 \b 词边界判据，防子串误伤
 * （'workflow' 不许命中 'workflowy' 这类注册商标/普通词的内部片段）。 */
const ASCII_WORD_RE = /^[a-z0-9_-]+$/i;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 红线命中（发送步最后守卫与闸门 checks 共用同一判据）。中文词子串匹配
 * （\b 对 CJK 无意义）；英文词 \b 词边界 + 大小写不敏感（Workflow/TRIAGE
 * 同拦，2026-09-15 断点九②）。 */
export const redlineHit = (body: string, words: readonly string[]): string | undefined => {
  for (const w of words) {
    if (w === '') continue;
    if (ASCII_WORD_RE.test(w)) {
      if (new RegExp(`\\b${escapeRe(w)}\\b`, 'i').test(body)) return w;
    } else if (body.includes(w)) {
      return w;
    }
  }
  return undefined;
};

/** 称呼提取：正文头部「XXX 你好/您好」形态（2-4 个汉字或拉丁名）。
 * 2026-10-01 陈莉君事故：回信对着 alice.chen@ 编造中文名。只认这一种形态
 * ——「关于XX：」这类主题式开头不误伤。 */
export const greetingNameIn = (body: string): string | undefined => {
  const m = /^([\u4e00-\u9fa5]{2,4}|[A-Za-z][A-Za-z .'-]{1,39})\s*(?:你好|您好)/.exec(body.slice(0, 60));
  return m?.[1]?.trim() || undefined;
};

/** 称呼一致性：提取的称呼与合法名集（来信显示名 + 地址 localpart 词干）
 * 对照——不符 = 疑似编造姓名，标黄进人裁决（不拒发，与口径机制同纪律）。 */
const greetingCheck = (
  body: string, senderName: string | undefined, senderAddress: string | undefined,
): SendCheck | null => {
  const name = greetingNameIn(body);
  if (name === undefined) return null;
  if (senderName === undefined || senderName === '') {
    return { name: 'greeting', status: 'warn', detail: `称呼「${name}」无法对账（来信无显示名）——请人工确认不是编造的姓名` };
  }
  const local = (senderAddress ?? '').split('@')[0] ?? '';
  const allowed = new Set([
    senderName, ...senderName.split(/[\s·]+/).filter((x) => x.length >= 2),
    ...(local !== '' ? [local, ...local.split(/[._-]+/).filter((x) => x.length >= 2)] : []),
  ]);
  const hit = [...allowed].some((a) => a.toLowerCase() === name.toLowerCase()
    || a.includes(name) || name.includes(a));
  return hit
    ? { name: 'greeting', status: 'pass', detail: `称呼「${name}」与来信人（${senderName}）一致` }
    : { name: 'greeting', status: 'warn', detail: `称呼「${name}」与来信人不符（显示名「${senderName}」${local !== '' ? ` / ${local}` : ''}）——疑似编造姓名，请人工核对` };
};

/** 正文里的 URL 提取（探活对象；mailto: 等非 http 一律不碰）。 */
export const urlsIn = (body: string): string[] =>
  [...body.matchAll(/https?:\/\/[^\s)>\]}"'，。、；]+/g)].map((m) => m[0]!).slice(0, 5);

/** URL 探活默认实现：HEAD + 3s 超时，任何异常/非 2xx 归 false（best-effort）。 */
const defaultProbeUrl = async (url: string): Promise<boolean> => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3000);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ac.signal, redirect: 'follow' }).catch(() => null);
    return res !== null && res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
};

/** 发送前置对账：词表硬拦 + URL 探活（best-effort 警示）+ 契约缺位标黄。
 * 返回的检查结果钉在发送闸门 input 上——人只判异常，不跑检查。
 * probeUrl 注入探活实现（默认真实 fetch HEAD）；probeUrls=false 跳过探活。 */
export const runSendChecks = async (
  body: string,
  opts: {
    redlineWords: readonly string[];
    hasManifest: boolean;
    feedbackRefs: readonly string[];
    probeUrls: boolean;
    probeUrl?: (url: string) => Promise<boolean>;
    /** 来信人显示名/地址（称呼一致性对账；缺省跳过该检查）。 */
    senderName?: string;
    senderAddress?: string;
  },
): Promise<SendCheck[]> => {
  const checks: SendCheck[] = [];
  const hit = redlineHit(body, opts.redlineWords);
  checks.push(hit
    ? { name: 'redline', status: 'fail', detail: `正文含红线词「${hit}」——内部词汇不得出现在客户邮件` }
    : { name: 'redline', status: 'pass', detail: '红线词表扫描通过' });
  checks.push(body.trim() !== ''
    ? { name: 'body', status: 'pass', detail: `正文非空（${body.length} 字）` }
    : { name: 'body', status: 'fail', detail: '正文为空' });
  // 披露行（2026-09-14 二轮）：落款由引擎代码拼装（composeTextBody 在 send 步
  // 必经），结构性保证在位——闸门不再判草稿，只陈述事实。
  checks.push({ name: 'disclosure', status: 'pass', detail: '落款由引擎拼装（披露行结构性在位）' });
  if (!opts.hasManifest) {
    checks.push({ name: 'contract', status: 'warn', detail: '无申报单（reply.json）——body 未走工件契约（nodes 模式无 body_ref 将拒发：正文无契约工件）' });
  } else if (opts.feedbackRefs.length === 0) {
    checks.push({ name: 'contract', status: 'warn', detail: '申报单无 feedback_refs——事实宣称未带指针，请人工核对外部实况' });
  } else {
    checks.push({ name: 'contract', status: 'pass', detail: `申报单带 ${opts.feedbackRefs.length} 个 feedback 指针` });
  }
  // 称呼一致性（2026-10-01 陈莉君事故）：编造姓名在闸门面显性化，人只判异常。
  if (opts.senderName !== undefined || greetingNameIn(body) !== undefined) {
    const g = greetingCheck(body, opts.senderName, opts.senderAddress);
    if (g !== null) checks.push(g);
  }
  if (opts.probeUrls) {
    const probe = opts.probeUrl ?? defaultProbeUrl;
    for (const url of urlsIn(body)) {
      const online = await probe(url).catch(() => false);
      checks.push(online
        ? { name: 'url_probe', status: 'pass', detail: `${url} 在线` }
        : { name: 'url_probe', status: 'warn', detail: `${url} 探活失败——宣称在线的链接请人工复核` });
    }
  }
  return checks;
};
