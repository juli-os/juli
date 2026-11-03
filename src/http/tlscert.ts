// 自签证书（iOS App 兼容）：数据目录缺证书时用 openssl 生成（10 年期，
// CN 仅占位——App 端 TOFU 钉扎的是叶子公钥，不验 CA 链）。文件权限 600。

import { execSync } from 'node:child_process';
import { existsSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TlsMaterial {
  readonly cert: Buffer;
  readonly key: Buffer;
}

export const ensureSelfSignedCert = (dataDir: string, cn: string): TlsMaterial => {
  const dir = join(dataDir, 'tls');
  const certPath = join(dir, 'juli.crt');
  const keyPath = join(dir, 'juli.key');
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    try {
      execSync('mkdir -p "$d" && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 '
        + '-subj "/CN=$cn/O=juli-service" -keyout "$d/juli.key" -out "$d/juli.crt"',
        { env: { ...process.env, d: dir, cn } });
    } catch (e) {
      // 保留 stderr 摘要（openssl/mkdir 报错在 stderr），截 200 字符——裸
      // execSync 异常的 message 只有 "Command failed"，排障时等于瞎的。
      const raw = (e as { stderr?: Buffer | string } | null)?.stderr;
      // stderr 可能是 null/undefined/空串（openssl 缺失、被信号杀）——先归一，
      // 空则回退异常 message，别让排障信息退化成光杆前缀。
      const stderrText = typeof raw === 'string' ? raw : raw != null ? raw.toString() : '';
      const fallback = e instanceof Error ? e.message : String(e);
      const detail = (stderrText !== '' ? stderrText : fallback).slice(0, 200);
      throw new Error(`自签证书生成失败（openssl）：${detail}`);
    }
  }
  chmodSync(keyPath, 0o600);
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
};
