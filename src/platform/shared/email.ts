// 邮箱规范化单一事实源（R8 批3 收敛）：trim + 小写。原先散在 party 域
// 4 文件 / push / workflow 共 18 处手写同款（.trim().toLowerCase()）——
// 归一口径漂移即客户归组错位。party/store.ts 的同名导出改为转发本件
// （公开面不变）。注意：非邮箱场景（会话名比较、CLI 输出归一）不得借用。

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
