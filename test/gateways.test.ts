/**
 * T16 · 网关 5 类的路由与汇聚（`nodes/gateways.ts` + `runtime/loop.ts`）
 *
 * ★ 三条验证项（照抄 `ARCHITECTURE.md` §9 的 T16）：
 *   ① `ExclusiveGateway` 无匹配且无 `default` → **抛错**；
 *   ② `InclusiveGateway` 汇聚只等**被激活**的分支；
 *   ③ `ParallelGateway` 等全部入向；`EndEvent` 全分支结束 → 实例 `completed`。
 *
 * ★ 另有一条**反向**判据贯穿全档：任何"跑不了"的情形都必须**抛**，
 *   绝不静默取第一条出向（那会让流程走错分支且毫无征兆）。
 */

import { describe, expect, it } from 'vitest';

import { ENGINE_ERROR_CODES } from '../src/core/errors';
import { STATE_SCHEMA_VERSION } from '../src/core/state';
import type { InstanceState } from '../src/core/state';
import { createProcessGraph } from '../src/nodes/graph';
import type { OutFlow } from '../src/nodes/graph';
import type { NodeEffect } from '../src/nodes/tasks';
import { NO_EFFECT } from '../src/nodes/tasks';
import {
  EXECUTABLE_GATEWAY_TYPES,
  GATEWAY_TYPES,
  canJoin,
  isConverging,
  isGatewayType,
  routeGateway,
} from '../src/nodes/gateways';
import { runToWait } from '../src/runtime/loop';
import type { LoopContext } from '../src/runtime/loop';
import { expectCode } from './helpers/expect';
import { makeDefinition, userApproval } from './helpers/definition';

const T = '2026-10-01T00:00:00.000Z';

const base = (tokens: InstanceState['tokens'], variables: Record<string, unknown> = {}): InstanceState => ({
  instanceId: 'pi_1',
  processId: 'Process_1',
  definitionVersion: 1,
  status: 'running',
  rev: 1,
  stateSchema: STATE_SCHEMA_VERSION,
  startedAt: T,
  updatedAt: T,
  tokens,
  completedNodes: [],
  variables,
  auditTrail: [],
});

const ctxOf = (
  def: ReturnType<typeof makeDefinition>,
  opts: {
    assigneesOf?: (n: string) => readonly string[];
    conditionsOf?: (f: OutFlow) => boolean;
    effectsOf?: () => NodeEffect;
  } = {},
): LoopContext => ({
  graph: createProcessGraph(def, 'Process_1', 1),
  assigneesOf: opts.assigneesOf ?? (() => ['u1'] as readonly string[]),
  conditionsOf: opts.conditionsOf ?? (() => true),
  effectsOf: opts.effectsOf ?? (() => NO_EFFECT),
  at: T,
});

const flow = (id: string, to: string, expression?: string): OutFlow =>
  expression === undefined ? { id, to } : { id, to, expression };

// ---------------- 分类 ----------------

describe('网关 5 类的分类（`01-moddle` §5.3 · gateway 族）', () => {
  it('GATEWAY_TYPES 恰好 5 类，其中可执行的 3 类（FR-E11）', () => {
    expect(GATEWAY_TYPES).toHaveLength(5);
    expect(EXECUTABLE_GATEWAY_TYPES).toHaveLength(3);
    for (const g of EXECUTABLE_GATEWAY_TYPES) {
      expect(GATEWAY_TYPES).toContain(g);
    }
    // 未实现的两类各自有 FR 兜底（FR-E17 / FR-E14），不留悬空
    expect(GATEWAY_TYPES).toContain('complexGateway');
    expect(GATEWAY_TYPES).toContain('eventBasedGateway');
  });

  it('`isConverging`：parallel / inclusive 是汇聚点，exclusive 不是', () => {
    expect(isConverging('parallelGateway')).toBe(true);
    expect(isConverging('inclusiveGateway')).toBe(true);
    // BPMN 里 exclusive 作为 join 是"先到先过"，等它就会永久卡住
    expect(isConverging('exclusiveGateway')).toBe(false);
    expect(isGatewayType('exclusiveGateway')).toBe(true);
    expect(isGatewayType('userTask')).toBe(false);
  });
});

// ---------------- 路由（分叉） ----------------

describe('routeGateway · 分叉语义', () => {
  const route = (
    type: string,
    outFlows: readonly OutFlow[],
    truth: Record<string, boolean>,
    defaultFlowId?: string,
  ) =>
    routeGateway({
      type,
      nodeId: 'G_1',
      outFlows,
      defaultFlowId,
      isTrue: (f) => truth[f.id] === true,
    });

  it('`exclusiveGateway`：取**第一条**为真的（顺序 = 定义顺序，确定性）', () => {
    const r = route('exclusiveGateway', [flow('F1', 'A', 'c1'), flow('F2', 'B', 'c2')], {
      F1: false,
      F2: true,
    });
    expect(r).toEqual([{ flowId: 'F2', to: 'B' }]);
    // 两条都真 → 取第一条（BPMN 未定义，我们取确定性的那一个）
    expect(
      route('exclusiveGateway', [flow('F1', 'A', 'c1'), flow('F2', 'B', 'c2')], { F1: true, F2: true }),
    ).toEqual([{ flowId: 'F1', to: 'A' }]);
  });

  /**
   * ★ D-42 的落点：**没写条件 = 无条件 = 恒真**，且不进求值器。
   *   若交给宿主 handler，他一句 `return false` 就能把 BPMN 的既有语义改掉。
   */
  it('无条件流恒真：不调 `isTrue`，也没人能把它判成 false', () => {
    let asked = 0;
    const r = routeGateway({
      type: 'exclusiveGateway',
      nodeId: 'G_1',
      outFlows: [flow('F1', 'A'), flow('F2', 'B', 'c2')],
      defaultFlowId: undefined,
      isTrue: () => {
        asked += 1;
        return false; // 就算宿主一律判假，无条件流也必须走
      },
    });
    expect(r).toEqual([{ flowId: 'F1', to: 'A' }]);
    expect(asked).toBe(0);
  });

  it('`parallelGateway`：全部出向，且**不判条件**（规范里它的条件被忽略）', () => {
    let asked = 0;
    const r = routeGateway({
      type: 'parallelGateway',
      nodeId: 'G_1',
      outFlows: [flow('F1', 'A', 'amount > 1'), flow('F2', 'B')],
      defaultFlowId: undefined,
      isTrue: () => {
        asked += 1;
        return false;
      },
    });
    expect(r).toEqual([
      { flowId: 'F1', to: 'A' },
      { flowId: 'F2', to: 'B' },
    ]);
    expect(asked).toBe(0); // ★ 条件求值器一次都没被调用
  });

  it('`inclusiveGateway`：所有为真的（可多条）', () => {
    expect(
      route(
        'inclusiveGateway',
        [flow('F1', 'A', 'c1'), flow('F2', 'B', 'c2'), flow('F3', 'C', 'c3')],
        { F1: true, F2: false, F3: true },
      ),
    ).toEqual([
      { flowId: 'F1', to: 'A' },
      { flowId: 'F3', to: 'C' },
    ]);
  });

  /** ★ 验证项 ① */
  it('★ `exclusiveGateway` 无匹配且无 default → **抛**（不得静默"哪都不走"）', () => {
    const err = expectCode(
      () =>
        route('exclusiveGateway', [flow('F1', 'A', 'c1'), flow('F2', 'B', 'c2')], {
          F1: false,
          F2: false,
        }),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
    expect(err.details?.outgoing).toEqual(['F1', 'F2']);
    expect(err.details?.defaultFlowId).toBeNull();
  });

  it('`exclusiveGateway` 无匹配但有 default → 走 default', () => {
    expect(
      route('exclusiveGateway', [flow('F1', 'A', 'c1'), flow('F2', 'B', 'c2')], { F1: false, F2: false }, 'F2'),
    ).toEqual([{ flowId: 'F2', to: 'B' }]);
  });

  /** `inclusive` 与 `exclusive` 同口径：至少走一条，否则 default，再否则抛 */
  it('★ `inclusiveGateway` 无匹配且无 default → **抛**', () => {
    expectCode(
      () => route('inclusiveGateway', [flow('F1', 'A', 'c1')], { F1: false }),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
    expect(
      route('inclusiveGateway', [flow('F1', 'A', 'c1'), flow('F2', 'B', 'c2')], { F1: false }, 'F2'),
    ).toEqual([{ flowId: 'F2', to: 'B' }]);
  });

  /** default **只在一条都没中时**才走 —— 别的分支为真时它不参与 */
  it('default 不被"顺带"选中（只在兜底时生效）', () => {
    expect(
      route('exclusiveGateway', [flow('F1', 'A', 'c1'), flow('F2', 'B', 'c2')], { F1: true, F2: true }, 'F2'),
    ).toEqual([{ flowId: 'F1', to: 'A' }]);
  });

  it('未实现的 2 类网关 → 抛，且错误里点名归属 FR', () => {
    for (const [type, owner] of [
      ['complexGateway', 'FR-E17'],
      ['eventBasedGateway', 'FR-E14'],
    ] as const) {
      const err = expectCode(
        () => route(type, [flow('F1', 'A')], { F1: true }),
        ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
      );
      expect(String(err.details?.owner)).toContain(owner);
    }
  });

  it('没有出向的网关 → 抛 `DEFINITION_MISSING`（定义不完整）', () => {
    expectCode(
      () => route('parallelGateway', [], {}),
      ENGINE_ERROR_CODES.STATE_DEFINITION_MISSING,
    );
  });
});

// ---------------- 汇聚（canJoin） ----------------

describe('canJoin · 汇聚判据 =「还有没有人能来」', () => {
  const parallelDef = () =>
    makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Fork', type: 'parallelGateway' },
        { id: 'Task_a', type: 'userTask', approval: userApproval('u_a') },
        { id: 'Task_b', type: 'userTask', approval: userApproval('u_b') },
        { id: 'Join', type: 'parallelGateway' },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { id: 'F1', from: 'Start_1', to: 'Fork' },
        { id: 'F2', from: 'Fork', to: 'Task_a' },
        { id: 'F3', from: 'Fork', to: 'Task_b' },
        { id: 'F4', from: 'Task_a', to: 'Join' },
        { id: 'F5', from: 'Task_b', to: 'Join' },
        { id: 'F6', from: 'Join', to: 'End_1' },
      ],
    });

  it('另一分支还有在途令牌 → 不能合流', () => {
    const g = createProcessGraph(parallelDef(), 'Process_1', 1);
    const s = base([
      { id: 'tk_a', nodeId: 'Join', state: 'active' },
      { id: 'tk_b', nodeId: 'Task_b', state: 'active', assignee: 'u_b' },
    ]);
    expect(canJoin(s, 'Join', g)).toBe(false);
  });

  it('另一分支令牌已终结（被取消）→ 可以合流（★ 不会死锁）', () => {
    const g = createProcessGraph(parallelDef(), 'Process_1', 1);
    const s = base([
      { id: 'tk_a', nodeId: 'Join', state: 'active' },
      { id: 'tk_b', nodeId: 'Task_b', state: 'cancelled', assignee: 'u_b' },
    ]);
    expect(canJoin(s, 'Join', g)).toBe(true);
  });

  it('两条分支都到齐 → 可以合流', () => {
    const g = createProcessGraph(parallelDef(), 'Process_1', 1);
    const s = base([
      { id: 'tk_a', nodeId: 'Join', state: 'active' },
      { id: 'tk_b', nodeId: 'Join', state: 'active' },
    ]);
    expect(canJoin(s, 'Join', g)).toBe(true);
  });
});

// ---------------- 端到端：并行分叉 / 汇聚 ----------------

describe('run-to-wait · 并行分支（T16）', () => {
  const parallelDef = () =>
    makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Fork', type: 'parallelGateway' },
        { id: 'Task_a', type: 'userTask', name: 'A', approval: userApproval('u_a') },
        { id: 'Task_b', type: 'userTask', name: 'B', approval: userApproval('u_b') },
        { id: 'Join', type: 'parallelGateway' },
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

  it('★ 并行分叉：发起后**两条**分支各一条待办', () => {
    const def = parallelDef();
    const r = runToWait(base([{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }]), ctxOf(def, {
      assigneesOf: (n) => (n === 'Task_a' ? ['u_a'] : n === 'Task_b' ? ['u_b'] : ['u_z']),
    }));
    const live = r.next.tokens.filter((t) => t.state === 'active');
    expect(live).toHaveLength(2);
    expect(live.map((t) => t.assignee).sort()).toEqual(['u_a', 'u_b']);
    expect(r.landings).toHaveLength(2);
    expect([...r.landings].sort()).toEqual(['Task_a', 'Task_b']);
    // ★ 两条分支各有各的 `branch`（D-47 的撤销范围靠它）
    expect(new Set(live.map((t) => t.branch)).size).toBe(2);
  });

  it('★ 并行汇聚：只办完一条分支 → 停在网关等（不推进）', () => {
    const def = parallelDef();
    const c = ctxOf(def, { assigneesOf: () => ['u_z'] as readonly string[] });
    const s = base([
      { id: 'tk_a', nodeId: 'Join', state: 'active', branch: 'tk_1#F2' },
      { id: 'tk_b', nodeId: 'Task_b', state: 'active', assignee: 'u_b', branch: 'tk_1#F3' },
    ]);
    const r = runToWait(s, c);
    const live = r.next.tokens.filter((t) => t.state === 'active');
    expect(live).toHaveLength(2);
    expect(live.map((t) => t.nodeId).sort()).toEqual(['Join', 'Task_b']);
  });

  /**
   * ★ 这条同时守住「合流必须在推进之前」这个顺序：
   *   先推进的话，两条令牌会各自走出网关 → `Task_end` 出现两条一模一样的待办。
   */
  it('★ 两条分支都到齐 → 合流成**一个**令牌再推进（不是两条）', () => {
    const def = parallelDef();
    const c = ctxOf(def, { assigneesOf: () => ['u_z'] as readonly string[] });
    const s = base([
      { id: 'tk_a', nodeId: 'Join', state: 'active', branch: 'tk_1#F2' },
      { id: 'tk_b', nodeId: 'Join', state: 'active', branch: 'tk_1#F3' },
    ]);
    const r = runToWait(s, c);
    const live = r.next.tokens.filter((t) => t.state === 'active');
    expect(live).toHaveLength(1);
    expect(live[0]?.nodeId).toBe('Task_end');
    expect(live[0]?.assignee).toBe('u_z');
    // 合流后回到"单干" → `branch` 必须摘掉
    expect(live[0]?.branch).toBeUndefined();
    // 被合并掉的那条**留在 tokens 里供审计**（不是删掉）
    expect(r.next.tokens.find((t) => t.id === 'tk_b')?.state).toBe('completed');
  });

  /** ★ 验证项 ③ */
  it('★ 全分支结束 → 实例 completed', () => {
    const def = parallelDef();
    const c = ctxOf(def, { assigneesOf: () => ['u_z'] as readonly string[] });
    const r = runToWait(
      base([
        { id: 'tk_a', nodeId: 'End_1', state: 'completed' },
        { id: 'tk_b', nodeId: 'End_1', state: 'active' },
      ]),
      c,
    );
    expect(r.next.status).toBe('completed');
    expect(r.next.tokens.every((t) => t.state === 'completed')).toBe(true);
  });
});

// ---------------- 端到端：包容网关与排他网关 ----------------

describe('run-to-wait · 包容 / 排他（T16）', () => {
  /** `Fork(inclusive) → A / B / C`，条件由变量 `needA` 等决定；`Join(inclusive) → End` */
  const inclusiveDef = () =>
    makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Fork', type: 'inclusiveGateway' },
        { id: 'Task_a', type: 'userTask', approval: userApproval('u_a') },
        { id: 'Task_b', type: 'userTask', approval: userApproval('u_b') },
        { id: 'Join', type: 'inclusiveGateway' },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { id: 'F1', from: 'Start_1', to: 'Fork' },
        { id: 'F2', from: 'Fork', to: 'Task_a', condition: 'needA' },
        { id: 'F3', from: 'Fork', to: 'Task_b', condition: 'needB' },
        { id: 'F4', from: 'Task_a', to: 'Join' },
        { id: 'F5', from: 'Task_b', to: 'Join' },
        { id: 'F6', from: 'Join', to: 'End_1' },
      ],
    });

  /**
   * ★ 验证项 ②：只激活了 A 分支 → **不等 B**（"只等被激活的分支"）。
   *   若按"等全部入向"实现，这里会永久卡住（B 分支从来没有令牌）。
   */
  it('★ `inclusiveGateway` 汇聚只等被激活的分支（未激活的不等）', () => {
    const def = inclusiveDef();
    const c = ctxOf(def, {
      assigneesOf: () => ['u_a'] as readonly string[],
      conditionsOf: (f) => f.id === 'F2', // 只走 A
    });
    const r = runToWait(base([{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }]), c);
    const live = r.next.tokens.filter((t) => t.state === 'active');
    expect(live).toHaveLength(1);
    expect(live[0]?.nodeId).toBe('Task_a');

    // A 办完 → 到 Join → **立刻**合流走到 End（不等不存在的 B）
    const r2 = runToWait(
      base([{ id: 'tk_1', nodeId: 'Join', state: 'active', branch: 'tk_1#F2' }]),
      c,
    );
    expect(r2.next.status).toBe('completed');
  });

  it('两条都激活 → 两条都走，且必须都办完才合流', () => {
    const def = inclusiveDef();
    const c = ctxOf(def, {
      assigneesOf: (n) => (n === 'Task_a' ? ['u_a'] : ['u_b']),
      conditionsOf: () => true,
    });
    const r = runToWait(base([{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }]), c);
    expect(r.next.tokens.filter((t) => t.state === 'active')).toHaveLength(2);

    // 只办完 A → 停在 Join 等 B
    const r2 = runToWait(
      base([
        { id: 'tk_a', nodeId: 'Join', state: 'active', branch: 'tk_1#F2' },
        { id: 'tk_b', nodeId: 'Task_b', state: 'active', assignee: 'u_b', branch: 'tk_1#F3' },
      ]),
      c,
    );
    expect(r2.next.status).toBe('running');
    expect(r2.next.tokens.find((t) => t.id === 'tk_a')?.nodeId).toBe('Join');
  });

  it('`exclusiveGateway` 按条件走一条（另一条分支不产生令牌）', () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'G_1', type: 'exclusiveGateway' },
        { id: 'Task_big', type: 'userTask', approval: userApproval('u_boss') },
        { id: 'Task_small', type: 'userTask', approval: userApproval('u_lead') },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { id: 'F1', from: 'Start_1', to: 'G_1' },
        { id: 'F2', from: 'G_1', to: 'Task_big', condition: 'amount > 5000' },
        { id: 'F3', from: 'G_1', to: 'Task_small', condition: 'amount <= 5000' },
        { id: 'F4', from: 'Task_big', to: 'End_1' },
        { id: 'F5', from: 'Task_small', to: 'End_1' },
      ],
    });
    const route = (amount: number) =>
      runToWait(base([{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }], { amount }), ctxOf(def, {
        assigneesOf: (n) => (n === 'Task_big' ? ['u_boss'] : ['u_lead']),
        conditionsOf: (f) => (f.id === 'F2' ? amount > 5000 : true),
      }));

    expect(route(9000).next.tokens[0]?.nodeId).toBe('Task_big');
    expect(route(9000).next.tokens[0]?.assignee).toBe('u_boss');
    expect(route(100).next.tokens[0]?.nodeId).toBe('Task_small');
  });

  /**
   * ★ 反向判据（`D-22`）：**非网关**节点挂两条出向 → 仍抛。
   *   "隐式排他 / 隐式包容"没有规格依据，静默取第一条就是静默走错分支。
   */
  it('★ D-22：普通节点多出向 → 抛（只有网关能路由多分支）', () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        // `onEmpty:'skip'` 让令牌真的**离开**这个节点（否则它会被判成"已落定"而停在原地）
        { id: 'Task_1', type: 'userTask', approval: { ...userApproval('u1'), onEmpty: 'skip' } },
        { id: 'Task_a', type: 'userTask', approval: userApproval('u_a') },
        { id: 'Task_b', type: 'userTask', approval: userApproval('u_b') },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { id: 'F1', from: 'Start_1', to: 'Task_1' },
        { id: 'F2', from: 'Task_1', to: 'Task_a' },
        { id: 'F3', from: 'Task_1', to: 'Task_b' },
        { id: 'F4', from: 'Task_a', to: 'End_1' },
        { id: 'F5', from: 'Task_b', to: 'End_1' },
      ],
    });
    const err = expectCode(
      () => runToWait(base([{ id: 'tk_1', nodeId: 'Task_1', state: 'active' }]), ctxOf(def, {
        assigneesOf: () => [] as readonly string[],
      })),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
    expect(err.details?.outgoing).toEqual(['Task_a', 'Task_b']);
  });
});
