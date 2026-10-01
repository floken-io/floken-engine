/**
 * T14 · 条件求值（`03-engine` §7 / §8.3，出口判据 **AC-E9**）
 *
 * ★ 本文件的判据只有一条，但它是**双向**的：
 *   ① 能求值的必须求对（§7.2 承诺下限逐条跑）；
 *   ② 求不了值的**必须抛错** —— **绝不返回 `false`**（「表达式出错却返回 false」=
 *      流程静默走错分支，比抛错危险十倍）。
 *
 * 第 ② 条对**注入的自定义 handler 同样生效**（无豁免），故下面有一整组
 * 「坏 handler」用例：抛错要原样传播、返回 undefined/字符串要被挡住。
 */
import { describe, expect, it } from 'vitest';

import { createFeelConditionHandler, evaluateCondition } from '../src/eval/condition';
import type { FeelConditionOptions } from '../src/eval/condition';
import { ENGINE_ERROR_CODES } from '../src/core/errors';
import type { ConditionCtx, ConditionHandler } from '../src/core/spi';
import { expectCode, expectCodeAsync } from './helpers/expect';

const ctxOf = (variables: Record<string, unknown>): ConditionCtx => ({
  instanceId: 'pi_1',
  nodeId: 'Gateway_1',
  variables,
});

const feel = createFeelConditionHandler();
/**
 * ⚠️ 返回类型**刻意是 `unknown`**：`ConditionHandler.evaluate` 的契约是
 * `boolean | Promise<boolean>`，若这里声明成 `boolean` 就把「内置实现是同步的」这件事
 * 写成了类型断言 —— 用 `expect(...).toBe(true)` 断言，顺带把「不是 Promise」也验了。
 */
const evalSync = (src: string, variables: Record<string, unknown> = {}): unknown =>
  feel.evaluate(src, ctxOf(variables));

describe('内置默认 ConditionHandler —— §7.2 承诺下限（下限，不是上限）', () => {
  it('比较：`amount > 5000`', () => {
    expect(evalSync('amount > 5000', { amount: 6000 })).toBe(true);
    expect(evalSync('amount > 5000', { amount: 1000 })).toBe(false);
    expect(evalSync('amount >= 5000', { amount: 5000 })).toBe(true);
    expect(evalSync('amount != 5000', { amount: 5000 })).toBe(false);
  });

  it('布尔：`and` / `or` / `not`', () => {
    expect(evalSync('urgent and amount > 5000', { urgent: true, amount: 9000 })).toBe(true);
    expect(evalSync('urgent and amount > 5000', { urgent: true, amount: 100 })).toBe(false);
    expect(evalSync('not(urgent) or amount > 5000', { urgent: true, amount: 9000 })).toBe(true);
  });

  it('区间：`[a..b]` 闭、`(a..b)` 开', () => {
    expect(evalSync('days in [3..5]', { days: 4 })).toBe(true);
    expect(evalSync('days in [3..5]', { days: 3 })).toBe(true);
    expect(evalSync('days in (3..5)', { days: 3 })).toBe(false);
    expect(evalSync('days in [3..5]', { days: 6 })).toBe(false);
  });

  it('空值：`null` 参与比较是三值语义，不是二值', () => {
    expect(evalSync('reason = null', { reason: null })).toBe(true);
    expect(evalSync('reason = null', { reason: 'x' })).toBe(false);
  });

  it('内置函数至少：`not` / `contains` / `list contains` / `count` / `sum`', () => {
    expect(evalSync('not(flag)', { flag: false })).toBe(true);
    expect(evalSync('contains("abcdef", "cd")')).toBe(true);
    expect(evalSync('list contains(roles, "manager")', { roles: ['dev', 'manager'] })).toBe(true);
    expect(evalSync('count(roles) > 1', { roles: ['a', 'b'] })).toBe(true);
    expect(evalSync('sum(scores) > 10', { scores: [4, 5, 6] })).toBe(true);
  });

  it('变量引用：直接写名字 + 路径（`order.amount`），不是 `${...}`', () => {
    expect(evalSync('order.amount > 100', { order: { amount: 200 } })).toBe(true);
    expect(evalSync('dept = "IT"', { dept: 'IT' })).toBe(true);
  });

  it('★ D-37 反证：裸 `true` 必须是 true（unary tests 顶层语义会判成 false）', () => {
    // `unaryTest('true')` 会把 `true` 解析成 `? = true` 与未定义的 `?` 比较 → false。
    // 网关条件没有「单一输入值」，用 unary 语义等于把「无条件走」写成「永不走」。
    expect(evalSync('true')).toBe(true);
    expect(evalSync('false')).toBe(false);
  });
});

describe('AC-E9 ①：解析不了的语法 → 抛错，不返回 false', () => {
  it('`amount >` → 抛 FEEL 语法错（不是 false）', () => {
    const e = expectCode(() => evalSync('amount >'), 'FEEL_SYNTAX_UNEXPECTED_TOKEN');
    expect(e.message).toMatch(/Unexpected token/);
  });

  it('`${...}`（JUEL）→ 抛 `ENGINE_OPTION_INVALID` 并指名是 JUEL', () => {
    const e = expectCode(
      () => evalSync('${variables.amount > 5000}', { amount: 6000 }),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
    expect(e.details).toMatchObject({
      option: 'condition',
      expression: '${variables.amount > 5000}',
      hintKind: 'juel',
    });
  });

  it('★ 语法错绝不退化成 false —— 逐个坏表达式都抛', () => {
    for (const bad of ['amount >', '((1', 'and and', '"unterminated']) {
      expect(() => evalSync(bad), `坏表达式应当抛错：${bad}`).toThrow();
    }
  });
});

describe('AC-E9 ②：三值 → 二值（`null` 抛错，不静默 false）', () => {
  it('★ 变量缺失 → 求值为 null → 抛（unary 语义下这里会静默返回 true）', () => {
    const e = expectCode(
      () => evalSync('amount > 5000'),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
    expect(e.details?.option).toBe('condition');
    // feel 的「变量找不到」诊断原样透传，便于宿主定位拼错的变量名
    expect(JSON.stringify(e.details?.warnings)).toContain('FEEL_EVAL_NO_VARIABLE');
  });

  it('非布尔结果 → 抛', () => {
    const e = expectCode(() => evalSync('"abc"'), ENGINE_ERROR_CODES.OPTION_INVALID);
    expect(e.details).toMatchObject({ value: 'abc' });
  });

  it('区间字面量（没有 `in`）→ 不是布尔 → 抛', () => {
    expectCode(() => evalSync('[3..5]'), ENGINE_ERROR_CODES.OPTION_INVALID);
  });
});

describe('D-42：空 / 空白 = 无条件（BPMN 的既有语义）', () => {
  it("'' 与 '   ' → true", () => {
    expect(evalSync('')).toBe(true);
    expect(evalSync('   ')).toBe(true);
  });
});

describe('FeelConditionOptions：白名单收窄（默认不收窄）', () => {
  it('默认可用白名单外的具名函数（引擎能力 = 完整 feel）', () => {
    const opts: FeelConditionOptions = {};
    expect(createFeelConditionHandler(opts).evaluate('count(x) > 1', ctxOf({ x: [1, 2] }))).toBe(
      true,
    );
  });

  it('传 `allowedFunctions` → 白名单外的具名函数抛 `FEEL_NOT_ALLOWED_*`', () => {
    const narrow = createFeelConditionHandler({ allowedFunctions: ['not'] });
    expect(narrow.evaluate('not(flag)', ctxOf({ flag: false }))).toBe(true);
    expectCode(() => narrow.evaluate('count(x) > 1', ctxOf({ x: [1, 2] })), 'FEEL_NOT_ALLOWED_FUNCTION');
  });
});

describe('evaluateCondition()：第 0 层要求对任何实现生效（无豁免）', () => {
  it('注入的 handler 抛错 → **原样传播**（不降级为 false）', async () => {
    const boom = new Error('宿主求值器炸了');
    const handler: ConditionHandler = {
      evaluate() {
        throw boom;
      },
    };
    let caught: unknown;
    try {
      await evaluateCondition(handler, 'amount > 1', ctxOf({}));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(boom); // ★ 同一个实例：引擎没有包装、没有吞
  });

  it('注入的 handler 返回 rejected promise → 传播', async () => {
    const boom = new Error('async 炸了');
    const handler: ConditionHandler = {
      evaluate() {
        return Promise.reject(boom);
      },
    };
    let caught: unknown;
    try {
      await evaluateCondition(handler, 'amount > 1', ctxOf({}));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(boom);
  });

  it('★ 注入的 handler 返回 undefined → 抛（「求值失败返回空」不得静默成不走）', async () => {
    const handler: ConditionHandler = {
      evaluate() {
        return undefined as unknown as boolean;
      },
    };
    const e = await expectCodeAsync(
      evaluateCondition(handler, 'amount > 1', ctxOf({})),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
    expect(e.details).toMatchObject({ handler: 'injected', value: null });
  });

  it('注入的 handler 返回字符串 → 抛', async () => {
    const handler: ConditionHandler = {
      evaluate() {
        return 'yes' as unknown as boolean;
      },
    };
    await expectCodeAsync(
      evaluateCondition(handler, 'amount > 1', ctxOf({})),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
  });

  it('注入的 async handler 返回 true / false → 照常', async () => {
    const handler: ConditionHandler = {
      async evaluate(src) {
        return src.length > 0;
      },
    };
    expect(await evaluateCondition(handler, 'x', ctxOf({}))).toBe(true);
    expect(await evaluateCondition(handler, '', ctxOf({}))).toBe(false);
  });

  it('ctx 原样传给 handler（instanceId / nodeId / variables）', async () => {
    const seen: ConditionCtx[] = [];
    const handler: ConditionHandler = {
      evaluate(_src, c) {
        seen.push(c);
        return true;
      },
    };
    const c = ctxOf({ amount: 6000 });
    await evaluateCondition(handler, 'amount > 5000', c);
    expect(seen[0]).toEqual(c);
  });
});
