// 存量回填（2026-11-08 多租户提案 A1）：真 sqlite 临时库种六张单（五类信号
// 各就各位）→ dry-run 判定与分布 → apply 各归各位 → 第二遍 apply 幂等 0 行。
// 声明模式守卫：判定目标租户未声明的行跳过不改写、单计 skipped。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createLedgerStore, type LifecycleStore } from '@juli-os/ledger';
import { type JsonRecord } from '../src/platform/shared/json.ts';
import { configSchema } from '../src/platform/config/schema.ts';
import { parseTenantDecls, scanTenantBackfill } from '../src/platform/config/tenants.ts';
import { loadBackfillConfig } from '../cli/juli.ts';

let dir: string | null = null;

interface SeededIds {
  readonly internal1: string;
  readonly internal2: string;
  readonly acmeSession: string;
  readonly acmeDomain: string;
  readonly acmeSource: string;
  readonly noSignal: string;
}

interface SeededStore extends LifecycleStore {
  readonly ids: SeededIds;
}

const seededStore = (): SeededStore => {
  dir = mkdtempSync(join(tmpdir(), 'juli-tenant-backfill-'));
  const store = createLedgerStore(join(dir, 'lifecycle.db'));
  // 六张单：internal 会话 2、acme 老会话 1、acme.de 域名落 internal 会话 1、
  // team-pb 来源 1、无任何信号 1。createWorkflow 缺省 tenant=internal——
  // 与迁移脚本 ADD COLUMN DEFAULT 'internal' 后的副本库同态。
  const seed = (title: string, session: string, meta: JsonRecord = {}): string => {
    const w = store.createWorkflow({ kind: 'email', title, meta });
    store.setWorkflowSession(w.id, session);
    return w.id;
  };
  const ids: SeededIds = {
    internal1: seed('内部统计上月销量', 'juli-dev'),
    internal2: seed('内部部署排障', 'juli-eng'),
    acmeSession: seed('旧 acme 研究单', 'acme'),
    acmeDomain: seed('Acme 来信', 'juli-reply', { from: 'Alisa.Chen@Acme.DE' }),
    acmeSource: seed('反馈镜像单', 'juli-reply', { template_input: { channel: 'team-pb' } }),
    noSignal: seed('普通内部单', 'juli-dev', { from: 'neo@example.com' }),
  };
  return Object.assign(store, { ids });
};

const tableOf = () => {
  const r = parseTenantDecls(configSchema.parse({}));
  if (!r.ok) throw new Error(r.error);
  return r.table;
};

describe('scanTenantBackfill', () => {
  const store = seededStore();
  const ids = store.ids;
  const table = tableOf();

  afterAll(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
  });

  it('dry-run：判定与分布正确，不落库', () => {
    const report = scanTenantBackfill(store, table);
    expect(report.total).toBe(6);
    expect(report.byTarget).toEqual({ internal: 3, acme: 3 });
    expect(report.byBasis).toEqual({
      'sender-domain': 1, 'feedback-source': 1, session: 1, default: 3,
    });
    expect(report.rewritten).toBe(0);
    // 缺省形态：内置 acme 信号属可落集合，照常进 pending，无跳过。
    expect(report.skipped).toBe(0);
    expect(report.pending.map((r) => r.id).sort()).toEqual(
      [ids.acmeSession, ids.acmeDomain, ids.acmeSource].sort(),
    );
    expect(report.pending.every((r) => r.current === 'internal' && r.target === 'acme')).toBe(true);
    // dry-run 不改库：按租户过滤查 acme 仍为 0。
    expect(store.listWorkflows(undefined, undefined, 'acme')).toHaveLength(0);
  });

  it('apply：三张改写后各归各位', () => {
    const report = scanTenantBackfill(store, table, { apply: true });
    expect(report.rewritten).toBe(3);
    expect(store.listWorkflows(undefined, undefined, 'acme').map((w) => w.id).sort())
      .toEqual([ids.acmeSession, ids.acmeDomain, ids.acmeSource].sort());
    expect(store.listWorkflows(undefined, undefined, 'internal')).toHaveLength(3);
    expect(store.getWorkflow(ids.acmeDomain)?.tenant).toBe('acme');
    expect(store.getWorkflow(ids.noSignal)?.tenant).toBe('internal');
  });

  it('第二遍 apply：pending 空、改写 0（幂等收敛）', () => {
    const report = scanTenantBackfill(store, table, { apply: true });
    expect(report.pending).toHaveLength(0);
    expect(report.rewritten).toBe(0);
    expect(report.byTarget).toEqual({ internal: 3, acme: 3 });
  });
});

describe('scanTenantBackfill（声明模式：目标租户未声明跳过不改写）', () => {
  it('config 只声明 internal：@acme.de 行被判 acme，dry-run 与 apply 均跳过并单计 skipped', () => {
    const declDir = mkdtempSync(join(tmpdir(), 'juli-tenant-backfill-decl-'));
    try {
      const parsed = parseTenantDecls(configSchema.parse({
        agents: [{ session: 'juli-reply' }],
        tenants: [{ id: 'internal', agents: ['juli-reply'] }],
      }));
      if (!parsed.ok) throw new Error(parsed.error);
      const declStore = createLedgerStore(join(declDir, 'lifecycle.db'));
      const w = declStore.createWorkflow({ kind: 'email', title: 'Acme 来信', meta: { from: 'Alisa.Chen@Acme.DE' } });
      declStore.setWorkflowSession(w.id, 'juli-reply');

      const dry = scanTenantBackfill(declStore, parsed.table);
      expect(dry.byTarget).toEqual({ acme: 1 });
      expect(dry.byBasis['sender-domain']).toBe(1);
      expect(dry.skipped).toBe(1);
      expect(dry.pending).toHaveLength(0);

      const applied = scanTenantBackfill(declStore, parsed.table, { apply: true });
      expect(applied.skipped).toBe(1);
      expect(applied.rewritten).toBe(0);
      expect(declStore.getWorkflow(w.id)?.tenant).toBe('internal');
    } finally {
      rmSync(declDir, { recursive: true, force: true });
    }
  });
});

describe('scanTenantBackfill（人认领的行不改写）', () => {
  it('meta.tenant_basis=claimed 的行 apply 后不变，同信号的存量行照常改写', () => {
    const claimDir = mkdtempSync(join(tmpdir(), 'juli-tenant-backfill-claim-'));
    try {
      const s = createLedgerStore(join(claimDir, 'lifecycle.db'));
      // 两张单都是 acme.de 来信、现值 internal。一张 operator 认领过（认领端点
      // 写 basis=claimed），一张是没有 basis 的存量行。
      const claimed = s.createWorkflow({
        kind: 'email', title: '认领回 internal 的来信', tenant: 'internal',
        meta: { from: 'ops@acme.de', tenant_basis: 'claimed' },
      });
      const legacy = s.createWorkflow({ kind: 'email', title: '存量来信', meta: { from: 'ops@acme.de' } });

      const applied = scanTenantBackfill(s, tableOf(), { apply: true });
      expect(applied.pending.map((r) => r.id)).toEqual([legacy.id]);
      expect(applied.rewritten).toBe(1);
      expect(s.getWorkflow(claimed.id)?.tenant).toBe('internal');
      expect(s.getWorkflow(claimed.id)?.meta['tenant_basis']).toBe('claimed');
      expect(s.getWorkflow(legacy.id)?.tenant).toBe('acme');
    } finally {
      rmSync(claimDir, { recursive: true, force: true });
    }
  });
});

describe('scanTenantBackfill（A-P1-2：写侧专属依据的行不重判）', () => {
  it('explicit / sender_address 的行 dry-run 与 apply 都不动；改写带依据的行连 basis 一起刷；无依据行照旧只改租户列', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-tenant-backfill-writeside-'));
    try {
      const parsed = parseTenantDecls(configSchema.parse({
        agents: [{ session: 'juli-reply' }, { session: 'team-web' }],
        tenants: [
          { id: 'internal', agents: ['juli-reply'] },
          {
            id: 'acme', agents: ['team-web'], default_session: 'team-web',
            sender_addresses: ['vip@qq.com'],
          },
        ],
      }));
      if (!parsed.ok) throw new Error(parsed.error);
      const s = createLedgerStore(join(dir, 'lifecycle.db'));
      // 三行都是「回填想翻、翻错了」的写侧产物：显式选 acme 的单、按完整
      // 发件地址判的单。回填的四档规则看不见 explicit 与地址表。
      const explicit = s.createWorkflow({
        kind: 'adhoc', title: '确认卡显式选 acme', tenant: 'acme',
        meta: { tenant_basis: 'explicit', template_input: { tenant: 'acme' } },
      });
      const byAddress = s.createWorkflow({
        kind: 'email', title: '地址表判 acme', tenant: 'acme',
        meta: { from: 'vip@qq.com', tenant_basis: 'sender_address' },
      });
      // 写侧 basis=default 的单：判定落过缺省。声明后 team-web 会话归 acme，
      // 回填按会话改判 acme——租户和依据要一起刷，账面与依据不脱节。
      const stampedDefault = s.createWorkflow({
        kind: 'adhoc', title: '建单时按缺省判', tenant: 'internal',
        meta: { tenant_basis: 'default' },
      });
      s.setWorkflowSession(stampedDefault.id, 'team-web');
      // 没有依据的存量行：照旧只改租户列，不补依据。
      const legacy = s.createWorkflow({ kind: 'adhoc', title: 'team-web 上的存量单' });
      s.setWorkflowSession(legacy.id, 'team-web');

      const dry = scanTenantBackfill(s, parsed.table);
      expect(dry.pending.map((r) => r.id).sort()).toEqual([stampedDefault.id, legacy.id].sort());
      expect(dry.protectedByBasis).toBe(2);

      const applied = scanTenantBackfill(s, parsed.table, { apply: true });
      expect(applied.rewritten).toBe(2);
      expect(applied.protectedByBasis).toBe(2);
      // 写侧专属依据的行原样：租户没翻，basis 没动。
      expect(s.getWorkflow(explicit.id)?.tenant).toBe('acme');
      expect(s.getWorkflow(explicit.id)?.meta['tenant_basis']).toBe('explicit');
      expect(s.getWorkflow(byAddress.id)?.tenant).toBe('acme');
      expect(s.getWorkflow(byAddress.id)?.meta['tenant_basis']).toBe('sender_address');
      // 改写的带依据行：租户与依据同一次写入一起变。
      expect(s.getWorkflow(stampedDefault.id)?.tenant).toBe('acme');
      expect(s.getWorkflow(stampedDefault.id)?.meta['tenant_basis']).toBe('session');
      // 无依据存量行：只改租户列，不补依据。
      expect(s.getWorkflow(legacy.id)?.tenant).toBe('acme');
      expect(s.getWorkflow(legacy.id)?.meta['tenant_basis']).toBeUndefined();

      // 第二遍 apply：pending 空、改写 0（幂等收敛），保护计数照常。
      const second = scanTenantBackfill(s, parsed.table, { apply: true });
      expect(second.pending).toHaveLength(0);
      expect(second.rewritten).toBe(0);
      expect(second.protectedByBasis).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scanTenantBackfill（A-P1-1：缺省模式 agents 含 acme 会话名时仍判 acme）', () => {
  it('缺省配置 agents 里有 team-web：该会话的单回填改判 acme，不因名字被 config.agents 占用而留在 internal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-tenant-backfill-defaultalias-'));
    try {
      // live 形态：没写 tenants，agents 清单里就有 team-web / team-research-*。
      const parsed = parseTenantDecls(configSchema.parse({
        agents: [{ session: 'juli-reply' }, { session: 'team-web' }, { session: 'team-research-cases' }],
        default_session: 'juli-reply',
      }));
      if (!parsed.ok) throw new Error(parsed.error);
      const s = createLedgerStore(join(dir, 'lifecycle.db'));
      const onAcmeWeb = s.createWorkflow({ kind: 'adhoc', title: 'team-web 上的历史单' });
      s.setWorkflowSession(onAcmeWeb.id, 'team-web');
      const onInternal = s.createWorkflow({ kind: 'adhoc', title: 'juli-reply 上的历史单' });
      s.setWorkflowSession(onInternal.id, 'juli-reply');

      const applied = scanTenantBackfill(s, parsed.table, { apply: true });
      expect(applied.pending.map((r) => r.id)).toEqual([onAcmeWeb.id]);
      expect(s.getWorkflow(onAcmeWeb.id)?.tenant).toBe('acme');
      expect(s.getWorkflow(onInternal.id)?.tenant).toBe('internal');
      expect(parsed.table.bySession['team-research-cases']).toBe('acme');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadBackfillConfig（A-P2-9：坏配置不当成没配置）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'juli-tenant-backfill-cfg-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, body: string): string => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  it('文件不存在 = 无配置（null）——按缺省规则跑，这是唯一的「没有配置」', () => {
    expect(loadBackfillConfig(join(dir, 'nope.json'))).toEqual({ ok: true, config: null });
  });

  it('坏 JSON / 校验不过：报错点名文件，不返回配置（修前静默当成空配置、照样列待改行并可 --apply）', () => {
    const broken = write('broken.json', '{ "tenants": [ { "id": "internal" ');
    const r1 = loadBackfillConfig(broken);
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.error).toContain(broken);
      expect(r1.error).toContain('回填拒跑');
    }
    // JSON 合法但过不了 schema（租户 id 不合法）。
    const invalid = write('invalid.json', JSON.stringify({ tenants: [{ id: 'Not Valid' }] }));
    const r2 = loadBackfillConfig(invalid);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toContain(invalid);
  });

  it('好配置：解析出 tenants 声明', () => {
    const good = write('good.json', JSON.stringify({
      agents: [{ session: 'juli-reply' }],
      tenants: [{ id: 'internal', agents: ['juli-reply'] }],
    }));
    const r = loadBackfillConfig(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config?.tenants.map((t) => t.id)).toEqual(['internal']);
  });
});

