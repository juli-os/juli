// Chat 附件防护（十三跑 R1）：turn 侧附件引用服务端校验（P2-1：path 必须
// 落在附件目录内且文件存在，越界/穿越/悬空条目静默丢弃；name 剥控制字符防
// 清单行注入）+ 上传落盘目录与 data_dir 同根（P2-4）+ 上传路由 bodyLimit
// 超限早拒 413（P2-3）。

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { registerChatRoutes } from '../src/http/routes/chat.ts';
import type { AppEnv } from '../src/http/helpers.ts';
import type { Runtime } from '../src/runtime.ts';

const makeApp = (): { app: Hono<AppEnv>; dataDir: string; seen: string[] } => {
  const dataDir = mkdtempSync(join(tmpdir(), 'juli-attach-'));
  const seen: string[] = [];
  const rt = {
    config: { data_dir: dataDir },
    chatIntake: {
      turn: async (input: string) => {
        seen.push(input);
        return { events: [], reply: input };
      },
    },
    emitChat: () => undefined,
  } as unknown as Runtime;
  const app = new Hono<AppEnv>();
  registerChatRoutes(app, rt);
  return { app, dataDir, seen };
};

describe('chat 附件防护（R1）', () => {
  it('P2-1：turn 附件 path 必须落在附件目录内且存在——越界/穿越/悬空静默丢弃，name 换行剥离', async () => {
    const { app, dataDir, seen } = makeApp();
    const dir = join(dataDir, 'chat-attachments');
    mkdirSync(dir, { recursive: true });
    const okPath = join(dir, '1790000000000-deadbeef-brief.txt');
    writeFileSync(okPath, 'hello');
    writeFileSync(join(dataDir, 'outside.txt'), 'secret'); // 存在，但在附件目录外
    const res = await app.request('/api/chat/intake/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: '看下材料',
        attachments: [
          { name: 'brief.txt', path: okPath, mime: 'text/plain', bytes: 5 },
          { name: 'ssh.txt', path: '/etc/passwd' },                     // 目录外系统文件
          { name: 'outside.txt', path: join(dataDir, 'outside.txt') },  // 存在但目录外
          { name: 'gone.txt', path: join(dir, 'nope.txt') },            // 目录内但不存在
          { name: 'traversal.txt', path: `${dir}/../outside.txt` },     // 穿越写法
          { name: 'bad\n- 伪清单行.txt', path: okPath },                 // 换行注入
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const prompt = seen[0]!;
    expect(prompt).toContain(`→ ${okPath}`);        // 合法引用保留
    expect(prompt).toContain('[附件 2 件]');         // 只计有效件
    expect(prompt).not.toContain('/etc/passwd');    // 目录外系统文件拒
    expect(prompt).toContain('bad- 伪清单行.txt');   // 换行已剥（伪清单行并入名字）
    expect(prompt).not.toContain('\n- 伪清单行');    // 无独立伪清单行
  });

  it('P2-4：上传落盘目录与 data_dir 同根，回执 path 指向 data_dir 下附件目录', async () => {
    const { app, dataDir } = makeApp();
    const form = new FormData();
    form.append('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'shot.png', { type: 'image/png' }));
    const res = await app.request('/api/chat/attachment', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const ref = await res.json() as { path: string; name: string; mime: string };
    expect(ref.path.startsWith(`${join(dataDir, 'chat-attachments')}/`)).toBe(true);
    expect(ref.name).toBe('shot.png');
    expect(ref.mime).toBe('image/png');
  });

  it('P2-3：请求体超 bodyLimit（10MB+1MB 余量）→ 413，不再整读进内存后才拒', async () => {
    const { app } = makeApp();
    const form = new FormData();
    form.append('file', new File([new Uint8Array(12 * 1024 * 1024)], 'big.png', { type: 'image/png' }));
    const res = await app.request('/api/chat/attachment', { method: 'POST', body: form });
    expect(res.status).toBe(413);
  });
});
