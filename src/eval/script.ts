/**
 * @floken-io/engine · **`scriptTask` 的 FEEL 求值**（T17 · `eval/script.ts`）
 *
 * ★ **本档存在的唯一理由**：`03-engine` §6 的 `ScriptTask` 写明
 *   「**不执行任意 JS** —— ① `scriptFormat` = FEEL → 经 `@floken-io/feel` 求值，结果写入变量；
 *   ② 其它格式 → 报错 / 走 `handlers` 表；**禁止 `eval` / `new Function` / `node:vm`**」。
 *
 *   这条红线在本档是**结构性的**，不是纪律：整个包里没有任何一处能拿到「要执行的 JS 源码」——
 *   唯一的求值入口是本档的 `evaluateScript()`，而它只调 `@floken-io/feel`。
 *   （`tooling/verify.mjs` 与冷启动探针还有一道**产物源码扫描**把 `eval(` /
 *   `new Function` / `node:vm` 钉成硬门禁 —— 三层防线，缺一层都不算收口。）
 *
 * ## ★ 为什么结果与条件的处置不同（不要照抄 `eval/condition.ts`）
 *   - **条件**必须收敛成**二值**：网关分支的真值只有「走 / 不走」，`null` 没有对应行为
 *     ⇒ 非布尔**抛错**（D-38）；
 *   - **脚本**的结果是**数据**：`null` 是 FEEL 的合法值（三值语义），写进变量天经地义
 *     ⇒ **原样返回**，不抛。
 *
 *   把两者合成一个"求值器"是这类实现最常见的错：让脚本任务去复用条件求值器，
 *   脚本就永远算不出 `null`；反过来让条件去复用脚本求值器，网关就会静默走错分支。
 *
 * ★ 分层：`eval/` 是域层，可 import `core/`；**`core/` 不得反向 import `eval/`**。
 */

import type { Diagnostic, EvalResult } from '@floken-io/feel';

import { requirePeer } from '../core/peer.js';
import { assertNotJuel } from './condition.js';

/**
 * 惰性取 `@floken-io/feel`（Q49：**optional** peer —— 没有 `scriptTask` 就不用装）。
 *
 * ★ 本档是「不执行任意 JS」红线的落点，求值入口**只有** feel 的 `evaluate()`；
 *   peer 化之后这条红线不变，只是「feel 从哪来」由依赖声明改成了运行期解析。
 */
type FeelEvaluator = Pick<typeof import('@floken-io/feel'), 'evaluate'>;
let feelCache: FeelEvaluator | undefined;
function feelModule(): FeelEvaluator {
  return (feelCache ??= requirePeer<FeelEvaluator>('@floken-io/feel', {
    neededFor: 'FEEL evaluation: evaluate() for scriptTask (scriptFormat = FEEL)',
    range: '>=0.0.4 <1.0.0',
    optional: true,
  }));
}

export interface ScriptResult {
  /** FEEL 的求值结果（**可能是 `null`** —— 三值语义的合法值，不抛） */
  readonly value: unknown;
  /**
   * `@floken-io/feel` 的诊断（**原样透传，不重新包装**）。
   *
   * ⚠️ 与 `eval/condition.ts` 同款处置：**成功时的 warning 暂不上报**（D-41 的同一取舍）——
   *   脚本的返回值是"数据"不是"分支"，引擎没有地方挂诊断；语法错 / 求值错则**直接抛**。
   *   保留在返回值里，是为了将来接 `PlanResult.diagnostics` 时不用改签名。
   */
  readonly warnings: readonly Diagnostic[];
}

/** `evaluate()` 的完整结果（供需要细看的调用方） */
export type ScriptEvalResult = EvalResult;

/**
 * ★ 求值一段 **FEEL 脚本**（`scriptTask` 且 `scriptFormat` 认作 FEEL 时走这里）。
 *
 * @throws `@floken-io/feel` 的 `FeelSyntaxError` —— 语法错**原样向上**（不 catch、不降级）；
 *         `03` §6 的判据是"不执行任意 JS"，而不是"脚本写错了也要跑下去"。
 * @throws `ENGINE_OPTION_INVALID` —— 写了 `${...}`（JUEL，不是 FEEL）
 */
export function evaluateScript(
  source: string,
  variables: Readonly<Record<string, unknown>>,
): ScriptResult {
  assertNotJuel(source, 'script');
  const src = source.trim();
  // 空脚本：`nodes/graph.ts` 的 `scriptOf()` 已把它归一化成 `undefined`，
  // 走到这里说明调用方自己传了空白 —— 交给 feel 报语法错比在这里静默返回 null 好
  // （静默 null 的表现是"变量被写成了空"，排查时看不出脚本根本没写）。
  const result = feelModule().evaluate(src, variables as Record<string, unknown>);
  return { value: result.value, warnings: [...result.warnings] };
}
