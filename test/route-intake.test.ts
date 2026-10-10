// route_intake 场景（2026-09-28 用户裁定「路由不该在规则层」）：邮件进件第一跳
// 的内容判定腿——规则（company/domain 发件域）降为兜底与对账基准。
// 纪律：绑定/authz 永不经判定；shadow=留痕不改行为；on+过阈值+答案在非绑定
// 声明表内才采纳；fail-open（off/挂/低置信=规则腿结果）。

import { describe, expect, it } from 'vitest';
import { type JudgmentGateway } from '@juli-os/routing';
import { makeEngine, makeEmail, until } from './helpers.ts';

const AGENTS = [
  { session: 'juli-reply', company: 'juli', domain: 'reply' },
  { session: 'acme', company: 'acme', domain: 'site', senders: ['casey.li@acme.de'] },
  { session: 'juli-dev', company: 'juli', domain: 'dev' },
];

const gw = (
  mode: 'shadow' | 'on',
  answer: string,
  confidence: number,
  ok = true,
): { gateway: JudgmentGateway; asks: string[] } => {
  const asks: string[] = [];
  return {
    asks,
    gateway: {
      threshold: () => 0.7,
      ask: async (scenario) => {
        asks.push(scenario);
        const base = { mode, threshold: 0.7, provider: 'test', model: 'jev-test', inputTokens: 7, outputTokens: 3, durationMs: 12 };
        if (!ok) return { ...base, ok: false, error: 'down' };
        return { ...base, ok: true, answer, confidence };
      },
    },
  };
};

const routing = { defaultSession: 'juli-reply', defaultProject: 'p', agents: AGENTS };

describe('route_intake 邮件进件内容判定', () => {
  it('off（无网关）→ 规则腿独走，零判定零留痕（既有行为）', async () => {
    const w = makeEngine({ routing });
    await w.engine.onEmailReceived(makeEmail({ subject: 'acme 工厂照片替换' }));
    const wf = w.store.listWorkflows()[0]!;
    const step = w.store.stepsForWorkflow(wf.id)[0]!;
    expect(step.input['session']).toBe('juli-reply'); // 0930：default 也显式钉（queued 即锚定占位），派发等价
    expect(w.store.listEvents(50).some((e) => e.type === 'route_judgment')).toBe(false);
    const rd = wf.meta['route_decision'] as { chain: readonly string[] };
    expect(rd.chain).toEqual(['authz', 'company', 'domain', 'default']);
  });

  it('shadow → 留痕对账（jev 答案 vs 规则会话+agree 旗），行为零变化', async () => {
    const j = gw('shadow', 'acme', 0.94);
    const w = makeEngine({ routing, judgment: j.gateway });
    await w.engine.onEmailReceived(makeEmail({ subject: 'acme 工厂照片替换' }));
    expect(j.asks).toEqual(['route_intake']);
    const events = w.store.listEvents(50);
    const rj = events.find((e) => e.type === 'route_judgment');
    expect(rj).toBeDefined();
    expect(rj!.payload['answer']).toBe('acme');
    expect(rj!.payload['rule_session']).toBe('juli-reply');
    expect(rj!.payload['agree']).toBe(false);
    // 行为零变化：路由照旧规则腿，播种步不钉 acme。
    const step = w.store.stepsForWorkflow(w.store.listWorkflows()[0]!.id)[0]!;
    expect(step.input['session']).toBe('juli-reply'); // 0930 显式钉默认
  });

  it('on + 声明表内 + 过阈值 → 采纳：route_decision 链尾多 jev 跳 + 播种步钉 acme + applied 留痕', async () => {
    const j = gw('on', 'acme', 0.94);
    const w = makeEngine({ routing, judgment: j.gateway });
    await w.engine.onEmailReceived(makeEmail({ subject: 'acme 中国的工厂照片替换' }));
    const wf = w.store.listWorkflows()[0]!;
    const rd = wf.meta['route_decision'] as { session: string; chain: readonly string[]; reasons: Record<string, string> };
    expect(rd.session).toBe('acme');
    expect(rd.chain).toEqual(['authz', 'company', 'domain', 'default', 'jev']);
    expect(rd.reasons['jev']).toContain('acme');
    const step = w.store.stepsForWorkflow(wf.id)[0]!;
    expect(step.input['session']).toBe('acme');
    expect(w.store.listEvents(50).some((e) => e.type === 'route_judgment_applied')).toBe(true);
  });

  it('on + 答案不在声明表 → 拒采纳回退规则腿（决定留引擎：答案合法性引擎侧校验）', async () => {
    const j = gw('on', 'claude-hallucination', 0.99);
    const w = makeEngine({ routing, judgment: j.gateway });
    await w.engine.onEmailReceived(makeEmail());
    const wf = w.store.listWorkflows()[0]!;
    expect((wf.meta['route_decision'] as { session: string }).session).toBe('juli-reply');
    const step = w.store.stepsForWorkflow(wf.id)[0]!;
    expect(step.input['session']).toBe('juli-reply'); // 0930 显式钉默认
    const rj = w.store.listEvents(50).find((e) => e.type === 'route_judgment_rejected');
    expect(rj!.payload['reason']).toBe('非声明会话');
  });

  it('on + 低置信 → 拒采纳（fail-safe：内容判定不笃定就按规则走）', async () => {
    const j = gw('on', 'acme', 0.4);
    const w = makeEngine({ routing, judgment: j.gateway });
    await w.engine.onEmailReceived(makeEmail());
    const wf = w.store.listWorkflows()[0]!;
    expect((wf.meta['route_decision'] as { session: string }).session).toBe('juli-reply');
  });

  it('判定服务挂 → error 留痕 + 规则腿照走（fail-open）', async () => {
    const j = gw('on', 'acme', 0.9, false);
    const w = makeEngine({ routing, judgment: j.gateway });
    await w.engine.onEmailReceived(makeEmail());
    const wf = w.store.listWorkflows()[0]!;
    expect((wf.meta['route_decision'] as { session: string }).session).toBe('juli-reply');
    const rj = w.store.listEvents(50).find((e) => e.type === 'route_judgment');
    expect(rj!.payload['error']).toBe('down');
  });

  it('绑定发件人 → 判定零调用（绑定隔离红线：白名单直达不经语义）', async () => {
    const j = gw('on', 'acme', 0.99);
    const w = makeEngine({
      routing: {
        ...routing,
        boundAgents: [{ session: 'project-a', cwd: '/w', senders: ['alice.chen@example.com'] }],
      },
      judgment: j.gateway,
      authz: { mode: 'allowlist', allow: ['alice.chen@example.com'], deny: [] },
    });
    await w.engine.onEmailReceived(makeEmail({ from: 'alice.chen@example.com', subject: '记账' }));
    expect(j.asks).toEqual([]);
    const wf = w.store.listWorkflows()[0]!;
    const step = w.store.stepsForWorkflow(wf.id)[0]!;
    expect(step.input['session']).toBe('project-a');
    expect(wf.meta['session_bound']).toBe('project-a');
  });

  it('采纳后的首步派发真落到采纳会话（端到端：钉 acme → dispatch acme）', async () => {
    const j = gw('on', 'acme', 0.94);
    const w = makeEngine({
      routing: { ...routing, defaultSession: 'juli-reply' },
      judgment: j.gateway,
      availableSessions: ['juli-reply', 'acme'],
    });
    await w.engine.onEmailReceived(makeEmail({ subject: 'acme 站点图片更新' }));
    const wf = w.store.listWorkflows()[0]!;
    await until(() => w.store.stepsForWorkflow(wf.id)[0]!.status === 'running');
    expect(w.dispatched[0]?.session).toBe('acme');
    expect(w.dispatched[0]?.text).toContain('acme 站点图片更新');
  });
});
