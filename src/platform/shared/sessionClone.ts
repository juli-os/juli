// 忙闲克隆会话命名约定（单一事实源）：克隆创建侧已随忙闲改道重设计退役
// （8ba81cc：忙时改道其他声明 agent，不再克隆）；本约定保留用于识别既有
// 克隆会话——web 端组织树按此规则把克隆挂到基会话卡下（http routes/agents.ts
// cloneOf）。iOS owns() 持有对齐副本（跨 target 不可共享，改这里时同步
// ios/）。规则：`<base>-<纯数字>`（尾号 n 从 2 起——1 号就是基会话自己）
// 且 base 是已知会话。

/** 克隆基名：`name-<纯数字>` 剥掉数字尾得 base；非克隆形状返回 null。
 * 贪婪匹配与旧正则 /^(.*)-(\d+)$/ 逐字对齐（a-b-2-3 → a-b-2）。 */
export const cloneBaseOf = (name: string): string | null => {
  const m = /^(.*)-(\d+)$/.exec(name);
  return m !== null ? m[1]! : null;
};
