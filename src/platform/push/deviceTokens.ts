// 设备推送注册表的文件存取（2026-11-12 第 7 步从 runtime.ts 搬入）：
// device_tokens.json 读写收进 platform/push——runtime 只拿两个纯函数。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 读在册设备 token（文件缺失/形状异常=空表）。 */
export const deviceTokensOf = (dataDir: string): readonly string[] => {
  try {
    const v = JSON.parse(readFileSync(join(dataDir, 'device_tokens.json'), 'utf8')) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** 全量保存（0600——设备 token 是推送凭据）。 */
export const saveDeviceTokensTo = (dataDir: string, tokens: readonly string[]): void => {
  writeFileSync(join(dataDir, 'device_tokens.json'), JSON.stringify(tokens), { mode: 0o600 });
};
