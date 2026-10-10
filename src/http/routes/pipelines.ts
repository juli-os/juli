// 管线控制面：模板 CRUD/起流/进件授权策略读写。
// 分层重构（2026-09-23）：自 app.ts 按资源族拆出，路由注册体逐字保留。

import type { Hono } from 'hono';
import type { Runtime } from '../../runtime.ts';
import type { JsonRecord } from '../../platform/shared/json.ts';
import { readBody, type AppEnv } from '../helpers.ts';

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
    const fileName = typeof body['file'] === 'string' ? body['file'] : '';
    const yaml = typeof body['yaml'] === 'string' ? body['yaml'] : '';
    if (fileName === '' || yaml === '') return c.json({ error: 'file and yaml required' }, 400);
    const saveErr = rt.saveTemplate(fileName, yaml);
    if (saveErr !== null) return c.json({ error: saveErr }, 400);
    rt.reloadTemplates();
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
    if (!/^[\w.-]+\.ya?ml$/.test(file)) return c.json({ error: '文件名不合法' }, 400);
    rt.deleteTemplate(file);
    rt.reloadTemplates();
    return c.json({ ok: true });
  });

  app.post('/api/pipelines/start', async (c) => {
    const body = await readBody(c);
    const template = typeof body['template'] === 'string' ? body['template'] : '';
    const title = typeof body['title'] === 'string' ? body['title'] : '';
    if (template === '') return c.json({ error: 'template required' }, 400);
    const rawInput = body['input'] ?? {};
    if (rawInput === null || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
      return c.json({ error: 'input must be an object' }, 400);
    }
    const input = rawInput as JsonRecord;
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
    rt.engine.setAuthz({ mode, allow: arr('allow'), deny: arr('deny') });
    const p = rt.engine.currentAuthz();
    return c.json({ mode: p.mode, allow: [...p.allow], deny: [...p.deny] });
  });

};
