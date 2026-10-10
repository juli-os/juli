// 模板注册表：磁盘目录（~/.juli-service/pipelines/）是作者层事实源；目录为
// 空时用内嵌默认集 seed。SetTemplates 原子换掉整个活跃集合——管理 UI 的
// 保存/停用/删除全部经此收口。

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tryParseTemplate, type Template } from './template.ts';
import { DEFAULT_TEMPLATE_FILES } from './defaultTemplates.ts';

export const pipelinesDir = (dataDir: string): string => join(dataDir, 'pipelines');

export interface RegistryLoadResult {
  readonly templates: Readonly<Record<string, Template>>;
  readonly files: Readonly<Record<string, string>>;
  readonly errors: readonly string[];
}

/** 逐文件容忍坏模板：坏的跳过并记错误，好的照常注册。 */
export const loadTemplates = (dir: string): RegistryLoadResult => {
  const errors: string[] = [];
  const templates: Record<string, Template> = {};
  const files: Record<string, string> = {};
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    for (const [name, yaml] of Object.entries(DEFAULT_TEMPLATE_FILES)) {
      writeFileSync(join(dir, name), yaml, { mode: 0o600 });
    }
  }
  let names: string[] = [];
  try {
    // sort() 只保证加载/展示顺序确定性——**不是选择器**。任何 trigger/模板
    // 路由都禁止回退到「字母序第一」（2026-09-13 假完成案贰的根源）：
    // 匹配失败一律显式报错，或走动态进件（进件不查模板）。
    names = readdirSync(dir).filter((n) => n.endsWith('.yaml') || n.endsWith('.yml')).sort();
  } catch (e) {
    errors.push(`readdir ${dir}: ${String(e)}`);
    return { templates, files, errors };
  }
  for (const name of names) {
    try {
      const t = tryParseTemplate(readFileSync(join(dir, name), 'utf8'));
      if (t) templates[t.key] = t;
      else errors.push(`${name}: 解析失败（见 template 校验规则）`);
    } catch (e) {
      errors.push(`${name}: ${String(e)}`);
    }
  }
  return { templates, files, errors };
};

/** 保存（新增/覆盖）一个模板文件并重载解析。返回 null 或错误串。 */
export const saveTemplateFile = (dir: string, fileName: string, yaml: string): string | null => {
  const t = tryParseTemplate(yaml);
  if (!t) return 'template YAML 无效（key/steps/kind/title 校验未过）';
  if (!/^[\w.-]+\.ya?ml$/.test(fileName)) return '文件名不合法';
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), yaml, { mode: 0o600 });
  return null;
};

export const deleteTemplateFile = (dir: string, fileName: string): void => {
  const p = join(dir, fileName);
  if (existsSync(p)) {
    // 停用区：可审计的软删除（对齐 Go 的 disabled/ 目录约定）。
    mkdirSync(join(dir, 'disabled'), { recursive: true });
    renameSync(p, join(dir, 'disabled', `${Date.now()}-${fileName}`));
  }
};

/** 读模板原始 YAML（编辑器的取件口）；不存在或越权名返回 null。 */
export const readTemplateFile = (dir: string, fileName: string): string | null => {
  if (!/^[\w.-]+\.ya?ml$/.test(fileName)) return null;
  const p = join(dir, fileName);
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
};
