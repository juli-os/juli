// 通话挂断（P0，2026-10-27）：voiceState.call 有进无出——开通话后
// /api/chat 的 turn/confirm/deny 永久 409 直到进程重启。本文件锁两件事：
// 1) 路由契约：开通话 → intake 409 围栏 → 挂断 → turn 放行；挂断幂等
//    （无在途通话也 ok）。voice 三件套走真 createVoiceCall + runtime 同款
//    最小镜像（open 置 call / close 置 null），守卫语义与 chat.ts 现网一致。
// 2) 真组合根：closeVoiceCall 生命周期（开→非空，挂→置空，空态挂断无害）。

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ok } from '../src/platform/shared/result.ts';
import { createVoiceCall, type CallMode, type ChatLlmPort } from '@juli-os/agents';
import { createChatIntake } from '../src/business/intake/chatIntake.ts';
import { registerChatRoutes } from '../src/http/routes/chat.ts';
import type { AppEnv } from '../src/http/helpers.ts';
import { createRuntime, type Runtime, type RuntimeSeams } from '../src/runtime.ts';
import { configSchema } from '../src/platform/config/schema.ts';

const fakeLlm = (): ChatLlmPort => ({
  name: 'fake',
  async chat() {
    return ok({ content: '好的', toolCalls: [] });
  },
});

// ---- 路由契约 ---------------------------------------------------------------------

describe('HTTP /api/chat/call 挂断', () => {
  const makeApp = (intake: unknown): { app: Hono<AppEnv>; rt: Runtime } => {
    const voiceState: { call: ReturnType<typeof createVoiceCall> | null } = { call: null };
    const llm = fakeLlm();
    const rt = {
      chatIntake: intake,
      chatIntakeFor: (_conv: string) => intake,
      emitChat: () => undefined,
      usage: { stats: () => ({}), timeline: () => [] },
      config: { data_dir: join(tmpdir(), 'juli-voice-hangup-fake') },
      get voiceCall() { return voiceState.call; },
      openVoiceCall: (mode: CallMode) => {
        voiceState.call = createVoiceCall(mode, {
          llm, model: 'fake',
          dispatch: async () => ok(undefined),
        });
        return voiceState.call;
      },
      closeVoiceCall: () => { voiceState.call = null; },
    } as unknown as Runtime;
    const app = new Hono<AppEnv>();
    registerChatRoutes(app, rt);
    return { app, rt };
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试 JSON 探针：与 chat-intake.test.ts 同款（data=JSON.parse 动态形态）。
  const j = async (app: Hono<AppEnv>, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  it('开通话→intake turn/confirm/deny 409→挂断→turn 放行；挂断幂等', async () => {
    const intake = createChatIntake({
      llm: fakeLlm(), model: 'fake', tools: [],
      startTask: async () => ok({ id: 'wf_voice_1' }),
    });
    const { app, rt } = makeApp(intake);

    // 开通话：200 + mode 回传；voiceCall 在位。
    const open = await j(app, 'POST', '/api/chat/call', { mode: 'plan' });
    expect(open.status).toBe(200);
    expect(open.data).toEqual({ ok: true, mode: 'plan' });
    expect(rt.voiceCall).not.toBeNull();

    // 通话占用围栏（修复前的永久死锁面）：intake 三口一律 409。
    expect((await j(app, 'POST', '/api/chat/intake/turn', { input: '出材料' })).status).toBe(409);
    expect((await j(app, 'POST', '/api/chat/intake/confirm')).status).toBe(409);
    expect((await j(app, 'POST', '/api/chat/intake/deny')).status).toBe(409);

    // 挂断：200 ok；voiceCall 置空（有出径了）。
    const hangup = await j(app, 'POST', '/api/chat/call/hangup');
    expect(hangup.status).toBe(200);
    expect(hangup.data).toEqual({ ok: true });
    expect(rt.voiceCall).toBeNull();

    // turn 不再 409：围栏解除，真 intake 回 200 带 reply。
    const turn = await j(app, 'POST', '/api/chat/intake/turn', { input: '出材料' });
    expect(turn.status).toBe(200);
    expect(turn.data.reply).toBe('好的');

    // 幂等：无在途通话再挂一次也 ok（webapp 挂断 fire-and-forget 依赖此口径）。
    const again = await j(app, 'POST', '/api/chat/call/hangup');
    expect(again.status).toBe(200);
    expect(again.data).toEqual({ ok: true });
  });
});

// ---- 真组合根 ---------------------------------------------------------------------

describe('runtime closeVoiceCall', () => {
  it('开→非空；挂→置空；空态挂断无害（幂等）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'juli-voice-rt-'));
    // seams.llm 让 orchestrator 在位（openVoiceCall 前置）；不开 turn 不触网。
    const seams: RuntimeSeams = {
      llm: { async complete() { return ok({ text: 'ok' }); } },
    };
    let rt: Runtime | null = null;
    try {
      rt = createRuntime(configSchema.parse({ data_dir: dir }), seams);
      expect(rt.voiceCall).toBeNull();
      expect(rt.openVoiceCall('plan')).not.toBeNull();
      expect(rt.voiceCall).not.toBeNull();
      rt.closeVoiceCall();
      expect(rt.voiceCall).toBeNull();
      expect(() => rt!.closeVoiceCall()).not.toThrow(); // 幂等：空态 no-op
    } finally {
      rt?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
