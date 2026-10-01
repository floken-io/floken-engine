/**
 * @floken-io/engine/conformance · 报告与用例驱动器
 *
 * 契约来源：`ARCHITECTURE.md` §9 T6；`03-engine` §9.2（宿主自研实现的两类静默错误）。
 *
 * ═══════════════════════════════════════════════════════════════
 * ★ 三条设计裁决（不是随手写的，改之前先看理由）
 * ═══════════════════════════════════════════════════════════════
 *
 * ① **绝不 import 测试框架**。本套件**随包发布**（`./conformance` 子路径），宿主拿它去验
 *    自己写的 Postgres / MySQL 实现 —— 此时宿主用什么 runner 是宿主的自由（vitest /
 *    jest / `node:test` / 一个没框架的脚本都行）。套件若 `import { expect } from 'vitest'`，
 *    等于给整个宿主应用强塞一个测试框架依赖；而且 `check:deps` 的依赖白名单也会直接拦下来。
 *    → 所以这里**只返回报告、不抛断言**；怎么把报告变成 CI 上的红/绿，由调用方决定。
 *
 * ② **返回报告而非 fail-fast**。逐条 `try/catch`，一次跑完给出**完整缺口清单**。
 *    fail-fast 会让人「修一条跑一次」，而宿主的实现缺陷通常是**成簇**出现的
 *    （比如「不抛冲突」往往连带「失败路径不留痕」也不成立）。
 *
 * ③ **断言体可以抛任何错**，套件把它转成 `error: string`。所以套件内部用**纯 `Error`**
 *    做断言失败信号 —— 它**不是** `EngineError`。理由：`EngineError` 是**引擎对宿主**的
 *    错误契约（码表 / 四禁 / 双命名空间），而「你的实现不满足契约」是**开发期**的结论，
 *    不该混进那套码表里去占用码名。详见 `AGENTS.md` §5。
 */
import { EngineError } from '../core/errors.js';
import { deepEqual } from '../core/state.js';

// ═══════════════════════════════════════════════════════════════
// 报告形状
// ═══════════════════════════════════════════════════════════════

/** 单条契约用例的结果 */
export interface ConformanceCase {
  /** 判据名：**人类可读、直接进 CI 日志**（说明"哪条契约没兑现"） */
  name: string;
  /** 该用例覆盖的规格锚点（`INV-x` / `AC-Ex` / 文档小节），失败时可直接回溯规范 */
  refs: readonly string[];
  ok: boolean;
  /** 失败原因；`ok === true` 时**不存在该键** */
  error?: string;
}

/** 一次契约测试的完整结果（`ok` = 全绿） */
export interface ConformanceReport {
  /** 套件名：`'store'` | `'projection'` */
  suite: string;
  /** 被测实现的自述（宿主传入，便于日志里区分多套实现） */
  subject?: string;
  cases: ConformanceCase[];
  total: number;
  passed: number;
  failed: number;
  ok: boolean;
}

/** 单条用例的断言体：抛错即失败，正常返回即通过 */
export type ConformanceCaseBody = () => void | Promise<void>;

/** 用例定义元组：`[判据名, 规格锚点[], 断言体]` */
export type ConformanceCaseSpec = readonly [string, readonly string[], ConformanceCaseBody];

/**
 * 顺序跑完全部用例并汇总成报告。
 *
 * ⚠️ 用例之间**只靠唯一 id 隔离，不做清库** —— 所以每个用例必须自己生成全新的
 * `instanceId`（见 `store.ts` 的 `uniqueId()`）。这正是 `runStoreConformance(store)`
 * 能保持单参签名的原因：不需要工厂、不需要 `clear()`（那会让 `StateStore` 长出非契约方法）。
 */
export async function runConformanceCases(
  suite: string,
  subject: string | undefined,
  specs: readonly ConformanceCaseSpec[],
): Promise<ConformanceReport> {
  const cases: ConformanceCase[] = [];
  for (const [name, refs, body] of specs) {
    try {
      await body();
      cases.push({ name, refs, ok: true });
    } catch (e) {
      cases.push({ name, refs, ok: false, error: describeError(e) });
    }
  }
  const passed = cases.filter((c) => c.ok).length;
  const failed = cases.length - passed;
  return {
    suite,
    // `exactOptionalPropertyTypes`：不能用 `subject: undefined` 占键
    ...(subject === undefined ? {} : { subject }),
    cases,
    total: cases.length,
    passed,
    failed,
    ok: failed === 0,
  };
}

/** 人类可读结论（宿主 `console.log` 它即可） */
export function formatConformanceReport(report: ConformanceReport): string {
  const head = `[${report.suite} conformance]${report.subject === undefined ? '' : ` ${report.subject}`}`;
  const lines = [`${report.ok ? '\u2713' : '\u2717'} ${head} — ${report.passed}/${report.total} 通过`];
  for (const c of report.cases) {
    const refs = c.refs.length === 0 ? '' : ` (${c.refs.join(' ')})`;
    if (c.ok) lines.push(`  \u2713 ${c.name}${refs}`);
    else lines.push(`  \u2717 ${c.name}${refs}`, `      ${c.error ?? '(无错误信息)'}`);
  }
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// 断言工具（套件内部用；**不随公开面导出**，改动不受 semver 约束）
// ═══════════════════════════════════════════════════════════════

/**
 * 断言真值。用 `asserts` 签名让 TS 收窄 —— 于是用例里不必写
 * `if (x === null) throw new Error(...)` 这种噪音。
 */
export function assertTrue(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** 深等断言（复用 `core/state.ts` 的 `deepEqual`，避免两套比较语义） */
export function assertDeepEqual(actual: unknown, expected: unknown, what: string): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(`${what}：期望 ${show(expected)}，实得 ${show(actual)}`);
  }
}

/**
 * 错误**归属**判定。
 *
 * ⚠️ 不能只靠 `instanceof EngineError`：宿主项目里若有**两份** `@floken-io/engine`
 * （例如 pnpm 的重复安装 / 不同 major），两份的 `EngineError` 是两个不同构造器，
 * `instanceof` 会**假阴性**。所以这里叠加结构判据 —— `floken === true` 是五包统一印记
 * （`AGENTS.md` §5.5），跨副本稳定。
 */
export function isEngineErrorLike(e: unknown): e is EngineError {
  if (e instanceof EngineError) return true;
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { floken?: unknown }).floken === true &&
    typeof (e as { code?: unknown }).code === 'string'
  );
}

/**
 * 断言「这个值是一个码名正确的引擎错误」，并把它返回（方便继续断言 `details`）。
 *
 * ★ 为什么连 `floken` 印记一起断言：宿主**自研 `StateStore`** 必须用 engine 导出的
 *   `persistConflict` / `persistAlreadyExists` 抛错。若宿主自己 `new Error()`，
 *   引擎侧就**分不清**「CAS 冲突」与「数据库掉线」，会把冲突当故障重试（或反之）。
 */
export function assertEngineErrorValue(
  value: unknown,
  expectedCode: string,
  what: string,
): EngineError {
  if (!isEngineErrorLike(value)) {
    throw new Error(`${what}：期望抛 EngineError，实得 ${describeError(value)}`);
  }
  assertTrue(
    value.code === expectedCode,
    `${what}：错误码期望 ${expectedCode}，实得 ${value.code}`,
  );
  assertTrue(
    value.floken === true,
    `${what}：错误缺 floken 印记 —— 宿主自研实现须用 engine 导出的工厂抛错，否则引擎无法归一`,
  );
  assertTrue(value.pkg === 'engine', `${what}：pkg 期望 'engine'，实得 ${String(value.pkg)}`);
  return value;
}

/** 断言 `fn()` 抛错，并把抛出的值原样返回 */
async function mustThrow(fn: () => Promise<unknown>, what: string): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error(`${what}：期望抛错，但正常返回了`);
}

/** 断言 `fn()` 抛出**指定码**的引擎错误 */
export async function catchEngineError(
  fn: () => Promise<unknown>,
  expectedCode: string,
  what: string,
): Promise<EngineError> {
  return assertEngineErrorValue(await mustThrow(fn, what), expectedCode, what);
}

/** 诊断用的人类可读描述（message 里带 `code`，一眼能定位） */
export function describeError(e: unknown): string {
  if (isEngineErrorLike(e)) {
    const hint = e.hint === undefined ? '' : ` — ${e.hint}`;
    return `${e.name}: ${e.message} [${e.code}]${hint}`;
  }
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return show(e);
}

/** 安全的单行展示（循环引用 / 不可序列化值都不炸） */
export function show(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    const s = JSON.stringify(value);
    return s === undefined ? String(value) : s;
  } catch {
    return String(value);
  }
}
