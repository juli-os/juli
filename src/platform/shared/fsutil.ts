// 文件读取的小接缝：注入即 mock（APNs key、配置文件、模板目录的测试面）。

import { readFileSync } from 'node:fs';

export interface ReadFile {
  (path: string): string | null;
}

export const createReadFile = (): ReadFile => (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** 同步盘冲突副本判别（export-public.mts 清洁守卫的消费面，纯函数可测）。
 * iCloud/Dropbox 冲突命名「name 2.ext」与 `.sync-conflict-*` 绝非仓库内容。
 * 输入必须是 `git ls-files -z` 的裸路径——-z 输出永不引用；默认 core.quotePath
 * 会把非 ASCII 路径包成带引号八进制形态（`"\346\200\273… 2.ts"`），尾部引号
 * 令 ` N.ext` 过滤器失配 → 中文名冲突副本漏清。 */
export const isSyncConflictJunk = (path: string): boolean =>
  / \d+\.[A-Za-z0-9]+$/.test(path) || /\.sync-conflict/.test(path);

/** `git ls-files -z` 输出切分：\0 分隔（路径本身可含换行），滤掉末尾空段。 */
export const splitLsFilesZ = (out: string): readonly string[] =>
  out.split('\0').filter((s) => s !== '');
