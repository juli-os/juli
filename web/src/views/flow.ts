// 模板视图：管线模板列表 + 手动起流。（authz 热更新已迁至「设置」页。）

import { api, getToken, type TemplateInfo } from '../api.ts';
import { esc } from './dashboard.ts';
import { askText, askChecks } from '../dialog.ts';
import { toast } from '../ui.ts';

export const flowView = async (el: HTMLElement): Promise<void> => {
  el.innerHTML = '<h1>模板</h1><div id="templates" class="panel"></div>';

  const loadTemplates = async (): Promise<void> => {
    const box = el.querySelector('#templates') as HTMLElement;
    // 拉取失败（P1-7）：失败面+重试——此前=空面板（拒绝仅 console 可见）。
    let templates: TemplateInfo[];
    try {
      ({ templates } = await api.get<{ templates: TemplateInfo[] }>('/api/pipelines'));
    } catch (e) {
      box.innerHTML = `<p class="muted">加载失败：${esc(e instanceof Error ? e.message : String(e))}</p>` +
        `<button class="mini" id="tpl-retry">重试</button>`;
      box.querySelector('#tpl-retry')?.addEventListener('click', () => void loadTemplates());
      return;
    }
    box.innerHTML = `<h2>已注册（${templates.length}）</h2>${
      templates.map((t) => `
        <div class="panel" style="margin:8px 0">
          <strong>${esc(t.name)}</strong> <span class="muted">${esc(t.key)} · ${esc(t.hash)}</span>
          <div class="muted">${t.steps.map((s) => esc(s.kind)).join(' → ')}</div>
          <div class="row" style="margin-top:8px">
            <button class="mini" data-start="${esc(t.key)}">手动起流</button>
            <button class="mini ghost" data-step-start="${esc(t.key)}">单步起流</button>
            <button class="mini ghost" data-edit="${esc(t.file)}">编辑</button>
          </div>
        </div>`).join('')
    }<div class="row"><input id="flow-title" placeholder="标题（可空）" style="padding:6px;border:1px solid var(--line);border-radius:8px" /><input id="flow-input" placeholder='初始 input（JSON，如 {"concept":"拉花"}）' style="flex:1;padding:6px;border:1px solid var(--line);border-radius:8px" /></div>`;

    for (const btn of box.querySelectorAll<HTMLButtonElement>('button[data-edit]')) {
      btn.addEventListener('click', () => {
        void (async () => {
        const file = btn.dataset.edit ?? '';
        const r = await api.get<{ yaml: string }>(`/api/pipelines/${encodeURIComponent(file)}`);
        const edited = await askText({ title: '编辑模板 YAML（保存即时生效，在途流水不受影响）', value: r.yaml, multiline: true });
        if (edited === null || edited === r.yaml) return;
        const res = await fetch('/api/pipelines', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ file, yaml: edited }),
        });
        if (!res.ok) toast('保存失败：' + (await res.text()), 'urgent');
        await loadTemplates();
        })();
      });
    }
    for (const btn of box.querySelectorAll<HTMLButtonElement>('button[data-step-start]')) {
      btn.addEventListener('click', () => {
        void (async () => {
        const key = btn.dataset.stepStart ?? '';
        const tpl = (await api.get<{ templates: TemplateInfo[] }>('/api/pipelines')).templates.find((x) => x.key === key);
        if (!tpl) return;
        const picked = await askChecks('单步起流——勾选要执行的步骤', tpl.steps.map((s) => ({ id: s.id, label: s.title })));
        if (picked === null) return;
        const title = (box.querySelector('#flow-title') as HTMLInputElement).value;
        let input: unknown = {};
        const raw = (box.querySelector('#flow-input') as HTMLInputElement).value.trim();
        // 非法 JSON 防御（P2-10）：此前裸抛=按钮点了没反应（unhandledrejection）。
        if (raw !== '') {
          try { input = JSON.parse(raw); }
          catch { toast('初始 input 不是合法 JSON——请检查输入框', 'urgent'); return; }
        }
        try {
          await api.post('/api/pipelines/start', { template: key, title, input, steps: picked });
        } catch (e) {
          toast(`起流失败：${e instanceof Error ? e.message : String(e)}`, 'urgent');
          return;
        }
        location.hash = '/lifecycle';
        })();
      });
    }
    for (const btn of box.querySelectorAll<HTMLButtonElement>('button[data-start]')) {
      btn.addEventListener('click', () => {
        void (async () => {
        const key = btn.dataset.start ?? '';
        const title = (box.querySelector('#flow-title') as HTMLInputElement).value;
        let input: unknown = {};
        const raw = (box.querySelector('#flow-input') as HTMLInputElement).value.trim();
        if (raw !== '') {
          try { input = JSON.parse(raw); }
          catch { toast('初始 input 不是合法 JSON——请检查输入框', 'urgent'); return; }
        }
        try {
          await api.post('/api/pipelines/start', { template: key, title, input });
        } catch (e) {
          toast(`起流失败：${e instanceof Error ? e.message : String(e)}`, 'urgent');
          return;
        }
        location.hash = '/lifecycle';
        })();
      });
    }
  };

  await loadTemplates();
};
