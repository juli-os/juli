// 忙会话判定（2026-10-13 双落点事故修复）：
// 事故链：Apple 单卡闸门占 juli-reply（open work）→ 财务跟进挂靠继承
// juli-reply → 旧=「播种即钉住」硬闯派发 → contextGate 判切单 /clear 掉
// 活单上下文（138K）。裁定（用户 10-13）：忙时优先空闲 agent（否则多
// agent 无意义）；只有人显式点名才排队等原会话。落法=挂靠继承不钉
// （lifecycle 播种）+ holdGate 忙会话腿压单（engine）+ steps 守卫改道。

import { describe, expect, it } from 'vitest';
import { makeEngine, until } from './helpers.ts';

const decl = {
  defaultSession: 'juli-reply', defaultProject: 'p',
  agents: [
    { session: 'juli-reply', company: 'juli', domain: 'reply' },
    { session: 'juli-dev', company: 'juli', domain: 'dev' },
  ],
};

const settled = (w: { store: { getWorkflow: (id: string) => { status: string } | null } }, id: string) =>
  until(() => w.store.getWorkflow(id)!.status === 'running');

describe('忙会话判定（挂靠继承不钉）', () => {
  it('事故回放：挂靠继承落忙会话 → 改道空闲 agent（不硬闯、不钉住）', async () => {
    const w = makeEngine({ routing: decl, availableSessions: ['juli-reply', 'juli-dev'], queueConcurrency: 3 });
    const apple = await w.engine.startTask('Apple 调研', { session: 'juli-reply' });
    await settled(w, apple.id); // apple 占住 juli-reply（open work）
    const fin = await w.engine.startTask('财务跟进', { relates_to: apple.id });
    await until(() => w.dispatched.some((d) => d.text.includes('财务跟进')));
    const step = w.store.stepsForWorkflow(fin.id)[0]!;
    expect(step.input['session']).toBe('juli-reply');      // 继承仍作上下文倾向
    expect(step.input['session_pinned']).not.toBe(true);   // 但不再钉住（事故入口）
    expect(step.input['resolved_session']).toBe('juli-dev'); // 改道落空闲 agent
    expect(step.input['busy_diverted_from']).toBe('juli-reply');
    expect(w.dispatched.some((d) => d.session === 'juli-reply' && d.text.includes('财务跟进'))).toBe(false);
  });

  it('全忙：压单等待不派进忙会话；会话空出（force-close）自动放行到原会话', async () => {
    const w = makeEngine({ routing: decl, availableSessions: ['juli-reply', 'juli-dev'], queueConcurrency: 3 });
    const a = await w.engine.startTask('占位A', { session: 'juli-reply' });
    const b = await w.engine.startTask('占位B', { session: 'juli-dev' });
    await settled(w, b.id); // 两个声明会话都有 open work = 全忙
    const fin = await w.engine.startTask('财务跟进', { relates_to: a.id });
    await new Promise((r) => setTimeout(r, 150)); // 给 pump/异步留窗口
    expect(w.store.getWorkflow(fin.id)!.status).toBe('queued'); // 压单不派发
    expect(w.dispatched.some((d) => d.text.includes('财务跟进'))).toBe(false);
    await w.engine.forceClose(a.id, 'test', 'test'); // juli-reply 空出 → 泵队放行
    await until(() => w.dispatched.some((d) => d.text.includes('财务跟进')));
    expect(w.dispatched.find((d) => d.text.includes('财务跟进'))!.session).toBe('juli-reply');
  });

  it('人显式点名：忙时排队等原会话（钉住语义保留，不被改道）', async () => {
    const w = makeEngine({ routing: decl, availableSessions: ['juli-reply', 'juli-dev'], queueConcurrency: 3 });
    const a = await w.engine.startTask('占位A', { session: 'juli-reply' });
    await settled(w, a.id);
    const t = await w.engine.startTask('点名跟进', { session: 'juli-reply' });
    await new Promise((r) => setTimeout(r, 150));
    expect(w.store.getWorkflow(t.id)!.status).toBe('queued'); // 等，不派
    expect(w.dispatched.some((d) => d.text.includes('点名跟进'))).toBe(false); // 也不改道去 juli-dev
    await w.engine.forceClose(a.id, 'test', 'test');
    await until(() => w.dispatched.some((d) => d.text.includes('点名跟进')));
    expect(w.dispatched.find((d) => d.text.includes('点名跟进'))!.session).toBe('juli-reply');
  });

  it('继承落空闲会话：照常落原会话（上下文延续不受影响）', async () => {
    const w = makeEngine({ routing: decl, availableSessions: ['juli-reply', 'juli-dev'], queueConcurrency: 3 });
    const parent = await w.engine.startTask('父单', { session: 'juli-reply' });
    await w.engine.forceClose(parent.id, 'test', 'test'); // 父单终态=juli-reply 空闲
    await until(() => w.store.getWorkflow(parent.id)!.status !== 'running');
    const fin = await w.engine.startTask('跟进', { relates_to: parent.id });
    await until(() => w.dispatched.some((d) => d.text.includes('跟进')));
    const step = w.store.stepsForWorkflow(fin.id)[0]!;
    expect(step.input['resolved_session']).toBeUndefined(); // 没有改道
    expect(w.dispatched.find((d) => d.text.includes('跟进'))!.session).toBe('juli-reply');
  });
});
