/**
 * T16 · 事件 6 类的执行语义（`nodes/events.ts`）
 *
 * ★ 两条判据（与 T16 的验证项对应）：
 *   ① **分类穷举**：6 类事件每一类都有明确的归属（已实现 / 未实现且指名 FR）；
 *   ② **未实现的必须抛**，绝不静默直通 —— "这个事件没发生、流程却走过去了"
 *      是业务上无法接受、且排查时**毫无报错**可循的一类事故。
 */

import { describe, expect, it } from 'vitest';

import { ENGINE_ERROR_CODES } from '../src/core/errors';
import { STATE_SCHEMA_VERSION } from '../src/core/state';
import type { InstanceState } from '../src/core/state';
import { createProcessGraph } from '../src/nodes/graph';
import {
  EVENT_TYPES,
  assertEventSupported,
  eventBehaviorOf,
  isEventType,
} from '../src/nodes/events';
import { NO_EFFECT } from '../src/nodes/tasks';
import { runToWait } from '../src/runtime/loop';
import { expectCode } from './helpers/expect';
import { makeDefinition, userApproval } from './helpers/definition';

const T = '2026-10-01T00:00:00.000Z';

const base = (tokens: InstanceState['tokens']): InstanceState => ({
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
  variables: {},
  auditTrail: [],
});

const ctx = (def: ReturnType<typeof makeDefinition>) => ({
  graph: createProcessGraph(def, 'Process_1', 1),
  assigneesOf: () => ['u1'] as readonly string[],
  conditionsOf: () => true,
  effectsOf: () => NO_EFFECT,
  at: T,
});

describe('事件 6 类的分类（`01-moddle` §5.3 · event 族）', () => {
  it('EVENT_TYPES 恰好 6 类，且行为映射全覆盖', () => {
    expect(EVENT_TYPES).toHaveLength(6);
    for (const t of EVENT_TYPES) {
      expect(isEventType(t)).toBe(true);
      expect(eventBehaviorOf(t)).toBeDefined();
    }
  });

  it('行为归类：start=入口 / end=终点 / catch=等投递 / 其余 3 类=未实现', () => {
    expect(eventBehaviorOf('startEvent')).toBe('start');
    expect(eventBehaviorOf('endEvent')).toBe('terminal');
    expect(eventBehaviorOf('intermediateCatchEvent')).toBe('catch');
    expect(eventBehaviorOf('intermediateThrowEvent')).toBe('unsupported');
    expect(eventBehaviorOf('boundaryEvent')).toBe('unsupported');
    expect(eventBehaviorOf('implicitThrowEvent')).toBe('unsupported');
  });

  it('非事件类型 → undefined（不得把普通节点当事件处理）', () => {
    expect(eventBehaviorOf('userTask')).toBeUndefined();
    expect(eventBehaviorOf('exclusiveGateway')).toBeUndefined();
    expect(eventBehaviorOf(undefined)).toBeUndefined();
    expect(isEventType('userTask')).toBe(false);
  });

  /**
   * ★ 反向断言：未实现的三类必须**抛**，且错误里点名归属 FR（照着就能排期）。
   */
  it('未实现的 3 类：`assertEventSupported` 一律抛 `STATE_SHAPE_INVALID`', () => {
    for (const [type, owner] of [
      ['intermediateThrowEvent', 'FR-E14'],
      ['boundaryEvent', 'FR-E13'],
      ['implicitThrowEvent', 'FR-E24'],
    ] as const) {
      let err: unknown;
      try {
        assertEventSupported(type, 'Ev_1', 'unsupported');
      } catch (e) {
        err = e;
      }
      expect((err as { code?: string })?.code).toBe(ENGINE_ERROR_CODES.STATE_SHAPE_INVALID);
      expect(String((err as { details?: { owner?: string } })?.details?.owner)).toContain(owner);
    }
  });

  it('已实现的 3 类：`assertEventSupported` 是 no-op', () => {
    expect(() => assertEventSupported('endEvent', 'End_1', 'terminal')).not.toThrow();
    expect(() => assertEventSupported('startEvent', 'Start_1', 'start')).not.toThrow();
    expect(() => assertEventSupported('intermediateCatchEvent', 'Ev_1', 'catch')).not.toThrow();
  });
});

describe('令牌到达各类事件时的真实行为', () => {
  /**
   * ★ **`intermediateThrowEvent` 显式抛错（D-56 的第二半，T20 收口）**。
   *
   * 它是「向**外**抛出」：引擎没有对外的消息出口（11 项 SPI 里没有 `MessageSink`），
   * ADR-006 又把事件集定死 10 个。直通的表现是「流程图上说这里发了一条消息，
   * 而它从来没发出去」—— 那正是「不得静默降级」要挡的事。
   */
  it('`intermediateThrowEvent` → 抛 `STATE_SHAPE_INVALID`（不静默直通）', () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Throw_1', type: 'intermediateThrowEvent', name: '通知' },
        { id: 'Task_1', type: 'userTask', approval: userApproval('u1') },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Throw_1' },
        { from: 'Throw_1', to: 'Task_1' },
        { from: 'Task_1', to: 'End_1' },
      ],
    });
    const err = expectCode(
      () => runToWait(base([{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }]), ctx(def)),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
    expect(String(err.details?.owner)).toContain('FR-E14');
  });

  it('`endEvent` → 令牌完成；全部结束 → 实例 completed', () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [{ from: 'Start_1', to: 'End_1' }],
    });
    const r = runToWait(base([{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }]), ctx(def));
    expect(r.next.tokens[0]?.state).toBe('completed');
    expect(r.next.status).toBe('completed');
  });

  /**
   * ★ 未实现的三类：令牌到达即抛。**绝不**静默当成自动直通。
   *   否则"捕获事件没等到消息、流程却往下走了"会变成一个没有任何报错的静默事实。
   */
  it.each([
    ['intermediateCatchEvent', 'FR-E14'],
    ['boundaryEvent', 'FR-E13'],
    ['implicitThrowEvent', 'FR-E24'],
  ])('令牌到达 `%s` → 抛 `STATE_SHAPE_INVALID`（归属 %s）', (type) => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Ev_1', type },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Ev_1' },
        { from: 'Ev_1', to: 'End_1' },
      ],
    });
    expectCode(
      () => runToWait(base([{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }]), ctx(def)),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
  });

  /** `startEvent` 作为**退回目标**时必须自动走下去（T15 的 D-34 场景里已依赖此行为） */
  it('回到 `startEvent` → 自动直通到下一个等待节点（不是卡在发起节点）', () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Task_1', type: 'userTask', approval: userApproval('u1') },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Task_1' },
        { from: 'Task_1', to: 'End_1' },
      ],
    });
    const r = runToWait(base([{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }]), ctx(def));
    expect(r.next.tokens[0]?.nodeId).toBe('Task_1');
  });
});
