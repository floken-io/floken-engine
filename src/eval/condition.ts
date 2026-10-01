/**
 * 条件求值 —— 网关分支 / 顺序流的 `conditionExpression`（`03-engine` §7 与 §8.3）。
 *
 * 出口判据 **AC-E9**：`@floken-io/feel` **解析不了**的语法 → **抛错**，不返回 `false`；
 * 该要求对**注入的自定义 `conditionHandler` 同样生效**（无豁免）。
 *
 * ★ 三条硬约束（改本档前先默念）：
 *   ① **求值失败必须抛错**，绝不静默返回 `false` —— 表达式出错却返回 false 会让流程
 *      **静默走错分支**，比抛错危险十倍（`03-engine` §7.2）；
 *   ② **不得自带求值器** —— S-FEEL 来自 `@floken-io/feel`（§7.4(2) 的反面教材：
 *      同作者手上有 FEEL，流程侧却退化成字符串模板，最后只能宿主注入 JS）；
 *   ③ **不 import 时态** —— Q33：`dist` 产物不得出现 temporal（`tooling/verify.mjs` 的
 *      `check:deps` 守）。本档只用 `evaluate()`，不碰 `@floken-io/feel/temporal`。
 *
 * ★ 分层：`eval/` 是域层，可 import `core/`；**`core/` 不得反向 import `eval/`**。
 */

import { evaluate } from '@floken-io/feel';
import type { EvaluateOptions } from '@floken-io/feel';

import { conditionInvalid } from '../core/errors.js';
import type { ConditionCtx, ConditionHandler } from '../core/spi.js';

/**
 * JUEL 插值（`${variables.foo}`）—— **不是 FEEL**。
 * Camunda 7 的写法；本引擎执行 FEEL，变量**直接写名字**（`amount` / `order.amount`）。
 * `03-engine` §7.2：出现即**越界抛错**，不静默求值、也不做隐式转换。
 *
 * ★ 导出给 `eval/script.ts` 复用：脚本任务与条件走**同一条**越界判定
 *   （两处各写一份正则，必然有一处漏 —— 而漏的表现是"JUEL 被当成 FEEL 静默求值"）。
 */
export const JUEL_INTERPOLATION = /\$\{/;

/**
 * ★ 越界拦截：**先于**解析器。
 *
 * 不拦的话 `@floken-io/feel` 只会报 `Unexpected character '$'`（指向**错因**而不是**错类**），
 * 拦了才有「这是 JUEL 不是 FEEL」的可执行修复建议。
 */
export function assertNotJuel(source: string, where: 'condition' | 'script'): void {
  if (!JUEL_INTERPOLATION.test(source)) return;
  throw conditionInvalid(
    source,
    'JUEL 插值 ${...} 不是 FEEL 语法',
    { hintKind: 'juel', where },
  );
}

/**
 * 内置 `ConditionHandler` 的可调项（透传给 `@floken-io/feel` 的 `EvaluateOptions`）。
 *
 * ⚠️ 这里**刻意不默认开启 `allowedFunctions`**：`03-engine` §7.2 那张表是「**承诺下限**，
 * 不是能力上限」，引擎实际能力 = **完整 `@floken-io/feel`**。想收紧到 S-FEEL 子集的宿主
 * 自己传白名单 —— 那是**收窄**动作，不该由引擎替他做。
 */
export interface FeelConditionOptions {
  /**
   * S-FEEL 子集白名单：设置后，调用白名单外的**具名**函数 → `@floken-io/feel` 抛
   * `FeelNotAllowedError`（`FEEL_NOT_ALLOWED_*`）。**默认不设**。
   */
  readonly allowedFunctions?: readonly string[];
  /** AST 节点数上限（防构造型攻击） */
  readonly maxNodes?: number;
  /** 表达式嵌套深度上限 */
  readonly maxDepth?: number;
  /** 协作式超时（毫秒）；仅在求值步之间的检查点生效 */
  readonly timeoutMs?: number;
}

/**
 * 内置默认 `ConditionHandler`（**不注入即用它** —— `NFR-E10`「零配置可跑」）。
 *
 * 语义 = **FEEL 表达式**（`evaluate()`），不是 unary tests 的顶层判定 —— 见 **D-37**：
 * `unaryTest()` 的顶层语义是「输入值 `?` 是否满足该测试」，而网关条件**没有单一输入值**，
 * 实测两个方向都是静默错误：裸 `true` → `false`（被当成 `? = true`）、
 * 变量缺失 → `true`（`amount > 5000` 在空上下文里恒真）。
 *
 * @example
 * createFeelConditionHandler().evaluate('amount > 5000', ctx) // → true / false
 */
export function createFeelConditionHandler(options: FeelConditionOptions = {}): ConditionHandler {
  const feel: EvaluateOptions = {
    ...(options.allowedFunctions !== undefined
      ? { allowedFunctions: [...options.allowedFunctions] }
      : {}),
    ...(options.maxNodes !== undefined ? { maxNodes: options.maxNodes } : {}),
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };

  return {
    evaluate(expression: string, ctx: ConditionCtx): boolean {
      // ① `${...}`：先于解析器拦截，好给出「这是 JUEL 不是 FEEL」的可执行修复建议。
      //    （不拦的话 feel 只会报 `Unexpected character '$'`，指向错因而不是错类。）
      assertNotJuel(expression, 'condition');

      // ② 空 / 空白 = **无条件**（BPMN 的既有语义：无 `conditionExpression` 的顺序流即默认流）。
      //    只有 trim 后为空才走这条；写坏了（`amount >`）照旧抛语法错 —— 见 **D-42**。
      const src = expression.trim();
      if (src === '') return true;

      // ③ 求值。语法错 → feel 抛 `FeelSyntaxError`，**原样向上**（不 catch、不降级）。
      const result = evaluate(src, ctx.variables as Record<string, unknown>, feel);

      // ④ 三值 → 二值：`null`（未知）**抛错**，不静默转 false（**D-38**）。
      //    网关分支的真值只有「走 / 不走」，「未知」没有对应的行为。
      if (typeof result.value !== 'boolean') {
        throw conditionInvalid(
          expression,
          result.value === null || result.value === undefined
            ? '求值为 null（未知）—— 网关条件必须是 true / false'
            : `求值结果不是布尔值（${typeof result.value}）`,
          {
            value: result.value ?? null,
            warnings: [...result.warnings],
          },
        );
      }

      return result.value;
    },
  };
}

/**
 * ★ 条件求值的**唯一入口**（引擎内部任何地方都不得绕过它直接调 `handler.evaluate`）。
 *
 * 第 0 层要求（`AC-E9`，**对任何实现生效、无豁免**）就落在这一个函数里：
 *   - 实现**抛错** → **原样传播**（不 try/catch、不降级为 `false`）；
 *   - 实现返回 `Promise` 且 reject → 同样传播；
 *   - 实现返回**非布尔值**（含 `null` / `undefined` / 字符串）→ 抛 `OPTION_INVALID`。
 *
 * 把它做成函数而不是「纪律」的理由：宿主注入的 `conditionHandler` 是他自己的代码，
 * 引擎管不了他里面写什么 —— 但**出口**必须归引擎管，否则「注入了一个会返回 undefined 的
 * 求值器」会表现成「分支永远不走」且毫无报错。
 */
export async function evaluateCondition(
  handler: ConditionHandler,
  expression: string,
  ctx: ConditionCtx,
): Promise<boolean> {
  // ⚠️ 这里**刻意不包 try/catch**：求值失败必须让调用方看见（AC-E9 无豁免）。
  //    加 catch 再 rethrow 除了增加一层栈、什么也没守住。
  const value = await handler.evaluate(expression, ctx);
  if (typeof value !== 'boolean') {
    throw conditionInvalid(
      expression,
      value === null || value === undefined
        ? 'conditionHandler 返回了 null / undefined —— 求值失败必须抛错，不得返回空'
        : `conditionHandler 返回了非布尔值（${typeof value}）`,
      { value: value ?? null, handler: 'injected' },
    );
  }
  return value;
}

// ---------------- "还没求值"的哨兵（T16 网关接线的关键接缝） ----------------

/**
 * ★ **条件尚未求值**的哨兵（**不是** 19 个抛出码之一，也不进 `EngineError` 家族）。
 *
 * 为什么需要它 —— 这是 T16 唯一的结构性难题：
 *   - `ConditionHandler` 是**异步** SPI（宿主可能查库），而 `runToWait()` 必须**同步纯**（NFR-E6）；
 *   - 于是 `plan()` / `step()` 拿到的只能是一个**同步闭包** `conditionsOf(flow)`。
 *   两个显而易见的写法都是错的：
 *     ① **预先把全图条件求值一遍** —— 那些分支引用的变量此刻可能还不存在
 *        （`amount` 要第二步的表单才填），按 D-38（`null` 必抛）流程会在**第一步就炸**，
 *        而它本来根本走不到那个分支；
 *     ② **闭包缺值时默认 `false`** —— 静默走错分支，正是 §7.2 要防的头号事故。
 *
 *   故：缺值就**抛本哨兵**，`runtime/engine.ts` 捕获它 → 异步求值 → **重跑**。
 *   每轮至少多解析一条，轮数 ≤ 条件数 + 1 ⇒ 必然收敛，且**只求本次真正走到的条件**。
 *
 * ⚠️ 它不是错误契约的一部分，宿主**不会**从公开 API 收到它（引擎吞掉并重试）；
 *   门 2 自编排下宿主自己提供 `conditionsOf` 闭包，是否用本哨兵由他决定。
 */
export class ConditionUnresolved extends Error {
  override readonly name = 'ConditionUnresolved';
  /** 内部信号：便于与其它错误一眼区分（不依赖 instanceof，跨包/跨产物都稳） */
  readonly unresolved = true;
  readonly flowId: string;
  readonly expression: string;
  readonly nodeId: string;
  /**
   * ★ **到达该网关那一刻**的变量快照（T17）。
   *
   * 为什么必须由哨兵带出来：解析发生在**重跑**里，那时拿不到"当时"的状态。
   * 若用提交前的旧变量去求值，`scriptTask` / `serviceTask` 在本次推进里改过的变量
   * 就被忽略了 —— 表现为「脚本把 amount 改成了 9000，网关却按旧值走了分支」。
   */
  readonly variables: Readonly<Record<string, unknown>>;

  constructor(
    flowId: string,
    expression: string,
    nodeId: string,
    variables: Readonly<Record<string, unknown>> = {},
  ) {
    super(`condition of flow '${flowId}' is not resolved yet`);
    this.flowId = flowId;
    this.expression = expression;
    this.nodeId = nodeId;
    this.variables = variables;
  }
}

/** 抛出哨兵（`conditionsOf` 闭包在缺值时用） */
export function unresolvedCondition(
  flowId: string,
  expression: string,
  nodeId: string,
  variables: Readonly<Record<string, unknown>> = {},
): ConditionUnresolved {
  return new ConditionUnresolved(flowId, expression, nodeId, variables);
}

/** 判定并取出哨兵内容；不是哨兵 → `undefined`（**原样交给上层，绝不吞**） */
export function asUnresolved(e: unknown): ConditionUnresolved | undefined {
  if (e instanceof ConditionUnresolved) return e;
  if (
    typeof e === 'object' &&
    e !== null &&
    (e as { unresolved?: unknown }).unresolved === true &&
    typeof (e as { flowId?: unknown }).flowId === 'string'
  ) {
    return e as ConditionUnresolved;
  }
  return undefined;
}
