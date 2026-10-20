// conv id 清洗单一事实源（2026-10-18 自 business/intake 收敛，R1-F2）：chat
// 会话线程 id 的格式契约——[A-Za-z0-9_-]{1,64}，违规（含空串/缺省）一律归
// 'main'（fail-safe 旧单线程形态）。消费方三方同源：intake 注册表（business）、
// HTTP 路由（http 边）、WS wire（platform/ws）——先前 WS 侧手写
// `?? 'main'` 对空串不触发（?conv= 空串会订阅永不存在的线程、静默零帧），
// 收敛后口径漂移即红 oss/arch 围栏的测试面。

export const sanitizeConv = (raw: string | undefined | null): string => {
  const s = (raw ?? '').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : 'main';
};
