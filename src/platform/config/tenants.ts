// 租户登记（2026-11-08 多租户提案 A1）：config.tenants 声明 → 五张查询表
// （agent / sender_address / sender_domain / feedback_prefix / session 各到
// 租户）+ 三条启动校验 + 判租户与存量回填。纯函数无 IO；runtime 启动校验、
// 回填 CLI、读侧（A2）吃同一张表，判定口径零分叉。
// 位置说明：schema 的租户投影与 schema 同包（platform/config）——登记表是
// config 声明的派生查询面，且结构宪法把仓根 cli 的跨包 import 钉死在
// [cli, platform/config, platform/llm]（test/arch.test.ts），platform/config
// 是 runtime 与 CLI 都可直达的唯一合宪落点。
//
// 判租户（judgeTenant）按优先级取首个命中：
//   1. sender-domain    meta.$.from 的域名（@ 后小写）命中某租户 sender_domains
//   2. feedback-source  meta.$.template_input.channel 或 .source 命中登记来源
//   3. session          落单会话命中某租户（bySession 含内置老会话别名）
//   4. default          兜底 internal
// ②的来源表与③的别名表是内置存量信号，不随 config 走：租户化之前的历史
// 单子只有 meta JSON 可判，这批事实来自 P1 实测（P1 原型证据见 D0 文档
// PR 归档的 proto-20261108/p1/evidence.md：acme.de 域 26 张、
// team-pb 来源 4 张、acme 系会话 29 张，副本库合计 acme 59）。
// config 显式声明的同名表项优先于内置信号（运营改判在 config 一处生效）。
// 缺省模式（没写 tenants）反过来：「全部 agent 归 internal」是收编缺省值，
// 不是运营的声明，内置会话别名盖过它（2026-11-11 A-P1-1：真实配置的 agents
// 里就有 team-web / team-research-*，别名让位会把这几个会话判成juli，
// 同一份副本库缺省模式回填 acme 49、声明模式 58）。

import { effectiveDefaultSession, type Config } from './schema.ts';
import type { LifecycleStore } from '@juli-os/ledger';

/** 内置存量信号（P1 实测，见文件头）：全部指向 acme 租户。
 * feedbackSources 两值=反馈镜像 source 字段的历史取值：P1 原型副本里是
 * 'team-pb'，live 短名是 'acme'（2026-11-11 实测 GROUP BY：acme ×396，
 * 另有 juli 自身渠道 juli-service ×11 / juli-site ×3 归 internal——读侧在
 * http/routes/feedback.ts mirrorTenantOf 特判，不进本表）。A2 读侧
 * mirrorTenantOf 与 A3 写侧 resolveTenant 的 feedback_source 档共用本表，
 * 漏一个值=该来源的反馈记录与工单全部错落「全部」视角。 */
export const LEGACY_REFLEX_SIGNALS = {
  tenant: 'acme',
  senderDomains: ['acme.de'],
  feedbackSources: ['team-pb', 'acme'],
  sessions: [
    'acme', 'team-web', 'team-research-cases', 'team-research-products',
    'team-research-progress', 'meridian-case-count',
  ],
} as const;

export const INTERNAL_TENANT = 'internal';

export type TenantBasis = 'sender-domain' | 'feedback-source' | 'session' | 'default';

/** 每租户 herdr server 的有效 session 名（2026-11-08 多租户提案 A4）：声明
 * 空串回落租户 id——照 A1 惯例（'' 原样透传，回落发生在消费方），本函数
 * 即那个消费面。租户 id 已过 zod kebab 小写校验，作 herdr session 名合法；
 * workspace 命名空间随 session 名走（P2 口径：单 server 内 workspace 名 =
 * tenant 参数，这里每租户独立 server，两参数同值即与既有单实例行为逐字节
 * 一致——internal 声明 herdr_session='juli' 即绑现有 juli server 的现有
 * workspace，存量会话零迁移）。 */
export const effectiveHerdrSession = (t: TenantEntry): string =>
  t.herdrSession !== '' ? t.herdrSession : t.id;

export interface TenantEntry {
  readonly id: string;
  readonly name: string;
  /** herdr workspace namespace；空 = 未配（消费方回退 id）。 */
  readonly herdrSession: string;
  readonly agents: readonly string[];
  readonly defaultSession: string;
}

export interface TenantTable {
  readonly tenants: readonly TenantEntry[];
  /** agent 会话名 → 租户 id（config 声明）。 */
  readonly byAgent: Readonly<Record<string, string>>;
  /** 完整发件邮箱（小写）→ 租户 id（config 声明）。 */
  readonly bySenderAddress: Readonly<Record<string, string>>;
  /** 发件域名（小写）→ 租户 id：config 声明 + 内置存量信号（声明优先）。 */
  readonly bySenderDomain: Readonly<Record<string, string>>;
  /** 反馈页面前缀 → 租户 id（config 声明）。 */
  readonly byFeedbackPrefix: Readonly<Record<string, string>>;
  /** feedback 渠道来源 → 租户 id（内置存量信号）。 */
  readonly byFeedbackSource: Readonly<Record<string, string>>;
  /** 落单会话名 → 租户 id：config 声明 + 内置老会话别名。声明模式声明优先；
   * 缺省模式别名优先（见文件头）。 */
  readonly bySession: Readonly<Record<string, string>>;
  /** 回填允许 stamp 的目标租户全集：声明模式 = config.tenants 的 id 集合；
   * 缺省形态 = internal + 内置存量信号的 acme（缺省形态回填按现行为
   * 继续 stamp，测试钉住的意图）。声明之外的目标 = 运营没认领，不 stamp。 */
  readonly stampableTenants: ReadonlySet<string>;
}

export type TenantTableResult =
  | { readonly ok: true; readonly table: TenantTable }
  | { readonly ok: false; readonly error: string };

/** config.tenants → 登记表。声明非法返回点名错误（哪个租户、哪条冲突），
 * 调用方（runtime 启动 / 回填 CLI）以启动失败或拒跑回应。config 无 tenants
 * 键 = 单 internal 租户收编全部 agent 与全局 default_session。 */
export const parseTenantDecls = (config: Config): TenantTableResult => {
  const declared = config.tenants;

  // —— 表构建（声明优先，内置存量信号只补空位）——
  // 查询表一律无原型（2026-11-11 A-P2-4）：键来自外部输入（发件域名、会话名、
  // 反馈来源）。普通对象上查 constructor / __proto__ / toString 会查到函数或
  // 对象，被当成「租户」一路带进建单的 SQLite 绑定而崩——任何人发一封
  // a@constructor 的信就能触发。无原型表上这些键一律 undefined，下游十几处
  // 直接下标查表的调用点随之安全。
  const lookup = <V = string>(): Record<string, V> => Object.create(null) as Record<string, V>;
  const tenants: TenantEntry[] = [];
  const byAgent = lookup();
  const bySenderAddress = lookup();
  const bySenderDomain = lookup();
  const byFeedbackPrefix = lookup();

  if (declared.length === 0) {
    tenants.push({
      id: INTERNAL_TENANT,
      name: INTERNAL_TENANT,
      herdrSession: '',
      agents: config.agents.map((a) => a.session),
      defaultSession: config.default_session,
    });
    for (const a of config.agents) byAgent[a.session] = INTERNAL_TENANT;
  } else {
    // internal 两个回退（A-P2-6）：default_session 留空 = 全局 default_session
    // （原来透传空串，没指定会话的单直接 failed，报错还说「顶层没配」）；
    // herdr_session 留空 = 全局 herdr_session（缺省 juli——原来回落成租户 id
    // 'internal'，等于连到一个新 server，原 juli server 里的会话引擎全看不见）。
    const globalDefault = effectiveDefaultSession(config).session;
    for (const t of declared) {
      const isInternal = t.id === INTERNAL_TENANT;
      tenants.push({
        id: t.id,
        name: t.name !== '' ? t.name : t.id,
        herdrSession: t.herdr_session !== '' ? t.herdr_session : isInternal ? config.herdr_session : '',
        agents: t.agents,
        defaultSession: t.default_session !== '' ? t.default_session : isInternal ? globalDefault : '',
      });
      for (const s of t.agents) byAgent[s] = t.id;
      for (const a of t.sender_addresses) bySenderAddress[a.toLowerCase()] = t.id;
      for (const d of t.sender_domains) bySenderDomain[d.toLowerCase()] = t.id;
      for (const p of t.feedback_prefixes) byFeedbackPrefix[p] = t.id;
    }
  }

  const bySession = Object.assign(lookup(), byAgent);
  for (const s of LEGACY_REFLEX_SIGNALS.sessions) {
    // 声明模式只补空位（声明优先）；缺省模式别名直接盖过收编缺省值（A-P1-1）。
    if (declared.length === 0 || !(s in bySession)) bySession[s] = LEGACY_REFLEX_SIGNALS.tenant;
  }
  const bySenderDomainAll = Object.assign(lookup(), bySenderDomain);
  for (const d of LEGACY_REFLEX_SIGNALS.senderDomains) {
    if (!(d in bySenderDomainAll)) bySenderDomainAll[d] = LEGACY_REFLEX_SIGNALS.tenant;
  }
  const byFeedbackSource = lookup();
  for (const s of LEGACY_REFLEX_SIGNALS.feedbackSources) {
    byFeedbackSource[s] = LEGACY_REFLEX_SIGNALS.tenant;
  }


  // —— 启动校验（声明模式才需点名；缺省单 internal 恒过）——
  if (declared.length > 0) {
    if (!tenants.some((t) => t.id === INTERNAL_TENANT)) {
      return { ok: false, error: `租户 internal 未声明——config.tenants 必须包含 internal 租户（现为：${tenants.map((t) => t.id).join('、')}）` };
    }
    // 重复声明：静默覆盖会让先声明的租户在表里无声消失，点名拒绝。
    const idSeen = lookup<boolean>();
    for (const t of declared) {
      if (idSeen[t.id] === true) {
        return { ok: false, error: `租户 id "${t.id}" 重复声明——每个租户 id 只能声明一次` };
      }
      idSeen[t.id] = true;
    }
    // 保留字（A-P2-6）：请求头 X-Juli-Tenant: all 是「全部视角」，租户不能叫这个名字
    // ——叫了就永远选不中它（parseTenantScope 先判 all）。
    if (idSeen['all'] === true) {
      return { ok: false, error: '租户 id 不能叫 "all"——all 在 X-Juli-Tenant 里是「全部视角」的保留字' };
    }
    const addrSeen = lookup();
    const domainSeen = lookup();
    const prefixSeen = lookup();
    for (const t of declared) {
      for (const a of t.sender_addresses) {
        const k = a.toLowerCase();
        if (addrSeen[k] !== undefined && addrSeen[k] !== t.id) {
          return { ok: false, error: `sender_address "${k}" 同时被租户 ${addrSeen[k]} 与 ${t.id} 认领——每项发件身份只能被一个租户认领` };
        }
        addrSeen[k] = t.id;
      }
      for (const d of t.sender_domains) {
        const k = d.toLowerCase();
        if (domainSeen[k] !== undefined && domainSeen[k] !== t.id) {
          return { ok: false, error: `sender_domain "${k}" 同时被租户 ${domainSeen[k]} 与 ${t.id} 认领——每项发件身份只能被一个租户认领` };
        }
        domainSeen[k] = t.id;
      }
      for (const p of t.feedback_prefixes) {
        if (prefixSeen[p] !== undefined && prefixSeen[p] !== t.id) {
          return { ok: false, error: `feedback_prefix "${p}" 同时被租户 ${prefixSeen[p]} 与 ${t.id} 认领——每项反馈前缀只能被一个租户认领` };
        }
        prefixSeen[p] = t.id;
      }
    }
    const seen = lookup();
    for (const t of tenants) {
      for (const s of t.agents) {
        if (seen[s] !== undefined && seen[s] !== t.id) {
          return { ok: false, error: `agent "${s}" 同时属于租户 ${seen[s]} 与 ${t.id}——每个 agent 恰好属于一个租户` };
        }
        seen[s] = t.id;
      }
    }
    for (const a of config.agents) {
      if (seen[a.session] === undefined) {
        return { ok: false, error: `agent "${a.session}" 未被任何租户认领——每个 agent 恰好属于一个租户` };
      }
    }
    for (const rule of config.feedback_routing.rules) {
      const owner = byFeedbackPrefix[rule.prefix] ?? INTERNAL_TENANT;
      const target = bySession[rule.session];
      if (target !== undefined && owner !== target && tenants.some((t) => t.id === target)) {
        return { ok: false, error: `feedback 路由规则 prefix "${rule.prefix}"（属于租户 ${owner}）指向会话 "${rule.session}"，该会话属于租户 ${target}——规则必须指向所属租户的会话` };
      }
    }
    // default_session（A-P2-6）：排在既有校验之后，既有报错的先后不变。
    //   非 internal 租户：必须配，且必须是本租户声明的 agent——空着的后果是该
    //     租户没指定会话的单直接 failed；指到别处则落进别家（或 internal）的终端。
    //   internal：留空已回退全局值；不得是别的租户的 agent。没声明进任何租户
    //     的会话允许（表外会话本来就落 internal 的终端）。
    for (const t of tenants) {
      const ds = t.defaultSession;
      if (t.id === INTERNAL_TENANT) {
        if (ds !== '' && seen[ds] !== undefined && seen[ds] !== INTERNAL_TENANT) {
          return { ok: false, error: `租户 internal 的 default_session "${ds}" 属于租户 ${seen[ds]}——兜底会话必须是本租户的会话` };
        }
        continue;
      }
      if (ds === '') {
        return { ok: false, error: `租户 ${t.id} 没有配 default_session——没指定会话的单会直接失败；给它配一个本租户声明的 agent 会话` };
      }
      if (!t.agents.includes(ds)) {
        return { ok: false, error: `租户 ${t.id} 的 default_session "${ds}" 不是本租户声明的 agent（${t.agents.length > 0 ? t.agents.join('、') : '未声明 agent'}）——兜底会话必须属于本租户` };
      }
    }
  }

  // 回填可落集合：声明模式 = 声明的 id；缺省形态补上内置存量信号的 acme
  // （缺省形态回填按现行为继续 stamp，声明模式越权 stamp 拒之门外）。
  const stampableTenants = new Set(tenants.map((t) => t.id));
  if (declared.length === 0) stampableTenants.add(LEGACY_REFLEX_SIGNALS.tenant);

  return {
    ok: true,
    table: {
      tenants,
      byAgent,
      bySenderAddress,
      bySenderDomain: Object.freeze(bySenderDomainAll),
      byFeedbackPrefix,
      byFeedbackSource: Object.freeze(byFeedbackSource),
      bySession: Object.freeze(bySession),
      stampableTenants,
    },
  };
};

// ---- 判租户 ----

/** meta JSON 里按点路径取 string（缺路径/类型不符 = 空串，走下一档判定）。 */
const metaStr = (meta: unknown, path: readonly string[]): string => {
  let cur: unknown = meta;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return '';
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' ? cur : '';
};

/** 发件域名：meta.$.from 的最后一个 @ 之后取域名 token（容忍 "Name <a@b>"）。 */
export const senderDomainOf = (meta: unknown): string => {
  const from = metaStr(meta, ['from']);
  const at = from.lastIndexOf('@');
  if (at < 0) return '';
  const m = /^([\w.-]+)/.exec(from.slice(at + 1).toLowerCase());
  return m !== null ? (m[1] ?? '') : '';
};

export interface TenantJudgment {
  readonly tenant: string;
  readonly basis: TenantBasis;
}

/** 表查值（A-P2-4）：只认自有键、只认字符串。parseTenantDecls 建的表本身无
 * 原型；这里再守一道，是因为表可以是结构兼容的普通对象（测试/别的装配）。 */
const ownTenant = (t: Readonly<Record<string, string>>, key: string): string | undefined => {
  if (key === '' || !Object.hasOwn(t, key)) return undefined;
  const v: unknown = t[key];
  return typeof v === 'string' ? v : undefined;
};

/** 判租户：文件头的四档优先级。meta 不合法或字段缺失走下一档。 */
export const judgeTenant = (table: TenantTable, wf: { readonly session: string; readonly meta: unknown }): TenantJudgment => {
  const byDomain = ownTenant(table.bySenderDomain, senderDomainOf(wf.meta));
  if (byDomain !== undefined) return { tenant: byDomain, basis: 'sender-domain' };
  const ti = metaStr(wf.meta, ['template_input', 'channel']);
  const ti2 = metaStr(wf.meta, ['template_input', 'source']);
  const source = ownTenant(table.byFeedbackSource, ti) ?? ownTenant(table.byFeedbackSource, ti2);
  if (source !== undefined) return { tenant: source, basis: 'feedback-source' };
  const bySession = ownTenant(table.bySession, wf.session);
  if (bySession !== undefined) return { tenant: bySession, basis: 'session' };
  return { tenant: INTERNAL_TENANT, basis: 'default' };
};

// ---- 存量回填 ----

/** 写侧专属依据（2026-11-11 A-P1-2）：这三档只有写侧 resolveTenant（六档）给得
 * 出——回填的四档判定里没有完整发件地址表，没有显式选择，也没有人工认领。带
 * 这三档的行回填不重判：重判只能落到四档看得见的信号上（多半是 internal），
 * 等于把人选的租户翻回去。 */
const WRITE_ONLY_BASES: ReadonlySet<string> = new Set(['claimed', 'explicit', 'sender_address']);

/** 回填判定依据 → meta.tenant_basis 的写侧词表（snake_case，与 resolveTenant 同名）。 */
const BASIS_TO_META: Readonly<Record<TenantBasis, string>> = {
  'sender-domain': 'sender_domain', 'feedback-source': 'feedback_source', session: 'session', default: 'default',
};

export interface TenantBackfillRow {
  readonly id: string;
  readonly basis: TenantBasis;
  /** 改写前行上的 meta.tenant_basis（空串 = 没有依据的存量行）。 */
  readonly prevBasis: string;
  readonly current: string;
  readonly target: string;
  readonly title: string;
}

export interface TenantBackfillReport {
  readonly total: number;
  readonly byTarget: Readonly<Record<string, number>>;
  readonly byBasis: Readonly<Record<TenantBasis, number>>;
  /** 现值 ≠ 目标、目标可落且不带写侧专属依据的行。apply 即对它们逐条改写。 */
  readonly pending: readonly TenantBackfillRow[];
  /** 实际改写行数（dry-run 恒 0；重复 apply 幂等收敛到 0）。 */
  readonly rewritten: number;
  /** 判定目标租户不在 stampableTenants（运营未声明）——跳过不改写的行数。 */
  readonly skipped: number;
  /** 带写侧专属依据（explicit / sender_address / claimed）而不重判的行数。 */
  readonly protectedByBasis: number;
}

/** 扫 lifecycle.db 全量 workflows 判目标租户；apply=true 逐条落库。
 * 目标租户未声明的行跳过不改写、单计 skipped——回填不能 stamp 运营没
 * 认领的租户。幂等：改写后现值=目标，第二遍 pending 为空、rewritten 0。
 * 带写侧专属依据的行（WRITE_ONLY_BASES）照常计入分布，但不进 pending，
 * 单计 protectedByBasis。
 * 依据跟着租户走：改写的行如果本来带依据（sender_domain / feedback_source /
 * session / default），同一次 apply 里把 meta.tenant_basis 改成这次的判定
 * 依据，账面和依据不脱节。没有依据的存量行只改租户列，不补依据。 */
export const scanTenantBackfill = (
  store: Pick<LifecycleStore, 'listWorkflows' | 'setWorkflowTenant' | 'updateWorkflowMeta'>,
  table: TenantTable,
  opts: { readonly apply?: boolean } = {},
): TenantBackfillReport => {
  // listWorkflows 缺省 LIMIT 100（服务端分页读法）——回填必须全量扫描，
  // 显式给足上限（SQLite LIMIT 收 int 安全整数）。
  const rows = store.listWorkflows(Number.MAX_SAFE_INTEGER);
  const pending: TenantBackfillRow[] = [];
  const byTarget: Record<string, number> = {};
  const byBasis: Record<TenantBasis, number> = { 'sender-domain': 0, 'feedback-source': 0, session: 0, default: 0 };
  let skipped = 0;
  let protectedByBasis = 0;
  for (const w of rows) {
    const j = judgeTenant(table, { session: w.session, meta: w.meta });
    byTarget[j.tenant] = (byTarget[j.tenant] ?? 0) + 1;
    byBasis[j.basis] += 1;
    if (!table.stampableTenants.has(j.tenant)) {
      skipped += 1;
      continue;
    }
    const prevBasis = metaStr(w.meta, ['tenant_basis']);
    if (WRITE_ONLY_BASES.has(prevBasis)) {
      protectedByBasis += 1;
      continue;
    }
    if (w.tenant !== j.tenant) {
      pending.push({ id: w.id, basis: j.basis, prevBasis, current: w.tenant, target: j.tenant, title: w.title });
    }
  }
  let rewritten = 0;
  if (opts.apply === true) {
    for (const r of pending) {
      store.setWorkflowTenant(r.id, r.target);
      if (r.prevBasis !== '') store.updateWorkflowMeta(r.id, { tenant_basis: BASIS_TO_META[r.basis] });
      rewritten += 1;
    }
  }
  return { total: rows.length, byTarget, byBasis, pending, rewritten, skipped, protectedByBasis };
};
