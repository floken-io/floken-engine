/**
 * T18 · 活动 / 子流程 4 类（`nodes/activities.ts`）
 *
 * 三种处置分别验到：
 *   ① `SubProcess` —— **建图时内嵌展开**，令牌走进去、再走出来；
 *   ② `CallActivity` —— **子实例 + 等待 + 自动回归**，版本按**绑定**取（INV-16）；
 *   ③ `AdHocSubProcess` / `Transaction` / 事件子流程 —— **显式抛错**并指名归属 FR。
 *
 * ★ 每条断言都对着 `ARCHITECTURE.md` §9 的 T18 验证项：
 *   「`SubProcess` 子令牌树正确归并 / `CallActivity` 版本绑定 + `childInstanceIds` 记录」。
 */
import type { FlowNode, ProcessDefinition } from '@floken-io/moddle';
import { describe, expect, it } from 'vitest';

import { findNonSerializableValue } from '../src/core/state.js';
import type { EngineEvent } from '../src/core/events.js';
import type { InstanceState } from '../src/core/state.js';
import {
  ACTIVITY_TYPES,
  CALL_RETURN_ACTION,
  SUBPROCESS_EXIT_TYPE,
  SUBPROCESS_PATH_SEP,
  activityBehaviorOf,
  assertActivitySupported,
  callInstanceIdOf,
  callReturnOf,
  callTargetOf,
  expandSubProcesses,
  isActivityType,
} from '../src/nodes/activities.js';
import { createProcessGraph } from '../src/nodes/graph.js';
import { createEngine } from '../src/runtime/engine.js';
import { tasksOf } from '../src/runtime/loop.js';
import { createMemoryStore } from '../src/store/memory.js';
import { makeDefinition, mapSource, userApproval } from './helpers/definition.js';
import type { TestFlow, TestNode } from './helpers/definition.js';
import { expectCode, expectCodeAsync } from './helpers/expect.js';

const T0 = '2026-10-01T00:00:00.000Z';

// ---------------- 夹具 ----------------

/** 走一遍 `makeDefinition` 拿到模型层形状，再喂给展开器 */
function flattenOf(nodes: readonly TestNode[], flows: readonly TestFlow[]) {
  const def = makeDefinition({ nodes, flows });
  const p = def.processes[0];
  if (p === undefined) throw new Error('fixture: no process');
  return expandSubProcesses(p.nodes ?? [], p.flows ?? []);
}

/** 一个「有内嵌子流程」的主流程：`Start_1 → Sub_1 → Task_2 → End_1` */
function mainWithSub(subExtra: Partial<TestNode> = {}): ProcessDefinition {
  return makeDefinition({
    nodes: [
      { id: 'Start_1', type: 'startEvent' },
      {
        id: 'Sub_1',
        type: 'subProcess',
        nodes: [
          { id: 'S_Start', type: 'startEvent' },
          { id: 'S_Task', type: 'userTask', name: '子流程审批', approval: userApproval('u_child') },
          { id: 'S_End', type: 'endEvent' },
        ],
        flows: [
          { from: 'S_Start', to: 'S_Task' },
          { from: 'S_Task', to: 'S_End' },
        ],
        ...subExtra,
      },
      { id: 'Task_2', type: 'userTask', name: '主管审批', approval: userApproval('u_boss') },
      { id: 'End_1', type: 'endEvent' },
    ],
    flows: [
      { from: 'Start_1', to: 'Sub_1' },
      { from: 'Sub_1', to: 'Task_2' },
      { from: 'Task_2', to: 'End_1' },
    ],
  });
}

/** 被调用的子流程；`taskId` 用来区分 v1 / v2（版本绑定的观测点） */
function subProcess(version: 1 | 2): ProcessDefinition {
  return makeDefinition({
    processId: 'Sub_Proc',
    version,
    nodes: [
      { id: 'S_Start', type: 'startEvent' },
      {
        id: version === 1 ? 'S_Task_v1' : 'S_Task_v2',
        type: 'userTask',
        name: `子流程任务 v${version}`,
        approval: userApproval(version === 1 ? 'u_v1' : 'u_v2'),
      },
      { id: 'S_End', type: 'endEvent' },
    ],
    flows: [
      { from: 'S_Start', to: version === 1 ? 'S_Task_v1' : 'S_Task_v2' },
      { from: version === 1 ? 'S_Task_v1' : 'S_Task_v2', to: 'S_End' },
    ],
  });
}

/** 被调用的子流程（**无人工节点** —— 一进去就跑完，用来验「立刻回归」） */
function autoSubProcess(): ProcessDefinition {
  return makeDefinition({
    processId: 'Auto_Proc',
    nodes: [
      { id: 'A_Start', type: 'startEvent' },
      { id: 'A_End', type: 'endEvent' },
    ],
    flows: [{ from: 'A_Start', to: 'A_End' }],
  });
}

/** 主流程：`Start_1 → Call_1 → Task_2 → End_1` */
function mainWithCall(call: Partial<TestNode> = {}): ProcessDefinition {
  return makeDefinition({
    nodes: [
      { id: 'Start_1', type: 'startEvent' },
      {
        id: 'Call_1',
        type: 'callActivity',
        calledElement: 'Sub_Proc',
        call: { version: 1 },
        ...call,
      },
      { id: 'Task_2', type: 'userTask', name: '主管审批', approval: userApproval('u_boss') },
      { id: 'End_1', type: 'endEvent' },
    ],
    flows: [
      { from: 'Start_1', to: 'Call_1' },
      { from: 'Call_1', to: 'Task_2' },
      { from: 'Task_2', to: 'End_1' },
    ],
  });
}

/** 引擎 + 内存 store + 事件收集 */
function harness(entries: Readonly<Record<string, ProcessDefinition>>) {
  const store = createMemoryStore();
  const events: EngineEvent[] = [];
  const engine = createEngine({
    definitionSource: mapSource(entries),
    store,
    clock: () => T0,
    events: { emit: (e) => void events.push(e) },
  });
  return { engine, store, events };
}

async function load(store: ReturnType<typeof createMemoryStore>, id: string): Promise<InstanceState> {
  const s = await store.load(id);
  expect(s, `实例 ${id} 应当存在`).not.toBeNull();
  return s as InstanceState;
}

// ---------------- ① 分类（穷举） ----------------

describe('① 4 类活动的分类（穷举）', () => {
  it('`ACTIVITY_TYPES` 就是那 4 个名字，且顺序与 `03` §6 一致', () => {
    expect([...ACTIVITY_TYPES]).toEqual([
      'subProcess',
      'adHocSubProcess',
      'transaction',
      'callActivity',
    ]);
  });

  it('`isActivityType` 只认这 4 个；`undefined` 不是活动', () => {
    for (const t of ACTIVITY_TYPES) expect(isActivityType(t)).toBe(true);
    expect(isActivityType('userTask')).toBe(false);
    expect(isActivityType('exclusiveGateway')).toBe(false);
    expect(isActivityType(undefined)).toBe(false);
  });

  it('`activityBehaviorOf`：只有 `callActivity` 是 `call`', () => {
    expect(activityBehaviorOf('callActivity')).toBe('call');
    for (const t of ['subProcess', 'adHocSubProcess', 'transaction']) {
      expect(activityBehaviorOf(t)).toBe('unsupported');
    }
    expect(activityBehaviorOf('userTask')).toBeUndefined();
    expect(activityBehaviorOf(undefined)).toBeUndefined();
  });

  /**
   * ★ 为什么运行期还能看到 `subProcess` 只有一个可能：正常的内嵌子流程**在建图时就已被展开**，
   *   剩下的必然是"没被展开"的那类（事件子流程）。这条断言把那个推理钉住。
   */
  it('★ 三类未实现的活动一律抛，且 `details.owner` 指名归属 FR', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['subProcess', 'FR-E24'],
      ['adHocSubProcess', 'FR-E18'],
      ['transaction', 'FR-E13'],
    ];
    for (const [type, owner] of cases) {
      const e = expectCode(
        () => assertActivitySupported(type, 'N_1', 'unsupported'),
        'ENGINE_STATE_SHAPE_INVALID',
      );
      expect(String(e.details?.owner)).toContain(owner);
      expect(e.details?.nodeId).toBe('N_1');
      expect(e.details?.type).toBe(type);
    }
  });

  it('`call` 与 `undefined`（不是活动）都不抛', () => {
    expect(() => assertActivitySupported('callActivity', 'N_1', 'call')).not.toThrow();
  });
});

// ---------------- ② ★ CallActivity 的版本绑定（INV-16） ----------------

describe('② ★ `callActivity` 的版本绑定（INV-16）', () => {
  const node = (extra: Partial<Record<string, unknown>>): FlowNode =>
    ({ id: 'C_1', type: 'callActivity', calledElement: 'Sub_Proc', ...extra }) as unknown as FlowNode;

  it('绑定了版本 → 返回 `{ processId, definitionVersion }`', () => {
    expect(callTargetOf(node({ extension: { 'floken:call': { version: 3 } } }))).toEqual({
      processId: 'Sub_Proc',
      definitionVersion: 3,
    });
  });

  it('不是 `callActivity` → `undefined`（不抛）', () => {
    expect(callTargetOf({ id: 'T_1', type: 'userTask' } as unknown as FlowNode)).toBeUndefined();
    expect(callTargetOf(undefined)).toBeUndefined();
  });

  /**
   * ★ 本条是 INV-16 的核心：**没有绑定就抛，绝不回退到"最新版"**。
   *   回退的代价是「主流程没改、子流程悄悄换了版本，在途实例行为随发布而变」，
   *   且它**没有任何报错**可循 —— 正是 AC-E10 要防的那件事。
   */
  it('★ 没绑定版本 → 抛（`STATE_SHAPE_INVALID`，不是静默取最新版）', () => {
    const e = expectCode(() => callTargetOf(node({})), 'ENGINE_STATE_SHAPE_INVALID');
    expect(e.message).toContain('version');
  });

  it('版本非法（0 / 负数 / 非整数 / 字符串）→ 抛', () => {
    for (const version of [0, -1, 1.5, '2']) {
      expectCode(
        () => callTargetOf(node({ extension: { 'floken:call': { version } } })),
        'ENGINE_STATE_SHAPE_INVALID',
      );
    }
  });

  it('缺 `calledElement` → 抛（不知道要调谁）', () => {
    const e = expectCode(
      () => callTargetOf({ id: 'C_1', type: 'callActivity', extension: { 'floken:call': { version: 1 } } } as unknown as FlowNode),
      'ENGINE_STATE_SHAPE_INVALID',
    );
    expect(e.message).toContain('calledElement');
  });
});

// ---------------- ③ 子实例 id 的确定性与唯一性 ----------------

describe('③ 子实例 id（确定性 + 重入不撞车）', () => {
  const base: InstanceState = {
    instanceId: 'pi_1',
    processId: 'P',
    definitionVersion: 1,
    status: 'running',
    rev: 1,
    stateSchema: 1,
    startedAt: T0,
    updatedAt: T0,
    tokens: [],
    completedNodes: [],
    variables: {},
    auditTrail: [],
  };

  it('同 (父, 节点, 令牌) → 恒等（纯函数可算，与执行顺序无关）', () => {
    expect(callInstanceIdOf(base, 'Call_1', 'tk_start')).toBe('pi_1::Call_1::tk_start');
  });

  /**
   * ★ 循环回到同一个 `callActivity`（驳回重办）时基名会完全相同 ——
   *   直接复用的话 `save(next, 0)` 会撞 `ENGINE_PERSIST_ALREADY_EXISTS`，
   *   表现是"第二次走到子流程就报一个跟流程毫无关系的存储错"。
   */
  it('★ 重入加序号：已有 N 个同名 → 第 N+1 个带 `#N`', () => {
    const one: InstanceState = { ...base, childInstanceIds: ['pi_1::Call_1::tk_start'] };
    expect(callInstanceIdOf(one, 'Call_1', 'tk_start')).toBe('pi_1::Call_1::tk_start#1');
    const two: InstanceState = {
      ...base,
      childInstanceIds: ['pi_1::Call_1::tk_start', 'pi_1::Call_1::tk_start#1'],
    };
    expect(callInstanceIdOf(two, 'Call_1', 'tk_start')).toBe('pi_1::Call_1::tk_start#2');
  });
});

// ---------------- ④ 内嵌子流程的展开 ----------------

describe('④ 内嵌子流程的展开（`expandSubProcesses`）', () => {
  it('★ 节点加层级前缀；子流程**自身**从图里消失', () => {
    const flat = flattenOf(
      [
        { id: 'Start_1', type: 'startEvent' },
        {
          id: 'Sub_1',
          type: 'subProcess',
          nodes: [
            { id: 'S_Start', type: 'startEvent' },
            { id: 'S_Task', type: 'userTask' },
            { id: 'S_End', type: 'endEvent' },
          ],
          flows: [
            { from: 'S_Start', to: 'S_Task' },
            { from: 'S_Task', to: 'S_End' },
          ],
        },
        { id: 'End_1', type: 'endEvent' },
      ],
      [
        { from: 'Start_1', to: 'Sub_1' },
        { from: 'Sub_1', to: 'End_1' },
      ],
    );

    const ids = flat.nodes.map((n) => n.id);
    expect(ids).toContain('Start_1');
    expect(ids).toContain(`Sub_1${SUBPROCESS_PATH_SEP}S_Start`);
    expect(ids).toContain(`Sub_1${SUBPROCESS_PATH_SEP}S_Task`);
    expect(ids).toContain(`Sub_1${SUBPROCESS_PATH_SEP}S_End`);
    // ★ 展开后 `Sub_1` 不再是节点：它的实例身份就是"那几个内嵌节点"
    expect(ids).not.toContain('Sub_1');
    expect(ids).toContain('End_1');
  });

  /**
   * ★ 本条是"子流程出口不会被截断"的**结构性保证**：
   *   内嵌 `endEvent` 若保留 `endEvent` 类型，令牌到达即终结 —— 出口后面的节点永远走不到，
   *   而且**没有任何报错**。
   */
  it('★ 内嵌 `endEvent` 被改写成出口类型（不是 `endEvent`）', () => {
    const flat = flattenOf(
      [
        {
          id: 'Sub_1',
          type: 'subProcess',
          nodes: [
            { id: 'S_Start', type: 'startEvent' },
            { id: 'S_End', type: 'endEvent' },
          ],
          flows: [{ from: 'S_Start', to: 'S_End' }],
        },
      ],
      [],
    );
    const exit = flat.nodes.find((n) => n.id === `Sub_1${SUBPROCESS_PATH_SEP}S_End`);
    expect(exit?.type).toBe(SUBPROCESS_EXIT_TYPE);
    expect(exit?.type).not.toBe('endEvent');
  });

  it('★ 进 / 出的流被重接：进 → 内嵌 `startEvent`；出 → 由内嵌出口发出', () => {
    const flat = flattenOf(
      [
        { id: 'Start_1', type: 'startEvent' },
        {
          id: 'Sub_1',
          type: 'subProcess',
          nodes: [
            { id: 'S_Start', type: 'startEvent' },
            { id: 'S_End', type: 'endEvent' },
          ],
          flows: [{ from: 'S_Start', to: 'S_End' }],
        },
        { id: 'End_1', type: 'endEvent' },
      ],
      [
        { id: 'F_in', from: 'Start_1', to: 'Sub_1' },
        { id: 'F_out', from: 'Sub_1', to: 'End_1' },
      ],
    );
    expect(flat.flows.find((f) => f.id === 'F_in')?.to).toBe(`Sub_1${SUBPROCESS_PATH_SEP}S_Start`);
    expect(flat.flows.find((f) => f.id === 'F_out')?.from).toBe(`Sub_1${SUBPROCESS_PATH_SEP}S_End`);
    expect(flat.flows.find((f) => f.id === 'F_out')?.to).toBe('End_1');
  });

  it('★ 多出口：出向流复制成 N 份（每个出口一份，flow id 不撞车）', () => {
    const flat = flattenOf(
      [
        {
          id: 'Sub_1',
          type: 'subProcess',
          nodes: [
            { id: 'S_Start', type: 'startEvent' },
            { id: 'E_a', type: 'endEvent' },
            { id: 'E_b', type: 'endEvent' },
          ],
          flows: [
            { from: 'S_Start', to: 'E_a' },
            { from: 'S_Start', to: 'E_b' },
          ],
        },
        { id: 'End_1', type: 'endEvent' },
      ],
      [{ id: 'F_out', from: 'Sub_1', to: 'End_1', condition: 'true' }],
    );
    const outs = flat.flows.filter((f) => f.to === 'End_1');
    expect(outs).toHaveLength(2);
    // 条件照抄（出口流的条件是"子流程整体结束"的判定，两个出口各一份）
    for (const f of outs) expect(f.condition).toBe('true');
    // id 必须互不相同：撞车会让条件缓存互相覆盖（按 flow id 缓存）
    expect(outs[0]?.id).not.toBe(outs[1]?.id);
  });

  it('嵌套两层：前缀逐级叠加', () => {
    const flat = flattenOf(
      [
        {
          id: 'Sub_1',
          type: 'subProcess',
          nodes: [
            { id: 'S_Start', type: 'startEvent' },
            {
              id: 'Sub_2',
              type: 'subProcess',
              nodes: [
                { id: 'T_Start', type: 'startEvent' },
                { id: 'T_End', type: 'endEvent' },
              ],
              flows: [{ from: 'T_Start', to: 'T_End' }],
            },
            { id: 'S_End', type: 'endEvent' },
          ],
          flows: [
            { from: 'S_Start', to: 'Sub_2' },
            { from: 'Sub_2', to: 'S_End' },
          ],
        },
      ],
      [],
    );
    const ids = flat.nodes.map((n) => n.id);
    expect(ids).toContain(`Sub_1${SUBPROCESS_PATH_SEP}Sub_2${SUBPROCESS_PATH_SEP}T_Start`);
    expect(ids).toContain(`Sub_1${SUBPROCESS_PATH_SEP}Sub_2${SUBPROCESS_PATH_SEP}T_End`);
    expect(ids).not.toContain('Sub_2');
  });

  it('★ 事件子流程（`triggeredByEvent`）**不**展开 —— 它是被事件触发的，不是走进去的', () => {
    const flat = flattenOf(
      [
        {
          id: 'Sub_1',
          type: 'subProcess',
          triggeredByEvent: true,
          nodes: [
            { id: 'S_Start', type: 'startEvent' },
            { id: 'S_End', type: 'endEvent' },
          ],
          flows: [{ from: 'S_Start', to: 'S_End' }],
        },
        { id: 'End_1', type: 'endEvent' },
      ],
      [{ from: 'Sub_1', to: 'End_1' }],
    );
    // 节点原样留下 → 令牌到达时由 `assertActivitySupported` 抛（FR-E24 / T21）
    expect(flat.nodes.map((n) => n.id)).toContain('Sub_1');
  });

  it('缺 `startEvent` / 缺 `endEvent` / 空子流程 → 建图时抛（`STATE_SHAPE_INVALID`）', () => {
    expectCode(
      () =>
        flattenOf(
          [
            {
              id: 'Sub_1',
              type: 'subProcess',
              nodes: [{ id: 'S_End', type: 'endEvent' }],
              flows: [],
            },
          ],
          [],
        ),
      'ENGINE_STATE_SHAPE_INVALID',
    );
    expectCode(
      () =>
        flattenOf(
          [
            {
              id: 'Sub_1',
              type: 'subProcess',
              nodes: [{ id: 'S_Start', type: 'startEvent' }],
              flows: [],
            },
          ],
          [],
        ),
      'ENGINE_STATE_SHAPE_INVALID',
    );
  });
});

// ---------------- ⑤ 端到端：内嵌子流程 ----------------

describe('⑤ 端到端：令牌走进子流程、再走出来', () => {
  it('★ 走完子流程再回到主流程；`completedNodes` 记的是**内嵌节点**', async () => {
    const def = mainWithSub();
    const { engine, store } = harness({ 'Process_1@1': def });
    const graph = createProcessGraph(def, 'Process_1', 1);

    // 展开后 `Sub_1` 不在图里，内嵌节点在
    expect(graph.nodeIds()).not.toContain('Sub_1');
    expect(graph.nodeIds()).toContain('Sub_1/S_Task');

    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    let st = await load(store, id);
    // ① 停在内嵌的 userTask 上（说明令牌真的"走进去了"）
    expect(tasksOf(st, graph).map((t) => t.nodeId)).toEqual(['Sub_1/S_Task']);

    // ② 办完它 → 从子流程出口出来，落到主流程的下一个节点
    await engine.submit(id, { action: 'approve', actor: 'u_child', at: T0 });
    st = await load(store, id);
    expect(tasksOf(st, graph).map((t) => t.nodeId)).toEqual(['Task_2']);
    expect(st.completedNodes).toContain('Sub_1/S_Task');

    // ③ 再办完 → 实例结束
    await engine.submit(id, { action: 'approve', actor: 'u_boss', at: T0 });
    st = await load(store, id);
    expect(st.status).toBe('completed');
  });

  /**
   * ★ 「子令牌树正确归并」：子流程内开两条并行分支，两个人都办完后**合一次**，
   *   出口后的节点**只出现一条**待办（不是两条）。
   */
  it('★ 子流程内的并行分支：合流后出口只走一次', async () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        {
          id: 'Sub_1',
          type: 'subProcess',
          nodes: [
            { id: 'S_Start', type: 'startEvent' },
            { id: 'Fork', type: 'parallelGateway' },
            { id: 'A', type: 'userTask', approval: userApproval('u_a') },
            { id: 'B', type: 'userTask', approval: userApproval('u_b') },
            { id: 'Join', type: 'parallelGateway' },
            { id: 'S_End', type: 'endEvent' },
          ],
          flows: [
            { from: 'S_Start', to: 'Fork' },
            { from: 'Fork', to: 'A' },
            { from: 'Fork', to: 'B' },
            { from: 'A', to: 'Join' },
            { from: 'B', to: 'Join' },
            { from: 'Join', to: 'S_End' },
          ],
        },
        { id: 'Task_2', type: 'userTask', approval: userApproval('u_boss') },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Sub_1' },
        { from: 'Sub_1', to: 'Task_2' },
        { from: 'Task_2', to: 'End_1' },
      ],
    });
    const { engine, store } = harness({ 'Process_1@1': def });
    const graph = createProcessGraph(def, 'Process_1', 1);

    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    let st = await load(store, id);
    expect([...tasksOf(st, graph).map((t) => t.nodeId)].sort()).toEqual(['Sub_1/A', 'Sub_1/B']);

    // 先办 A：B 还在 → 不能合流，出口后不该出现待办
    await engine.submit(id, { action: 'approve', actor: 'u_a', at: T0 });
    st = await load(store, id);
    expect(tasksOf(st, graph).map((t) => t.nodeId)).toEqual(['Sub_1/B']);

    // 再办 B：合流 → 出口 → Task_2 **只有一条**
    await engine.submit(id, { action: 'approve', actor: 'u_b', at: T0 });
    st = await load(store, id);
    expect(tasksOf(st, graph).map((t) => t.nodeId)).toEqual(['Task_2']);

    await engine.submit(id, { action: 'approve', actor: 'u_boss', at: T0 });
    st = await load(store, id);
    expect(st.status).toBe('completed');
  });

  it('未实现的活动（`transaction`）→ 抛并指名 FR-E13', async () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'T_1', type: 'transaction' },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'T_1' },
        { from: 'T_1', to: 'End_1' },
      ],
    });
    const { engine } = harness({ 'Process_1@1': def });
    const e = await expectCodeAsync(
      engine.start('Process_1', { definitionVersion: 1, starter: 'u0' }),
      'ENGINE_STATE_SHAPE_INVALID',
    );
    expect(String(e.details?.owner)).toContain('FR-E13');
  });
});

// ---------------- ⑥ 端到端：CallActivity ----------------

describe('⑥ 端到端：`CallActivity` 子实例 + 回归', () => {
  const entries = {
    'Process_1@1': mainWithCall(),
    'Sub_Proc@1': subProcess(1),
    'Sub_Proc@2': subProcess(2),
  };

  it('★ 版本绑定：绑定 v1 就按 v1 取图（v2 存在也不理）', async () => {
    const { engine, store } = harness(entries);
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const parent = await load(store, id);

    // ① 父实例记下了子实例 id
    expect(parent.childInstanceIds).toHaveLength(1);
    const childId = parent.childInstanceIds?.[0] as string;

    // ② 子实例：processId 对了、**版本是绑定的 1**（不是最新 v2）
    const child = await load(store, childId);
    expect(child.processId).toBe('Sub_Proc');
    expect(child.definitionVersion).toBe(1);
    // ③ 子实例指回父实例（回归要靠它）
    expect(child.parent).toEqual({ instanceId: id, nodeId: 'Call_1', tokenId: 'tk_start' });

    // ④ 子实例用的是 **v1** 的那条任务（v2 的节点名不同，一眼可辨）
    const subGraph = createProcessGraph(subProcess(1), 'Sub_Proc', 1);
    expect(tasksOf(child, subGraph).map((t) => t.nodeId)).toEqual(['S_Task_v1']);
  });

  it('★ 父实例在 `callActivity` 上**等待**（不是待办），子实例才有待办', async () => {
    const { engine, store } = harness(entries);
    const graph = createProcessGraph(mainWithCall(), 'Process_1', 1);
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const parent = await load(store, id);

    // `waiting` 不算待办（`tasksOf` 只认 `active`）—— 否则宿主待办表里会多出一条点不动的行
    expect(tasksOf(parent, graph)).toEqual([]);
    expect(parent.tokens.filter((t) => t.state === 'waiting')).toHaveLength(1);
    expect(parent.status).toBe('running');
  });

  it('★ 子实例办完 → 父实例自动继续到下一个节点', async () => {
    const { engine, store } = harness(entries);
    const graph = createProcessGraph(mainWithCall(), 'Process_1', 1);
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const childId = (await load(store, id)).childInstanceIds?.[0] as string;

    await engine.submit(childId, { action: 'approve', actor: 'u_v1', at: T0 });

    // 子实例终态
    expect((await load(store, childId)).status).toBe('completed');
    // ★ 父实例被唤醒：走到 Task_2
    const parent = await load(store, id);
    expect(tasksOf(parent, graph).map((t) => t.nodeId)).toEqual(['Task_2']);
    // 离开 `callActivity` 才记账（INV-6 的驳回目标来源）
    expect(parent.completedNodes).toContain('Call_1');
    // 审计里那条是"子流程回归"，不是"某人审批"（伪造操作记录是合规事故）
    expect(parent.auditTrail.some((e) => e.action === CALL_RETURN_ACTION)).toBe(true);
    expect(parent.lastAction?.name).toBe(CALL_RETURN_ACTION);

    // 主流程接着走完
    await engine.submit(id, { action: 'approve', actor: 'u_boss', at: T0 });
    expect((await load(store, id)).status).toBe('completed');
  });

  it('★ 子实例**无人工节点** → 建出来立刻跑完，父实例在 `start()` 里就一路走到底', async () => {
    const { engine, store } = harness({
      'Process_1@1': mainWithCall({ calledElement: 'Auto_Proc' }),
      'Auto_Proc@1': autoSubProcess(),
    });
    const graph = createProcessGraph(mainWithCall({ calledElement: 'Auto_Proc' }), 'Process_1', 1);

    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const parent = await load(store, id);
    const childId = parent.childInstanceIds?.[0] as string;

    expect((await load(store, childId)).status).toBe('completed');
    expect(tasksOf(parent, graph).map((t) => t.nodeId)).toEqual(['Task_2']);
  });

  it('★ 未绑定版本 → `start()` 就抛（不是等走到那个节点才炸）', async () => {
    // 同一张主流程，只是 `Call_1` 上**没有** `floken:call`
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Call_1', type: 'callActivity', calledElement: 'Sub_Proc' },
        { id: 'Task_2', type: 'userTask', approval: userApproval('u_boss') },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Call_1' },
        { from: 'Call_1', to: 'Task_2' },
        { from: 'Task_2', to: 'End_1' },
      ],
    });
    const { engine } = harness({ 'Process_1@1': def, 'Sub_Proc@1': subProcess(1) });
    const e = await expectCodeAsync(
      engine.start('Process_1', { definitionVersion: 1, starter: 'u0' }),
      'ENGINE_STATE_SHAPE_INVALID',
    );
    expect(e.message).toContain('version');
  });

  it('被调用的定义不存在 → 抛 `STATE_DEFINITION_MISSING`（不静默跳过调用）', async () => {
    const { engine } = harness({ 'Process_1@1': mainWithCall() });
    await expectCodeAsync(
      engine.start('Process_1', { definitionVersion: 1, starter: 'u0' }),
      'ENGINE_STATE_DEFINITION_MISSING',
    );
  });

  it('★ 子实例继承父实例那一刻的变量（不是提交前的旧值）', async () => {
    const { engine, store } = harness(entries);
    const id = await engine.start('Process_1', {
      definitionVersion: 1,
      starter: 'u0',
      variables: { amount: 9000 },
    });
    const childId = (await load(store, id)).childInstanceIds?.[0] as string;
    expect((await load(store, childId)).variables.amount).toBe(9000);
  });
});

// ---------------- ⑦ 连坐终止 ----------------

describe('⑦ 父实例终态 → 子实例连坐终止', () => {
  /**
   * ★ 为什么必须有这条：父实例一终止，`resumeParent()` 就**永远不会**再触发 ——
   *   子实例会继续产生待办，而宿主看主流程已经是终态了。
   *   「案子都撤了、子流程还在催人审批」是这类引擎最典型的事故之一。
   */
  it('★ 终止父实例 → 在跑的子实例一并终止，待办被移除', async () => {
    const { engine, store } = harness({
      'Process_1@1': mainWithCall(),
      'Sub_Proc@1': subProcess(1),
    });
    const subGraph = createProcessGraph(subProcess(1), 'Sub_Proc', 1);
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const childId = (await load(store, id)).childInstanceIds?.[0] as string;

    // 终止前：子实例确实有一条待办
    expect(tasksOf(await load(store, childId), subGraph)).toHaveLength(1);

    await engine.submit(id, { action: 'terminate', actor: 'u_admin', at: T0 });

    expect((await load(store, id)).status).toBe('terminated');
    const child = await load(store, childId);
    expect(child.status).toBe('terminated');
    expect(child.tokens.every((t) => t.state !== 'active' && t.state !== 'waiting')).toBe(true);
    // ★ 待办必须真的没了（宿主待办表里还留着就是"催一个已撤销的案子"）
    expect(tasksOf(child, subGraph)).toEqual([]);
  });
});

// ---------------- ⑧ 状态契约 ----------------

describe('⑧ 状态契约（INV-14 / `callReturnOf`）', () => {
  it('★ 带 `parent` / `childInstanceIds` 的实例仍是纯数据（可 JSON 往返）', async () => {
    const { engine, store } = harness({
      'Process_1@1': mainWithCall(),
      'Sub_Proc@1': subProcess(1),
    });
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const childId = (await load(store, id)).childInstanceIds?.[0] as string;

    for (const s of [await load(store, id), await load(store, childId)]) {
      expect(findNonSerializableValue(s), `${s.instanceId} 应当是可序列化的纯数据`).toBeNull();
    }
  });

  it('`callReturnOf`：放行那条 `waiting` 令牌并记账；状态不对 → 抛', () => {
    const st: InstanceState = {
      instanceId: 'pi_1',
      processId: 'P',
      definitionVersion: 1,
      status: 'running',
      rev: 3,
      stateSchema: 1,
      startedAt: T0,
      updatedAt: T0,
      tokens: [{ id: 'tk_1', nodeId: 'Call_1', state: 'waiting', assignee: 'u_old' }],
      completedNodes: [],
      variables: {},
      auditTrail: [],
    };
    const next = callReturnOf(st, { instanceId: 'pi_1', nodeId: 'Call_1', tokenId: 'tk_1' }, 'Task_2');
    expect(next.tokens[0]?.state).toBe('active');
    expect(next.tokens[0]?.nodeId).toBe('Task_2');
    // ★ 换了节点 → 旧办理人作废（带着旧人走过去会让下一条待办落在错的人名下）
    expect(next.tokens[0]?.assignee).toBeUndefined();
    // ★ 离开节点 → 记账（它是 INV-6 的驳回目标来源）
    expect(next.completedNodes).toEqual(['Call_1']);
    // 纯函数：不改入参
    expect(st.tokens[0]?.state).toBe('waiting');

    expectCode(
      () => callReturnOf(st, { instanceId: 'pi_1', nodeId: 'Call_1', tokenId: 'nope' }, 'Task_2'),
      'ENGINE_STATE_SHAPE_INVALID',
    );
    const active: InstanceState = {
      ...st,
      tokens: [{ id: 'tk_1', nodeId: 'Call_1', state: 'active' }],
    };
    expectCode(
      () => callReturnOf(active, { instanceId: 'pi_1', nodeId: 'Call_1', tokenId: 'tk_1' }, 'Task_2'),
      'ENGINE_STATE_SHAPE_INVALID',
    );
  });
});
