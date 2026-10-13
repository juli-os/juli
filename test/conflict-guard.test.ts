// 同步盘冲突副本清洁守卫（export-public.mts [8] 的消费面，纯函数围栏）：
// 「name 2.ext」= iCloud/Dropbox 冲突命名绝非仓库内容；非 ASCII 文件名必须
// 走 ls-files -z 裸路径——默认 core.quotePath 的带引号八进制形态尾部引号
// 令过滤器失配，正是守卫要防的漏清形态（2026-10-11 一晚 177 个的事故防线）。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isSyncConflictJunk, splitLsFilesZ } from '../src/platform/shared/fsutil.ts';

describe('isSyncConflictJunk（裸路径判别）', () => {
  it('冲突副本命名命中：「 2.ext」数字后缀与 .sync-conflict', () => {
    expect(isSyncConflictJunk('总表 2.ts')).toBe(true);
    expect(isSyncConflictJunk('src/web/view 2.ts')).toBe(true);
    expect(isSyncConflictJunk('README.md.sync-conflict-20261011-0730')).toBe(true);
    expect(isSyncConflictJunk('notes.sync-conflict.md')).toBe(true);
  });

  it('正常文件不误伤（含带空格/连字符/无扩展名路径）', () => {
    expect(isSyncConflictJunk('src/runtime.ts')).toBe(false);
    expect(isSyncConflictJunk('我的 文档.md')).toBe(false); // 空格后非「数字.扩展名」结尾
    expect(isSyncConflictJunk('package-lock.json')).toBe(false);
    expect(isSyncConflictJunk('export/reports/publish-x.md')).toBe(false);
  });

  it('quotePath 带引号八进制形态不匹配（失配实证——输入必须先过 ls-files -z）', () => {
    // 真实形态：git 会输出 "\346\200\273\350\241\250 2.ts"（含字面反斜杠与尾引号）
    const quoted = '"\\346\\200\\273\\350\\241\\250 2.ts"';
    expect(isSyncConflictJunk(quoted)).toBe(false);
  });
});

describe('splitLsFilesZ（\\0 切分）', () => {
  it('按 \\0 切分并滤末尾空段，非 ASCII 路径原样透出', () => {
    expect(splitLsFilesZ('总表 2.ts\0src/a.ts\0')).toEqual(['总表 2.ts', 'src/a.ts']);
    expect(splitLsFilesZ('')).toEqual([]);
    expect(splitLsFilesZ('only.ts\0')).toEqual(['only.ts']);
  });

  it('端到端：-z 切分 + 过滤器咬合（quotePath 形态在场即漏判的反例对照）', () => {
    const raw = ['总表 2.ts', 'src/runtime.ts', '"\\346\\200\\221 3.ts"', 'x.sync-conflict-y.ts'].join('\0') + '\0';
    expect(splitLsFilesZ(raw).filter((f) => isSyncConflictJunk(f))).toEqual(['总表 2.ts', 'x.sync-conflict-y.ts']);
  });
});

describe('export-public.mts 的 -z 接线钉死（源码扫描，沿 cli-hook.test idiom）', () => {
  // 上面锁的是纯函数——接线本身（脚本行 ls-files -z）改回非 -z 不产生红灯，
  // quotePath 漏清防线会静默退化。此处读脚本源码钉死调用行（源码即真值，
  // 零手工维护）。scripts/** 不在公开投影 include（test/** 在）——公开树
  // 该文件缺席即跳过：钉死对象是私仓发布脚本，公开树本就没有它。
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'export-public.mts');
  const src = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : null;

  it('冲突副本清理必须吃 ls-files -z（改回默认 quotePath 形态即红）', () => {
    if (src === null) return; // 公开投影树：脚本不在投影面，无事可钉
    expect(src).toContain('ls-files -z --others --exclude-standard');
    expect(src).toContain('splitLsFilesZ('); // sanity：钉的是真消费行，非别处巧合字面量
  });
});
