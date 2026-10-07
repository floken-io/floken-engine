/**
 * ★ ADR-009：宿主自定义扩展属性（`node.extension`）→ 引擎。
 *
 * 九条细则里，本文件逐个钉死最容易被"做歪"的几条：
 *   ① 只读字段**恒给**（不配置也有）      —— 用例 1 / 2
 *   ③ 模型一等字段键不外泄                —— 用例 3
 *   ④ 结构化值**也给**（v2 放开）          —— 用例 4
 *   ⑤ 默认**不并入** `variables`          —— 用例 1 / 5
 *   ⑥ opt-in 后挂成 `node` / `target`     —— 用例 6
 *   ⑦ 变量名冲突 → 抛错（不静默覆盖）      —— 用例 7
 *   ⑧ cast 还原类型 / 转不动就抛           —— 用例 8 / 9
 *   ⑨ 不入 `state.variables`              —— 用例 5
 *
 * ⚠️ 判据一律是**可观测行为**，不是"代码里写了"：并入与否看**待办落在哪个分支**。
 *
 * ★ v2 口径：extension 的键**不带前缀**（`priority`，不是 `acme:priority`）。
 * 前缀是 XML 命名空间的遗留物，v2 已无此概念；且带冒号的键 **FEEL 引用不到**
 * （`x.a:b` 语法错、`x["a:b"]` 求值为 null），故并入层遇到冒号键直接抛错（用例 7b）。
 */
import { describe, expect, it } from 'vitest';

import { createEngine } from '../src/runtime/engine';
import { createMemoryStore } from '../src/store/memory';
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
 * - `GW` 自身挂 `gwTag`（测 `nodeExtensions` = 当前节点）
 * - `Task_urgent` 挂 `priority='high'` / `slaHours`（字符串 "48"）/ **结构化值**（v2 也给）
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
        extension: { gwTag: 'main' },
      },
      {
        id: 'Task_urgent',
        type: 'userTask',
        name: '加急',
        approval: userApproval('u_boss'),
        extension: {
          priority: 'high',
          slaHours: '48', // ★ 字符串（作者这么写就存成字符串，JSON 不强制类型）
          tags: ['finance'], // 结构化值
          rule: { limit: 1 }, // 结构化值
        },
      },
      {
        id: 'Task_normal',
        type: 'userTask',
        name: '普通',
        approval: userApproval('u_staff'),
        extension: { priority: 'low' },
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
    expect(ctx?.nodeExtensions).toEqual({ gwTag: 'main' });
    /*
     * ★ v2 起**结构化值也给出**（ADR-009 细则④ 已放开，2026-10-03）：
     * 旧口径"只给标量"的理由是「结构化值写不进 XML 属性」，那个理由随 moddle v2
     * 的 JSON-only 一起消失了。继续只给标量的代价是：宿主存得下 `rule:{limit:1}`，
     * 却读不进条件表达式。
     */
    expect(ctx?.targetExtensions).toEqual({
      priority: 'high',
      slaHours: '48',
      tags: ['finance'],
      rule: { limit: 1 },
    });
  });

  it('③ `extension` 是宿主的地盘：与一等字段**同名也照给**（引擎不筛选）', async () => {
    /*
     * ★ 用户 2026-10-06 质问：「自定义扩展键中出现什么都不奇怪吧，这是用户自己的」。
     * 对。v2 里一等字段在 `node.approval`，**不在** `node.extension` 里 ——
     * 所以袋里出现 `approval` 只可能是**宿主自己的业务数据**。
     * 引擎若按保留键把它剔除，就是**静默吃掉宿主的数据**，与"原样存取"的承诺矛盾。
     * （引擎侧这道排除逻辑已于 2026-10-06 删除；误用提示交给 moddle 的 warn 指路。）
     *
     * ⚠️ 这条曾经是"恒真空断言"：断言 `!key.startsWith('floken:')`，而测试数据里
     * 早就没有 `floken:` 键 —— 恒真，等于没测。现在改成真断言：塞进去真能读出来。
     */
    const withSameName = def() as unknown as { nodes: Array<Record<string, unknown>> };
    withSameName.nodes[2] = {
      ...withSameName.nodes[2]!,
      extension: { approval: '宿主自己的审批意见', call: 42, timeout: null, mine: 'ok' },
    };
    const spy: ConditionCtx[] = [];
    const e = createEngine({
      definitionSource: { async getDefinition() { return withSameName as never; } },
      clock: () => T,
      conditionHandler: { evaluate(_expr, ctx) { spy.push(ctx); return true; } },
    });
    await startIt(e);
    const ctx = spy.find((c) => c.targetExtensions !== undefined);
    expect(ctx).toBeDefined();
    // ★ 一个都不少、一个都没被改写
    expect(ctx?.targetExtensions).toEqual({
      approval: '宿主自己的审批意见',
      call: 42,
      timeout: null,
      mine: 'ok',
    });
  });

  it('④ v2：结构化值**也给**（只有函数排除）', async () => {
    const spy: ConditionCtx[] = [];
    await startIt(engineWith(undefined, spy));
    const ctx = spy.find((c) => c.targetExtensions?.['priority'] === 'high');
    expect(ctx?.targetExtensions).toBeDefined();
    // 数组与对象原样给出（moddle v2 的 extension 就是任意 JSON，类型天然保真）
    expect(ctx?.targetExtensions?.['tags']).toEqual(['finance']);
    expect(ctx?.targetExtensions?.['rule']).toEqual({ limit: 1 });
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
  it('⑥ 挂成 `variables.node` / `variables.target`，**键原样**（引擎不改写宿主键名）', async () => {
    const spy: ConditionCtx[] = [];
    const e = engineWith({}, spy);
    await startIt(e);
    const ctx = spy.find((c) => c.nodeId === 'GW');
    /*
     * ★ v1 曾在这里"去命名空间前缀"（`acme:priority` → `priority`）。v2 已删：
     * 无前缀概念，且去前缀会**静默截断**普通键（`order:id` → `id`）。
     * 现在写什么键就是什么键 —— 也正因为如此，键**不能带冒号**（见下一条用例）。
     */
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

  it('⑥★ 键里带冒号 → `OPTION_INVALID`（FEEL 引用不到，静默并入等于功能不存在）', async () => {
    /*
     * 实测（`tmp/ext-key-check.mjs`，直连 feel dist）：
     *   `target.acme:priority`        → FeelSyntaxError: Unexpected token ':'
     *   `target["acme:priority"]`     → null（[...] 是列表筛选，不是对象取键）
     * 所以"并进去了却读不出来"比"当场报错"糟得多 —— 这里必须抛。
     * （v1 靠"去前缀"绕过，代价是 `order:id` 被截成 `id`；v2 两者都不做，直接说清。）
     */
    const colon = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'GW', type: 'exclusiveGateway' },
        {
          id: 'Task_a',
          type: 'userTask',
          name: 'A',
          approval: userApproval('u_a'),
          extension: { 'acme:level': 'high' },
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
      definitionSource: { async getDefinition() { return colon; } },
      clock: () => T,
      extensionVars: {},
    });
    const err = await expectCodeAsync(() => startIt(e), ENGINE_ERROR_CODES.OPTION_INVALID);
    expect(String(err.details?.reason)).toContain('acme:level');
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
    const e = engineWith({ casts: { slaHours: 'number' } }, spy);
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
          extension: { slaHours: 'soon' }, // 声明了 number 却不是数字
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
      extensionVars: { casts: { slaHours: 'number' } },
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
          extensionVars: { casts: { x: 'int' } } as unknown as ExtensionVarsOption,
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

describe('ADR-009 · 不 opt-in 时零变化（向后语义）', () => {
  it('不声明 `extensionVars` 时，`variables` 只多两个只读字段，业务变量逐字不变', async () => {
    const spy: ConditionCtx[] = [];
    await startIt(engineWith(undefined, spy), { amount: 9000 });
    const ctx = spy.find((c) => c.nodeId === 'GW');
    expect(ctx?.variables).toEqual({ amount: 9000 });
  });
});

// ---------------- ★ D-94：副作用侧（`scriptTask` / `serviceTask`）同样并入 ----------------

/**
 * 一个 `scriptTask` / `serviceTask`，节点自身挂 `extension: { taxRate: 0.06 }`。
 *
 * ⚠️ 为什么单开一个流程：上面那套是**网关条件**流程（判据看"待办落在哪个分支"），
 *   而副作用的判据是「脚本算出来什么 / handler 收到什么」，观测点不同，
 *   硬塞进同一张图会让断言绕一大圈。
 */
const effectDef = (type: 'scriptTask' | 'serviceTask') =>
  makeDefinition({
    nodes: [
      { id: 'Start_1', type: 'startEvent' },
      {
        id: 'Calc_1',
        type,
        // ★ FEEL 里读并入的扩展属性；读不到是 `null`（不抛），正好做「默认不并入」的判据
        ...(type === 'scriptTask' ? { script: 'node.taxRate', scriptFormat: 'feel' } : {}),
        extension: { taxRate: 0.06 },
      },
      { id: 'End_1', type: 'endEvent' },
    ],
    flows: [
      { from: 'Start_1', to: 'Calc_1' },
      { from: 'Calc_1', to: 'End_1' },
    ],
  });

describe('ADR-009 · **D-94**：副作用侧（脚本 / 服务）与条件同一口径', () => {
  it('不 opt-in → 脚本读不到 `node`（默认行为逐字不变）', async () => {
    const store = createMemoryStore();
    const engine = createEngine({
      definitionSource: { async getDefinition() { return effectDef('scriptTask'); } },
      clock: () => T,
      store,
    });
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u_x' });
    const state = await store.load(id);
    expect(state?.variables.Calc_1).toBeNull();
  });

  it('★ opt-in 后脚本能读到 `node.taxRate`（此前**永远 null** 且不报错）', async () => {
    const store = createMemoryStore();
    const engine = createEngine({
      definitionSource: { async getDefinition() { return effectDef('scriptTask'); } },
      clock: () => T,
      extensionVars: {},
      store,
    });
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u_x' });
    const state = await store.load(id);
    expect(state?.variables.Calc_1).toBe(0.06);
  });

  it('★ opt-in 后 `serviceTask` 的 handler 也收到 `node`（第 1 参）', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const store = createMemoryStore();
    const engine = createEngine({
      definitionSource: { async getDefinition() { return effectDef('serviceTask'); } },
      clock: () => T,
      extensionVars: { key: 'node' },
      handlers: {
        get: () => async (vars) => {
          seen.push({ ...vars });
          return { ok: true };
        },
      },
      store,
    });
    await engine.start('Process_1', { definitionVersion: 1, starter: 'u_x', variables: { amount: 1000 } });
    expect(seen[0]).toEqual({ amount: 1000, node: { taxRate: 0.06 } });
  });

  it('不 opt-in 时 handler 收到的变量**一个键都不多**', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const store = createMemoryStore();
    const engine = createEngine({
      definitionSource: { async getDefinition() { return effectDef('serviceTask'); } },
      clock: () => T,
      handlers: {
        get: () => async (vars) => {
          seen.push({ ...vars });
          return { ok: true };
        },
      },
      store,
    });
    await engine.start('Process_1', { definitionVersion: 1, starter: 'u_x', variables: { amount: 1000 } });
    expect(seen[0]).toEqual({ amount: 1000 });
  });

  it('★ 并入键与已有变量撞车 → 抛（与条件同款，不静默覆盖）', async () => {
    const store = createMemoryStore();
    const engine = createEngine({
      definitionSource: { async getDefinition() { return effectDef('scriptTask'); } },
      clock: () => T,
      extensionVars: {},
      store,
    });
    await expectCodeAsync(
      engine.start('Process_1', {
        definitionVersion: 1,
        starter: 'u_x',
        variables: { node: '宿主自己的 node' },
      }),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
  });

  it('★ 并入只在求值上下文里：`state.variables` 里**不出现** `node`', async () => {
    const store = createMemoryStore();
    const engine = createEngine({
      definitionSource: { async getDefinition() { return effectDef('scriptTask'); } },
      clock: () => T,
      extensionVars: {},
      store,
    });
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u_x' });
    const state = await store.load(id);
    // 只有脚本结果（键 = 节点 id），没有 `node` / `taxRate`
    expect(Object.keys(state?.variables ?? {})).toEqual(['Calc_1']);
  });
});
