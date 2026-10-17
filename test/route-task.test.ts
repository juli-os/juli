// routeTask（0930「所有的都走路由」）：无键起单落点判定的契约——jev 内容
// 判定 > 忙闲改道（同公司空闲优先）> default 兜底；fail-open（判定挂/off/
// 低置信=既有 default 行为）。附带 sessionHasOpenWork 忙闲谓词的口径断言
// （忙=名下非终态单：排队/在跑/等批准都算）。

import { describe, expect, it } from 'vitest';
import { createLedgerStore } from '@juli-os/ledger';
import { makeClock, seqIds } from './helpers.ts';
import { routeTask, routeTaskMenu, type RouteTaskDeps } from '@juli-os/routing';
import { type JudgmentGateway, type JudgmentOutcome } from '@juli-os/routing';

const ROUTING = {
  defaultSession: 'juli-reply', defaultProject: 'p',
  boundAgents: [{ session: 'project-a', cwd: '~/f', senders: ['alice.chen@example.com'] }],
  agents: [
    { session: 'juli-reply', company: 'juli', domain: 'reply', senders: [], cwd: '', description: '通用答复' },
    { session: 'juli-dev', company: 'juli', domain: 'dev', senders: [], cwd: '', description: '引擎开发' },
    { session: 'juli-dev-hi', company: '', domain: '', senders: [], cwd: '', model_tier: 'high' as const },
    { session: 'acme', company: 'acme', domain: 'feedback', senders: ['casey.li@acme.de'], cwd: '', description: '官网维护' },
  ],
};

/** 剧本式假网关：ask 返回固定 outcome；off=null。 */
const fakeJudgment = (outcome: JudgmentOutcome | null): { gw: JudgmentGateway; asked: number } => {
  const asked = { n: 0 };
  return {
    asked: asked as unknown as number,
    gw: {
      threshold: () => 0.7,
      async ask() { (asked).n++; return outcome; },
    },
  };
};

const onOutcome = (answer: string, confidence = 0.9, mode: 'on' | 'shadow' = 'on'): JudgmentOutcome => ({
  mode, ok: true, threshold: 0.7, answer, confidence, provider: 'fake',
});

const deps = (over: Partial<RouteTaskDeps> = {}): RouteTaskDeps => ({
  routing: ROUTING,
  busySession: () => false,
  availableSessions: ['juli-reply', 'juli-dev', 'acme'],
  ...over,
});

describe('routeTaskMenu 候选纪律', () => {
  it('绑定会话与 high 档孪生不进菜单（守卫拒派/成本纪律）', () => {
    const menu = routeTaskMenu(ROUTING).map((a) => a.session);
    expect(menu).toEqual(['juli-reply', 'juli-dev', 'acme']);
    expect(menu).not.toContain('project-a');
    expect(menu).not.toContain('juli-dev-hi');
  });
});

describe('routeTask 判定链', () => {
  it('jev on+过阈值+菜单内 → 采纳；shadow 不生效', async () => {
    const a = await routeTask('官网文案修复', 'brief', deps({ judgment: fakeJudgment(onOutcome('acme')).gw }));
    expect(a).toMatchObject({ session: 'acme', via: 'jev', diverted: false });
    const sh = await routeTask('官网文案修复', 'brief', deps({ judgment: fakeJudgment(onOutcome('acme', 0.9, 'shadow')).gw }));
    expect(sh).toMatchObject({ session: 'juli-reply', via: 'default' });
  });

  it('jev 低置信/菜单外答案/网关 off/抛错 → fail-open 落 default', async () => {
    expect((await routeTask('t', 'b', deps({ judgment: fakeJudgment(onOutcome('acme', 0.3)).gw }))).session).toBe('juli-reply');
    expect((await routeTask('t', 'b', deps({ judgment: fakeJudgment(onOutcome('ghost-session')).gw }))).session).toBe('juli-reply');
    expect((await routeTask('t', 'b', deps({ judgment: fakeJudgment(null).gw }))).session).toBe('juli-reply');
    expect((await routeTask('t', 'b', deps())).session).toBe('juli-reply'); // 无网关
  });

  it('理想落点忙 → 同公司空闲优先；全忙 → 落理想会话排队', async () => {
    // ideal=juli-reply（公司 juli）忙 → 同公司空闲声明会话 juli-dev 先于跨公司 acme。
    const busy = new Set(['juli-reply']);
    const a = await routeTask('t', 'b', deps({ judgment: fakeJudgment(onOutcome('juli-reply')).gw, busySession: (s) => busy.has(s) }));
    expect(a).toMatchObject({ session: 'juli-dev', ideal: 'juli-reply', diverted: true, via: 'jev' });
    expect(a.note).toContain('diverted to');
    // 全忙 → 不硬塞别人，落理想会话排队。
    const allBusy = new Set(['acme', 'juli-reply', 'juli-dev']);
    const q = await routeTask('t', 'b', deps({ judgment: fakeJudgment(onOutcome('acme')).gw, busySession: (s) => allBusy.has(s) }));
    expect(q).toMatchObject({ session: 'acme', diverted: false });
    expect(q.note).toContain('queued');
  });

  it('空闲的 default 也是合法改道目标；候选须 tmux 真身存在（不在 → 跳过）', async () => {
    // acme 忙、juli-reply 空闲 → 跨公司改道 juli-reply（与派发面 others 同集）。
    const busy = new Set(['acme']);
    const a = await routeTask('t', 'b', deps({
      judgment: fakeJudgment(onOutcome('acme')).gw,
      busySession: (s) => busy.has(s),
    }));
    expect(a).toMatchObject({ session: 'juli-reply', ideal: 'acme', diverted: true });
    // acme+juli-reply 都忙、juli-dev 声明但不在 tmux → 无可用候选 → 排队理想会话。
    const busy2 = new Set(['acme', 'juli-reply']);
    const q = await routeTask('t', 'b', deps({
      judgment: fakeJudgment(onOutcome('acme')).gw,
      busySession: (s) => busy2.has(s),
      availableSessions: ['juli-reply', 'acme'], // juli-dev 不在 tmux
    }));
    expect(q).toMatchObject({ session: 'acme', diverted: false });
    expect(q.note).toContain('queued');
  });

  it('无候选声明会话 → default 直落（note 如实）', async () => {
    const a = await routeTask('t', 'b', deps({ routing: { defaultSession: 'juli-reply', defaultProject: 'p' } }));
    expect(a).toMatchObject({ session: 'juli-reply', via: 'default', diverted: false });
    expect(a.note).toContain('no candidate declared session');
  });

  it('jev 判中但声明会话离线（不在 tmux）→ 活性校验不过视同 fail-open（十一跑 P2-3）', async () => {
    // acme 声明在菜单但不在 tmux——采纳会把落点钉进离线会话，派发面
    // resolveSession 静默兜回 default 且钉住跟着走。落 default 不采纳。
    const a = await routeTask('t', 'b', deps({
      judgment: fakeJudgment(onOutcome('acme')).gw,
      availableSessions: ['juli-reply', 'juli-dev'], // acme 离线
    }));
    expect(a).toMatchObject({ session: 'juli-reply', via: 'default', ideal: 'juli-reply', diverted: false });
    expect(a.note).toContain('offline');
    expect(a.note).toContain('acme');
    // 对照：同一答案、会话在线 → 照常采纳。
    const b = await routeTask('t', 'b', deps({ judgment: fakeJudgment(onOutcome('acme')).gw }));
    expect(b).toMatchObject({ session: 'acme', via: 'jev' });
  });

  it('availableSessions 缺省（无 tmux 面）→ 不做活性校验，jev 采纳旧行为不变（十一跑 P2-3）', async () => {
    const a = await routeTask('t', 'b', deps({
      judgment: fakeJudgment(onOutcome('acme')).gw,
      availableSessions: undefined,
    }));
    expect(a).toMatchObject({ session: 'acme', via: 'jev' });
  });
});

describe('sessionHasOpenWork 忙闲口径（0930 重定义）', () => {
  const mk = () => createLedgerStore(':memory:', { clock: makeClock().clock, ids: seqIds() });

  it('排队中（queued+播种锚定）也忙；终态不忙', () => {
    const st = mk();
    const w = st.createWorkflow({ kind: 'adhoc', title: '排队单', status: 'queued', meta: { mode: 'nodes' } });
    st.setWorkflowSession(w.id, 'acme');
    expect(st.sessionHasOpenWork('acme')).toBe(true);
    st.setWorkflowStatus(w.id, 'completed');
    expect(st.sessionHasOpenWork('acme')).toBe(false);
  });

  it('在跑+等批准（步 waiting_human）都忙；自排除后不忙', () => {
    const st = mk();
    const w = st.createWorkflow({ kind: 'adhoc', title: '等批', status: 'running', meta: { mode: 'nodes' } });
    const s = st.createStep({ workflowId: w.id, seq: 1, kind: 'agent', title: '审', input: {} });
    st.setStepStatus(s.id, 'waiting_human');
    st.setWorkflowSession(w.id, 'juli-reply');
    expect(st.sessionHasOpenWork('juli-reply')).toBe(true);
    expect(st.sessionHasOpenWork('juli-reply', w.id)).toBe(false); // 派发面自排除
    expect(st.sessionHasOpenWork('acme')).toBe(false);
  });

  it('老形态锚（仅 runs 行）也认——派发事实即占用', () => {
    const st = mk();
    const w = st.createWorkflow({ kind: 'adhoc', title: '仅 runs', status: 'running', meta: { mode: 'nodes' } });
    st.createRun(w.id, 'juli-dev');
    expect(st.sessionHasOpenWork('juli-dev')).toBe(true);
  });
});
