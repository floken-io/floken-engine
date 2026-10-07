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
import { stateShapeInvalid } from '../core/errors.js';
import { assertNotJuel } from './condition.js';

/**
 * ★ **归一化深度上限**（防恶意 / 手滑的循环引用把栈打爆）。
 *
 * FEEL 的 context 可以嵌套任意深，而 `InstanceState.variables` 是要被 `JSON` 往返的 ——
 * 超出这个深度的结构在业务上也不可能是"流程变量"，故直接判为不可存储并抛错。
 */
const MAX_PLAIN_DEPTH = 64;

/**
 * ★ 判定一个值是不是 FEEL 的 **context**（`{a: 1}` 的求值结果）。
 *
 * ⚠️ 为什么不能只判「是不是普通对象」：`@floken-io/feel` 的 context 是**类实例**
 *   `_FeelContext`，键值对装在 `entries`（一个 `Map`）里，`Object.keys()` 只能看到
 *   `['entries', '__feelContext']` —— 直接 `JSON.stringify` 出来是
 *   `{"entries":{},"__feelContext":true}`，**数据全丢且看不出丢了**（Map 序列化成 `{}`）。
 *
 * 判据因此取 feel 自己打的两个标记（`__feelContext === true` + `entries` 是 Map），
 * 而不是猜类名：类名是 feel 的内部实现，改一次这里就漏一次。
 */
function isFeelContext(value: object): value is { entries: Map<unknown, unknown> } {
  const v = value as { __feelContext?: unknown; entries?: unknown };
  return v.__feelContext === true && v.entries instanceof Map;
}

/**
 * ★ 把 FEEL 的求值结果转成**能落库的纯数据**（**D-93**）。
 *
 * ## 为什么必须有这一步（实测，不是偏好）
 *   `scriptTask` 写 `{ tax: amount * 0.06, total: amount * 1.06 }` —— 「一次算多个值」是
 *   脚本任务最常见的写法 —— 在归一化之前**一步都跑不动**：结果写进 `variables` 时被
 *   `assertSerializable` 挡成
 *   `ENGINE_STATE_SHAPE_INVALID: non-serializable class-instance … detail: _FeelContext`。
 *   报错里点的是 **feel 的内部类名**，宿主看到只能干瞪眼（实测 2026-10-07）。
 *
 * ## 三条处置（与「引擎不猜语义」同口径）
 *   - 标量 / `null` / 数组 → 原样（数组**递归**，因为列表里可以装 context）；
 *   - context → 递归转 plain object（**键必须是字符串**：非字符串键在 FEEL 里也引用不到）；
 *   - **其它类实例一律抛**，绝不静默转 `{}` —— 典型是宿主加载了 `@floken-io/feel/temporal`
 *     之后的日期 / 时长对象：它们的值在内部槽里，转出来是个空对象，
 *     「到期时间算出来了、落库变成 `{}`」比直接报错糟得多。
 *
 * @throws `ENGINE_STATE_SHAPE_INVALID` —— 值不是能落库的纯数据（指名路径与类型）
 */
export function plainScriptValue(value: unknown, path = '$', depth = 0): unknown {
  if (value === null) return null;

  if (typeof value !== 'object') {
    if (
      typeof value === 'function' ||
      typeof value === 'undefined' ||
      typeof value === 'symbol' ||
      typeof value === 'bigint'
    ) {
      throw stateShapeInvalid(`script result at ${path} is of type '${typeof value}' and cannot be stored`, {
        path,
        kind: typeof value,
        hint: '脚本结果必须是能 JSON 往返的纯数据；要返回时间语义请改成字符串，或改用 handlers 自己实现',
      });
    }
    return value;
  }

  if (depth >= MAX_PLAIN_DEPTH) {
    throw stateShapeInvalid(`script result is nested deeper than ${MAX_PLAIN_DEPTH} levels at ${path}`, {
      path,
      depth,
      maxDepth: MAX_PLAIN_DEPTH,
    });
  }

  if (Array.isArray(value)) {
    return value.map((item, i) => plainScriptValue(item, `${path}[${i}]`, depth + 1));
  }

  // —— context：把 `entries` 这个 Map 摊平成 plain object ——
  if (isFeelContext(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of value.entries) {
      if (typeof key !== 'string') {
        throw stateShapeInvalid(`script result key at ${path} is not a string ('${String(key)}')`, {
          path,
          key: String(key),
          hint: 'FEEL 里也引用不到非字符串键 —— 请改用字符串键',
        });
      }
      out[key] = plainScriptValue(item, `${path}.${key}`, depth + 1);
    }
    return out;
  }

  // —— 普通对象（宿主经 `extensionVars` 塞进来的值可能是）→ 递归 ——
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = plainScriptValue(item, `${path}.${key}`, depth + 1);
    }
    return out;
  }

  // —— 其余类实例：抛，不静默转 `{}` ——
  throw stateShapeInvalid(
    `script result at ${path} is a '${(value as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'}' instance and cannot be stored as plain data`,
    {
      path,
      kind: 'class-instance',
      hint: '引擎不猜怎么把类实例变成数据：请让脚本返回标量 / 列表 / context，或改用 handlers 自己实现',
    },
  );
}

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
  /**
   * FEEL 的求值结果（**可能是 `null`** —— 三值语义的合法值，不抛）。
   *
   * ★ **已归一化为纯数据**（D-93）：context 会先摊平成 plain object 再返回，
   *   调用方拿到的值可以直接写进 `InstanceState.variables`，不必再验一遍可序列化。
   */
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
 * @throws `ENGINE_STATE_SHAPE_INVALID` —— 结果不是能落库的纯数据（类实例 / 超深嵌套，D-93）
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
  // ★ 归一化放在**求值出口**而不是落库之前：出口只有这一处，漏不掉
  return { value: plainScriptValue(result.value), warnings: [...result.warnings] };
}
