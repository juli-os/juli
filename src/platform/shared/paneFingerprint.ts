// pane 文本指纹判定的纯函数族（2026-09-28 提问卡单修复）：platform/agents
// 的探针与 business/workflow 的僵尸看门狗共用同一口径——「什么算等输入」
// 是跨层共识，住在 shared 零依赖（arch 围栏：workflow 不 import agents）。

/** 「等输入」判定：编号选择菜单（权限/选项）+ CC 权限问句指纹。这是
 * 「等人的健康态」不是僵尸——看门狗豁免 + 通知人，绝不打断。 */
export const paneAwaitingInput = (pane: string): boolean =>
  /❯\s*\d|[1-9]\.\s+(yes|no|allow|deny)/i.test(pane)
  || /\b(do you want|would you like|waiting for your|awaiting your)\b/i.test(pane);

export interface PaneQuestionOption {
  readonly label: string; // 审批卡按钮文案（含编号）
  readonly reply: string; // 回流进会话的答案（菜单=编号，自由题=文本）
}
export interface PaneQuestion {
  readonly question: string;
  readonly options: readonly PaneQuestionOption[];
}

/** 从 pane 文本解析「agent 的问题 + 选项」（问询闸门的内容源，2026-09-28）。
 * CC 权限/选择菜单 = 编号行（❯ 1. Yes / 2. No…）——选项 reply 用编号（菜单
 * 键盘选择语义）；无菜单（开放提问）= 通用同意/拒绝 + 自定义兜底。 */
export const parsePaneQuestion = (pane: string, fallbackMessage = ''): PaneQuestion => {
  const opts: PaneQuestionOption[] = [];
  const seen = new Set<string>();
  for (const raw of pane.split('\n')) {
    const m = /^\s*[❯>\s]*(\d)\.\s+(.{1,90})$/.exec(raw);
    if (m !== null) {
      const num = m[1] ?? '';
      const label = (m[2] ?? '').trim();
      if (num !== '' && !seen.has(num)) {
        seen.add(num);
        opts.push({ label: `${num}. ${label}`, reply: num });
      }
    }
    if (opts.length >= 5) break;
  }
  // 问题文本：hook message 优先（CC 的人话自报）；缺省取菜单上方最后一段
  // 非选项非空行。
  let question = fallbackMessage.trim();
  if (question === '') {
    const lines = pane.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i] ?? '';
      if (!/^\s*[❯>\s]*\d\./.test(ln)) { question = ln.slice(0, 200); break; }
    }
  }
  if (question === '') question = 'agent 在等你回答';
  const options = opts.length >= 2 ? opts
    : [{ label: '同意继续（yes）', reply: 'yes' }, { label: '拒绝（no）', reply: 'no' }];
  return { question, options };
};
