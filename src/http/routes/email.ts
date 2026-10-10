// 邮件通道状态 + 开发/测试注入口（不经 IMAP 直接触发入站）。
// 分层重构（2026-09-23）：自 app.ts 按资源族拆出，路由注册体逐字保留。

import type { Hono } from 'hono';
import type { Runtime } from '../../runtime.ts';
import { readBody, type AppEnv } from '../helpers.ts';

export const registerEmailRoutes = (app: Hono<AppEnv>, rt: Runtime): void => {
  app.get('/api/email/status', (c) => {
    const email = rt.config.email;
    const src = rt.mailSource?.status();
    const live = rt.liveOverrides() as { email?: { poll_interval_sec?: number } };
    return c.json({
      enabled: email.enabled && src !== undefined,
      host: email.host,
      poll_interval_sec: live.email?.poll_interval_sec ?? email.poll_interval_sec,
      mode: rt.engine.currentAuthz().mode,
      last_poll: src?.lastPoll ?? null,
      last_ok: src?.lastOk ?? null,
      last_error: src?.lastError ?? '',
      processed: src?.processed ?? 0,
    });
  });

  // ---- 开发/测试注入口：不经 IMAP 直接触发一封入站邮件 ---------------------------
  // 生产收紧（2026-09-20 P1 旁道 B）：默认关——持 token 的调用方可伪造任意
  // 白名单发件人直达 startEmailWorkflow（含 bound 路由），邮件口从内部可伪造。
  // 测试/本机调试显式开 config email.simulate_enabled。进件自回环守卫
  // （self_echo_ignored）对本路径同样生效（共用 onEmailReceived 入口）。
  app.post('/api/email/simulate', async (c) => {
    if (!rt.config.email.simulate_enabled) {
      return c.json({ error: 'email simulate endpoint disabled — set config email.simulate_enabled=true（测试注入口，生产默认关）' }, 403);
    }
    const body = await readBody(c);
    const str = (k: string): string => (typeof body[k] === 'string' ? body[k] as string : '');
    const from = str('from');
    if (from === '') return c.json({ error: 'from required' }, 400);
    const w = await rt.engine.onEmailReceived({
      from,
      to: str('to'),
      subject: str('subject'),
      body: str('body'),
      messageId: str('message_id') || `<sim-${Date.now()}@juli.local>`,
      date: str('date') || new Date().toISOString(),
      uid: typeof body['uid'] === 'number' ? body['uid'] : 0,
      attachments: [],
    });
    return c.json({ ok: true });
  });

};
