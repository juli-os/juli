// 本地 transcript + conv 线程 id（2026-10-27 通话后台保持抽出）：通话中心与
// chat 视图是同一档的两个消费者——单一事实源必须单处持有，否则后台轮次与
// 视图回放各写一份档互相覆盖。语义不变（2026-10-07 用户实报「chat 不记录
// 历史」）：写穿透、500 条上限、含附件元数据；工具活动行是过程帧不落档。
// 服务端 chathub 环形 200 条只服务 WS 断线补帧——本地档即唯一历史源。

export const TS_KEY = 'juli_chat_transcript_v1';
export const TS_LIMIT = 500;
const CONV_KEY = 'juli_conv';

export interface TsMsg {
  readonly role: 'user' | 'assistant' | 'sys';
  readonly text: string;
  readonly at: string;
  readonly atts?: readonly { name: string; mime: string }[];
}

export const loadTranscript = (): TsMsg[] => {
  try {
    const v = JSON.parse(localStorage.getItem(TS_KEY) ?? '[]') as TsMsg[];
    return Array.isArray(v) ? v.filter((m) => typeof m.text === 'string' && (m.role === 'user' || m.role === 'assistant' || m.role === 'sys')) : [];
  } catch { return []; }
};

export const saveTranscript = (msgs: readonly TsMsg[]): void => {
  try {
    localStorage.setItem(TS_KEY, JSON.stringify(msgs.slice(-TS_LIMIT)));
  } catch { /* 隐私模式/配额——历史是增强不是地基，写失败不炸对话 */ }
};

/** 后台轮次追加（通话中心专用）：读-改-写穿透。视图在场时走 appendMsg
 * （渲染+落档一体），不在场时由中心走这里；两个入口同一份档。 */
export const appendTranscriptMsg = (role: TsMsg['role'], text: string): void => {
  if (text === '') return;
  saveTranscript([...loadTranscript(), { role, text, at: new Date().toISOString() }]);
};

// conv 分线程（2026-10-17）：本浏览器的会话线程 id——服务端按 conv 隔离
// intake 上下文/相位/暂存计划，诊断注入与多端并行不再串台。「新对话」=
// 换 id（旧线程留在服务端按 LRU 自然过期）。通话后台轮次与视图发同一线程，
// 回到 /chat 才看得到期间发生了什么——所以 id 也必须同源。
export const newConvId = (): string => `web-${(crypto.randomUUID ? crypto.randomUUID() : String(Date.now()))}`;

export const convId = (): string => {
  let v = localStorage.getItem(CONV_KEY) ?? '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(v)) {
    v = newConvId();
    localStorage.setItem(CONV_KEY, v);
  }
  return v;
};

/** 「新对话」：换 conv id + 清本地档（视图「新对话」按钮与中心同源）。 */
export const resetConversation = (): void => {
  localStorage.setItem(CONV_KEY, newConvId());
  saveTranscript([]);
};
