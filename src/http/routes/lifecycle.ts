// 生命周期账本与闸门动词：workflows/events/steps 动作/队列/任务起单/节点追加/settle 族。
// 分层重构（2026-09-23）：自 app.ts 按资源族拆出，路由注册体逐字保留。

import type { Hono, Context } from 'hono';
import { stepToGo, workflowToGo } from '../../platform/shared/goShape.ts';
import { type StepKind } from '@juli-os/ledger';
import type { Runtime } from '../../runtime.ts';
import type { JsonRecord } from '@juli-os/artifacts'
import { bodyStr, clampInt, readBody, type AppEnv } from '../helpers.ts';
import { usageAggOf } from '../../business/workflow/costContext.ts';

export const registerLifecycleRoutes = (app: Hono<AppEnv>, rt: Runtime): void => {

  // ---- 生命周期 ---------------------------------------------------------------

  app.get('/api/lifecycle/workflows', (c) => {
    const limit = clampInt(c.req.query('limit'), 100, 1, 500);
    // status 可选等值过滤（NEW-2）：非法值=空结果，语义无害；不加 session 参数
    // （那要牵 meta.assigned_session JSON 面，超出本参数所需）。
    const status = c.req.query('status');
    // hold 透明化（2026-09-28）：在途单被工作窗 hold 时前端必须看得见——
    // held_ids + hold_until（窗口终点 HH:MM）随清单下发，流水页据此挂徽标。
    const qs = rt.engine.queueStatus();
    return c.json({
      workflows: rt.store.listWorkflows(limit, status),
      held_ids: [...qs.held],
      hold_until: rt.config.work_hours.mode !== 'off' ? `${rt.config.work_hours.start}–${rt.config.work_hours.end}` : '',
    });
  });

  // 单子级免批切换（2026-10-07 用户裁定：前端按单开关，非全局配置）：
  // meta.auto_approve 布尔；开=立即跑一轮 sweep（在等闸门当秒处理）；
  // 硬边界不变（问询/外发仍等人）。留痕 auto_approve_set。
  app.post('/api/lifecycle/workflows/:id/auto-approve', async (c) => {
    const id = c.req.param('id');
    const w = rt.store.getWorkflow(id);
    if (!w) return c.json({ error: 'not found' }, 404);
    const body = await readBody(c);
    const on = body['on'] === true;
    rt.store.updateWorkflowMeta(id, on ? { auto_approve: true } : { auto_approve: null });
    rt.store.appendEvent('workflow', id, 'auto_approve_set', {
      on, by: 'human',
      note: on ? '本单免批：非发送闸门自动批准（问询与外发邮件仍等人）' : '恢复人工批准',
    });
    let acted = 0;
    if (on) acted = await rt.runAutoApproveSweep();
    return c.json({ ok: true, on, gates_acted: acted });
  });

  app.get('/api/lifecycle/workflows/:id', (c) => {
    const w = rt.store.getWorkflow(c.req.param('id'));
    if (!w) return c.json({ error: 'not found' }, 404);
    // iOS LifecycleWorkflowTree：workflow.created_at/updated_at 必填 snake_case，
    // steps[].workflow_id/updated_at 同理——camelCase 会整体解码失败
    // （"The data couldn't be read because it is missing"）。case_file/其余
    // 键 iOS 不建模，Codable 忽略多余键。
    // per-workflow Prompt 计数（wf_2542c2c7eb13）：该单窗口内其会话的
    // claude_code 回合聚合——Round 语义澄清为 Prompt 数而非 Workflow 数。
    // 历史记录（tmux_session 列加入前）无归属，按时间窗×会话尽力反填：
    // 窗口内无归属行若该会话窗口外无同 note 干扰则计入（简化：无归属行
    // 仅当本窗口存在该会话归属行时按比例并入，太玄——直接两段并集计数：
    // 有归属行精确计，无归属行不计，新数据起精确）。
    // 归属会话（十四跑 R1 P2-1）：转派/改道单的回合落在实际执行会话名下
    //（human.ts assigned_session / retry patch.session）——与 runtime.ts
    // workflowFor、agentSettle claimedContainerFor 的双键口径对齐：单键
    // w.session 时转派单详情页 Prompts 恒 0。prompt_usage 每行恰一个
    // tmux_session，两会话行集不相交，分别聚合求和无双计。
    // 用户批注修正（闸门 24da83）：一个 tmux session 串多单——全窗会混入
    // 等待期/别单回合。按本单各 agent 步 [started, completed] 区间并集计数
    // （tmux 会话串行跑任务卡：步窗口内该会话的回合即本单）；无步区间
    // （异常/极老单）退化为 [created, updated] 全窗。→ costContextOf 单一
    // 实现，经 usageAggOf 聚合（计费时点修复 wf_be61c3a55842 亦在其中：
    // approve 后回流执行段并入计费窗口）。
    const agg = usageAggOf(rt.store, rt.usage, w);
    return c.json({
      workflow: workflowToGo(w),
      steps: rt.store.stepsForWorkflow(w.id).map(stepToGo),
      case_file: rt.store.loadCaseFile(w.id),
      promptStats: { count: agg.prompts, inputTokens: agg.inputTokens, outputTokens: agg.outputTokens },
      // API 等效价格（wf_535149a174fe）：同口径（sessions × effWindows）行级
      // 用量代入 bigmodel 价目三价计价；不在价目的模型只显用量不出价。
      usageCost: agg.priced,
    });
  });

  // 每单费用聚合（wf_6a74fc4a23e4 用户定案）：Flow Dashboard 层面的费用分析。
  // 范围内 workflows 逐单复用详情口径（usageAggOf 单一事实源），
  // 聚合 overall / 价位分桶 / 逐单明细（散点+下钻）。¥0（无归属/无 CC 用量）
  // 单显式计数不隐藏；已取消单计入（也真实花了钱）；不在价目的单进
  // unpricedOrders 只列名。days=0 表示全部（默认 30 天）。
  // 分桶右开区间（2026-10-06 真实分布定案，单一定义处）：p25≈17/p50≈30/
  // p75≈41 落前两非空档、p90≈71 落 ¥50–100、max≈145 落 ¥100–200；调档只改
  // 本表（增长走数据）。
  app.get('/api/lifecycle/cost-stats', (c) => {
    const days = clampInt(c.req.query('days'), 30, 0, 3650);
    const since = days === 0 ? '' : new Date(Date.now() - days * 86_400_000).toISOString();
    const COST_EDGES = [5, 20, 50, 100, 200];
    const bucketOf = (v: number): number => {
      let i = 0;
      while (i < COST_EDGES.length && v >= COST_EDGES[i]!) i++;
      return i;
    };
    interface OrderAgg {
      id: string; title: string; kind: string; status: string; createdAt: string;
      prompts: number; totalCny: number; unpriced: boolean;
      byModel: Map<string, { label: string; count: number; totalCny: number }>;
    }
    const inRange = rt.store.listWorkflows(5000).filter((w) => since === '' || (w.createdAt ?? '') >= since);
    const orders: OrderAgg[] = [];
    let zeroCost = 0;
    let pricingRetrievedAt = '';
    for (const w of inRange) {
      const uc = usageAggOf(rt.store, rt.usage, w).priced;
      if (uc.pricingRetrievedAt > pricingRetrievedAt) pricingRetrievedAt = uc.pricingRetrievedAt;
      // 无计费用量（纯闸门/llm 单）或纯免费档=真 ¥0；纯无价目单（成本未知≠0）
      // 不计 zeroCost、不入桶，只进 unpricedOrders 显式列名。
      const billable = uc.byModel.some((m) => m.costCny.total > 0);
      if (!billable && uc.unpricedModels.length === 0) { zeroCost++; continue; }
      const agg: OrderAgg = {
        id: w.id, title: w.title, kind: w.kind, status: w.status,
        createdAt: (w.createdAt ?? '').slice(0, 10), prompts: 0, totalCny: uc.totalCny.total,
        unpriced: uc.unpricedModels.length > 0, byModel: new Map(),
      };
      for (const m of uc.byModel) {
        agg.prompts += m.calls;
        if (m.costCny.total <= 0) continue; // 免费档/无价目不占分桶堆叠（无价目另列）
        agg.byModel.set(m.model, {
          label: m.label,
          count: (agg.byModel.get(m.model)?.count ?? 0) + 1, // 单内同模型一行合并（priceUsage 已按模型聚合）
          totalCny: (agg.byModel.get(m.model)?.totalCny ?? 0) + m.costCny.total,
        });
      }
      orders.push(agg);
    }
    // 分位（有计价单成本升序，floor 索引——与分析工件同式）
    const costs = orders.filter((o) => o.totalCny > 0).map((o) => o.totalCny).sort((a, b) => a - b);
    const q = (p: number): number => (costs.length === 0 ? 0 : costs[Math.min(costs.length - 1, Math.floor(p * costs.length))]!);
    const total = costs.reduce((a, x) => a + x, 0);
    const buckets = COST_EDGES.concat([Infinity]).map((hi, i) => {
      const lo = i === 0 ? 0 : COST_EDGES[i - 1]!;
      const label = hi === Infinity ? `¥${lo}+` : `¥${lo}–${hi}`;
      const inBucket = orders.filter((o) => o.totalCny > 0 && bucketOf(o.totalCny) === i);
      const byModel = new Map<string, { model: string; label: string; count: number; totalCny: number }>();
      for (const o of inBucket) {
        for (const [model, v] of o.byModel) {
          const e = byModel.get(model) ?? { model, label: v.label, count: 0, totalCny: 0 };
          e.count++; e.totalCny += v.totalCny;
          byModel.set(model, e);
        }
      }
      return {
        label, edges: [lo, hi === Infinity ? null : hi] as const,
        count: inBucket.length,
        totalCny: Math.round(inBucket.reduce((a, o) => a + o.totalCny, 0) * 100) / 100,
        byModel: [...byModel.values()].sort((a, b) => b.totalCny - a.totalCny),
      };
    });
    // 模型清单（图例/配色）：model id 升序固定序——颜色跟实体不跟排名，切换
    // 时间范围时幸存模型不换色。
    const models = [...orders.flatMap((o) => [...o.byModel]).reduce((m, [model, v]) => {
      const e = m.get(model) ?? { model, label: v.label, orders: 0, totalCny: 0 };
      e.orders++; e.totalCny += v.totalCny;
      m.set(model, e);
      return m;
    }, new Map<string, { model: string; label: string; orders: number; totalCny: number }>()).values()]
      .sort((a, b) => a.model.localeCompare(b.model));
    return c.json({
      days, since, pricingRetrievedAt,
      overall: {
        workflows: inRange.length, ordersWithCost: costs.length, zeroCostOrders: zeroCost,
        totalCny: Math.round(total * 100) / 100,
        meanCny: costs.length === 0 ? 0 : Math.round((total / costs.length) * 100) / 100,
        medianCny: Math.round(q(0.5) * 100) / 100, p90Cny: Math.round(q(0.9) * 100) / 100,
        maxCny: costs.length === 0 ? 0 : costs[costs.length - 1]!,
      },
      buckets,
      perOrder: orders.filter((o) => o.totalCny > 0).sort((a, b) => b.totalCny - a.totalCny).map((o) => ({
        id: o.id, title: o.title, kind: o.kind, status: o.status, createdAt: o.createdAt,
        prompts: o.prompts, totalCny: Math.round(o.totalCny * 100) / 100,
        models: [...o.byModel.values()].sort((a, b) => b.totalCny - a.totalCny).map((m) => m.label),
      })),
      models: models.map((m) => ({ ...m, totalCny: Math.round(m.totalCny * 100) / 100 })),
      unpricedOrders: orders.filter((o) => o.unpriced).map((o) => o.id),
    });
  });

  app.get('/api/lifecycle/events', (c) => {
    const limit = clampInt(c.req.query('limit'), 200, 1, 1000);
    // type=逗号分隔多类型过滤（路由图回放：稀有 route_* 深埋 12 万行窗口外，
    // 过滤后 limit 全花在该类型上——真实历史可达，无需模拟）。
    const types = (c.req.query('type') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    return c.json({ events: rt.store.listEvents(limit, types.length > 0 ? types : undefined) });
  });

  // send_at 类型守卫：approve 专属的定时发参数（其余动作忽略）。
const stepAction = (action: 'approve' | 'deny' | 'resolve' | 'retry') =>
    async (c: Context): Promise<Response> => {
      const body = await readBody(c);
      const id = c.req.param('id') ?? '';
      const noteV = body['note'];
      const note = typeof noteV === 'string' ? noteV : '';
      const byV = body['by'];
      const by = typeof byV === 'string' ? byV : 'operator';
      // 干预重试（agent/verify/llm 步）：携带 plan/prompt/session 补丁，
      // 重臂前覆写步骤 input——出问题时人可以在重跑前改指令/改路由。
      const patch: { plan?: string; prompt?: string; session?: string } = {};
      for (const k of ['plan', 'prompt', 'session'] as const) {
        const v = body[k];
        if (typeof v === 'string' && v.trim() !== '') patch[k] = v;
      }
      try {
        const sendAt = typeof body['send_at'] === 'string' && body['send_at'] !== '' ? body['send_at'] : undefined;
        if (action === 'approve') await rt.engine.approve(id, note, by, sendAt);
        else if (action === 'deny') await rt.engine.deny(id, note, by);
        else if (action === 'resolve') await rt.engine.resolve(id, note, by);
        else await rt.engine.retry(id, Object.keys(patch).length > 0 ? patch : undefined, by);
        return c.json({ ok: true });
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    };

  app.post('/api/lifecycle/steps/:id/approve', stepAction('approve'));
  app.post('/api/lifecycle/steps/:id/deny', stepAction('deny'));
  app.post('/api/lifecycle/steps/:id/resolve', stepAction('resolve'));
  app.post('/api/lifecycle/steps/:id/retry', stepAction('retry'));
  // 收单台快照（0920）：并发上限 / 正占位 / 等待中（队序）。CLI juli queue 同源。
  app.get('/api/queue', (c) => c.json(rt.engine.queueStatus()));

  // ---- 引擎动作路由的公共壳 -----------------------------------------------------
  // 读 body → 调引擎（:id 参数 + body）→ {ok:true}（或 fn 返回的 JSON）；
  // 引擎抛错 → 400 透传中文消息。五段 try/catch 样板收口成一处。
  // bodyStr 已升 http/helpers.ts 共享（R8 批3）。

  const engineAction = (fn: (id: string, body: JsonRecord) => Promise<JsonRecord | void>) =>
    async (c: Context): Promise<Response> => {
      try {
        const out = await fn(c.req.param('id') ?? '', await readBody(c));
        return c.json(out ?? { ok: true });
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    };

  app.post('/api/lifecycle/steps/:id/rework', engineAction(async (id, body) => {
    await rt.engine.rework(id, bodyStr(body, 'feedback'), bodyStr(body, 'by', 'operator'));
  }));

  // 发送守卫拒发的打回补正：内容缺陷 retry 不好，回 agent 补正后重新过闸。
  app.post('/api/lifecycle/steps/:id/rework-send', engineAction(async (id, body) => {
    await rt.engine.reworkSend(id, bodyStr(body, 'feedback'), bodyStr(body, 'by', 'operator'));
  }));

  // hold 人工放行（2026-09-28 透明化配套）：窗口内立即派发——人的动词优先
  // 于窗口策略，meta.hold_released 持久 + hold_released 事件留痕。
  app.post('/api/lifecycle/workflows/:id/release-hold', engineAction(async (id, body) => {
    rt.engine.releaseHold(id, bodyStr(body, 'by', 'web'));
  }));

  // 统一干预（四件套，2026-09-28）：session/context 派发点消费；priority/
  // 时机即时生效。任何状态可设——状态迁移时人插得进手。
  app.post('/api/lifecycle/workflows/:id/override', engineAction(async (id, body) => {
    const pr = body['priority'];
    rt.engine.setOverride(id, {
      ...(typeof body['session'] === 'string' ? { session: body['session'] } : {}),
      ...(typeof body['context'] === 'string' ? { context: body['context'] } : {}),
      ...(pr === 'high' || pr === 'normal' ? { priority: pr } : {}),
      ...(typeof body['hold_until'] === 'string' ? { hold_until: body['hold_until'] } : {}),
      ...(body['dispatch_now'] === true ? { dispatch_now: true } : {}),
    }, bodyStr(body, 'by', 'web'));
  }));

  // 转派（task-handoff）：agent 提案 domain，引擎四道校验后追加执行步。
  app.post('/api/lifecycle/workflows/:id/handoff', engineAction(async (id, body) => {
    const r = await rt.engine.handoff(id, bodyStr(body, 'domain'), bodyStr(body, 'reason'), bodyStr(body, 'by', 'agent'));
    return r;
  }));

  // 单步取消（断点六③）：auto-pair 与手动 send 撞车后多余 pending 节点的
  // 合规取消通道——此前单步只有直改 SQLite 一条路（已被权限层拦截）。
  app.post('/api/lifecycle/steps/:id/cancel', engineAction(async (id, body) => {
    await rt.engine.cancelStep(id, bodyStr(body, 'note'), bodyStr(body, 'by', 'operator'));
  }));

  // 补料：给卡住/失败步骤补缺失 input（in_reply_to 等）——快照不解锁，
  // 修正本身记账（step_input_amended 事件：改前/改后/操作人）。
  app.post('/api/lifecycle/steps/:id/amend', engineAction(async (id, body) => {
    const raw = body['patch'] ?? {};
    const patch = (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as JsonRecord;
    await rt.engine.amendStep(id, patch, bodyStr(body, 'by', 'operator'));
  }));

  // 补料候选值：从关联单 meta / 本单字段推导预填——人只裁断不当检索器。
  app.get('/api/lifecycle/workflows/:id/amend-suggestions', engineAction(async (id) => {
    return rt.engine.amendSuggestions(id);
  }));

  // 一等插话：向在途 agent 步递补充指示——投递+留痕一体（区别于裸
  // /api/sessions/:name/send 的无账本 send-keys）。
  app.post('/api/lifecycle/steps/:id/intervene', engineAction(async (id, body) => {
    await rt.engine.intervene(id, bodyStr(body, 'text'), bodyStr(body, 'by', 'operator'));
  }));

  // 对齐修正：审阅人就地改理解——修正成为新工件，下游 agent 锚定人定稿版本。
  app.post('/api/lifecycle/steps/:id/align', engineAction(async (id, body) => {
    await rt.engine.align(id, bodyStr(body, 'amendment'), bodyStr(body, 'by', 'operator'));
  }));

  app.post('/api/lifecycle/workflows/:id/nodes', engineAction(async (id, body) => {
    const kind = bodyStr(body, 'kind');
    const title = bodyStr(body, 'title') || kind;
    const rawInput = body['input'] ?? {};
    const input = (rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {}) as JsonRecord;
    const st = await rt.engine.appendNode(id, {
      kind: kind as StepKind, title, input,
    });
    return { step: st } as unknown as JsonRecord;
  }));

  // 免模板起单（动态模型标准入口）：POST /api/lifecycle/tasks {title, input}
  app.post('/api/lifecycle/tasks', async (c) => {
    const body = await readBody(c);
    const title = bodyStr(body, 'title');
    const rawInput = body['input'] ?? {};
    const input = (rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {}) as JsonRecord;
    try {
      // 判定收敛执行层（2026-10-13 用户裁定「排队后再决定路由」）：进件只
      // 收倾向（显式 session/挂靠/档位原样透传），落点与档位判定移到派发
      // 时刻（engine steps 三无腿，jev 对实时忙闲判）——进件快照过期就此
      // 收口；startTask「入口到 createWorkflow 无 await」不变量随之恢复。
      const w = await rt.engine.startTask(title, input);
      return c.json({ workflow: w });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.post('/api/lifecycle/workflows/:id/settle', engineAction(async (id, body) => {
    await rt.engine.settle(id, bodyStr(body, 'by', 'operator'));
  }));

  // 人工中止 running 单（前端"中止"按钮）：在跑步/闸门全 cancelled，审计留痕。
  app.post('/api/lifecycle/workflows/:id/force-close', engineAction(async (id, body) => {
    await rt.engine.forceClose(id, bodyStr(body, 'note'), bodyStr(body, 'by', 'operator'));
  }));

  app.post('/api/lifecycle/workflows/:id/close', engineAction(async (id, body) => {
    await rt.engine.closeWorkflow(id, bodyStr(body, 'note'), bodyStr(body, 'by', 'operator'));
  }));

  app.post('/api/lifecycle/workflows/:id/assign', async (c) => {
    const body = await readBody(c);
    const session = bodyStr(body, 'session');
    const by = bodyStr(body, 'by', 'operator');
    try {
      await rt.engine.assignSession(c.req.param('id'), session, by);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.get('/api/lifecycle/steps', (c) => {
    const status = c.req.query('status') ?? '';
    const limit = clampInt(c.req.query('limit'), 30, 1, 200);
    const rows = rt.store.db.prepare(
      `SELECT s.id, s.workflow_id, s.seq, s.kind, s.title, s.status, s.input, s.output,
              s.summary, s.updated_at, s.started_at, s.completed_at,
              w.id AS w_id, w.title AS w_title, w.kind AS w_kind, w.status AS w_status
       FROM workflow_steps s LEFT JOIN workflows w ON w.id = s.workflow_id
       ${status !== '' ? 'WHERE s.status = ?' : ''}
       ORDER BY s.updated_at DESC LIMIT ?`,
    ).all(...(status !== '' ? [status, limit] : [limit])) as Record<string, string | number | null>[];
    const steps = rows.map((r) => {
      const parse = (v: string | number | null): Record<string, unknown> => {
        try { return JSON.parse(String(v ?? '{}')) as Record<string, unknown>; } catch { return {}; }
      };
      return {
        step: stepToGo({
          id: String(r['id'] ?? ''), workflowId: String(r['workflow_id'] ?? ''),
          seq: Number(r['seq'] ?? 0), kind: String(r['kind'] ?? ''),
          title: String(r['title'] ?? ''), status: String(r['status'] ?? ''),
          input: parse(r['input'] as string | null), output: parse(r['output'] as string | null),
          summary: r['summary'] === null ? undefined : String(r['summary']),
          updatedAt: String(r['updated_at'] ?? ''),
          startedAt: String(r['started_at'] ?? ''),
          completedAt: r['completed_at'] === null ? null : String(r['completed_at'] ?? ''),
        }),
        workflow: r['w_id'] === null ? undefined : {
          id: r['w_id'], title: r['w_title'], kind: r['w_kind'], status: r['w_status'],
        },
      };
    });
    return c.json({ steps });
  });

  // workflows2 = workflows 的防缓存别名（POST 空 body = 列表查询，iOS 在用）。
  const listWorkflowsGo = (query: { status?: string; limit?: string }): Record<string, unknown>[] => {
    const limit = clampInt(query.limit, 100, 1, 1000);
    const status = query.status ?? '';
    const rows = rt.store.db.prepare(
      `SELECT w.*, 
         (SELECT COUNT(*) FROM workflow_steps s WHERE s.workflow_id = w.id AND s.status = 'waiting_human') AS waiting_steps
       FROM workflows w ${status !== '' ? 'WHERE w.status = ?' : ''} 
       ORDER BY w.created_at DESC, w.rowid DESC LIMIT ?`,
    ).all(...(status !== '' ? [status, limit] : [limit])) as Record<string, string | number | null>[];
    return rows.map((r) => {
      let meta: unknown = undefined;
      try { meta = JSON.parse(String(r['meta'] ?? '')) as unknown; } catch { /* 无 meta */ }
      return workflowToGo(
        {
          id: String(r['id'] ?? ''), kind: String(r['kind'] ?? ''), title: String(r['title'] ?? ''),
          status: String(r['status'] ?? ''),
          session: r['session'] === null ? null : String(r['session']),
          project: r['project'] === null ? null : String(r['project']),
          path: r['path'] === null ? null : String(r['path']),
          threadId: r['thread_id'] === null || r['thread_id'] === undefined ? null : String(r['thread_id']),
          meta, createdAt: String(r['created_at'] ?? ''), updatedAt: String(r['updated_at'] ?? ''),
        },
        Number(r['waiting_steps'] ?? 0),
      );
    });
  };

  app.get('/api/lifecycle/workflows2', (c) => c.json({ workflows: listWorkflowsGo(c.req.query()) }));
  // Task 投影（第四期最小转正）：store 层从任务卡+挂链聚出的归属面——
  // 前端 kanban/流水列表项的「属 Task」徽标与同 Task 过滤只吃这一个端点，
  // 不新开 tab、不建新表。
  app.get('/api/lifecycle/task-map', (c) => {
    const { views, map } = rt.store.taskViews();
    return c.json({
      tasks: views.map((t) => ({
        id: t.taskId, title: t.title, status: t.status, workflow_ids: t.workflowIds,
      })),
      map,
    });
  });
  app.post('/api/lifecycle/workflows2', async (c) => {
    const body = await readBody(c);
    const title = bodyStr(body, 'title');
    if (title === '') return c.json({ workflows: listWorkflowsGo(c.req.query()) });
    const w = rt.store.createWorkflow({ kind: bodyStr(body, 'kind', 'adhoc'), title });
    return c.json({ workflow: { id: w.id, kind: w.kind, title: w.title, status: w.status, created_at: w.createdAt, updated_at: w.updatedAt } });
  });
};
