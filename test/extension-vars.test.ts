/**
 * ★ ADR-009：宿主自定义扩展属性（`node.extension['acme:*']`）→ 引擎。
 *
 * 九条细则里，本文件逐个钉死最容易被"做歪"的几条：
 *   ① 只读字段**恒给**（不配置也有）      —— 用例 1 / 2
 *   ③ `floken:*` 不外泄                  —— 用例 3
 *   ④ 只给标量（结构化值跳过）            —— 用例 4
 *   ⑤ 默认**不并入** `variables`          —— 用例 1 / 5
 *   ⑥ opt-in 后挂成 `node` / `target`     —— 用例 6
 *   ⑦ 变量名冲突 → 抛错（不静默覆盖）      —— 用例 7
 *   ⑧ cast 还原类型 / 转不动就抛           —— 用例 8 / 9
 *   ⑨ 不入 `state.variables`              —— 用例 5
 *
 * ⚠️ 判据一律是**可观测行为**，不是"代码里写了"：并入与否看**待办落在哪个分支**。
 */
import { describe, expect, it } from 'vitest';

import { createEngine } from '../src/runtime/engine';
import type { ExtensionVarsOption } from '../src/runtime/engine';
import { ENGINE_ERROR_CODES } from '../src/core/errors';
import type { ConditionCtx } from '../src/core/spi';
import type { InstanceState } from '../src/core/state';
import { makeDefinition, userApproval } from './helpers/definition';
import { expectCode, expectCodeAsync } from './helpers/expect';

const T = '2026-10-02T04:00:00.000Z';

/**
 * 条件分支流程：
 * `Start_1 → GW →(target.priority = "high")→ Task_urgent →(…)→ End_1`
 *                 `→(无条件)→ Task_normal → End_1`
 *
 * - `GW` 自身挂 `acme:gwTag`（测 `nodeExtensions` = 当前节点）
 * - `Task_urgent` 挂 `acme:priority='high'` / `acme:slaHours`（字符串 "48"）/ **结构化值**（测跳过）
 * - 两个 Task 都带 `floken:approval`（测 `floken:*` 不被外泄）
 */
const def = () =>
  makeDefinition({
    id: 'Definitions_ext',
    version: 1,
    nodes: [
      { id: 'Start_1', type: 'startEvent' },
      {
        id: 'GW',
        type: 'exclusiveGateway',
        extension: { 'acme:gwTag': 'main' },
      },
      {
        id: 'Task_urgent',
        type: 'userTask',
        name: '加急',
        approval: userApproval('u_boss'),
        extension: {
          'acme:priority': 'high',
          'acme:slaHours': '48', // ★ 字符串（XML 往返后的真实形态）
          'acme:tags': ['finance'], // 结构化 → 应被跳过
          'acme:rule': { limit: 1 }, // 结构化 → 应被跳过
        },
      },
      {
        id: 'Task_normal',
        type: 'userTask',
        name: '普通',
        approval: userApproval('u_staff'),
        extension: { 'acme:priority': 'low' },
      },
      { id: 'End_1', type: 'endEvent' },
    ],
    flows: [
      { from: 'Start_1', to: 'GW' },
      { from: 'GW', to: 'Task_urgent', condition: 'target.priority = "high"' },
      { from: 'GW', to: 'Task_normal' },
      { from: 'Task_urgent', to: 'End_1' },
      { from: 'Task_normal', to: 'End_1' },
    ],
  });

/** 造引擎；`spy` 收集每次求值拿到的上下文 */
function engineWith(
  extensionVars: ExtensionVarsOption | undefined,
  spy: ConditionCtx[],
  extra: Record<string, unknown> = {},
) {
  return createEngine({
    definitionSource: { async getDefinition() { return def(); } },
    clock: () => T,
    ...(extensionVars === undefined ? {} : { extensionVars }),
    conditionHandler: {
      evaluate(expr, ctx) {
        spy.push(ctx);
        return expr.includes('target.priority = "high"')
          ? (ctx.variables as { target?: { priority?: string } }).target?.priority === 'high'
          : true;
      },
    },
    ...extra,
  });
}

const startIt = (e: ReturnType<typeof createEngine>, variables: Record<string, unknown> = {}) =>
  e.start('Process_1', { definitionVersion: 1, starter: 'u_x', variables });

describe('ADR-009 · 只读字段恒给（不配置也有）', () => {
  it('① `nodeExtensions` = 当前节点、`targetExtensions` = 分支目标节点', async () => {
    const spy: ConditionCtx[] = [];
    await startIt(engineWith(undefined, spy));
    const ctx = spy.find((c) => c.nodeId === 'GW');
    expect(ctx).toBeDefined();
    expect(ctx?.nodeExtensions).toEqual({ 'acme:gwTag': 'main' });
    expect(ctx?.targetExtensions).toEqual({ 'acme:priority': 'high', 'acme:slaHours': '48' });
  });

  it('③ `floken:*` 一律不外泄（引擎自己的键不进这两袋）', async () => {
    const spy: ConditionCtx[] = [];
    await startIt(engineWith(undefined, spy));
    for (const c of spy) {
      for (const bag of [c.nodeExtensions, c.targetExtensions]) {
        for (const key of Object.keys(bag ?? {})) {
          expect(key.startsWith('floken:')).toBe(false);
        }
      }
    }
  });

  it('④ 只给标量：数组 / 对象被跳过（与 XML 层同口径）', async () => {
    const spy: ConditionCtx[] = [];
    await startIt(engineWith(undefined, spy));
    const ctx = spy.find((c) => c.targetExtensions?.['acme:priority'] === 'high');
    expect(ctx?.targetExtensions).toBeDefined();
    expect(ctx?.targetExtensions?.['acme:tags']).toBeUndefined();
    expect(ctx?.targetExtensions?.['acme:rule']).toBeUndefined();
  });

  it('⑤⑨ 默认**不并入** `variables`，且**绝不写回** state（细则⑨）', async () => {
    const spy: ConditionCtx[] = [];
    const saved: InstanceState[] = [];
    const e = engineWith(undefined, spy, {
      store: {
        async load() { return null; },
        async save(next: InstanceState) { saved.push(next); },
      },
    });
    await startIt(e);
    for (const c of spy) {
      expect(Object.prototype.hasOwnProperty.call(c.variables, 'node')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(c.variables, 'target')).toBe(false);
    }
    // ★ 落库的每一版状态里都不能出现并入层 —— 否则状态膨胀且快照里存两份真相
    expect(saved.length).toBeGreaterThan(0);
    for (const s of saved) {
      expect(Object.prototype.hasOwnProperty.call(s.variables, 'node')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(s.variables, 'target')).toBe(false);
    }
  });
});

describe('ADR-009 · opt-in 并入（细则⑥⑦⑧）', () => {
  it('⑥ 挂成 `variables.node` / `variables.target`，**键已去前缀**（FEEL 只能引用无冒号的名字）', async () => {
    const spy: ConditionCtx[] = [];
    const e = engineWith({}, spy);
    await startIt(e);
    const ctx = spy.find((c) => c.nodeId === 'GW');
    // ★ 实测：`target.acme:priority` 语法错、`target["acme:priority"]` 求值为 null —— 带冒号引用不到
    expect(ctx?.variables).toMatchObject({
      node: { gwTag: 'main' },
      target: { priority: 'high', slaHours: '48' },
    });
  });

  it('⑥★ 端到端：**内置 FEEL** 写 `target.priority = "high"` 真能选中加急分支（不用注入 handler）', async () => {
    const seen: string[] = [];
    const e = createEngine({
      definitionSource: { async getDefinition() { return def(); } },
      clock: () => T,
      extensionVars: {},
      projection: {
        async apply(_id, delta) { for (const v of delta.added) seen.push(`${v.nodeId}/${v.assignee}`); },
        async sync() { /* 无对账场景 */ },
      },
    });
    await startIt(e);
    // ★ 判据是**真走了哪条分支**，不是"代码里调了并入函数"
    expect(seen).toEqual(['Task_urgent/u_boss']);
  });

  it('⑥★ 反例（★ 行为钉死）：不 opt-in 却在表达式里写 `target.*` → **不报错、静默走另一条分支**', async () => {
    /*
     * ⚠️ 这条不是在断言"正确的行为"，而是把**当前真实行为钉住**，好让文档能如实警示：
     * `target` 未定义时 `target.priority = "high"` 求值为 **false**（等值比较：null ≠ "high"），
     * 于是流程**安静地走了普通分支** —— 既不是抛错，也不是走对。
     * （对比 `amount > 5000` 缺变量求值为 null → 按 D-38 抛错；等值比较与关系运算的三值语义不同。）
     * 引擎**不解析表达式**去猜"你是不是想引用扩展属性"，故这条只能靠宿主 opt-in 来避免。
     */
    const seen: string[] = [];
    const e = createEngine({
      definitionSource: { async getDefinition() { return def(); } },
      clock: () => T,
      projection: {
        async apply(_id, delta) { for (const v of delta.added) seen.push(`${v.nodeId}/${v.assignee}`); },
        async sync() { /* 无对账场景 */ },
      },
    });
    await startIt(e);
    expect(seen).toEqual(['Task_normal/u_staff']); // ★ 静默走错分支：这就是不 opt-in 的代价
  });

  it('⑥ 去前缀后同名（两个命名空间撞名）→ 抛 `OPTION_INVALID`，不静默二选一', async () => {
    const clash = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'GW', type: 'exclusiveGateway' },
        {
          id: 'Task_a',
          type: 'userTask',
          name: 'A',
          approval: userApproval('u_a'),
          extension: { 'acme:level': 'high', 'hr:level': 'low' }, // 去前缀后都叫 level
        },
        { id: 'Task_b', type: 'userTask', name: 'B', approval: userApproval('u_b') },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'GW' },
        { from: 'GW', to: 'Task_a', condition: 'target.level = "high"' },
        { from: 'GW', to: 'Task_b' },
        { from: 'Task_a', to: 'End_1' },
        { from: 'Task_b', to: 'End_1' },
      ],
    });
    const e = createEngine({
      definitionSource: { async getDefinition() { return clash; } },
      clock: () => T,
      extensionVars: {},
    });
    const err = await expectCodeAsync(() => startIt(e), ENGINE_ERROR_CODES.OPTION_INVALID);
    expect(String(err.details?.reason)).toContain('level');
  });

  it('⑥ 条件写 `node.*` 也能用（当前节点自己的属性）', async () => {
    const spy: ConditionCtx[] = [];
    const e = createEngine({
      definitionSource: { async getDefinition() { return def(); } },
      clock: () => T,
      extensionVars: {},
      conditionHandler: {
        evaluate(_expr, ctx) {
          spy.push(ctx);
          return (ctx.variables as { node?: { gwTag?: string } }).node?.gwTag === 'main';
        },
      },
    });
    await startIt(e);
    expect(spy.length).toBeGreaterThan(0);
  });

  it('⑦ 变量名撞车 → 抛 `OPTION_INVALID`（不静默覆盖业务变量）', async () => {
    const e = engineWith({}, []);
    const err = await expectCodeAsync(
      () => startIt(e, { node: { mine: 1 } }),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
    // ⚠️ 断言 details 而不是 message（`AGENTS.md` §5.6：message 面向人、details 面向程序）
    expect(String(err.details?.reason)).toContain('node');
  });

  it('⑧ cast：声明 number 后 `"48"` 变 48（不声明就是字符串 —— 引擎不猜类型）', async () => {
    const spy: ConditionCtx[] = [];
    const e = engineWith({ casts: { 'acme:slaHours': 'number' } }, spy);
    await startIt(e);
    const ctx = spy.find((c) => c.nodeId === 'GW');
    expect(ctx?.variables).toMatchObject({ target: { slaHours: 48 } });
    expect(typeof (ctx?.variables as { target: { slaHours: unknown } }).target.slaHours).toBe('number');
  });

  it('⑧ cast 转不动 → 抛 `OPTION_INVALID`（不是静默原样返回）', async () => {
    const spy: ConditionCtx[] = [];
    const bad = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'GW', type: 'exclusiveGateway' },
        {
          id: 'Task_a',
          type: 'userTask',
          name: 'A',
          approval: userApproval('u_a'),
          extension: { 'acme:slaHours': 'soon' }, // 不是数字
        },
        { id: 'Task_b', type: 'userTask', name: 'B', approval: userApproval('u_b') },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'GW' },
        { from: 'GW', to: 'Task_a', condition: 'target.priority = "high"' },
        { from: 'GW', to: 'Task_b' },
        { from: 'Task_a', to: 'End_1' },
        { from: 'Task_b', to: 'End_1' },
      ],
    });
    const e = createEngine({
      definitionSource: { async getDefinition() { return bad; } },
      clock: () => T,
      extensionVars: { casts: { 'acme:slaHours': 'number' } },
      conditionHandler: {
        evaluate(_expr, ctx) { spy.push(ctx); return true; },
      },
    });
    await expectCodeAsync(
      () => startIt(e),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
  });
});

describe('ADR-009 · 配置形状（禁止静默忽略，D-7 同款）', () => {
  it('未知键 → `OPTION_UNKNOWN`', () => {
    expectCode(
      () =>
        createEngine({
          definitionSource: { async getDefinition() { return def(); } },
          extensionVars: { nope: 1 } as unknown as ExtensionVarsOption,
        }),
      ENGINE_ERROR_CODES.OPTION_UNKNOWN,
    );
  });

  it('`casts` 取值非法 → `OPTION_INVALID`（写错成 "int" 不会退化成"不转换"）', () => {
    expectCode(
      () =>
        createEngine({
          definitionSource: { async getDefinition() { return def(); } },
          extensionVars: { casts: { 'acme:x': 'int' } } as unknown as ExtensionVarsOption,
        }),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
  });

  it('`key` 带 "." → `OPTION_INVALID`（FEEL 路径会被误解成嵌套取值）', () => {
    expectCode(
      () =>
        createEngine({
          definitionSource: { async getDefinition() { return def(); } },
          extensionVars: { key: 'a.b' },
        }),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
  });
});

describe('ADR-009 · 默认语义零变化（0.0.1 → 0.0.2 不 breaking）', () => {
  it('不声明 `extensionVars` 时，`variables` 与 0.0.1 逐字一致（只多两个只读字段）', async () => {
    const spy: ConditionCtx[] = [];
    await startIt(engineWith(undefined, spy), { amount: 9000 });
    const ctx = spy.find((c) => c.nodeId === 'GW');
    expect(ctx?.variables).toEqual({ amount: 9000 });
  });
});
