// Party（当事人）：身份在 CRM（Twenty），juli 只存引用不建档——「身份在 CRM，
// 过程在 juli，事实在账本」。指针挂 workflow.meta.party，三种形态：
//   { contact_id, company_id, source: 'twenty' }  Twenty 命中（contact 归属 company）
//   { internal: true }                            内部地址（自家域/内部声明），不查 CRM
//   { unmatched: true }                           陌生外部地址，默认不建 CRM 记录
// 铁律：一切 PartyDirectory 实现必须自带 try+超时（≤2s）——CRM 故障绝不阻断
// 邮件进件，查询失败 party 字段缺省即可（引擎侧另有兜底，纵深防御）。
// 实体模型登记（Party = Twenty 托管、juli 存引用）在外部治理仓，
// 本仓无法改其模型文件——待登记（commit 与报告注明）。

export interface PartyContactRef {
  readonly contact_id: string;
  readonly company_id: string;
  readonly source: 'twenty';
}

/** meta.party 的合法形状（写侧引擎、读侧投影共用同一裁决）。 */
export type PartyPointer =
  | PartyContactRef
  | { readonly internal: true }
  | { readonly unmatched: true };

/** 从 workflow.meta 还原 party 指针（投影用）。形状不对 = null（缺省态：
 * 未接 Twenty 的旧行 / CRM 故障期的进件）。 */
export const parsePartyPointer = (meta: Readonly<Record<string, unknown>>): PartyPointer | null => {
  const p = meta['party'];
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return null;
  const r = p as Record<string, unknown>;
  if (typeof r['contact_id'] === 'string' && r['contact_id'] !== '') {
    return {
      contact_id: r['contact_id'],
      company_id: typeof r['company_id'] === 'string' ? r['company_id'] : '',
      source: 'twenty',
    };
  }
  if (r['internal'] === true) return { internal: true };
  if (r['unmatched'] === true) return { unmatched: true };
  return null;
};

/** 目录命中（引擎消费）：id 进指针，name 进投影。 */
export interface PartyMatch {
  readonly contactId: string;
  readonly companyId: string;
  readonly contactName: string;
  readonly companyName: string;
}

/** Party 目录端口。引擎只依赖本接口（测试注 fake）；生产实现是 Twenty REST
 * 客户端（createTwentyPartyDirectory）。语义约定：查无此人 = null（正常值，
 * 引擎据此标 unmatched）；网络/HTTP 故障 = 抛错或超时（引擎吞掉 → party 缺省，
 * 绝不与「确认没有」混同）。 */
export interface PartyDirectory {
  /** 按邮箱查 contact → 归属 company。 */
  findByEmail(email: string): Promise<PartyMatch | null>;
  /** 投影用显示名；实现可不提供（前端退显 contact_id 短码）。 */
  nameOfContact?(contactId: string): Promise<string | null>;
  /** 陌生外部地址顺路建档（party.auto_create 开启才被调用）。实现必须
   * 先查再建（幂等）：同邮箱重复建档不得新建第二条。 */
  createContact?(input: { readonly email: string }): Promise<PartyMatch | null>;
}
