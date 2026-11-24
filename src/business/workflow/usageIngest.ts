// CC transcript 摄取定时器（2026-11-12 第 7 步从 runtime.ts 搬入，归属
// usage 计价侧——costContext 同域）：每分钟增量摄取 + claude_sessions 映射
// 自动接线 + 空归属过半重放。
// wf_9658ce9225e0：ingest 的 tmux_session 归属靠 claude_sessions 映射，
// 而 recordClaudeSession 此前从未接线（映射 0 行→归属恒空→详情页
// promptStats 恒 0）。这里每轮先按 tmux pane cwd ↔ claude projects
// 目录名（cwd 的 / → - 转义）自动建映射；存量空归属行自动重放回填。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { autoMapPairs } from '../../platform/llm/transcripts.ts';
import type { UsageStore } from '@juli-os/ledger';
import type { TmuxClient } from '@juli-os/agents';
import type { AgentBackend } from '@juli-os/agents';
import type { Logger } from '../../platform/events/bus.ts';

export const startUsageIngestTimers = (deps: {
  readonly usage: Pick<UsageStore, 'recordClaudeSession' | 'needsClaudeReplay' | 'resetClaudeIngest' | 'ingestProjectTranscripts'>;
  readonly tmux: Pick<TmuxClient, 'listSessionsDetailed' | 'sessionBirthsOf'>;
  readonly agentBackend: Pick<AgentBackend, 'kind'>;
  readonly claudeDir: string;
  readonly log: Logger;
}): readonly NodeJS.Timeout[] => {
  const { usage, tmux, agentBackend, log } = deps;
  return [
    setInterval(() => {
      void (async () => {
        try {
          const projects = join(deps.claudeDir, 'projects');
          const det = await tmux.listSessionsDetailed();
          if (det.ok) {
            // 人机混仓防线规则本体（出生点 + mtime 门 + herdr 目录扫描
            // 停用，b51 R1 P1-2）在 platform/llm/transcripts（autoMapPairs）
            // ——此处只留 IO 接线：出生点表由终端契约 sessionBirthsOf
            // 提供（herdr 无此概念回空表；herdr 的目录级自动映射在
            // autoMapPairs 内整体停用——归属只走 hook 精确登记链，人用
            // CC 的旧 transcript 不再整目录误归属给 agent 会话）。
            const createdOf: ReadonlyMap<string, number> = new Map(await tmux.sessionBirthsOf());
            const pairs = autoMapPairs({
              kind: agentBackend.kind,
              sessions: det.value,
              births: createdOf,
              filesOf: (cwd) => {
                const dir = join(projects, cwd.replaceAll('/', '-'));
                if (!existsSync(dir)) return [];
                const out: { stem: string; mtimeMs: number | undefined; path: string }[] = [];
                for (const f of readdirSync(dir)) {
                  if (!f.endsWith('.jsonl')) continue;
                  let mtimeMs: number | undefined;
                  try { mtimeMs = statSync(join(dir, f)).mtimeMs; } catch { mtimeMs = undefined; }
                  out.push({ stem: f.replace(/\.jsonl$/, ''), mtimeMs, path: join(dir, f) });
                }
                return out;
              },
            });
            for (const p of pairs) usage.recordClaudeSession(p.claudeId, p.session, p.transcriptPath, p.cwd);
          }
          if (usage.needsClaudeReplay()) {
            log.info('[usage] claude_code 归属空行过半——重放 transcript 回填 tmux_session');
            usage.resetClaudeIngest();
          }
          usage.ingestProjectTranscripts(projects);
        } catch (e) {
          // 只容忍「文件/目录不存在」（2026-11-23 全量审查）：这个 catch 最早
          // 只包摄取一行，claude_dir 还没建是常态；后来往 try 里加了映射登记
          // 写库（wf_9658ce9225e0），写库出错也被当成目录缺失吞掉，日志里没有
          // 痕迹。现在 ENOENT 以外的错误一律记 error。
          const missing = e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT';
          if (!missing) log.error(`[usage] transcript 摄取出错：${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    }, 60_000),
  ];
};
