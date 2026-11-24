// 编排器 /api/chat + 语音通话 + 快照/恢复 + 用量统计。
// 分层重构（2026-09-23）：自 app.ts 按资源族拆出，路由注册体逐字保留。

import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { parseCallMode } from '@juli-os/agents';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { toWireFrame } from '../../platform/ws/wirehubs.ts';
import { sanitizeConv } from '../../business/intake/chatIntakeRegistry.ts';
import type { Runtime } from '../../runtime.ts';
import { bodyStr, clampInt, operatorFaceBlocked, readBody, tenantFilterOf, tenantScopeOf, type AppEnv } from '../helpers.ts';

export const registerChatRoutes = (app: Hono<AppEnv>, rt: Runtime): void => {
  // ---- 租户收口（2026-11-08 提案 A2）-----------------------------------------
  // conv 门：one 身份只能触达本租户登记的 conv；他租户 conv 一律拦——与不存在
  // 同响应。没登记的 conv 分两种：线程里已经有内容 = A2 之前的存量线程（只进
  // all）→ 拦；确实是新线程 → 放行，首次取实例时按发起方租户登记
  // （chatIntakeFor 的 tenant 参数）。
  // 「有没有内容」问 chatHub 的帧环，不问登记表（2026-11-11 A-P2-5）：登记表的
  // has 与 tenantOf 读的是同一张表，没登记时两个都是空——旧写法「未登记存量
  // 一律 404」那一支永远不成立，one 身份对存量线程调一次接口（GET 也行）就把
  // 它登记到自己名下，随后回放出线程里已有的内容。
  const convBlocked = (c: Context<AppEnv>, conv: string): boolean => {
    const scope = tenantScopeOf(c);
    if (scope.kind === 'all') return false;
    const reg = rt.chatConvTenant(conv);
    if (reg !== null) return reg !== scope.tenant;
    return rt.chatHub ? rt.chatHub.replay(conv).length > 0 : false;
  };
  /** 本租户会话名单（A1 bySession 反查，含内置老会话别名）。 */
  const tenantSessions = (tenant: string): readonly string[] =>
    Object.entries(rt.tenants.bySession).filter(([, t]) => t === tenant).map(([s]) => s);
  // ---- 编排器（/api/chat）+ 语音通话 + 快照 --------------------------------------
  // iOS 兼容：把本轮聊天事件镜像进 chatHub（/ws/chat 的 wire 帧由此流出）。
  // conv 分线程（2026-10-17）：镜像必须落到发起回合的那条线程——
  // mirrorChatEvents 一律带 conv，不带=main（旧单线程语义）。
  const mirrorChatEvent = (e: unknown, conv: string): void => {
    const f = toWireFrame((e ?? {}) as Record<string, unknown>);
    if (f) rt.emitChat(f.type, f.data, conv);
  };
  const mirrorChatEvents = (events: readonly unknown[], conv = 'main'): void => {
    for (const e of events) mirrorChatEvent(e, conv);
  };
  const convOf = (c: { req: { query(key: string): string | undefined } }): string =>
    sanitizeConv(c.req.query('conv'));

  // 运营面（A-P1-5）：主线程编排器对 one 身份 404。编排器手里的工具能读任意
  // 终端、往任意终端发文本（runtime makeAllTools），没有按租户过滤——租户视角
  // 一律不给进；语音的 call/confirm/deny 驱动的是同一个编排器，同拦。挂断
  // （call/hangup）不拦：webapp 在任何视角都靠它收尾服务器侧通话。
  app.post('/api/chat', async (c) => {
    if (operatorFaceBlocked(c)) return c.json({ error: 'not found' }, 404);
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
    // conv 分线程：带 ?conv= 只回该线程帧；不带=全量（旧客户端兼容）。
    // 租户收口（A2）：one 身份只回放本租户登记的 conv，他租户/未登记 = 零帧。
    const conv = convOf(c);
    const scope = tenantScopeOf(c);
    if (scope.kind === 'one' && rt.chatConvTenant(conv) !== scope.tenant) return c.json({ history: [] });
    return c.json({ history: rt.chatHub.replay(conv) });
  });

  app.post('/api/chat/cancel', (c) => {
    // TS 版编排器为单轮请求作用域（无后台生成可取消）——返回已确认的空操作。
    return c.json({ ok: true, note: 'request-scoped: nothing to cancel' });
  });

  app.post('/api/chat/call', async (c) => {
    if (operatorFaceBlocked(c)) return c.json({ error: 'not found' }, 404);
    const body = await readBody(c);
    // mode 白名单收口：bodyStr 来的是任意字符串，原 `as CallMode` 强转对伪值
    // 是谎言——createVoiceCall 查 callModeConfigs[mode] 得 undefined，通话一开
    // 全部 turn 抛 500，且 voiceState 无出径（无挂断端点）只能重启。走包内
    // parseCallMode（唯一事实源，伪值回退 plan）。
    const mode = parseCallMode(bodyStr(body, 'mode', 'plan'));
    const call = rt.openVoiceCall(mode);
    if (!call) return c.json({ error: 'orchestrator not configured (missing llm key)' }, 503);
    return c.json({ ok: true, mode: call.mode });
  });

  // 挂断（P0，2026-10-27）：此前 voiceState.call 有进无出——通话一开
  // turn/confirm/deny 永久 409 直到进程重启。幂等：无在途通话也回 ok
  // （客户端挂断不依赖服务端在途状态，重复点/迟到包无害）。
  app.post('/api/chat/call/hangup', (c) => {
    rt.closeVoiceCall();
    return c.json({ ok: true });
  });

  app.post('/api/chat/confirm', async (c) => {
    if (operatorFaceBlocked(c)) return c.json({ error: 'not found' }, 404);
    const events = await rt.confirmVoicePlan();
    mirrorChatEvents(events);
    return c.json({ events });
  });
  app.post('/api/chat/deny', async (c) => {
    if (operatorFaceBlocked(c)) return c.json({ error: 'not found' }, 404);
    const events = await rt.denyVoicePlan();
    mirrorChatEvents(events);
    return c.json({ events });
  });

  app.post('/api/snapshot', async (c) => c.json({ sessions: await rt.takeSnapshotNow() }));
  app.post('/api/recover', async (c) => c.json({ recovered: await rt.recoverNow() }));

  // 租户收口（A2）：one 身份的用量只算本租户会话归属的 claude_code 行（逐
  // 会话×窗口取行，与单子计价 usageAggOf 同一 tmux_session 口径）；引擎 llm/
  // chat/jev 等不挂会话的行无租户归属，只进 all。all 原样走全量聚合。
  const scopedRows = (tenant: string, windows: readonly (readonly [string, string])[]) =>
    tenantSessions(tenant).flatMap((s) => rt.usage.perSessionWindowsRows(s, windows));

  app.get('/api/usage/stats', (c) => {
    const hours = clampInt(c.req.query('hours'), 24, 1, 24 * 30);
    const tenant = tenantFilterOf(c);
    if (tenant === undefined) return c.json(rt.usage.stats(hours));
    const end = new Date().toISOString();
    const start = new Date(Date.now() - hours * 3_600_000).toISOString();
    const rows = scopedRows(tenant, [[start, end]]);
    const byModel = new Map<string, { model: string; calls: number; inputTokens: number; outputTokens: number }>();
    for (const r of rows) {
      const m = byModel.get(r.model) ?? { model: r.model, calls: 0, inputTokens: 0, outputTokens: 0 };
      m.calls += 1; m.inputTokens += r.inputTokens; m.outputTokens += r.outputTokens;
      byModel.set(r.model, m);
    }
    return c.json({
      totalCalls: rows.length,
      totalInputTokens: rows.reduce((a, r) => a + r.inputTokens, 0),
      totalOutputTokens: rows.reduce((a, r) => a + r.outputTokens, 0),
      byModel: [...byModel.values()].sort((a, b) => b.calls - a.calls),
    });
  });

  app.get('/api/usage/timeline', (c) => {
    const hours = clampInt(c.req.query('hours'), 24, 1, 24 * 30);
    const tenant = tenantFilterOf(c);
    if (tenant === undefined) return c.json({ points: rt.usage.timeline(hours) });
    // 与 store.timeline 同口径：UTC 小时桶（created_at 前 13 字符），只出有量的桶。
    const points: { hour: string; calls: number; inputTokens: number; outputTokens: number }[] = [];
    const startMs = Date.now() - hours * 3_600_000;
    for (let t = Math.floor(startMs / 3_600_000) * 3_600_000; t <= Date.now(); t += 3_600_000) {
      const a = new Date(Math.max(t, startMs)).toISOString();
      const b = new Date(t + 3_600_000 - 1).toISOString();
      const rows = scopedRows(tenant, [[a, b]]);
      if (rows.length === 0) continue;
      points.push({
        hour: new Date(t).toISOString().slice(0, 13),
        calls: rows.length,
        inputTokens: rows.reduce((x, r) => x + r.inputTokens, 0),
        outputTokens: rows.reduce((x, r) => x + r.outputTokens, 0),
      });
    }
    return c.json({ points });
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
    if (!rt.chatIntake) return c.json({ error: 'chat intake not configured (missing llm key)' }, 503);  // 快速失败面（main 桶在=注册表在）
    // 旧语音状态机与 intake loop 共用 chatHub 镜像——并存会串台（审查
    // P2），开着通话先拒。
    if (rt.voiceCall) return c.json({ error: 'voice call active — end it first' }, 409);
    const body = await readBody(c);
    let input = bodyStr(body, 'input');
    if (input.trim() === '') return c.json({ error: 'input required' }, 400);
    const conv = convOf(c);
    if (convBlocked(c, conv)) return c.json({ error: 'conv not found' }, 404);
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
    const mirrorLive = (e: unknown): void => mirrorChatEvent(e, conv);
    const intake = rt.chatIntakeFor(conv, tenantFilterOf(c));
    if (!intake) return c.json({ error: 'chat intake not configured (missing llm key)' }, 503);
    const t = await intake.turn(input, {
      voice: body['voice'] === true,
      onEvent: mirrorLive,
    });
    return c.json({ events: t.events, reply: t.reply });
  });

  app.post('/api/chat/intake/confirm', async (c) => {
    if (!rt.chatIntake) return c.json({ error: 'chat intake not configured (missing llm key)' }, 503);  // 快速失败面（main 桶在=注册表在）
    if (rt.voiceCall) return c.json({ error: 'voice call active — end it first' }, 409);
    // 计划卡「本单免批」勾选（2026-10-07）：客户端 control 面，LLM 计划块
    // 里写什么都不认——只有 confirm body 的人为勾选生效。
    const body = await readBody(c);
    const conv = convOf(c);
    if (convBlocked(c, conv)) return c.json({ error: 'conv not found' }, 404);
    // 显式租户（A3 写侧打标记）：confirm body 的人为选择，边界校验一次。
    // 不在 stampableTenants（声明租户全集）即 400 点名；空缺省 = 引擎按
    // 进件信号自行判定。内部信任（resolveTenant 还有纵深防御闸）。
    const tenantReq = typeof body['tenant'] === 'string' ? body['tenant'].trim() : '';
    if (tenantReq !== '' && !rt.tenants.stampableTenants.has(tenantReq)) {
      return c.json({ error: `未知租户 "${tenantReq}"，可选值：${[...rt.tenants.stampableTenants].join('、')}` }, 400);
    }
    // one 身份（A-P2-8）：请求租户就是缺省的显式租户——不带 tenant 的确认不再
    // 落会话继承/缺省判定（那样可能落到别的租户，开单人自查 404）；带了别的
    // 租户 400 点名。all 身份照旧：不带 = 引擎按进件信号自行判定。
    const confirmScope = tenantScopeOf(c);
    if (confirmScope.kind === 'one' && tenantReq !== '' && tenantReq !== confirmScope.tenant) {
      return c.json({ error: `单租户身份只能给本租户开单（请求租户 ${confirmScope.tenant}，显式租户 ${tenantReq}）` }, 400);
    }
    const tenantEff = tenantReq !== '' ? tenantReq : confirmScope.kind === 'one' ? confirmScope.tenant : '';
    const intakeConfirm = rt.chatIntakeFor(conv, tenantFilterOf(c));
    if (!intakeConfirm) return c.json({ error: 'chat intake not configured (missing llm key)' }, 503);
    const autoApproveChecked = body['auto_approve'] === true;
    const r = await intakeConfirm.confirm({
      autoApprove: autoApproveChecked,
      ...(tenantEff !== '' ? { tenant: tenantEff } : {}),
    });
    mirrorChatEvents(r.events, conv);
    // gates 域登记（第 5 步）：chat 确认卡是拍板事——confirm 即决策，落
    // 审计行（proposed 卡本身活在 intake 实例内存，审计记「谁确认了哪张」）。
    if (typeof r.runId === 'string' && r.runId !== '') {
      const now = new Date().toISOString();
      rt.gates.register({ id: `cc-${r.runId}`, kind: 'chat_confirm', workflowId: r.runId, title: '开单计划确认', payload: { auto_approve: autoApproveChecked, ...(tenantEff !== '' ? { tenant: tenantEff } : {}) }, now });
      rt.gates.decide(`cc-${r.runId}`, 'approve', 'operator', autoApproveChecked ? '本单免批' : '', false, now);
    }
    return c.json({ events: r.events, runId: r.runId });
  });

  app.post('/api/chat/intake/deny', (c) => {
    // 围栏补齐（对齐 turn/confirm）：deny 也镜像 chatHub 帧——开着通话一样
    // 串台，不设防就是半开围栏。
    if (rt.voiceCall) return c.json({ error: 'voice call active — end it first' }, 409);
    const conv = convOf(c);
    if (convBlocked(c, conv)) return c.json({ error: 'conv not found' }, 404);
    const intakeDeny = rt.chatIntakeFor(conv, tenantFilterOf(c));
    if (!intakeDeny) return c.json({ error: 'chat intake not configured (missing llm key)' }, 503);
    const r: { events: unknown[] } = intakeDeny.deny();
    mirrorChatEvents(r.events, conv);
    // gates 域登记（第 5 步）：计划卡的取消也是拍板决策，落审计行。
    const denyId = `cc-deny-${conv}-${Date.now()}`;
    const now = new Date().toISOString();
    rt.gates.register({ id: denyId, kind: 'chat_confirm', title: '开单计划确认（取消）', payload: {}, now });
    rt.gates.decide(denyId, 'deny', 'operator', '', false, now);
    return c.json({ events: r.events });
  });

  app.get('/api/chat/intake/state', (c) => {
    const conv = convOf(c);
    if (convBlocked(c, conv)) return c.json({ phase: 'discuss', plan: null });
    const intakeState = rt.chatIntakeFor(conv, tenantFilterOf(c));
    if (!intakeState) return c.json({ phase: 'discuss', plan: null });
    return c.json(intakeState.state());
  });

};
