// skill 追溯一期（2026-10-02）：目录端点 / hook 收口 / hook spec matcher。
// 方案 A（供给面：目录+家族+健康）+ 方案 B（PostToolUse ^skill__ 自动落账）。

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/platform/config/schema.ts';
import { createRuntime } from '../src/runtime.ts';
import { createHttpApp } from '../src/http/app.ts';
import { defaultHookSpecs, installClaudeHooks, parseSkillUsedStdin } from '@juli-os/agents';

const dir = mkdtempSync(join(tmpdir(), 'juli-skill-'));
const claudeDir = join(dir, 'claude');
mkdirSync(join(claudeDir, 'skills', 'juli-tracing-demo'), { recursive: true });
writeFileSync(
  join(claudeDir, 'skills', 'juli-tracing-demo', 'SKILL.md'),
  '---\nname: juli-tracing-demo\ndescription: 演示用技能\n---\n\n正文',
);
mkdirSync(join(claudeDir, 'skills', 'tool-legacy-x'), { recursive: true });
writeFileSync(
  join(claudeDir, 'skills', 'tool-legacy-x', 'SKILL.md'),
  '---\nname: tool-legacy-x\ndescription: 通用工具\n---\n\n正文',
);
writeFileSync(join(claudeDir, 'settings.json'), '{}');

const rt = createRuntime(configSchema.parse({
  data_dir: dir, claude_dir: claudeDir, password: 'pw-skill-trace',
}));
const app = createHttpApp(rt);
const auth = { 'content-type': 'application/json', authorization: 'Bearer pw-skill-trace' };

describe('skill 追溯', () => {
  it('defaultHookSpecs 含 PostToolUse：matcher ^(Skill$|skill__)（CC 实测 Skill 工具名 + 规范格式双兼容）', () => {
    const specs = defaultHookSpecs('/x/hook.js', 'pw', 'http://127.0.0.1:7170');
    const post = specs.find((s) => s.event === 'PostToolUse');
    expect(post).toBeDefined();
    expect(post!.matcher).toBe('^(Skill$|skill__)');
    expect(post!.command).toContain('skill-used');
    // 既有五 hook 不受影响（matcher 缺省 = 全量语义不变）。
    expect(specs.filter((s) => s.event === 'Stop').length).toBe(1);
    expect(specs.find((s) => s.event === 'Stop')!.matcher).toBeUndefined();
  });

  it('installClaudeHooks 把 matcher 写进 hook 组（省略时不出键）', () => {
    const r = installClaudeHooks(claudeDir, [
      { event: 'PostToolUse', matcher: '^skill__', command: 'echo x' },
      { event: 'Stop', command: 'echo y' },
    ]);
    expect(r.ok).toBe(true);
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')) as {
      hooks: Record<string, { matcher?: string }[]>;
    };
    const post = settings.hooks['PostToolUse']!.find((g) => g.matcher === '^skill__');
    expect(post).toBeDefined();
    // 无 matcher 的组保持无键（CC 语义：无键=全量）。
    const stop = settings.hooks['Stop']!.find((g) => g.matcher === undefined);
    expect(stop).toBeDefined();
  });

  it('POST /skill-used：事件落账（entity=agent 会话，payload 带 skill）', async () => {
    const bad = await app.request('/api/agents/sess-a/skill-used', {
      method: 'POST', body: JSON.stringify({}), headers: auth,
    });
    expect(bad.status).toBe(400); // 缺 skill 拒收
    const res = await app.request('/api/agents/sess-a/skill-used', {
      method: 'POST', body: JSON.stringify({ skill: 'juli-tracing-demo', tool_name: 'skill__juli-tracing-demo' }), headers: auth,
    });
    expect(res.status).toBe(200);
    const evs = rt.store.listEvents(50, ['skill_used']);
    expect(evs.length).toBe(1);
    expect(evs[0]!.entityType).toBe('agent');
    expect(evs[0]!.entityId).toBe('sess-a');
    expect(evs[0]!.payload['skill']).toBe('juli-tracing-demo');
  });

  it('GET /api/skills：家族/描述/健康/用量聚合/排序', async () => {
    // 再来两条不同会话的调用 → 聚合可见。
    await app.request('/api/agents/sess-b/skill-used', {
      method: 'POST', body: JSON.stringify({ skill: 'juli-tracing-demo', tool_name: 'skill__juli-tracing-demo' }), headers: auth,
    });
    await app.request('/api/agents/sess-a/skill-used', {
      method: 'POST', body: JSON.stringify({ skill: 'juli-tracing-demo', tool_name: 'skill__juli-tracing-demo' }), headers: auth,
    });
    const res = await app.request('/api/skills', { headers: auth });
    expect(res.status).toBe(200);
    const data = await res.json() as {
      skills: {
        name: string; family: string; description: string; resident: boolean;
        targets_ok: number; targets_total: number; uses: number; last_used_at: number;
        sessions: { session: string; count: number }[];
      }[];
    };
    const demo = data.skills.find((s) => s.name === 'juli-tracing-demo');
    expect(demo).toBeDefined();
    expect(demo!.family).toBe('juli');
    expect(demo!.description).toBe('演示用技能');
    expect(demo!.resident).toBe(false); // 常驻档只认宪法（显式声明集）
    expect(demo!.targets_ok).toBe(0); // 真实四落点没有这个测试 skill
    expect(demo!.targets_total).toBe(4);
    expect(demo!.uses).toBe(3);
    expect(demo!.sessions.length).toBe(2);
    expect(demo!.sessions[0]).toEqual({ session: 'sess-a', count: 2 }); // 按量排序
    expect(demo!.last_used_at).toBeGreaterThan(0);
    const legacy = data.skills.find((s) => s.name === 'tool-legacy-x');
    expect(legacy!.family).toBe('tool');
    expect(legacy!.uses).toBe(0);
    // 家族序：juli 在 tool 前。
    expect(data.skills.findIndex((s) => s.name === 'juli-tracing-demo'))
      .toBeLessThan(data.skills.findIndex((s) => s.name === 'tool-legacy-x'));
  });

  it('hook CLI skill-used stdin 契约：切名/负载构造/非 skill__ 与坏 stdin 静默丢弃', () => {
    // hook.ts 的 skill-used 分支本体（transcript.ts parseSkillUsedStdin）真实执行：
    // 格式 A（Claude Code 实测，2026-10-04）：tool_name="Skill" + tool_input.skill。
    expect(parseSkillUsedStdin('{"tool_name":"Skill","tool_input":{"skill":"juli-constitution"}}'))
      .toEqual({ skill: 'juli-constitution', tool_name: 'Skill' });
    expect(parseSkillUsedStdin('{"tool_name":"Skill","tool_input":{}}')).toBeNull(); // 参数缺 skill 名
    // 格式 B（agentskills.io 规范，兼容保留）：skill__<name> 切名，返回值即上报负载。
    expect(parseSkillUsedStdin('{"tool_name":"skill__juli-gate-reply"}'))
      .toEqual({ skill: 'juli-gate-reply', tool_name: 'skill__juli-gate-reply' });
    expect(parseSkillUsedStdin('{"tool_name":"skill__a__b"}')).toEqual({ skill: 'a__b', tool_name: 'skill__a__b' });
    // 非法工具名（matcher 漏配/CC 版本变迁）→ null = 静默丢弃。
    expect(parseSkillUsedStdin('{"tool_name":"Bash"}')).toBeNull();
    expect(parseSkillUsedStdin('{"tool_name":"skill"}')).toBeNull(); // 前缀须带双下划线
    expect(parseSkillUsedStdin('{"tool_name":123}')).toBeNull(); // 非字符串 tool_name
    expect(parseSkillUsedStdin('{}')).toBeNull(); // 缺键
    // 坏/空 stdin 不崩：null = exit 0，hook 永不阻塞 agent。
    expect(parseSkillUsedStdin('not json')).toBeNull();
    expect(parseSkillUsedStdin('')).toBeNull();
  });
});
