// macOS 桌面通知（对应 Go internal/delivery/notify）：terminal-notifier 可点击
// 优先，osascript 兜底；前台检测（应用在最前时不打扰）。尽力而为：失败只
// 记日志，绝不阻塞调用方。

import { execFile } from 'node:child_process';

export interface NotifyDeps {
  readonly run?: (cmd: readonly string[]) => Promise<void>;
  readonly frontmost?: () => Promise<boolean>;
  readonly platform?: string;
  readonly log?: (m: string) => void;
}

const runDefault = (cmd: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(cmd[0] ?? '', cmd.slice(1), { timeout: 5000 }, (e) => (e ? reject(e) : resolve()));
  });

/** 应用是否处于前台（最前 = 用户正盯着，无需打扰）。 */
const frontmostDefault = async (): Promise<boolean> => {
  const out = await new Promise<string>((resolve) => {
    execFile('osascript', ['-e',
      'tell application "System Events" to get name of first process whose frontmost is true',
    ], { timeout: 3000 }, (e, stdout) => resolve(e ? '' : stdout.trim().toLowerCase()));
  });
  return out.includes('juli') || out.includes('terminal');
};

export const createDesktopNotifier = (deps: NotifyDeps = {}): ((title: string, body: string) => Promise<void>) => {
  const run = deps.run ?? runDefault;
  const frontmost = deps.frontmost ?? frontmostDefault;
  const platform = deps.platform ?? process.platform;
  const log = deps.log ?? (() => undefined);
  return async (title, body) => {
    if (platform !== 'darwin') return; // 非 macOS：桌面通知不存在，推送链已覆盖
    try {
      if (await frontmost().catch(() => false)) return; // 用户正盯着——免打扰
      // terminal-notifier 优先（可点击）；不可用退 osascript。
      try {
        await run(['terminal-notifier', '-title', title, '-message', body, '-sound', 'default']);
      } catch {
        await run(['osascript', '-e', `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`]);
      }
    } catch (e) {
      log(`[notify] ${String(e).slice(0, 120)}`);
    }
  };
};
