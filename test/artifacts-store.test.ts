// disk 工件后端 containment 契约：穿越键（../ 等）绝不触盘外文件。

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiskBackend } from '../src/platform/artifacts/store.ts';

describe('disk 后端 containment', () => {
  it('穿越键 get/put/delete 一律失败，盘外文件不被读写删', async () => {
    const base = mkdtempSync(join(tmpdir(), 'juli-store-'));
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'top-secret');
    const backend = createDiskBackend(root);
    try {
      expect((await backend.get('../outside/secret.txt')).ok).toBe(false);
      expect((await backend.put('../evil.txt', Buffer.from('x'))).ok).toBe(false);
      expect((await backend.delete('../outside/secret.txt')).ok).toBe(false);
      // 盘外世界未被触碰
      expect(existsSync(join(outside, 'secret.txt'))).toBe(true);
      expect(existsSync(join(base, 'evil.txt'))).toBe(false);
      // 正常键往返不受影响
      expect((await backend.put('cases/wf1/a.txt', Buffer.from('ok'))).ok).toBe(true);
      expect((await backend.get('cases/wf1/a.txt')).ok).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
