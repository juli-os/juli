// 应用内模态对话框：Electron 不支持 window.prompt()（壳内点按钮直接抛
// "prompt() is not supported"）——所有取输入的场景一律走这里，浏览器/壳通用。
// title/placeholder 会拼进 innerHTML——一律经 esc() 转义（会话名等动态字段
// 可携带任意字符，裸插即存储型 XSS）。

import { esc } from './esc.ts';

/** 焦点圈闭+归还原语（R7-F1 P2-4/5/6）：弹层/抽屉打开时调用——记录触发钮
 * （opener），Tab 键在容器内可聚焦件首尾环绕（焦点已逃出容器也拉回，杜绝
 * 回车在「被遮罩盖住的背景件」上触发）；返回释放器=移除监听并把焦点还给
 * 触发钮（opener 已离树则不还，自然回落 BODY）。四件对话框与开单抽屉共用。 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const trapFocus = (wrap: HTMLElement): (() => void) => {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const focusables = [...wrap.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const inside = wrap.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKey, true);
  return () => {
    document.removeEventListener('keydown', onKey, true);
    if (opener !== null && document.contains(opener)) opener.focus();
  };
};

export interface AskTextOpts {
  readonly title: string;
  readonly value?: string;
  readonly multiline?: boolean;
  readonly placeholder?: string;
}

/** 取单行/多行文本；取消返回 null。Promise 语义，async 处理器里直接 await。 */
export const askText = (opts: AskTextOpts): Promise<string | null> =>
  new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999;display:flex;align-items:center;justify-content:center;padding:16px';
    const field = opts.multiline
      ? `<textarea id="dlg-f" rows="14" placeholder="${esc(opts.placeholder ?? '')}" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--line);border-radius:8px;font:12px/1.5 ui-monospace,monospace;resize:vertical"></textarea>`
      : `<input id="dlg-f" placeholder="${esc(opts.placeholder ?? '')}" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--line);border-radius:8px" />`;
    wrap.innerHTML = `
      <div class="panel" style="width:min(720px,94vw);max-height:88vh;display:flex;flex-direction:column;margin:0">
        <h2 style="margin:0 0 10px;font-size:16px">${esc(opts.title)}</h2>
        ${field}
        <div class="row" style="margin-top:10px;justify-content:flex-end">
          <button class="mini ghost" id="dlg-cancel">取消</button>
          <button class="mini" id="dlg-ok">确定</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    const release = trapFocus(wrap);
    const f = wrap.querySelector('#dlg-f') as HTMLInputElement | HTMLTextAreaElement;
    f.value = opts.value ?? '';
    const done = (v: string | null): void => {
      release();
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const ok = (): void => done(f.value);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') done(null);
      else if (e.key === 'Enter' && (opts.multiline ? (e.metaKey || e.ctrlKey) : true)) {
        e.preventDefault();
        ok();
      }
    };
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(null); });
    wrap.querySelector('#dlg-ok')!.addEventListener('click', ok);
    wrap.querySelector('#dlg-cancel')!.addEventListener('click', () => done(null));
    document.addEventListener('keydown', onKey, true);
    f.focus();
    if (f instanceof HTMLTextAreaElement) f.setSelectionRange(f.value.length, f.value.length);
  });

/** 下拉单选对话框（2026-09-28）：会话改派这类干预面用声明清单选，不手填
 * ——手填要记名字还易错（近匹配绑定守卫会显性拒派）。取消返回 null。 */
export const askSelect = (opts: {
  readonly title: string;
  readonly options: readonly { readonly value: string; readonly label: string; readonly selected?: boolean }[];
  readonly keepLabel?: string;
  readonly keepValue?: string;
}): Promise<string | null> =>
  new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999;display:flex;align-items:center;justify-content:center;padding:16px';
    const optsHtml = opts.options.map((o) =>
      `<option value="${esc(o.value)}"${o.selected ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
    const keep = opts.keepValue !== undefined
      ? `<option value="${esc(opts.keepValue)}">${esc(opts.keepLabel ?? '不改')}</option>` : '';
    wrap.innerHTML = `
      <div class="panel" style="width:min(560px,94vw);margin:0">
        <h2 style="margin:0 0 10px;font-size:16px">${esc(opts.title)}</h2>
        <select id="dlg-s" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--line);border-radius:8px">${keep}${optsHtml}</select>
        <div class="row" style="margin-top:10px;justify-content:flex-end">
          <button class="mini ghost" id="dlg-cancel">取消</button>
          <button class="mini" id="dlg-ok">确定</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    const release = trapFocus(wrap);
    const sel = wrap.querySelector('#dlg-s') as HTMLSelectElement;
    const done = (v: string | null): void => {
      release();
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const ok = (): void => done(sel.value);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') done(null);
      else if (e.key === 'Enter') { e.preventDefault(); ok(); }
    };
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(null); });
    wrap.querySelector('#dlg-ok')!.addEventListener('click', ok);
    wrap.querySelector('#dlg-cancel')!.addEventListener('click', () => done(null));
    document.addEventListener('keydown', onKey, true);
    sel.focus();
  });

/** 多选对话框；取消返回 null。title 与选项同样经 esc()（同一注入面）。 */
export const askChecks = (title: string, options: { id: string; label: string }[]): Promise<string[] | null> =>
  new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999;display:flex;align-items:center;justify-content:center;padding:16px';
    wrap.innerHTML = `
      <div class="panel" style="width:min(560px,94vw);margin:0">
        <h2 style="margin:0 0 10px;font-size:16px">${esc(title)}</h2>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${options.map((o) => `<label style="display:flex;gap:8px;align-items:center;font-size:14px"><input type="checkbox" value="${esc(o.id)}" /> <span><strong>${esc(o.id)}</strong> ${esc(o.label)}</span></label>`).join('')}
        </div>
        <div class="row" style="margin-top:12px;justify-content:flex-end">
          <button class="mini ghost" id="dlg-cancel">取消</button>
          <button class="mini" id="dlg-ok">确定</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    const release = trapFocus(wrap);
    const done = (v: string[] | null): void => {
      release();
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') done(null); };
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(null); });
    wrap.querySelector('#dlg-cancel')!.addEventListener('click', () => done(null));
    wrap.querySelector('#dlg-ok')!.addEventListener('click', () => {
      const picked = [...wrap.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')].map((x) => x.value);
      done(picked.length > 0 ? picked : null);
    });
    document.addEventListener('keydown', onKey, true);
    // 初始聚焦首个 checkbox（P1-1）：与同族三件一致——打开即可 Tab/空格操作，
    // 不落 BODY。
    wrap.querySelector<HTMLInputElement>('input[type=checkbox]')?.focus();
  });

export interface AskConfirmOpts {
  readonly title: string;
  /** 后果陈述行（收件人/主题等）——不可逆动作的确认必须重述后果。 */
  readonly rows: readonly { readonly k: string; readonly v: string }[];
  /** 正文预览（原样，不美化）。 */
  readonly bodyPreview?: string;
  /** 检查结果芯片（✓/⚠/✗ 计数与名称）。 */
  readonly chips?: readonly { readonly label: string; readonly cls: string }[];
  readonly confirmText: string;
  readonly notePlaceholder?: string;
}

/** 结构化确认对话框：确认返回备注（可空串），取消返回 null。
 * 与 askText 的区别：它不是注释表单——收件人/主题/正文/检查全部摆在
 * 确认键上方，操作人按下确认时看见的就是将发生的后果。 */
export const askConfirm = (opts: AskConfirmOpts): Promise<string | null> =>
  new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999;display:flex;align-items:center;justify-content:center;padding:16px';
    wrap.innerHTML = `
      <div class="panel confirm-card" style="width:min(640px,94vw);max-height:88vh;display:flex;flex-direction:column;margin:0">
        <h2 style="margin:0 0 6px;font-size:16px">${esc(opts.title)}</h2>
        <div class="confirm-rows">${opts.rows.map((r) =>
          `<div class="k">${esc(r.k)}</div><div><strong>${esc(r.v)}</strong></div>`).join('')}</div>
        ${opts.chips && opts.chips.length > 0 ? `<div class="confirm-chips">${opts.chips.map((c) =>
          `<span class="chip ${esc(c.cls)}">${esc(c.label)}</span>`).join('')}</div>` : ''}
        ${opts.bodyPreview !== undefined ? `<pre class="confirm-preview">${esc(opts.bodyPreview)}</pre>` : ''}
        <input id="dlg-note" placeholder="${esc(opts.notePlaceholder ?? '备注（可空）')}" style="margin-top:10px;padding:8px;border:1px solid var(--line);border-radius:8px" />
        <div class="row" style="margin-top:10px;justify-content:flex-end">
          <button class="mini ghost" id="dlg-cancel">取消</button>
          <button id="dlg-ok" style="min-height:42px;padding:8px 22px;font-size:14px;border-radius:10px">${esc(opts.confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    const release = trapFocus(wrap);
    const note = wrap.querySelector('#dlg-note') as HTMLInputElement;
    const done = (v: string | null): void => {
      release();
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const ok = (): void => done(note.value);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') done(null);
      else if (e.key === 'Enter' && e.target === note) { e.preventDefault(); ok(); }
    };
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(null); });
    wrap.querySelector('#dlg-ok')!.addEventListener('click', ok);
    wrap.querySelector('#dlg-cancel')!.addEventListener('click', () => done(null));
    document.addEventListener('keydown', onKey, true);
    note.focus();
  });
