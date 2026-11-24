// gates 域登记表：一切需要人拍板的事的统一台账（gate_items，gates.db 走
// @juli-os/basin 版本化迁移）。
//
// 数据主权口径（2026-11-12 第 5 步定案）：gate_items 是登记与审计面，不是
// 第二事实源——步级闸门的真身仍在账本（workflow_steps 的 waiting_human
// 步），本表负责三件事：①决策审计（谁在何时对哪张卡按了哪个动词）；
// ②非步级拍板事（chat 确认卡）的唯一登记处；③统一待决列表的投影像。
// 列表读侧实时投影账本 waiting_human 步（workflow_gate/agent_ask 两种
// kind），叠加本表 open 的 chat_confirm。

import { openDatabase, sqlMigration, migrate, type Migration, type BasinDb } from '@juli-os/basin';

/** 拍板事的三种来源。 */
export type GateKind = 'workflow_gate' | 'chat_confirm' | 'agent_ask';

/** 决策动词全集（amend 归 rework 族——API 层 amend 是 rework 的别名重载）。 */
export const GATE_VERBS = ['approve', 'deny', 'resolve', 'rework', 'align', 'amend'] as const;
export type GateVerb = (typeof GATE_VERBS)[number];

export interface GateItem {
  readonly id: string;
  readonly kind: GateKind;
  readonly workflowId: string;
  readonly stepId: string;
  readonly title: string;
  readonly payload: Record<string, unknown>;
  readonly status: 'open' | 'decided';
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly decision: { verb: GateVerb; note: string; by: string; auto: boolean } | null;
}

const MIGRATIONS: readonly Migration[] = [
  sqlMigration(1, 'create gate_items', `
    CREATE TABLE IF NOT EXISTS gate_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      workflow_id TEXT NOT NULL DEFAULT '',
      step_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT,
      decision TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gate_items_status ON gate_items(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_gate_items_workflow ON gate_items(workflow_id);
  `),
];

export interface GatesStore {
  readonly db: BasinDb;
  /** 登记一张拍板卡（幂等：同 id 重登只刷 title/payload）。 */
  register(item: { id: string; kind: GateKind; workflowId?: string; stepId?: string; title: string; payload?: Record<string, unknown>; now: string }): void;
  /** 落决策（审计行）。幂等：已 decided 的卡不再改写。 */
  decide(id: string, verb: GateVerb, by: string, note: string, auto: boolean, now: string): boolean;
  /** 按状态列登记卡（新→旧）。 */
  list(status?: 'open' | 'decided', limit?: number): readonly GateItem[];
  /** 单卡取回。 */
  get(id: string): GateItem | null;
}

type Row = Record<string, string | number | bigint | null | Uint8Array>;

const parseJson = (v: unknown): Record<string, unknown> => {
  if (typeof v !== 'string' || v === '') return {};
  try { return JSON.parse(v) as Record<string, unknown>; } catch { return {}; }
};

/** 打开 gates 域库并跑齐迁移——runtime 装配的唯一入口。 */
export const openGatesStore = (path: string): GatesStore => {
  const db = openDatabase(path);
  migrate(db, MIGRATIONS);
  const rowOf = (r: Row): GateItem => ({
    id: String(r['id']),
    kind: String(r['kind']) as GateKind,
    workflowId: String(r['workflow_id'] ?? ''),
    stepId: String(r['step_id'] ?? ''),
    title: String(r['title'] ?? ''),
    payload: parseJson(r['payload']),
    status: r['status'] === 'decided' ? 'decided' : 'open',
    createdAt: String(r['created_at']),
    decidedAt: r['decided_at'] === null || r['decided_at'] === undefined ? null : String(r['decided_at']),
    decidedBy: r['decided_by'] === null || r['decided_by'] === undefined ? null : String(r['decided_by']),
    decision: r['decision'] === null || r['decision'] === undefined ? null : parseJson(r['decision']) as GateItem['decision'],
  });
  return {
    db,
    register({ id, kind, workflowId = '', stepId = '', title, payload = {}, now }) {
      db.prepare(
        `INSERT INTO gate_items (id, kind, workflow_id, step_id, title, payload, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, payload=excluded.payload
         WHERE gate_items.status = 'open'`,
      ).run(id, kind, workflowId, stepId, title, JSON.stringify(payload), now);
    },
    decide(id, verb, by, note, auto, now) {
      const res = db.prepare(
        `UPDATE gate_items SET status='decided', decided_at=?, decided_by=?, decision=?
         WHERE id=? AND status='open'`,
      ).run(now, by, JSON.stringify({ verb, note, by, auto }), id);
      return Number(res.changes) === 1;
    },
    list(status, limit = 200) {
      const rows = status === undefined
        ? db.prepare('SELECT * FROM gate_items ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit)
        : db.prepare('SELECT * FROM gate_items WHERE status=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(status, limit);
      return (rows as Row[]).map(rowOf);
    },
    get(id) {
      const r = db.prepare('SELECT * FROM gate_items WHERE id=?').get(id) as Row | undefined;
      return r ? rowOf(r) : null;
    },
  };
};
