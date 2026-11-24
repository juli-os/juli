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

// ---- 目录级自动映射（b51 R1 P1-2 收口）--------------------------------------

export interface AutoMapPair {
  readonly claudeId: string;
  readonly session: string;
  readonly transcriptPath: string;
  readonly cwd: string;
}

/** 后端 × 目录级自动映射：定时器扫描「会话 cwd ↔ claude projects 目录」建
 * (claude transcript, agent 会话) 兜底映射的规则本体。
 *
 * tmux：沿用出生点 mtime 门（transcriptMappable 原语义逐值保留）——出生点
 * 已知时 stat 取不到 mtime 的候选按旧处理不映射（与原实现 stat throw →
 * continue 同语义），出生点未知保守回落全映射。
 *
 * herdr：目录级自动映射【整体停用】（b51 R1 P1-2）——herdr 无出生点
 * （sessionBirthsOf 恒空表），mtime 门恒不拦，整目录映射会把人用 CC 同仓的
 * 旧 transcript 划给 agent 会话（防线在 herdr 下静默失效，「保守回落」从降级
 * 兜底变稳态）。herdr 的归属只走 hook 精确登记链（capture/permission hook
 * → /api/agents/:s/claude-session → recordClaudeSessionPrecise；扫描兜底对
 * 已精确登记的行插不进，无覆盖风险）——人用 CC 的 transcript 不进映射。
 * filesOf 每会话 cwd 调一次：返回该项目目录下的 .jsonl 候选（stem=claude
 * 会话 id；目录缺席回空数组）。 */
export const autoMapPairs = (args: {
  kind: 'tmux' | 'herdr';
  sessions: readonly { readonly name: string; readonly path: string }[];
  births: ReadonlyMap<string, number>;
  filesOf: (cwd: string) => readonly { readonly stem: string; readonly mtimeMs: number | undefined; readonly path: string }[];
}): readonly AutoMapPair[] => {
  if (args.kind === 'herdr') return [];
  const out: AutoMapPair[] = [];
  for (const si of args.sessions) {
    const cwd = si.path;
    if (cwd === '') continue;
    const bornMs = args.births.get(si.name);
    for (const f of args.filesOf(cwd)) {
      if (bornMs !== undefined && (f.mtimeMs === undefined || !transcriptMappable(f.mtimeMs, bornMs))) continue;
      out.push({ claudeId: f.stem, session: si.name, transcriptPath: f.path, cwd });
    }
  }
  return out;
};
