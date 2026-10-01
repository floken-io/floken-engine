/**
 * T12 · 事件派生与投递（`ARCHITECTURE.md` §9 T12 / ADR-006）
 *
 * ★ 本文件最值钱的是**顺序**与**同源**两条断言：
 *   ① 顺序（`taskCreated` 先于 `taskAssigned`、实例终态在待办之后、挂起在待办之前）——
 *      顺序不是美观问题，宿主按它建索引、发通知；
 *   ② 同源（事件的 `action` 与 `delta.action` 是**同一个对象**）——
 *      三处各造一份就会在重放时对不上。
 *
 *   ★ 另一条是收口断言：**10 个事件名全部被真实触发过一次**（`covered` 集合）。
 *     否则「实现了 10 个事件」只是文档里的一句话，等于没验。
 */
import { describe, expect, it } from 'vitest';

import type { ActionInput } from '../src/core/action';
import type { EngineEvent, EngineEventName } from '../src/core/events';
import {
  ENGINE_EVENT_NAMES,
  INSTANCE_EVENT_NAMES,
  TASK_EVENT_NAMES,
  isInstanceEvent,
  isTaskEvent,
} from '../src/core/events';
import type { EventSink } from '../src/core/spi';
import type { InstanceState } from '../src/core/state';
import { headerOf } from '../src/core/state';
import type { TaskDelta } from '../src/core/task';
import { createProcessGraph } from '../src/nodes/graph';
import type { Engine } from '../src/runtime/engine';
import { createEngine } from '../src/runtime/engine';
import { emitAll, eventsOf, instanceEventNameOf } from '../src/runtime/emit';
import { tasksOf } from '../src/runtime/loop';
import { expenseDefinition, makeDefinition, singleVersionSource, userApproval } from './helpers/definition';
import { createMemoryProjection } from './helpers/memory-projection';
import type { TestMemoryProjection } from './helpers/memory-projection';
import { makeState } from './helpers/state';

const T0 = '2026-10-01T00:00:00.000Z';
const PROCESS = 'Process_1';

interface RecordingSink extends EventSink {
  readonly events: EngineEvent[];
  names(): EngineEventName[];
}

function recordingSink(): RecordingSink {
  const events: EngineEvent[] = [];
  return {
    events,
    names: () => events.map((e) => e.name),
    emit(e: EngineEvent): void {
      events.push(e);
    },
  };
}

interface Ctx {
  engine: Engine;
  sink: RecordingSink;
  projection: TestMemoryProjection;
}

/**
 * ★ 一个引擎实例 = 一个内存 store（`NFR-E10` 默认），
 *   所以 `start()` 与后续 `submit()` **必须**用同一个实例 —— 分成两个工厂会直接 `STATE_NOT_FOUND`。
 */
function ctx(def = expenseDefinition(), events?: EventSink): Ctx {
  const sink = recordingSink();
  const projection = createMemoryProjection();
  const engine = createEngine({
    definitionSource: singleVersionSource(PROCESS, 1, def),
    projection,
    events: events ?? sink,
    clock: () => T0,
  });
  return { engine, sink, projection };
}

/** 事件名集合：用于最后「10 个事件逐条覆盖」的收口断言 */
const covered = new Set<EngineEventName>();
const mark = (sink: RecordingSink): void => {
  for (const e of sink.events) covered.add(e.name);
};

describe('事件集自洽（ADR-006：节点级 5 + 实例级 5）', () => {
  it('ENGINE_EVENT_NAMES === 10，两类各 5 个、互不重叠', () => {
    expect(ENGINE_EVENT_NAMES).toHaveLength(10);
    expect(TASK_EVENT_NAMES).toHaveLength(5);
    expect(INSTANCE_EVENT_NAMES).toHaveLength(5);
    for (const n of TASK_EVENT_NAMES) {
      expect((INSTANCE_EVENT_NAMES as readonly string[]).includes(n)).toBe(false);
      expect(isTaskEvent({ name: n } as EngineEvent)).toBe(true);
      expect(isInstanceEvent({ name: n } as EngineEvent)).toBe(false);
    }
    for (const n of INSTANCE_EVENT_NAMES) {
      expect(isInstanceEvent({ name: n } as EngineEvent)).toBe(true);
      expect(isTaskEvent({ name: n } as EngineEvent)).toBe(false);
    }
  });

  it('★ `cancelled` 状态不产事件 —— 实例级 5 个里没有它（诚实标注，不偷偷加）', () => {
    // 当前无任何原语产出 `cancelled`（只有 halt → terminated）；真出现了也不该凭空造一个事件
    expect(instanceEventNameOf('running', 'cancelled')).toBeUndefined();
    expect(INSTANCE_EVENT_NAMES).not.toContain('cancelled');
  });
});

describe('AC-E14 · 一次提交的事件序列', () => {
  it('start()：`started` → `taskCreated` → `taskAssigned`（created 必先于 assigned）', async () => {
    const c = ctx();
    const id = await c.engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    expect(id.startsWith('pi_')).toBe(true);

    expect(c.sink.names()).toEqual(['started', 'taskCreated', 'taskAssigned']);
    expect(c.sink.names().indexOf('taskCreated')).toBeLessThan(
      c.sink.names().indexOf('taskAssigned'),
    );

    expect(c.sink.events[0]).toMatchObject({ name: 'started', status: 'running', instanceId: id });
    expect(c.sink.events[1]).toMatchObject({
      name: 'taskCreated',
      taskId: 'Task_apply:tk_start',
      nodeId: 'Task_apply',
      nodeName: '部门经理审批',
      formKey: 'form_expense',
      assignee: 'u_manager',
      taskStatus: 'active',
    });
    mark(c.sink);
  });

  it('approve：旧待办 `taskCompleted`（令牌换节点）→ 新待办 created → assigned', async () => {
    const c = ctx();
    const id = await c.engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    c.sink.events.length = 0;

    await c.engine.submit(id, { action: 'approve', actor: 'u_manager' });
    expect(c.sink.names()).toEqual(['taskCompleted', 'taskCreated', 'taskAssigned']);
    expect(c.sink.events[0]).toMatchObject({
      name: 'taskCompleted',
      taskId: 'Task_apply:tk_start',
      taskStatus: 'done',
    });
    expect(c.sink.events[1]).toMatchObject({
      name: 'taskCreated',
      taskId: 'Task_finance:tk_start',
      assignee: 'u_finance',
    });
    mark(c.sink);
  });

  it('★ 走到结束：`taskCompleted` 之后才是实例 `completed`（终态是结果，排在原因之后）', async () => {
    const c = ctx();
    const id = await c.engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    await c.engine.submit(id, { action: 'approve', actor: 'u_manager' });
    c.sink.events.length = 0;

    await c.engine.submit(id, { action: 'approve', actor: 'u_finance' });
    expect(c.sink.names()).toEqual(['taskCompleted', 'completed']);

    const inst = c.sink.events[1];
    expect(inst).toBeDefined();
    if (inst === undefined) throw new Error('unreachable: 事件数已被上一条断言钉住');
    expect(inst).toMatchObject({ name: 'completed', status: 'completed' });
    expect(isInstanceEvent(inst)).toBe(true);
    if (isInstanceEvent(inst)) expect(inst.instance.status).toBe('completed');
    mark(c.sink);
  });

  it('terminate：`taskCancelled` → 实例 `terminated`（令牌被取消 ≠ 办完）', async () => {
    const c = ctx();
    const id = await c.engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    c.sink.events.length = 0;

    await c.engine.submit(id, { action: 'terminate', actor: 'u_admin', comment: '业务取消' });
    expect(c.sink.names()).toEqual(['taskCancelled', 'terminated']);
    expect(c.sink.events[0]).toMatchObject({ taskStatus: 'cancelled' });
    mark(c.sink);
  });

  it('suspend：实例 `suspended` **先于** 待办 `taskUpdated`（实例状态是待办状态的原因）', async () => {
    const c = ctx();
    const id = await c.engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    c.sink.events.length = 0;

    await c.engine.submit(id, { action: 'suspend', actor: 'u_admin' });
    expect(c.sink.names()).toEqual(['suspended', 'taskUpdated']);
    expect(c.sink.events[1]).toMatchObject({ name: 'taskUpdated', taskStatus: 'suspended' });
    mark(c.sink);
  });

  it('resume：实例 `resumed` → 待办 `taskUpdated`（回到 active）', async () => {
    const c = ctx();
    const id = await c.engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    await c.engine.submit(id, { action: 'suspend', actor: 'u_admin' });
    c.sink.events.length = 0;

    await c.engine.submit(id, { action: 'resume', actor: 'u_admin' });
    expect(c.sink.names()).toEqual(['resumed', 'taskUpdated']);
    expect(c.sink.events[1]).toMatchObject({ taskStatus: 'active' });
    mark(c.sink);
  });

  it('★ reject：事件里的 `action` 与 `delta.action` **同一个对象**（都是 reject）', async () => {
    const def = makeDefinition({
      id: 'Definitions_reject',
      version: 1,
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        {
          id: 'Task_apply',
          type: 'userTask',
          name: '部门经理审批',
          approval: userApproval('u_manager'),
        },
        {
          id: 'Task_2',
          type: 'userTask',
          name: '财务审批',
          // ★ `allowedTargets` 是**类别**（'previous' / 'nodeId' / 'starter'），不是节点 id 白名单
          approval: userApproval('u_2', { reject: { allowed: true, allowedTargets: ['nodeId'] } }),
        },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Task_apply' },
        { from: 'Task_apply', to: 'Task_2' },
        { from: 'Task_2', to: 'End_1' },
      ],
    });
    const c = ctx(def);
    const id = await c.engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    await c.engine.submit(id, { action: 'approve', actor: 'u_manager' });
    c.sink.events.length = 0;

    const delta = await c.engine.submit(id, {
      action: 'reject',
      actor: 'u_2',
      target: 'Start_1',
      comment: '金额不符',
    } as ActionInput);

    expect(delta.action.name).toBe('reject');
    // 驳回后令牌回到 Task_apply：旧待办办结 + 新待办产生
    expect(c.sink.names()).toEqual(['taskCompleted', 'taskCreated', 'taskAssigned']);
    for (const e of c.sink.events) {
      expect(e.action.name).toBe('reject');
      expect(e.action).toBe(delta.action); // ★ 不是复制品
    }
    mark(c.sink);
  });

  it('★ 事件的 `at` 与本次动作同源（ADR-007：不另取一次时钟）', async () => {
    const c = ctx();
    const id = await c.engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    c.sink.events.length = 0;

    await c.engine.submit(id, { action: 'approve', actor: 'u_manager' });
    expect(c.sink.events.length).toBeGreaterThan(0);
    for (const e of c.sink.events) expect(e.at).toBe(T0);
  });

  it('★ 收口：10 个事件名全部被真实触发过（不是只在文档里写着）', () => {
    expect([...covered].sort()).toEqual([...ENGINE_EVENT_NAMES].sort());
  });
});

describe('eventsOf() 的判定（纯函数，门 2 自编排复用同一份）', () => {
  const graph = createProcessGraph(expenseDefinition(), PROCESS, 1);
  const action = { name: 'approve', actor: 'u_manager', at: T0 };

  it('令牌 `completed` → taskCompleted；`cancelled` → taskCancelled；不改入参', () => {
    const before = tasksOf(
      makeState({ tokens: [{ id: 'tk_1', nodeId: 'Task_apply', state: 'active', assignee: 'u_manager' }] }),
      graph,
    );
    const done: InstanceState = makeState({
      tokens: [{ id: 'tk_1', nodeId: 'Task_apply', state: 'completed', assignee: 'u_manager' }],
    });
    const cancelled: InstanceState = makeState({
      tokens: [{ id: 'tk_1', nodeId: 'Task_apply', state: 'cancelled', assignee: 'u_manager' }],
    });
    const deltaOf = (next: InstanceState): TaskDelta => ({
      rev: next.rev,
      action,
      added: [],
      removed: ['Task_apply:tk_1'],
      changed: [],
      instance: headerOf(next),
    });

    const snapshot = JSON.stringify({ before, done, cancelled });

    expect(eventsOf({ before, delta: deltaOf(done), next: done, previousStatus: 'running' })).toHaveLength(1);
    expect(eventsOf({ before, delta: deltaOf(done), next: done, previousStatus: 'running' })[0]?.name).toBe(
      'taskCompleted',
    );
    expect(
      eventsOf({ before, delta: deltaOf(cancelled), next: cancelled, previousStatus: 'running' })[0]?.name,
    ).toBe('taskCancelled');

    // ★ 纯函数性：调用前后入参必须一字不动（否则门 2 复用它时会出现"算第二遍结果不同"）
    expect(JSON.stringify({ before, done, cancelled })).toBe(snapshot);
  });

  it('同一入参两次调用 → 同一结果', () => {
    const before = tasksOf(
      makeState({ tokens: [{ id: 'tk_1', nodeId: 'Task_apply', state: 'active', assignee: 'u_manager' }] }),
      graph,
    );
    const next = makeState({
      tokens: [{ id: 'tk_1', nodeId: 'Task_finance', state: 'active', assignee: 'u_finance' }],
    });
    const delta: TaskDelta = {
      rev: next.rev,
      action,
      added: tasksOf(next, graph),
      removed: ['Task_apply:tk_1'],
      changed: [],
      instance: headerOf(next),
    };
    const input = { before, delta, next, previousStatus: 'running' as const };
    expect(JSON.stringify(eventsOf(input))).toBe(JSON.stringify(eventsOf(input)));
  });
});

describe('emitAll() 投递：丢了不影响流程', () => {
  const ev: EngineEvent = {
    name: 'started',
    at: T0,
    instanceId: 'pi_1',
    processId: PROCESS,
    definitionVersion: 1,
    status: 'running',
    action: { name: 'start', actor: 'u_1', at: T0 },
    instance: {
      instanceId: 'pi_1',
      processId: PROCESS,
      definitionVersion: 1,
      status: 'running',
      rev: 1,
      stateSchema: 1,
      startedAt: T0,
      updatedAt: T0,
    },
  };

  it('sink 同步抛错 → 不冒泡（否则会变成「提交失败但流程其实走完了」）', () => {
    const boom: EventSink = {
      emit(): void {
        throw new Error('sink boom');
      },
    };
    expect(() => emitAll(boom, [ev])).not.toThrow();
  });

  it('sink 返回 rejected promise → 不冒泡、也不留 unhandled rejection', async () => {
    const bad: EventSink = {
      emit(): Promise<void> {
        return Promise.reject(new Error('async boom'));
      },
    };
    expect(() => emitAll(bad, [ev])).not.toThrow();
    // 若上面没接住，这一轮会炸在 unhandled rejection 上
    await new Promise((r) => setTimeout(r, 0));
  });

  it('未注入 sink / 空事件列表 → 静默返回（不是错误）', () => {
    expect(() => emitAll(undefined, [ev])).not.toThrow();
    expect(() => emitAll(recordingSink(), [])).not.toThrow();
  });

  it('★ 事件投递失败不影响 `submit()` 的结果', async () => {
    const boom: EventSink = {
      emit(): void {
        throw new Error('boom');
      },
    };
    const c = ctx(expenseDefinition(), boom);
    const id = await c.engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    await expect(c.engine.submit(id, { action: 'approve', actor: 'u_manager' })).resolves.toBeDefined();
    // 状态照常推进：事件炸了，流程没炸
    const tasks = await c.projection.list(id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.nodeId).toBe('Task_finance');
  });
});
