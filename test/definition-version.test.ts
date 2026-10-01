/**
 * T19 · `DefinitionSource` 版本语义与在途实例绑定（`AC-E10`）
 *
 * ═══════════════════════════════════════════════════════════════
 * ★ 一句话：`AC-E10` = 「**改版只影响之后发起的实例**」
 * ═══════════════════════════════════════════════════════════════
 * 在途实例一旦绑定 `definitionVersion` 就**终身不变**（INV-19）。这件事看着显然，
 * 破防方式却都很安静 —— 本文件逐个把它们变成红：
 *
 * | 破防方式 | 症状 | 本文件的哪条断言 |
 * |---|---|---|
 * | 宿主 `getDefinition` 忽略 `version` | 在途实例跑到发起时**还不存在的节点**上 | 「改版后在途仍走旧图」 |
 * | 取不到第 v 版就回退到别版 | 版本下线后实例**静默换图** | 「绑定的版本被下线 → 抛 `DEFINITION_MISSING`」 |
 * | 演化过程中有人改了 `definitionVersion` | 同上，但更难查（状态里看不出是谁改的） | 「INV-19 守卫」 |
 *
 * 观测点设计：v1 = 两段审批（`Task_a → Task_b`），v2 在中间**插入**一个 `Task_new`。
 * 于是「走的是哪一版」一眼可辨 —— 在途实例若跑到 `Task_new`，就说明它偷偷换了图。
 */
import { describe, expect, it } from 'vitest';

import type { ProcessDefinition } from '@floken-io/moddle';
import { ENGINE_ERROR_CODES } from '../src/core/errors';
import type { DefinitionSource, StateStore } from '../src/core/spi';
import type { InstanceState } from '../src/core/state';
import { STATE_SCHEMA_VERSION } from '../src/core/state';
import { createProcessGraph } from '../src/nodes/graph';
import { createEngine } from '../src/runtime/engine';
import { plan } from '../src/runtime/plan';
import { tasksOf } from '../src/runtime/loop';
import { createMemoryStore } from '../src/store/memory';
import { makeDefinition, userApproval } from './helpers/definition';
import { expectCode, expectCodeAsync } from './helpers/expect';

const T0 = '2026-10-01T00:00:00.000Z';
const PID = 'expense';

// ---------------- 夹具 ----------------

/**
 * 同一 `processId` 的两版：v2 在中间**插入**了一个 `Task_new`。
 * 于是「走的是哪一版」从节点 id 就能看出来，不必去比对整张图。
 */
function expenseV(version: 1 | 2): ProcessDefinition {
  const nodes = [
    { id: 'Start_1', type: 'startEvent' },
    { id: 'Task_a', type: 'userTask', name: '部门经理', approval: userApproval('u_a') },
    ...(version === 2
      ? [{ id: 'Task_new', type: 'userTask', name: 'v2 新增的合规审批', approval: userApproval('u_new') }]
      : []),
    { id: 'Task_b', type: 'userTask', name: '财务', approval: userApproval('u_b') },
    { id: 'End_1', type: 'endEvent' },
  ];
  const flows =
    version === 1
      ? [
          { from: 'Start_1', to: 'Task_a' },
          { from: 'Task_a', to: 'Task_b' },
          { from: 'Task_b', to: 'End_1' },
        ]
      : [
          { from: 'Start_1', to: 'Task_a' },
          { from: 'Task_a', to: 'Task_new' },
          { from: 'Task_new', to: 'Task_b' },
          { from: 'Task_b', to: 'End_1' },
        ];

  return makeDefinition({ id: `Def_expense_v${version}`, version, processId: PID, nodes, flows });
}

/**
 * 可增删版本的 `DefinitionSource` —— 「改版 / 下线」只能靠它模拟。
 * ⚠️ 刻意**不做**任何回退：取不到就是 `null`（`core/spi.ts` 版本语义 ②）。
 */
function mutableSource(initial: Readonly<Record<string, ProcessDefinition>>): DefinitionSource & {
  entries: Record<string, ProcessDefinition>;
  publish(pid: string, v: number, def: ProcessDefinition): void;
  unpublish(pid: string, v: number): void;
} {
  const entries: Record<string, ProcessDefinition> = { ...initial };
  return {
    entries,
    publish(pid, v, def) {
      entries[`${pid}@${v}`] = def;
    },
    unpublish(pid, v) {
      delete entries[`${pid}@${v}`];
    },
    async getDefinition(pid, v) {
      return entries[`${pid}@${v}`] ?? null;
    },
  };
}

function harness(initial: Readonly<Record<string, ProcessDefinition>>) {
  const store = createMemoryStore();
  const source = mutableSource(initial);
  const engine = createEngine({ definitionSource: source, store, clock: () => T0 });
  return { engine, store, source };
}

async function load(store: StateStore, id: string): Promise<InstanceState> {
  const s = await store.load(id);
  expect(s, `实例 ${id} 应当存在`).not.toBeNull();
  return s as InstanceState;
}

/** 当前在办的节点（按 `active` 令牌取 —— `waiting` 不是待办，见 D-32） */
const activeNodes = (s: InstanceState): string[] =>
  s.tokens.filter((t) => t.state === 'active').map((t) => t.nodeId);

const MISSING = ENGINE_ERROR_CODES.STATE_DEFINITION_MISSING;

/** 停在 `Task_a` 的运行中实例（守卫用例要一个最小合法快照，不必惊动引擎） */
function runningAt(definitionVersion: number): InstanceState {
  return {
    instanceId: 'pi_1',
    processId: PID,
    definitionVersion,
    status: 'running',
    rev: 1,
    stateSchema: STATE_SCHEMA_VERSION,
    startedAt: T0,
    updatedAt: T0,
    tokens: [{ id: 'tk_1', nodeId: 'Task_a', state: 'active', assignee: 'u_a' }],
    completedNodes: [],
    variables: {},
    auditTrail: [{ seq: 1, at: T0, actor: 'u0', action: 'start' }],
  };
}

// ---------------- ① AC-E10 正向：改版不影响在途 ----------------

describe('① AC-E10 · 改版只影响之后发起的实例', () => {
  it('★ 发布 v2 后，v1 的在途实例仍按 v1 的图走完（不去 `Task_new`）', async () => {
    const { engine, store, source } = harness({ 'expense@1': expenseV(1) });

    // ① v1 时代发起：停在 Task_a
    const id = await engine.start(PID, { definitionVersion: 1, starter: 'u0' });
    expect(activeNodes(await load(store, id))).toEqual(['Task_a']);

    // ② 改版：发布 v2（多出一个 `Task_new`）
    source.publish(PID, 2, expenseV(2));

    // ③ 在途实例继续走 —— 必须落在 **Task_b**，而不是 v2 新插入的 `Task_new`
    await engine.submit(id, { action: 'approve', actor: 'u_a' });
    expect(activeNodes(await load(store, id))).toEqual(['Task_b']);

    await engine.submit(id, { action: 'approve', actor: 'u_b' });
    const done = await load(store, id);
    expect(done.status).toBe('completed');
    expect(done.completedNodes).not.toContain('Task_new');
  });

  it('改版后新发起的实例用新版本（会经过 `Task_new`）', async () => {
    const { engine, store, source } = harness({ 'expense@1': expenseV(1) });
    source.publish(PID, 2, expenseV(2));

    const id = await engine.start(PID, { definitionVersion: 2, starter: 'u0' });
    await engine.submit(id, { action: 'approve', actor: 'u_a' });
    expect(activeNodes(await load(store, id))).toEqual(['Task_new']);
  });

  it('★ 冒烟：同一 processId 的两个版本各启一个实例，走的是各自的图', async () => {
    const { engine, store } = harness({ 'expense@1': expenseV(1), 'expense@2': expenseV(2) });

    const oldOne = await engine.start(PID, { definitionVersion: 1, starter: 'u0' });
    const newOne = await engine.start(PID, { definitionVersion: 2, starter: 'u0' });

    // 两者都停在 `Task_a`（两版共有），差别在**下一步**去哪
    expect(activeNodes(await load(store, oldOne))).toEqual(['Task_a']);
    expect(activeNodes(await load(store, newOne))).toEqual(['Task_a']);

    await engine.submit(oldOne, { action: 'approve', actor: 'u_a' });
    await engine.submit(newOne, { action: 'approve', actor: 'u_a' });

    expect(activeNodes(await load(store, oldOne))).toEqual(['Task_b']);
    expect(activeNodes(await load(store, newOne))).toEqual(['Task_new']);
  });
});

// ---------------- ② 版本不存在 = 抛错（绝不回退） ----------------

describe('② 版本不存在 → `ENGINE_STATE_DEFINITION_MISSING`（绝不回退到别版）', () => {
  it('start 时该版本不存在 → 抛错（不静默用最新版）', async () => {
    const { engine } = harness({ 'expense@1': expenseV(1), 'expense@2': expenseV(2) });
    const err = await expectCodeAsync(
      engine.start(PID, { definitionVersion: 3, starter: 'u0' }),
      MISSING,
    );
    expect(err.details?.processId).toBe(PID);
    expect(err.details?.definitionVersion).toBe(3);
  });

  it('★ 在途实例绑定的版本被**下线** → 抛错，不得静默改跑 v2', async () => {
    const { engine, store, source } = harness({ 'expense@1': expenseV(1), 'expense@2': expenseV(2) });

    const id = await engine.start(PID, { definitionVersion: 1, starter: 'u0' });
    // 模拟「运维把 v1 下线了，库里只剩 v2」
    source.unpublish(PID, 1);

    const err = await expectCodeAsync(
      engine.submit(id, { action: 'approve', actor: 'u_a' }),
      MISSING,
    );
    expect(err.details?.definitionVersion).toBe(1);

    // 状态未被改动：失败的提交不得留下半截状态（INV-2 之外的同类底线）
    const after = await load(store, id);
    expect(activeNodes(after)).toEqual(['Task_a']);
    expect(after.rev).toBe(1);
  });

  it('★ `CallActivity` 子实例同样按绑定版本取，绑定版被下线 → 抛错（不回退 v2）', async () => {
    const subV = (version: 1 | 2): ProcessDefinition =>
      makeDefinition({
        processId: 'Sub_Proc',
        version,
        nodes: [
          { id: 'S_Start', type: 'startEvent' },
          {
            id: version === 1 ? 'S_Task_v1' : 'S_Task_v2',
            type: 'userTask',
            name: `子流程 v${version}`,
            approval: userApproval('u_sub'),
          },
          { id: 'S_End', type: 'endEvent' },
        ],
        flows: [
          { from: 'S_Start', to: version === 1 ? 'S_Task_v1' : 'S_Task_v2' },
          { from: version === 1 ? 'S_Task_v1' : 'S_Task_v2', to: 'S_End' },
        ],
      });

    const main = makeDefinition({
      processId: 'Main_Proc',
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Call_1', type: 'callActivity', calledElement: 'Sub_Proc', call: { version: 1 } },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Call_1' },
        { from: 'Call_1', to: 'End_1' },
      ],
    });

    // ① 绑定 v1 而 v2 也在库里 —— 子实例必须取 v1
    const ok = harness({
      'Main_Proc@1': main,
      'Sub_Proc@1': subV(1),
      'Sub_Proc@2': subV(2),
    });
    const okId = await ok.engine.start('Main_Proc', { definitionVersion: 1, starter: 'u0' });
    const childId = (await load(ok.store, okId)).childInstanceIds?.[0] as string;
    const child = await load(ok.store, childId);
    expect(child.definitionVersion).toBe(1);
    expect(
      tasksOf(child, createProcessGraph(subV(1), 'Sub_Proc', 1)).map((t) => t.nodeId),
    ).toEqual(['S_Task_v1']);

    // ② 把绑定的 v1 下线（v2 还在）→ 子实例建不起来，且**不得**退到 v2
    const broken = harness({ 'Main_Proc@1': main, 'Sub_Proc@2': subV(2) });
    await expectCodeAsync(
      broken.engine.start('Main_Proc', { definitionVersion: 1, starter: 'u0' }),
      MISSING,
    );
  });
});

// ---------------- ③ INV-19：版本绑定终身不变 ----------------

describe('③ INV-19 · 实例的 `definitionVersion` 终身不变', () => {
  it('从 start 到 completed，`definitionVersion` 全程是发起时的那一个', async () => {
    const { engine, store, source } = harness({ 'expense@1': expenseV(1) });
    const id = await engine.start(PID, { definitionVersion: 1, starter: 'u0' });
    source.publish(PID, 2, expenseV(2));

    const seen: number[] = [];
    let s = await load(store, id);
    seen.push(s.definitionVersion);
    for (const actor of ['u_a', 'u_b']) {
      await engine.submit(id, { action: 'approve', actor });
      s = await load(store, id);
      seen.push(s.definitionVersion);
    }
    expect(seen).toEqual([1, 1, 1]);
    expect(s.status).toBe('completed');
  });

  /**
   * ★ 机检而非靠人记：`plan()` 是两条路径（submit / 门 2）的**唯一**演化入口，
   *   所以守卫放在这里就同时护住了两条路 —— 一条断言覆盖两个门。
   */
  it('★ 守卫：`plan()` 的 `apply` 接缝偷改 `definitionVersion` → 抛 `STATE_SHAPE_INVALID`', () => {
    const err = expectCode(
      () =>
        plan(
          runningAt(1),
          { action: 'approve', actor: 'u_a', at: T0 },
          // ✗ 宿主（或某个将来被加进来的分支）试图把实例"升级"到 v2
          { apply: (draft) => ({ ...draft, definitionVersion: 2 }) },
        ),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
    expect(err.message).toContain('definitionVersion');
    expect(err.details?.expected).toBe(1);
    expect(err.details?.got).toBe(2);
  });

  it('守卫不影响正常演化（同版本提交照常通过 —— 防"守卫生效"变成"永远抛错"）', () => {
    const r = plan(runningAt(1), { action: 'approve', actor: 'u_a', at: T0 });
    expect(r.next.definitionVersion).toBe(1);
    expect(r.next.rev).toBe(2);
  });
});
