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

/** `expectCode` 的异步版（await 被测 Promise，用于 async 的入口） */
export async function expectCodeAsync(p: Promise<unknown>, code: string): Promise<CaughtError> {
  let thrown: unknown;
  try {
    await p;
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `应当抛错（期望 code=${code}）`).toBeDefined();
  expect((thrown as { code?: string }).code).toBe(code);
  return thrown as CaughtError;
}
