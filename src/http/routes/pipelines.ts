// 管线控制面：模板 CRUD/起流/进件授权策略读写。
// 分层重构（2026-09-23）：自 app.ts 按资源族拆出，路由注册体逐字保留。

import type { Hono } from 'hono';
import type { Runtime } from '../../runtime.ts';
import { type JsonRecord } from '../../platform/shared/json.ts';
import { TEMPLATE_FILE_NAME_RE } from '../../business/templates/registry.ts';
import { bodyStr, foreignSessionError, pinTenantCreateInput, readBody, tenantScopeOf, type AppEnv } from '../helpers.ts';

export const registerPipelinesRoutes = (app: Hono<AppEnv>, rt: Runtime): void => {
  // ---- 管线控制面 ---------------------------------------------------------------

  app.get('/api/pipelines', (c) => {
    const templates = rt.engine.currentTemplates();
    return c.json({
      templates: Object.values(templates).map((t) => ({
        key: t.key, name: t.name, trigger: t.trigger, hash: t.hash,
        file: rt.templateFiles[t.key] ?? `${t.key}.yaml`,
        steps: t.steps.map((s) => ({ id: s.id, kind: s.kind, title: s.title })),
      })),
      errors: rt.templateErrors,
    });
  });

  app.post('/api/pipelines', async (c) => {
    const body = await readBody(c);
    const fileName = bodyStr(body, 'file');
    const yaml = bodyStr(body, 'yaml');
    if (fileName === '' || yaml === '') return c.json({ error: 'file and yaml required' }, 400);
    const saveErr = rt.saveTemplate(fileName, yaml);
    if (saveErr !== null) return c.json({ error: saveErr }, 400);
    return c.json({ ok: true });
  });

  app.get('/api/pipelines/:file', (c) => {
    const file = c.req.param('file') ?? '';
    const yaml = rt.readTemplate(file);
    if (yaml === null) return c.json({ error: 'not found' }, 404);
    return c.json({ yaml });
  });

  app.delete('/api/pipelines/:file', (c) => {
    const file = c.req.param('file') ?? '';
    if (!TEMPLATE_FILE_NAME_RE.test(file)) return c.json({ error: '文件名不合法' }, 400);
    rt.deleteTemplate(file);
    return c.json({ ok: true });
  });

  app.post('/api/pipelines/start', async (c) => {
    const body = await readBody(c);
    const template = bodyStr(body, 'template');
    const title = bodyStr(body, 'title');
    if (template === '') return c.json({ error: 'template required' }, 400);
    const rawInput = body['input'] ?? {};
    if (typeof rawInput !== 'object' || Array.isArray(rawInput)) {
      return c.json({ error: 'input must be an object' }, 400);
    }
    let input = rawInput as JsonRecord;
    // 建单租户闸（A-P1-4 / A-P2-8）：one 身份起流按请求租户打显式戳——模板流
    // 此前完全不打戳，落 internal、起流人在自己视角自查 404。显式他租户、钉他
    // 会话、关联他租户单一律 400 点名（与 /api/lifecycle/tasks 同一份闸）。
    const scope = tenantScopeOf(c);
    if (scope.kind === 'one') {
      const sessionErr = foreignSessionError(c, rt, body);
      if (sessionErr !== '') return c.json({ error: sessionErr }, 400);
      try {
        input = pinTenantCreateInput(scope.tenant, rt, input);
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
    const rawSteps = body['steps'];
    const onlySteps = Array.isArray(rawSteps) ? rawSteps.filter((x): x is string => typeof x === 'string') : undefined;
    try {
      const w = await rt.engine.startFlow(template, title, input, onlySteps);
      return c.json({ workflow: w });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.get('/api/pipeline/authz', (c) => {
    const p = rt.engine.currentAuthz();
    return c.json({ mode: p.mode, allow: p.allow, deny: p.deny });
  });

  app.post('/api/pipeline/authz', async (c) => {
    const body = await readBody(c);
    const mode = body['mode'] === 'open' ? 'open' : 'allowlist';
    const arr = (k: string): readonly string[] =>
      Array.isArray(body[k]) ? body[k].filter((x): x is string => typeof x === 'string') : [];
    // 渠道闸和引擎策略一起换（2026-11-23 全量审查修复）：此前只调
    // engine.setAuthz，邮件源收信第一步的渠道闸还是旧策略——这里新加的
    // 白名单地址继续被挡在外面（邮件被跳过、不建单不留痕），要重启才生效。
    rt.setSenderAuthz({ mode, allow: arr('allow'), deny: arr('deny') });
    const p = rt.engine.currentAuthz();
    return c.json({ mode: p.mode, allow: [...p.allow], deny: [...p.deny] });
  });

};
