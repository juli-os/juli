// 模板系统契约测试：解析/校验/哈希快照。阶梯是数据——校验的就是解释器
// 赖以生存的不变量（唯一 id、已知 kind、必填 title）。

import { describe, expect, it } from 'vitest';
import { parseTemplate, tryParseTemplate } from '../src/business/templates/template.ts';
import { EMAIL_REPLY_YAML, VIDEO_PROD_YAML } from '../src/business/templates/defaultTemplates.ts';

describe('parseTemplate', () => {
  it('内嵌邮件模板解析出 8 步阶梯', () => {
    const t = parseTemplate(EMAIL_REPLY_YAML);
    expect(t.key).toBe('email-reply');
    expect(t.trigger).toBe('email');
    expect(t.steps.map((s) => s.kind)).toEqual([
      'triage', 'gate', 'agent', 'verify', 'gate', 'draft', 'gate', 'send',
    ]);
    expect(t.zombie).toEqual({ timeout: '5m', maxAttempts: 3 });
  });

  it('hash 是内容 sha256 前 12 位（快照可审计）', () => {
    const t = parseTemplate(EMAIL_REPLY_YAML);
    expect(t.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(parseTemplate(EMAIL_REPLY_YAML).hash).toBe(t.hash);
    expect(parseTemplate(VIDEO_PROD_YAML).hash).not.toBe(t.hash);
  });

  it('模板流步骤携带 prompt/system/session 声明', () => {
    const t = parseTemplate(VIDEO_PROD_YAML);
    const concept = t.steps.find((s) => s.id === 'concept');
    expect(concept?.prompt).toContain('{{.Input.concept}}');
    expect(concept?.system).toContain('只输出 JSON');
    const render = t.steps.find((s) => s.id === 'render');
    expect(render?.session).toBe('e2e-demo');
    expect(render?.zombie).toEqual({ timeout: '20m', maxAttempts: 2 });
  });

  it.each([
    ['缺 key', 'name: x\nsteps:\n  - {id: a, kind: gate, title: t}\n'],
    ['空阶梯', 'key: k\nsteps: []\n'],
    ['重复 id', 'key: k\nsteps:\n  - {id: a, kind: gate, title: t}\n  - {id: a, kind: send, title: t2}\n'],
    ['未知 kind', 'key: k\nsteps:\n  - {id: a, kind: black_magic, title: t}\n'],
    ['缺 title', 'key: k\nsteps:\n  - {id: a, kind: gate}\n'],
  ])('校验拒绝：%s', (_name, yaml) => {
    expect(tryParseTemplate(yaml)).toBeNull();
  });
});

describe('parseDur（Go 风格时长解析）', () => {
  it('复合式逐段累加；非法/空整体判 0（回落默认）', async () => {
    const { parseDur } = await import('../src/business/templates/template.ts');
    expect(parseDur('5m')).toBe(300_000);
    expect(parseDur('1h30m')).toBe(5_400_000);
    expect(parseDur('90s')).toBe(90_000);
    expect(parseDur('500ms')).toBe(500);
    expect(parseDur('  20m ')).toBe(1_200_000);
    expect(parseDur('')).toBe(0);
    expect(parseDur('abc')).toBe(0);
  });
});

describe('发送前置对账（sendChecks：探活注入）', () => {
  it('URL 探活走注入 mock——离线 warn/在线 pass，全程不碰真实网络', async () => {
    const { runSendChecks } = await import('../src/business/send/sendChecks.ts');
    const probed: string[] = [];
    const checks = await runSendChecks('详见 https://a.example.com/x 与 https://b.example.com/y', {
      redlineWords: ['扣例'], hasManifest: true, feedbackRefs: ['fb-1'], probeUrls: true,
      probeUrl: async (url) => { probed.push(url); return url.includes('a.example'); },
    });
    expect(probed).toEqual(['https://a.example.com/x', 'https://b.example.com/y']);
    const probes = checks.filter((c) => c.name === 'url_probe');
    expect(probes.find((c) => c.detail.includes('a.example'))!.status).toBe('pass');
    expect(probes.find((c) => c.detail.includes('b.example'))!.status).toBe('warn');
    expect(checks.find((c) => c.name === 'redline')!.status).toBe('pass');
    expect(checks.find((c) => c.name === 'contract')!.status).toBe('pass');
  });
});
