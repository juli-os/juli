// gates 域 HTTP 面测试（2026-11-12 第 5 步）：/api/gates 统一待决列表的投影
// （workflow_gate/agent_ask 两 kind）、六动词转发 engine 正门、决策审计落
// gate_items、chat_confirm 卡的引导语义。

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { openGatesStore, listGates } from '../src/business/gates/index.ts';
import { registerGatesRoutes } from '../src/http/routes/gates.ts';
import type { AppEnv } from '../src/http/helpers.ts';
import type { JsonRecord } from '../src/platform/shared/json.ts';
import type { Runtime } from '../src/runtime.ts';
import type { ArtifactPort } from '../src/contracts/ports.ts';
import { makeEngine, until } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'juli-gates-api-'));

/** 真 store + 真 gates 库 + fake engine 动作面（记录动词转发）。 */
const makeRt = (over: { readonly bySession?: Readonly<Record<string, string>> } = {}): { rt: Runtime; calls: { verb: string; id: string; note: string; by: string }[] } => {
  const w = makeEngine();
  const calls: { verb: string; id: string; note: string; by: string }[] = [];
  const gates = openGatesStore(join(dir, `gates-${Math.random().toString(36).slice(2)}.db`));
  const engine = new Proxy(w.engine, {
    get(target, prop) {
      if (prop === 'approve' || prop === 'deny' || prop === 'resolve' || prop === 'rework' || prop === 'align') {
        return async (id: string, a?: string, by?: string) => {
          calls.push({ verb: String(prop), id, note: a ?? '', by: by ?? '' });
        };
      }
      if (prop === 'amendStep') {
        return async (id: string) => { calls.push({ verb: 'amend', id, note: '', by: '' }); };
      }
      return Reflect.get(target, prop);
    },
  });
  const rt = {
    store: w.store, gates, engine,
    config: { data_dir: dir },
    tenants: { bySession: over.bySession ?? {}, stampableTenants: new Set<string>() },
  } as unknown as Runtime;
  return { rt, calls };
};

/** tenant 给值 = 以该租户的单租户身份发请求（中间件解析 X-Juli-Tenant 后挂到
 *  context 的同一形状）；缺省 = 无头 operator（all）。 */
const appOf = (rt: Runtime, tenant?: string): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();
  if (tenant !== undefined) {
    app.use('*', async (c, next) => {
      c.set('tenantScope', { kind: 'one', tenant });
      await next();
    });
  }
  registerGatesRoutes(app, rt);
  return app;
};

const j = async (app: ReturnType<typeof appOf>, method: string, path: string, body?: unknown) => {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) as Record<string, unknown> };
};

describe('/api/gates：统一待决面', () => {
  it('列表投影：waiting_human 闸步 → workflow_gate；问询闸 → agent_ask', () => {
    const { rt } = makeRt();
    const w = rt.store;
    const wf = w.createWorkflow({ kind: 'case', title: '外单', meta: { from: 'a@b.co' } });
    const g1 = w.createStep({ workflowId: wf.id, seq: 1, kind: 'gate', title: '确认闸门', input: { delivery: 'apply' } });
    w.setStepStatus(g1.id, 'waiting_human');
    const g2 = w.createStep({ workflowId: wf.id, seq: 2, kind: 'gate', title: '问询', input: { delivery: 'answer', question: '选哪个', question_options: [{ label: 'A', reply: 'a' }] } });
    w.setStepStatus(g2.id, 'waiting_human');

    const gates = listGates(w, rt.gates);
    expect(gates).toHaveLength(2);
    const kinds = new Map(gates.map((g) => [g.title, g.kind]));
    expect(kinds.get('确认闸门')).toBe('workflow_gate');
    expect(kinds.get('问询')).toBe('agent_ask');
    expect(gates.every((g) => g.workflowId === wf.id)).toBe(true);
  });

  it('GET /api/gates 返回投影行；决策后列表收缩', async () => {
    const { rt, calls } = makeRt();
    const wf = rt.store.createWorkflow({ kind: 'case', title: 't' });
    const g = rt.store.createStep({ workflowId: wf.id, seq: 1, kind: 'gate', title: '确认', input: { delivery: 'artifact' } });
    rt.store.setStepStatus(g.id, 'waiting_human');
    const app = appOf(rt);

    const r1 = await j(app, 'GET', '/api/gates?status=open');
    expect(r1.status).toBe(200);
    expect((r1.data['gates'] as { id: string }[]).map((x) => x.id)).toContain(g.id);

    const r2 = await j(app, 'POST', `/api/gates/${g.id}/approve`, { note: '可以', by: 'nagle' });
    expect(r2.status).toBe(200);
    expect(calls).toEqual([{ verb: 'approve', id: g.id, note: '可以', by: 'nagle' }]);
    // 审计行已落（decided）
    const audit = rt.gates.get(g.id);
    expect(audit?.status).toBe('decided');
    expect(audit?.decision?.verb).toBe('approve');
    expect(audit?.decision?.by).toBe('nagle');
    // approve 转发只打到 fake engine——真 store 里步没翻（投影测试世界引擎是
    // 桩），此处断言的是动词面；真实翻转由 engine 正门测试覆盖。
  });

  it('六动词路由齐备：deny/resolve/rework/align/amend 各自转发', async () => {
    const { rt, calls } = makeRt();
    const mk = (title: string): string => {
      const wf = rt.store.createWorkflow({ kind: 'case', title: 'w-' + title });
      const g = rt.store.createStep({ workflowId: wf.id, seq: 1, kind: 'gate', title, input: { delivery: 'artifact' } });
      rt.store.setStepStatus(g.id, 'waiting_human');
      return g.id;
    };
    const app = appOf(rt);
    const cases: readonly [string, string, Record<string, unknown>][] = [
      ['deny', mk('d1'), { note: '不要' }],
      ['resolve', mk('d2'), { note: '别处已办' }],
      ['rework', mk('d3'), { feedback: '改一下' }],
      ['align', mk('d4'), { amendment: '以我说的为准' }],
      ['amend', mk('d5'), { patch: { note: '补充' } }],
    ];
    for (const [verb, id, body] of cases) {
      const r = await j(app, 'POST', `/api/gates/${id}/${verb}`, body);
      expect(r.status, `${verb} 应 200`).toBe(200);
    }
    expect(calls.map((c) => c.verb).sort()).toEqual(['align', 'amend', 'deny', 'resolve', 'rework']);
  });

  it('chat_confirm 卡：动词 400 引导走 chat intake 端点', async () => {
    const { rt } = makeRt();
    const now = new Date().toISOString();
    rt.gates.register({ id: 'cc-wf9', kind: 'chat_confirm', workflowId: 'wf9', title: '开单计划确认', payload: {}, now });
    const app = appOf(rt);
    const r1 = await j(app, 'GET', '/api/gates?status=open');
    expect((r1.data['gates'] as { id: string }[]).map((x) => x.id)).toContain('cc-wf9');
    const r2 = await j(app, 'POST', '/api/gates/cc-wf9/approve', { note: '' });
    expect(r2.status).toBe(400);
    expect(String(r2.data['error'])).toContain('/api/chat/intake/');
  });

  it('未知卡 404', async () => {
    const { rt } = makeRt();
    const app = appOf(rt);
    const r = await j(app, 'POST', '/api/gates/nope/approve', {});
    expect(r.status).toBe(404);
  });

  // 2026-11-23：rework / align 的审计此前恒记空 note（前端传的内容在
  // body.feedback / body.amendment 里，路由只读了 body.note）。口径与
  // lifecycle.ts recordGateDecision 一致：rework 记 feedback、align 记
  // amendment、amend 记补丁 JSON。
  it('rework / align / amend 的审计行记真正的内容（不再记空 note）', async () => {
    const { rt } = makeRt();
    const mk = (title: string): string => {
      const wf = rt.store.createWorkflow({ kind: 'case', title: 'w-' + title });
      const g = rt.store.createStep({ workflowId: wf.id, seq: 1, kind: 'gate', title, input: { delivery: 'artifact' } });
      rt.store.setStepStatus(g.id, 'waiting_human');
      return g.id;
    };
    const cases: readonly [string, string, Record<string, unknown>, string][] = [
      ['rework', mk('audit-r'), { feedback: '正文补上披露落款' }, '正文补上披露落款'],
      ['align', mk('audit-a'), { amendment: '收件人写成王工，不是李工' }, '收件人写成王工，不是李工'],
      ['amend', mk('audit-m'), { patch: { in_reply_to: '<x@y>' } }, JSON.stringify({ in_reply_to: '<x@y>' })],
      // 显式带 note 的动作照旧记 note。
      ['deny', mk('audit-d'), { note: '不要' }, '不要'],
    ];
    const app = appOf(rt);
    for (const [verb, id, body] of cases) {
      const r = await j(app, 'POST', `/api/gates/${id}/${verb}`, body);
      expect(r.status, verb).toBe(200);
    }
    for (const [verb, id, , note] of cases) {
      expect(rt.gates.get(id)!.decision, verb).toMatchObject({ verb, note });
    }
  });
});

// 2026-11-23：上面的用例把 amendStep 桩掉了，所以「等待人工的发送审批点补料
// 必失败」一直是绿的（真引擎只收 pending/failed，审批卡上的闸门是
// waiting_human）。这里走真实引擎。

describe('/api/gates/:id/amend：等待人工的发送审批（真实引擎）', () => {
  const BODY = '回信正文如约定。\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。';
  /** 任务流发送闸（from 空、nodes）：收件人=申报 envelope.to，正文=body 工件。 */
  const makeSendGate = () => {
    const sha = createHash('sha256').update(BODY).digest('hex');
    const w = makeEngine({
      artifacts: {
        list: () => [], updateMeta: () => {},
        getContent: async (id) => id === 'art_body'
          ? { bytes: Buffer.from(BODY), sha256: sha, name: 'b.txt', viewRole: 'body' }
          : null,
        sweepCaseInbox: async () => ({ count: 0, entries: [], envelope: null, warnings: [], has_manifest: false }),
      } satisfies ArtifactPort,
      caseInboxDir: () => dir,
    });
    const gates = openGatesStore(join(dir, `gates-live-${Math.random().toString(36).slice(2)}.db`));
    const rt = {
      store: w.store, gates, engine: w.engine,
      config: { data_dir: dir },
      tenants: { bySession: {}, stampableTenants: new Set<string>() },
    } as unknown as Runtime;
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '任务流发送单', status: 'running', meta: { mode: 'nodes' } });
    const gate = w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'gate', title: '发送闸门',
      input: {
        envelope: { to: 'wrong@example.com' },
        deliverables: [{ id: 'art_body', name: 'b.txt', view_role: 'body', sha256: sha }],
      },
    });
    w.store.setStepStatus(gate.id, 'waiting_human');
    const send = w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'send', title: '发送', input: {} });
    return { w, rt, gate, send };
  };
  const PATCH = { envelope: { to: 'right@example.com' } };

  it('补料成功 → input 更新、步状态不变、事件留痕 → 批准后发送步用的是补过的收件人', async () => {
    const { w, rt, gate, send } = makeSendGate();
    const app = appOf(rt);
    const r = await j(app, 'POST', `/api/gates/${gate.id}/amend`, { patch: PATCH, by: 'nagle' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const g = w.store.getStep(gate.id)!;
    expect(g.status).toBe('waiting_human'); // 补料不是决定：闸门还在等人
    expect(g.input['envelope']).toEqual({ to: 'right@example.com' });
    expect(w.store.getStep(send.id)!.status).toBe('pending'); // 批准前不播种、不推进
    expect(w.store.getStep(send.id)!.input).toEqual({});
    // 修正记账：before/after/by。
    const ev = w.store.listEvents(200).find((e) => e.type === 'step_input_amended');
    expect(ev?.payload).toMatchObject({
      step: gate.id, kind: 'gate', keys: ['envelope'],
      before: { envelope: { to: 'wrong@example.com' } }, after: PATCH, by: 'nagle',
    });
    // 审计行记补丁本体（与 lifecycle 的 recordGateDecision 同口径）。
    expect(rt.gates.get(gate.id)!.decision).toEqual({ verb: 'amend', note: JSON.stringify(PATCH), by: 'nagle', auto: false });

    const a = await j(app, 'POST', `/api/gates/${gate.id}/approve`, { note: '可以', by: 'nagle' });
    expect(a.status, JSON.stringify(a.data)).toBe(200);
    await until(() => w.sent.length === 1);
    expect(w.sent[0]!.to).toBe('right@example.com'); // 发的是补过的收件人
    expect(w.sent[0]!.body).toContain('回信正文如约定');
  });

  it('补料不越过人审：补完闸门仍在等人，没批准就不发', async () => {
    const { w, rt, gate, send } = makeSendGate();
    const r = await j(appOf(rt), 'POST', `/api/gates/${gate.id}/amend`, { patch: PATCH, by: 'nagle' });
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 40));
    expect(w.sent).toHaveLength(0);
    expect(w.store.getStep(gate.id)!.status).toBe('waiting_human');
    expect(w.store.getStep(send.id)!.status).toBe('pending');
  });

  it('只放开「gate 且 waiting_human」这一种：其它状态照旧拒绝补料', async () => {
    const { w, gate } = makeSendGate();
    const patch = { envelope: { to: 'right@example.com' } };
    // 同一张闸依次摆到此外的状态（pending/failed 是原本就收的，不在其列）：
    // 每种都必须被拒。
    for (const status of ['completed', 'cancelled', 'skipped'] as const) {
      w.store.setStepStatus(gate.id, status);
      await expect(w.engine.amendStep(gate.id, patch, 'nagle'), status).rejects.toThrow(/only pending\/failed/);
    }
    w.store.setStepStatus(gate.id, 'running');
    await expect(w.engine.amendStep(gate.id, patch, 'nagle')).rejects.toThrow(/is running/);
    // 非 gate 的步即使停在 waiting_human 也不放开。
    const agent = w.store.createStep({ workflowId: gate.workflowId, seq: 3, kind: 'agent', title: '执行', input: { plan: 'x' } });
    w.store.setStepStatus(agent.id, 'waiting_human');
    await expect(w.engine.amendStep(agent.id, patch, 'nagle')).rejects.toThrow(/only pending\/failed/);
    expect(w.store.getStep(gate.id)!.input['envelope']).toEqual({ to: 'wrong@example.com' });
    expect(w.store.getStep(agent.id)!.input).toEqual({ plan: 'x' });
    expect(w.store.listEvents(200).filter((e) => e.type === 'step_input_amended')).toEqual([]);
  });

  it('已收尾的单子（终态工作流）里的等待闸门照旧拒绝补料', async () => {
    const { w, gate } = makeSendGate();
    w.store.setWorkflowStatus(gate.workflowId, 'cancelled');
    await expect(w.engine.amendStep(gate.id, PATCH, 'nagle')).rejects.toThrow(/start a new run/);
    expect(w.store.getStep(gate.id)!.input['envelope']).toEqual({ to: 'wrong@example.com' });
  });
});

// 2026-11-24 复审 P3-⑥：等待中的闸门可以补料之后，有两件事没管——
// (a) 什么键都能补：delivery / checks 这些引擎管的键也写得进去，卡面和账本说的
//     就不是同一件事了；
// (b) 人改了正文，发送检查不重算：卡上的红绿灯还是开闸时按旧正文跑的
//    （agentSettle 的收编那条路早就重算，见 2026-11-04 R1 P2-5）。这里走真实引擎。
describe('等待中的闸门补料：挑键 + 重算检查（R1 复审 P3-⑥）', () => {
  type Check = { name: string; status: string; detail: string };
  const checksOf = (w: ReturnType<typeof makeEngine>, id: string): readonly Check[] =>
    w.store.getStep(id)!.input['checks'] as unknown as readonly Check[];
  const checkNamed = (w: ReturnType<typeof makeEngine>, id: string, name: string): Check | undefined =>
    checksOf(w, id).find((c) => c.name === name);
  const sendChecksEvents = (w: ReturnType<typeof makeEngine>, id: string) =>
    w.store.entityEvents('step', id, 'send_checks_ran', 10);

  /** 内联草稿的发送闸（没有 body 工件）：改正文就是改 input.draft，检查跟着变。 */
  const makeDraftGate = (over: { title?: string; input?: JsonRecord } = {}) => {
    const w = makeEngine({ redlineWords: ['禁词甲'] });
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: '任务流发送单', status: 'running', meta: { mode: 'nodes' } });
    const gate = w.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'gate', title: over.title ?? '发送闸门',
      input: over.input ?? { draft: '干净正文', envelope: { to: 'a@example.com' } },
    });
    w.store.setStepStatus(gate.id, 'waiting_human');
    const send = w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'send', title: '发送', input: {} });
    return { w, gate, send };
  };

  it('引擎管的键不许补：五个键各自报错、input 原样；和合法的键混在一起整包拒绝', async () => {
    const { w, gate } = makeDraftGate();
    for (const key of ['delivery', 'checks', 'checked_at', 'send_checks_ran', 'question_options']) {
      await expect(w.engine.amendStep(gate.id, { [key]: 'x' }, 'nagle'), key).rejects.toThrow(/managed by the engine/);
    }
    await expect(w.engine.amendStep(gate.id, { draft: '新正文', delivery: 'artifact' }, 'nagle'))
      .rejects.toThrow(/managed by the engine/);
    const g = w.store.getStep(gate.id)!;
    expect(g.input).toEqual({ draft: '干净正文', envelope: { to: 'a@example.com' } });
    expect(g.status).toBe('waiting_human');
    // 被拒的补料不留「已补料」的账。
    expect(w.store.listEvents(200).filter((e) => e.type === 'step_input_amended')).toEqual([]);
  });

  it('pending / failed 步骤的补料规则不变：同样的键补到待办的发送步上照旧收', async () => {
    const { w, gate, send } = makeDraftGate();
    await w.engine.amendStep(send.id, { checks: [], delivery: 'x' }, 'nagle');
    expect(w.store.getStep(send.id)!.input).toEqual({ checks: [], delivery: 'x' });
    expect(w.store.getStep(send.id)!.status).toBe('pending');
    expect(w.store.getStep(gate.id)!.input['draft']).toBe('干净正文');
  });

  it('补料改了正文：发送检查重算，红绿灯跟着新正文走，checked_at 更新，留 send_checks_ran 事件', async () => {
    const { w, gate } = makeDraftGate();
    // 开闸时按旧正文跑的检查（摆一个），补料后必须被覆盖。
    w.store.setStepInput(gate.id, {
      checks: [{ name: 'redline', status: 'pass', detail: '开闸时按旧正文跑的' }], checked_at: '2020-01-01T00:00:00.000Z',
    });
    w.advanceClock(60_000);

    await w.engine.amendStep(gate.id, { draft: '正文里有禁词甲' }, 'nagle');
    expect(checkNamed(w, gate.id, 'redline')?.status).toBe('fail');
    expect(checkNamed(w, gate.id, 'redline')?.detail).toContain('禁词甲');
    expect(w.store.getStep(gate.id)!.input['checked_at']).not.toBe('2020-01-01T00:00:00.000Z');
    expect(sendChecksEvents(w, gate.id).some((e) => e.payload?.['recompute'] === true)).toBe(true);

    // 再改回干净正文：红灯撤掉。
    w.advanceClock(60_000);
    const before = String(w.store.getStep(gate.id)!.input['checked_at']);
    await w.engine.amendStep(gate.id, { draft: '又是干净正文' }, 'nagle');
    expect(checkNamed(w, gate.id, 'redline')?.status).toBe('pass');
    expect(String(w.store.getStep(gate.id)!.input['checked_at'])).not.toBe(before);
    expect(w.store.getStep(gate.id)!.status).toBe('waiting_human'); // 补料不是决定
  });

  it('补料只改了和正文无关的键（回信引用、定时）：不重算检查，卡上的结果原样', async () => {
    // R2 复审 P3-H：重算要联网探活链接，最长十几秒，还占着工作流锁——
    // 改的东西不影响正文就不该跑。
    const { w, gate } = makeDraftGate();
    const old = [{ name: 'redline', status: 'pass', detail: '开闸时按旧正文跑的' }];
    w.store.setStepInput(gate.id, { checks: old, checked_at: '2020-01-01T00:00:00.000Z' });
    w.advanceClock(60_000);

    await w.engine.amendStep(gate.id, { in_reply_to: '<x@y>', send_at: '2030-01-01T00:00:00Z', subject: '改了主题' }, 'nagle');
    expect(w.store.getStep(gate.id)!.input['checks']).toEqual(old);
    expect(w.store.getStep(gate.id)!.input['checked_at']).toBe('2020-01-01T00:00:00.000Z');
    expect(sendChecksEvents(w, gate.id)).toEqual([]);
    expect(w.store.getStep(gate.id)!.input['in_reply_to']).toBe('<x@y>'); // 补料本身照常生效
  });

  it('非发送决策闸（申报 artifact）补料不跑检查', async () => {
    const { w, gate } = makeDraftGate({ title: '确认闸门', input: { delivery: 'artifact', draft: '方案正文' } });
    await w.engine.amendStep(gate.id, { draft: '改过的方案正文' }, 'nagle');
    const g = w.store.getStep(gate.id)!;
    expect(g.input['draft']).toBe('改过的方案正文');
    expect(g.input['checks']).toBeUndefined();
    expect(sendChecksEvents(w, gate.id)).toEqual([]);
  });
});

// 2026-11-23：/api/gates/:id/amend 收 body.patch（补丁全量写进步 input），但
// 此前没过 foreignSessionError——单租户身份能把本租户的闸门补丁钉到别家会话
// （/api/lifecycle/steps/:id/amend 同一个口早就拦了）。
describe('/api/gates/:id/amend：单租户身份的钉会话闸', () => {
  it('补丁里钉别家会话 / 未声明会话 400，不进引擎；钉本租户会话照常；无头 operator 不受限', async () => {
    const { rt, calls } = makeRt({ bySession: { 'sess-mine': 't1', 'juli-reply': 't2' } });
    const wf = rt.store.createWorkflow({ kind: 'case', title: '本租户发送单', tenant: 't1' });
    const g = rt.store.createStep({
      workflowId: wf.id, seq: 1, kind: 'gate', title: '发送闸门',
      input: { delivery: 'email', envelope: { to: 'a@b.co' } },
    });
    rt.store.setStepStatus(g.id, 'waiting_human');
    const before = JSON.stringify(rt.store.getStep(g.id)!.input);
    const app = appOf(rt, 't1');
    for (const patch of [
      { session: 'juli-reply' },
      { resolved_session: 'juli-reply' },
      { envelope: { to: 'x@y.z' }, session: 'no-such-session' },
    ]) {
      const r = await j(app, 'POST', `/api/gates/${g.id}/amend`, { patch, by: 'nagle' });
      expect(r.status, JSON.stringify(patch)).toBe(400);
      expect(String(r.data['error']), JSON.stringify(patch)).toContain('不属于本租户');
    }
    expect(calls).toEqual([]); // 一律没进引擎
    expect(JSON.stringify(rt.store.getStep(g.id)!.input)).toBe(before);
    // 钉本租户会话：过闸。
    const mine = await j(app, 'POST', `/api/gates/${g.id}/amend`, { patch: { session: 'sess-mine' }, by: 'nagle' });
    expect(mine.status).toBe(200);
    // 无头 operator：跨租户钉会话照旧允许（账面与执行会话可分叉是既定设计）。
    const all = await j(appOf(rt), 'POST', `/api/gates/${g.id}/amend`, { patch: { session: 'juli-reply' } });
    expect(all.status).toBe(200);
    expect(calls.map((c) => c.verb)).toEqual(['amend', 'amend']);
  });
});

it('cleanup', () => { rmSync(dir, { recursive: true, force: true }); });
