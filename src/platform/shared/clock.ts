// 可注入的时间与 ID 生成——测试确定性的根。引擎/store 一律经由这两个端口
// 取时间与新 ID，测试里注入假时钟/计数器即可全流程断言。

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface IdGen {
  newId(prefix: string): string;
}

const hex = (n: number): string =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');

export const randomIds: IdGen = {
  newId: (prefix: string) => `${prefix}_${hex(12)}`,
};

/** RFC3339（秒级）——账本时间戳的统一格式，与 Go 版一致。 */
export const rfc3339 = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
