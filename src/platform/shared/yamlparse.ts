// YAML 解析的最小封装：解析为 unknown，不做形状校验——对象/数组/标量的
// 拒绝由调用方负责（如 zod schema 或手动检查）。独立成文件便于注入假
// 解析器做测试，也避免 yaml 库类型渗进领域层。

import { parse as parseYaml } from 'yaml';

export const yamlParse = (data: string): unknown => parseYaml(data);
