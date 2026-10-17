// CC（Claude Code）transcript 扫描规则（R8 批4 刀3，自 runtime.ts 摄取定时器
// 抽出的纯函数核）：runtime 只留 IO 接线（tmux exec / 文件系统 / usage 账本），
// 规则本体（会话出生点解析 + mtime 门）在此可直测——此前人机混仓防线长在
// 定时器闭包里零直测。

/** tmux `list-sessions -F '#{session_name}\t#{session_created}'` 输出 → 会话
 * 出生点表（epoch 秒 → ms）。坏行（空名/非数字/非正数）静默剔除——出生点
 * 取不到的会话不进表，由 transcriptMappable 的 undefined 臂保守回落。 */
export const sessionBirthOf = (raw: string): ReadonlyMap<string, number> => {
  const born = new Map<string, number>();
  for (const line of raw.split('\n')) {
    const [nm, ts] = line.split('\t');
    const t = Number(ts);
    if (nm && Number.isFinite(t) && t > 0) born.set(nm.trim(), t * 1000);
  }
  return born;
};

/** 人机混仓防线（十四跑 R1 P2-2）：transcript mtime 须【新于】会话出生点才
 * 映射——live 会话 cwd 项目目录下的全部 .jsonl 整目录映射会把人用 CC 同仓
 * 的旧 transcript 划给 agent（人机混仓污染）。出生点未知（exec 失败/老 tmux
 * 取不到 created）保守回落旧行为（全映射）。边界：相等算旧（不映射）。 */
export const transcriptMappable = (mtimeMs: number, bornMs: number | undefined): boolean =>
  bornMs === undefined ? true : mtimeMs > bornMs;
