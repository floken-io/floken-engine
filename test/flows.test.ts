/**
 * T17 · 连线与数据 4 类的语义
 *
 * ★ 两条要钉死的口径：
 *   ① **无条件流恒真、且不进求值器**（BPMN 的默认流语义，D-42）；
 *   ② **数据元素是"数据状态"不是"流程步骤"** —— 引擎只读不写，令牌落到它上面就是定义画错了。
 */
import { describe, expect, it } from 'vitest';

import { ENGINE_ERROR_CODES } from '../src/core/errors';
import { createProcessGraph } from '../src/nodes/graph';
import {
  DATA_ACCESS,
  DATA_NODE_TYPES,
  FLOW_TYPES,
  assertNotDataNode,
  dataRefOf,
  flowPasses,
  isDataNode,
} from '../src/nodes/flows';
import { createEngine } from '../src/runtime/engine';
import { createMemoryStore } from '../src/store/memory';
import { makeDefinition, singleVersionSource, userApproval } from './helpers/definition';
import { expectCodeAsync } from './helpers/expect';

const T0 = '2026-10-01T00:00:00.000Z';

// ---------------- ① 分类 ----------------

describe('① 连线与数据 4 类（`03-engine` §6）', () => {
  it('FLOW_TYPES 恰好 4 类，其中 3 类是数据元素', () => {
    expect(FLOW_TYPES).toHaveLength(4);
    expect(DATA_NODE_TYPES).toHaveLength(3);
    for (const d of DATA_NODE_TYPES) {
      expect(FLOW_TYPES).toContain(d);
    }
  });

  it('只有数据三兄弟是"数据节点"；`sequenceFlow` 不是', () => {
    for (const d of DATA_NODE_TYPES) expect(isDataNode(d), d).toBe(true);
    for (const t of ['sequenceFlow', 'userTask', 'startEvent', 'nonsense']) {
      expect(isDataNode(t), t).toBe(false);
    }
    expect(isDataNode(undefined)).toBe(false);
  });
});

// ---------------- ② ★ 数据：引擎只读不写 ----------------

describe('② ★ 数据元素：引擎只读不写', () => {
  it('`DATA_ACCESS` 恒为 `readOnly`（规格口径钉成常量，别处不得另写一份）', () => {
    expect(DATA_ACCESS).toBe('readOnly');
  });

  it('令牌落到数据节点 → 抛 STATE_SHAPE_INVALID', () => {
    let threw: unknown;
    try {
      assertNotDataNode('dataObject', 'Data_1');
    } catch (e) {
      threw = e;
    }
    expect((threw as { code?: string }).code).toBe(ENGINE_ERROR_CODES.STATE_SHAPE_INVALID);
    expect((threw as { details?: Record<string, unknown> }).details?.access).toBe('readOnly');
  });

  it('非数据节点**不抛**（守门只拦数据，不拦其它）', () => {
    for (const t of ['userTask', 'serviceTask', 'sequenceFlow', 'startEvent']) {
      expect(() => assertNotDataNode(t, 'N')).not.toThrow();
    }
  });

  it('`dataRefOf`：dataObjectRef → dataStoreRef → itemSubjectRef 三级回退', () => {
    expect(dataRefOf({ dataObjectRef: 'DO_1' } as never)).toBe('DO_1');
    expect(dataRefOf({ dataStoreRef: 'DS_1' } as never)).toBe('DS_1');
    expect(dataRefOf({ itemSubjectRef: 'Item_1' } as never)).toBe('Item_1');
    expect(dataRefOf({ id: 'X', type: 'dataObject' } as never)).toBeUndefined();
    expect(dataRefOf(undefined)).toBeUndefined();
  });

  it('★ 运行期：令牌经 sequenceFlow 落到 `dataObject` → 抛（不静默走过去）', async () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Data_1', type: 'dataObject' },
        { id: 'Task_1', type: 'userTask', approval: userApproval('u1') },
      ],
      flows: [
        { from: 'Start_1', to: 'Data_1' },
        { from: 'Data_1', to: 'Task_1' },
      ],
    });
    const engine = createEngine({
      definitionSource: singleVersionSource('Process_1', 1, def),
      store: createMemoryStore(),
      clock: () => T0,
    });
    await expectCodeAsync(engine.start('Process_1', { definitionVersion: 1, starter: 'u0' }),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
  });
});

// ---------------- ③ ★ 连线通不通（唯一口径） ----------------

describe('③ `flowPasses`（连线的唯一口径）', () => {
  it('★ 无条件 → **恒真**，且**不调**求值器', () => {
    const isTrue = () => {
      throw new Error('无条件流不该进求值器');
    };
    expect(flowPasses({ id: 'F1', to: 'X' } as never, isTrue)).toBe(true);
  });

  it('有条件 → 调求值器，且**原样**返回它的结果（含 false）', () => {
    expect(flowPasses({ id: 'F1', expression: 'a > 1' } as never, () => true)).toBe(true);
    expect(flowPasses({ id: 'F1', expression: 'a > 1' } as never, () => false)).toBe(false);
  });

  it('★ 空串不算"无条件"（那是"写坏了"，由 `expressionOf` 归一化成 undefined 之前不会被传进来）', () => {
    // 防御性断言：真传了空串就按"有条件"处理（交给求值器报错），而不是静默放行
    let called = false;
    flowPasses({ id: 'F1', expression: '' } as never, () => {
      called = true;
      return false;
    });
    expect(called).toBe(true);
  });
});

// ---------------- ④ 与网关的接线（flows 是唯一口径，网关不得另写一份） ----------------

describe('④ 网关复用 `flowPasses`：无条件流在包容网关上也恒真', () => {
  it('包容网关：一条无条件 + 一条有条件为假 → 只走无条件的那条', () => {
    const g = createProcessGraph(
      makeDefinition({
        nodes: [
          { id: 'Start_1', type: 'startEvent' },
          { id: 'GW_1', type: 'inclusiveGateway' },
          { id: 'A', type: 'userTask', approval: userApproval('u1') },
          { id: 'B', type: 'userTask', approval: userApproval('u2') },
          { id: 'End_1', type: 'endEvent' },
        ],
        flows: [
          { from: 'Start_1', to: 'GW_1' },
          { id: 'F_a', from: 'GW_1', to: 'A' }, // 无条件
          { id: 'F_b', from: 'GW_1', to: 'B', condition: 'amount > 5000' },
          { from: 'A', to: 'End_1' },
          { from: 'B', to: 'End_1' },
        ],
      }),
      'Process_1',
      1,
    );
    expect(g.outFlowsOf('GW_1').map((f) => f.id)).toEqual(['F_a', 'F_b']);
    // 无条件的那条没有 `expression`
    expect(g.outFlowsOf('GW_1').find((f) => f.id === 'F_a')?.expression).toBeUndefined();
  });
});
