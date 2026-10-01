/**
 * T16 · 并行分支与网关条件的**引擎层**验收（跑真实的 `createEngine`）
 *
 * 与 `test/gateways.test.ts` 的分工：那边验的是**纯函数**（`routeGateway` / `canJoin` / `runToWait`），
 * 这边验的是**接线** —— 条件经 `ConditionHandler`（`@floken-io/feel`）求值、
 * 待办差分、投影、`plan()` 的两条路径是否一致。
 *
 * ★ 三条最有价值的断言：
 *   ① **惰性解析**：没走到的分支上的坏表达式**不得**被求值（否则流程会在第一步就炸）；
 *   ② **payload 可见**：表单里改了变量，网关必须按**新值**走分支；
 *   ③ **D-47**：并行分支上"拿回"只撤本分支，另一条分支的待办不得被误伤。
 */

import { describe, expect, it } from 'vitest';

import { compileAction } from '../src/actions/compile';
import type { ActionInput } from '../src/core/action';
import { ENGINE_ERROR_CODES } from '../src/core/errors';
import type { InstanceState } from '../src/core/state';
import { createProcessGraph } from '../src/nodes/graph';
import { createEngine } from '../src/runtime/engine';
import { step } from '../src/runtime/loop';
import { createMemoryStore } from '../src/store/memory';
import { makeDefinition, userApproval } from './helpers/definition';
import { createMemoryProjection } from './helpers/memory-projection';
import { expectCodeAsync } from './helpers/expect';

const T0 = '2026-10-01T00:00:00.000Z';
const PROCESS = 'Process_1';

// ---------------- 夹具 ----------------

/**
 * `Start_1 → Fork(并行) → Task_a(u_a) / Task_b(u_b) → Join(并行) → Task_end(u_z) → End_1`
 *
 * ★ `Task_a` 上开 `withdraw`（拿回）+ `reject.allowedTargets: ['nodeId']`
 *   —— D-46：回退类六项共用 `reject.allowedTargets`，且开关挂在**当前节点**上。
 */
const parallelDef = () =>
  makeDefinition({
    id: 'Definitions_parallel',
    version: 1,
    nodes: [
      { id: 'Start_1', type: 'startEvent' },
      { id: 'Fork', type: 'parallelGateway', name: '并行分叉' },
      {
        id: 'Task_a',
        type: 'userTask',
        name: 'A 分支',
        approval: userApproval('u_a', {
          withdraw: { allowed: true },
          reject: { allowed: true, allowArbitrary: true, allowedTargets: ['nodeId'] },
        }),
      },
      { id: 'Task_b', type: 'userTask', name: 'B 分支', approval: userApproval('u_b') },
      { id: 'Join', type: 'parallelGateway', name: '并行汇聚' },
      { id: 'Task_end', type: 'userTask', name: '终审', approval: userApproval('u_z') },
      { id: 'End_1', type: 'endEvent' },
    ],
    flows: [
      { id: 'F1', from: 'Start_1', to: 'Fork' },
      { id: 'F2', from: 'Fork', to: 'Task_a' },
      { id: 'F3', from: 'Fork', to: 'Task_b' },
      { id: 'F4', from: 'Task_a', to: 'Join' },
      { id: 'F5', from: 'Task_b', to: 'Join' },
      { id: 'F6', from: 'Join', to: 'Task_end' },
      { id: 'F7', from: 'Task_end', to: 'End_1' },
    ],
  });

const ctxOf = (def: ReturnType<typeof makeDefinition>) => {
  const store = createMemoryStore();
  const projection = createMemoryProjection();
  const engine = createEngine({
    store,
    definitionSource: {
      async getDefinition(pid: string, v: number) {
        return pid === PROCESS && v === 1 ? def : null;
      },
    },
    projection,
    clock: () => T0,
  });
  return {
    engine,
    projection,
    load: async (id: string) => (await store.load(id)) as InstanceState,
  };
};

const start = (c: ReturnType<typeof ctxOf>, variables?: Record<string, unknown>) =>
  c.engine.start(PROCESS, {
    definitionVersion: 1,
    starter: 'u_applicant',
    ...(variables === undefined ? {} : { variables }),
  });

const submit = (
  c: ReturnType<typeof ctxOf>,
  id: string,
  action: string,
  actor: string,
  extra: Partial<ActionInput> = {},
) => c.engine.submit(id, { action, actor, ...extra } as ActionInput);

const at = async (c: ReturnType<typeof ctxOf>, id: string, nodeId: string) =>
  (await c.projection.list(id)).filter((t) => t.nodeId === nodeId).map((t) => t.assignee);

// ---------------- 并行端到端 ----------------

describe('并行分支端到端（引擎层）', () => {
  it('★ 分叉 → 两条待办；都办完 → 合流成一条；全部走完 → 实例 completed', async () => {
    const c = ctxOf(parallelDef());
    const id = await start(c);

    // ① 分叉：两条待办
    expect(await at(c, id, 'Task_a')).toEqual(['u_a']);
    expect(await at(c, id, 'Task_b')).toEqual(['u_b']);
    expect(await c.projection.list(id)).toHaveLength(2);

    // ② 只办完 A → B 还在办，且**不**推进到终审
    const d1 = await submit(c, id, 'approve', 'u_a');
    expect(d1.added).toEqual([]);
    expect(await at(c, id, 'Task_end')).toEqual([]);
    const parked = (await c.load(id)).tokens.filter((t) => t.nodeId === 'Join' && t.state === 'active');
    expect(parked).toHaveLength(1); // 令牌停在汇聚网关上等 B

    // ③ B 办完 → 合流 → 终审**只有一条**待办
    const d2 = await submit(c, id, 'approve', 'u_b');
    expect(d2.added.map((t) => t.assignee)).toEqual(['u_z']);
    expect(await c.projection.list(id)).toHaveLength(1);

    // ④ 终审通过 → 实例完成
    const d3 = await submit(c, id, 'approve', 'u_z');
    expect(d3.instance.status).toBe('completed');
    expect(await c.projection.list(id)).toHaveLength(0);
  });

  /**
   * ★ **D-47**：并行分支上的"拿回"只撤**本分支**。
   *   不收缩范围的话，A 分支点一次拿回会把 B 分支上正在办的待办一起取消 ——
   *   表现为"我的待办凭空消失了"，且**没有任何报错**可循（最难查的一类误伤）。
   */
  it('★ D-47：并行分支上 takeBack 不得误伤另一条分支的待办', async () => {
    const c = ctxOf(parallelDef());
    const id = await start(c);
    expect(await c.projection.list(id)).toHaveLength(2);

    await submit(c, id, 'takeBack', 'u_a', { target: 'Start_1', comment: '填错了' });

    // ★ B 分支那条待办必须还在（旧行为会把它一起 cancelled）
    expect(await at(c, id, 'Task_b')).toEqual(['u_b']);
  });

  it('★ D-47（编译层）：`rollbackTo` 的入参带上本分支的 `branch`', () => {
    const def = parallelDef();
    const graph = createProcessGraph(def, PROCESS, 1);
    const state: InstanceState = {
      instanceId: 'pi_1',
      processId: PROCESS,
      definitionVersion: 1,
      status: 'running',
      rev: 1,
      stateSchema: 1,
      startedAt: T0,
      updatedAt: T0,
      tokens: [
        { id: 'tk_a', nodeId: 'Task_a', state: 'active', assignee: 'u_a', branch: 'tk_start#F2' },
        { id: 'tk_b', nodeId: 'Task_b', state: 'active', assignee: 'u_b', branch: 'tk_start#F3' },
      ],
      completedNodes: ['Start_1', 'Fork'],
      variables: {},
      auditTrail: [],
    };
    const compiled = compileAction(
      { action: 'takeBack', actor: 'u_a', target: 'Start_1', comment: 'x' },
      state,
      {
        approval: graph.approvalOf('Task_a'),
        startNodeId: graph.startNodeId,
        tokenId: 'tk_a',
      },
    );
    const call = compiled.calls[0];
    expect(call?.primitive).toBe('rollbackTo');
    expect((call?.input as { branch?: string }).branch).toBe('tk_start#F2');

    // 施加后：B 分支的令牌必须还活着
    const after = step(
      state,
      { graph, at: T0, assigneesOf: () => ['u_b'] as readonly string[], conditionsOf: () => true },
      { calls: compiled.calls, ...(compiled.post ? { post: compiled.post } : {}) },
    ).next;
    expect(after.tokens.find((t) => t.id === 'tk_b')?.state).toBe('active');
  });
});

// ---------------- 网关条件（真实 FEEL 求值） ----------------

describe('网关条件的引擎接线（AC-E9 / D-37 / D-40）', () => {
  /**
   * `Start_1 → Task_1(u_1) → G(exclusive) → [amount > 5000] Task_big(u_boss) / default Task_small(u_lead)`
   */
  const amountDef = () =>
    makeDefinition({
      id: 'Definitions_amount',
      version: 1,
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Task_1', type: 'userTask', name: '填单', approval: userApproval('u_1') },
        {
          id: 'G',
          type: 'exclusiveGateway',
          name: '金额判定',
          defaultFlow: 'F_small',
        },
        { id: 'Task_big', type: 'userTask', name: '老板批', approval: userApproval('u_boss') },
        { id: 'Task_small', type: 'userTask', name: '主管批', approval: userApproval('u_lead') },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { id: 'F1', from: 'Start_1', to: 'Task_1' },
        { id: 'F_big', from: 'G', to: 'Task_big', condition: 'amount > 5000' },
        { id: 'F_small', from: 'G', to: 'Task_small' },
        { id: 'F2', from: 'Task_1', to: 'G' },
        { id: 'F3', from: 'Task_big', to: 'End_1' },
        { id: 'F4', from: 'Task_small', to: 'End_1' },
      ],
    });

  it('★ 零配置即能求 FEEL：9000 → 老板批；100 → 主管批（走 default）', async () => {
    const c = ctxOf(amountDef());

    const big = await start(c, { amount: 9000 });
    await submit(c, big, 'approve', 'u_1');
    expect(await at(c, big, 'Task_big')).toEqual(['u_boss']);
    expect(await at(c, big, 'Task_small')).toEqual([]);

    const small = await start(c, { amount: 100 });
    await submit(c, small, 'approve', 'u_1');
    expect(await at(c, small, 'Task_small')).toEqual(['u_lead']);
  });

  /**
   * ★ `payload` 必须与网关看到的变量**同源**：
   *   表单里把 amount 改成 9000，网关却按旧值走分支 —— 那是最难查的一类走错分支。
   */
  it('★ 表单增量可见：提交时把 amount 改成 9000 → 走老板批', async () => {
    const c = ctxOf(amountDef());
    const id = await start(c, { amount: 100 });
    await submit(c, id, 'approve', 'u_1', { payload: { amount: 9000 } });
    expect(await at(c, id, 'Task_big')).toEqual(['u_boss']);
  });

  /**
   * ★ **惰性解析**：走不到的分支上的坏表达式**不得**被求值。
   *   若"拿到图就把全图条件算一遍"，第二次 start 会在**第一步**就炸 ——
   *   而 `missingVar` 那条分支本来根本走不到。
   */
  const lazyDef = () =>
    makeDefinition({
      id: 'Definitions_lazy',
      version: 1,
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Task_1', type: 'userTask', approval: userApproval('u_1') },
        { id: 'G1', type: 'exclusiveGateway', defaultFlow: 'F_default' },
        { id: 'Task_a', type: 'userTask', approval: userApproval('u_a') },
        { id: 'G2', type: 'exclusiveGateway', defaultFlow: 'F_default2' },
        { id: 'Task_c', type: 'userTask', approval: userApproval('u_c') },
        { id: 'Task_d', type: 'userTask', approval: userApproval('u_d') },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { id: 'F1', from: 'Start_1', to: 'Task_1' },
        { id: 'F2', from: 'Task_1', to: 'G1' },
        { id: 'F_a', from: 'G1', to: 'Task_a', condition: 'pick = 1' },
        { id: 'F_b', from: 'G1', to: 'G2', condition: 'pick = 2' },
        { id: 'F_default', from: 'G1', to: 'Task_a' },
        // ★ `missingVar` 从不存在 → 求值为 null → 按 D-38 必须抛
        { id: 'F_c', from: 'G2', to: 'Task_c', condition: 'missingVar > 1' },
        { id: 'F_default2', from: 'G2', to: 'Task_d' },
        { id: 'F3', from: 'Task_a', to: 'End_1' },
        { id: 'F4', from: 'Task_c', to: 'End_1' },
        { id: 'F5', from: 'Task_d', to: 'End_1' },
      ],
    });

  it('★ 走不到的分支不求值：`pick = 1` 时 `missingVar > 1` 不得被求值', async () => {
    const c = ctxOf(lazyDef());
    const id = await start(c, { pick: 1 });
    await submit(c, id, 'approve', 'u_1');
    expect(await at(c, id, 'Task_a')).toEqual(['u_a']);
  });

  it('★ 走到了才求值：`pick = 2` 时同一份定义必须抛（AC-E9 无豁免）', async () => {
    const c = ctxOf(lazyDef());
    const id = await start(c, { pick: 2 });
    const err = await expectCodeAsync(
      submit(c, id, 'approve', 'u_1'),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
    expect(err.details?.expression).toBe('missingVar > 1');
  });

  /** 语法错必须冒泡到调用方（`plan()` 与 `submit()` 都不吞），且不静默走 default */
  it('语法错 → 抛，不是静默走 default', async () => {
    const def = amountDef();
    for (const f of def.processes[0]?.flows ?? []) {
      if (f.id === 'F_big') f.condition = 'amount >';
    }
    const c = ctxOf(def);
    const id = await start(c, { amount: 9000 });

    let caught: unknown;
    try {
      await submit(c, id, 'approve', 'u_1');
    } catch (e) {
      caught = e;
    }
    expect(caught, '语义错必须抛，不得静默走 default 分支').toBeDefined();
    // 码名由 @floken-io/feel 决定（FEEL_SYNTAX_*）；引擎只保证**原样冒泡、不降级**
    expect(String((caught as { code?: string }).code)).toMatch(/^FEEL_SYNTAX/);
    expect(await at(c, id, 'Task_small')).toEqual([]); // 没有被"兜底"成主管批
  });
});
