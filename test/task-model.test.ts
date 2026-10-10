// 任务读模型（web/src/task-model.ts）+ 实体锚点契约（ui.ts entityAnchor）。
// 看板任务卡枢纽的单一读法：分组键三类身份、相位派生优先级、锚点 URL
// 契约——纯函数零 DOM，vitest 直测。状态判定断言的是「任务的相位」不是
// 事件回放：在跑>排队、全终态后办成>被否>失败>取消。

import { describe, expect, it } from 'vitest';
import {
  buildTaskCards, countByColumn, displayTitleOf, taskColumnOf, taskKeyOf, taskSortKeyOf, taskStatusOf,
  type TaskMapLike, type TaskRunLike,
} from '../web/src/task-model.ts';
import { anchorHref, colHref, entityAnchor } from '../web/src/anchors.ts';
import { KANBAN_ARCHIVE_KEY, KANBAN_OTHER_KEY, KANBAN_WAITING_KEY } from '../web/src/statuses.ts';

const run = (over: Partial<TaskRunLike> & { id: string }): TaskRunLike => ({
  status: 'completed', title: '', created_at: '2026-09-29T10:00:00Z', ...over,
});
const emptyMap: TaskMapLike = { tasks: [], map: {} };

describe('任务分组键：任务卡挂链 > Thread > 孤单', () => {
  it('task-map 命中 → t:<任务卡id>；thread → th:；都不是 → w:', () => {
    const map: TaskMapLike = { tasks: [{ id: 'wf_task1', title: 'banner 改版' }], map: { wf_a: 'wf_task1' } };
    expect(taskKeyOf(run({ id: 'wf_a' }), map)).toBe('t:wf_task1');
    expect(taskKeyOf(run({ id: 'wf_b', thread_id: 'th_9' }), map)).toBe('th:th_9');
    expect(taskKeyOf(run({ id: 'wf_c' }), map)).toBe('w:wf_c');
  });

  it('同 Thread 两封往来 = 一张任务卡；标题取最新成员（剥前缀）', () => {
    const cards = buildTaskCards([
      run({ id: 'wf_new', title: '回复：Re: PPT 需求', thread_id: 'th_1', status: 'running' }),
      run({ id: 'wf_old', title: 'PPT 需求', thread_id: 'th_1', meta: { from: 'casey@acme.de', date: '2026-09-28T09:00:00Z' } }),
    ], emptyMap);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.kind).toBe('thread');
    expect(cards[0]!.title).toBe('PPT 需求');
    expect(cards[0]!.runs.map((r) => r.id)).toEqual(['wf_new', 'wf_old']);
  });

  it('任务卡挂链优先于 Thread：跨线程挂同一任务卡仍是一件事', () => {
    const map: TaskMapLike = {
      tasks: [{ id: 'wf_task1', title: 'banner 全案' }],
      map: { wf_a: 'wf_task1', wf_b: 'wf_task1' },
    };
    const cards = buildTaskCards([
      run({ id: 'wf_a', thread_id: 'th_1' }),
      run({ id: 'wf_b', thread_id: 'th_2' }),
    ], map);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.kind).toBe('task');
    expect(cards[0]!.taskId).toBe('wf_task1');
    expect(cards[0]!.title).toBe('banner 全案');
  });

  it('孤单自成一事（历史行无任务卡无线程）', () => {
    const cards = buildTaskCards([run({ id: 'wf_x', title: 'ad-hoc' })], emptyMap);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.kind).toBe('solo');
    expect(cards[0]!.key).toBe('w:wf_x');
  });
});

describe('任务相位派生：在跑>排队；全终态后办成>被否>失败>取消', () => {
  const col = (...statuses: string[]): string =>
    taskColumnOf({ key: 'k', kind: 'solo', taskId: '', title: '', sessions: [], customer: '', runs: statuses.map((s, i) => run({ id: `wf_${i}`, status: s })) });

  it('在途 + 等人步数 → 等你决定列（等人是第一视觉）', () => {
    const { status } = taskStatusOf([run({ id: 'a', status: 'running' })]);
    expect(status).toBe('running');
    expect(col('running')).toBe('running');
    const withWaiting = taskColumnOf({
      key: 'k', kind: 'solo', taskId: '', title: '', sessions: [], customer: '',
      runs: [run({ id: 'a', status: 'running', waiting_steps: 2 })],
    });
    expect(withWaiting).toBe(KANBAN_WAITING_KEY);
  });

  it('有在途成员事未完：queued+completed 仍算排队，不被终态吞', () => {
    expect(col('completed', 'queued')).toBe('queued');
    expect(col('running', 'completed')).toBe('running');
  });

  it('全终态：任一办成 → 已完成（其余成员的失败是过程）', () => {
    expect(col('completed', 'failed')).toBe('completed');
  });

  it('无办成时：被否 > 失败 > 取消；全取消进归档区', () => {
    expect(col('rejected', 'failed')).toBe('rejected');
    expect(col('failed', 'cancelled')).toBe('failed');
    expect(col('cancelled', 'cancelled')).toBe(KANBAN_ARCHIVE_KEY);
  });

  it('名单外未知状态 → 「其他」列不隐藏', () => {
    expect(col('mystery_state')).toBe(KANBAN_OTHER_KEY);
  });
});

describe('任务卡锚点数据面', () => {
  it('customer = 最新非空 meta.from；sessions 去重保序（新→旧）', () => {
    const cards = buildTaskCards([
      run({ id: 'wf_1', session: 'juli-dev', thread_id: 'th_1', meta: { from: 'casey@acme.de' } }),
      run({ id: 'wf_2', session: 'juli-reply', thread_id: 'th_1', meta: {} }),
      run({ id: 'wf_3', session: 'juli-dev', thread_id: 'th_1', meta: { from: 'old@x.de' } }),
    ], emptyMap);
    expect(cards[0]!.customer).toBe('casey@acme.de');
    expect(cards[0]!.sessions).toEqual(['juli-dev', 'juli-reply']);
  });

  it('排序键 = 成员最新 meta.date（邮件世界的时间是发信时间）', () => {
    const cards = buildTaskCards([
      run({ id: 'wf_a', created_at: '2026-09-29T12:00:00Z', meta: { date: '2026-09-20T08:00:00Z' } }),
      run({ id: 'wf_b', created_at: '2026-09-28T12:00:00Z', meta: { date: '2026-09-27T08:00:00Z' } }),
    ], emptyMap);
    expect(cards.map((c) => c.runs[0]!.id)).toEqual(['wf_b', 'wf_a']);
    expect(taskSortKeyOf(cards[0]!)).toBe('2026-09-27T08:00:00Z');
  });
});

describe('实体锚点契约（URL 即导航）', () => {
  it('四类实体 → 四个落点投影', () => {
    expect(anchorHref('task', 't:wf_task1')).toBe('/kanban?task=t%3Awf_task1');
    expect(anchorHref('session', 'juli-dev')).toBe('/sessions?s=juli-dev');
    expect(anchorHref('customer', 'casey@acme.de')).toBe('/customers?focus=casey%40acme.de');
    expect(anchorHref('run', 'wf_1')).toBe('/order?w=wf_1');
  });

  it('空 id/空文本降级纯文本，不留死链接', () => {
    expect(entityAnchor('session', '', 'juli-dev')).toBe('juli-dev');
    expect(entityAnchor('customer', 'a@b.de', '')).toBe('');
    expect(entityAnchor('session', 'juli-dev', 'juli-dev'))
      .toBe('<a class="ea ea-session" href="#/sessions?s=juli-dev" title="">juli-dev</a>');
  });
});

describe('displayTitleOf：剥回复/转发前缀（展示去噪）', () => {
  it('中英前缀多层剥净，保留正文大小写', () => {
    expect(displayTitleOf('回复：Re: PPT 需求')).toBe('PPT 需求');
    expect(displayTitleOf('FW: Acme 询价')).toBe('Acme 询价');
    expect(displayTitleOf('无前缀主题')).toBe('无前缀主题');
  });
});

describe('总览统计与看板列同源（任务口径）：countByColumn === 看板 taskColumnOf 分桶', () => {
  it('同一份任务卡，统计卡数字 = 看板各列卡数；进行中=running+waiting（产品裁决：等人也是进行中）', () => {
    const tasks = buildTaskCards([
      run({ id: 'a', status: 'running', waiting_steps: 1, thread_id: 'th_1', created_at: '2026-09-29T10:00:00Z' }),
      run({ id: 'b', status: 'running', thread_id: 'th_2', created_at: '2026-09-29T09:00:00Z' }),
      run({ id: 'c', status: 'queued', created_at: '2026-09-29T08:00:00Z' }),
      run({ id: 'd', status: 'completed', created_at: '2026-09-29T07:00:00Z' }),
      run({ id: 'e', status: 'failed', created_at: '2026-09-29T06:00:00Z' }),
      run({ id: 'f', status: 'cancelled', created_at: '2026-09-29T05:00:00Z' }),
    ], emptyMap);
    const counts = countByColumn(tasks);
    // 分桶逐列对账（countByColumn 内部就是 taskColumnOf——物理同源由同一
    // 函数保证，这里锁定的是消费端语义：进行中并入 waiting 的产品裁决）。
    expect(counts[KANBAN_WAITING_KEY]).toBe(1);
    expect(counts['running']).toBe(1);
    expect(counts['queued']).toBe(1);
    expect(counts['completed']).toBe(1);
    expect(counts['failed']).toBe(1);
    expect(counts[KANBAN_ARCHIVE_KEY]).toBe(1);
    expect((counts['running'] ?? 0) + (counts[KANBAN_WAITING_KEY] ?? 0)).toBe(2); // 总览「进行中」=2
  });

  it('窗口语义锁定：相位只认传入的成员——窗口外的老执行不参与（视图窗口既定语义）', () => {
    // 同一任务的两次执行，窗口只含新执行（老执行滑出 limit=100）：
    const inWindow = [run({ id: 'new', status: 'running', thread_id: 'th_1' })];
    const cards = buildTaskCards(inWindow, emptyMap);
    expect(taskColumnOf(cards[0]!)).toBe('running');
    // 全窗口含老执行（已完成）时同任务仍「进行中」；只剩老执行则「已完成」。
    const withOld = buildTaskCards([
      run({ id: 'new', status: 'running', thread_id: 'th_1' }),
      run({ id: 'old', status: 'completed', thread_id: 'th_1' }),
    ], emptyMap);
    expect(taskColumnOf(withOld[0]!)).toBe('running');
    const onlyOld = buildTaskCards([run({ id: 'old', status: 'completed', thread_id: 'th_1' })], emptyMap);
    expect(taskColumnOf(onlyOld[0]!)).toBe('completed');
  });
});

describe('相位列链接契约（视图态锚点）', () => {
  it('colHref：#/kanban?col= 单一拼装点', () => {
    expect(colHref(KANBAN_WAITING_KEY)).toBe('/kanban?col=waiting');
    expect(colHref(KANBAN_OTHER_KEY)).toBe('/kanban?col=other');
  });
});
