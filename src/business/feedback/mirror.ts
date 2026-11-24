// 公开投影桩：与私仓同形，双侧投影导出面一致防漂移。
// 私仓本文件是 feedback 镜像 sync job（PocketBase 事件流 → 域库镜像表）；
// b56 step3 feedback 独立成域后，2026-11-13 R2-F 将 exclude 更新到域真实路径
// （src/business/feedback/**），本桩承接公开投影对镜像面仅存的直连：
// runtime.ts 组合根的 feedbackReplyCount 注入（回挂答复计数）。
// 语义：私仓真实现「镜像表不存在 = 无回挂证据 = 计 0」（catch 兜底）；
// 公开投影镜像域整体砍面（runtime.business 桩 feedbackMirrorDb 恒 null），
// 恒 0 ≡ 引擎缺省路径语义。db 参数收 unknown——公开调用点实参为 null
//（同 platform/ops/timers.ts 桩的 mailer: unknown 放宽先例）；导出面漂移
// （私仓改签名忘同步桩）即公开树 typecheck 红灯。

export const replyCountOf = (db: unknown, recordId: string): number => {
  void db;
  void recordId;
  return 0; // 公开投影未含镜像域——无回挂证据，恒 0
};
