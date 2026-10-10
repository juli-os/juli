// 引擎契约测试——把 Go 版拿真实事故换来的语义原样锁死：
// 闸门按下一个步的 kind 播种；deny 终态且 Retry 拒绝绕过；resolve 非
// 失败级联；send 只认 meta.from；已结算流水不许再走阶梯；settle-once。
//
// 断言时序约定：引擎内部的 fire-and-forget advance 都排在每工作流的锁链
// 上，测试里 `await engine.advance(id)` 即"排队到链尾"，返回时全部落定。

import { describe, expect, it } from 'vitest';
import { ladderEmail, makeEngine, makeEmail, until } from './helpers.ts';
import { parseTemplate } from '../src/business/templates/template.ts';
import { EMAIL_REPLY_YAML, VIDEO_PROD_YAML } from '../src/business/templates/defaultTemplates.ts';

describe('邮件全流程（mock 端口）', () => {
  it('triage→gate→agent→verify→gate→draft→gate→send 全程走通到 completed', async () => {
    const w = makeEngine();
    await ladderEmail(w.engine, makeEmail());
    const wfId = w.store.listWorkflows()[0]!.id;
    const steps = () => w.store.stepsForWorkflow(wfId);
    await w.engine.advance(wfId); // 排到触发推进之后：triage 完成、闸门 1 在等人

    // 1) triage 结构化 + 路由；闸门 1 waiting_human 且推送恰好一次。
    expect(steps()[0]!.status).toBe('completed');
    expect(steps()[1]!.status).toBe('waiting_human');
    expect(w.pushes.filter((p) => p.startsWith('gate:')).length).toBe(1);
    expect(steps()[0]!.output['session']).toBe('agent-a');
    expect(w.store.getWorkflow(wfId)!.project).toBe('proj-x'); // 默认项目路由
    expect(steps()[1]!.input['plan']).toBe('请整理上月销量数据表');

    // 2) 批准闸门 1 → agent 步按 kind 播种拿到 plan/session。
    await w.engine.approve(steps()[1]!.id, '计划可以', 'boss');
    await until(() => steps()[2]!.status === 'running');
    expect(w.dispatched.length).toBe(1);
    expect(w.dispatched[0]!.session).toBe('agent-a');
    expect(w.dispatched[0]!.text).toContain('请整理上月销量数据表');
    expect(w.dispatched[0]!.text).toContain('人工审批');

    // 3) agent 停止 → verify 步继承会话继续派发（第二次 agent 跳）。
    // 产出走 Stop hook 结构化上报（finalMessage）——capture-pane 兜底已摘除。
    await w.engine.onAgentStopped('agent-a', 'ok', '销量数据已整理完毕');
    await until(() => steps()[3]!.status === 'running');
    expect(w.dispatched.length).toBe(2);
    await w.engine.onAgentStopped('agent-a', 'ok', '复核完毕：数据无误');
    await until(() => steps()[4]!.status === 'waiting_human');
    // 案卷记了两条执行记录。
    expect(w.store.loadCaseFile(wfId).executions.length).toBe(2);

    // 4) 批准闸门 2 → draft 起草，拿到完整产出（output 优先于 plan）。
    expect(steps()[4]!.input['output']).toBe('复核完毕：数据无误');
    await w.engine.approve(steps()[4]!.id, '产出合格', 'boss');
    await until(() => steps()[5]!.status === 'completed');
    expect(steps()[5]!.output['draft']).not.toContain('本邮件由 AI 助理答复'); // 落款归引擎，草稿只写正文（2026-09-14 二轮）
    expect(w.store.loadCaseFile(wfId).draft).toBeTruthy();

    // 5) 批准回信闸门 → send 播种 to/subject/body/in_reply_to（to 只认 meta.from，
    // step input 里写什么都改不了收件人）。
    await until(() => steps()[6]!.status === 'waiting_human');
    await w.engine.approve(steps()[6]!.id, '回信可以发', 'boss');
    await until(() => steps()[7]!.status === 'completed');

    const sendInput = steps()[7]!.input;
    expect(sendInput['to']).toBe('boss@example.com');
    expect(sendInput['subject']).toBe('Re: 帮忙统计上月销量');
    expect(sendInput['in_reply_to']).toBe('<orig-1@example.com>');
    expect(w.sent.length).toBe(1);
    expect(w.sent[0]!.to).toBe('boss@example.com');
    expect(w.sent[0]!.body).toContain('本邮件由 AI 助理答复'); // 发出的信必有 AI 披露行（P1 机械强制）
    await until(() => w.store.getWorkflow(wfId)!.status === 'completed');
    expect(w.pushes.some((p) => p.startsWith('done:'))).toBe(true);
    // 引用链生长：meta.references 收进回信 message-id；案卷同步。
    expect(w.store.getWorkflow(wfId)!.meta['references']).toEqual(['<reply-1@juli.local>']);
    expect(w.store.loadCaseFile(wfId).references).toEqual(['<reply-1@juli.local>']);
    // 决策留痕：三个闸门的 approved 全在案卷。
    expect(w.store.loadCaseFile(wfId).decisions.map((d) => d.action)).toEqual([
      'approved', 'approved', 'approved',
    ]);
  });

  it('被拒邮件（authz 不过）不静默丢弃：建 rejected workflow 可审计', async () => {
    const w = makeEngine();
    await w.engine.onEmailReceived(makeEmail({ from: 'stranger@nowhere.io' }));
    const workflows = w.store.listWorkflows();
    expect(workflows.length).toBe(1);
    expect(workflows[0]!.status).toBe('rejected');
    expect(workflows[0]!.meta['rejected_reason']).toContain('not on the allowlist');
  });

  it('references 链（九跑 P2 类型翻转）：进件存数组；存量 string 单被线程扫描接上', async () => {
    const w = makeEngine();
    // ① 进件存 id 数组（修复前存空格分隔原文 string，首封回信即被 growReferences 抹链）。
    await w.engine.onEmailReceived(makeEmail({ references: '<a@x> <b@x>' }));
    const wf0 = w.store.listWorkflows()[0]!;
    expect(wf0.meta['references']).toEqual(['<a@x>', '<b@x>']);
    // ② 存量 string 落库形态（修复前的旧单）也能被线程扫描接上：回信的
    // in_reply_to 命中 references 里的 id → 挂线（主题全新，只有因果锚能匹配）。
    w.store.updateWorkflowMeta(wf0.id, { references: '<old-1@x> <old-2@x>' });
    await w.engine.onEmailReceived(makeEmail({ subject: '全新主题', inReplyTo: '<old-2@x>' }));
    await until(() => w.store.listWorkflows().length === 2);
    const reply = w.store.listWorkflows().find((x) => x.id !== wf0.id)!;
    expect(reply.parentId).toBe(wf0.id);
  });

  it('growReferences 兼容存量 string（九跑 P2）：回信追加不抹进件原链；sendSeed 取链尾', async () => {
    const w = makeEngine();
    const wf = await ladderEmail(w.engine, makeEmail());
    // 模拟修复前的存量形态：meta.references 是空格分隔 string。
    w.store.updateWorkflowMeta(wf.id, { references: '<orig-1@example.com> <mid-2@example.com>' });
    const steps = () => w.store.stepsForWorkflow(wf.id);
    // 通用驱动：闸门等人即批、agent 在跑即结算，直到 send 完成。
    for (let i = 0; i < 60; i++) {
      const gate = steps().find((s) => s.kind === 'gate' && s.status === 'waiting_human');
      const agent = steps().find((s) => (s.kind === 'agent' || s.kind === 'verify') && s.status === 'running');
      if (gate === undefined && agent === undefined) {
        if (w.sent.length > 0) break;
        await new Promise((r) => setTimeout(r, 10)); // 链条推进中（triage/draft 异步落定）
        continue;
      }
      if (gate !== undefined) await w.engine.approve(gate.id, '', 'boss');
      else await w.engine.onAgentStopped('agent-a', 'ok', '整理完毕，见正文');
    }
    await until(() => w.sent.length === 1);
    // 原链保真 + 回信 message-id 追加（不再是整体替换抹掉存量 string）。
    expect(w.store.getWorkflow(wf.id)!.meta['references'])
      .toEqual(['<orig-1@example.com>', '<mid-2@example.com>', '<reply-1@juli.local>']);
    // sendSeed 读取兼容：in_reply_to 取 references 链尾（存量 string 也认）。
    expect(w.sent[0]!.inReplyTo).toBe('<mid-2@example.com>');
  });

  it('活跃去重：同一封邮件在途时重复注入幂等；结算后允许重新触发', async () => {
    const w = makeEngine({ routing: { defaultSession: 'agent-a', defaultProject: 'proj-x' } });
    // 动态进件：首节点=理解 agent，在途即 running。
    await w.engine.onEmailReceived(makeEmail());
    const wfId = w.store.listWorkflows()[0]!.id;
    await until(() => w.store.stepsForWorkflow(wfId)[0]!.status === 'running');
    expect(w.store.getWorkflow(wfId)!.meta['mode']).toBe('nodes');
    // 在途 → 重复注入不建新流。
    await w.engine.onEmailReceived(makeEmail());
    expect(w.store.listWorkflows().length).toBe(1);
    // 理解回合落定后 settle 收口 → 同邮件可以重新来一遍。
    await w.engine.onAgentStopped('agent-a', 'done', '理解完成');
    await w.engine.settle(wfId, 'boss');
    await w.engine.onEmailReceived(makeEmail());
    expect(w.store.listWorkflows().length).toBe(2);
  });

  it('默认路由优先于 LLM 建议；LLM 无建议且无默认时报错失败', async () => {
    const w = makeEngine({
      routing: { defaultSession: 'agent-b', defaultProject: '' },
      availableSessions: ['agent-a'],
    });
    await ladderEmail(w.engine, makeEmail());
    const wfId = w.store.listWorkflows()[0]!.id;
    await w.engine.advance(wfId);
    expect(w.store.stepsForWorkflow(wfId)[0]!.output['session']).toBe('agent-b');
    expect(w.dispatched.length).toBe(0); // 还没派发，闸门先审

    // 无默认路由 + LLM 返回空会话 → triage 失败。
    const w2 = makeEngine({
      routing: { defaultSession: '', defaultProject: '' },
      llm: {
        async complete(req) {
          if (req.system.includes('邮件信息抽取')) {
            return { ok: true, value: { text: JSON.stringify({ category: '任务', summary: 's', session: ' ' }) } };
          }
          return { ok: true, value: { text: '{}' } };
        },
      },
    });
    await ladderEmail(w2.engine, makeEmail());
    const id2 = w2.store.listWorkflows()[0]!.id;
    await until(() => w2.store.stepsForWorkflow(id2)[0]!.status === 'failed');
    expect(w2.store.getWorkflow(id2)!.status).toBe('failed');
  });
});

describe('闸门语义', () => {
  const setupAtGate1 = async () => {
    const w = makeEngine();
    await ladderEmail(w.engine, makeEmail());
    const wfId = w.store.listWorkflows()[0]!.id;
    await until(() => w.store.stepsForWorkflow(wfId)[1]!.status === 'waiting_human');
    return { w, wfId };
  };

  it('deny 是终态：workflow failed + meta 记录理由 + Retry 拒绝绕过', async () => {
    const { w, wfId } = await setupAtGate1();
    const gate = w.store.stepsForWorkflow(wfId)[1]!;
    await w.engine.deny(gate.id, '方案不对', 'boss');
    const gateAfter = w.store.getStep(gate.id)!; // deny 后重读（快照不可变）
    expect(w.store.getWorkflow(wfId)!.status).toBe('failed');
    expect(gateAfter.output['denied']).toBe(true);
    expect(w.store.getWorkflow(wfId)!.meta['denied_reason']).toBe('方案不对');
    // Retry 任何步都被拒绝（防止跳过否决一路走到 send）。
    await expect(w.engine.retry(gate.id)).rejects.toThrow('denied');
    // 非 failed 的步先被状态检查挡住（对齐 Go 的检查次序）。
    await expect(w.engine.retry(w.store.stepsForWorkflow(wfId)[2]!.id)).rejects.toThrow('is not failed');
  });

  it('resolve 非失败语义：gate→cancelled、下游未跑→cancelled、审计全留', async () => {
    const { w, wfId } = await setupAtGate1();
    const gate = w.store.stepsForWorkflow(wfId)[1]!;
    await w.engine.resolve(gate.id, '客户已当面处理', 'boss');
    expect(w.store.getWorkflow(wfId)!.status).toBe('cancelled');
    const steps = w.store.stepsForWorkflow(wfId);
    expect(steps[1]!.status).toBe('cancelled');
    for (const s of steps.slice(2)) expect(s!.status).toBe('cancelled');
    expect(steps[0]!.status).toBe('completed');
    const events = w.store.listEvents(100).map((e) => e.type);
    expect(events).toContain('gate_resolved');
    expect(events).toContain('workflow_resolved');
    expect(w.store.loadCaseFile(wfId).decisions[0]?.action).toBe('resolved');
  });

  it('retry 重臂失败步：workflow 翻回 running 并重新推进', async () => {
    // LLM 只在首轮 3 次调用内 429（引擎内退避重试耗尽），retry 后恢复。
    let llmCalls = 0;
    const w = makeEngine({
      llmRetryDelayMs: 1,
      llm: {
        async complete(req) {
          llmCalls++;
          if (llmCalls <= 3) return { ok: false, error: new Error('429 too many requests') };
          if (req.system.includes('邮件信息抽取')) {
            return { ok: true, value: { text: JSON.stringify({ category: '任务', summary: 's', session: 'agent-a' }) } };
          }
          return { ok: true, value: { text: '{}' } };
        },
      },
    });
    await ladderEmail(w.engine, makeEmail());
    const wfId = w.store.listWorkflows()[0]!.id;
    await until(() => w.store.stepsForWorkflow(wfId)[0]!.status === 'failed');
    expect(w.store.getWorkflow(wfId)!.status).toBe('failed'); // 步失败镜像进工作流
    expect(llmCalls).toBe(3); // 429 已在引擎内退避重试 3 次
    await w.engine.retry(w.store.stepsForWorkflow(wfId)[0]!.id);
    expect(w.store.getWorkflow(wfId)!.status).toBe('running');
    await until(() => w.store.stepsForWorkflow(wfId)[1]!.status === 'waiting_human');
  });

  it('已结算（deny）的流水：迟到的 agent 结算不推进阶梯（settle-once 语义）', async () => {
    const { w, wfId } = await setupAtGate1();
    await w.engine.deny(w.store.stepsForWorkflow(wfId)[1]!.id, '否', 'boss');
    await w.engine.onAgentStopped('agent-a', 'ok');
    expect(w.store.getWorkflow(wfId)!.status).toBe('failed');
    expect(w.sent.length).toBe(0);
  });

  it('闸门动作要求工作流仍 running：非 running 的闸门拒绝审批（后端是权威）', async () => {
    const { w, wfId } = await setupAtGate1();
    // 直接把工作流打成 failed（模拟别处已收口），闸门仍挂着等待态——
    // 陈旧的 UI 还看得见它，但后端是权威，审批必须被拒。
    w.store.setWorkflowStatus(wfId, 'failed');
    const gate = w.store.stepsForWorkflow(wfId)[1]!;
    await expect(w.engine.approve(gate.id, '', 'boss')).rejects.toThrow('only valid while the workflow is running');
    await expect(w.engine.deny(gate.id, '', 'boss')).rejects.toThrow('only valid while the workflow is running');
  });

  it('重入守卫：running 的步不被重复执行（双击 approve 不会重复派发）', async () => {
    const { w, wfId } = await setupAtGate1();
    await w.engine.approve(w.store.stepsForWorkflow(wfId)[1]!.id, '', 'boss');
    await until(() => w.store.stepsForWorkflow(wfId)[2]!.status === 'running');
    await w.engine.advance(wfId); // 重入推进：running 步必须被守卫跳过
    expect(w.dispatched.length).toBe(1);
  });
});

describe('对账（重启恢复）', () => {
  it('reconcileStartup：中断的 llm 步落成 failed 可重试；等待中的闸门归位 waiting_human', async () => {
    const w = makeEngine();
    await ladderEmail(w.engine, makeEmail());
    const wfId = w.store.listWorkflows()[0]!.id;
    await until(() => w.store.stepsForWorkflow(wfId)[1]!.status === 'waiting_human');

    // 模拟重启后的脏状态：triage 完成但 gate 悬在 running（不可能中间态）。
    w.store.setStepStatus(w.store.stepsForWorkflow(wfId)[1]!.id, 'running');
    w.store.setWorkflowStatus(wfId, 'running');
    // triage 步人为置 running（模拟中断在供应商调用里）。
    w.store.setStepStatus(w.store.stepsForWorkflow(wfId)[0]!.id, 'running');

    await w.engine.reconcileStartup();
    const steps = w.store.stepsForWorkflow(wfId);
    expect(steps[0]!.status).toBe('failed'); // 中断 → failed 可重试
    expect(steps[0]!.output['error']).toContain('restart');
    expect(steps[1]!.status).toBe('waiting_human'); // 闸门归位
  });
});

describe('手动触发的模板流（StartFlow）', () => {
  it('未知模板键报错；已知键创建带快照哈希与输入的工作流', async () => {
    const w = makeEngine();
    await expect(w.engine.startFlow('nope', 't', {})).rejects.toThrow('unknown flow template');
    const wf = await w.engine.startFlow('email-reply', '手动流', { custom: 'x' });
    expect(wf.meta['template_key']).toBe('email-reply');
    expect(wf.meta['template_hash']).toMatch(/^[0-9a-f]{12}$/);
    expect(wf.meta['template_input']).toEqual({ custom: 'x' });
  });
});

describe('僵尸看门狗', () => {
  const setupAtAgent = async () => {
    const w = makeEngine();
    await ladderEmail(w.engine, makeEmail());
    const wfId = w.store.listWorkflows()[0]!.id;
    await until(() => w.store.stepsForWorkflow(wfId)[1]!.status === 'waiting_human');
    await w.engine.approve(w.store.stepsForWorkflow(wfId)[1]!.id, '', 'boss');
    await until(() => w.store.stepsForWorkflow(wfId)[2]!.status === 'running');
    return { w, wfId };
  };

  it('心跳沉默超时 → 第一次扫设指纹基线，第二次扫判定沉默并重派', async () => {
    const { w, wfId } = await setupAtAgent();
    w.advanceClock(6 * 60_000); // > 模板 5m 阈值
    await w.engine.sweepZombies(); // 首扫：设 pane 指纹基线（宽限）
    await w.engine.sweepZombies(); // 次扫：指纹未变 → 沉默确认 → 重派
    await w.engine.advance(wfId);  // 排空重派推进（pending → running）
    const agentStep = w.store.stepsForWorkflow(wfId)[2]!;
    expect(agentStep.status).toBe('running');
    expect(agentStep.input['zombie_attempts']).toBe(1);
    expect(w.dispatched.length).toBe(2); // 重派即第二次派发
  });

  it('重派后计数达到上限 → failed 转人工', async () => {
    const { w, wfId } = await setupAtAgent();
    w.store.setStepInput(w.store.stepsForWorkflow(wfId)[2]!.id, { zombie_attempts: 2 });
    w.advanceClock(6 * 60_000);
    await w.engine.sweepZombies();
    await w.engine.sweepZombies();
    const agentStep = w.store.stepsForWorkflow(wfId)[2]!;
    expect(agentStep.status).toBe('failed');
    expect(agentStep.output['error']).toContain('转人工');
    expect(w.store.loadCaseFile(wfId).decisions.some((d) => d.action === 'zombie_failed')).toBe(true);
  });

  it('静默未超时的步不被误杀', async () => {
    const { w, wfId } = await setupAtAgent();
    w.engine.touchSession('agent-a'); // 刚有心跳
    await w.engine.sweepZombies();
    await w.engine.sweepZombies();
    expect(w.store.stepsForWorkflow(wfId)[2]!.status).toBe('running');
  });

  it('策略快照：建流后改模板 zombie.timeout，在途流策略不变', async () => {
    const { w, wfId } = await setupAtAgent();
    // 建流时 email-reply 的 5m/3 已物化进 meta（zombie_policy）。
    expect(w.store.getWorkflow(wfId)?.meta['zombie_policy'])
      .toEqual({ timeoutMs: 5 * 60_000, maxAttempts: 3 });
    // 热更新模板：timeout 收紧到 1m——在途流不许跟随（阶梯快照语义的补全）。
    w.engine.setTemplates({
      'email-reply': parseTemplate(EMAIL_REPLY_YAML.replace('timeout: 5m', 'timeout: 1m')),
    });
    w.advanceClock(3 * 60_000); // 超新阈值(1m)、未超建流快照(5m)
    await w.engine.sweepZombies(); // 首扫：设指纹基线（宽限）
    await w.engine.sweepZombies(); // 次扫：按快照 5m 判定 → 不动手
    const agentStep = w.store.stepsForWorkflow(wfId)[2]!;
    expect(agentStep.status).toBe('running');
    expect(agentStep.input['zombie_attempts']).toBeUndefined(); // 未被重派
  });

  it('策略快照（步级）：建流后改模板步级 zombie.timeout，在途流该步策略不变', async () => {
    const w = makeEngine({ templates: { 'video-prod': parseTemplate(VIDEO_PROD_YAML) } });
    await w.engine.startFlow('video-prod', '视频', { concept: '咖啡拉花' });
    const wfId = w.store.listWorkflows()[0]!.id;
    const renderOf = () => w.store.stepsForWorkflow(wfId).find((s) => s.input['_ref'] === 'render')!;
    // 建流时 render 步的 20m/2 已随 carryStepConfig 物化进步 input（声明原文）。
    expect(renderOf().input['_zombie']).toEqual({ timeout: '20m', max_attempts: 2 });
    // 走到 render agent 步 running（创意/分镜两道闸门拍板）。
    await until(() => w.store.stepsForWorkflow(wfId)[1]!.status === 'waiting_human');
    await w.engine.approve(w.store.stepsForWorkflow(wfId)[1]!.id, '拍板', 'boss');
    await until(() => w.store.stepsForWorkflow(wfId)[3]!.status === 'waiting_human');
    await w.engine.approve(w.store.stepsForWorkflow(wfId)[3]!.id, '拍板', 'boss');
    await until(() => renderOf().status === 'running');
    // 热更新模板：步级 timeout 收紧到 1m——在途步不许跟随（步级快照语义）。
    w.engine.setTemplates({
      'video-prod': parseTemplate(VIDEO_PROD_YAML.replace('timeout: 20m', 'timeout: 1m')),
    });
    w.advanceClock(10 * 60_000); // 超热更值(1m)、未超建流步级快照(20m)
    await w.engine.sweepZombies(); // 首扫：设指纹基线（宽限）
    await w.engine.sweepZombies(); // 次扫：按步级快照 20m 判定 → 不动手
    expect(renderOf().status).toBe('running');
    expect(renderOf().input['zombie_attempts']).toBeUndefined(); // 未被重派
  });
});

describe('store 原子追加（appendStepOutputItem）', () => {
  it('缺键起建、追加保序、cap 裁剪保尾部最近条目', () => {
    const w = makeEngine();
    const wf = w.store.createWorkflow({ kind: 'adhoc', title: 't' });
    const st = w.store.createStep({ workflowId: wf.id, seq: 1, kind: 'agent', title: 'x' });
    w.store.appendStepOutputItem(st.id, 'activity', { n: 1 }, 50);
    w.store.appendStepOutputItem(st.id, 'activity', { n: 2 }, 50);
    w.store.setStepOutput(st.id, { session: 'agent-a' }); // 其它键合并不受影响
    w.store.appendStepOutputItem(st.id, 'activity', { n: 3 }, 2); // cap=2 → 裁掉最旧
    const out = w.store.getStep(st.id)!.output;
    expect(out['session']).toBe('agent-a');
    expect(out['activity']).toEqual([{ n: 2 }, { n: 3 }]);
  });
});


describe('语义跳过（when）', () => {
  const SKIPPY_YAML = `key: skippy
name: 跳过测试流
trigger: manual
steps:
  - id: extract
    kind: triage
    title: 抽取
  - id: execute
    kind: agent
    title: 执行
    when: "{{.Steps.extract.output.needs_reply}}"
  - id: send
    kind: send
    title: 发送
`;
  const w = makeEngine({ templates: { skippy: parseTemplate(SKIPPY_YAML) } });

  it('needs_reply=true → agent 正常执行（skippy 模板无闸门，when 为真直通）', async () => {
    const w = makeEngine({ templates: { skippy: parseTemplate(SKIPPY_YAML) } });
    await w.engine.startFlow('skippy', '', { from: 'boss@example.com', subject: 's', body: 'b' });
    const wfId = w.store.listWorkflows()[0]!.id;
    await until(() => w.store.stepsForWorkflow(wfId)[1]!.status === 'running');
    expect(w.dispatched.length).toBe(1);
    expect(w.store.stepsForWorkflow(wfId)[1]!.status).toBe('running');
  });

  it('needs_reply=false → agent 步 skipped，事件留痕，直接推进 send', async () => {
    const w2 = makeEngine({
      llm: { async complete(req) {
        if (req.system.includes('邮件信息抽取')) {
          return { ok: true, value: { text: JSON.stringify({ category: '信息同步', summary: '不需要回复', session: 'agent-a', needs_reply: false }) } };
        }
        return { ok: true, value: { text: '{}' } };
      } },
      templates: { skippy: parseTemplate(SKIPPY_YAML) },
      mailer: { async send() { return { ok: true, value: { messageId: '<skip@j>' } }; } },
    });
    await w2.engine.startFlow('skippy', '', { from: 'boss@example.com', subject: '仅供存档', body: 'b' });
    const wfId = w2.store.listWorkflows()[0]!.id;
    await w2.engine.advance(wfId);
    const steps = w2.store.stepsForWorkflow(wfId);
    // triage 完成 → agent 跳过 → 直达 send？send 在 raw 阶段会因无闸门种子发空信：
    // to=meta.from 存在 → send 完成 → 工作流 completed。
    expect(steps[0]!.status).toBe('completed');
    const agentStep = steps[1]!;
    expect(agentStep.status).toBe('skipped');
    expect(agentStep.output['skipped']).toBe(true);
    const events = w2.store.listEvents(50).map((e) => e.type);
    expect(events).toContain('step_skipped');
  });
});

describe('僵尸看门狗·resolved 会话（2026-09-21 /site→acme 事故）', () => {
  it('声明会话被兜底改道后，看门狗盯实际落点会话，重派也落对', async () => {
    const w = makeEngine({
      resolveSession: (s: string) => (s === 'acme' ? 'juli-reply' : s),
      availableSessions: ['agent-a', 'juli-reply'],
    });
    const wf = await w.engine.startTask('fb 单', { brief: '按 skill 处理', session: 'acme' });
    await until(() => w.store.stepsForWorkflow(wf.id)[0]!.status === 'running');
    const step = w.store.stepsForWorkflow(wf.id)[0]!;
    expect(step.input['resolved_session']).toBe('juli-reply');
    expect(w.dispatched[0]?.session).toBe('juli-reply');
    w.advanceClock(6 * 60_000); // > 默认 5m 阈值
    await w.engine.sweepZombies(); // 首扫：指纹基线（宽限）
    await w.engine.sweepZombies(); // 次扫：沉默确认 → 判僵尸
    const zombie = w.store.listEvents(500).find((e) => e.type === 'agent_zombie');
    expect(zombie).toBeDefined();
    // 事故形态断言：监视/中断/重派目标必须是 resolved 会话——盯声明会话
    // （acme，不存在）= 永远「静默」→ 对在跑的 juli-reply 重复投递。
    expect((zombie!.payload as Record<string, unknown>)['session']).toBe('juli-reply');
    await w.engine.advance(wf.id);
    const after = w.store.stepsForWorkflow(wf.id)[0]!;
    expect(after.status).toBe('running');
    expect(after.input['zombie_attempts']).toBe(1);
    expect(w.dispatched).toHaveLength(2);
    expect(w.dispatched.every((d) => d.session === 'juli-reply')).toBe(true);
  });
});

describe('提交未确认软路径（2026-09-21 深夜用户实测假阴性）', () => {
  const softDispatch = (msg: string) => ({
    dispatch: { dispatch: async () =>
      ({ ok: false as const, error: new Error(msg) }) },
  });

  it('submit_unconfirmed → 步保持 running 留痕，绝不判死', async () => {
    const w = makeEngine(softDispatch(
      'submit_unconfirmed: prompt 已入框但连续补 Enter 未被消费（输入框未重置）——任务未确认提交'));
    const wf = await w.engine.startTask('t', { brief: 'b', session: 'agent-a' });
    await until(() => w.store.stepsForWorkflow(wf.id)[0]!.status === 'running');
    const types = w.store.listEvents(200).map((e) => e.type);
    expect(types).toContain('submit_unverified');
    expect(types).not.toContain('step_failed');
    // 假阴性真实场景：agent 稍后消费了 prompt——Stop hook 正常结算为 completed。
    await w.engine.onAgentStopped('agent-a', 'ok', '任务完成汇报');
    expect(w.store.stepsForWorkflow(wf.id)[0]!.status).toBe('completed');
  });

  it('tmux 层硬错误仍显性 failed', async () => {
    const w = makeEngine(softDispatch('tmux send-keys: can\'t find session'));
    const wf = await w.engine.startTask('t', { brief: 'b', session: 'agent-a' });
    await until(() => w.store.stepsForWorkflow(wf.id)[0]!.status === 'failed');
    expect(w.store.stepsForWorkflow(wf.id)[0]!.output['error']).toContain('can\'t find session');
  });
});

describe('route_fallback jev 兜底腿（2026-09-23 用户口令，影子先行）', () => {
  const routing = {
    defaultSession: 'juli-reply', defaultProject: 'p',
    agents: [
      { session: 'juli-reply', company: 'juli', domain: 'reply' },
      { session: 'memory-cli', company: 'juli', domain: 'research' },
    ],
    boundAgents: [],
  };
  const gw = (mode: 'shadow' | 'on', answer: string, confidence: number) => ({
    threshold: () => 0.7,
    ask: async () => ({ mode, ok: true, answer, confidence, threshold: 0.7, provider: 'test' }),
  });
  const mk = (j: ReturnType<typeof gw>) => makeEngine({
    routing,
    resolveSession: (s: string) => (s === 'acme' ? 'juli-reply' : s),
    availableSessions: ['agent-a', 'juli-reply', 'memory-cli'],
    judgment: j,
  });
  const typesOf = (w: ReturnType<typeof makeEngine>) => w.store.listEvents(200).map((e) => e.type);

  it('shadow：判定留痕但派发仍落默认会话', async () => {
    const w = mk(gw('shadow', 'memory-cli', 0.9));
    const wf = await w.engine.startTask('t', { brief: 'b', session: 'acme' });
    await until(() => w.dispatched.length > 0);
    expect(w.dispatched[0]?.session).toBe('juli-reply'); // 不生效
    const types = typesOf(w);
    expect(types).toContain('route_fallback');
    expect(types).toContain('route_judgment');
    expect(types).not.toContain('route_judgment_applied');
  });

  it('on+过阈值+声明会话 → 派发改道判定会话', async () => {
    const w = mk(gw('on', 'memory-cli', 0.9));
    const wf = await w.engine.startTask('t', { brief: 'b', session: 'acme' });
    await until(() => w.dispatched.length > 0);
    expect(w.dispatched[0]?.session).toBe('memory-cli');
    expect(typesOf(w)).toContain('route_judgment_applied');
    const step = w.store.stepsForWorkflow(wf.id)[0]!;
    expect(step.input['resolved_session']).toBe('memory-cli');
  });

  it('on 但答案非声明会话 → 拒绝留痕，照旧落默认', async () => {
    const w = mk(gw('on', 'made-up-session', 0.99));
    const wf = await w.engine.startTask('t', { brief: 'b', session: 'acme' });
    await until(() => w.dispatched.length > 0);
    expect(w.dispatched[0]?.session).toBe('juli-reply');
    expect(typesOf(w)).toContain('route_judgment_rejected');
  });

  it('解析未改道（resolved === requested）→ 不咨询判定（判定块误挪出改道守卫则本例红）', async () => {
    let asked = 0;
    const j = {
      threshold: () => 0.7,
      ask: async () => {
        asked++;
        return { mode: 'on' as const, ok: true, answer: 'memory-cli', confidence: 0.99, threshold: 0.7, provider: 'test' };
      },
    };
    const w = makeEngine({
      routing,
      resolveSession: (s: string) => s, // 点名存在：原样放行，不改道
      availableSessions: ['agent-a', 'juli-reply', 'memory-cli', 'acme'],
      judgment: j,
    });
    await w.engine.startTask('t', { brief: 'b', session: 'acme' });
    await until(() => w.dispatched.length > 0);
    expect(w.dispatched[0]?.session).toBe('acme');
    expect(asked).toBe(0); // 负例：正常解析零判定调用
    expect(typesOf(w)).not.toContain('route_judgment');
  });

  it('on 但低置信 → 拒绝留痕', async () => {
    const w = mk(gw('on', 'memory-cli', 0.4));
    const wf = await w.engine.startTask('t', { brief: 'b', session: 'acme' });
    await until(() => w.dispatched.length > 0);
    expect(w.dispatched[0]?.session).toBe('juli-reply');
    expect(typesOf(w)).toContain('route_judgment_rejected');
  });

  it('无网关（缺省）→ 原行为零变化', async () => {
    const w = makeEngine({ routing, resolveSession: (s: string) => (s === 'acme' ? 'juli-reply' : s) });
    const wf = await w.engine.startTask('t', { brief: 'b', session: 'acme' });
    await until(() => w.dispatched.length > 0);
    expect(w.dispatched[0]?.session).toBe('juli-reply');
    expect(typesOf(w)).toContain('route_fallback');
    expect(typesOf(w)).not.toContain('route_judgment');
  });
});
