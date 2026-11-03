// 通话开单围栏（2026-10-21）：语音确认分类器（零 DOM）+ 朗读文本清洗 +
// chat 接线防回退。确认动作仍走 confirmPlan 正门；分类器只认纯确认/纯否决
// 短句——误开单的代价远大于多说一轮。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyConfirmUtterance } from '../web/src/chat-live.ts';
import { speechText } from '../web/src/chat-live.ts';

describe('classifyConfirmUtterance：只认纯短句', () => {
  it('确认：常见口语肯定（含尾助词/句号）', () => {
    for (const t of ['确认', '确认开单', '开单', '开吧', '好', '好的', '可以', '行', '没问题', '对', '对的', '就这样', '就这么办', '可以吧', '好的。', '确认！']) {
      expect(classifyConfirmUtterance(t), t).toBe('confirm');
    }
  });

  it('否决：取消/算了/先不开', () => {
    for (const t of ['取消', '算了', '先不开', '不开', '不改了', '不要', '不用', '不用了', '再想想', '等等', '不对', '算了吧']) {
      expect(classifyConfirmUtterance(t), t).toBe('deny');
    }
  });

  it('修订：长句里带「确认/好」一律当对话（误开单比多说一轮贵）', () => {
    for (const t of ['好的，不过把周四改成周五', '确认一下标题对不对', '可以的话再加一个附件', '这个不对，收件人是 Emily', '帮我看看明天北京的天气', '']) {
      expect(classifyConfirmUtterance(t), t).toBe('revise');
    }
  });
});

describe('speechText：朗读用文本清洗', () => {
  it('去 Markdown/链接/行内码/代码块占位/wf 单号，折叠空白', () => {
    expect(speechText('**已开单** `wf_52f97a2ac956`：见 [流水](https://x/y)\n\n```json\n{}\n```')).toBe('已开单 ：见 流水 （代码）');
    expect(speechText('# 标题\n- 第一\n- 第二')).toBe('标题 - 第一 - 第二');
  });

  it('超长截断 400 字', () => {
    expect(speechText('字'.repeat(500)).length).toBe(400);
  });
});

const read = (rel: string): string => readFileSync(resolve(import.meta.dirname, rel), 'utf8');
const chatSrc = read('../web/src/views/chat.ts');
const chatMainSrc = read('../web/src/main.ts');
const callSrc = read('../web/src/voice-call.ts');

describe('通话接线防回退', () => {
  it('语音确认走 confirmPlan/denyPlan 正门并留系统行审计；长句照常进件', () => {
    expect(chatSrc).toContain('classifyConfirmUtterance(t)');
    expect(chatSrc).toContain('📞 语音确认');
    expect(chatSrc).toContain('void confirmPlan();');
    expect(chatSrc).toContain('void denyPlan();');
  });

  it('回复朗读挂在回合收口（turn_done/兜底回包）与开单回执', () => {
    expect(chatSrc).toContain('maybeSpeak(finalizeStream())');
    expect(chatSrc).toContain("call.speak('已开单。')");
  });

  it('朗读期半双工关上行 + 尾音抑制窗（外放防回声），挂断释放会话', () => {
    expect(callSrc).toContain('session.setUplink(false)');
    expect(callSrc).toContain('GUARD_MS');
    expect(callSrc).toContain('session.close()');
    expect(callSrc).toContain('session.route(null)');
  });

  it('通话期间隐藏 PTT 按钮，挂断重挂（会话路由归还输入模式；通话中重进本页也不挂）', () => {
    expect(chatSrc).toContain("if (call.active()) { voiceSlot.style.display = 'none'; return; }");
    expect(chatSrc).toContain('remountVoiceInput()');
  });

  // ---- 后台保持围栏（2026-10-27，缺陷单 wf_efccc6271097：通话切页即断线）----

  it('通话生命周期=页面：核心单例 + UI 挂载分离（detach 不动通话，视图清理口零 dispose）', () => {
    expect(callSrc).toContain('export const getVoiceCall = (): VoiceCallCore =>');
    expect(callSrc).toContain('export const mountVoiceCallUI = (');
    expect(callSrc).toContain('export const mountVoiceCallPill = (');
    expect(chatSrc).toContain('mountVoiceCallUI(');
    expect(chatSrc).not.toContain('voiceCall.dispose()');
    expect(chatSrc).not.toContain('voiceSession.dispose()');
  });

  it('视图在场走视图执行器，切页注销接线上报（轮次回落后台执行器）', () => {
    expect(chatSrc).toContain('call.setViewHandlers(');
    expect(chatSrc).toContain('call.setViewHandlers(null)');
    expect(callSrc).toContain('else void bgTurn(text)');
  });

  it('后台轮次写穿透 + 视图回放桥（transcript 单一事实源：chat-transcript 共享）', () => {
    expect(callSrc).toContain("from './chat-transcript.ts'");
    expect(callSrc).toContain('appendTranscriptMsg(');
    expect(chatSrc).toContain('call.setOnExternalTranscript(');
    expect(chatSrc).toContain('replayThread()');
  });

  it('壳层 pill：通话中且非 /chat 才显（双显=噪音），挂断/止播/回页齐备', () => {
    expect(callSrc).toContain("pill.hidden = s === 'idle' || onChat");
    expect(callSrc).toContain("location.hash = '#/chat'");
    expect(callSrc).toContain("call.onState(paint); // 壳层常驻订阅（与视图横幅多播并存，切页互不顶掉）");
    expect(chatMainSrc).toContain('mountVoiceCallPill(');
  });
});
