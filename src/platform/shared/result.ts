// Result/Either：可预期错误的函数式通道。端口边界（网络/磁盘/解析）一律
// 返回 Result，让错误成为类型的一部分；程序性 bug 仍走 throw。
// 事实源自 @juli-os/artifacts 0.2.4 原样收编（2026-11-11 第 1 步：artifacts
// 删工具出口，工具回家到主仓 platform/shared）。

export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** 把 Promise 变成 Result——async 端口的统一收口。 */
export const toResult = async <T>(p: Promise<T>, message = 'operation failed'): Promise<Result<T, Error>> => {
  try {
    return ok(await p);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(`${message}: ${String(e)}`));
  }
};
