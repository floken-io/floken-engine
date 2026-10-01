/**
 * 断言**错误码**而非 message。
 *
 * ★ 为什么不能写 `expect(fn).toThrow(ENGINE_ERROR_CODES.X)`：
 *   `toThrow(string)` 匹配的是 **message**，而错误码**不在 message 里**
 *   （`AGENTS.md` §5.6：message 面向人、details 面向程序）。
 *   于是它**永远匹配不上却也不报错** —— 一个看起来在断言、实际什么都没验的假断言。
 *   T7 时踩过一次，症状是「实现明明抛了正确的码，测试却说没抛」。
 */

import { expect } from 'vitest';

export interface CaughtError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  hint?: string;
}

export function expectCode(fn: () => unknown, code: string): CaughtError {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `应当抛错（期望 code=${code}）`).toBeDefined();
  expect((thrown as { code?: string }).code).toBe(code);
  return thrown as CaughtError;
}

/**
 * `expectCode` 的异步版（await 被测 Promise，用于 async 的入口）。
 *
 * ★ **接受 Promise 也接受「返回 Promise 的函数」**，且两者都不是时**显式炸**：
 *   只收 Promise 时，误传一个 thunk（`() => engine.start(...)`）`await` 会正常返回
 *   —— 于是「期望抛错」的断言**永远通过且什么都没验**（本助手存在的意义就是防这类假断言，
 *   结果它自己留了一个）。T19 写测试时踩到一次，故补上这道形状检查。
 */
export async function expectCodeAsync(
  p: Promise<unknown> | (() => Promise<unknown>),
  code: string,
): Promise<CaughtError> {
  const target = typeof p === 'function' ? p() : p;
  if (typeof (target as { then?: unknown } | null)?.then !== 'function') {
    throw new TypeError(
      `expectCodeAsync 需要 Promise 或「返回 Promise 的函数」，实得 ${typeof p} —— 传了非 Promise 会让本断言静默失效`,
    );
  }
  let thrown: unknown;
  try {
    await target;
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `应当抛错（期望 code=${code}）`).toBeDefined();
  expect((thrown as { code?: string }).code).toBe(code);
  return thrown as CaughtError;
}
