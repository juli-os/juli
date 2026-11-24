// 生命周期账本与闸门动词：workflows/events/steps 动作/队列/任务起单/节点追加/settle 族。
// 分层重构（2026-09-23）：自 app.ts 按资源族拆出，路由注册体逐字保留。

import type { Hono, Context } from 'hono';
import { stepToGo, workflowToGo } from '../../platform/shared/goShape.ts';
import { type StepKind } from '@juli-os/ledger';
import type { Runtime } from '../../runtime.ts';
import { type JsonRecord } from '../../platform/shared/json.ts';
import {
  bodyStr, clampInt, foreignSessionError, operatorFaceBlocked, pinTenantCreateInput, readBody, tenantFilterOf, tenantScopeOf, type AppEnv,
} from '../helpers.ts';
import { scopeSees } from '../../business/workflow/tenantScope.ts';
import { usageAggOf } from '../../business/workflow/costContext.ts';

export const registerLifecycleRoutes = (app: Hono<AppEnv>, rt: Runtime): void => {

  // ---- 写面租户闸（2026-11-11 A-P1-4）-------------------------------------------
  // one 身份的写请求只能落在本租户的单子/步骤/会话上。他租户与不存在同响应
  // （404 not found），不泄露别家单子在不在、什么状态。all（无头 operator /
  // iOS / CLI hook）不过闸，行为逐字节不变。

  /** 单子或步骤不属请求租户（含查无此物）→ true。 */
  const ownerBlocked = (c: Context<AppEnv>, owner: 'workflow' | 'step', id: string): boolean => {
    const scope = tenantScopeOf(c);
    if (scope.kind === 'all') return false;
    if (owner === 'workflow') return !scopeSees(scope, rt.store.getWorkflow(id)?.tenant ?? null);
    const st = rt.store.getStep(id);
    return !scopeSees(scope, st === null ? null : (rt.store.getWorkflow(st.workflowId)?.tenant ?? null));
  };

  // 钉会话闸与建单入参闸（foreignSessionError / pinTenantCreateInput）在 http/helpers.ts，
  // 本文件、pipelines 起流、chat 开单确认共用一份。

  app.get('/api/lifecycle/workflows', (c) => {
    const limit = clampInt(c.req.query('limit'), 100, 1, 500);
    // status 可选等值过滤（NEW-2）：非法值=空结果，语义无害；不加 session 参数
    // （那要牵 meta.assigned_session JSON 面，超出本参数所需）。
    const status = c.req.query('status');
    // 租户收口（A2 读侧边界）：X-Juli-Tenant=one 时下推 tenant 参数到 store；
    // all（无头 operator）原样全量。hold 名单同口径按租户单子收窄。
    const tenant = tenantFilterOf(c);
    const qs = rt.engine.queueStatus();
    const rows = rt.store.listWorkflows(limit, status, tenant);
    const visible = new Set(rows.map((w) => w.id));
    return c.json({
      workflows: rows,
      held_ids: [...qs.held].filter((id) => visible.has(id)),
      hold_until: rt.config.work_hours.mode !== 'off' ? `${rt.config.work_hours.start}–${rt.config.work_hours.end}` : '',
    });
  });

  // 单子级免批切换（2026-10-07 用户裁定：前端按单开关，非全局配置）：
  // meta.auto_approve 布尔；开=立即跑一轮 sweep（在等闸门当秒处理）；
  // 硬边界不变（问询/外发仍等人）。留痕 auto_approve_set。
  app.post('/api/lifecycle/workflows/:id/auto-approve', async (c) => {
    const id = c.req.param('id');
    const body = await readBody(c);
    const w = rt.store.getWorkflow(id);
    // 写面租户闸（A-P1-4）：读体后才查归属（同 engineAction 壳，校验与动作间
    // 无窗口）；他租户与不存在同响应 404。
    if (!w || ownerBlocked(c, 'workflow', id)) return c.json({ error: 'not found' }, 404);
    const on = body['on'] === true;
    rt.store.updateWorkflowMeta(id, on ? { auto_approve: true } : { auto_approve: null });
    rt.store.appendEvent('workflow', id, 'auto_approve_set', {
      on, by: 'human',
      note: on ? '本单免批：显式申报为 apply / artifact 的审批自动批准（问询、发送审批、没申报交付类型的审批仍等人）' : '恢复人工批准',
    });
    let acted = 0;
    if (on) acted = await rt.runAutoApproveSweep();
    return c.json({ ok: true, on, gates_acted: acted });
  });

  // 租户认领（A3 写侧打标记的改判通道）：租户归属的写动词只有 all 身份
  // 能动，one 身份连存在与否都看不到。只对 queued 开放：running/终态单已在
  // 消费租户上下文（A2 守卫、SSE 推送面），中途改判会让同一单前后两半
  // 归属不同租户；409 点名现状态。basis 覆写为 claimed，记录「人认领的，
  // 不是信号判的」；改判前的 basis 记进 tenant_claimed 事件（prev_basis），
  // 租户未变（default 单认领回原租户）时这是 basis 变化的唯一留痕。
  // 窗口分析。await readBody 是本路由唯一的让出点，期间别的请求能改这张单
  // （并发认领，派发把它推离 queued）。单子因此在 await 之后才读，404、409、
  // 幂等判断与事件 from 共用这一份快照。读完到写完没有 await，进程内无交错，
  // from 就是写入前的真实租户。ledger 0.2.0 未暴露事务接口，tenant 列、
  // meta.basis、事件仍分三步写（先列后 meta 再事件），残缺只剩进程崩在两步
  // 之间。列与 meta 按快照比对补写。事件按账本判，最近一条 tenant_claimed
  // 已记到目标租户就跳过，所以同租户重复认领零写入，并发认领只记一条，重试
  // 补上崩掉的那条事件。补写那条的 from 与 prev_basis 取崩溃后的现值（可能
  // from=to），真实改前租户在 setWorkflowTenant 自记的 tenant_changed 事件里。
  app.post('/api/lifecycle/workflows/:id/tenant', async (c) => {
    if (operatorFaceBlocked(c)) return c.json({ error: 'not found' }, 404);
    const id = c.req.param('id');
    const body = await readBody(c);
    const w = rt.store.getWorkflow(id);
    if (!w) return c.json({ error: 'not found' }, 404);
    const tenant = bodyStr(body, 'tenant').trim();
    if (!rt.tenants.stampableTenants.has(tenant)) {
      return c.json({ error: `未知租户 "${tenant}"，可选值：${[...rt.tenants.stampableTenants].join('、')}` }, 400);
    }
    if (w.status !== 'queued') {
      return c.json({ error: `只能认领 queued 状态的单子（${id} 现状态 ${w.status}）` }, 409);
    }
    const prevBasis = typeof w.meta['tenant_basis'] === 'string' ? w.meta['tenant_basis'] : '';
    if (w.tenant !== tenant || prevBasis !== 'claimed') {
      rt.store.setWorkflowTenant(id, tenant);
      rt.store.updateWorkflowMeta(id, { tenant_basis: 'claimed' });
    }
    if (rt.store.entityEvents('workflow', id, 'tenant_claimed').at(-1)?.payload['to'] !== tenant) {
      rt.store.appendEvent('workflow', id, 'tenant_claimed', {
        from: w.tenant, to: tenant, prev_basis: prevBasis, by: bodyStr(body, 'by', 'operator'),
      });
    }
    return c.json({ ok: true, id, tenant, basis: 'claimed' });
  });

  app.get('/api/lifecycle/workflows/:id', (c) => {
    const w = rt.store.getWorkflow(c.req.param('id'));
    if (!w) return c.json({ error: 'not found' }, 404);
    // 租户收口（A2）：one 身份看他租户的单 = 404（与不存在同响应，不泄露在否）。
    if (!scopeSees(tenantScopeOf(c), w.tenant)) return c.json({ error: 'not found' }, 404);
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
      byModel: Map<string, { label: string; totalCny: number }>;
    }
    const inRange = rt.store.listWorkflows(5000, undefined, tenantFilterOf(c))
      .filter((w) => since === '' || (w.createdAt ?? '') >= since);
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
        agg.byModel.set(m.model, { label: m.label, totalCny: m.costCny.total }); // priceUsage 已按模型 Map 聚合，单内模型唯一
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
    // 租户条件进查询再截断（A-P2-7）：先按 limit 截断再按租户过滤，别家事件一多
    // 本租户能看到的就很少甚至为空（acme 头 limit=5 回 0 条、limit=500 才有）。
    // all 原样走 store.listEvents（operator 行为不变）。
    const scope = tenantScopeOf(c);
    const wanted = types.length > 0 ? types : undefined;
    const rows = scope.kind === 'one'
      ? rt.store.listEventsForTenant(scope.tenant, limit, wanted)
      : rt.store.listEvents(limit, wanted);
    return c.json({ events: rows });
  });

  // ---- 引擎动作路由的公共壳 -----------------------------------------------------
  // 读 body → 调引擎（:id 参数 + body）→ {ok:true}（或 fn 返回的 JSON）；
  // 引擎抛错 → 400 透传中文消息。五段 try/catch 样板收口成一处。
  // bodyStr 已升 http/helpers.ts 共享（R8 批3）。

  // 返回体 object：领域接口对象（Step/Workflow，无索引签名）也可直返——
  // 此前被 `as unknown as JsonRecord` 双重断言硬塞（R1 P2#7）。不用 unknown：
  // hono c.json 约束 T extends JSONValue | {}，object 是满足约束的最小放宽。
  // owner：路径参数指向的资源种类——'workflow' | 'step' 时 one 身份先做属主
  // 校验（A-P1-4），null = 无 id 的建单口（建单租户闸在 fn 里做）。
  const engineAction = (
    owner: 'workflow' | 'step' | null,
    fn: (id: string, body: JsonRecord, c: Context<AppEnv>) => Promise<object | void>,
  ) =>
    async (c: Context<AppEnv>): Promise<Response> => {
      try {
        const id = c.req.param('id') ?? '';
        const body = await readBody(c);
        // 校验与 fn 起步之间不再有 await（先读体再查归属，查询同步），进程内
        // 没有可插的窗口。
        if (owner !== null && ownerBlocked(c, owner, id)) return c.json({ error: 'not found' }, 404);
        const sessionErr = foreignSessionError(c, rt, body);
        if (sessionErr !== '') return c.json({ error: sessionErr }, 400);
        const out = await fn(id, body, c);
        return c.json(out ?? { ok: true });
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    };

  /** gates 域统一审计（第 5 步）：旧步级端点保留转发可用——动作成功后把
   * 决策落 gate_items（与新端点 /api/gates/:id/<verb> 同一审计面）。 */
  const recordGateDecision = (id: string, verb: 'approve' | 'deny' | 'resolve' | 'rework' | 'align' | 'amend', note: string, by: string): void => {
    const st = rt.store.getStep(id);
    if (st === null || st.kind !== 'gate') return; // 非闸门步（agent 重试等）不进拍板审计
    const now = new Date().toISOString();
    rt.gates.register({ id: st.id, kind: 'workflow_gate', workflowId: st.workflowId, stepId: st.id, title: st.title, payload: st.input, now });
    rt.gates.decide(st.id, verb, by, note, by === 'juli-auto', now);
  };

  // send_at 类型守卫：approve 专属的定时发参数（其余动作忽略）。
  const stepAction = (action: 'approve' | 'deny' | 'resolve' | 'retry') =>
    engineAction('step', async (id, body) => {
      const note = bodyStr(body, 'note');
      const by = bodyStr(body, 'by', 'operator');
      // 干预重试（agent/verify/llm 步）：携带 plan/prompt/session 补丁，
      // 重臂前覆写步骤 input——出问题时人可以在重跑前改指令/改路由。
      const patch: { plan?: string; prompt?: string; session?: string } = {};
      for (const k of ['plan', 'prompt', 'session'] as const) {
        const v = body[k];
        if (typeof v === 'string' && v.trim() !== '') patch[k] = v;
      }
      const sendAt = typeof body['send_at'] === 'string' && body['send_at'] !== '' ? body['send_at'] : undefined;
      if (action === 'approve') await rt.engine.approve(id, note, by, sendAt);
      else if (action === 'deny') await rt.engine.deny(id, note, by);
      else if (action === 'resolve') await rt.engine.resolve(id, note, by);
      else await rt.engine.retry(id, Object.keys(patch).length > 0 ? patch : undefined, by);
      if (action !== 'retry') recordGateDecision(id, action, note, by);
    });

  app.post('/api/lifecycle/steps/:id/approve', stepAction('approve'));
  app.post('/api/lifecycle/steps/:id/deny', stepAction('deny'));
  app.post('/api/lifecycle/steps/:id/resolve', stepAction('resolve'));
  app.post('/api/lifecycle/steps/:id/retry', stepAction('retry'));
  // 收单台快照（0920）：并发上限 / 正占位 / 等待中（队序）。CLI juli queue 同源。
  // 租户收口（A2）：与 workflows 端点对 held_ids 同款——one 身份三个名单
  //（active/waiting/held）都按单子归属过滤，他租户在途单号不外泄；
  // concurrency 是全局槽位数，无租户语义，原样给。
  app.get('/api/queue', (c) => {
    const qs = rt.engine.queueStatus();
    const scope = tenantScopeOf(c);
    if (scope.kind === 'all') return c.json(qs);
    const sees = (id: string): boolean => scopeSees(scope, rt.store.getWorkflow(id)?.tenant ?? null);
    return c.json({
      concurrency: qs.concurrency,
      active: qs.active.filter(sees),
      waiting: qs.waiting.filter(sees),
      held: qs.held.filter(sees),
    });
  });

  app.post('/api/lifecycle/steps/:id/rework', engineAction('step', async (id, body) => {
    await rt.engine.rework(id, bodyStr(body, 'feedback'), bodyStr(body, 'by', 'operator'));
    recordGateDecision(id, 'rework', bodyStr(body, 'feedback'), bodyStr(body, 'by', 'operator'));
  }));

  // 发送守卫拒发的打回补正：内容缺陷 retry 不好，回 agent 补正后重新过闸。
  app.post('/api/lifecycle/steps/:id/rework-send', engineAction('step', async (id, body) => {
    await rt.engine.reworkSend(id, bodyStr(body, 'feedback'), bodyStr(body, 'by', 'operator'));
  }));

  // hold 人工放行（2026-09-28 透明化配套）：窗口内立即派发——人的动词优先
  // 于窗口策略，meta.hold_released 持久 + hold_released 事件留痕。
  app.post('/api/lifecycle/workflows/:id/release-hold', engineAction('workflow', async (id, body) => {
    rt.engine.releaseHold(id, bodyStr(body, 'by', 'web'));
  }));

  // 统一干预（四件套，2026-09-28）：session/context 派发点消费；priority/
  // 时机即时生效。任何状态可设——状态迁移时人插得进手。
  app.post('/api/lifecycle/workflows/:id/override', engineAction('workflow', async (id, body) => {
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
  app.post('/api/lifecycle/workflows/:id/handoff', engineAction('workflow', async (id, body) => {
    const r = await rt.engine.handoff(id, bodyStr(body, 'domain'), bodyStr(body, 'reason'), bodyStr(body, 'by', 'agent'));
    return r;
  }));

  // 单步取消（断点六③）：auto-pair 与手动 send 撞车后多余 pending 节点的
  // 合规取消通道——此前单步只有直改 SQLite 一条路（已被权限层拦截）。
  app.post('/api/lifecycle/steps/:id/cancel', engineAction('step', async (id, body) => {
    await rt.engine.cancelStep(id, bodyStr(body, 'note'), bodyStr(body, 'by', 'operator'));
  }));

  // 补料：给卡住/失败步骤补缺失 input（in_reply_to 等）——快照不解锁，
  // 修正本身记账（step_input_amended 事件：改前/改后/操作人）。
  app.post('/api/lifecycle/steps/:id/amend', engineAction('step', async (id, body) => {
    const raw = body['patch'] ?? {};
    const patch = (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as JsonRecord;
    await rt.engine.amendStep(id, patch, bodyStr(body, 'by', 'operator'));
    recordGateDecision(id, 'amend', JSON.stringify(patch), bodyStr(body, 'by', 'operator'));
  }));

  // 补料候选值：从关联单 meta / 本单字段推导预填——人只裁断不当检索器。
  // 租户收口（A2）：与单子详情本体同判据——他租户/不存在一律 404（engineAction
  // 壳只兜引擎异常，越权守卫要在此显式做）。
  app.get('/api/lifecycle/workflows/:id/amend-suggestions', async (c) => {
    const w = rt.store.getWorkflow(c.req.param('id'));
    if (!w) return c.json({ error: 'not found' }, 404);
    if (!scopeSees(tenantScopeOf(c), w.tenant)) return c.json({ error: 'not found' }, 404);
    try {
      const suggestions: object = rt.engine.amendSuggestions(w.id); // c.json 约束的最小放宽（同 engineAction 壳）
      return c.json(suggestions);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // 一等插话：向在途 agent 步递补充指示——投递+留痕一体（区别于裸
  // /api/sessions/:name/send 的无账本 send-keys）。
  app.post('/api/lifecycle/steps/:id/intervene', engineAction('step', async (id, body) => {
    await rt.engine.intervene(id, bodyStr(body, 'text'), bodyStr(body, 'by', 'operator'));
  }));

  // 对齐修正：审阅人就地改理解——修正成为新工件，下游 agent 锚定人定稿版本。
  app.post('/api/lifecycle/steps/:id/align', engineAction('step', async (id, body) => {
    await rt.engine.align(id, bodyStr(body, 'amendment'), bodyStr(body, 'by', 'operator'));
    recordGateDecision(id, 'align', bodyStr(body, 'amendment'), bodyStr(body, 'by', 'operator'));
  }));

  app.post('/api/lifecycle/workflows/:id/nodes', engineAction('workflow', async (id, body) => {
    const kind = bodyStr(body, 'kind');
    const title = bodyStr(body, 'title') || kind;
    const rawInput = body['input'] ?? {};
    const input = (rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {}) as JsonRecord;
    const st = await rt.engine.appendNode(id, {
      kind: kind as StepKind, title, input,
    });
    return { step: st };
  }));

  // 免模板起单（动态模型标准入口）：POST /api/lifecycle/tasks {title, input}
  // 建单租户闸（A-P1-4 / A-P2-8）：one 身份的请求租户当显式租户——裸建落本租户
  // （不再落 internal 让开单人自查 404）；显式他租户、钉他会话、关联他租户单
  // 一律 400 点名（helpers.pinTenantCreateInput）。
  app.post('/api/lifecycle/tasks', engineAction(null, async (_id, body, c) => {
    const rawInput = body['input'] ?? {};
    let input = (rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {}) as JsonRecord;
    const scope = tenantScopeOf(c);
    if (scope.kind === 'one') input = pinTenantCreateInput(scope.tenant, rt, input);
    // 判定收敛执行层（2026-10-13 用户裁定「排队后再决定路由」）：进件只
    // 收倾向（显式 session/挂靠/档位原样透传），落点与档位判定移到派发
    // 时刻（engine steps 三无腿，jev 对实时忙闲判）——进件快照过期就此
    // 收口；startTask「入口到 createWorkflow 无 await」不变量随之恢复。
    const w = await rt.engine.startTask(bodyStr(body, 'title'), input);
    return { workflow: w };
  }));

  app.post('/api/lifecycle/workflows/:id/settle', engineAction('workflow', async (id, body) => {
    await rt.engine.settle(id, bodyStr(body, 'by', 'operator'));
  }));

  // 人工中止 running 单（前端"中止"按钮）：在跑步/闸门全 cancelled，审计留痕。
  app.post('/api/lifecycle/workflows/:id/force-close', engineAction('workflow', async (id, body) => {
    await rt.engine.forceClose(id, bodyStr(body, 'note'), bodyStr(body, 'by', 'operator'));
  }));

  app.post('/api/lifecycle/workflows/:id/close', engineAction('workflow', async (id, body) => {
    await rt.engine.closeWorkflow(id, bodyStr(body, 'note'), bodyStr(body, 'by', 'operator'));
  }));

  app.post('/api/lifecycle/workflows/:id/assign', engineAction('workflow', async (id, body) => {
    await rt.engine.assignSession(id, bodyStr(body, 'session'), bodyStr(body, 'by', 'operator'));
  }));

  app.get('/api/lifecycle/steps', (c) => {
    const status = c.req.query('status') ?? '';
    const limit = clampInt(c.req.query('limit'), 30, 1, 200);
    // 租户收口（A2）：按关联单 w.tenant 过滤（孤儿步=无单归属，one 不可见）。
    const tenant = tenantFilterOf(c);
    // ledger 关门（2026-11-12）：直查改 listStepsWithWorkflow（status/tenant
    // 过滤 + updated_at 倒序语义随迁）。
    const rows = rt.store.listStepsWithWorkflow({
      status: status === '' ? undefined : status,
      tenant,
      limit,
    });
    const steps = rows.map((r) => ({
      step: stepToGo(r.step),
      workflow: r.workflow === undefined ? undefined : {
        id: r.workflow.id, title: r.workflow.title, kind: r.workflow.kind, status: r.workflow.status,
      },
    }));
    return c.json({ steps });
  });

  // workflows2 = workflows 的防缓存别名（POST 空 body = 列表查询，iOS 在用）。
  const listWorkflowsGo = (query: { status?: string; limit?: string }, tenant?: string): Record<string, unknown>[] => {
    const limit = clampInt(query.limit, 100, 1, 1000);
    const status = query.status ?? '';
    // ledger 关门（2026-11-12）：直查改 listWorkflowsWithWaiting（Go 形列表
    // 附 waiting_human 计数，过滤语义随迁）。
    const rows = rt.store.listWorkflowsWithWaiting({
      status: status === '' ? undefined : status,
      tenant,
      limit,
    });
    return rows.map(({ workflow: r, waitingSteps }) => {
      return workflowToGo(
        {
          id: r.id, kind: r.kind, title: r.title, status: r.status,
          session: r.session ?? null,
          project: r.project ?? null,
          path: r.path ?? null,
          threadId: r.threadId ?? null,
          meta: r.meta, createdAt: r.createdAt, updatedAt: r.updatedAt,
        },
        waitingSteps,
      );
    });
  };

  app.get('/api/lifecycle/workflows2', (c) => c.json({ workflows: listWorkflowsGo(c.req.query(), tenantFilterOf(c)) }));
  // Task 投影（第四期最小转正）：store 层从任务卡+挂链聚出的归属面——
  // 前端 kanban/流水列表项的「属 Task」徽标与同 Task 过滤只吃这一个端点，
  // 不新开 tab、不建新表。租户收口（A2）：taskViews 全量扫无租户参数——
  // 在本投影层按租户单子过滤（视图保留仍有可见单的，workflow_ids 收窄到
  // 可见子集；map 同步剔除不可见行）。
  app.get('/api/lifecycle/task-map', (c) => {
    const { views, map } = rt.store.taskViews();
    const tenant = tenantFilterOf(c);
    if (tenant === undefined) {
      return c.json({
        tasks: views.map((t) => ({
          id: t.taskId, title: t.title, status: t.status, workflow_ids: t.workflowIds,
        })),
        map,
      });
    }
    const visible = new Set(rt.store.listWorkflows(Number.MAX_SAFE_INTEGER, undefined, tenant).map((w) => w.id));
    const scopedMap = Object.fromEntries(Object.entries(map).filter(([wfId]) => visible.has(wfId)));
    const scopedViews = views
      .map((t) => ({ ...t, workflowIds: t.workflowIds.filter((id) => visible.has(id)) }))
      .filter((t) => t.workflowIds.length > 0);
    return c.json({
      tasks: scopedViews.map((t) => ({
        id: t.taskId, title: t.title, status: t.status, workflow_ids: t.workflowIds,
      })),
      map: scopedMap,
    });
  });
  app.post('/api/lifecycle/workflows2', async (c) => {
    const body = await readBody(c);
    const title = bodyStr(body, 'title');
    if (title === '') return c.json({ workflows: listWorkflowsGo(c.req.query(), tenantFilterOf(c)) });
    // 建单租户闸（A-P1-4 / A-P2-8）：one 身份带标题建单按请求租户打显式戳，
    // 不再落 internal 让开单人自查 404。all 原样（无信号不 stamp，与旧行为一致）。
    const scope = tenantScopeOf(c);
    const w = rt.store.createWorkflow({
      kind: bodyStr(body, 'kind', 'adhoc'), title,
      ...(scope.kind === 'one'
        ? { tenant: scope.tenant, meta: { tenant_basis: 'explicit' as const } }
        : {}),
    });
    return c.json({ workflow: { id: w.id, kind: w.kind, title: w.title, status: w.status, created_at: w.createdAt, updated_at: w.updatedAt } });
  });
};
