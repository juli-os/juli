// 工件库：列表/取件/分享签名/案卷工件面/清理。
// 分层重构（2026-09-23）：自 app.ts 按资源族拆出，路由注册体逐字保留。

import type { Hono } from 'hono';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import type { Runtime } from '../../runtime.ts';
import { readBody, makeShareAuth, type AppEnv } from '../helpers.ts';

export const registerArtifactsRoutes = (app: Hono<AppEnv>, rt: Runtime): void => {
  const { shareTtlSec: SHARE_TTL_SEC, shareSign, shareVerify } = makeShareAuth(rt);
  const artifactMime = (name: string): string => {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      html: 'text/html', htm: 'text/html', png: 'image/png', jpg: 'image/jpeg',
      jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4',
      mov: 'video/quicktime', pdf: 'application/pdf', json: 'application/json',
      md: 'text/plain', txt: 'text/plain',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ppt: 'application/vnd.ms-powerpoint',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls: 'application/vnd.ms-excel',
    };
    return map[ext] ?? 'application/octet-stream';
  };
  const artifactEntryType = (name: string): string => {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    return ext === 'mp4' || ext === 'mov' || ext === 'webm' ? 'video' : 'html';
  };
  const artifactRoots = (): readonly string[] => [
    join(homedir(), '.makro', 'artifacts'),
    join(rt.config.data_dir, 'artifacts-store'),
  ];
  const walkArtifacts = (): { readonly session: string; readonly file: string; readonly name: string; readonly mtime: number; readonly size: number; readonly ledgerId: string }[] => {
    const out: { session: string; file: string; name: string; mtime: number; size: number; ledgerId: string }[] = [];
    // 账本预处理：walk 只看文件系统，会投影出已墓碑/已删字节的幽灵条目——
    // 一次性读账本，构建全量 keySet 与已墓碑 tombstonedKeys 供 pushFile 过滤；
    // key→id 映射给 /api/artifacts 行补账本 id（iOS 分享 POST /api/artifact/
    // share {id} 的取值面，2026-09-20 P2 契约对齐）。
    const ledgerRows = rt.store.db.prepare('SELECT id, key, deleted_at FROM artifacts').all() as
      Record<string, string | null>[];
    const keySet = new Set<string>();
    const tombstonedKeys = new Set<string>();
    const ledgerIdByKey = new Map<string, string>();
    for (const r of ledgerRows) {
      const key = String(r['key'] ?? '');
      if (key === '') continue;
      keySet.add(key);
      if (r['deleted_at'] !== null) tombstonedKeys.add(key);
      ledgerIdByKey.set(key, String(r['id'] ?? ''));
    }
    const juliRoot = join(rt.config.data_dir, 'artifacts-store');
    const pushFile = (session: string, file: string, rawName: string): void => {
      // juli 工件树（artifacts-store）以 key = 相对路径入账：cases/ 子树里
      // 已墓碑或账本外的孤儿文件一律跳过（legacy makro 库无账本，不过滤）。
      let ledgerId = '';
      if (file.startsWith(juliRoot + sep)) {
        const rel = file.slice(juliRoot.length + sep.length);
        if (rel.startsWith(`cases${sep}`)) {
          if (tombstonedKeys.has(rel)) return;
          if (!keySet.has(rel)) return;
          // 断点十五（2026-09-20）：sweep 收编的申报单（reply.json/manifest.json）
          // 是内部对账面不是人视图交付物——cases/ 子树里按剥离后名字跳过，
          // 不在手机/桌面工件列表里怼原始 JSON。
          const bare = rawName.replace(/^\d{13}-/, '');
          if (bare === 'reply.json' || bare === 'manifest.json') return;
        }
        ledgerId = ledgerIdByKey.get(rel) ?? '';
      }
      try {
        const st = statSync(file);
        // juli 存储文件名带毫秒时间戳前缀（<ts>-<name>）——显示与检索用剥离后的名字
        const name = rawName.replace(/^\d{13}-/, '');
        out.push({ session, file, name, mtime: Math.floor(st.mtimeMs / 1000), size: st.size, ledgerId });
      } catch { /* 竞态文件消失 */ }
    };
    for (const root of artifactRoots()) {
      if (!existsSync(root)) continue;
      for (const top of readdirSync(root, { withFileTypes: true })) {
        if (!top.isDirectory() || top.name === 'customers' || top.name.startsWith('.')) continue;
        if (top.name === 'cases') {
          // juli 结构 cases/<workflowId>/<role>/<file>：session=工作流 id
          const casesDir = join(root, 'cases');
          for (const wf of readdirSync(casesDir, { withFileTypes: true })) {
            if (!wf.isDirectory()) continue;
            const walk = (dir: string, depth: number): void => {
              if (depth > 3) return;
              for (const ent of readdirSync(dir, { withFileTypes: true })) {
                const full = join(dir, ent.name);
                if (ent.name.startsWith('.')) continue;
                if (ent.isDirectory()) {
                  // 结案流程图治理保险（wf_ba456cc065b0，2026-10-04）：case_journey
                  // 子树整目录不进工件列表——生成点已删（wf_00a2a1339b3a），此处
                  // 兜住未来回归与漏网存量（根因报告 wf_40f777a9c45f 可选项）。
                  if (ent.name === 'case_journey') continue;
                  walk(full, depth + 1); continue;
                }
                pushFile(wf.name, full, ent.name);
              }
            };
            walk(join(casesDir, wf.name), 1);
          }
          continue;
        }
        // 遗留 makro 结构 <root>/<session>/<file>（可再嵌套一层）
        const walk = (dir: string, depth: number): void => {
          if (depth > 2) return;
          for (const ent of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, ent.name);
            if (ent.name.startsWith('.')) continue;
            if (ent.isDirectory()) { walk(full, depth + 1); continue; }
            pushFile(top.name, full, ent.name);
          }
        };
        walk(join(root, top.name), 1);
      }
    }
    return out;
  };

  app.get('/api/artifacts', (c) => {
    const session = c.req.query('session') ?? '';
    const all = walkArtifacts().filter((x) => session === '' || x.session === session);
    // makro-artifacts 三件套契约：meta.json 是 agent 复用的索引面，md 是
    // html 视图的侧车——人视图（手机/桌面列表）只该看到交付物本体。
    const has = new Set(all.map((x) => `${x.session}/${x.name}`));
    // 服务端 join enrich（wf_1bc08ecd4184，方案 A）：juli 工件树 session=工作流
    // id——批量查 workflows 附 {id,title,status}，根治客户端 join 覆盖率缺口
    //（>500 单截断/legacy 名对不上）。legacy makro 会话查无即不附键。
    const wfRows = rt.store.db.prepare('SELECT id, title, status FROM workflows').all() as
      Record<string, string>[];
    const wfById = new Map(wfRows.map((r) => [String(r['id']), {
      id: String(r['id']), title: String(r['title'] ?? ''), status: String(r['status'] ?? ''),
    }]));
    const rows = all
      .filter((x) => {
        if (x.name.endsWith('.meta.json')) return false;
        if (x.name.endsWith('.md')) return !has.has(`${x.session}/${x.name.slice(0, -3)}.html`);
        return true;
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => ({
        session: x.session, name: x.name, path: x.name,
        type: artifactEntryType(x.name), mtime: x.mtime, size: x.size,
        // 账本 id（juli 工件有、legacy makro 文件无）：POST /api/artifact/share
        // {id} 的取值面；缺省键省略（iOS String? 容错解码）。
        id: x.ledgerId !== '' ? x.ledgerId : undefined,
        // 所属单（wf_1bc08ecd4184）：卡片芯片/预览页「所属单」横幅与回跳的数据源。
        workflow: wfById.get(x.session),
      }));
    return c.json(rows);
  });

  app.get('/api/artifact', async (c) => {
    const session = c.req.query('session') ?? '';
    const path = c.req.query('path') ?? '';
    if (session === '' || path === '') return c.json({ error: 'session and path required' }, 400);
    const hit = walkArtifacts().find((x) => x.session === session && x.name === path);
    if (!hit) return c.text('not found', 404);
    const bytes = readFileSync(hit.file);
    return c.body(new Uint8Array(bytes), 200, { 'content-type': artifactMime(hit.name) });
  });

  // 工件分享外链时长（Go makro shareURLTTL 同款回归）：发出去的链接收件人可能
  // 数月后才点，1h 短票对人是死链。OSS presign 走本值；本地 HMAC 回退链仍 1h。
  const SHARE_URL_TTL_SEC = 10 * 365 * 24 * 3600;

  // 工件分享：OSS 外链优先（Go 时代行为回归，2026-09-30 用户报「分享域名不是
  // example」——TS 移植曾把 URL 换成请求 origin 铸的 HMAC 链，iPhone 经 frp 直连
  // 拿到自签证书的 IP:端口，收件人打不开）。presign + share 域改写在字节后端内
  // 完成；dual.url() 顺带重传主存字节，存量对象 PUT 未带 Content-Type 的旧伤
  // （octet-stream 下载件）在首次分享时自动治愈。OSS 不可达/未配 → 回退本地
  // 签名链（LAN 内可用），绝不让分享按钮无链可出。
  app.post('/api/artifact/share', async (c) => {
    const body = await readBody(c);
    const id = typeof body['id'] === 'string' ? body['id'] : '';
    if (id === '') return c.json({ error: 'id required' }, 400);
    const row = rt.store.db.prepare('SELECT key, deleted_at FROM artifacts WHERE id = ?')
      .get(id) as Record<string, string | null> | undefined;
    if (!row || row['deleted_at'] !== null || (row['key'] ?? '') === '') {
      return c.json({ error: 'artifact not found or purged' }, 404);
    }
    if (rt.artifactSharing) {
      const u = await rt.artifactBackend.url(String(row['key']), SHARE_URL_TTL_SEC);
      if (u.ok) return c.json({ url: u.value, expires_in_sec: SHARE_URL_TTL_SEC });
      console.error(`[share] OSS 外链失败，回退本地签名链: ${u.error.message}`);
    }
    const exp = Math.floor(Date.now() / 1000) + SHARE_TTL_SEC;
    const sig = shareSign(id, exp);
    const origin = new URL(c.req.url).origin; // 绝对 origin；反代场景由 X-Forwarded 头决定时可再扩展
    const url = `${origin}/api/artifacts/${encodeURIComponent(id)}/content?share=${exp}:${sig}`;
    return c.json({ url, expires_in_sec: SHARE_TTL_SEC });
  });

  // 案件证据链（工件账本投影，Go Artifact 字段逐字）。
  const goArtifact = (a: Record<string, unknown>, session: string): Record<string, unknown> => {
    const meta = (a['meta'] ?? {}) as Record<string, unknown>;
    const key = String(a['key'] ?? '');
    return {
      id: a['id'], workflow_id: a['workflowId'], role: a['role'], name: a['name'],
      seq: a['seq'], mime: a['mime'], bytes: a['bytes'], sha256: a['sha256'],
      step_id: a['stepId'] || undefined, session: session || undefined,
      storage: {
        backend: key === '' ? 'none' : rt.artifactSharing ? 's3' : 'disk',
        key: key || undefined,
        pending: meta['pending'] === true ? true : undefined,
      },
      meta: Object.keys(meta).length > 0 ? meta : undefined,
      created_at: a['createdAt'], deleted_at: a['deletedAt'] || undefined,
    };
  };

  app.get('/api/lifecycle/workflows/:id/artifacts', (c) => {
    const wf = rt.store.getWorkflow(c.req.param('id'));
    const rows = rt.artifactLedger.list(c.req.param('id'), true);
    const session = wf?.session ?? '';
    return c.json({ artifacts: rows.map((a) => goArtifact(a as unknown as Record<string, unknown>, session)) });
  });

  app.post('/api/lifecycle/workflows/:id/artifacts/purge', async (c) => {
    const id = c.req.param('id');
    let purged = 0;
    for (const a of rt.artifactLedger.list(id, false)) {
      // purge = 字节 + 墓碑（只 tombstone 会留下能被 walk 出来的幽灵文件）。
      if (a.key !== '') {
        const del = await rt.artifactBackend.delete(a.key);
        if (!del.ok) console.error(`[purge] 字节删除失败 ${a.key}: ${del.error.message}`);
      }
      rt.artifactLedger.tombstone(a.id);
      purged++;
    }
    return c.json({ purged });
  });

  app.get('/api/artifacts/:id/content', async (c) => {
    const row = rt.store.db.prepare('SELECT key, name, mime, deleted_at FROM artifacts WHERE id = ?')
      .get(c.req.param('id')) as Record<string, string | null> | undefined;
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row['deleted_at'] !== null || (row['key'] ?? '') === '') return c.json({ error: 'purged' }, 410);
    const bytes = await rt.artifactBackend.get(String(row['key']));
    if (!bytes.ok) return c.json({ error: 'not found' }, 404);
    // 存量行兜底：登记时被打成 octet-stream 的（guessMime 词表补齐前入库的
    // html/pptx/docx 等），按文件名全量重导——iOS QuickLook 靠 MIME 判预览
    // （wf 用户实报：结案流程图.html 即此类）。
    const stored = String(row['mime'] ?? 'application/octet-stream');
    const mime = stored === 'application/octet-stream'
      ? artifactMime(String(row['name'] ?? ''))
      : stored;
    // text/* 必须带 charset：裸 text/html 在直开场景（iOS QuickLook/新标签）
    // 按 windows-1252 解码，中文=乱码。fetch/srcdoc 路径默认 UTF-8 不受影响。
    const contentType = mime.startsWith('text/') || mime === 'application/json'
      ? `${mime}; charset=utf-8`
      : mime;
    // 文件名进 disposition（ascii 兜底 + UTF-8 扩展）：裸 inline 时浏览器按
    // URL 存文件（"content"、无扩展名），下载后本地无法双击打开。
    const asciiName = String(row['name'] ?? 'artifact').replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    return c.body(new Uint8Array(bytes.value), 200, {
      'content-type': contentType,
      'content-disposition': `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(String(row['name'] ?? 'artifact'))}`,
    });
  });

  // 闸门队列（iOS GateQueue：step + workflow 摘要）。
};
