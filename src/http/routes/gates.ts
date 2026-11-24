// gates 域 HTTP 面（2026-11-12 第 5 步）：/api/gates 统一待决列表 + 六动词。
// 旧的步级端点（/api/lifecycle/steps/:id/*）保留转发可用，不删——本路由是
// 统一入口，不是唯一入口；决策动作转发既有 engine 正门（宪法级路径不动）。
import type { Hono } from 'hono';
import type { Runtime } from '../../runtime.ts';
import { bodyStr, foreignSessionError, readBody, tenantScopeOf, type AppEnv } from '../helpers.ts';
import { scopeSees } from '../../business/workflow/tenantScope.ts';
import { listGates, GATE_VERBS, type GateView } from '../../business/gates/index.ts';
import type { JsonRecord } from '../../platform/shared/json.ts';

export const registerGatesRoutes = (app: Hono<AppEnv>, rt: Runtime): void => {

  /** 列表行按请求租户过滤（one 只见本租户的单子的卡）。 */
  const visible = (c: ReturnType<typeof tenantScopeOf>, g: GateView): boolean =>
    scopeSees(c, g.tenant === '' ? null : g.tenant);

  app.get('/api/gates', (c) => {
    const scope = tenantScopeOf(c);
    const status = c.req.query('status') ?? 'open';
    if (status !== 'open') return c.json({ gates: [] }); // 决策史走 gate_items 审计（本端点只喂待决面）
    const limit = Number(c.req.query('limit') ?? '200');
    const gates = listGates(rt.store, rt.gates).filter((g) => visible(scope, g)).slice(0, Number.isFinite(limit) ? limit : 200);
    return c.json({ gates, count: gates.length });
  });

  app.get('/api/gates/:id', (c) => {
    const id = c.req.param('id') ?? '';
    const scope = tenantScopeOf(c);
    const hit = listGates(rt.store, rt.gates).find((g) => g.id === id);
    if (!hit || !visible(scope, hit)) return c.json({ error: 'not found' }, 404);
    const audit = rt.gates.get(id);
    return c.json({ gate: hit, audit: audit?.decision ?? null });
  });

  // 六动词：approve/deny/resolve/rework/align/amend（amend 归 rework 族=补料）。
  // 执行=转发 engine 正门；成功后 gates 库落审计行（红线③：by 全审计）。
  for (const verb of GATE_VERBS) {
    app.post(`/api/gates/:id/${verb}`, async (c) => {
      const id = c.req.param('id') ?? '';
      const scope = tenantScopeOf(c);
      const body = await readBody(c);
      const hit = listGates(rt.store, rt.gates).find((g) => g.id === id);
      if (!hit || !visible(scope, hit)) return c.json({ error: 'not found' }, 404);
      if (hit.kind === 'chat_confirm') {
        // 计划确认卡的状态机在 chat intake（proposed 相位）——动词仍走
        // /api/chat/intake/confirm|deny（登记面只做可见与审计）。
        return c.json({ error: 'chat_confirm 卡走 /api/chat/intake/confirm|deny' }, 400);
      }
      // 钉会话闸（2026-11-23）：amend 的补丁全量写进步 input（human.ts
      // setStepInput 不挑键），补丁里的 session/resolved_session 是派发落点——
      // 步级端点 /api/lifecycle/steps/:id/* 的 engineAction 壳早就先过这道闸，
      // 本路由漏了：单租户身份能把本租户的闸门补丁钉到别家会话。六个动词
      // 一律先过（与步级端点同一口径；不带会话键的动词零影响）。
      const sessionErr = foreignSessionError(c, rt, body);
      if (sessionErr !== '') return c.json({ error: sessionErr }, 400);
      const note = bodyStr(body, 'note');
      const by = bodyStr(body, 'by', 'operator');
      // 审计文案按动词取人真正写的内容（2026-11-23）：rework 的意见在
      // body.feedback、align 的修正文在 body.amendment、amend 是补丁本体——
      // 此前一律记 body.note，这三个动词的审计行恒为空。口径与
      // lifecycle.ts recordGateDecision 一致。
      let auditNote = note;
      try {
        switch (verb) {
          case 'approve': {
            const sendAt = typeof body['send_at'] === 'string' && body['send_at'] !== '' ? body['send_at'] : undefined;
            await rt.engine.approve(id, note, by, sendAt);
            break;
          }
          case 'deny':
            await rt.engine.deny(id, note, by);
            break;
          case 'resolve':
            await rt.engine.resolve(id, note, by);
            break;
          case 'rework':
            auditNote = bodyStr(body, 'feedback');
            await rt.engine.rework(id, auditNote, by);
            break;
          case 'align':
            auditNote = bodyStr(body, 'amendment');
            await rt.engine.align(id, auditNote, by);
            break;
          case 'amend': {
            const p = body['patch'];
            const patch: JsonRecord = p !== null && typeof p === 'object' && !Array.isArray(p)
              ? p as JsonRecord
              : {};
            auditNote = JSON.stringify(patch);
            await rt.engine.amendStep(id, patch, by);
            break;
          }
        }
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
      const now = new Date().toISOString();
      rt.gates.register({ id, kind: hit.kind, workflowId: hit.workflowId, stepId: hit.stepId, title: hit.title, payload: hit.payload, now });
      rt.gates.decide(id, verb, by, auditNote, false, now);
      return c.json({ ok: true });
    });
  }
};
