// agent 面：结算上报/会话列表与投递/组织声明与路由图（iOS 兼容字段勿改）。
// 分层重构（2026-09-23）：自 app.ts 按资源族拆出，路由注册体逐字保留。

import type { Hono, Context } from 'hono';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cloneBaseOf } from '../../platform/shared/sessionClone.ts';
import type { Runtime } from '../../runtime.ts';
import { clampInt, readBody, type AppEnv } from '../helpers.ts';

export const registerAgentsRoutes = (app: Hono<AppEnv>, rt: Runtime): void => {
  // ---- agent 结算上报（tmux hook / 外部执行器回调的服务端路径）----------------
  // 没有这条路由，部署形态下 agent 步只能靠僵尸扫描 3 轮后转人工。
  const sessionAction = (kind: 'stopped' | 'activity' | 'heartbeat') =>
    async (c: Context): Promise<Response> => {
      const session = c.req.param('session') ?? '';
      const body = await readBody(c);
      const status = typeof body['status'] === 'string' ? body['status'] : 'ok';
      const finalMessage = typeof body['final_message'] === 'string' ? body['final_message'] : '';
      const output = typeof body['output'] === 'string' ? body['output'] : '';
      const text = typeof body['text'] === 'string' ? body['text'] : '';
      const event = typeof body['event'] === 'string' ? body['event'] : 'hook';
      if (session === '') return c.json({ error: 'session required' }, 400);
      try {
        if (kind === 'stopped') await rt.engine.onAgentStopped(session, status, finalMessage);
        else if (kind === 'activity') await rt.engine.recordActivity(session, event, output || text);
        else rt.engine.touchSession(session);
        return c.json({ ok: true });
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    };
  app.post('/api/agents/:session/stopped', sessionAction('stopped'));
  app.post('/api/agents/:session/activity', sessionAction('activity'));
  app.post('/api/agents/:session/heartbeat', sessionAction('heartbeat'));
  // 等输入（CC Notification hook，2026-09-28）：agent 在等人——僵尸豁免 +
  // 通知人。CLI 结构化信号，比 pane 文本启发式稳。
  app.post('/api/agents/:session/awaiting', async (c) => {
    const session = c.req.param('session') ?? '';
    const body = await readBody(c);
    if (session === '') return c.json({ error: 'session required' }, 400);
    // noteAwaiting 持工作流锁（问询闸挂闸段）——hook 路径 fire-and-forget，
    // 绝不让 pane 采集/等锁阻塞 HTTP 响应；异常吞掉（尽力而为信号）。
    void rt.engine.noteAwaiting(session, typeof body['message'] === 'string' ? body['message'] : '').catch(() => undefined);
    return c.json({ ok: true });
  });

  // ---- skill 面（2026-10-02 追溯一期：目录+健康+用量聚合）--------------------
  // hook 收口：PostToolUse(matcher ^skill__) → skill_used 账本事件（entity=agent
  // 会话）。计数为方向性口径（hook 重试可能双计），去重不在此层做。
  // 精确映射登记（wf_e8d6984ba09e 三断点）：CC UserPromptSubmit hook 每回合
  // 自报 (tmux 会话, claude session_id)——prompt_usage 归属的精确来源。
  app.post('/api/agents/:session/claude-session', async (c) => {
    const session = c.req.param('session') ?? '';
    const body = await readBody(c);
    const claudeId = typeof body['claude_session_id'] === 'string' ? body['claude_session_id'] : '';
    if (session === '' || claudeId === '') return c.json({ error: 'session and claude_session_id required' }, 400);
    rt.usage.recordClaudeSessionPrecise(claudeId, session);
    return c.json({ ok: true });
  });

  app.post('/api/agents/:session/skill-used', async (c) => {
    const session = c.req.param('session') ?? '';
    const body = await readBody(c);
    const skill = typeof body['skill'] === 'string' ? body['skill'] : '';
    if (session === '' || skill === '') return c.json({ error: 'session and skill required' }, 400);
    rt.store.appendEvent('agent', session, 'skill_used', {
      skill,
      tool: typeof body['tool_name'] === 'string' ? body['tool_name'] : '',
    });
    return c.json({ ok: true });
  });

  // 技能目录：~/.claude/skills（事实源）逐 SKILL.md 解析 description；家族按
  // 目录名前缀；分发健康 = 四落点 SKILL.md 与事实源逐字一致（sync-skills.sh
  // 同款口径的轻量版）；用量 = skill_used 事件聚合（无事件=0，不伪造）。
  // 注：与 src/platform/agents/skills.ts 的 orchestrator skillRegistry（源目录
  // data_dir/skills）是两套无关体系——同名不同源，此处不复用其 parseSkill
  // （frontmatter/无 name 时它返回 null，而本表要求此类目录仍以 description=''
  // 出列），轻量 frontmatter 正则是本表有意为之。
  // 常驻声明：宪法 skill 由 planPrompt 每张任务卡强制携带（调用量恒=全量，
  // 无信息量），单列 resident 档避免按需类的频次被淹没。
  const SKILL_SYNC_TARGETS = [
    join(homedir(), '.zcode', 'skills'),
    join(homedir(), '.agents', 'skills'),
    join(homedir(), '.codex', 'skills'),
    join(homedir(), '.pi', 'agent', 'skills'),
  ];
  const RESIDENT_SKILLS: ReadonlySet<string> = new Set(['juli-constitution']);
  const skillFamily = (dirName: string): string =>
    dirName.startsWith('juli-') ? 'juli' : dirName.startsWith('team-') ? 'acme'
      : dirName.startsWith('makro-') ? 'makro' : 'tool';
  app.get('/api/skills', (c) => {
    const root = join(rt.config.claude_dir !== '' ? rt.config.claude_dir : join(homedir(), '.claude'), 'skills');
    const readDesc = (md: string): string => {
      try {
        const m = /^---\n([\s\S]*?)\n---/.exec(md);
        return new RegExp('^description:\\s*(.+)$', 'm').exec(m?.[1] ?? '')?.[1]?.trim() ?? '';
      } catch { return ''; }
    };
    const entries: Record<string, unknown>[] = [];
    if (existsSync(root)) {
      for (const d of readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('.') || d.name.startsWith('_')) continue;
        const mdPath = join(root, d.name, 'SKILL.md');
        if (!existsSync(mdPath)) continue;
        let md = '';
        let mtimeMs = 0;
        // mtime 与正文同一次 try 内取得（一次读取两用）：statSync 裸奔在 try 外
        // 是 TOCTOU 窄窗（读后被删 = 未捕获 throw = 整接口 500）。
        try { md = readFileSync(mdPath, 'utf8'); mtimeMs = statSync(mdPath).mtimeMs; } catch { continue; }
        // 健康面：事实源字节 vs 四落点字节（落点缺目录/内容漂移都不计 ok）。
        let targetsOk = 0;
        for (const t of SKILL_SYNC_TARGETS) {
          try {
            if (readFileSync(join(t, d.name, 'SKILL.md'), 'utf8') === md) targetsOk++;
          } catch { /* 落点缺席 */ }
        }
        entries.push({
          name: d.name,
          family: skillFamily(d.name),
          description: readDesc(md),
          resident: RESIDENT_SKILLS.has(d.name),
          targets_ok: targetsOk,
          targets_total: SKILL_SYNC_TARGETS.length,
          last_modified: Math.floor(mtimeMs / 1000),
          uses: 0, last_used_at: 0, sessions: [] as Record<string, unknown>[],
        });
      }
    }
    // 用量聚合：全量 skill_used 事件一次读回（稀有事件，两千行窗口绰绰有余）。
    const byName = new Map(entries.map((e) => [String(e['name']), e]));
    const perSession = new Map<string, Map<string, number>>();
    for (const ev of rt.store.listEvents(2000, ['skill_used'])) {
      const skill = String(ev.payload['skill'] ?? '');
      const e = byName.get(skill);
      if (e === undefined) continue; // 已退场的 skill 不进目录（事件仍在账本可考古）
      e['uses'] = Number(e['uses']) + 1;
      const lastAt = Date.parse(ev.ts);
      if (Number.isFinite(lastAt) && lastAt / 1000 > Number(e['last_used_at'])) {
        e['last_used_at'] = Math.floor(lastAt / 1000);
      }
      const m = perSession.get(skill) ?? new Map<string, number>();
      m.set(ev.entityId, (m.get(ev.entityId) ?? 0) + 1);
      perSession.set(skill, m);
    }
    for (const e of entries) {
      e['sessions'] = [...(perSession.get(String(e['name'])) ?? new Map<string, number>())]
        .map(([session, count]) => ({ session, count }))
        .sort((a, b) => b.count - a.count);
    }
    // 家族序（自家的在前）+ 用量序。
    const famRank: Record<string, number> = { juli: 0, acme: 1, makro: 2, tool: 3 };
    entries.sort((a, b) =>
      (famRank[String(a['family'])] ?? 9) - (famRank[String(b['family'])] ?? 9)
      || Number(b['uses']) - Number(a['uses'])
      || String(a['name']).localeCompare(String(b['name'])));
    return c.json({ skills: entries });
  });

  // ---- 会话（tmux 面板：列表/抓取/发送；完整 PTY WS 桥见 PORTING）----
  app.get('/api/sessions', async (c) => {
    if (!rt.tmux) return c.json([]);
    // 单条 list-sessions 批量取元数据（name/attached/path/当前命令）——
    // 不再逐会话 display-message（N+1 消除：一次请求一次 tmux 调用）。
    const det = await rt.tmux.listSessionsDetailed();
    if (!det.ok) return c.json([]); // tmux 缺失/不可用降级为空列表（与旧 listSessions 语义一致）
    // project 未分类必须省略键（而非空串）：iOS AgentsView 的 owns() 用
    // s.project == (p.project ?? p.name) 归属——空串会让每个 profile 认领全部会话。
    return c.json(det.value.map((s) => ({
      name: s.name, active: s.attached, working: false, unread: 0,
      agent: s.cmd.includes('claude') ? 'claude' : s.cmd.includes('codex') ? 'codex' : '',
      path: s.path,
    })));
  });

  app.post('/api/sessions', async (c) => {
    const body = await readBody(c);
    const name = typeof body['name'] === 'string' ? body['name'] : '';
    const cwd = typeof body['cwd'] === 'string' ? body['cwd'] : undefined;
    if (name === '') return c.json({ error: 'name required' }, 400);
    // 绑定会话守卫（2026-09-20 P2 预建旁路；先于 tmux 可用性判断，与
    // /api/sessions/:name/send 守卫同序）：绑定会话由引擎按配置 cwd 自建
    // （dispatch provision），不接受预建——预建可指定任意目录，项目级 skill
    // 缺席且无告警；就绪派发复用前另有 path 比对兜底（dispatch.ts）。
    if (rt.config.email.bound_agents.some((b) => b.session === name)) {
      return c.json({ error: `会话 ${name} 是绑定会话（专用 agent 隔离）——由引擎按配置自建，不接受预建` }, 403);
    }
    if (!rt.tmux) return c.json({ error: 'tmux not available' }, 503);
    const res = await rt.tmux.newSession(name, cwd || undefined);
    return res.ok ? c.json({ ok: true }) : c.json({ error: res.error.message }, 400);
  });

  app.post('/api/sessions/:name/capture', async (c) => {
    if (!rt.tmux) return c.json({ error: 'tmux not available' }, 503);
    const lines = clampInt(c.req.query('lines'), 400, 10, 5000);
    const res = await rt.tmux.capturePane(c.req.param('name') ?? '', lines);
    return res.ok ? c.json({ output: res.value }) : c.json({ error: res.error.message }, 400);
  });

  // iOS GET capture 兼容面：content 键给 iOS，output 键保 web 兼容（同一文本）；
  // 语义 = tmux capturePane(name, 2000)。
  app.get('/api/sessions/:name/capture', async (c) => {
    if (!rt.tmux) return c.json({ error: 'tmux not available' }, 503);
    const res = await rt.tmux.capturePane(c.req.param('name') ?? '', 2000);
    return res.ok
      ? c.json({ content: res.value, output: res.value })
      : c.json({ error: res.error.message }, 400);
  });

  // iOS 会话删除：杀 tmux 会话（kill 失败 = 会话不存在 → 404）。
  app.delete('/api/sessions/:name', async (c) => {
    if (!rt.tmux) return c.json({ error: 'tmux not available' }, 503);
    const res = await rt.tmux.killSession(c.req.param('name') ?? '');
    return res.ok ? c.body(null, 204) : c.json({ error: res.error.message }, 404);
  });

  app.post('/api/sessions/:name/send', async (c) => {
    const name = c.req.param('name') ?? '';
    // 绑定会话旁道守卫（2026-09-20 P1 旁道 A，与引擎 session_bound 同语义）：
    // 裸 send-keys 无闸门、无账本、无守卫——绑定会话（专用 agent 隔离）只开
    // 邮件口，会话名命中 bound_agents 一律拒。对在途步的合法递话走
    // /api/lifecycle/steps/:id/intervene（投递+留痕一体）。
    if (rt.config.email.bound_agents.some((b) => b.session === name)) {
      return c.json({
        error: `会话 ${name} 是绑定会话（专用 agent 隔离）——只接受白名单发件人的邮件通道，不开放裸文本注入；对在途步递话请用 /api/lifecycle/steps/:id/intervene`,
      }, 403);
    }
    if (!rt.tmux) return c.json({ error: 'tmux not available' }, 503);
    const body = await readBody(c);
    const text = typeof body['text'] === 'string' ? body['text'] : '';
    if (text === '') return c.json({ error: 'text required' }, 400);
    const res = await rt.tmux.sendText(c.req.param('name') ?? '', text);
    return res.ok ? c.json({ ok: true }) : c.json({ error: res.error.message }, 400);
  });

  // ---- iOS App 兼容面（Go routes.go 逐字对齐；字段名 snake_case 勿改）----------

  // Agents：juli 无 ACP 线程 → agents 恒空数组（Go 关 ACP 时同行为）；
  // history = 最近失败的 agent/verify 步（triage/gate 等 'failed' 是上游噪声，
  // 会把 iOS AgentsView 的"待处理"列表刷爆——kind 过滤收口）。
  app.get('/api/agents', (c) => {
    const limit = clampInt(c.req.query('limit'), 30, 1, 200);
    const rows = rt.store.db.prepare(
      `SELECT s.id AS step_id, s.workflow_id, s.seq, s.title, s.output, s.updated_at,
              w.title AS workflow_title, w.session AS session
       FROM workflow_steps s LEFT JOIN workflows w ON w.id = s.workflow_id
       WHERE s.status = 'failed' AND s.kind IN ('agent','verify') ORDER BY s.updated_at DESC LIMIT ?`,
    ).all(limit) as Record<string, string | number | null>[];
    const history = rows.map((r) => {
      let error = '';
      let outSession = '';
      try {
        const out = JSON.parse(String(r['output'] ?? '{}')) as Record<string, unknown>;
        error = typeof out['error'] === 'string' ? out['error'] : '';
        outSession = typeof out['session'] === 'string' ? out['session'] : '';
      } catch { /* 无 output */ }
      const wfSession = r['session'] === null ? '' : String(r['session']);
      return {
        step_id: String(r['step_id'] ?? ''), workflow_id: String(r['workflow_id'] ?? ''),
        seq: Number(r['seq'] ?? 0), title: String(r['title'] ?? ''), error,
        // session 取值回退链：w.session → 步 output JSON 的 session → 空
        session: wfSession !== '' ? wfSession : outSession,
        updated_at: String(r['updated_at'] ?? ''),
        workflow_title: r['workflow_title'] === null ? undefined : String(r['workflow_title']),
      };
    });
    return c.json({ agents: [], history });
  });

  app.get('/api/agents/profiles', async (c) => {
    // profiles 从现存 tmux 会话派生（iOS 按 profile 分组会话）；更新时间=毫秒。
    // 与 /api/sessions 同源：单条 list-sessions 批量取（N+1 消除）。
    const profiles: Record<string, unknown>[] = [];
    if (rt.tmux) {
      const det = await rt.tmux.listSessionsDetailed();
      if (det.ok) {
        for (const s of det.value) {
          profiles.push({
            name: s.name, runtime: 'tmux',
            cwd: s.path,
            model: '', launch_cmd: '', prompt_brief: '',
            updated_at: Date.now(),
          });
        }
      }
    }
    return c.json({ profiles });
  });
  app.put('/api/agents/profiles', (c) => c.body(null, 204));
  app.delete('/api/agents/profiles', (c) => c.body(null, 204));

  // Agent Mesh 图（板D「一张活图」的引擎唯一供给）：结构=agents 声明展开，
  // 活动=账本 route_decision 回放。任何端（web/iOS/dispatcher）retrieve 同
  // 一份只读投影——图上每一笔都指回声明或账本，无第三份真相。必须在
  // /api/agents/:id 通配之前注册。
  // tmux 快照短缓存（3s TTL）：list-sessions 在本机间歇性 1~5.5s（tmux server
  // 老毛病），graph 每次同步等它曾把首屏拖到 ~10s。视图 3s 节流刷新，TTL 内的
  // 陈旧 ≤1 个刷新周期，live/working 感知不受影响；tmux 报错时沿用上一份快照。
  let tmuxSnapAt = 0;
  let tmuxSnap: readonly { name: string; attached: boolean; path: string; cmd: string }[] = [];
  const tmuxLive = async (): Promise<typeof tmuxSnap> => {
    if (Date.now() - tmuxSnapAt < 3000 || rt.tmux === null) return tmuxSnap;
    const det = await rt.tmux.listSessionsDetailed();
    if (det.ok) { tmuxSnap = det.value; tmuxSnapAt = Date.now(); }
    return tmuxSnap;
  };
  app.get('/api/agents/graph', async (c) => {
    const decls = rt.config.agents;
    const bound = rt.config.email.bound_agents;
    const declBy = new Map(decls.map((d) => [d.session, d]));
    // 活态：tmux 现存会话（与 /api/sessions 同源单次批量；快照走 3s TTL 缓存）。
    const live = new Map<string, { agent: string; path: string; working: boolean }>();
    if (rt.tmux) {
      for (const s of await tmuxLive()) {
        live.set(s.name, {
          agent: s.cmd.includes('claude') ? 'claude' : s.cmd.includes('codex') ? 'codex' : '',
          path: s.path,
          working: false,
        });
      }
    }
    // 克隆规则与 iOS owns() 同源（单一事实源 shared/sessionClone.ts）：
    // name-<纯数字> 且 base 存在 → 挂卡不占顶层。
    const known = new Set<string>([...declBy.keys(), ...bound.map((b) => b.session), ...live.keys()]);
    const cloneOf = (name: string): string | null => {
      const base = cloneBaseOf(name);
      return base !== null && known.has(base) ? base : null;
    };
    const names = [...new Set<string>([...declBy.keys(), ...bound.map((b) => b.session), ...live.keys()])];
    const nodes = names.map((name) => {
      const d = declBy.get(name);
      const b = bound.find((x) => x.session === name);
      const lv = live.get(name);
      return {
        name,
        clone_of: cloneOf(name),
        company: d?.company ?? '',
        domain: d?.domain ?? '',
        bind_senders: b?.senders ?? [],
        cwd: b?.cwd || d?.cwd || lv?.path || '',
        agent: lv?.agent ?? '',
        // 占用真源（0930 忙闲重定义）：名下存在非终态单（排队/在跑/停在
        // 闸门等批准）= 占用——与派发面改道、routeTask 同一谓词。「此刻正在
        // 干活」由 SSE 通讯动画轴表达，不占此字段。
        working: rt.store.sessionHasOpenWork(name),
        live: lv !== undefined,
      };
    });
    const companies = [...new Set(nodes.filter((n) => n.company !== '' && n.clone_of === null).map((n) => n.company))];
    const domains = [...new Set(decls.filter((d) => d.domain !== '').map((d) => `${d.company}|${d.domain}`))]
      .map((k) => { const [company, name] = k.split('|'); return { company, name }; });
    // 活动回放：route_decision（最近分发）+ route_fallback/session_bound_route（审计行）。
    const evs = rt.store.listEvents(1500);
    const recent = evs
      .filter((e) => e.type === 'route_decision')
      .slice(0, 10)
      .map((e) => ({ id: e.id, ts: e.ts, workflow: e.entityId, ...e.payload }));
    const audit = evs
      .filter((e) => e.type === 'route_fallback' || e.type === 'session_bound_route'
        || e.type === 'route_content_handoff' || e.type === 'route_busy_divert')
      .slice(0, 20)
      // route_fallback 是 step 事件（entityId=step id）——workflow 真值在
      // payload.workflow_id（stepEvent 注入）；session_bound_route 直接是 workflow。
      .map((e) => {
        const p = e.payload as Record<string, unknown>;
        return { id: e.id, ts: e.ts, kind: e.type,
          workflow: (typeof p['workflow_id'] === 'string' ? p['workflow_id'] : e.entityId), ...p };
      });
    return c.json({
      default_session: rt.config.email.default_session,
      companies, domains, nodes, recent, audit,
    });
  });

  app.get('/api/agents/:id', (c) => c.json({ error: 'no acp threads' }, 404));
  app.delete('/api/agents/:id', (c) => c.body(null, 204));

  // 会话产物（Go artifact_service 语义：中心目录扁平列表，裸数组）。
  // 数据源两处：遗留 makro 中心库（~/.makro/artifacts/<session>/）+ juli
  // 自有产物库（排除 customers/——那是客户合同文档，走客户详情页）。
  // iOS 会话页辅助动作（juli 语义下为已确认空操作）。
  app.post('/api/sessions/:name/viewed', (c) => c.body(null, 204));
  app.post('/api/sessions/:name/start-agent', (c) => c.body(null, 204));

};
