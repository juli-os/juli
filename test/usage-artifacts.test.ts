// usage 账本 + 工件账本（disk/S3 presign）+ case-inbox 扫描契约测试。

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageStore } from '@juli-os/ledger';
import { createArtifactLedger, sweepCaseInbox } from '@juli-os/artifacts';
import { createDiskBackend, createS3Backend, createDualBackend, assertSigV4PresignShape, type ArtifactBackend } from '@juli-os/artifacts';
import { DatabaseSync } from 'node:sqlite';

/** 恒 miss 后端：验证 dual 的读穿透（主存缺字节 → 远端兜底）。 */
const mkMissBackend = (): ArtifactBackend => ({
  put: async () => ({ ok: false, error: new Error('miss') }),
  get: async () => ({ ok: false, error: new Error('miss') }),
  delete: async () => ({ ok: true, value: undefined }),
  list: async () => [],
  url: async () => ({ ok: false, error: new Error('miss') }),
});

describe('usage 账本', () => {
  it('记录 → 统计 → 时间线', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-usage-'));
    try {
      let t = new Date('2026-09-07T08:00:00Z');
      const store = createUsageStore(join(dir, 'usage.db'), () => new Date(t));
      store.record({ source: 'orchestrator', model: 'glm-5.3', inputTokens: 100, outputTokens: 200, durationMs: 500 });
      t = new Date('2026-09-07T09:30:00Z');
      store.record({ source: 'orchestrator', model: 'glm-5.3', inputTokens: 50, outputTokens: 80 });
      t = new Date('2026-09-07T10:00:00Z');
      store.record({ source: 'triage', model: 'glm-5.3-flash', inputTokens: 10, outputTokens: 5, error: 'timeout' });

      const stats = store.stats(24);
      expect(stats.totalCalls).toBe(3);
      expect(stats.totalInputTokens).toBe(160);
      expect(stats.totalOutputTokens).toBe(285);
      // byModel/timeline 双向计量（2026-09-27）：计费大头在输入，只聚合输出
      // 会误判成本——两处都带 inputTokens。
      expect(stats.byModel[0]).toMatchObject({ model: 'glm-5.3', calls: 2, inputTokens: 150, outputTokens: 280 });
      const tl = store.timeline(24);
      expect(tl.length).toBe(3); // 08/09/10 三个小时桶
      expect(tl[0]).toMatchObject({ hour: '2026-09-07T08', calls: 1, inputTokens: 100, outputTokens: 200 });
      expect(store.recent(2).length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('工件账本（disk 后端）', () => {
  it('put→get→list 往返；register 版本链；墓碑不可逆；updateMeta 记忆化', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-art-'));
    try {
      const backend = createDiskBackend(dir);
      const put = await backend.put('cases/wf1/a.txt', Buffer.from('hello artifact'));
      expect(put.ok).toBe(true);
      const get = await backend.get('cases/wf1/a.txt');
      expect(get.ok).toBe(true);
      if (get.ok) expect(get.value.toString()).toBe('hello artifact');
      const list = await backend.list('cases/wf1');
      expect(list).toContain('cases/wf1/a.txt');
      const url = await backend.url('cases/wf1/a.txt');
      expect(url.ok).toBe(true);

      const db = new DatabaseSync(':memory:');
      const ledger = createArtifactLedger(db, backend);
      const a1 = await ledger.putAndRegister({ workflowId: 'wf1', role: 'agent_output', name: 'a.txt', bytes: Buffer.from('v1') });
      const a2 = await ledger.putAndRegister({ workflowId: 'wf1', role: 'agent_output', name: 'a.txt', bytes: Buffer.from('v2 longer') });
      expect(a1.seq).toBe(1);
      expect(a2.seq).toBe(2); // 同名版本链
      expect(a2.sha256).not.toBe(a1.sha256);
      ledger.updateMeta(a2.id, { share_url: 'https://x/presigned' });
      expect(ledger.list('wf1').find((x) => x.id === a2.id)!.meta['share_url']).toBe('https://x/presigned');
      ledger.tombstone(a2.id);
      expect(ledger.list('wf1').map((x) => x.id)).not.toContain(a2.id); // 默认不列已删
      expect(ledger.list('wf1', true).length).toBe(2); // 墓碑后行仍在（行不可变）
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S3 presign URL 具备 SigV4 签名形状', async () => {
    const s3 = createS3Backend({
      endpoint: 'https://s3.example.com', region: 'auto', bucket: 'juli',
      accessKeyId: 'AKID', secretAccessKey: 'secret', pathStyle: true,
    });
    const url = await s3.url('cases/wf1/a.mp4', 600);
    expect(url.ok).toBe(true);
    if (url.ok) {
      expect(url.value.startsWith('https://s3.example.com/juli/cases/wf1/a.mp4?')).toBe(true);
      expect(assertSigV4PresignShape(url.value)).toBe(true);
    }
  });

  it('OSS 端点走 V1 预签（virtual-host 路径不带桶、鉴权三参齐备）', async () => {
    const s3 = createS3Backend({
      endpoint: 'https://artifacts-bucket.oss-cn-hangzhou.aliyuncs.com', region: 'cn-hangzhou', bucket: 'artifacts-bucket',
      accessKeyId: 'AKID', secretAccessKey: 'secret', pathStyle: false,
    });
    const url = await s3.url('cases/wf1/a.mp4', 600);
    expect(url.ok).toBe(true);
    if (url.ok) {
      expect(url.value.startsWith('https://artifacts-bucket.oss-cn-hangzhou.aliyuncs.com/cases/wf1/a.mp4?')).toBe(true);
      expect(url.value).toContain('OSSAccessKeyId=AKID');
      expect(url.value).toContain('Expires=');
      expect(url.value).toContain('Signature=');
      expect(url.value).not.toContain('X-Amz-');
    }
  });

  it('OSS V1 签名已知向量:固定 AK/SK/时钟/资源 → 固定 Expires 与 Signature(时钟可注入)', async () => {
    const s3 = createS3Backend({
      endpoint: 'https://b.oss-cn-hangzhou.aliyuncs.com', region: 'cn-hangzhou', bucket: 'b',
      accessKeyId: 'AKID', secretAccessKey: 'secret', pathStyle: false,
      now: () => new Date('2026-09-16T00:00:00Z'),
    });
    const url = await s3.url('cases/wf1/a.mp4', 600);
    expect(url.ok).toBe(true);
    if (url.ok) {
      // 独立按 OSS V1 规范计算:HMAC-SHA1("GET\n\n\n1789517400\n/b/cases/wf1/a.mp4", 'secret') base64
      // = mUY+Kk9xniLAk4wE/sWHNcPuuMc=,URL 编码后如下——锁定签名算法不回归。
      expect(url.value).toContain('Expires=1789517400');
      expect(url.value).toContain('Signature=mUY%2BKk9xniLAk4wE%2FsWHNcPuuMc%3D');
    }
  });

  it('put() 带 Content-Type 且逐字进 V1 签名:text/* 与 json 附 charset(2026-09-30 octet-stream 旧伤)', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      const s3 = createS3Backend({
        endpoint: 'https://b.oss-cn-hangzhou.aliyuncs.com', region: 'cn-hangzhou', bucket: 'b',
        accessKeyId: 'AKID', secretAccessKey: 'secret', pathStyle: false,
        now: () => new Date('2026-09-30T00:00:00Z'),
      });
      const r = await s3.put('cases/wf1/a.html', Buffer.from('<p>x</p>'));
      expect(r.ok).toBe(true);
      expect(calls.length).toBe(1);
      const { createHmac } = await import('node:crypto');
      const url = new URL(calls[0]!.url);
      const expires = url.searchParams.get('Expires')!;
      // 独立按 V1 规范(含 Content-Type 位)重算签名,与请求 URL 上的 Signature 逐字一致
      // ——签名串与请求头任何一侧漂移,服务端即 SignatureDoesNotMatch。
      const expected = createHmac('sha1', 'secret')
        .update(`PUT\n\ntext/html; charset=utf-8\n${expires}\n/b/cases/wf1/a.html`)
        .digest('base64');
      expect(url.searchParams.get('Signature')).toBe(expected);
      expect(calls[0]!.headers['content-type']).toBe('text/html; charset=utf-8');
      // 词表:json 附 charset,二进制裸类型。
      await s3.put('cases/wf1/a.json', Buffer.from('{}'));
      await s3.put('cases/wf1/a.mp4', Buffer.from('\0\0'));
      expect(calls[1]!.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(calls[2]!.headers['content-type']).toBe('video/mp4');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('url() publicHost 改写仅对 OSS V1 生效:share 域替换、签名参数原样;SigV4 端点不改写', async () => {
    const oss = createS3Backend({
      endpoint: 'https://artifacts-bucket.oss-cn-hangzhou.aliyuncs.com', region: 'cn-hangzhou', bucket: 'artifacts-bucket',
      accessKeyId: 'AKID', secretAccessKey: 'secret', pathStyle: false,
      publicHost: 'https://share.example.com/',
    });
    const u = await oss.url('cases/wf1/a.html', 3600);
    expect(u.ok).toBe(true);
    if (u.ok) {
      // Go makro 时代 share.example.com CNAME 同款回归:域名换、鉴权三参在。
      expect(u.value.startsWith('https://share.example.com/cases/wf1/a.html?')).toBe(true);
      expect(u.value).toContain('OSSAccessKeyId=AKID');
      expect(u.value).toContain('Signature=');
      expect(u.value).not.toContain('aliyuncs.com');
    }
    const aws = createS3Backend({
      endpoint: 'https://s3.example.com', region: 'auto', bucket: 'juli',
      accessKeyId: 'AKID', secretAccessKey: 'secret', pathStyle: true,
      publicHost: 'share.example.cn',
    });
    const v = await aws.url('cases/wf1/a.html', 3600);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.startsWith('https://s3.example.com/juli/')).toBe(true); // SigV4 签 host,改写即废 → 忽略
  });

  it('OSS 裸区域端点(path-style 默认)出 /bucket/key 形态,签名 resource 仍为 /bucket/key', async () => {
    const s3 = createS3Backend({
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', region: 'cn-hangzhou', bucket: 'juli',
      accessKeyId: 'AKID', secretAccessKey: 'secret', pathStyle: true,
    });
    const url = await s3.url('cases/wf1/a.mp4', 600);
    expect(url.ok).toBe(true);
    if (url.ok) {
      expect(url.value.startsWith('https://oss-cn-hangzhou.aliyuncs.com/juli/cases/wf1/a.mp4?')).toBe(true);
      expect(url.value).toContain('Signature=');
      expect(url.value).not.toContain('X-Amz-');
    }
  });

  it('预签 URL 对 key 逐段编码:?/#/空格/字面 % 不破坏 URL 结构(SigV4 与 OSS 一致)', async () => {
    const oss = createS3Backend({
      endpoint: 'https://b.oss-cn-hangzhou.aliyuncs.com', region: 'cn-hangzhou', bucket: 'b',
      accessKeyId: 'AKID', secretAccessKey: 'secret', pathStyle: false,
    });
    const u = await oss.url('cases/wf1/报告 50% off?v=1#2.txt', 600);
    expect(u.ok).toBe(true);
    if (u.ok) {
      expect((u.value.match(/\?/g) ?? []).length).toBe(1); // ? 被编码 → 查询串唯一
      expect((u.value.match(/#/g) ?? []).length).toBe(0); // # 被编码 → 无片段截断
      expect(u.value).toContain('OSSAccessKeyId=AKID'); // 鉴权三参完整落在查询串
    }
    const s3 = createS3Backend({
      endpoint: 'https://s3.example.com', region: 'auto', bucket: 'juli',
      accessKeyId: 'AKID', secretAccessKey: 'secret', pathStyle: true,
    });
    const u2 = await s3.url('cases/wf1/报告#a.txt', 600);
    expect(u2.ok).toBe(true);
    if (u2.ok) {
      expect(u2.value.startsWith('https://s3.example.com/juli/cases/wf1/%E6%8A%A5%E5%91%8A%23a.txt?')).toBe(true);
      expect(assertSigV4PresignShape(u2.value)).toBe(true);
    }
  });

  it('s3.list 现状语义锁定:匿名 ListObjects 仅公开桶可用,私有桶 403 → 静默 [](无生产调用方,启用前须改预签)', async () => {
    const fetchMock = vi.fn(async () => new Response('AccessDenied', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const s3 = createS3Backend({
        endpoint: 'https://s3.example.com', region: 'auto', bucket: 'juli',
        accessKeyId: 'AKID', secretAccessKey: 'secret', pathStyle: true,
      });
      expect(await s3.list('cases/')).toEqual([]);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('双后端：disk 主存远端影子、读穿透回退、url() 惰性回填存量字节', async () => {
    const d1 = mkdtempSync(join(tmpdir(), 'juli-dual-p-'));
    const d2 = mkdtempSync(join(tmpdir(), 'juli-dual-r-'));
    try {
      const disk = createDiskBackend(d1);
      const remote = createDiskBackend(d2);
      const dual = createDualBackend(disk, remote);
      // put 双落：两端都读得到
      const put = await dual.put('wf1/a.txt', Buffer.from('hello'));
      expect(put.ok).toBe(true);
      expect((await remote.get('wf1/a.txt')).ok).toBe(true);
      // 读穿透：主存缺字节时远端兜底（存量旧工件场景的镜像面）
      const primaryMiss = createDualBackend(mkMissBackend(), remote);
      const viaRemote = await primaryMiss.get('wf1/a.txt');
      expect(viaRemote.ok).toBe(true);
      if (viaRemote.ok) expect(viaRemote.value.toString()).toBe('hello');
      // url() 惰性回填：远端缺字节时先从主存补传再出链接
      const emptyRemote = createDiskBackend(mkdtempSync(join(tmpdir(), 'juli-dual-e-')));
      const lazy = createDualBackend(disk, emptyRemote);
      expect((await emptyRemote.get('wf1/a.txt')).ok).toBe(false); // 初始缺
      const url = await lazy.url('wf1/a.txt', 60);
      expect(url.ok).toBe(true);
      expect((await emptyRemote.get('wf1/a.txt')).ok).toBe(true); // 回填成功
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  });

  it('dual 失败路径:远端 put 恒败不伤 put;url() 回填失败/两端皆无字节 → err 不出死链;delete 远端失败可见', async () => {
    const d1 = mkdtempSync(join(tmpdir(), 'juli-dual-f1-'));
    try {
      const disk = createDiskBackend(d1);
      // 远端全瘫桩:put/get 恒败、delete 恒败;url 恒 ok(presign 是纯本地计算)
      const remoteDown: ArtifactBackend = {
        ...mkMissBackend(),
        delete: async () => ({ ok: false, error: new Error('remote down') }),
        url: async () => ({ ok: true, value: 'https://remote.invalid/presigned' }),
      };
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const dual = createDualBackend(disk, remoteDown);
        // put:disk 已落即 ok(远端抖动不伤管线),错误只进日志
        const put = await dual.put('wf2/a.txt', Buffer.from('x'));
        expect(put.ok).toBe(true);
        expect((await disk.get('wf2/a.txt')).ok).toBe(true);
        expect(errSpy.mock.calls.some((c) => String(c[0]).includes('remote put failed'))).toBe(true);
        // url():远端回填失败 → err(死链不外发,上游 share 走 failed 可重试、不记忆化)
        const u = await dual.url('wf2/a.txt', 60);
        expect(u.ok).toBe(false);
        // url():两端皆无字节 → err,同样不出死链
        const ghost = await dual.url('wf2/ghost.txt', 60);
        expect(ghost.ok).toBe(false);
        // delete:远端失败并入返回值(purge 可见,不再静默残留),主存字节仍删净
        const del = await dual.delete('wf2/a.txt');
        expect(del.ok).toBe(false);
        expect((await disk.get('wf2/a.txt')).ok).toBe(false);
      } finally {
        errSpy.mockRestore();
      }
    } finally {
      rmSync(d1, { recursive: true, force: true });
    }
  });

  it('dual.list = 主存 ∪ 远端(并集去重)', async () => {
    const d1 = mkdtempSync(join(tmpdir(), 'juli-dual-l1-'));
    const d2 = mkdtempSync(join(tmpdir(), 'juli-dual-l2-'));
    try {
      const disk = createDiskBackend(d1);
      const remote = createDiskBackend(d2);
      await disk.put('wf3/disk-only.txt', Buffer.from('d'));
      await remote.put('wf3/remote-only.txt', Buffer.from('r'));
      const dual = createDualBackend(disk, remote);
      await dual.put('wf3/both.txt', Buffer.from('b')); // 双落 → 两端同名,应去重
      const listed = await dual.list('wf3');
      expect(listed).toContain('wf3/disk-only.txt');
      expect(listed).toContain('wf3/remote-only.txt');
      expect(listed.filter((k) => k === 'wf3/both.txt').length).toBe(1);
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  });

  it('case-inbox 收编：申报单核验 role/哈希；登记即删（inbox 回空）；版本链', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-inbox-'));
    try {
      const inbox = join(dir, 'case-inbox', 'wf9');
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, 'chart.png'), Buffer.from([137, 80, 78, 71]));
      writeFileSync(join(inbox, 'draft-followup.txt'), '答复正文');
      writeFileSync(join(inbox, 'reply.json'), JSON.stringify({
        envelope: { in_reply_to_hint: '<orig@x>', feedback_refs: ['fb-1'] },
        deliverables: [
          { file: 'draft-followup.txt', role: 'body', summary: '答复正文' },
          { file: 'chart.png', role: 'weird-role' }, // 未知 role → report + warning
        ],
      }));
      const db = new DatabaseSync(':memory:');
      const ledger = createArtifactLedger(db, createDiskBackend(join(dir, 'store')));
      const swept = await sweepCaseInbox({ inboxDir: inbox, workflowId: 'wf9', ledger });
      // 交付物 2 件 + 引擎 HTML 兜底 1 件（无 HTML 交付物时合成 result.html）
      expect(swept.count).toBe(3);
      expect(swept.has_manifest).toBe(true);
      expect(swept.envelope).toMatchObject({ in_reply_to_hint: '<orig@x>', feedback_refs: ['fb-1'] });
      const byRole = Object.fromEntries(swept.entries.map((e) => [e.name, e.view_role]));
      expect(byRole['draft-followup.txt']).toBe('body');
      expect(byRole['chart.png']).toBe('report'); // 未知 role 降级
      expect(byRole['result.html']).toBe('report'); // 兜底件
      expect(swept.warnings.some((w) => w.includes('weird-role'))).toBe(true);
      expect(swept.warnings.some((w) => w.includes('fallback result.html'))).toBe(true);
      const rows = ledger.list('wf9');
      expect(rows.length).toBe(4); // 2 交付物 + 兜底件 + 申报单本体（data，manifest=true）
      const manifestRow = rows.find((r) => r.name === 'reply.json')!;
      expect(manifestRow).toMatchObject({ role: 'agent_output' });
      expect(manifestRow.meta).toMatchObject({ view_role: 'data', manifest: true });
      const body = rows.find((r) => r.name === 'draft-followup.txt')!;
      expect(body.meta).toMatchObject({ view_role: 'body', summary: '答复正文' });
      expect(body.sha256).toMatch(/^([0-9a-f]{64})$/);
      expect(rows.find((r) => r.name === 'result.html')?.meta)
        .toMatchObject({ view_role: 'report', generated: 'engine_fallback', source_file: 'draft-followup.txt' });
      // 登记即删：工件库拥有字节后 inbox 回空——同名再交付形成新版本。
      expect(readdirSync(inbox)).toEqual([]);
      writeFileSync(join(inbox, 'draft-followup.txt'), '答复正文 v2');
      const swept2 = await sweepCaseInbox({ inboxDir: inbox, workflowId: 'wf9', ledger });
      expect(swept2.count).toBe(2); // txt v2 + 兜底 result.html v2
      expect(ledger.list('wf9').filter((r) => r.name === 'draft-followup.txt').length).toBe(2); // 版本链
      expect(ledger.list('wf9').filter((r) => r.name === 'result.html').length).toBe(2); // 兜底件同版本链
      // 空目录 = 0 件，不报错。
      expect((await sweepCaseInbox({ inboxDir: join(dir, 'nope'), workflowId: 'wf9', ledger })).count).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('case-inbox 契约核验：多重 body 申报整体降级 report（发送步只见唯一 body）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-inbox2-'));
    try {
      const inbox = join(dir, 'case-inbox', 'wf10');
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, 'a.txt'), 'A');
      writeFileSync(join(inbox, 'b.txt'), 'B');
      writeFileSync(join(inbox, 'manifest.json'), JSON.stringify({
        deliverables: [
          { file: 'a.txt', role: 'body' }, { file: 'b.txt', role: 'body' },
        ],
      }));
      const ledger = createArtifactLedger(new DatabaseSync(':memory:'), null);
      const swept = await sweepCaseInbox({ inboxDir: inbox, workflowId: 'wf10', ledger });
      expect(swept.entries.every((e) => e.view_role === 'report')).toBe(true);
      expect(swept.warnings.some((w) => w.includes('2 body file'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('case-inbox 收编：attachment 是合法 view_role，直接登记不降级不警告', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-inbox3-'));
    try {
      const inbox = join(dir, 'case-inbox', 'wf11');
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, 'deck.pptx'), 'PPT-BYTES');
      writeFileSync(join(inbox, 'manifest.json'), JSON.stringify({
        deliverables: [{ file: 'deck.pptx', role: 'attachment', summary: '生成的演示文稿' }],
      }));
      const ledger = createArtifactLedger(new DatabaseSync(':memory:'), null);
      const swept = await sweepCaseInbox({ inboxDir: inbox, workflowId: 'wf11', ledger });
      expect(swept.count).toBe(1);
      expect(swept.entries[0]).toMatchObject({ name: 'deck.pptx', view_role: 'attachment' });
      expect(swept.warnings).toEqual([]); // 合法值：不再"未知 role，按 report 处理"；纯非文本交付不触发 HTML 兜底
      expect(ledger.list('wf11').find((r) => r.name === 'deck.pptx')?.meta)
        .toMatchObject({ view_role: 'attachment', summary: '生成的演示文稿' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('HTML 兜底（wf_9658ce9225e0 回归）：txt-only 交付合成可渲染 result.html', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-inbox-9658-'));
    try {
      const inbox = join(dir, 'case-inbox', 'wf_9658ce9225e0');
      mkdirSync(inbox, { recursive: true });
      // 复现样本同型：agent 只交 *-body.txt（申报 body）+ reply.json，零 HTML
      writeFileSync(join(inbox, 'promptstats-fix-body.txt'), '根因查清并已修复：<script>alert(1)</script> 与 & 转义验证。');
      writeFileSync(join(inbox, 'reply.json'), JSON.stringify({
        deliverables: [{ file: 'promptstats-fix-body.txt', role: 'body', summary: '修复说明' }],
      }));
      const store = createDiskBackend(join(dir, 'store'));
      const ledger = createArtifactLedger(new DatabaseSync(':memory:'), store);
      const swept = await sweepCaseInbox({ inboxDir: inbox, workflowId: 'wf_9658ce9225e0', ledger });
      // 结果工件恒为 HTML：兜底件在交付物面里，body 原样保留（发送链不受影响）
      expect(swept.count).toBe(2);
      expect(swept.entries.map((e) => e.name).sort()).toEqual(['promptstats-fix-body.txt', 'result.html']);
      expect(swept.warnings.some((w) => w.includes('no primary HTML deliverable') && w.includes('result.html'))).toBe(true);
      const row = ledger.list('wf_9658ce9225e0').find((r) => r.name === 'result.html')!;
      expect(row.mime).toBe('text/html');
      expect(row.meta).toMatchObject({
        view_role: 'report', generated: 'engine_fallback', source_file: 'promptstats-fix-body.txt',
      });
      // 内容可渲染且安全：转义注入面 + julios-meta 数据岛
      const bytes = await store.get(row.key);
      expect(bytes.ok).toBe(true);
      const html = bytes.ok ? bytes.value.toString('utf8') : '';
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).not.toContain('<script>alert');
      expect(html).toContain('id="julios-meta"');
      expect(html).toContain('engine-fallback');
      expect(html).toContain('根因查清并已修复');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('HTML 兜底：交付物已含 HTML 时不合成、不告警', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-inbox-html-'));
    try {
      const inbox = join(dir, 'case-inbox', 'wf12');
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, 'report.html'), '<!doctype html><html><body>正式报告</body></html>');
      writeFileSync(join(inbox, 'reply.json'), JSON.stringify({
        deliverables: [{ file: 'report.html', role: 'report', summary: '主交付物' }],
      }));
      const ledger = createArtifactLedger(new DatabaseSync(':memory:'), null);
      const swept = await sweepCaseInbox({ inboxDir: inbox, workflowId: 'wf12', ledger });
      expect(swept.count).toBe(1);
      expect(swept.entries.map((e) => e.name)).toEqual(['report.html']);
      expect(ledger.list('wf12').some((r) => r.name === 'result.html')).toBe(false);
      expect(swept.warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('HTML 兜底（十四跑 R1 P2-6）：多步单步 1 已交真 HTML，步 2 补交 txt 不再合成冗余 result.html', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-inbox-multi-'));
    try {
      const ledger = createArtifactLedger(new DatabaseSync(':memory:'), null);
      // 步 1：真 report.html 入库
      const inbox1 = join(dir, 'case-inbox', 'wf-multi', 's1');
      mkdirSync(inbox1, { recursive: true });
      writeFileSync(join(inbox1, 'report.html'), '<!doctype html><html><body>正式报告</body></html>');
      const s1 = await sweepCaseInbox({ inboxDir: inbox1, workflowId: 'wf-multi', stepId: 'st1', ledger });
      expect(s1.entries.map((e) => e.name)).toEqual(['report.html']);
      // 步 2：补交 txt——工件库已有非兜底真 HTML，不再造兜底件（版本链不虚增、无告警误报）
      const inbox2 = join(dir, 'case-inbox', 'wf-multi', 's2');
      mkdirSync(inbox2, { recursive: true });
      writeFileSync(join(inbox2, 'notes.txt'), '补充说明');
      const s2 = await sweepCaseInbox({ inboxDir: inbox2, workflowId: 'wf-multi', stepId: 'st2', ledger });
      expect(s2.entries.map((e) => e.name)).toEqual(['notes.txt']);
      expect(s2.warnings.some((w) => w.includes('no primary HTML deliverable'))).toBe(false);
      expect(ledger.list('wf-multi').filter((r) => r.name === 'result.html')).toHaveLength(0);
      // 对照：若库里只有引擎兜底件（generated=engine_fallback），不挡后续兜底
      const inbox3 = join(dir, 'case-inbox', 'wf-fb-only', 's1');
      mkdirSync(inbox3, { recursive: true });
      writeFileSync(join(inbox3, 'a.txt'), '第一批文本');
      await sweepCaseInbox({ inboxDir: inbox3, workflowId: 'wf-fb-only', stepId: 'st1', ledger });
      const inbox4 = join(dir, 'case-inbox', 'wf-fb-only', 's2');
      mkdirSync(inbox4, { recursive: true });
      writeFileSync(join(inbox4, 'b.txt'), '第二批文本');
      const s4 = await sweepCaseInbox({ inboxDir: inbox4, workflowId: 'wf-fb-only', stepId: 'st2', ledger });
      expect(s4.warnings.some((w) => w.includes('no primary HTML deliverable'))).toBe(true); // 前兜底件不算「真 HTML 在库」
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
