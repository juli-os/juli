// 服务版本唯一事实源（chat service_info 工具与 /api/version 共用；
// 2026-10-07 从 http/app.ts 抽出——runtime 注入工具面时反向引 app 会成环）。
export const VERSION = '0.2.0-ts';
