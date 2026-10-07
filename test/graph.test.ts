/**
 * `nodes/graph.ts` —— 定义图适配器（INV-3 的唯一判定点）
 */
import { describe, expect, it } from 'vitest';

import { createProcessGraph, assertTokensInGraph, isTerminalNode, isWaitingNode } from '../src/nodes/graph';
import type { ProcessGraph } from '../src/nodes/graph';
import { ENGINE_ERROR_CODES } from '../src/core/errors';
import { makeDefinition } from './helpers/definition';
import { expectCode } from './helpers/expect';

const linear = () =>
  makeDefinition({
    nodes: [
      { id: 'Start_1', type: 'startEvent' },
      { id: 'Task_1', type: 'userTask', name: '经理审批', formKey: 'f1', approval: { approvers: [{ type: 'user', value: 'u1' }] } },
      { id: 'End_1', type: 'endEvent' },
    ],
    flows: [
      { from: 'Start_1', to: 'Task_1' },
      { from: 'Task_1', to: 'End_1' },
    ],
  });

const graphOf = (): ProcessGraph => createProcessGraph(linear(), 'Process_1', 1);

describe('createProcessGraph', () => {
  it('建图：发起节点 / 类型 / 名字 / formKey', () => {
    const g = graphOf();
    expect(g.startNodeId).toBe('Start_1');
    expect(g.typeOf('Task_1')).toBe('userTask');
    expect(g.nameOf('Task_1')).toBe('经理审批');
    expect(g.formKeyOf('Task_1')).toBe('f1');
    expect([...g.nodeIds()].sort()).toEqual(['End_1', 'Start_1', 'Task_1']);
  });

  it('nextOf：单出向给出目标；结束节点无出向 → undefined', () => {
    const g = graphOf();
    expect(g.nextOf('Start_1')).toBe('Task_1');
    expect(g.nextOf('Task_1')).toBe('End_1');
    expect(g.nextOf('End_1')).toBeUndefined();
  });

  it('★ D-22：多出向必须抛错（T16 才实现多分支，不得静默取第一条）', () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'GW_1', type: 'parallelGateway' },
        { id: 'Task_a', type: 'userTask' },
        { id: 'Task_b', type: 'userTask' },
      ],
      flows: [
        { from: 'Start_1', to: 'GW_1' },
        { from: 'GW_1', to: 'Task_a' },
        { from: 'GW_1', to: 'Task_b' },
      ],
    });
    const g = createProcessGraph(def, 'Process_1', 1);
    const e = expectCode(() => g.nextOf('GW_1'), ENGINE_ERROR_CODES.STATE_SHAPE_INVALID);
    expect((e.details?.outgoing as string[]).sort()).toEqual(['Task_a', 'Task_b']);
  });

  it('processId 不在定义里 → STATE_DEFINITION_MISSING', () => {
    expectCode(
      () => createProcessGraph(linear(), 'Process_X', 1),
      ENGINE_ERROR_CODES.STATE_DEFINITION_MISSING,
    );
  });

  it('没有 startEvent → STATE_DEFINITION_MISSING（否则引擎不知道从哪起步）', () => {
    const def = makeDefinition({ nodes: [{ id: 'Task_1', type: 'userTask' }], flows: [] });
    expectCode(
      () => createProcessGraph(def, 'Process_1', 1),
      ENGINE_ERROR_CODES.STATE_DEFINITION_MISSING,
    );
  });

  it('节点 id 重复 → 抛错（静默取一个会掩盖定义自身的错误）', () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Task_1', type: 'userTask' },
        { id: 'Task_1', type: 'userTask' },
      ],
      flows: [{ from: 'Start_1', to: 'Task_1' }],
    });
    expectCode(
      () => createProcessGraph(def, 'Process_1', 1),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
  });

  it('approvalOf：已归一化（缺省值由 moddle 填，不在本包写第二份默认值）', () => {
    const g = graphOf();
    const a = g.approvalOf('Task_1');
    expect(a).toBeDefined();
    expect(a?.approvers).toEqual([{ type: 'user', value: 'u1' }]);
    // DV-1：默认值来自 normalizeApproval —— 这几项本包绝不自己写
    expect(a?.reject.allowedTargets).toEqual(['previous']);
    expect(a?.onReject).toBe('abort');
    expect(g.approvalOf('Start_1')).toBeUndefined();
  });

  it('approvalOf 有缓存：同一节点两次取到同一份（避免反复归一化）', () => {
    const g = graphOf();
    expect(g.approvalOf('Task_1')).toBe(g.approvalOf('Task_1'));
  });
});

describe('节点分类（T11 边界）', () => {
  it('等待类只有 userTask；结束类只有 endEvent', () => {
    expect(isWaitingNode('userTask')).toBe(true);
    expect(isWaitingNode('manualTask')).toBe(false); // T17
    expect(isTerminalNode('endEvent')).toBe(true);
    expect(isTerminalNode('userTask')).toBe(false);
  });
});

describe('★ `condition.language`：只认 FEEL，其余建图即抛（此前完全不读）', () => {
  /** 一个带条件分支的图：`Gate_1` → A（有条件）/ B（默认流） */
  const gateDef = (condition: unknown) =>
    makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Gate_1', type: 'exclusiveGateway', defaultFlow: 'f3' },
        { id: 'A', type: 'endEvent' },
        { id: 'B', type: 'endEvent' },
      ],
      flows: [
        { id: 'f1', from: 'Start_1', to: 'Gate_1' },
        { id: 'f2', from: 'Gate_1', to: 'A', condition: condition as never },
        { id: 'f3', from: 'Gate_1', to: 'B' },
      ],
    });

  it("★ `language:'javascript'` → 抛 OPTION_INVALID（不静默当 FEEL 求值）", () => {
    expectCode(
      () => createProcessGraph(gateDef({ body: 'amount > 500', language: 'javascript' }), 'Process_1', 1),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
  });

  it('其它语言（`python` / `groovy`）同样抛', () => {
    for (const language of ['python', 'groovy', 'xpath']) {
      expectCode(
        () => createProcessGraph(gateDef({ body: 'amount > 500', language }), 'Process_1', 1),
        ENGINE_ERROR_CODES.OPTION_INVALID,
      );
    }
  });

  it("FEEL 的各种写法放行：`feel` / `text/feel` / `FEEL` / OMG URN", () => {
    for (const language of [
      'feel',
      'text/feel',
      'FEEL',
      'https://www.omg.org/spec/DMN/20230324/FEEL/',
    ]) {
      expect(() =>
        createProcessGraph(gateDef({ body: 'amount > 500', language }), 'Process_1', 1),
      ).not.toThrow();
    }
  });

  it('不写 `language`（简写也不写）→ 一律按 FEEL，不抛', () => {
    expect(() => createProcessGraph(gateDef({ body: 'amount > 500' }), 'Process_1', 1)).not.toThrow();
    expect(() => createProcessGraph(gateDef('amount > 500'), 'Process_1', 1)).not.toThrow();
  });
});

describe('assertTokensInGraph（INV-3）', () => {
  it('全部令牌都在图里 → 通过', () => {
    const g = graphOf();
    expect(() =>
      assertTokensInGraph(
        { instanceId: 'pi_1', tokens: [{ id: 'tk_1', nodeId: 'Task_1' }] },
        g,
      ),
    ).not.toThrow();
  });

  it('令牌指向图外节点 → STATE_TOKEN_ORPHAN（不得静默忽略）', () => {
    const g = graphOf();
    expectCode(
      () => assertTokensInGraph({ instanceId: 'pi_1', tokens: [{ id: 'tk_1', nodeId: 'Ghost' }] }, g),
      ENGINE_ERROR_CODES.STATE_TOKEN_ORPHAN,
    );
  });
});
