/**
 * `runtime/loop.ts` —— run-to-wait（ADR-003）+ 待办视图
 *
 * ★ 本文件跑的是**纯函数**：不注入任何 SPI（`assigneesOf` 是同步闭包），
 *   于是它同时证明两件事：① 循环本身可单测；② `plan()` 的 `apply` 接缝确实是纯的（NFR-E6）。
 */
import { describe, expect, it } from 'vitest';

import { ENGINE_ERROR_CODES } from '../src/core/errors';
import { diffTasks } from '../src/core/task';
import { STATE_SCHEMA_VERSION } from '../src/core/state';
import type { InstanceState, Token } from '../src/core/state';
import { createProcessGraph } from '../src/nodes/graph';
import type { OutFlow, ProcessGraph } from '../src/nodes/graph';
import type { NodeEffect } from '../src/nodes/tasks';
import { NO_EFFECT } from '../src/nodes/tasks';
import { PROBE_ASSIGNEE, applyPrimitiveCalls, runToWait, tasksOf } from '../src/runtime/loop';
import { makeDefinition, userApproval } from './helpers/definition';
import { expectCode } from './helpers/expect';

const T = '2026-10-01T00:00:00.000Z';

function stateOf(overrides: Partial<InstanceState> = {}): InstanceState {
  const base: InstanceState = {
    instanceId: 'pi_1',
    processId: 'Process_1',
    definitionVersion: 1,
    status: 'running',
    rev: 1,
    stateSchema: STATE_SCHEMA_VERSION,
    startedAt: T,
    updatedAt: T,
    tokens: [],
    completedNodes: [],
    variables: {},
    auditTrail: [],
  };
  return { ...base, ...overrides };
}

const graphFor = (nodes: Parameters<typeof makeDefinition>[0]['nodes'], flows: Parameters<typeof makeDefinition>[0]['flows']): ProcessGraph =>
  createProcessGraph(makeDefinition({ nodes, flows }), 'Process_1', 1);

const linearGraph = (): ProcessGraph =>
  graphFor(
    [
      { id: 'Start_1', type: 'startEvent' },
      { id: 'Task_1', type: 'userTask', name: '经理审批', formKey: 'f1', approval: userApproval('u1') },
      { id: 'Task_2', type: 'userTask', approval: userApproval('u2') },
      { id: 'End_1', type: 'endEvent' },
    ],
    [
      { from: 'Start_1', to: 'Task_1' },
      { from: 'Task_1', to: 'Task_2' },
      { from: 'Task_2', to: 'End_1' },
    ],
  );

/**
 * T16 起 `LoopContext` 必须有 `conditionsOf`（网关分支的真值来源）。
 * 缺省 = **无条件恒真** —— 与「顺序流没写 `conditionExpression`」同义（D-42）。
 *
 * T17 起还要有 `effectsOf`（任务副作用的来源）。缺省 = **无副作用** ——
 * 本档测的是推进 / 汇聚 / 事件，服务与脚本另有专测。
 */
const ctxOf = (
  graph: ProcessGraph,
  assigneesOf: (n: string) => readonly string[],
  conditionsOf: (f: OutFlow) => boolean = () => true,
  effectsOf: () => NodeEffect = () => NO_EFFECT,
) => ({
  graph,
  assigneesOf,
  conditionsOf,
  effectsOf,
  at: T,
});

describe('applyPrimitiveCalls', () => {
  it('依次施加原语（顺序即契约）', () => {
    const g = linearGraph();
    const s = stateOf({ tokens: [{ id: 'tk_1', nodeId: 'Task_1', state: 'active' }] });
    const next = applyPrimitiveCalls(s, [
      { primitive: 'advance', input: { tokenId: 'tk_1', to: 'Task_2' } },
    ]);
    expect(next.tokens[0]?.nodeId).toBe('Task_2');
    expect(next.completedNodes).toEqual(['Task_1']);
    // 不改入参
    expect(s.tokens[0]?.nodeId).toBe('Task_1');
    void g;
  });
});

describe('runToWait（ADR-003）', () => {
  it('★ 从发起节点一路走到第一个等待节点并落定办理人', () => {
    const g = linearGraph();
    const s = stateOf({ tokens: [{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }] });
    const r = runToWait(s, ctxOf(g, () => ['u1']));

    expect(r.landings).toEqual(['Task_1']);
    expect(r.next.tokens[0]?.nodeId).toBe('Task_1');
    expect(r.next.tokens[0]?.assignee).toBe('u1');
    expect(r.next.tokens[0]?.createdAt).toBe(T);
    expect(r.next.status).toBe('running');
    expect(s.tokens[0]?.nodeId).toBe('Start_1'); // 入参未改
  });

  it('★ 自动直通也要记 completedNodes（D-28：不记则驳回目标永远为空）', () => {
    const g = linearGraph();
    const s = stateOf({ tokens: [{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }] });
    const r = runToWait(s, ctxOf(g, () => ['u1']));
    /*
     * 直通不走 `advance` 原语而是直接改 `token.nodeId`，所以这里必须自己记账：
     * `completedNodes` 若为空，`INV-6`（驳回 / 退回目标 ∈ completedNodes）会让
     * 「驳回给发起人」这种最常见的场景**永远做不到**，且报错是"目标非法"而非"记账漏了"。
     */
    expect(r.next.completedNodes).toEqual(['Start_1']);
  });

  it('★ advance 换节点会作废旧办理人（否则 run-to-wait 会误判"已落定"而永远推不动）', () => {
    const g = linearGraph();
    const s = stateOf({
      tokens: [{ id: 'tk_1', nodeId: 'Task_1', state: 'active', assignee: 'u1', createdAt: T, returnTo: 'u0' }],
    });
    const primed = applyPrimitiveCalls(s, [{ primitive: 'advance', input: { tokenId: 'tk_1', to: 'Task_2' } }]);
    expect(primed.tokens[0]?.assignee).toBeUndefined();
    expect(primed.tokens[0]?.returnTo).toBeUndefined();
    expect(primed.tokens[0]?.createdAt).toBeUndefined();

    const r = runToWait(primed, ctxOf(g, (n) => (n === 'Task_2' ? ['u2'] : ['u1'])));
    expect(r.landings).toEqual(['Task_2']);
    expect(r.next.tokens[0]?.assignee).toBe('u2');
    expect(r.next.tokens[0]?.createdAt).toBe(T);
  });

  it('走到结束事件 → 令牌 completed；全部令牌终结 → 实例 completed', () => {
    const g = linearGraph();
    const s = stateOf({
      tokens: [{ id: 'tk_1', nodeId: 'Task_2', state: 'active', assignee: 'u2' }],
    });
    // 已落定的令牌停在等待节点（它就是一个稳定点）；要先 advance 才会往下走
    expect(runToWait(s, ctxOf(g, () => ['u9'])).next.tokens[0]?.state).toBe('active');

    const primed = applyPrimitiveCalls(s, [{ primitive: 'advance', input: { tokenId: 'tk_1', to: 'End_1' } }]);
    const r = runToWait(primed, ctxOf(g, () => ['u9']));
    expect(r.next.tokens[0]?.state).toBe('completed');
    expect(r.next.tokens[0]?.nodeId).toBe('End_1');
    expect(r.next.status).toBe('completed');
    expect(r.landings).toEqual([]);
  });

  it('已进终态的实例不被改写成 completed（halt 之后仍是 terminated）', () => {
    const g = linearGraph();
    const s = stateOf({
      status: 'terminated',
      tokens: [{ id: 'tk_1', nodeId: 'Task_1', state: 'cancelled' }],
    });
    expect(runToWait(s, ctxOf(g, () => ['u1'])).next.status).toBe('terminated');
  });

  it('★ INV-13：解析出 0 个办理人 + onEmpty=error → ACTION_APPROVER_EMPTY（不得静默卡住）', () => {
    const g = linearGraph();
    const s = stateOf({ tokens: [{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }] });
    expectCode(
      () => runToWait(s, ctxOf(g, () => [])),
      ENGINE_ERROR_CODES.ACTION_APPROVER_EMPTY,
    );
  });

  it("onEmpty='skip' → 该节点无人可办，令牌完成并继续往下走", () => {
    const g = graphFor(
      [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Task_1', type: 'userTask', approval: userApproval('u1', { onEmpty: 'skip' }) },
        { id: 'Task_2', type: 'userTask', approval: userApproval('u2') },
        { id: 'End_1', type: 'endEvent' },
      ],
      [
        { from: 'Start_1', to: 'Task_1' },
        { from: 'Task_1', to: 'Task_2' },
        { from: 'Task_2', to: 'End_1' },
      ],
    );
    const s = stateOf({ tokens: [{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }] });
    const r = runToWait(s, ctxOf(g, (n) => (n === 'Task_1' ? [] : ['u2'])));
    expect(r.landings).toEqual(['Task_2']);
    expect(r.next.tokens[0]?.nodeId).toBe('Task_2');
  });

  it('★ 多办理人 → 展开成汇聚组（T13；静默取第一人会退化成单人审批）', () => {
    const g = linearGraph();
    const s = stateOf({ tokens: [{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }] });
    const r = runToWait(s, ctxOf(g, () => ['u1', 'u2', 'u3']));
    const group = r.next.tokens.filter((t) => t.instanceGroup !== undefined);
    expect(group.map((t) => t.assignee)).toEqual(['u1', 'u2', 'u3']);
    expect(group.every((t) => t.nodeId === 'Task_1')).toBe(true);
    expect(group.every((t) => t.state === 'active')).toBe(true); // 非串行 → 全员并行
    expect(r.landings).toEqual(['Task_1']);
    expect(s.tokens[0]?.nodeId).toBe('Start_1'); // 入参未改
  });

  it('INV-3：令牌指向图外节点 → STATE_TOKEN_ORPHAN', () => {
    const g = linearGraph();
    const s = stateOf({ tokens: [{ id: 'tk_1', nodeId: 'Ghost', state: 'active' }] });
    expectCode(
      () => runToWait(s, ctxOf(g, () => ['u1'])),
      ENGINE_ERROR_CODES.STATE_TOKEN_ORPHAN,
    );
  });

  it('死路（非结束节点却无出向）→ STATE_DEFINITION_MISSING，不得静默停住', () => {
    const g = graphFor(
      [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Task_x', type: 'task' },
      ],
      [{ from: 'Start_1', to: 'Task_x' }],
    );
    const s = stateOf({ tokens: [{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }] });
    expectCode(
      () => runToWait(s, ctxOf(g, () => ['u1'])),
      ENGINE_ERROR_CODES.STATE_DEFINITION_MISSING,
    );
  });

  it('★ 定义图有环 → 步骤预算兜底（没有它进程会直接挂死）', () => {
    const g = graphFor(
      [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'GW_1', type: 'exclusiveGateway' },
      ],
      [
        { from: 'Start_1', to: 'GW_1' },
        { from: 'GW_1', to: 'GW_1' },
      ],
    );
    const s = stateOf({ tokens: [{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }] });
    expectCode(
      () => runToWait(s, ctxOf(g, () => ['u1'])),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
  });

  it('★ 探测用的占位办理人不会触发 INV-13（这是 submit 两阶段解析的前提）', () => {
    const g = linearGraph();
    const s = stateOf({ tokens: [{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }] });
    const seen: string[] = [];
    const r = runToWait(s, ctxOf(g, (n) => {
      seen.push(n);
      return [PROBE_ASSIGNEE];
    }));
    expect(seen).toEqual(['Task_1']);
    expect(r.next.tokens[0]?.assignee).toBe(PROBE_ASSIGNEE);
  });
});

describe('待办视图（读线数据源）', () => {
  it('在途 + 有办理人 = 一条待办；taskId 含节点（同令牌跨节点不复用同一行）', () => {
    const g = linearGraph();
    const s = stateOf({
      tokens: [
        { id: 'tk_1', nodeId: 'Task_1', state: 'active', assignee: 'u1', createdAt: T },
        { id: 'tk_2', nodeId: 'Task_2', state: 'cancelled', assignee: 'u2' },
        { id: 'tk_3', nodeId: 'Task_2', state: 'active' },
      ],
    });
    const views = tasksOf(s, g);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      taskId: 'Task_1:tk_1',
      instanceId: 'pi_1',
      nodeId: 'Task_1',
      nodeName: '经理审批',
      formKey: 'f1',
      assignee: 'u1',
      status: 'active',
      createdAt: T,
    });
  });

  it('实例挂起 → 待办 suspended；委派出去的 → delegated', () => {
    const g = linearGraph();
    const mk = (t: Partial<Token>): Token =>
      ({ id: 'tk_1', nodeId: 'Task_1', state: 'active', assignee: 'u1', ...t }) as Token;

    expect(tasksOf(stateOf({ status: 'suspended', tokens: [mk({})] }), g)[0]?.status).toBe('suspended');
    expect(tasksOf(stateOf({ tokens: [mk({ returnTo: 'u0' })] }), g)[0]?.status).toBe('delegated');
    expect(tasksOf(stateOf({ tokens: [mk({})] }), g)[0]?.status).toBe('active');
  });

  it('diffTasks：added / removed / changed 三路（removed 必须真删）', () => {
    const g = linearGraph();
    const before = tasksOf(
      stateOf({
        tokens: [
          { id: 'tk_1', nodeId: 'Task_1', state: 'active', assignee: 'u1', createdAt: T },
          { id: 'tk_2', nodeId: 'Task_2', state: 'active', assignee: 'u2', createdAt: T },
        ],
      }),
      g,
    );
    const after = tasksOf(
      stateOf({
        tokens: [
          { id: 'tk_2', nodeId: 'Task_2', state: 'active', assignee: 'u9', createdAt: T },
          { id: 'tk_3', nodeId: 'Task_2', state: 'active', assignee: 'u3', createdAt: T },
        ],
      }),
      g,
    );
    const d = diffTasks(before, after);
    expect(d.removed).toEqual(['Task_1:tk_1']);
    expect(d.added.map((t) => t.taskId)).toEqual(['Task_2:tk_3']);
    expect(d.changed.map((t) => t.taskId)).toEqual(['Task_2:tk_2']);
  });

  it('diffTasks 幂等：相同视图相减为空差分', () => {
    const g = linearGraph();
    const v = tasksOf(
      stateOf({ tokens: [{ id: 'tk_1', nodeId: 'Task_1', state: 'active', assignee: 'u1', createdAt: T }] }),
      g,
    );
    expect(diffTasks(v, v)).toEqual({ added: [], removed: [], changed: [] });
  });
});
