// 忙闲克隆会话命名约定（单一事实源）：基会话忙时 dispatcher 顺 base-2…base-9
// 找空闲克隆（engine runAgentStep 忙闲选枝），web 端组织树按同一规则把克隆
// 挂到基会话卡下（http app.ts cloneOf）。iOS owns() 持有对齐副本（跨 target
// 不可共享，改这里时同步 ios/）。规则：`<base>-<纯数字>` 且 base 是已知会话。

/** 克隆名：base-<n>（n 从 2 起——1 号就是基会话自己）。 */
export const cloneSessionName = (base: string, n: number): string => `${base}-${n}`;

/** 克隆基名：`name-<纯数字>` 剥掉数字尾得 base；非克隆形状返回 null。
 * 贪婪匹配与旧正则 /^(.*)-(\d+)$/ 逐字对齐（a-b-2-3 → a-b-2）。 */
export const cloneBaseOf = (name: string): string | null => {
  const m = /^(.*)-(\d+)$/.exec(name);
  return m !== null ? m[1]! : null;
};
