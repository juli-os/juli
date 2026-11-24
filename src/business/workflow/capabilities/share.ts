// share：把案卷工件经 ExternalLink 接缝换成可访问 URL——质量闸门审的是
// 真实可达的链接，不是本地路径。share_url 记忆化：已分享过的不重传。

import { rfc3339 } from '../../../platform/shared/clock.ts';
import { asRecord, type JsonRecord } from '../../../platform/shared/json.ts';
import type { StepCtx } from './common.ts';

/** share：把案卷工件经 ExternalLink 接缝换成可访问 URL——质量闸门审的是
 * 真实可达的链接，不是本地路径。share_url 记忆化：已分享过的不重传。 */
export const runShare = async (ctx: StepCtx): Promise<void> => {
  const { store, step: st, workflow: w, clock, artifacts, externalLink } = ctx;
  const rows = artifacts?.list(w.id) ?? [];
  const links: { name: string; url: string }[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const a of rows) {
    if (a.deletedAt !== null || a.key === '') continue;
    const memo = asRecord(a.meta)['share_url'];
    if (typeof memo === 'string' && memo !== '') {
      links.push({ name: a.name, url: memo });
      continue;
    }
    if (!externalLink) continue;
    // 异常消息不吞：failed 记录带真实原因（网关炸了≠空 URL），诊断面才可用。
    let u: string | null = null;
    let err = 'empty share url';
    try {
      u = await externalLink(a);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    if (u === null || u === '') {
      failed.push({ name: a.name, error: err });
      continue;
    }
    artifacts?.updateMeta(a.id, { share_url: u });
    links.push({ name: a.name, url: u });
  }
  const out: Record<string, unknown> = {
    links, shared: links.length, completed_at: rfc3339(clock.now()),
  };
  if (failed.length > 0) out['failed'] = failed;
  // 零成功 + 至少一败 = 分享没发生——带事件地失败（可重试），绝不空转完成。
  if (links.length === 0 && failed.length > 0) {
    throw new Error(`all ${failed.length} uploads failed`);
  }
  store.setStepOutput(st.id, out as JsonRecord);
};
