// 编排器 /api/chat + 语音通话 + 快照/恢复 + 用量统计。
// 分层重构（2026-09-23）：自 app.ts 按资源族拆出，路由注册体逐字保留。

import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { toWireFrame } from '../../platform/ws/wirehubs.ts';
import type { Runtime } from '../../runtime.ts';
import { bodyStr, clampInt, readBody, type AppEnv } from '../helpers.ts';

export const registerChatRoutes = (app: Hono<AppEnv>, rt: Runtime): void => {
  // ---- 编排器（/api/chat）+ 语音通话 + 快照 --------------------------------------
  // iOS 兼容：把本轮聊天事件镜像进 chatHub（/ws/chat 的 wire 帧由此流出）。
  const mirrorChatEvents = (events: readonly unknown[]): void => {
    for (const e of events) {
      const f = toWireFrame((e ?? {}) as Record<string, unknown>);
      if (f) rt.emitChat(f.type, f.data);
    }
  };

  app.post('/api/chat', async (c) => {
    if (!rt.orchestrator) return c.json({ error: 'orchestrator not configured (missing llm key)' }, 503);
    const body = await readBody(c);
    const input = bodyStr(body, 'input');
    if (input.trim() === '') return c.json({ error: 'input required' }, 400);
    const events: unknown[] = [];
    // 通话激活 → 走语音状态机（模式前缀/plan 暂存/确认短语）。
    if (rt.voiceCall) {
      const t = await rt.voiceCall.turn(input);
      mirrorChatEvents(t.events);
      return c.json({ events: t.events, reply: t.reply });
    }
    await rt.orchestrator.handle(input, (e) => events.push(e));
    mirrorChatEvents(events);
    return c.json({ events });
  });

  app.get('/api/chat/history', (c) => {
    if (!rt.chatHub) return c.json({ history: [] });
    return c.json({ history: rt.chatHub.replay() });
  });

  app.post('/api/chat/cancel', (c) => {
    // TS 版编排器为单轮请求作用域（无后台生成可取消）——返回已确认的空操作。
    return c.json({ ok: true, note: 'request-scoped: nothing to cancel' });
  });

  app.post('/api/chat/call', async (c) => {
    const body = await readBody(c);
    const mode = bodyStr(body, 'mode', 'plan');
    const call = rt.openVoiceCall(mode as 'chat' | 'plan' | 'query');
    if (!call) return c.json({ error: 'orchestrator not configured (missing llm key)' }, 503);
    return c.json({ ok: true, mode: call.mode });
  });

  app.post('/api/chat/confirm', async (c) => {
    const events = await rt.confirmVoicePlan();
    mirrorChatEvents(events);
    return c.json({ events });
  });
  app.post('/api/chat/deny', async (c) => {
    const events = await rt.denyVoicePlan();
    mirrorChatEvents(events);
    return c.json({ events });
  });

  app.post('/api/snapshot', async (c) => c.json({ sessions: await rt.takeSnapshotNow() }));
  app.post('/api/recover', async (c) => c.json({ recovered: await rt.recoverNow() }));

  app.get('/api/usage/stats', (c) => {
    const hours = clampInt(c.req.query('hours'), 24, 1, 24 * 30);
    return c.json(rt.usage.stats(hours));
  });

  app.get('/api/usage/timeline', (c) => {
    const hours = clampInt(c.req.query('hours'), 24, 1, 24 * 30);
    return c.json({ points: rt.usage.timeline(hours) });
  });

  // ---- 开单对话（09-29）：clarify loop → 确认开单（startTask 正门）-------
  // 事件复用 chatHub 镜像（chat:X → 线上 X），/ws/chat 的客户端零改动吃到。

  // ---- Chat 附件（wf_3310501a9fe4，2026-10-05）：multipart 上传 →
  // 落 chat-attachments/ 常驻；turn 携带引用，清单+服务端路径注入 prompt
  // （agent 按路径自行读取消费）。≤10MB/件，后缀白名单，文件名净化。
  // R1 P2-4：目录与数据面同根（data_dir）——原 homedir() 拼死在自定义
  // data_dir 部署时附件落 HOME 而非数据卷（备份/迁移漏网）；旧 HOME 目录
  // 保留为只读兼容（部署切换瞬间在途的存量回执引用不悬空）。
  const ATTACH_DIR = join(rt.config.data_dir, 'chat-attachments');
  const LEGACY_ATTACH_DIR = join(homedir(), '.juli-service', 'chat-attachments');
  const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
  const ATTACH_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.pdf',
    '.txt', '.md', '.json', '.csv', '.docx', '.xlsx', '.pptx', '.zip',
  ]);
  const sanitizeName = (s: string): string =>
    s.replace(/[/\\]/g, '_').replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 120) || 'file';

  interface ChatAttachRef {
    id: string; name: string; mime: string; bytes: number; path: string;
  }

  app.post('/api/chat/attachment',
    // R1 P2-3：先验体量再读体——bodyLimit 有 content-length 头即早拒（不
    // 缓冲），无头则流式计数封顶；原实现 parseBody() 整读进内存后才 413，
    // 任意大请求体都吃满内存。10MB 附件 + multipart 编码余量。
    bodyLimit({
      maxSize: ATTACH_MAX_BYTES + 1024 * 1024,
      onError: (c) => c.json({ error: '请求体过大（附件上限 10MB）' }, 413),
    }),
    async (c) => {
      const body = await c.req.parseBody();
      const file = body['file'];
      if (!(file instanceof File)) return c.json({ error: 'file field required (multipart)' }, 400);
      if (file.size > ATTACH_MAX_BYTES) {
        return c.json({ error: `文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），上限 10MB` }, 413);
      }
      const name = sanitizeName(file.name ?? 'file');
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
      if (ext === '' || !ATTACH_EXTS.has(ext)) {
        return c.json({ error: `不支持的类型 ${ext || '(无后缀)'}——图片/pdf/文档/表格/zip 可以` }, 415);
      }
      mkdirSync(ATTACH_DIR, { recursive: true });
      const id = `${Date.now()}-${randomBytes(4).toString('hex')}`;
      const path = join(ATTACH_DIR, `${id}-${name}`);
      writeFileSync(path, Buffer.from(await file.arrayBuffer()));
      const ref: ChatAttachRef = {
        id, name,
        mime: file.type || 'application/octet-stream',
        bytes: file.size, path,
      };
      return c.json(ref);
    });

  app.post('/api/chat/intake/turn', async (c) => {
    if (!rt.chatIntake) return c.json({ error: 'chat intake not configured (missing llm key)' }, 503);
    // 旧语音状态机与 intake loop 共用 chatHub 镜像——并存会串台（审查
    // P2），开着通话先拒。
    if (rt.voiceCall) return c.json({ error: 'voice call active — end it first' }, 409);
    const body = await readBody(c);
    let input = bodyStr(body, 'input');
    if (input.trim() === '') return c.json({ error: 'input required' }, 400);
    // 附件注入（wf_3310501a9fe4）：清单+服务端路径并入 prompt——LLM/后续
    // agent 按路径读取；开单时该文本随 brief 保留，材料不丢线。
    // R1 P2-1：客户端回执不再全信——path 必须 resolve 后落在附件目录内
    // （新 data_dir 目录或旧 HOME 目录）且文件存在，越界/穿越/悬空条目
    // 静默丢弃；name/mime 剥控制字符，防换行注入伪清单行。
    const stripCtl = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, '');
    const pathInAttachDir = (p: string): boolean => {
      const rp = resolve(p);
      return [ATTACH_DIR, LEGACY_ATTACH_DIR].some((dir) => rp === dir || rp.startsWith(dir + sep))
        && existsSync(rp);
    };
    const atts = Array.isArray(body['attachments'])
      ? (body['attachments'] as unknown[]).flatMap((a): Record<string, unknown>[] => {
          if (typeof a !== 'object' || a === null) return [];
          const rec = a as Record<string, unknown>;
          if (typeof rec['name'] !== 'string' || typeof rec['path'] !== 'string') return [];
          return pathInAttachDir(rec['path']) ? [rec] : [];
        })
      : [];
    if (atts.length > 0) {
      const lines = atts.slice(0, 5).map(a => {
        const mime = typeof a['mime'] === 'string' ? stripCtl(a['mime']) : '?';
        const bytes = typeof a['bytes'] === 'number' ? a['bytes'] : 0;
        return `- ${stripCtl(String(a['name']))} (${mime}, ${(bytes / 1024).toFixed(0)}KB) → ${String(a['path'])}`;
      });
      input += `\n\n[附件 ${atts.length} 件]\n${lines.join('\n')}`;
    }
    // 实时镜像：LLM 多轮回合可达 30s+，事件逐帧进 chatHub（iOS 客户端
    // 靠 /ws/chat 帧渲染）——憋到回合结束才镜像=全程死机感（0929 实证）。
    const mirrorLive = (e: unknown): void => {
      const f = toWireFrame((e ?? {}) as Record<string, unknown>);
      if (f) rt.emitChat(f.type, f.data);
    };
    const t = await rt.chatIntake.turn(input, {
      voice: body['voice'] === true,
      onEvent: mirrorLive,
    });
    return c.json({ events: t.events, reply: t.reply });
  });

  app.post('/api/chat/intake/confirm', async (c) => {
    if (!rt.chatIntake) return c.json({ error: 'chat intake not configured (missing llm key)' }, 503);
    if (rt.voiceCall) return c.json({ error: 'voice call active — end it first' }, 409);
    // 计划卡「本单免批」勾选（2026-10-07）：客户端 control 面，LLM 计划块
    // 里写什么都不认——只有 confirm body 的人为勾选生效。
    const body = (await readBody(c).catch(() => ({}))) as Record<string, unknown>;
    const r = await rt.chatIntake.confirm({ autoApprove: body['auto_approve'] === true });
    mirrorChatEvents(r.events);
    return c.json({ events: r.events, runId: r.runId });
  });

  app.post('/api/chat/intake/deny', async (c) => {
    if (!rt.chatIntake) return c.json({ error: 'chat intake not configured (missing llm key)' }, 503);
    const r: { events: unknown[] } = rt.chatIntake.deny();
    mirrorChatEvents(r.events);
    return c.json({ events: r.events });
  });

  app.get('/api/chat/intake/state', (c) => {
    if (!rt.chatIntake) return c.json({ phase: 'discuss', plan: null });
    return c.json(rt.chatIntake.state());
  });

};
