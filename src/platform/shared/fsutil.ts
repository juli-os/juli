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
