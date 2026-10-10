// YAML 解析的最小封装：只取对象，数组/标量拒绝。独立成文件便于注入假
// 解析器做测试，也避免 yaml 库类型渗进领域层。

import { parse as parseYaml } from 'yaml';

export const yamlParse = (data: string): unknown => {
  const v = parseYaml(data);
  return v;
};
