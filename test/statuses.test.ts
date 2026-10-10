// 状态唯一名单 + Task 最小转正（第四期 2026-09-22）：
// 1. 名单完整性——真实 DB（同一 sqlite schema，内存库）里能出现的每个状态
//    都必须在名单内；类型全集穷尽守卫（新增状态不改名单 = 编译期红灯）。
// 2. 看板列生成纯函数——列由名单长出来（含「失败」列，走查痛点）；名单外
//    未知状态进「其他」，不隐藏。
// 3. 总览计数与看板列同源——同一输入，countByStatus 的数字 === 看板分桶数。
// 4. web 对齐副本逐字对齐单一事实源（web 不引 src，测试强制同步）。
// 5. Task 投影（store 层聚合）——一 Task 多流水，链爬根 + 环守卫 + 端点冒烟。

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createLedgerStore, type LifecycleStore } from '../src/platform/ledger/store.ts';
import { TERMINAL_WORKFLOW_STATUSES, type StepKind, type StepStatus, type WorkflowStatus } from '../src/contracts/entities.ts';
import {
  ACTIVE_STEP_STATUSES, ACTIVE_WORKFLOW_STATUSES, DEDUP_WINDOW_STATUSES,
  PRUNE_WORKFLOW_STATUSES, SETTLED_STEP_STATUSES, SETTLED_WORKFLOW_STATUSES,
  STATUS_GROUP_OTHER, STEP_STATUSES, TERMINAL_STEP_STATUSES, WORKFLOW_STATUSES,
  isActiveStepStatus, isActiveWorkflowStatus, isLiveNodeStatus, isSettledStepStatus,
  isSettledWorkflowStatus, isTerminalStepStatus, sqlInList, statusLabelOf,
} from '../src/contracts/statuses.ts';
import type { JsonRecord } from '../src/platform/shared/json.ts';
import {
  KANBAN_ARCHIVE_KEY, KANBAN_COLUMNS, KANBAN_OTHER_KEY, KANBAN_WAITING_KEY,
  LIFECYCLE_FILTERS, ALL_STATUS_LABELS, STEP_STATUSES as WEB_STEP_STATUSES,
  WORKFLOW_STATUSES as WEB_WORKFLOW_STATUSES, currentStepOf,
  kanbanColumnOf, kanbanColumnsFromStatuses, CURRENT_PRIORITY as CURRENT_PRIORITY_WEB,
} from '../web/src/statuses.ts';

// 类型穷尽守卫（编译期）：types.ts 的状态联合新增成员而名单未跟 → 下面两个
// 字面量缺 key，npx tsc 直接红灯——名单完整性由类型系统兜底。
const WF_UNION_GUARD: Record<WorkflowStatus, true> = {
  queued: true, running: true, completed: true, failed: true, cancelled: true, rejected: true,
};
const STEP_UNION_GUARD: Record<StepStatus, true> = {
  pending: true, running: true, waiting_human: true, completed: true, failed: true, cancelled: true, skipped: true,
};
void WF_UNION_GUARD;
void STEP_UNION_GUARD;

describe('状态唯一名单：完整性', () => {
  it('名单 key 集合 === 类型联合全集（穷尽守卫与名单互锁）', () => {
    expect(WORKFLOW_STATUSES.map((s) => s.key).sort()).toEqual(Object.keys(WF_UNION_GUARD).sort());
    expect(STEP_STATUSES.map((s) => s.key).sort()).toEqual(Object.keys(STEP_UNION_GUARD).sort());
  });

  it('名单终态集合 === TERMINAL_WORKFLOW_STATUSES（types.ts 单一语义不二写）', () => {
    const terminalInList = WORKFLOW_STATUSES.filter((s) => s.terminal).map((s) => s.key).sort();
    expect(terminalInList).toEqual([...TERMINAL_WORKFLOW_STATUSES].sort());
  });

  it('真实 DB 状态全集 ⊆ 名单（同一 sqlite schema 内存库全状态写入后回读）', () => {
    const store: LifecycleStore = createLedgerStore(':memory:');
    for (const s of WORKFLOW_STATUSES) {
      store.createWorkflow({ kind: 'adhoc', title: s.label, status: s.key as WorkflowStatus });
    }
    const wf = store.createWorkflow({ kind: 'adhoc', title: 'steps-host' });
    const kinds: StepKind[] = ['gate', 'agent'];
    let seq = 0;
    for (const s of STEP_STATUSES) {
      const st = store.createStep({ workflowId: wf.id, seq: ++seq, kind: kinds[seq % 2]!, title: s.label });
      store.setStepStatus(st.id, s.key as StepStatus);
    }
    const wfRows = store.db.prepare('SELECT DISTINCT status FROM workflows').all() as { status: string }[];
    const stepRows = store.db.prepare('SELECT DISTINCT status FROM workflow_steps').all() as { status: string }[];
    const wfKeys = new Set(WORKFLOW_STATUSES.map((s) => s.key));
    const stepKeys = new Set(STEP_STATUSES.map((s) => s.key));
    for (const r of wfRows) expect(wfKeys.has(r.status), `账本状态 ${r.status} 不在名单`).toBe(true);
    for (const r of stepRows) expect(stepKeys.has(r.status), `步骤状态 ${r.status} 不在名单`).toBe(true);
  });

  it('生产库只读取证分布（2026-09-21）⊆ 名单：cancelled 89 / completed 45 / failed 4', () => {
    // 取证命令：sqlite3 "file:$HOME/.juli-service/lifecycle.db?mode=ro"
    //   SELECT status, count(*) FROM workflows GROUP BY status;
    const evidence = ['cancelled', 'completed', 'failed'];
    const keys = new Set(WORKFLOW_STATUSES.map((s) => s.key));
    for (const k of evidence) expect(keys.has(k)).toBe(true);
  });

  it('名单外未知状态：标签显示原文、分组归「其他」，绝不隐藏', () => {
    expect(statusLabelOf('mystery_state')).toBe('mystery_state');
    expect(statusLabelOf('failed')).toBe('失败');
  });
});

describe('web 对齐副本（statuses.ts web/src ≡ src/contracts/statuses.ts）', () => {
  it('两份名单逐字对齐——漂移即红灯', () => {
    expect(WEB_WORKFLOW_STATUSES).toEqual(WORKFLOW_STATUSES);
    expect(WEB_STEP_STATUSES).toEqual(STEP_STATUSES);
    expect(KANBAN_ARCHIVE_KEY).toBe('archived');
  });

  it('ui.ts 状态徽标释义表由名单派生（无第二份手写清单）', () => {
    // 派生源断言：名单并集 → 全状态释义表（键全覆盖、逐值一致；
    // workflow/step 重叠键标签相同，workflow 侧优先无观察差）。
    const all = [...WORKFLOW_STATUSES, ...STEP_STATUSES];
    expect(Object.keys(ALL_STATUS_LABELS).sort()).toEqual([...new Set(all.map((s) => s.key))].sort());
    for (const s of all) expect(ALL_STATUS_LABELS[s.key], `释义 ${s.key}`).toBe(s.label);
    // 消费端断言：ui.ts 必须从名单派生（引用 ALL_STATUS_LABELS），不得再
    // 手写任何一个状态中文标签。（ui.ts 引 DOM，root tsconfig 无 DOM lib
    // 不能直接 import——文本级围栏，arch.test.ts 同款手法。）
    const uiSrc = readFileSync(resolve(import.meta.dirname, '../web/src/ui.ts'), 'utf8');
    expect(uiSrc).toContain('ALL_STATUS_LABELS');
    for (const label of all.map((s) => s.label)) {
      expect(uiSrc.includes(label), `ui.ts 不应手写状态标签「${label}」`).toBe(false);
    }
  });
});

describe('看板列生成（纯函数）', () => {
  it('列由名单长出来：排队 → 等你决定（投影）→ 进行中 → 已完成 → 失败 → 已拒绝 → 其他；已取消归档不占列', () => {
    expect(KANBAN_COLUMNS.map((c) => c.key)).toEqual([
      'queued', KANBAN_WAITING_KEY, 'running', 'completed', 'failed', 'rejected', KANBAN_OTHER_KEY,
    ]);
    expect(KANBAN_COLUMNS.map((c) => c.label)).toEqual([
      '排队中', '等你决定', '进行中', '已完成', '失败', '已拒绝', '其他',
    ]);
    // 「失败」列结构性存在（走查痛点：总览报失败、看板找不到失败单）。
    expect(KANBAN_COLUMNS.find((c) => c.key === 'failed')?.label).toBe('失败');
  });

  it('卡片 → 列：名单态各归其位；running+waiting 步 = 等你决定（投影）', () => {
    expect(kanbanColumnOf({ status: 'queued' })).toBe('queued');
    expect(kanbanColumnOf({ status: 'running', waiting_steps: 0 })).toBe('running');
    expect(kanbanColumnOf({ status: 'running', waiting_steps: 2 })).toBe(KANBAN_WAITING_KEY);
    expect(kanbanColumnOf({ status: 'waiting_human' })).toBe(KANBAN_WAITING_KEY); // 防御分支（账本不产生）
    expect(kanbanColumnOf({ status: 'completed' })).toBe('completed');
    expect(kanbanColumnOf({ status: 'failed' })).toBe('failed');
    expect(kanbanColumnOf({ status: 'rejected' })).toBe('rejected');
    expect(kanbanColumnOf({ status: 'cancelled' })).toBe(KANBAN_ARCHIVE_KEY);
  });

  it('名单外未知状态 → 「其他」列（不隐藏）；列生成对任意名单形态稳定', () => {
    expect(kanbanColumnOf({ status: 'mystery_state' })).toBe(KANBAN_OTHER_KEY);
    // 投影列的存在不依赖名单顺序细节：名单里没有排队态时退到最前。
    const noQueued = kanbanColumnsFromStatuses(WORKFLOW_STATUSES.filter((s) => s.key !== 'queued'));
    expect(noQueued[0]?.key).toBe(KANBAN_WAITING_KEY);
  });
});

describe('总览统计与看板列同源（任务口径，2026-09-29 起）', () => {
  it('run 级同源断言退役说明：总览统计卡已改吃任务读模型（task-model.countByColumn），'
    + 'run 级 countByStatus 随之退役删除——任务口径的同源断言在 task-model.test.ts'
    + '（countByColumn === 看板 taskColumnOf 分桶）。此处锁定名单→列的映射仍可用（消费端）。', () => {
    const rows = [
      { status: 'running', waiting_steps: 3 },
      { status: 'failed' },
    ];
    expect(kanbanColumnOf(rows[0]!)).toBe(KANBAN_WAITING_KEY);
    expect(kanbanColumnOf(rows[1]!)).toBe('failed');
  });

  it('流水目录筛选由名单派生：全部 + 名单序 + 已取消殿后（2026-09-28 用户实录「终止了找不到」补寻回入口）、无 waiting_human 幻影 chip', () => {
    const keys = LIFECYCLE_FILTERS.map(([k]) => k);
    expect(keys[0]).toBe('');
    expect(keys[keys.length - 1]).toBe('cancelled'); // 殿后：终态寻回入口，不打乱名单序
    expect(keys.slice(1, -1)).toEqual(
      WORKFLOW_STATUSES.filter((s) => s.key !== 'cancelled').map((s) => s.key),
    );
    expect(keys).not.toContain('waiting_human');
  });
});

describe('Task 投影（store 层聚合，Task 不建新表）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'juli-statuses-'));
  const store: LifecycleStore = createLedgerStore(join(dir, 'lifecycle.db'));
  const wf = (title: string, meta: JsonRecord, parentId?: string) =>
    store.createWorkflow({ kind: 'adhoc', title, meta, parentId });

  // 场景：邮件流 E1；任务卡 T（brief）挂执行单 C1、跟进任务卡 T2；
  // 方向修正任务卡 T3 挂在邮件流 E1 下（根=T3 自身，邮件单不被吞并）；
  // 断链 U、无关邮件 E2 不属任何 Task。
  const e1 = store.createWorkflow({ kind: 'email-intake-v2', title: '客户来信', status: 'running' });
  const t = wf('PPT 需求', { mode: 'nodes', template_input: { brief: '做 PPT' } });
  const c1 = wf('执行：做 PPT', { related_workflow: t.id }, t.id);
  const t2 = wf('跟进：PPT 需求', { mode: 'nodes', related_workflow: t.id });
  const t3 = wf('〔方向修正〕客户来信', { mode: 'nodes', related_workflow: e1.id });
  const u = wf('断链单', { relates_to_unknown: 'wf_gone' });
  const e2 = store.createWorkflow({ kind: 'email-intake-v2', title: '无关来信', status: 'completed' });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('一个 Task = 一张任务卡下挂的多张 workflow：链爬根正确', () => {
    const { views, map } = store.taskViews();
    const byId = new Map(views.map((v) => [v.taskId, v]));
    const root = byId.get(t.id);
    expect(root, '任务卡 T 应成根').toBeDefined();
    expect([...(root?.workflowIds ?? [])].sort()).toEqual([t.id, c1.id, t2.id].sort());
    expect(byId.get(t3.id)?.workflowIds).toEqual([t3.id]); // 挂邮件单的方向修正卡自成根
    // 归属表：成员全指向根；非成员不进表。
    expect(map[c1.id]).toBe(t.id);
    expect(map[t2.id]).toBe(t.id);
    expect(map[t.id]).toBe(t.id);
    expect(map[t3.id]).toBe(t3.id);
    expect(map[e1.id]).toBeUndefined();
    expect(map[e2.id]).toBeUndefined();
    expect(map[u.id]).toBeUndefined();
  });

  it('视图带任务卡标题与状态（新→旧）', () => {
    const { views } = store.taskViews();
    const root = views.find((v) => v.taskId === t.id);
    expect(root?.title).toBe('PPT 需求');
    expect(root?.status).toBe('running');
  });

  it('环链守卫：互相挂靠不成死循环，无任务卡链不归属', () => {
    const a = wf('环A', { related_workflow: '' });
    const b = wf('环B', {});
    store.updateWorkflowMeta(a.id, { related_workflow: b.id });
    store.updateWorkflowMeta(b.id, { related_workflow: a.id });
    const { map } = store.taskViews();
    expect(map[a.id]).toBeUndefined();
    expect(map[b.id]).toBeUndefined();
  });
});

// ---- 状态谓词（2026-09-22 收口）------------------------------------------------

describe('状态谓词：从名单派生的单一事实源', () => {
  it('在途/收口/终态三档互不重叠且全覆盖名单', () => {
    expect(ACTIVE_STEP_STATUSES).toEqual(['pending', 'running', 'waiting_human']);
    expect(ACTIVE_WORKFLOW_STATUSES).toEqual(['queued', 'running']);
    expect(SETTLED_STEP_STATUSES).toEqual(['completed', 'cancelled']);
    expect(SETTLED_WORKFLOW_STATUSES).toEqual(['completed', 'cancelled']);
    expect(TERMINAL_STEP_STATUSES).toEqual(['completed', 'failed', 'cancelled', 'skipped']);
    // 谓词一致性：名单内逐 key 断言
    for (const s of STEP_STATUSES) {
      expect(isActiveStepStatus(s.key)).toBe(!s.terminal);
      expect(isSettledStepStatus(s.key)).toBe(s.key === 'completed' || s.key === 'cancelled');
      expect(isTerminalStepStatus(s.key)).toBe(s.terminal);
    }
    for (const s of WORKFLOW_STATUSES) {
      expect(isActiveWorkflowStatus(s.key)).toBe(!s.terminal);
      expect(isSettledWorkflowStatus(s.key)).toBe(s.key === 'completed' || s.key === 'cancelled');
    }
  });

  it('存活节点口径：completed 也存活（appendNode send 判重语义）', () => {
    expect(isLiveNodeStatus('pending')).toBe(true);
    expect(isLiveNodeStatus('running')).toBe(true);
    expect(isLiveNodeStatus('waiting_human')).toBe(true);
    expect(isLiveNodeStatus('completed')).toBe(true);
    expect(isLiveNodeStatus('failed')).toBe(false);
    expect(isLiveNodeStatus('cancelled')).toBe(false);
  });

  it('prune/dedup 名单：failed 保留与防御值的业务语义钉死', () => {
    expect(PRUNE_WORKFLOW_STATUSES).toEqual(['completed', 'cancelled', 'rejected']);
    expect(PRUNE_WORKFLOW_STATUSES).not.toContain('failed'); // 事故取证语义
    expect(DEDUP_WINDOW_STATUSES).toEqual(['queued', 'running', 'waiting_human']); // 历史防御值原样
  });

  it('sqlInList：谓词集合 → SQL IN 字面量（与旧手写 SQL 逐字一致）', () => {
    expect(sqlInList(['a', 'b'])).toBe("'a','b'");
    expect(sqlInList(ACTIVE_STEP_STATUSES)).toBe("'pending','running','waiting_human'");
    expect(sqlInList(TERMINAL_STEP_STATUSES)).toBe("'completed','failed','cancelled','skipped'");
  });
});

describe('web 当前步推导（dashboard/kanban 同源）', () => {
  const rows = (seq: number, status: string) => ({ step: { seq, status } });
  it('优先级：等人 > 在跑 > 失败 > 待排；全终态取末步', () => {
    const steps = [rows(1, 'completed'), rows(2, 'pending'), rows(3, 'running'), rows(4, 'waiting_human')];
    expect(currentStepOf(steps)?.step.seq).toBe(4); // waiting_human 最优先
    const steps2 = [rows(1, 'failed'), rows(2, 'pending')];
    expect(currentStepOf(steps2)?.step.seq).toBe(1); // failed > pending
    const allDone = [rows(1, 'completed'), rows(2, 'cancelled'), rows(3, 'completed')];
    expect(currentStepOf(allDone)?.step.seq).toBe(3); // 末步
    expect(currentStepOf([])).toBeUndefined();
  });
  it('web CURRENT_PRIORITY 值序锁定（等人>在跑>失败>待排，产品裁决）', () => {
    expect(CURRENT_PRIORITY_WEB).toEqual(['waiting_human', 'running', 'failed', 'pending']);
  });
});
