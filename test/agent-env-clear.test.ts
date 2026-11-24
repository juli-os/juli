// agent 执行环境里 ANTHROPIC_BASE_URL 的去向（2026-11-23 全量审查修复）。
// 接口地址在设置页清空后，此前只有「不赋值」这一个动作：
//   · 进程环境里的旧地址原样留着——之后首建的 tmux server、引擎自动拉起的
//     herdr server 从引擎环境继承到的还是旧地址，接口却回「已生效」；
//   · 终端侧只增不删（@juli-os/baton 的 applyEnv 只有「设置」这一个动作：tmux
//     走 set-environment -g，herdr 客户端内存里的 tab 环境只合并不删除），
//     引擎之后拉起的 agent 从 pane 的 shell 环境继承到的还是旧地址。
// 现在：注入过又清空 → 进程环境删掉这个变量；引擎拉起 agent 的启动命令前置
// unset，新起的 agent 进程拿不到旧地址。没注入过就不动——操作员自己设的
// ANTHROPIC_BASE_URL 不归这里管。

import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, saveConfigFile } from '../src/platform/config/schema.ts';
import { createRuntime, type Runtime } from '../src/runtime.ts';
import type { Logger } from '../src/platform/events/bus.ts';
import type { JsonRecord } from '../src/platform/shared/json.ts';
import type { TmuxClient } from '@juli-os/agents';
import { err, ok } from '../src/platform/shared/result.ts';

const captureLogger = (): { lines: string[]; logger: Logger } => {
  const lines: string[] = [];
  return { lines, logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) } };
};

/** 只为看「引擎拉起 agent 时敲进 pane 的启动命令」：会话不存在、pane 是裸
 *  shell（前台 zsh）→ 引擎发启动命令 → 假件记下后回一个错误，预热当场收场
 *  （不进就绪轮询，测试不等真实时间）。 */
const bootCapture = (): { tmux: TmuxClient; sent: string[] } => {
  const sent: string[] = [];
  const tmux = {
    socketPath: '/tmp/juli-agent-env-test.sock',
    async hasSession() { return false; },
    async newSession() { return ok(undefined); },
    async foregroundCommandOf() { return 'zsh'; },
    async sendText(_name: string, text: string) { sent.push(text); return err(new Error('测试到此为止：只看启动命令')); },
    async sendKey() { return ok(undefined); },
    async panePathOf() { return ''; },
    async sessionBirthsOf() { return new Map(); },
    async setEnv() { return ok(undefined); },
    async listSessions() { return []; },
    async listSessionsDetailed() { return ok([]); },
    async sendTextConfirmed() { return ok({ enters: 0, repasted: false, elapsedMs: 0 }); },
    async sendTextQueued() { return ok({ enters: 0, repasted: false, elapsedMs: 0, finalState: 'cleared' as const }); },
    async capturePane() { return ok(''); },
    async killSession() { return ok(undefined); },
    async interrupt() { return ok(undefined); },
  } as unknown as TmuxClient;
  return { tmux, sent };
};

const until = async (pred: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('until timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('ANTHROPIC_BASE_URL 清空后的去向', () => {
  // env 清场：热注入读 JULI_AI_*（key / 地址的覆盖源），断言又要看
  // ANTHROPIC_* 三个变量——开发者本机设了这些键时断言会漂。恢复在 afterAll。
  const envKeys = [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'JULI_AI_API_KEY', 'JULI_LLM_API_KEY', 'MAKRO_LLM_API_KEY', 'JULI_AI_BASE_URL', 'JULI_AI_MODEL',
    'JULI_DATA_DIR', 'MAKRO_DATA_DIR',
  ];
  const savedEnv = new Map(envKeys.map((k) => [k, process.env[k]]));
  const dirs: string[] = [];
  beforeAll(() => {
    for (const k of envKeys) delete process.env[k];
  });
  afterAll(() => {
    savedEnv.forEach((v, k) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const tmp = (label: string): string => {
    const d = mkdtempSync(join(tmpdir(), `juli-agent-env-${label}-`));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete process.env[k];
  });

  /** 照 HTTP 路由的次序走：先落盘，再热改（PUT /api/settings 就是这两步）。
   *  引擎平时是从盘上的 config.json 启动的；createRuntime 直接吃配置对象、不读
   *  盘，所以这里先把启动配置写成文件，之后每次保存都写同一个文件。
   *  热改的生效值以盘上为准（R2 复审 P1-A）——绕过落盘直接调 applySettings
   *  的用例测不到「上一次保存的值」。 */
  const booted = (boot: JsonRecord): { rt: Runtime; save: (patch: JsonRecord) => void } => {
    const home = mkdtempSync(join(tmpdir(), 'juli-agent-env-home-'));
    dirs.push(home);
    const seeded = saveConfigFile({ home }, boot);
    expect(seeded.ok, seeded.ok ? '' : seeded.error).toBe(true);
    const rt = createRuntime(configSchema.parse({ ...boot, data_dir: tmp('data') }), { home });
    const save = (patch: JsonRecord): void => {
      const r = saveConfigFile({ home }, patch);
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      rt.applySettings(patch);
    };
    return { rt, save };
  };
  const baseUrlInEnv = (): string | undefined => process.env['ANTHROPIC_BASE_URL'];

  it('注入过又清空：进程环境里的变量被删掉', () => {
    const { save } = booted({ ai: { api_key: 'sk-agent-env' } });
    save({ ai: { base_url: 'https://old.example' } });
    expect(baseUrlInEnv()).toBe('https://old.example');
    save({ ai: { base_url: '' } });
    expect(baseUrlInEnv()).toBeUndefined();
  });

  it('清空之后设置读取接口不再报旧地址（R1 复审 P3-④）', () => {
    const { rt, save } = booted({ ai: { api_key: 'sk-agent-env', base_url: 'https://old.example' } });
    // GET /api/settings = 冻结的启动配置盖上一层热改值（liveOverrides）。
    // 清空前：热改值里没有 ai.base_url，读出来是启动时的旧地址（本来就该显示它）。
    expect((rt.liveOverrides()['ai'] as Record<string, unknown> | undefined)?.['base_url']).toBeUndefined();
    save({ ai: { base_url: '' } });
    // 清空后必须带一个空串去盖——不带的话读取接口继续报旧地址，人以为没清掉。
    // （model 也是空串：2026-11-24 起清空的模型同样带空串去盖，R3 复审 P3-4。）
    expect(rt.liveOverrides()['ai']).toEqual({ provider: 'anthropic', base_url: '', model: '' });
  });

  it('只填了旧散键的部署（线上就是这种）：改 llm_base_url 同样热生效，清空同样删掉变量', () => {
    const { rt, save } = booted({
      llm_provider: 'openai', llm_model: 'some-model', llm_base_url: 'https://legacy.example',
      secrets: { llm_api_key: 'sk-legacy' },
    });
    save({ llm_base_url: 'https://old.example' });
    expect(baseUrlInEnv()).toBe('https://old.example');
    save({ llm_base_url: '' });
    expect(baseUrlInEnv()).toBeUndefined();
    expect(rt.liveOverrides()['ai']).toEqual({ provider: 'openai', base_url: '', model: 'some-model' });
    // 设置页上旧散键那一栏也跟着变（R2 复审 P3-G）。
    expect(rt.liveOverrides()['llm_base_url']).toBe('');
  });

  it('没注入过就不动：启动时没配地址，操作员自己设的 ANTHROPIC_BASE_URL 原样保留', () => {
    process.env['ANTHROPIC_BASE_URL'] = 'https://from-operator.example';
    const { save } = booted({ ai: { api_key: 'sk-agent-env' } });
    save({ ai: { model: 'some-model' } }); // 地址一直是空的
    expect(baseUrlInEnv()).toBe('https://from-operator.example');
  });

  // R2 复审 P1-A：热改的生效值此前用「启动时的配置 + 本次补丁」算，不读盘。
  // 连续保存两次（先存地址、再只存模型），后一次算出来的地址是启动时的值——
  // 前一次热改的地址被删掉，或者回到启动时的旧地址。盘上是对的，新拉起的
  // agent 带错地址或没有地址。
  describe('连续保存：后一次保存不能冲掉前一次热改的地址（R2 复审 P1-A）', () => {
    it('启动时没配地址：先存地址、再只存模型', () => {
      const { save } = booted({ ai: { api_key: 'sk-agent-env' } });
      save({ ai: { base_url: 'https://first.example' } });
      save({ ai: { model: 'some-model' } });
      expect(baseUrlInEnv()).toBe('https://first.example');
    });

    it('启动时 ai 段有旧地址：改了地址再只存模型，不能回到启动时的旧地址', () => {
      const { save } = booted({ ai: { api_key: 'sk-agent-env', base_url: 'https://boot.example' } });
      save({ ai: { base_url: 'https://first.example' } });
      save({ ai: { model: 'some-model' } });
      expect(baseUrlInEnv()).toBe('https://first.example');
    });

    it('只填旧散键的部署：ai 段存过地址后只存模型，不能回到旧散键的地址', () => {
      const { save } = booted({
        llm_provider: 'openai', llm_model: 'some-model', llm_base_url: 'https://legacy.example',
        secrets: { llm_api_key: 'sk-legacy' },
      });
      save({ ai: { base_url: 'https://first.example' } });
      save({ ai: { model: 'some-model-2' } });
      expect(baseUrlInEnv()).toBe('https://first.example');
    });

    it('只填旧散键的部署：先改旧散键的地址、再只改旧散键的模型', () => {
      const { rt, save } = booted({
        llm_provider: 'openai', llm_model: 'some-model', llm_base_url: 'https://legacy.example',
        secrets: { llm_api_key: 'sk-legacy' },
      });
      save({ llm_base_url: 'https://new.example' });
      save({ llm_model: 'some-model-2' });
      expect(baseUrlInEnv()).toBe('https://new.example');
      expect(rt.liveOverrides()['llm_model']).toBe('some-model-2');
    });

    it('清空之后再只存模型：仍然是清空', () => {
      const { save } = booted({ ai: { api_key: 'sk-agent-env', base_url: 'https://boot.example' } });
      save({ ai: { base_url: '' } });
      save({ ai: { model: 'some-model' } });
      expect(baseUrlInEnv()).toBeUndefined();
    });

    it('清空模型之后，设置读取接口不再报上一次的模型（R3 复审 P3-4）', () => {
      const { rt, save } = booted({ ai: { api_key: 'sk-agent-env', model: 'boot-model' } });
      save({ ai: { model: 'saved-model' } });
      expect(rt.liveOverrides()['ai']).toEqual({ provider: 'anthropic', base_url: '', model: 'saved-model' });
      save({ ai: { model: '' } });
      expect(rt.liveOverrides()['ai']).toEqual({ provider: 'anthropic', base_url: '', model: '' });
    });
  });

  /** 起一个带预热声明的运行时：start() 会在后台按声明逐个 provision。 */
  const startWithWarmup = (
    backend: 'tmux' | 'herdr', dataDir: string, log: Logger, tmux: TmuxClient,
  ): { rt: Runtime; save: (patch: JsonRecord) => void } => {
    const home = join(dataDir, 'home');
    const boot = {
      agent_backend: backend,
      // tmux 后端的名单源会 spawn 真 tmux：指到 tmpdir 的死 socket（hooks.test 同款）。
      tmux_socket_path: join(dataDir, 'tmux.sock'),
      ai: { api_key: 'sk-agent-env', base_url: 'https://old.example' },
      agents: [{ session: 'main' }],
      // 死 socket 上没有这个会话：预热走「新建 + 拉起」那条路。
    };
    const seeded = saveConfigFile({ home }, boot);
    expect(seeded.ok, seeded.ok ? '' : seeded.error).toBe(true);
    const rt = createRuntime(configSchema.parse({ ...boot, data_dir: dataDir }), { home, tmux }, log);
    const save = (patch: JsonRecord): void => {
      const r = saveConfigFile({ home }, patch);
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      rt.applySettings(patch);
    };
    rt.start();
    return { rt, save };
  };

  it('清空之后引擎拉起 agent：启动命令前置 unset ANTHROPIC_BASE_URL（tmux / herdr 两种后端）', async () => {
    for (const backend of ['tmux', 'herdr'] as const) {
      const dataDir = tmp(`boot-${backend}`);
      const { lines, logger } = captureLogger();
      const { tmux, sent } = bootCapture();
      const { rt, save } = startWithWarmup(backend, dataDir, logger, tmux);
      try {
        // start() 同步返回时预热停在第一个 await 上——这时清空地址，预热
        // 走到「拉起 agent」那一步看到的才是清空后的状态。
        expect(process.env['ANTHROPIC_BASE_URL']).toBe('https://old.example');
        save({ ai: { base_url: '' } });
        await until(() => lines.some((l) => l.includes('声明会话预热完成')));
        expect(sent).toHaveLength(1);
        // 前缀在后端包装的外层：herdr 的包装以 `JULI_HERDR_SESSION='…' claude`
        // 收尾，那个赋值得留给 claude。
        expect(sent[0]!.startsWith('unset ANTHROPIC_BASE_URL; ')).toBe(true);
        if (backend === 'tmux') expect(sent[0]).toBe('unset ANTHROPIC_BASE_URL; claude');
        else expect(sent[0]).toContain("JULI_HERDR_SESSION='main' claude");
        // herdr 的环境文件每次注入都整份重写（包内行为）：清空后文件里没有它。
        const envFile = join(dataDir, 'agent-env.sh');
        if (backend === 'herdr' && existsSync(envFile)) {
          expect(readFileSync(envFile, 'utf8')).not.toContain('ANTHROPIC_BASE_URL');
        }
      } finally {
        rt.stop();
      }
    }
  });

  it('没清空过：启动命令不带 unset（原样）', async () => {
    const dataDir = tmp('boot-keep');
    const { lines, logger } = captureLogger();
    const { tmux, sent } = bootCapture();
    const { rt } = startWithWarmup('tmux', dataDir, logger, tmux);
    try {
      await until(() => lines.some((l) => l.includes('声明会话预热完成')));
      expect(sent).toEqual(['claude']);
    } finally {
      rt.stop();
    }
  });
});
