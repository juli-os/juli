// 邮箱密码解析：环境变量 > secrets 配置（keychain: 引用支持）。
// 密码类永不入 config.json 的基线纪律在这里收口。

import { resolveSecret, type Config } from '../config/schema.ts';

export const resolveEmailPassword = (
  config: Config,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string =>
  resolveSecret({
    envValue: env['JULI_EMAIL_PASSWORD'] ?? env['MAKRO_EMAIL_PASSWORD'],
    configured: config.secrets.email_password,
  });
