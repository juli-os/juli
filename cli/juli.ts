#!/usr/bin/env node
// juli CLI:任务闭环的操作面——任何会话/工具通用的薄壳(状态在 juli DB,
// 不在交接里)。子命令全部打既有 API;本文件不含业务逻辑。
// 例外:session:start/send 直连 agents 层(provision+提交确认),是会话保障
// 链的测试器(2026-09-21 冷启动吞 Enter 事故),逐段报时。
// 用法:npx tsx cli/juli.ts <command> ... (环境变量 JULI_SERVICE_URL / JULI_PASSWORD)
// 单文件 bundle:npm run build:cli → dist-cli/juli.js(esbuild 自包含,可装
// <data_dir>/bin/juli 数据卷稳定路径,与 checkout 解耦)。

import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runHook } from '../src/cli/hook.ts';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { createTmuxClient } from '@juli-os/agents';
import { createProvisioningDispatch } from '@juli-os/agents';
import { createJev, jevTokenFromEnv } from '@juli-os/routing';
import {
  planRouting, SAMPLE_FACTS, SAMPLE_RECORDS, ticketTitle, topAlternatives,
  type RoutingFacts, type RoutingPlan,
} from '@juli-os/routing';
import {
  configFilePath, configSchema, danglingFeedbackRoutes, defaultDataDir, resolveAiConfig, saveConfigFile,
} from '../src/platform/config/schema.ts';
import { createAnthropicChat, createOpenAiChat } from '../src/platform/llm/chat.ts';
import type { FbRecord } from '@juli-os/routing';

const BASE = process.env['JULI_SERVICE_URL'] ?? 'http://127.0.0.1:7170';
const PW = process.env['JULI_PASSWORD'] ??
  ((): string => {
    try {
      return (JSON.parse(readFileSync(`${homedir()}/.juli-service/config.json`, 'utf8')) as { password?: string }).password ?? '';
    } catch {
      return '';
    }
  })();
const H = { Authorization: `Bearer ${PW}`, 'content-type': 'application/json' };

const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: H, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`✗ ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    process.exit(1);
  }
  return text === '' ? {} : JSON.parse(text);
};

const arg = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? '') : '';
};
const positional = (): string[] => process.argv.slice(3).filter((a) => !a.startsWith('--'));
const pos = (n: number): string => positional()[n] ?? '';

/** 读引擎 config.json 的 tmux_socket_path（十四跑 R1 P2-7：此前两处逐字
 * 复制，收口于此）。读失败/未配置 → undefined = tmux 默认 socket。 */
const readSocketCfg = (): string | undefined => {
  try {
    return (JSON.parse(readFileSync(`${homedir()}/.juli-service/config.json`, 'utf8')) as { tmux_socket_path?: string }).tmux_socket_path || undefined;
  } catch {
    return undefined;
  }
};

/** 引擎 config 的路由相关切片(routing 子命令的消费面)。 */
type RoutingCfg = {
  agents?: { session: string; company?: string; domain?: string; senders?: string[]; cwd?: string; description?: string }[];
  feedback_routing?: { rules?: { prefix: string; session: string }[] };
  email?: { default_session?: string };
};

/** config → RoutingFacts 投影(与生产路由同源):声明会话名/cwd/前缀规则/
 * default_session 逐项进 facts,未声明字段补空串(包 RouteAgent 形状)。
 * 纯函数,可测。 */
export const projectRoutingFacts = (cfg: RoutingCfg): RoutingFacts => ({
  agents: (cfg.agents ?? []).map((a) => ({
    session: a.session, company: a.company ?? '', domain: a.domain ?? '',
    senders: a.senders ?? [], cwd: a.cwd ?? '', description: a.description ?? '',
  })),
  rules: cfg.feedback_routing?.rules ?? [],
  defaultSession: cfg.email?.default_session || 'juli-reply',
});

/** 路由 plan 的声明表选择:config 有 agents 声明 → 按生产同源投影;
 * 无声明/config 加载失败(调用方 catch 成 {}) → 回退包内 SAMPLE_FACTS,
 * 不让 demo 落在占位声明表上除非真无声明。纯函数,可测。 */
export const factsForPlan = (cfg: RoutingCfg): RoutingFacts => {
  const f = projectRoutingFacts(cfg);
  return f.agents.length === 0 ? SAMPLE_FACTS : f;
};

/** `juli hook <verb> <session> [status]` 子命令分派（机器向，不进人类 help
 * 主列表——CC hook 注册面的统一入口）。argv 形态 ['hook', verb, session,
 * extra?]，剥掉 'hook' 后交 runHook——与 node dist/cli/hook.js 存量入口同
 * 一条逻辑，零分叉。独立导出可单测。 */
export const dispatchHook = (argv: readonly string[]): Promise<void> => runHook(argv.slice(1));

/** defaultHookSpecs 命令模板的裸 verb 面（`node <bin> <verb> <session>`）——
 * bin 作为 hook.js 替身时从 argv[2] 起就是 verb，见主分派首行的直通分支。
 * 导出供 test/cli-hook.test.ts 的撞名守卫（子命令表扫描 ∩ verbs = ∅）。 */
export const HOOK_VERBS: ReadonlySet<string> = new Set(['notify', 'permission', 'claude-start', 'capture', 'awaiting', 'skill-used']);

const cmd = process.argv[2] ?? '';

/** 路由计划的人面渲染（--json 走机器面，不经此）。 */
const renderPlan = (plan: RoutingPlan): void => {
  console.log(`路由计划 · dry-run · 模型=${plan.model} · ${plan.stats.tickets} 单 → ${plan.stats.groups} 组`
    + `（合并 ${plan.stats.merged} · 跨路由同根因 ${plan.stats.crossRouteDups} · 需人工 ${plan.stats.unresolved}）`
    + ` · 收敛 ${plan.passes} 轮 · tokens in=${plan.usage.inputTokens} out=${plan.usage.outputTokens}`
    + ` · 与基线一致 ${plan.stats.agreeWithBaseline}/${plan.stats.tickets}`);
  plan.groups.forEach((g, gi) => {
    const live = g.live === undefined ? '' : g.live.working ? ' ●干活' : g.live.live ? ' ○空闲' : ' ✗未活';
    console.log(`\n组 ${gi + 1} → ${g.session}${live} · 置信 ${g.confidence.toFixed(2)}`);
    for (const m of g.members) {
      const baseNote = `基线=${m.baseline.session}（${m.baseline.source === 'rule' ? '规则' : '默认'}）`;
      const agree = m.via !== 'jev' ? ' [基线投影]' : m.session === m.baseline.session ? ' [与基线一致✓]' : ` [⚠${baseNote}]`;
      console.log(`  ✦ ${m.record.id} 「${ticketTitle(m.record)}」 ${m.record.author_name || '匿名'}`
        + (m.via === 'jev' ? ` · p${m.pass}=${m.confidence.toFixed(2)}` : '') + agree);
      if (m.record.body !== '') {
        const b = m.record.body.slice(0, 66);
        console.log(`      ${b}${m.record.body.length > 66 ? '…' : ''}`);
      }
    }
    for (const p of g.mergedPairs) console.log(`  ⚡ 建议并单：${p.a} ↔ ${p.b}（同根因 ${p.noul.toFixed(2)}）`);
  });
  if (plan.needsHuman.length > 0) {
    console.log(`\n需人工（${plan.needsHuman.length}）——不瞎兜底，判定不动如下单：`);
    for (const m of plan.needsHuman) {
      const alts = topAlternatives(m.probabilities).map((a) => `${a.option} ${a.p.toFixed(2)}`).join(' / ');
      console.log(`  ？ ${m.record.id} 「${ticketTitle(m.record)}」 ${m.record.body.slice(0, 40)}`);
      console.log(`      ${plan.passes} 轮未定${alts !== '' ? ` · 候选：${alts}` : ''} · 现行链会走 ${m.baseline.session}（${m.baseline.source === 'rule' ? '规则' : '默认'}）`);
    }
  }
  for (const d of plan.crossRouteDups) {
    console.log(`\n⚠ 同根因但路由不同：${d.a} ↔ ${d.b}（${d.noul.toFixed(2)}）→ ${d.sessions[0]} vs ${d.sessions[1]}`);
  }
};

// 直跑守卫:仅作为 CLI 入口执行时跑主流程;被 import(如测试消费导出的
// 路由投影纯函数)时零副作用。process.argv[1]=入口脚本路径,与 import.meta
// .url 同源比对;两侧 realpath 后比——符号路径部署下(如 macOS /tmp→
// /private/tmp)node 把模块 URL 解析成真实路径,不 realpath 就永不相等
// (main 静默不跑)。realpath 失败(异常路径)回退 URL 字面比对。
const isCliEntry = process.argv[1] !== undefined && (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
})();
if (isCliEntry) (async () => {
  // CC hook 注册面命令形态直通：defaultHookSpecs 模板是 `node <bin> <verb>
  // <session>`——裸 verb 首参进来直接走 runHook（bin 是 hook.js 的 drop-in
  // 替身，存量注册面零改写平滑切换到数据卷 bin）。与 juli 显式子命令无词
  // 面冲突（六个 verb 均不在子命令表内）。
  if (HOOK_VERBS.has(cmd)) return runHook(process.argv.slice(2));
  if (cmd === 'start') {
    // 双形态：带模板名=配方起流；只有 --title=免模板起单（动态模型标准入口）。
    const tpl = pos(0);
    if (tpl === '') {
      const title = arg('title');
      if (title === '') { console.error('✗ 用法: juli start <template> ... 或 juli start --title T [--input JSON] [--relates-to WF]'); process.exit(1); }
      const input: Record<string, unknown> = {};
      const raw = arg('input');
      if (raw !== '') {
        try { Object.assign(input, JSON.parse(raw)); } catch { console.error('✗ --input 不是合法 JSON'); process.exit(1); }
      }
      const rel = arg('relates-to') || arg('relatesTo');
      if (rel !== '') input['relates_to'] = rel;
      const d = await call('POST', '/api/lifecycle/tasks', { title, input });
      const wf = (d as { workflow: { id: string } }).workflow.id;
      console.log(`✓ 已起单: ${wf}`);
      console.log(`  查看: ${BASE}/#/lifecycle?w=${wf}`);
      console.log(`  接管: npx tsx cli/juli.ts claim ${wf} --session <会话名>`);
      return;
    }
    const input: Record<string, unknown> = {};
    const raw = arg('input');
    if (raw !== '') {
      try { Object.assign(input, JSON.parse(raw)); } catch { console.error('✗ --input 不是合法 JSON'); process.exit(1); }
    }
    const rel = arg('relates-to') || arg('relatesTo');
    if (rel !== '') input['relates_to'] = rel;
    const body: Record<string, unknown> = { template: tpl, title: arg('title'), input };
    const steps = arg('steps');
    if (steps !== '') body['steps'] = steps.split(',').map((x) => x.trim()).filter(Boolean);
    // 前置校验：模板名打错时给出可用清单（call() 失败即 exit，catch 接不到）。
    const t = await call('GET', '/api/pipelines') as { templates: { key: string; name: string }[] };
    if (!t.templates.some((x) => x.key === tpl)) {
      console.error(`✗ 未知模板 "${tpl}"\n可用: ${t.templates.map((x) => `${x.key}(${x.name})`).join(', ')}`);
      process.exit(1);
    }
    const d = await call('POST', '/api/pipelines/start', body) as { workflow: { id: string } };
    const wf = d.workflow?.id ?? '(未知)';
    console.log(`✓ 已起流: ${wf}`);
    console.log(`  查看: ${BASE}/#/lifecycle?w=${wf}`);
    console.log(`  接管: npx tsx cli/juli.ts claim ${wf} --session <会话名>`);
  } else if (cmd === 'session:start' || cmd === 'session:send') {
    // 会话保障链测试器（2026-09-21 冷启动吞 Enter 事故的测试面）：不经引擎
    // API，直接驱动 agents 层（provision + 提交确认），逐段报时——socket
    // 竞态/冷启动卡壳/吞 Enter 全都秒级现形。socket 与引擎同源（config）。
    const socketCfg = readSocketCfg();
    const tmux = createTmuxClient(socketCfg ? { socketPath: socketCfg } : {});
    const t0 = Date.now();
    const at = (): string => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
    if (cmd === 'session:start') {
      const name = pos(0);
      if (name === '') { console.error('✗ 用法: juli session:start <name> [--cwd <dir>]'); process.exit(1); }
      // 声明过的 agent 自动带 config.agents 的 cwd——一条命令复活任何一个声明的会话。
      const decls = (JSON.parse(readFileSync(`${homedir()}/.juli-service/config.json`, 'utf8')) as { agents?: { session?: string; cwd?: string }[] }).agents ?? [];
      const declCwd = decls.find((d) => d.session === name)?.cwd || '';
      const cwd = arg('cwd') || declCwd || undefined;
      if (cwd !== undefined) console.log(`    · ${name} cwd=${cwd} (${at()})`);
      console.log(`[1] 会话存在性/创建（socket=${socketCfg ?? 'default'}）`);
      const provision = createProvisioningDispatch({
        tmux, bootCommand: 'claude',
        cwdFor: (s) => (s === name ? cwd : decls.find((d) => d.session === s)?.cwd),
        log: (m) => console.log(`    · ${m} (${at()})`),
      });
      // 空文本 = 只 provision（boot + 就绪等待）；结尾对 idle REPL 的空 Enter 是 no-op。
      const r = await provision('cli', name, '');
      if (!r.ok) { console.error(`✗ ${name} 未就绪: ${r.error.message} (${at()})`); process.exit(1); }
      console.log(`✓ ${name} 就绪，claude 在位（总耗时 ${at()}）`);
      console.log(`  提交测试: npx tsx cli/juli.ts session:send ${name} 你好，请回复 ok`);
      return;
    }
    const name = pos(0);
    const text = positional().slice(1).join(' ');
    if (name === '' || text === '') { console.error('✗ 用法: juli session:send <name> <text...>'); process.exit(1); }
    const r = await tmux.sendTextConfirmed(name, text);
    if (!r.ok) { console.error(`✗ ${r.error.message} (${at()})`); process.exit(1); }
    const { enters, repasted, elapsedMs } = r.value;
    console.log(`✓ 已确认提交（${elapsedMs}ms · 补 Enter×${enters} · 补粘贴${repasted ? '×1' : '×0'}）`);
    return;
  } else if (cmd === 'compact' || cmd === 'clear') {
    // CC context 管理（wf_50c13ffbf42f，用户口令）：juli compact <agent> /
    // juli clear <agent>——向目标 agent 的 CC REPL 发斜杠命令。此前的键盘
    // 模拟无法测试；命令化后可直接驱动 + 断言。clear = /clear（全清，
    // 进入新 workflow 边界的重置语义）；compact = /compact（就地压缩）。
    // 只做提交确认层（sendTextConfirmed：paste+Enter 且输入框已重置）；
    // compact/clear 本身的完成与就绪由下一次 dispatch 的 probePane 就绪环
    // 兜底（本命令不截屏、不等 context 操作跑完）。
    const name = pos(0);
    if (name === '') {
      console.error(`✗ 用法: juli ${cmd} <agent>   # 作用对象是 agent 会话（tmux 名）`);
      process.exit(1);
    }
    const slash = cmd === 'compact' ? '/compact' : '/clear';
    const socketCfg2 = readSocketCfg();
    const tmux2 = createTmuxClient(socketCfg2 ? { socketPath: socketCfg2 } : {});
    const det = await tmux2.listSessionsDetailed();
    if (!det.ok || !det.value.some((x) => x.name === name)) {
      console.error(`✗ 会话 ${name} 不在（juli session:list 查看）`);
      process.exit(1);
    }
    const r = await tmux2.sendTextConfirmed(name, slash);
    if (!r.ok) { console.error(`✗ 发送失败: ${r.error.message}`); process.exit(1); }
    console.log(`✓ 已向 ${name} 发送 ${slash}（${r.value.elapsedMs}ms · 补 Enter×${r.value.enters}）`);
    console.log(`  CC 正在${cmd === 'compact' ? '压缩' : '清空'} context…（idle 提示符回来后生效；transcript 照常留档）`);
    return;
  } else if (cmd === 'session:list') {
    // 会话总览：config 声明（agents/绑定）× tmux 活态 × 引擎占用（working
    // 真源=running agent 步）× feedback 路由规则，一张表——排障先看这里。
    const g = await call('GET', '/api/agents/graph') as {
      nodes: { name: string; clone_of: string | null; company: string; domain: string; bind_senders: string[]; agent: string; working: boolean; live: boolean }[];
    };
    const cfg = JSON.parse(readFileSync(`${homedir()}/.juli-service/config.json`, 'utf8')) as {
      email?: { default_session?: string };
      feedback_routing?: { rules?: { prefix: string; session: string }[] };
    };
    const rules = cfg.feedback_routing?.rules ?? [];
    // 中文双宽字符按显示宽度补齐（padEnd 数的是码元，对不齐）。
    const w = (s: string, n: number): string => {
      let width = 0;
      for (const ch of s) width += ch.codePointAt(0)! > 0x2e7f ? 2 : 1;
      return s + ' '.repeat(Math.max(0, n - width));
    };
    console.log(`会话总览（${g.nodes.length}） · default_session=${cfg.email?.default_session ?? '—'}`);
    console.log(`  ${w('', 2)}${w('会话', 26)}${w('前台', 8)}${w('引擎', 8)}${w('公司', 8)}${w('domain', 12)}绑定/备注`);
    for (const n of g.nodes) {
      const dot = n.working ? '●' : n.live ? '○' : '✗';
      const liveSt = n.live ? (n.agent || '在') : '不存在';
      const st = n.working ? '干活' : '空闲';
      const flags = [n.bind_senders.length > 0 ? `绑定=${n.bind_senders.join(',')}` : '',
        n.clone_of !== null ? `克隆→${n.clone_of}` : ''].filter(Boolean).join(' ');
      console.log(`  ${w(dot, 2)}${w(n.name, 26)}${w(liveSt, 8)}${w(st, 8)}${w(n.company || '—', 8)}${w(n.domain || '—', 12)}${flags}`);
    }
    if (rules.length > 0) {
      console.log('\nfeedback 路由规则（页面前缀 → 会话）：');
      for (const r of rules) console.log(`  ${r.prefix === '' ? '(其余全部)' : r.prefix} → ${r.session}`);
    }
    return;
  } else if (cmd === 'show') {
    const wf = pos(0);
    const d = await call('GET', `/api/lifecycle/workflows/${wf}`) as { workflow: { title: string; status: string; meta: Record<string, unknown> }; steps: { seq: number; kind: string; status: string; title: string; output?: Record<string, unknown> }[] };
    console.log(`${d.workflow.title} [${d.workflow.status}] round=${d.workflow.meta['round'] ?? 1}`);
    for (const s of d.steps) {
      console.log(`  ${s.seq}. ${s.kind.padEnd(6)} ${s.status.padEnd(13)} ${s.title}`);
      if (s.status === 'waiting_human' || s.status === 'failed') {
        const o = s.output ?? {};
        const draft = o['draft'] ?? o['output'];
        if (draft) console.log(`     └ ${String(draft).slice(0, 400)}`);
        if (o['error']) console.log(`     └ ✗ ${String(o['error']).slice(0, 200)}`);
      }
    }
  } else if (cmd === 'claim') {
    const wf = pos(0); const session = arg('session');
    await call('POST', `/api/lifecycle/workflows/${wf}/assign`, { session, by: `cli:${session}` });
    console.log(`✓ 已派发到 @${session}`);
  } else if (cmd === 'whisper') {
    const wf = pos(0); const text = arg('text');
    if (wf === '' || text === '') { console.error('✗ 用法: juli whisper <wf> --text "..."'); process.exit(1); }
    const d = await call('GET', `/api/lifecycle/workflows/${wf}`) as { steps: { id: string; kind: string; status: string }[]; workflow: { session?: string } };
    const running = d.steps.find((s) => (s.kind === 'agent' || s.kind === 'verify') && s.status === 'running');
    if (running) {
      await call('POST', `/api/lifecycle/steps/${running.id}/intervene`, { text, by: 'cli' });
      console.log(`✓ 一等插话已投递并留痕(step ${running.id})`);
    } else {
      const sess = d.workflow.session || arg('session');
      await call('POST', `/api/sessions/${encodeURIComponent(sess)}/send`, { text });
      console.log(`✓ 已插话给 @${sess}(无在途步,未留痕)`);
    }
  } else if (cmd === 'approve') {
    // --at "09:00"(最近未来) 或 ISO——定时发：批准=决定，执行等钟。
    const at = arg('at');
    let sendAt: string | undefined;
    if (at !== '') {
      if (/^\d{1,2}:\d{2}$/.test(at)) {
        const [h, m] = at.split(':').map(Number);
        const d = new Date();
        d.setHours(h!, m!, 0, 0);
        if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
        sendAt = d.toISOString();
      } else {
        sendAt = new Date(at).toISOString();
        if (sendAt === 'Invalid Date') { console.error('✗ --at 不可解析（用 HH:mm 或 ISO）'); process.exit(1); }
      }
    }
    await call('POST', `/api/lifecycle/steps/${pos(0)}/approve`, { by: 'cli', note: arg('note'), ...(sendAt ? { send_at: sendAt } : {}) });
    console.log(sendAt ? `✓ 已批准并定档 ${sendAt}（到点自动发出）` : '✓ 已批准');
  } else if (cmd === 'rework') {
    const feedback = arg('feedback') || arg('text');
    await call('POST', `/api/lifecycle/steps/${pos(0)}/rework`, { feedback, by: 'cli' });
    console.log(`✓ 回修已开启:feedback 已注入,轮次 +1`);
  } else if (cmd === 'align') {
    const amendment = arg('amendment') || arg('text');
    if (amendment === '') { console.error('✗ --amendment 必填'); process.exit(1); }
    await call('POST', `/api/lifecycle/steps/${pos(0)}/align`, { amendment, by: 'cli' });
    console.log(`✓ 对齐修正已生效:修正成为工件,下游 agent 以人定稿版本执行`);
  } else if (cmd === 'retry') {
    const patch: Record<string, string> = {};
    for (const k of ['plan', 'prompt', 'session']) {
      const v = arg(k);
      if (v !== '') patch[k] = v;
    }
    await call('POST', `/api/lifecycle/steps/${pos(0)}/retry`, { by: 'cli', ...patch });
    console.log(`✓ 已重试${Object.keys(patch).length ? '(带补丁:' + Object.keys(patch).join(',') + ')' : ''}`);
  } else if (cmd === 'amend') {
    // 补料：juli amend <step-id> in_reply_to=<...> draft=<...>——引擎记账后重臂。
    const stepId = pos(0);
    const patch: Record<string, unknown> = {};
    const raw = arg('input');
    if (raw !== '') {
      try { Object.assign(patch, JSON.parse(raw)); } catch { console.error('✗ --input 不是合法 JSON'); process.exit(1); }
    }
    for (const kv of positional().slice(1)) {
      const eq = kv.indexOf('=');
      if (eq <= 0) { console.error(`✗ 参数 "${kv}" 不是 key=value`); process.exit(1); }
      patch[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    if (Object.keys(patch).length === 0) {
      // 无参 = 查候选值：人只裁断不当检索器。
      const wf = arg('workflow') || stepId;
      const s = await call('GET', `/api/lifecycle/workflows/${wf}/amend-suggestions`) as Record<string, { value: unknown; source: string }>;
      console.log('候选值（来源）：');
      for (const [k, v] of Object.entries(s)) console.log(`  ${k} = ${String(v.value).slice(0, 80)}  （${v.source}）`);
      console.log(`用法: juli amend <step-id> key=value ...  或 --input '{"k":"v"}'`);
      return;
    }
    await call('POST', `/api/lifecycle/steps/${stepId}/amend`, { patch, by: 'cli' });
    console.log(`✓ 已补料 [${Object.keys(patch).join(',')}] 并重臂该步（事件留痕）`);
  } else if (cmd === 'rework-send') {
    const feedback = arg('feedback') || arg('text') || '内容守卫拒发：请补正正文（AI 披露落款不可省略）后重新交付';
    await call('POST', `/api/lifecycle/steps/${pos(0)}/rework-send`, { feedback, by: 'cli' });
    console.log('✓ 已打回补正：agent 带 feedback 重做，修正内容将重新过闸');
  } else if (cmd === 'deliver') {
    const wf = pos(0);
    const evidence = arg('evidence');
    // evidence 是 draft 节点的产出候选——空证据只会起草出空话回信，直接拦。
    if (evidence === '') { console.error('✗ --evidence 必填（交付证据：agent 汇报/关键事实/交付链接）'); process.exit(1); }
    await call('GET', `/api/lifecycle/workflows/${wf}`) as { workflow: { meta: Record<string, unknown> } };
    await call('POST', `/api/lifecycle/workflows/${wf}/nodes`, {
      kind: 'draft', title: '答复草稿',
      input: { evidence, note: `evidence: ${evidence}` },
    });
    console.log('✓ 答复草稿节点已追加(GLM 按 juli-reply 规范起草)→ 交付审阅闸门将开启');
  } else if (cmd === 'review') {
    const wf = pos(0);
    await call('POST', `/api/lifecycle/workflows/${wf}/nodes`, { kind: 'gate', title: arg('title') || '交付审阅' });
    console.log('✓ 审阅节点已追加,等待人工');
  } else if (cmd === 'send') {
    const wf = pos(0);
    await call('POST', `/api/lifecycle/workflows/${wf}/nodes`, { kind: 'send', title: '发送答复' });
    console.log('✓ 发送节点已追加(需已有批准节点)');
  } else if (cmd === 'settle') {
    const wf = pos(0);
    // 空 id 不许打 POST /workflows//settle 出 404（0923 断点⑤）。
    if (wf === '') { console.error('✗ 用法: juli settle <wf>（在途单见 juli queue / juli list）'); process.exit(1); }
    await call('POST', `/api/lifecycle/workflows/${wf}/settle`, { by: 'cli' });
    console.log('✓ run 已结算落账');
  } else if (cmd === 'force-close') {
    // 硬收口（活单中止/尸体收容，审计留痕）——测试循环的复位键。
    const wf = pos(0);
    if (wf === '') { console.error('✗ 用法: juli force-close <wf> [--note 一句话]'); process.exit(1); }
    await call('POST', `/api/lifecycle/workflows/${wf}/force-close`, { note: arg('note') || 'force-close via cli', by: 'cli' });
    console.log(`✓ ${wf} 已硬收口（终态留痕）`);
  } else if (cmd === 'queue') {
    // 收单台快照：谁在跑、谁在等（队序）。agent 开单后看排期同口。
    const d = await call('GET', '/api/queue') as { concurrency: number; active: string[]; waiting: string[] };
    console.log(`收单台 · 并发上限 ${d.concurrency}`);
    for (const id of d.active) console.log(`  ▶ ${id} (机器执行中)`);
    d.waiting.forEach((id, i) => console.log(`  ${i + 1}. ${id} (排队)`));
    if (d.active.length === 0 && d.waiting.length === 0) console.log('  (队空)');
  } else if (cmd === 'audit') {
    const wf = pos(0);
    const d = await call('GET', `/api/lifecycle/workflows/${wf}`) as { workflow: { title: string; status: string; meta: Record<string, unknown>; created_at: string }; steps: { seq: number; kind: string; status: string; title: string; input?: Record<string, unknown>; output?: Record<string, unknown> }[] };
    const w = d.workflow;
    console.log(`审计单 ${wf}`);
    console.log(`  标题: ${w.title} | 状态: ${w.status} | 轮次: round=${w.meta['round'] ?? 1}`);
    console.log(`  客户/发起: ${w.meta['from'] ?? '(内部)'} | 建立: ${w.created_at.slice(0, 16)}`);
    let totalMs = 0;
    for (const s of d.steps) {
      console.log(`  [${s.seq}] ${s.kind} ${s.status} ${s.title}`);
      const out = s.output ?? {};
      if (out['outputTokens']) console.log(`      └ tokens: in=${out['inputTokens'] ?? '?'} out=${out['outputTokens']}`);
      if (out['session']) console.log(`      └ 会话: @${out['session']}`);
      if (out['error']) console.log(`      └ ✗ ${String(out['error']).slice(0, 120)}`);
    }
    console.log(`  (时长明细见 events 流;token 台账见 prompt_usage.note='wf:${wf}')`);
  } else if (cmd === 'handoff') {
    // 转派（task-handoff）：agent 读懂内容发现不归自己时，按 domain 让渡。
    // 会话自动解析：优先 --session，其次 tmux 当前会话名（agent 在会话内调用）。
    const domain = pos(0);
    const reason = arg('reason');
    if (domain === '' || reason === '') {
      console.error('✗ 用法: juli handoff <domain> --reason "一句话理由" [--session S]');
      process.exit(1);
    }
    let session = arg('session');
    if (session === '') {
      const { execSync } = await import('node:child_process');
      try {
        // tmux 会话内 $TMUX 首段即本会话 server 的 socket（P2-9 已用一次性
        // 实验核实：自定义 socket 部署下不带 -S 的 display-message 也靠它
        // 自动定位同源 server）；显式 -S 与自动定位同源等价（最小防御）。
        // 不在 tmux 内（$TMUX 空）维持默认 socket 原行为。
        const sock = (process.env['TMUX'] ?? '').split(',')[0] ?? '';
        const dm = sock !== ''
          ? `tmux -S "${sock}" display-message -p '#S'`
          : `tmux display-message -p '#S'`;
        session = execSync(dm, { encoding: 'utf8' }).trim();
      } catch { /* 不在 tmux 里 */ }
    }
    if (session === '') {
      console.error('✗ 解析不出当前会话（不在 tmux 且未传 --session）——无法定位案卷');
      process.exit(1);
    }
    // 会话 → 案卷：最近一条停在该会话的 running 单（转派发生在理解/执行完成后）。
    // status=running 服务端过滤（NEW-2）：此前 limit=50 全单混排，长跑 running
    // 单会被新建单挤出窗口；running 子集内再按会话点查。
    const d = await call('GET', '/api/lifecycle/workflows?status=running&limit=200') as { workflows: { id: string; session: string; status: string; title: string }[] };
    const wf = d.workflows.find((x) => x.session === session && x.status === 'running');
    if (!wf) {
      console.error(`✗ 会话 ${session} 名下没有 running 的案卷——转派无主体`);
      process.exit(1);
    }
    const r = await call('POST', `/api/lifecycle/workflows/${wf.id}/handoff`, { domain, reason, by: `agent:${session}` }) as { from: string; to: string };
    console.log(`✓ 已转派: ${r.from} → ${r.to}（domain=${domain}）`);
    console.log(`  查看: ${BASE}/#/lifecycle?w=${wf.id}`);
  } else if (cmd === 'taskcheck') {
    const d = await call('GET', '/api/lifecycle/workflows?limit=200') as { workflows: { id: string; status: string; title: string; updatedAt?: string; createdAt: string }[] };
    const stale = d.workflows.filter((w) => w.status === 'failed');
    const running = d.workflows.filter((w) => w.status === 'running');
    console.log(`在途 ${running.length} · failed ${stale.length}`);
    for (const w of stale) console.log(`  ⚠ failed: ${w.id} ${w.title.slice(0, 40)} → juli 收口或重试`);
    for (const w of running) console.log(`  • 在途: ${w.id} ${w.title.slice(0, 40)}`);
    console.log(stale.length === 0 ? '✓ 无积压' : `✗ ${stale.length} 条需处置`);
  } else if (cmd === 'hook') {
    // 机器向子命令（CC hook 注册面，2026-10-10 统一 CLI 收编）：
    // juli hook <verb> <session> [status]——行为与 node dist/cli/hook.js 完全
    // 一致（同 runHook，服务不在静默 exit 0）。注册面切到数据卷 bin 后，
    // hook 存活性与 checkout 的 dist/ 清理彻底解耦。
    return dispatchHook(process.argv.slice(2));
  } else if (cmd === 'routing') {
    // 路由判定面（2026-09-22）：jev 分类+合并，现行规则链做基线并排投影。
    // 恒 dry-run——本分支构造上无派发路径（不 claim/dispatch/建单/落账），
    // 效果评估专用；引擎现行路由零改动。
    const sub = pos(0);
    let cfg: RoutingCfg;
    try {
      cfg = JSON.parse(readFileSync(`${homedir()}/.juli-service/config.json`, 'utf8'));
    } catch { cfg = {}; }
    const factsOfConfig = (): RoutingFacts => projectRoutingFacts(cfg);

    if (sub === 'rules') {
      const facts = factsOfConfig();
      console.log(`路由菜单 · 声明会话 ${facts.agents.length} · default_session=${facts.defaultSession}`);
      for (const a of facts.agents) {
        const extras = [a.senders.length > 0 ? `绑定=${a.senders.join(',')}` : '', a.cwd !== '' ? `cwd=${a.cwd}` : '']
          .filter(Boolean).join(' · ');
        console.log(`  ${a.session.padEnd(24)} ${a.company.padEnd(8)} domain=${a.domain || '—'}${extras !== '' ? ' · ' + extras : ''}`);
        if (a.description !== '') console.log(`      ${a.description}`);
      }
      const rules = facts.rules;
      if (rules.length > 0) {
        console.log('\nfeedback 前缀规则（现行引擎链）：');
        for (const r of rules) console.log(`  ${r.prefix === '' ? '(其余全部)' : r.prefix} → ${r.session}`);
      } else {
        console.log('\nfeedback 前缀规则：无（全部走渠道默认兜底）');
      }
      const dangling = danglingFeedbackRoutes(cfg as Parameters<typeof danglingFeedbackRoutes>[0]);
      if (dangling.length > 0) {
        console.log(`\n⚠ 悬空规则 ${dangling.length} 条（目标会话未声明，运行时被复用兜底静默改道）：`);
        for (const d of dangling) console.log(`  ${d.prefix} → ${d.session}`);
      }
      console.log('\n现行优先级链：explicit 钉死 → bound 发件人 → 前缀规则 → 渠道默认。');
      console.log('判定面：juli routing plan（jev 分类+合并，恒 dry-run）');
      return;
    }
    if (sub !== 'plan') {
      console.log(`juli routing
  plan [id...] [--queue N] [--status 新建] [--sample] [--no-jev] [--json]
                                    路由判定计划：jev 分类+合并判定，现行规则
                                    做基线并排对比。恒 dry-run——不派发/不建单/
                                    不落账，本命令无派发路径。
                                    id=feedback 记录 id；--queue 取镜像最近 N 条
                                    （默认 10，状态默认「新建」）；--sample 内置
                                    样例离线试跑；--no-jev 只看基线投影。
  rules                             路由菜单与现行规则（声明会话/前缀/兜底/悬空）`);
      return;
    }
    const asJson = process.argv.includes('--json');
    const useSample = process.argv.includes('--sample');
    const noJev = process.argv.includes('--no-jev');
    let records: typeof SAMPLE_RECORDS = SAMPLE_RECORDS;
    let facts: RoutingFacts;
    if (useSample) {
      records = SAMPLE_RECORDS;
      // 声明表与生产同源(引擎 config 投影);无声明/config 加载失败才落包内置样例表。
      facts = factsForPlan(cfg);
      if (facts === SAMPLE_FACTS && !asJson) console.error('· config 无 agents 声明——样例落包内置声明表(匿名化演示数据)');
    } else {
        console.error('✗ 公开版不带反馈镜像源——routing plan 用 --sample 离线试跑');
        process.exit(1);
      facts = factsOfConfig();
      // mesh 忙闲投影（目标会话干活中 → 组上标忙，供人看派发时机）。
      const g = await call('GET', '/api/agents/graph') as { nodes: { name: string; working: boolean; live: boolean }[] };
      facts = { ...facts, live: Object.fromEntries(g.nodes.map((n) => [n.name, { working: n.working, live: n.live }])) };
    }
    let judge = null;
    if (!noJev) {
      const token = jevTokenFromEnv();
      if (token === '') {
        console.error('✗ env 无 JEV_TOKEN（.zshrc 的 jev token）——jev 判定不可用；--no-jev 只看基线投影');
        process.exit(1);
      }
      judge = createJev({ token });
    }
    if (!asJson) console.error(`· 判定 ${records.length} 单 · jev=${judge === null ? '关（基线投影）' : judge.model} · 目标菜单 ${facts.agents.length} 会话 …`);
    const plan = await planRouting(records, facts, { judge });
    if (asJson) console.log(JSON.stringify(plan, null, 2));
    else renderPlan(plan);
    console.error('\n（dry-run：判定结果已出，未派发任何内容、未建单、未落账）');
    return;
  } else if (cmd === 'setup' || cmd === 'doctor') {
    // 开源 MVP（2026-10-10）：setup=检测/安装 tmux+Claude Code → 写入 ai 段 →
    // 端到端一句话往返自检；doctor=同一套自检的只读形态（不安装/不写配置/
    // 不起会话）。绿勾清单收尾，任一 ✗ 退出码 1（CI/脚本可判）。
    const setup = cmd === 'setup';
    const results: { name: string; ok: boolean | null; note: string }[] = [];
    const mark = (name: string, ok: boolean | null, note = ''): void => {
      results.push({ name, ok, note });
      console.log(`${ok === true ? '✓' : ok === false ? '✗' : '·'} ${name}${note !== '' ? ` — ${note}` : ''}`);
    };
    const sh = (c: string): { ok: boolean; out: string } => {
      try {
        return { ok: true, out: execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim() };
      } catch (e) {
        return { ok: false, out: e instanceof Error ? e.message.split('\n')[0]! : String(e) };
      }
    };
    const confirm = async (q: string): Promise<boolean> => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return (await rl.question(`${q} [y/N] `)).trim().toLowerCase() === 'y'; }
      finally { rl.close(); }
    };
    const ask = async (q: string): Promise<string> => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return (await rl.question(q)).trim(); }
      finally { rl.close(); }
    };

    console.log(`juli ${cmd}${setup ? '（可 --skip-e2e 跳过端到端、--api-key/--base-url/--model 免交互）' : '（只读自检）'}\n`);

    // [1] 运行基底
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    mark('Node ≥ 22', nodeMajor >= 22, process.versions.node);
    const tmuxV = sh('tmux -V');
    let tmuxOk = tmuxV.ok;
    if (!tmuxOk && setup) {
      const inst = process.platform === 'darwin' ? 'brew install tmux'
        : process.platform === 'linux' ? 'sudo apt-get update && sudo apt-get install -y tmux' : '';
      if (inst !== '' && (await confirm(`tmux 未安装（agent 执行基底）。现在安装？\n  $ ${inst}`))) {
        console.log(`  $ ${inst}`);
        sh(inst);
        tmuxOk = sh('tmux -V').ok;
      }
    }
    mark('tmux', tmuxOk, tmuxV.ok ? tmuxV.out : '未安装——agent 执行必需（macOS: brew install tmux / Debian: apt-get install tmux）');
    const claudeV = sh('claude --version');
    let claudeOk = claudeV.ok;
    if (!claudeOk && setup) {
      if (await confirm('Claude Code 未安装（agent 执行器）。现在安装？\n  $ npm install -g @anthropic-ai/claude-code')) {
        console.log('  $ npm install -g @anthropic-ai/claude-code');
        sh('npm install -g @anthropic-ai/claude-code');
        claudeOk = sh('claude --version').ok;
      }
    }
    mark('Claude Code', claudeOk, claudeV.ok ? claudeV.out.slice(0, 60) : '未安装——npm install -g @anthropic-ai/claude-code');

    // [2] 配置与统一 ai 段
    // 数据卷 env 解析（与 loadConfig 的 envOverrides 同源语义：JULI_* 优先，
    // MAKRO_* 迁移期兜底）——config 读写与 bin 落点吃同一解析，防 MAKRO_*
    // 存量用户的自检面与引擎实际注入面分裂。
    const dataDirEnv = (process.env['JULI_DATA_DIR'] && process.env['JULI_DATA_DIR'] !== ''
      ? process.env['JULI_DATA_DIR']
      : process.env['MAKRO_DATA_DIR']) ?? '';
    const cfgPath = configFilePath(homedir(), dataDirEnv);
    let cfgRaw: Record<string, unknown> = {};
    try { cfgRaw = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>; } catch { /* 缺省容忍 */ }
    mark('config.json', true, cfgPath);
    let aiNow = resolveAiConfig(configSchema.parse(cfgRaw), process.env);
    if (setup) {
      // 旗标/env 补齐（与 key 来源无关——env 只给 key、旗标给端点/模型是常态，
      // 此前 key 来自 env 时旗标被整段跳过，401 的常见根因）。
      const patch: Record<string, string> = {};
      const flagProvider = arg('provider') || process.env['JULI_AI_PROVIDER'] || '';
      const flagBaseUrl = arg('base-url') || process.env['JULI_AI_BASE_URL'] || '';
      const flagModel = arg('model') || process.env['JULI_AI_MODEL'] || '';
      if (flagProvider === 'anthropic' || flagProvider === 'openai') patch['provider'] = flagProvider;
      if (flagBaseUrl !== '') patch['base_url'] = flagBaseUrl;
      if (flagModel !== '') patch['model'] = flagModel;
      // key：旗标 > 交互输入（env 的 key 不落盘——容器/CI 形态由 env 供给）。
      let promptKey = '';
      if (aiNow.apiKey === '' && arg('api-key') === '' && !process.env['JULI_AI_API_KEY']) {
        console.log('\n— AI 配置（一处配置两处用：引擎 LLM + agent 执行环境）—');
        promptKey = await ask('API key（Anthropic 或兼容端点）: ');
        if (promptKey === '') mark('ai 段', false, '未提供 key（--api-key / 交互输入 / 引擎 Settings → AI）');
      }
      if (arg('api-key') !== '') patch['api_key'] = arg('api-key');
      else if (promptKey !== '') patch['api_key'] = promptKey;
      if (Object.keys(patch).length > 0) {
        const r = saveConfigFile({ home: homedir(), dataDir: dataDirEnv === '' ? undefined : dataDirEnv }, { ai: patch });
        if (r.ok) {
          mark('ai 段写入', true, `${cfgPath}（${Object.keys(patch).join('+')}）`);
          cfgRaw = { ...cfgRaw, ai: { ...((cfgRaw['ai'] as Record<string, unknown>) ?? {}), ...patch } };
          aiNow = resolveAiConfig(configSchema.parse(cfgRaw), process.env);
        } else {
          mark('ai 段写入', false, r.error);
        }
      }
      mark('ai 段（现行生效）', aiNow.apiKey !== '', aiNow.apiKey !== ''
        ? `provider=${aiNow.provider}${aiNow.model !== '' ? ` · model=${aiNow.model}` : ''}${aiNow.baseUrl !== '' ? ' · base_url=已设' : ' · base_url=未设（官方 Anthropic）'}`
        : '未配置 API key——Settings → AI 或 juli setup --api-key');
    } else {
      mark('ai 段', aiNow.apiKey !== '', aiNow.apiKey !== ''
        ? `provider=${aiNow.provider}${aiNow.model !== '' ? ` · model=${aiNow.model}` : ''}${aiNow.baseUrl !== '' ? ' · base_url=已设' : ''}`
        : '未配置 API key——Settings → AI 或 juli setup --api-key');
    }

    // 首启播种（开源 MVP）：无 agents 声明时补 main 会话 + default_session——
    // 零配置 chat 起单的落点（路由菜单/兜底链都吃声明表，没有它确认开单无处落）。
    if (setup) {
      const hasAgents = Array.isArray(cfgRaw['agents']) && (cfgRaw['agents'] as unknown[]).length > 0;
      const email = (cfgRaw['email'] ?? {}) as { default_session?: string };
      const needAgents = !hasAgents;
      const needDefault = email['default_session'] === undefined || email['default_session'] === '';
      if (needAgents || needDefault) {
        const seed: Record<string, unknown> = {};
        if (needAgents) seed['agents'] = [{
          session: 'main', company: '', domain: '', senders: [], cwd: '',
          description: 'Default agent session (seeded by juli setup)', model_tier: 'standard',
        }];
        if (needDefault) seed['email'] = { ...email, default_session: 'main' };
        // claude_dir 播种（2026-10-10 e2e 实锤）：不设则引擎跳过 CC hooks 注入
        // ——agent 完成后 Stop 事件无人上报，单子只能等 zombie 超时兜底。
        if (cfgRaw['claude_dir'] === undefined || cfgRaw['claude_dir'] === '') {
          seed['claude_dir'] = join(homedir(), '.claude');
        }
        const r2 = saveConfigFile({ home: homedir(), dataDir: dataDirEnv === '' ? undefined : dataDirEnv }, seed);
        if (r2.ok) {
          mark('agents 播种', true, needAgents ? 'main 会话 + default_session=main' : 'default_session=main');
          cfgRaw = { ...cfgRaw, ...seed };
        } else {
          mark('agents 播种', false, r2.error);
        }
      }
    }

    // [2.5] juli bin 自装/校验（2026-10-10 统一 CLI）：bundle 安装到
    // <data_dir>/bin/juli 数据卷稳定路径——CC hook 注册面指向它后，hook
    // 存活性与 checkout 的 dist/ 清理解耦（昨天 dist 被清 hook 全灭的事故
    // 形态断根）。data_dir 与 config 同源（env JULI_DATA_DIR > MAKRO_DATA_DIR
    // > config 段 > 默认 ~/.juli-service；容器 /data → /data/bin/juli）。setup
    // 安装/刷新（幂等：已存在且内容一致跳过），doctor 只校验。
    const dataDir = (dataDirEnv !== ''
      ? dataDirEnv
      : (configSchema.parse(cfgRaw).data_dir || defaultDataDir(homedir()))).replace(/\/+$/, '');
    const binPath = join(dataDir, 'bin', 'juli');
    // bundle 来源探测（setup/doctor 共用）：仓内形态（tsx cli/juli.ts 或 node
    // dist-cli/juli.js）→ repo 根（bundle=dist-cli/juli.js）；数据卷 bin 自跑
    // 形态 → 自身即 bundle。repoRoot 判不出且数据卷 bin 缺席的部署形态（如
    // 公开投影不带构建脚本）＝ bundle 不可得——bin 两项降级信息态（null，
    // 不计失败）：hooks 由引擎回退 dist/cli/hook.js（npm run build 产出，
    // 公开仓真实存在）。提示语不指向公开仓不存在的 npm run build:cli。
    const selfPath = fileURLToPath(import.meta.url);
    const selfDir = dirname(selfPath);
    const selfBase = selfPath.slice(selfDir.length + 1);
    const repoRoot = (selfBase === 'juli.ts' && selfDir.endsWith('/cli')) || (selfBase === 'juli.js' && selfDir.endsWith('/dist-cli'))
      ? dirname(selfDir) : null;
    const bundleUnavailable = (): boolean => repoRoot !== null && !existsSync(join(repoRoot, 'dist-cli', 'juli.js'));
    const binFallbackNote = 'bin 自装不可用——CC hooks 将回退 dist/cli/hook.js（npm run build 产出），不算失败';
    if (setup) {
      let bundleSrc: string | null = null;
      if (repoRoot !== null) {
        const candidate = join(repoRoot, 'dist-cli', 'juli.js');
        if (!existsSync(candidate)) {
          try {
            execSync('npm run build:cli', { cwd: repoRoot, encoding: 'utf8', stdio: 'ignore', timeout: 120_000 });
          } catch { /* 缺 devDeps/缺脚本等构建失败 → bundleUnavailable，下方 mark 信息态 */ }
        }
        if (existsSync(candidate)) bundleSrc = candidate;
      } else if (existsSync(binPath)) {
        bundleSrc = binPath; // 数据卷 bin 自跑：源即自身
      }
      const sameContent = (): boolean => {
        try { return readFileSync(binPath, 'utf8') === readFileSync(bundleSrc!, 'utf8'); } catch { return false; }
      };
      if (bundleSrc === null) {
        mark('juli bin 自装', null, binFallbackNote);
      } else if (bundleSrc === binPath) {
        mark('juli bin 自装', true, `${binPath}（当前即数据卷 bin 自跑）`);
      } else if (sameContent()) {
        mark('juli bin 自装', true, `${binPath} 已是最新（内容一致，跳过）`);
      } else {
        try {
          mkdirSync(dirname(binPath), { recursive: true });
          // 原子替换（tmp + 同目录 rename）：hook 模板 `node <bin> <verb>` 直打
          // 本文件，原地覆盖写存在半截文件瞬间——在飞 hook 读到即 SyntaxError
          // 丢事件；rename 原子生效无中间态。
          // tmp 名带 pid：并发双跑 setup 各写各的 tmp——固定名两进程交错写
          // 可把损坏内容 rename 转正为 bin（在飞 hook 读坏文件）。
          const tmpBin = `${binPath}.${process.pid}.tmp`;
          copyFileSync(bundleSrc, tmpBin);
          chmodSync(tmpBin, 0o755);
          renameSync(tmpBin, binPath);
          mark('juli bin 自装', true, `${binPath}（CC hook 注册的稳定路径，与 checkout 解耦）`);
        } catch (e) {
          mark('juli bin 自装', false, `写入失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    // 校验项（setup/doctor 共用）：bin 在位且可执行；bundle 不可得的部署形态
    // （公开投影等）降级信息态，不令 setup/doctor 恒红。现场重判（setup 可能
    // 刚把 dist-cli 建出来）——bundle 在位而 bin 仍缺席 = 真失败（跑 setup）。
    let binState: boolean | null = false;
    let binNote = `${binPath} 不存在或不可执行——juli setup 安装`;
    try {
      accessSync(binPath, constants.X_OK);
      binState = true;
      binNote = binPath;
    } catch {
      if (bundleUnavailable()) {
        binState = null;
        binNote = binFallbackNote;
      }
    }
    mark('juli bin', binState, binNote);
    // CC hooks 注册面（只报告，绝不改写——写面归引擎 installClaudeHooks）：
    // 命令应指向数据卷 bin；仍指 checkout 内 dist/cli/hook.js = dist 清理
    // 即灭。不一致只提示，引擎重启后自动重注册。
    const claudeDir = configSchema.parse(cfgRaw).claude_dir || join(homedir(), '.claude');
    type HookSettingsShape = { hooks?: Record<string, { hooks?: { command?: string }[] }[]> };
    let hookSettings: HookSettingsShape | null = null;
    try {
      hookSettings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')) as HookSettingsShape;
    } catch { /* 无文件/坏 JSON → 按未注册报告 */ }
    if (hookSettings === null) {
      mark('CC hooks 注册', null, `${join(claudeDir, 'settings.json')} 未读到位（引擎注入后再查）`);
    } else {
      const cmds = Object.values(hookSettings.hooks ?? {}).flat().flatMap((g) => g?.hooks ?? []).map((h) => h.command ?? '');
      const toBin = cmds.filter((c) => c.includes(binPath));
      const stale = cmds.filter((c) => c.includes('cli/hook.js') && !c.includes(binPath));
      if (toBin.length > 0) mark('CC hooks 注册', true, `${toBin.length} 条指向数据卷 bin`);
      else if (stale.length > 0) mark('CC hooks 注册', null, `${stale.length} 条仍指 checkout 内 dist/cli/hook.js（dist 清理即灭）——引擎重启后自动重注册`);
      else mark('CC hooks 注册', null, '未见 juli hook 命令（引擎注入后再查）');
    }

    // [3] LLM 连通（直打一次最小 completion；不落账不写盘）
    if (aiNow.apiKey !== '') {
      const port = aiNow.provider === 'openai'
        ? createOpenAiChat({ apiKey: aiNow.apiKey, baseUrl: aiNow.baseUrl, model: aiNow.model })
        : createAnthropicChat({ apiKey: aiNow.apiKey, baseUrl: aiNow.baseUrl, model: aiNow.model });
      const t0 = Date.now();
      const r = await port.chat({
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        maxTokens: 32,
        signal: AbortSignal.timeout(20_000),
      });
      mark('LLM 连通', r.ok ? true : false, r.ok
        ? `${Date.now() - t0}ms${aiNow.model !== '' ? ` · ${aiNow.model}` : ''}`
        : r.error.message.slice(0, 140));
    }

    // [4] 引擎可达（信息项——引擎可后起，不算失败）
    const health = await fetch(`${BASE}/healthz`).then((r) => r.ok).catch(() => false);
    mark('引擎服务', health ? true : null, health ? `${BASE} 在跑` : `${BASE} 未达（引擎另起，不算失败）`);

    // [5] 端到端一句话往返（setup 且基底齐备才跑；--skip-e2e 跳过）
    if (setup && aiNow.apiKey !== '' && tmuxOk && claudeOk && !process.argv.includes('--skip-e2e')) {
      console.log('\n— 端到端自检（tmux 起 claude 会话，一句话往返）—');
      const socketCfg = readSocketCfg();
      const tmux = createTmuxClient(socketCfg ? { socketPath: socketCfg } : {});
      const name = 'juli-setup-check';
      // 与引擎同源的执行环境注入（双通道 API_KEY+AUTH_TOKEN：AUTH_TOKEN 无
      // 「自定义 key」批准对话框，官方与兼容端都吃 Bearer）。进程 env（本 CLI
      // 首建 server 时继承）+ tmux 全局环境（server 已在跑时对新会话生效）。
      const pairs: readonly (readonly [string, string])[] = aiNow.baseUrl !== ''
        ? [['ANTHROPIC_API_KEY', aiNow.apiKey], ['ANTHROPIC_AUTH_TOKEN', aiNow.apiKey], ['ANTHROPIC_BASE_URL', aiNow.baseUrl]]
        : [['ANTHROPIC_API_KEY', aiNow.apiKey], ['ANTHROPIC_AUTH_TOKEN', aiNow.apiKey]];
      for (const [k, v] of pairs) {
        process.env[k] = v;
        await tmux.exec(['set-environment', '-g', k, v]);
      }
      await tmux.exec(['kill-session', '-t', name]);
      const provision = createProvisioningDispatch({
        tmux,
        bootCommand: 'claude',
        cwdFor: () => undefined,
        log: (m) => console.log(`    · ${m}`),
      });
      const t0 = Date.now();
      const pr = await provision('cli-setup', name, '');
      if (!pr.ok) {
        mark('agent 会话就绪', false, pr.error.message);
      } else {
        mark('agent 会话就绪', true, `${((Date.now() - t0) / 1000).toFixed(1)}s（claude REPL 在位）`);
        const send = await tmux.sendTextConfirmed(name, 'Reply with exactly: OK');
        if (!send.ok) {
          mark('一句话往返', false, send.error.message);
        } else {
          let got = false;
          const deadline = Date.now() + 180_000;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 3000));
            const cap = await tmux.capturePane(name, 80);
            if (cap.ok && /(^|\W)OK(\W|$)/.test(cap.value)) { got = true; break; }
          }
          mark('一句话往返', got, got
            ? `${((Date.now() - t0) / 1000).toFixed(1)}s 收到回复（tmux→claude→ANTHROPIC_* 注入全链通）`
            : '180s 内未见回复（查 claude 登态/端点/base_url——juli doctor 复诊）');
        }
      }
      await tmux.exec(['kill-session', '-t', name]);
    }

    const fails = results.filter((r) => r.ok === false);
    const oks = results.filter((r) => r.ok === true).length;
    console.log(`\n${cmd} 完成：${oks} ✓ · ${fails.length} ✗ · ${results.length - oks - fails.length} 信息项`);
    if (fails.length > 0) {
      for (const f of fails) console.log(`  ✗ ${f.name}${f.note !== '' ? ` — ${f.note}` : ''}`);
      process.exit(1);
    }
    return;
  } else {
    console.log(`juli CLI
  start --title T [--input JSON] [--relates-to WF]
                                    免模板起单(动态模型标准入口)
  start <template> [--title] [--input JSON]
        [--relates-to WF] [--steps]     配方起流(可重复阶梯)
  show <wf>                          查看任务与草稿
  claim <wf> --session S             派发/改派到某会话
  whisper <wf> --text "..."          插话纠偏(不中断)
  approve <gate-id> [--note] [--at 09:00|ISO]
                                      批准;--at 定时发(到点自动发出)
  rework <gate-id> --feedback "..."  驳回回修(轮次+1)
  align <gate-id> --amendment "..."  对齐修正(人定稿版注入下游,优先级最高)
  deliver <wf> --evidence E           答复草稿节点(GLM 按 juli-reply)
  review <wf> [title]                 审阅闸门节点
  send <wf>                           发送节点(需已批准审阅)
  settle <wf>                         结算落账
  audit <wf>                          单 run 审计单
  retry <step-id> [--plan/--session]  重试(可带干预补丁)
  amend <step-id> key=value ...       补料(缺 input 冻死/守卫拒发时的修正窗口;
                                      无参 + --workflow <wf> 查候选值)
  handoff <domain> --reason "…"      转派(mesh 查表,非绑定会话;agent 自助)
  compact <agent>                    CC 压缩 context(就地 /compact,测试友好)
  clear <agent>                      CC 清空 context(/clear,workflow 边界重置)
  rework-send <send-step-id> [--feedback "…"]
                                      发送守卫拒发的打回补正(agent 重做,重新过闸)
  taskcheck                          对账扫描
  setup [--api-key K] [--base-url U] [--model M] [--provider P] [--skip-e2e]
                                      开源 MVP 装配：tmux+Claude Code 检测/安装
                                      → ai 段写入 → LLM 连通 → 端到端一句话往返
  doctor                             同套自检只读形态（不安装/不写盘/不起会话）
  routing plan [id...|--queue|--sample] [--no-jev] [--json]
                                      路由判定计划（jev 分类+合并，恒 dry-run）
  routing rules                      路由菜单与现行规则/悬空规则
  (internal) hook <verb> <session> [status]
                                      CC hook 转发(机器向,与 dist/cli/hook.js 同逻辑)`);
  }
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
