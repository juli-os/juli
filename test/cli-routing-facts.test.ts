// cli/juli.ts 路由投影纯函数契约(R1 P2-3:routing plan --sample 声明表与
// 生产同源)。cli/juli.ts 有直跑守卫,import 零副作用,可安全单测。
import { describe, expect, it } from 'vitest';
import { SAMPLE_FACTS } from '@juli-os/routing';
import { factsForPlan, projectRoutingFacts } from '../cli/juli.ts';

describe('projectRoutingFacts:引擎 config → RoutingFacts 投影', () => {
  const cfg = {
    agents: [
      { session: 'juli-reply', company: 'Meridian', domain: 'reply', cwd: '/Users/op/services/juli-reply', description: '答复' },
      { session: 'project-a' },
    ],
    feedback_routing: { rules: [{ prefix: '/villa', session: 'juli-villa' }, { prefix: '', session: 'juli-reply' }] },
    email: { default_session: 'juli-reply' },
  };

  it('声明会话名/cwd/company/domain/description 逐项进入 facts', () => {
    const f = projectRoutingFacts(cfg);
    expect(f.agents.map((a) => a.session)).toEqual(['juli-reply', 'project-a']);
    expect(f.agents[0]).toMatchObject({
      cwd: '/Users/op/services/juli-reply', company: 'Meridian', domain: 'reply', description: '答复',
    });
  });

  it('未声明字段补空串、senders 缺省空数组(包 RouteAgent 形状)', () => {
    const f = projectRoutingFacts(cfg);
    expect(f.agents[1]).toEqual({
      session: 'project-a', company: '', domain: '', senders: [], cwd: '', description: '',
    });
  });

  it('前缀规则与渠道 default_session 进入 facts', () => {
    const f = projectRoutingFacts(cfg);
    expect(f.rules).toEqual([{ prefix: '/villa', session: 'juli-villa' }, { prefix: '', session: 'juli-reply' }]);
    expect(f.defaultSession).toBe('juli-reply');
  });

  it('空 config 投影为空菜单,default_session 兜底 juli-reply', () => {
    const f = projectRoutingFacts({});
    expect(f.agents).toEqual([]);
    expect(f.rules).toEqual([]);
    expect(f.defaultSession).toBe('juli-reply');
  });
});

describe('factsForPlan:声明表选择(生产同源优先,SAMPLE_FACTS 兜底)', () => {
  it('有 agents 声明 → 返回 config 投影(非 SAMPLE_FACTS)', () => {
    const f = factsForPlan({ agents: [{ session: 'juli-reply', cwd: '/Users/op/juli-reply' }] });
    expect(f).not.toBe(SAMPLE_FACTS);
    expect(f.agents.map((a) => a.session)).toEqual(['juli-reply']);
    expect(f.agents[0]!.cwd).toBe('/Users/op/juli-reply');
  });

  it('空声明(无 agents/agents:[])→ 回退 SAMPLE_FACTS(身份相等)', () => {
    expect(factsForPlan({})).toBe(SAMPLE_FACTS);
    expect(factsForPlan({ agents: [] })).toBe(SAMPLE_FACTS);
  });
});
