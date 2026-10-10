// 设置视图（板 09）：左侧节导航 + 右侧分节表单。五种字段控件按图例——
// string / number（窄）/ boolean toggle（绿=启用）/ secret（脱敏不回显，留空=不变）/ list（逗号分隔）。
// 热改键 label 旁挂「热改」chip；保存栏 cream 底说明条 + 保存本节 primary。
// 热改键保存即生效；其余键写入 config.json、重启服务后生效——服务端
// /api/settings 裁决，前端只按 applied_hot 如实展示。邮件触发授权（authz）
// 是特殊面板：走 /api/pipeline/authz（内存态，即时生效 + 同步落盘）。

import { api } from '../api.ts';
import { esc } from './dashboard.ts';
import { askConfirm } from '../dialog.ts';

type FieldType = 'string' | 'number' | 'boolean' | 'secret' | 'list' | 'json';

interface FieldSpec {
  path: string;
  label: string;
  type: FieldType;
}

interface SectionSpec {
  id: string;
  title: string;
  nav: string; // 左导航短名（板 09 侧栏文案）
  fields: FieldSpec[];
}

const SECTIONS: readonly SectionSpec[] = [
  {
    id: 'ai', title: 'AI（统一段）', nav: 'AI 统一段',
    fields: [], // 特殊面板：AI key/端点/模型 + 连通性自检（保存前可先测）
  },
  {
    id: 'authz', title: '邮件触发授权', nav: '邮件触发授权',
    fields: [], // 特殊面板：走 /api/pipeline/authz（内存态，即时生效）
  },
  {
    id: 'auto_approve', title: '闸门自动批准', nav: '闸门自动批准',
    fields: [
      { path: 'auto_approve.mode', label: '模式（off 关 / shadow 只留痕 / on 真批）', type: 'string' },
      { path: 'auto_approve.rules', label: '规则 JSON（id/kind/session/internal/title_contains/include_send；问询闸门永不自动批，发送闸门须 include_send）', type: 'json' },
    ],
  },
  {
    id: 'basic', title: '基础服务', nav: '基础服务',
    fields: [
      { path: 'listen_host', label: '监听地址', type: 'string' },
      { path: 'listen_port', label: '监听端口', type: 'number' },
      { path: 'password', label: '访问密码', type: 'secret' },
      { path: 'data_dir', label: '数据目录', type: 'string' },
      { path: 'claude_dir', label: 'CC 目录（hooks 注入）', type: 'string' },
      { path: 'tmux_mode', label: 'tmux 模式', type: 'string' },
      { path: 'tmux_socket_path', label: 'tmux socket 路径', type: 'string' },
    ],
  },
  {
    id: 'llm', title: 'LLM', nav: 'LLM',
    fields: [
      { path: 'llm_provider', label: '提供方（anthropic/openai）', type: 'string' },
      { path: 'llm_model', label: '模型', type: 'string' },
      { path: 'llm_base_url', label: '自定义端点', type: 'string' },
      { path: 'secrets.llm_api_key', label: 'API Key', type: 'secret' },
    ],
  },
  {
    id: 'email', title: '邮件入站（IMAP）', nav: '邮件入站 IMAP',
    fields: [
      { path: 'email_enabled', label: '启用（顶层生效键，优先于下方开关）', type: 'boolean' },
      { path: 'email.enabled', label: '启用（遗留嵌套位）', type: 'boolean' },
      { path: 'email.host', label: 'IMAP 主机', type: 'string' },
      { path: 'email.username', label: '账号', type: 'string' },
      { path: 'email.mailbox', label: '邮箱文件夹', type: 'string' },
      { path: 'email.poll_interval_sec', label: '轮询间隔（秒）', type: 'number' },
      { path: 'email.timeout_sec', label: '连接超时（秒）', type: 'number' },
      { path: 'email.default_session', label: '默认会话', type: 'string' },
      { path: 'email.default_project', label: '默认项目', type: 'string' },
      { path: 'secrets.email_password', label: 'IMAP 密码', type: 'secret' },
    ],
  },
  {
    id: 'smtp', title: '发信（SMTP）', nav: '发信 SMTP',
    fields: [
      { path: 'smtp.host', label: '主机', type: 'string' },
      { path: 'smtp.port', label: '端口', type: 'number' },
      { path: 'smtp.username', label: '账号', type: 'string' },
      { path: 'smtp.from', label: '发件人', type: 'string' },
      { path: 'secrets.smtp_password', label: 'SMTP 密码', type: 'secret' },
    ],
  },
  {
    id: 'tls', title: 'TLS（iOS App 兼容）', nav: 'TLS iOS 兼容',
    fields: [
      { path: 'tls_enabled', label: '启用', type: 'boolean' },
      { path: 'tls_port', label: 'HTTPS 端口', type: 'number' },
      { path: 'tls_cert_path', label: '证书路径', type: 'string' },
      { path: 'tls_key_path', label: '私钥路径', type: 'string' },
    ],
  },
  {
    id: 'push', title: '推送（APNs / Bark）', nav: '推送 APNs/Bark',
    fields: [
      { path: 'apns.key_path', label: 'APNs 密钥路径', type: 'string' },
      { path: 'apns.key_id', label: 'APNs Key ID', type: 'string' },
      { path: 'apns.team_id', label: 'APNs Team ID', type: 'string' },
      { path: 'apns.bundle_id', label: 'Bundle ID', type: 'string' },
      { path: 'apns.sandbox', label: 'APNs 沙箱', type: 'boolean' },
      { path: 'bark_key', label: 'Bark Key', type: 'secret' },
      { path: 'bark_url', label: 'Bark 地址', type: 'string' },
    ],
  },
  {
    id: 'notify', title: '邮件通知（五事件全量）', nav: '邮件通知',
    fields: [
      { path: 'notify.to', label: '收件人（逗号分隔）', type: 'list' },
      { path: 'notify.cc', label: '抄送（逗号分隔）', type: 'list' },
      { path: 'notify.base_url', label: '跳转基址（如 http://192.168.1.10:7170）', type: 'string' },
    ],
  },
  {
    id: 'acp', title: 'ACP 执行器', nav: 'ACP 执行器',
    fields: [
      { path: 'acp.enabled', label: '启用', type: 'boolean' },
      { path: 'acp.command', label: '启动命令', type: 'string' },
      { path: 'acp.model', label: '模型', type: 'string' },
      { path: 'secrets.acp_api_key', label: 'API Key', type: 'secret' },
    ],
  },
  {
    id: 'crm', title: 'CRM（juli内部库）', nav: 'CRM juli库',
    fields: [
      { path: 'crm.enabled', label: '启用', type: 'boolean' },
      { path: 'crm.url', label: '地址', type: 'string' },
      { path: 'crm.admin_email', label: '管理员邮箱', type: 'string' },
      { path: 'crm.admin_pass', label: '管理员密码', type: 'secret' },
    ],
  },
  {
    id: 'party', title: 'Party（当事人=Twenty 引用）', nav: 'Party Twenty',
    fields: [
      { path: 'party.enabled', label: '启用 Twenty 目录（进件挂 party 指针）', type: 'boolean' },
      { path: 'party.twenty_url', label: 'Twenty 地址（REST 根）', type: 'string' },
      { path: 'party.api_key', label: 'API Key', type: 'secret' },
      { path: 'party.auto_create', label: '陌生外部地址自动建档（先查再建，幂等；默认关）', type: 'boolean' },
    ],
  },
  {
    id: 'hold', title: '工作时间窗 hold', nav: '工作时间窗 hold',
    fields: [
      { path: 'work_hours.mode', label: '模式（off 关 / shadow 只记 / on 真hold）', type: 'string' },
      { path: 'work_hours.start', label: '窗口开始（HH:MM，含）', type: 'string' },
      { path: 'work_hours.end', label: '窗口结束（HH:MM，不含）', type: 'string' },
      { path: 'work_hours.timezone', label: '时区（IANA，如 Asia/Shanghai）', type: 'string' },
      { path: 'work_hours.scope', label: '生效面（feedback / all）', type: 'string' },
      { path: 'work_hours.aggregate_throttle_min', label: '聚合 flush 节流（分钟）', type: 'number' },
    ],
  },
  {
    id: 'channels', title: '进件渠道（声明制）', nav: '进件渠道',
    fields: [
      { path: 'channels.declared', label: '渠道声明（JSON 数组：id/kind/label/enabled/session/aggregate/priority_keywords/priority_senders）', type: 'json' },
    ],
  },
  {
    id: 'parties', title: '客户映射（发送者→客户，预留）', nav: '客户映射预留',
    fields: [
      { path: 'parties', label: '映射表（JSON 数组：email/customer/note）', type: 'json' },
    ],
  },
  {
    id: 's3', title: 'S3 工件远端', nav: 'S3 工件远端',
    fields: [
      { path: 's3.endpoint', label: '端点', type: 'string' },
      { path: 's3.region', label: '区域', type: 'string' },
      { path: 's3.bucket', label: '桶', type: 'string' },
      { path: 's3.access_key_id', label: 'Access Key ID', type: 'secret' },
      { path: 'secrets.s3_secret_key', label: 'Secret Key', type: 'secret' },
      { path: 's3.path_style', label: 'path-style 寻址', type: 'boolean' },
      { path: 's3.presign_ttl', label: '预签名有效期（秒）', type: 'number' },
    ],
  },
  {
    id: 'ledger', title: '认证与账本', nav: '认证与账本',
    fields: [
      { path: 'pb_url', label: 'PocketBase 认证地址', type: 'string' },
      { path: 'pb_collection', label: 'PB collection', type: 'string' },
      { path: 'ledger_retention_days', label: '账本保留天数（0=永久）', type: 'number' },
      { path: 'high_cost_models', label: '高成本模型（逗号分隔）', type: 'list' },
    ],
  },
  {
    id: 'judgment', title: '语义判定（Jev）', nav: '语义判定 Jev',
    fields: [], // 特殊面板：走 /api/settings/judgment（引擎热读，即时生效）
  },
];

const getByPath = (obj: Record<string, unknown>, path: string): unknown => {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
};

const setByPath = (obj: Record<string, unknown>, path: string, value: unknown): void => {
  const segs = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (const seg of segs.slice(0, -1)) {
    let next = cur[seg];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      next = {} as Record<string, unknown>;
      cur[seg] = next;
    }
    cur = next as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]!] = value;
};

const SECRET_MARK = '__MASKED__';

/** 字段行（板 09 五种控件）：label（+热改 chip）左列，控件右列。
 * data-init 记渲染时值：保存只发脏字段——env 覆盖值与未动过的键绝不烘进文件。 */
const rowHtml = (f: FieldSpec, value: unknown, hotKeys: readonly string[]): string => {
  const hot = hotKeys.includes(f.path);
  const chip = hot ? ' <span class="chip hot" title="保存后即时生效，无需重启">热改</span>' : '';
  const row = (ctl: string, init: string): string =>
    `<div class="set-row" data-init="${esc(init)}"><label>${esc(f.label)}${chip}</label><div class="set-ctl">${ctl}</div></div>`;
  if (f.type === 'boolean') {
    const on = value === true;
    return row(
      `<label class="tg"><input type="checkbox" data-field="${f.path}"${on ? ' checked' : ''} /><span class="tg-track"><span class="tg-knob"></span></span></label><span class="set-hint" data-tg-hint>${on ? '已启用' : '已停用'}</span>`,
      on ? '1' : '0',
    );
  }
  const v = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  if (f.type === 'secret') {
    // 脱敏：哨兵/keychain 不回显本体。空输入 = 保持不变（不进 patch）。
    const configured = value === SECRET_MARK || (typeof value === 'string' && value !== '');
    const hint = typeof value === 'string' && value.startsWith('keychain:')
      ? `${value} · 留空保持不变`
      : configured ? '已配置 · 留空保持不变' : '未配置';
    return row(
      `<input type="password" data-field="${f.path}" data-secret="1" placeholder="${configured ? '••••••••' : ''}" autocomplete="off" /><span class="set-hint">${esc(hint)}</span>`,
      '',
    );
  }
  if (f.type === 'number') {
    return row(`<input type="number" step="any" data-field="${f.path}" value="${esc(v)}" />`, v);
  }
  if (f.type === 'list') {
    const arr = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
    return row(`<input type="text" data-field="${f.path}" value="${esc(arr.join(', '))}" placeholder="逗号分隔" />`, arr.join(', '));
  }
  if (f.type === 'json') {
    const text = value === undefined || value === null ? '' : JSON.stringify(value, null, 2);
    return row(`<textarea data-field="${f.path}" rows="8" class="set-json" spellcheck="false">${esc(text)}</textarea><span class="set-hint">JSON 数组/对象 · 非法 JSON 拒绝保存</span>`, text);
  }
  return row(`<input type="text" data-field="${f.path}" value="${esc(v)}" />`, v);
};

/** 面板头：标题（可带 chip）+ 右侧 mono API 路径。 */
const panelHead = (titleHtml: string, apiPath: string): string =>
  `<div class="set-ph"><h2>${titleHtml}</h2><span class="set-api mono">${esc(apiPath)}</span></div>`;

export const settingsView = async (el: HTMLElement): Promise<() => void> => {
  el.innerHTML = `
    <div class="set-layout">
      <div class="panel set-nav">
        <h2>配置</h2>
        <div class="set-nav-sub">热改即生效 · 其余重启生效</div>
        <nav id="setNav" aria-label="配置分节"></nav>
        <div class="set-nav-note">敏感项脱敏不回显<br>留空 = 保持不变</div>
      </div>
      <div id="setMain" class="set-main"><p class="muted">加载配置…</p></div>
    </div>`;

  const { file, config, hot_keys } = await api.get<{
    file: string; config: Record<string, unknown>; hot_keys?: string[];
  }>('/api/settings');
  const hotKeys = Array.isArray(hot_keys) ? hot_keys : []; // 旧服务端缺字段 = 无热改标记
  const nav = el.querySelector('#setNav') as HTMLElement;
  const main = el.querySelector('#setMain') as HTMLElement;
  nav.innerHTML = SECTIONS.map((s, i) =>
    `<a data-sec="${s.id}"${i === 0 ? ' class="on"' : ''}>${esc(s.nav)}</a>`).join('') +
    `<div class="set-nav-file mono" title="${esc(file)}">${esc(file)}</div>` +
    // 版本行（2026-10-07 对齐 iOS 设置页版本行）：/api/version 服务端事实源。
    `<div class="set-nav-file mono" id="set-version" title="juli-service 服务端版本（/api/version）">版本 …</div>`;
  void api.get<{ version: string }>('/api/version')
    .then((v) => { const el2 = nav.querySelector('#set-version'); if (el2) el2.textContent = `版本 ${v.version}`; })
    .catch(() => { const el2 = nav.querySelector('#set-version'); if (el2) el2.textContent = '版本（不可达）'; });
  main.innerHTML = '';

  const setActive = (id: string): void => {
    nav.querySelectorAll('a').forEach((a) => a.classList.toggle('on', (a as HTMLElement).dataset.sec === id));
  };
  nav.querySelectorAll<HTMLElement>('a[data-sec]').forEach((a) => {
    a.addEventListener('click', () => {
      setActive(a.dataset.sec ?? '');
      main.querySelector(`#set-${a.dataset.sec ?? ''}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  // 滚动联动：滚动时高亮当前节（阈值带 = 面板进入视口上 1/5 即激活）。
  const spy = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) setActive(en.target.id.replace(/^set-/, ''));
      }
    },
    { rootMargin: '-15% 0px -75% 0px' },
  );

  const bindToggleHints = (sec: HTMLElement): void => {
    sec.querySelectorAll<HTMLInputElement>('.tg input[type="checkbox"]').forEach((input) => {
      input.addEventListener('change', () => {
        const hint = input.closest('.set-ctl')?.querySelector('[data-tg-hint]');
        if (hint) hint.textContent = input.checked ? '已启用' : '已停用';
      });
    });
  };

  // AI 统一段特殊面板（2026-10-10 开源 MVP）：key/base_url/model 一处配置
  // 两处用（引擎 LLM + agent 执行环境注入）。保存前可先「测试连通性」——
  // 服务端打一次最小 completion（不落账不写盘）。api_key 脱敏：留空=不变。
  const renderAi = async (): Promise<void> => {
    const st = await api.get<{ configured: boolean; provider: string; model: string; base_url_set: boolean }>('/api/ai/status');
    const aiCfg = (getByPath(config, 'ai') ?? {}) as Record<string, unknown>;
    const keyConfigured = aiCfg['api_key'] === SECRET_MARK || (typeof aiCfg['api_key'] === 'string' && (aiCfg['api_key'] as string) !== '');
    const sec = document.createElement('div');
    sec.className = 'panel set-panel';
    sec.id = 'set-ai';
    const provSel = (v: string): string => {
      const opts: readonly (readonly [string, string])[] = [
        ['', '跟随旧配置（llm_provider）'], ['anthropic', 'anthropic（官方 / 兼容端点）'], ['openai', 'openai（BigModel/GLM 原生）'],
      ];
      return opts.map(([val, label]) => `<option value="${val}"${v === val ? ' selected' : ''}>${label}</option>`).join('');
    };
    sec.innerHTML = `${panelHead('AI <span class="chip hot">统一段</span>', '/api/settings · /api/ai/check')}
      <p class="set-sub">一处配置两处用：引擎 LLM（chat 起单/记账）与 agent 执行（tmux 里 claude 的 ANTHROPIC_API_KEY 注入）同源。现行生效：provider=<b>${esc(st.provider)}</b> · model=<b>${esc(st.model || '（默认）')}</b> · base_url=${st.base_url_set ? '已设' : '未设'} · key=${st.configured ? '✓ 已配置' : '<b style="color:var(--danger,#c0392b)">未配置</b>'}</p>
      <div class="set-row"><label>provider</label><div class="set-ctl">
        <select id="ai-provider">${provSel(typeof aiCfg['provider'] === 'string' ? (aiCfg['provider'] as string) : '')}</select>
        <span class="set-hint">Anthropic 兼容端点（GLM 等）选 anthropic + 填 base_url</span></div></div>
      <div class="set-row" data-init=""><label>API Key</label><div class="set-ctl">
        <input type="password" id="ai-key" data-secret="1" placeholder="${keyConfigured ? '••••••••' : ''}" autocomplete="off" />
        <span class="set-hint">${keyConfigured ? '已配置 · 留空保持不变' : '未配置（agent 无法干活）'}</span></div></div>
      <div class="set-row"><label>Base URL</label><div class="set-ctl">
        <input type="text" id="ai-baseurl" value="${esc(typeof aiCfg['base_url'] === 'string' ? (aiCfg['base_url'] as string) : '')}" placeholder="留空 = 官方 api.anthropic.com" /></div></div>
      <div class="set-row"><label>模型</label><div class="set-ctl">
        <input type="text" id="ai-model" value="${esc(typeof aiCfg['model'] === 'string' ? (aiCfg['model'] as string) : '')}" placeholder="如 claude-sonnet-4-5 / glm-4.6" /></div></div>
      <div class="set-save"><span class="dot" aria-hidden="true"></span>
        <span class="set-save-note">保存写入 ai 段（tmux 环境热注入，新 agent 会话生效；引擎 LLM 重启生效）</span>
        <span class="set-status" id="ai-status"></span>
        <button id="ai-check" class="j-ghost">测试连通性</button>
        <button class="j-primary" id="ai-save">保存</button></div>`;
    const status = sec.querySelector('#ai-status') as HTMLElement;
    const collect = (): { provider: string; api_key: string; base_url: string; model: string } => ({
      provider: (sec.querySelector('#ai-provider') as HTMLSelectElement).value,
      api_key: (sec.querySelector('#ai-key') as HTMLInputElement).value,
      base_url: (sec.querySelector('#ai-baseurl') as HTMLInputElement).value.trim(),
      model: (sec.querySelector('#ai-model') as HTMLInputElement).value.trim(),
    });
    (sec.querySelector('#ai-check') as HTMLButtonElement).addEventListener('click', async () => {
      status.textContent = '测试中…';
      try {
        const r = await api.post<{ ok: boolean; latency_ms?: number; error?: string; model?: string; reply?: string }>(
          '/api/ai/check', collect());
        status.textContent = r.ok
          ? `✓ 连通（${r.latency_ms ?? '?'}ms · ${r.model || '默认模型'} · 回复「${r.reply ?? ''}」）`
          : `✗ ${r.error ?? '失败'}`;
      } catch (e) {
        status.textContent = `✗ ${e instanceof Error ? e.message : String(e)}`;
      }
    });
    (sec.querySelector('#ai-save') as HTMLButtonElement).addEventListener('click', async () => {
      const v = collect();
      const ai: Record<string, string> = {};
      if (v.provider !== (typeof aiCfg['provider'] === 'string' ? (aiCfg['provider'] as string) : '')) ai['provider'] = v.provider;
      if (v.api_key !== '') ai['api_key'] = v.api_key;
      if (v.base_url !== (typeof aiCfg['base_url'] === 'string' ? (aiCfg['base_url'] as string) : '')) ai['base_url'] = v.base_url;
      if (v.model !== (typeof aiCfg['model'] === 'string' ? (aiCfg['model'] as string) : '')) ai['model'] = v.model;
      if (Object.keys(ai).length === 0) { status.textContent = '没有改动'; return; }
      try {
        const r = await api.put<{ ok: boolean; applied_hot: string[] }>('/api/settings', { patch: { ai } });
        const hotAi = (r.applied_hot ?? []).filter((k) => k.startsWith('ai'));
        status.textContent = hotAi.length > 0 ? `✓ ${hotAi.join(' · ')}` : '已写入，重启服务后生效';
        toast('AI 配置已保存', 'ok');
      } catch (e) {
        alert('保存失败：' + (e instanceof Error ? e.message : String(e)));
      }
    });
    main.prepend(sec); // 渲染晚于 authz（prepend 两次中后者在上）——AI 置顶
    spy.observe(sec);
  };

  // authz 特殊面板：模式 + allow/deny 双输入 + fail-closed 说明，保存即时生效。
  const renderAuthz = async (): Promise<void> => {
    const a = await api.get<{ mode: string; allow: string[]; deny: string[] }>('/api/pipeline/authz');
    const sec = document.createElement('div');
    sec.className = 'panel set-panel';
    sec.id = 'set-authz';
    sec.innerHTML = `${panelHead('邮件触发授权 <span class="chip hot">即时生效</span>', '/api/pipeline/authz')}
      <p class="set-sub">哪类来件可以起流水 · deny 优先 · allowlist 空表 = 全拒（fail-closed）</p>
      <div class="set-row"><label>模式</label><div class="set-ctl">
        <select id="authz-mode"><option value="allowlist"${a.mode === 'allowlist' ? ' selected' : ''}>allowlist</option><option value="open"${a.mode === 'open' ? ' selected' : ''}>open</option></select>
        <span class="chip soft">open = 全部放行（不推荐）</span>
      </div></div>
      <div class="set-grid2">
        <div><label>允许 ALLOW</label><input id="authz-allow" value="${esc(a.allow.join(', '))}" placeholder="boss@example.com, *@acme.cn" /></div>
        <div><label>拒绝 DENY（优先）</label><input id="authz-deny" value="${esc(a.deny.join(', '))}" placeholder="*@spam.com" /></div>
        <button class="j-primary" id="authz-save">保存</button>
      </div>
      <p class="set-note">支持 *@domain 通配 · 热更新无需重启 · 每次变更记录事件流</p>`;
    (sec.querySelector('#authz-save') as HTMLButtonElement).addEventListener('click', async () => {
      const split = (sel: string): string[] =>
        (sec.querySelector(sel) as HTMLInputElement).value.split(',').map((x) => x.trim()).filter(Boolean);
      const mode = (sec.querySelector('#authz-mode') as HTMLSelectElement).value;
      const allow = split('#authz-allow');
      const deny = split('#authz-deny');
      // 授权闸是安全生产变更（谁能用一封邮件起流水）：确认卡先重述将生效的
      // 模式与名单——open 模式在卡上点名警示（信任修复 2026-09-22）。
      const ok = await askConfirm({
        title: '变更邮件触发授权？',
        rows: [
          { k: '模式', v: mode === 'open' ? 'open——全部来件放行（fail-open，不推荐）' : 'allowlist——仅白名单来件可起流水' },
          { k: 'ALLOW', v: allow.length > 0 ? allow.join(', ') : '（空表 = 全拒，fail-closed）' },
          { k: 'DENY', v: deny.length > 0 ? deny.join(', ') : '（无）' },
          { k: '后果', v: '保存即时生效并写入配置——之后到达的邮件按新授权裁决' },
        ],
        confirmText: '确认保存',
      });
      if (ok === null) return;
      try {
        await api.post('/api/pipeline/authz', { mode, allow, deny });
        // 同步落盘（重启不丢）。env 覆盖时文件值被压住——与所有 env 键同理。
        await api.put('/api/settings', { patch: { email_authz_mode: mode, email_authz_allow: allow, email_authz_deny: deny } });
        toast('授权已生效并写入配置', 'ok');
      } catch (e) {
        alert('保存失败：' + (e instanceof Error ? e.message : String(e)));
      }
    });
    main.prepend(sec); // authz 是导航第一节，面板也必须在最前（渲染晚于其他节，故 prepend）
    spy.observe(sec);
  };

  for (const s of SECTIONS) {
    if (s.id === 'authz') continue; // 面板已在最前渲染
    if (s.id === 'ai') continue; // 特殊面板在 renderAuthz 后渲染（renderAi，prepend 到最前）
    if (s.id === 'judgment') continue; // 特殊面板在循环后渲染（renderJudgment）
    const sec = document.createElement('div');
    sec.className = 'panel set-panel';
    sec.id = `set-${s.id}`;
    sec.innerHTML = `${panelHead(esc(s.title), '/api/settings')}
      ${s.fields.map((f) => rowHtml(f, getByPath(config, f.path), hotKeys)).join('')}
      <div class="set-save">
        <span class="dot" aria-hidden="true"></span>
        <span class="set-save-note">热改键保存即生效；其余写入 config.json，重启服务后生效</span>
        <span class="set-status" id="status-${s.id}"></span>
        <button class="j-primary" data-save="${s.id}">保存本节</button>
      </div>`;
    bindToggleHints(sec);
    (sec.querySelector(`button[data-save="${s.id}"]`) as HTMLButtonElement).addEventListener('click', async () => {
      const patch: Record<string, unknown> = {};
      const dirtyLabels: string[] = [];
      for (const f of s.fields) {
        const input = sec.querySelector(`[data-field="${f.path}"]`) as HTMLInputElement | null;
        if (input === null) continue;
        const init = input.closest('.set-row')?.getAttribute('data-init') ?? '';
        if (f.type === 'secret') {
          if (input.value === '') continue; // 留空 = 保持不变
          setByPath(patch, f.path, input.value);
          dirtyLabels.push(f.label);
          continue;
        }
        if (f.type === 'boolean') {
          const cur = input.checked ? '1' : '0';
          if (cur === init) continue; // 未动过的不发——env 覆盖值不烘回文件
          setByPath(patch, f.path, input.checked);
          dirtyLabels.push(f.label);
          continue;
        }
        const raw = input.value.trim();
        // list 先于通用跳过：清空也是合法改动（如清空通知收件人=关通知）。
        if (f.type === 'list') {
          const arr = raw.split(',').map((x) => x.trim()).filter(Boolean);
          const initArr = init.split(',').map((x) => x.trim()).filter(Boolean);
          if (arr.join(',') === initArr.join(',')) continue;
          setByPath(patch, f.path, arr);
          dirtyLabels.push(f.label);
          continue;
        }
        if (f.type === 'json') {
          if (raw === '' || raw === init) continue; // 清空/未动 = 不碰该键
          try {
            setByPath(patch, f.path, JSON.parse(raw));
          } catch {
            alert(`${f.label}：不是合法 JSON`);
            return;
          }
          dirtyLabels.push(f.label);
          continue;
        }
        if (raw === '' || raw === init) continue; // 清空/未动 = 不碰该键
        if (f.type === 'number') {
          const n = Number(raw);
          if (!Number.isFinite(n)) { alert(`${f.label}：不是数字`); return; }
          setByPath(patch, f.path, n);
          dirtyLabels.push(f.label);
          continue;
        }
        setByPath(patch, f.path, raw);
        dirtyLabels.push(f.label);
      }
      const status = sec.querySelector(`#status-${s.id}`) as HTMLElement;
      if (Object.keys(patch).length === 0) { status.textContent = '没有改动'; return; }
      try {
        const r = await api.put<{ ok: boolean; applied_hot: string[] }>('/api/settings', { patch });
        const hotSet = new Set(r.applied_hot);
        const sentHot = s.fields.filter((f) => hotSet.has(f.path)).map((f) => f.label);
        const sentRest = dirtyLabels.filter((label) => !sentHot.includes(label));
        status.textContent = [
          sentHot.length > 0 ? `✓ 已生效：${sentHot.join('、')}` : '',
          sentRest.length > 0 ? `已写入，重启服务后生效：${sentRest.join('、')}` : '',
        ].filter(Boolean).join(' · ');
      } catch (e) {
        alert('保存失败：' + (e instanceof Error ? e.message : String(e)));
      }
    });
    main.appendChild(sec);
    spy.observe(sec);
  }

  // 语义判定（Jev）特殊面板：provider/token/阈值 + 九场景三态——引擎每次
  // ask 热读 judgment.json，保存即生效（无需重启）。token 脱敏：留空=不变。
  const renderJudgment = async (): Promise<void> => {
    const jd = await api.get<{
      file: string; exists: boolean; config: Record<string, unknown> | null; registry: readonly string[];
    }>('/api/settings/judgment');
    const cfgj = (jd.config ?? {}) as Record<string, unknown>;
    const cloud = (cfgj['cloud'] ?? {}) as Record<string, unknown>;
    const scen = (cfgj['scenarios'] ?? {}) as Record<string, string>;
    const sec = document.createElement('div');
    sec.className = 'panel set-panel';
    sec.id = 'set-judgment';
    const sel = (k: string, cur: string): string =>
      ['off', 'shadow', 'on'].map((m) =>
        `<option value="${m}"${cur === m ? ' selected' : ''}>${m}</option>`).join('');
    const scenRows = jd.registry.map((k) => {
      const cur = scen[k] ?? 'off';
      return `<div class="set-row" data-jinit="${cur}"><label>${esc(k)}</label><div class="set-ctl"><select data-jscen="${esc(k)}">${sel(k, cur)}</select></div></div>`;
    }).join('');
    const tokenSet = cloud['token'] === '__MASKED__';
    sec.innerHTML = `${panelHead('语义判定（Jev） <span class="chip hot">即时生效</span>', '/api/settings/judgment')}
      <p class="set-sub">场景 off/shadow/on 三态 · shadow=判定照跑只留痕不改行为 · on=过阈值才采纳 · 文件 <span class="mono">${esc(jd.file)}</span></p>
      <div class="set-row"><label>提供方 provider</label><div class="set-ctl">
        <select id="jd-provider">
          <option value="cloud"${cfgj['provider'] === 'cloud' ? ' selected' : ''}>cloud（TypeSafe API）</option>
          <option value="local-api"${cfgj['provider'] === 'local-api' ? ' selected' : ''}>local-api（自建端点）</option>
          <option value="cli"${cfgj['provider'] === 'cli' ? ' selected' : ''}>cli（子进程）</option>
        </select></div></div>
      <div class="set-row" data-jinit=""><label>API Token</label><div class="set-ctl">
        <input type="password" id="jd-token" data-secret="1" placeholder="${tokenSet ? '••••••••' : ''}" autocomplete="off" />
        <span class="set-hint">${tokenSet ? '已配置 · 留空保持不变' : '未配置'}</span></div></div>
      <div class="set-row"><label>超时上限（ms，夹紧 1000–30000）</label><div class="set-ctl">
        <input type="number" id="jd-timeout" value="${typeof cfgj['timeout_ms'] === 'number' ? cfgj['timeout_ms'] : ''}" placeholder="15000" /></div></div>
      <div class="set-row"><label>采纳阈值 min_confidence</label><div class="set-ctl">
        <input type="number" step="0.01" id="jd-minconf" value="${typeof cfgj['min_confidence'] === 'number' ? cfgj['min_confidence'] : ''}" placeholder="0.7" /></div></div>
      <p class="set-sub">场景开关（off=零出网零留痕 · shadow=留痕照常 · on=可采纳）</p>
      ${scenRows}
      <div class="set-save"><span class="dot" aria-hidden="true"></span>
        <span class="set-save-note">保存写入 judgment.json——引擎每次判定热读，即时生效，无需重启</span>
        <span class="set-status" id="jd-status"></span>
        <button class="j-primary" id="jd-save">保存</button></div>`;
    (sec.querySelector('#jd-save') as HTMLButtonElement).addEventListener('click', async () => {
      const patch: Record<string, unknown> = {};
      const dirty: string[] = [];
      const provider = (sec.querySelector('#jd-provider') as HTMLSelectElement).value;
      if (provider !== (cfgj['provider'] ?? '')) { patch['provider'] = provider; dirty.push('provider'); }
      const token = (sec.querySelector('#jd-token') as HTMLInputElement).value;
      if (token !== '') {
        patch['cloud'] = { ...(patch['cloud'] as object ?? {}), token };
        dirty.push('API Token');
      }
      const toRaw = (id: string): string => (sec.querySelector(id) as HTMLInputElement).value.trim();
      if (toRaw('#jd-timeout') !== '' && toRaw('#jd-timeout') !== String(cfgj['timeout_ms'] ?? '')) {
        const n = Number(toRaw('#jd-timeout'));
        if (!Number.isFinite(n)) { alert('超时上限：不是数字'); return; }
        patch['timeout_ms'] = n; dirty.push('超时上限');
      }
      if (toRaw('#jd-minconf') !== '' && toRaw('#jd-minconf') !== String(cfgj['min_confidence'] ?? '')) {
        const n = Number(toRaw('#jd-minconf'));
        if (!Number.isFinite(n)) { alert('采纳阈值：不是数字'); return; }
        patch['min_confidence'] = n; dirty.push('采纳阈值');
      }
      const scenPatch: Record<string, string> = {};
      const changed: string[] = [];
      sec.querySelectorAll<HTMLSelectElement>('[data-jscen]').forEach((selEl) => {
        const k = selEl.dataset.jscen ?? '';
        const init = selEl.closest('.set-row')?.getAttribute('data-jinit') ?? 'off';
        if (selEl.value !== init) { scenPatch[k] = selEl.value; changed.push(`${k}: ${init}→${selEl.value}`); }
      });
      if (Object.keys(scenPatch).length > 0) { patch['scenarios'] = scenPatch; }
      const status = sec.querySelector('#jd-status') as HTMLElement;
      if (Object.keys(patch).length === 0) { status.textContent = '没有改动'; return; }
      const okgo = await askConfirm({
        title: '变更语义判定配置？（即时生效）',
        rows: [
          ...(dirty.length > 0 ? [{ k: '配置项', v: dirty.join('、') }] : []),
          ...(changed.length > 0 ? [{ k: '场景开关', v: changed.join('、') }] : []),
          { k: '后果', v: '写入 judgment.json——引擎下一次判定即按新配置执行（shadow 只留痕，on 会真实采纳）' },
        ],
        confirmText: '确认保存',
      });
      if (okgo === null) return;
      try {
        await api.put('/api/settings/judgment', { patch });
        status.textContent = '✓ 已保存并生效（引擎热读）';
        toast('语义判定配置已生效', 'ok');
      } catch (e) {
        alert('保存失败：' + (e instanceof Error ? e.message : String(e)));
      }
    });
    main.appendChild(sec);
    spy.observe(sec);
  };

  // 字段类型图例（板 09 底部）：五种控件一览，纯展示不绑定保存。
  const legend = document.createElement('div');
  legend.className = 'panel set-panel set-legend';
  legend.innerHTML = `
    <div class="kicker">// FIELD TYPES</div>
    <h2 class="set-legend-title">字段类型 · 五种控件</h2>
    <div class="set-row"><label><span class="chip kind">string</span> 文本输入</label><div class="set-ctl"><input type="text" value="claude-ops" readonly /></div></div>
    <div class="set-row"><label><span class="chip kind">number</span> 数字输入（窄）</label><div class="set-ctl"><input type="number" value="60" readonly /></div></div>
    <div class="set-row"><label><span class="chip kind">boolean</span> 开关 toggle</label><div class="set-ctl"><span class="tg"><span class="tg-track tg-on"><span class="tg-knob"></span></span></span></div></div>
    <div class="set-row"><label><span class="chip kind">secret</span> 脱敏不回显</label><div class="set-ctl"><input type="password" placeholder="••••••••" readonly /></div></div>
    <div class="set-row"><label><span class="chip kind">list</span> 逗号分隔列表</label><div class="set-ctl"><input type="text" value="a@x.cn, b@y.cn" readonly /></div></div>
    <p class="set-note">secret 永不回显真值 · boolean 即时预览 · list 逗号分隔入库为数组</p>`;
  main.appendChild(legend);

  await renderAuthz();
  await renderAi(); // 后 prepend 才在最前——AI 面板压到 authz 之上
  await renderJudgment();
  return () => spy.disconnect();
};

const toast = (msg: string, level: 'ok' | 'info' = 'info'): void => {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = level === 'ok' ? `✓ ${msg}` : msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
};
