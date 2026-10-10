// 常量时间字符串比较（密码/token 校验）：长度不等直接 false（长度本身
// 不是秘密），等长走 timingSafeEqual。全服务唯一事实源。

import { timingSafeEqual } from 'node:crypto';

export const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
};
