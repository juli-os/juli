// voicechat R1-FX 修复围栏（2026-10-21）：chat 帧流/语音通话批 10 条修复的
// 防回退。chat.ts 与 voice-* 是 DOM/浏览器面模块（仓库无 jsdom/happy-dom，
// 新增依赖属禁区，且禁止为可测而重构视图抽逻辑）——按仓库既有惯例走文本级
// contain 断言（web-shell.test / voice-call.test 同手法），按块截取钉住修复
// 语义关键行在位；行为级证据见各源文件注释与 PROBLEMS.md 对应条目。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string): string => readFileSync(resolve(import.meta.dirname, rel), 'utf8');
const chatSrc = read('../web/src/views/chat.ts');
const callSrc = read('../web/src/voice-call.ts');
const inputSrc = read('../web/src/voice-input.ts');
const sessionSrc = read('../web/src/voice-session.ts');
const css = read('../web/src/style.css');
// b44 R1 P1：upwork 断言迁出（cli/upwork.ts 被投影 exclude，公仓无此文件）——
// P2#7 围栏随迁至 test/upwork-callback.test.ts（manifest exclude，私仓照常跑），
// 本文件不再读任何被 exclude 路径，其余 voice 断言继续随投影走公仓。

// ---- P1#1 朗读半双工代际闸（voice-call.ts）------------------------------------

describe('P1#1 朗读半双工代际闸', () => {
  it('speaker 代际：speak 捕获 myGen，stop 也推进代际；fin 收口过闸（滞后 onend 不代答新句）', () => {
    expect(callSrc).toContain('let gen = 0;');
    expect(callSrc).toContain('const myGen = gen;');
    expect(callSrc).toMatch(/if \(!settled && myGen === gen\)/);
    // 精确串（无行尾注释）只命中 createSpeaker.stop()，不误配 speak() 入口
    expect(callSrc).toContain('synth.cancel();\n      gen++;');
  });

  it('call.speak 入口拆 guardTimer + 消费侧代际闸：被顶掉的旧句不武装恢复定时器', () => {
    const block = callSrc.slice(callSrc.indexOf('speak(text) {'), callSrc.indexOf('stopSpeaking() {'));
    expect(block).toContain('window.clearTimeout(guardTimer)');
    expect(block).toContain('speakGen++');
    expect(block).toContain('if (myGen !== speakGen) return;');
  });
});

// ---- P1#2 close() 拆在途重连（voice-session.ts）-------------------------------

describe('P1#2 close 清 reconnectTimer', () => {
  it('close() 块内一并 clearTimeout(reconnectTimer)：退避窗挂断不留僵尸重连', () => {
    // 块截取（R2 NEW#2：原 [\s\S]*? 正则可跨越 close() 体直抵 dispose() 里本就
    // 存在的同名行——修不修都绿的假阳性围栏）。锚点 close() { / send(i16) {
    // 唯一（接口声明处是 `close(): void` / `send(i16: Int16Array)` 不撞），
    // 切片恰为 close() 方法体：connect() 的武装行与 dispose() 的清理行都在块外。
    const closeBlock = sessionSrc.slice(sessionSrc.indexOf('close() {'), sessionSrc.indexOf('send(i16) {'));
    expect(closeBlock).toContain('window.clearTimeout(reconnectTimer)');
  });
});

// ---- P1#3 清空断引用（chat.ts）------------------------------------------------

describe('P1#3 清空历史重置 UI 引用', () => {
  it('clear 处理器块内三重置（照 newChat），healAssistant 不再改写脱离文档的旧气泡', () => {
    const block = chatSrc.slice(chatSrc.indexOf('const clearBtn'), chatSrc.indexOf('// 重连恢复'));
    expect(block).toContain("clearBtn.addEventListener('click'");
    expect(block.indexOf('thinkingRow = null;')).toBeGreaterThan(-1);
    expect(block.indexOf('stream = null;')).toBeGreaterThan(block.indexOf('thinkingRow = null;'));
    expect(block.indexOf('lastFinal = null;')).toBeGreaterThan(block.indexOf('stream = null;'));
  });
});

// ---- P2#1 迟到终稿先交付（voice-input.ts）-------------------------------------

describe('P2#1 再按先交付上一按残留终稿', () => {
  it('pttStart 先拆 settle 定时器、heldFinals 非空立即 onFinal 交付后清零', () => {
    const block = inputSrc.slice(inputSrc.indexOf('const pttStart'), inputSrc.indexOf('const pttStop'));
    const atClear = block.indexOf('window.clearTimeout(settleTimer);');
    const atDeliver = block.indexOf('cb.onFinal(pending);');
    expect(block).toContain('heldFinals.length > 0');
    expect(atClear).toBeGreaterThan(-1);
    expect(atDeliver).toBeGreaterThan(atClear); // 先拆定时器再交付：防空窗到点误报「没听清」
    expect(block).toContain('heldFinals = [];');
  });
});

// ---- P2#2 采集层异常归一（voice-session/voice-input/voice-call）----------------

describe('P2#2 采集层异常归一 + 调用方收口', () => {
  it('initMic 后半段 try/catch：失败停 track、关 ctx、置空、提示、return false；blobUrl 恒 revoke', () => {
    expect(sessionSrc).toContain("let blobUrl = '';");
    expect(sessionSrc).toMatch(/\} catch \{[\s\S]*?getTracks\(\) \?\? \[\]\) t\.stop\(\);[\s\S]*?audioCtx = null;[\s\S]*?sink\?\.onNote\('语音采集初始化失败[\s\S]*?return false;[\s\S]*?\} finally \{\s*if \(blobUrl !== ''\) URL\.revokeObjectURL\(blobUrl\);/);
  });

  it('pttStart：session.start 异常按不可用收口，失败路径调 session.close()（WS 不悬开）', () => {
    const block = inputSrc.slice(inputSrc.indexOf('const pttStart'), inputSrc.indexOf('const pttStop'));
    expect(block).toContain('ok = await session.start();');
    expect(block).toContain('session.close();');
  });

  it('通话 start：.then 补 .catch，与 !ok 分支同款收口（2026-10-27 起在核心 begin()，UI 只触发）', () => {
    const block = callSrc.slice(callSrc.indexOf('begin() {'), callSrc.indexOf('    end() {'));
    expect(block).toMatch(/\.then\(\(ok\) => \{[\s\S]*?\}\)\.catch\(\(\) => \{[\s\S]*?call\.end\(\);[\s\S]*?麦克风不可用/);
  });
});

// ---- P2#3 confirmPlan 回执卡兜底（chat.ts）------------------------------------

describe('P2#3 confirmPlan liveSeen 丢帧补卡', () => {
  it('dispatched 帧记录 id；回包 liveSeen 且帧未到过时补 refCard（与 fire 的 plan 兜底对称）', () => {
    expect(chatSrc).toContain('let dispatchedId: string | null = null;');
    expect(chatSrc).toContain('dispatchedId = op.id;');
    expect(chatSrc).toContain('else if (r.runId !== null && dispatchedId !== r.runId)');
    expect(chatSrc).toContain('thread.appendChild(refCard(r.runId));');
  });
});

// ---- P2#4 在途挂断不误报激活（voice-call.ts）----------------------------------

describe('P2#4 start 在途挂断复查 inCall', () => {
  it('.then 内 !ok 后补 inCall 复查：挂断先行不误发 onActiveChange(true)（2026-10-27 起在核心 begin()）', () => {
    const block = callSrc.slice(callSrc.indexOf('begin() {'), callSrc.indexOf('    end() {'));
    expect(block).toMatch(/if \(!ok\) \{[\s\S]*?return; \}\s*\n\s*if \(!inCall\) return;/);
  });
});

// ---- P2#5 死配置面钉死（voice-session.ts）-------------------------------------

describe('P2#5 juli_voice_ws/token 只读面注释钉死', () => {
  it('键旁注释写明：无 UI 写入口、仅 devtools 手动覆盖、默认本地回环', () => {
    expect(sessionSrc).toContain('无 UI 写入口，仅 devtools 手动覆盖');
    expect(sessionSrc).toContain('ws://127.0.0.1:8790/ws');
  });
});

// ---- P2#6 style.css 注释提前终止（携带项）-------------------------------------

describe('P2#6 style.css 注释不含提前终止序列', () => {
  it('--st-*/ 形态不再出现（esbuild minify 告警源消除），语义改写保留', () => {
    expect(css).not.toContain('--st-*/');
    expect(css).toContain('--st-* 与 --c-*');
  });
});

// ---- P2#7 upwork OAuth 回调加固（携带项）--------------------------------------
// （b44 R1 P1 迁出：断言随 cli/upwork.ts 的投影 exclude 同砍，现住
// test/upwork-callback.test.ts——manifest exclude，私仓照常跑。）

// ---- R1/b44 P2 上行闸-协议机接线 + 关闭标记卫生（voice-session.ts）--------------

describe('R1/b44 P2 上行闸镜像进协议机 + deliberateClose 卫生', () => {
  it('setUplink 双向接线：开闸 uplinkStarted、松手 uplinkEnded（松手武装看门狗可达）', () => {
    const block = sessionSrc.slice(sessionSrc.indexOf('setUplink(on) {'), sessionSrc.indexOf('flushTail() {'));
    expect(block).toContain('if (on) machine.uplinkStarted();');
    expect(block).toContain('else machine.uplinkEnded();');
  });

  it('deliberateClose 仅在 ws 在场时置位（退避窗挂断 ws===null 无 close 事件可消费，置位即陈旧）', () => {
    expect(sessionSrc.match(/if \(ws !== null\) deliberateClose = true;/g)?.length).toBe(2); // close() + armIdleClose 两处
  });
});

// ---- R1/b42 P2#1 空闲断开上行活动门（voice-session.ts）-------------------------

describe('R1/b42 P2#1 空闲断开须整窗无上行帧', () => {
  it('armIdleClose 判定含 lastUplinkAt 门：锁定 PTT 长静默不再被 45s 空闲断开击中', () => {
    const block = sessionSrc.slice(sessionSrc.indexOf('const armIdleClose'), sessionSrc.indexOf('const initMic'));
    expect(block).toContain('performance.now() - lastUplinkAt >= IDLE_CLOSE_MS');
  });

  it('活动刷新点在 sendFrame 的 ws OPEN 早退之后：未连上的丢弃帧不算活动', () => {
    const block = sessionSrc.slice(sessionSrc.indexOf('const sendFrame'), sessionSrc.indexOf('const machine'));
    const atGuard = block.indexOf('readyState !== WebSocket.OPEN');
    expect(atGuard).toBeGreaterThan(-1);
    expect(block.indexOf('lastUplinkAt = performance.now()')).toBeGreaterThan(atGuard);
  });
});

// ---- R2/b42 NEW#1 松手关上行：idle-close 正门可触发（voice-input.ts）------------

describe('R2/b42 NEW#1 松手后 idle-close 可触发', () => {
  it('pttStop 先 flushTail 后关上行闸：松手即停实发帧，45s 空闲正门可触发（不关闸静默帧连流永不空闲；关闸在前则切尾音）', () => {
    const block = inputSrc.slice(inputSrc.indexOf('const pttStop'), inputSrc.indexOf("btn.addEventListener('pointerdown'"));
    const atFlush = block.indexOf('session.flushTail()');
    const atGate = block.indexOf('session.setUplink(false)');
    expect(atFlush).toBeGreaterThan(-1);
    expect(atGate).toBeGreaterThan(atFlush);
  });

  it('replayFn 闸只在实发期间开：灌帧前重开（不重开则回放整段被静默丢弃）、灌完即关（探针页活麦静默帧不得占死正门）', () => {
    const block = inputSrc.slice(inputSrc.indexOf('const replayFn'), inputSrc.indexOf('const pttFn'));
    const atOpen = block.indexOf('session.setUplink(true)');
    const atSend = block.indexOf('session.send(');
    expect(atOpen).toBeGreaterThan(-1);
    expect(atSend).toBeGreaterThan(atOpen);
    expect(block).toContain('session.setUplink(false)');
  });
});
