// 剥落款边界守卫（第 3 轮审查问题 5）：落款块草稿拒发（不发「只有落款」的信）、
// 常态落款尾随照发不告警、整段引用被剥实质截断时留痕照发。
import { describe, expect, it } from 'vitest';
import { makeEngine } from './helpers.ts';
import { SIGNATURE_TEXT } from '../src/business/send/emailView.ts';

type World = ReturnType<typeof makeEngine>;

/** 最小发送链：workflow(meta.from) + waiting_human 闸门（inline draft）+ send 步。
 * approve 播种 inline body → advance 直跑 runSendStep（不经 artifact 机器）。 */
const driveSend = async (w: World, draft: string): Promise<string> => {
  const wf = w.store.createWorkflow({
    kind: 'adhoc', title: 'strip-guard',
    meta: { from: 'boss@example.com', subject: '剥离守卫', message_id: '<orig@x>' },
  });
  const gate = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'gate', title: '发送决定' });
  w.store.setStepInput(gate.id, { draft });
  w.store.setStepStatus(gate.id, 'waiting_human');
  w.store.createStep({ workflowId: wf.id, seq: 2, kind: 'send', title: 'SMTP 发送' });
  await w.engine.approve(gate.id, '', 'test');
  await w.engine.advance(wf.id);
  return wf.id;
};

const sendStepOf = (w: World, wfId: string) =>
  w.store.stepsForWorkflow(wfId).find((s) => s.kind === 'send')!;

const truncatedEvents = (w: World, stepId: string) =>
  w.store.listEvents(500).filter((e) => e.type === 'send_body_truncated' && e.entityId === stepId);

describe('stripSignature 边界（剥空拒发 · 截断留痕）', () => {
  it('草稿只有落款块:剥出空主文 → empty_body 拒发,不发「只有落款」的信', async () => {
    const w = makeEngine();
    const wfId = await driveSend(w, SIGNATURE_TEXT);
    const send = sendStepOf(w, wfId);
    expect(send.status).toBe('failed');
    expect(send.output['guard']).toBe('empty_body');
    expect(String(send.output['error'])).toContain('signature-only');
    expect(w.sent).toHaveLength(0);
    expect(truncatedEvents(w, send.id)).toHaveLength(0);
  });

  it('草稿以「此致」开头(落款前置畸形):同样拒发', async () => {
    const w = makeEngine();
    const wfId = await driveSend(w, `此致\n敬礼\n\n${SIGNATURE_TEXT.slice(SIGNATURE_TEXT.indexOf('juli'))}`);
    const send = sendStepOf(w, wfId);
    expect(send.status).toBe('failed');
    expect(send.output['guard']).toBe('empty_body');
    expect(w.sent).toHaveLength(0);
  });

  it('常态:模型自带落款被正常剥掉 → 照发,引擎落款拼装,零截断告警', async () => {
    const w = makeEngine();
    const draft = `您好，销量表已发出。\n${SIGNATURE_TEXT}`;
    const wfId = await driveSend(w, draft);
    const send = sendStepOf(w, wfId);
    expect(send.status).toBe('completed');
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.body).toBe(`您好，销量表已发出。\n\n${SIGNATURE_TEXT}`);
    expect(truncatedEvents(w, send.id)).toHaveLength(0); // 剥掉的 ≈ 落款本身,不告警
  });

  it('整段引用含「此致」被实质截断:照发但留 send_body_truncated 事件', async () => {
    const w = makeEngine();
    const quoted = '历史往来内容——'.repeat(40);
    const draft = `收到，两点都确认。\n此致\n敬礼\n\n—— 客户原文引用 ——\n${quoted}\n本邮件由 AI 助理答复，如有出入，直接回复本邮件纠正。`;
    const wfId = await driveSend(w, draft);
    const send = sendStepOf(w, wfId);
    expect(send.status).toBe('completed');
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.body.startsWith('收到，两点都确认。\n\n此致')).toBe(true);
    const evs = truncatedEvents(w, send.id);
    expect(evs).toHaveLength(1);
    expect(Number(evs[0]!.payload['stripped_chars'])).toBeGreaterThan(SIGNATURE_TEXT.length + 40);
  });
});
