/**
 * @floken-io/engine · 10 个业务事件（节点级 5 + 实例级 5）
 *
 * 契约来源：`ARCHITECTURE.md` §7.3 / ADR-006。
 *
 * 三条定死的口径：
 *  1. **固定顺序**：`taskCreated` 必先于 `taskAssigned`（无 `assignee` 时只发 `created`）。
 *     —— 特意**不抄** Flowable 的「`assignment` 早于 `create`」：它那么做是因为要先定
 *     assignee 再实例化 task，语义混乱。
 *  2. **有意不采**：连线级 `flow.take`（`auditTrail` 已记 `from`/`to`，且噪音最大）、
 *     内核生命周期 `enter`/`leave`（暴露即锁死内核实现）→ **只发业务语义事件**。
 *  3. 出口是 `EventSink`（异步、不阻塞、丢了不影响流程）；**审计不走这里** ——
 *     审计主源是 `InstanceState.auditTrail`。
 *
 * `taskUpdated` 是**刻意加入**的第 5 个节点级事件：四家引擎里只有 Camunda 8 单独给它
 * 一个事件（`updating`），有道理 —— 变量变更也得同步到宿主的待办视图。
 */
import type { ActionRecord, InstanceStateHeader, InstanceStatus } from './state.js';
import type { TaskStatus } from './task.js';

export type TaskEventName =
  | 'taskCreated'
  | 'taskAssigned'
  | 'taskUpdated'
  | 'taskCompleted'
  | 'taskCancelled';

export type InstanceEventName =
  | 'started'
  | 'completed'
  | 'terminated'
  | 'suspended'
  | 'resumed';

export type EngineEventName = TaskEventName | InstanceEventName;

export const TASK_EVENT_NAMES = [
  'taskCreated',
  'taskAssigned',
  'taskUpdated',
  'taskCompleted',
  'taskCancelled',
] as const satisfies readonly TaskEventName[];

export const INSTANCE_EVENT_NAMES = [
  'started',
  'completed',
  'terminated',
  'suspended',
  'resumed',
] as const satisfies readonly InstanceEventName[];

/** 全部 10 个事件名（顺序即文档顺序，便于快照测试） */
export const ENGINE_EVENT_NAMES = [
  ...TASK_EVENT_NAMES,
  ...INSTANCE_EVENT_NAMES,
] as const satisfies readonly EngineEventName[];

interface EngineEventBase {
  at: string;
  /** 引擎生成、全局唯一 */
  instanceId: string;
  processId: string;
  definitionVersion: number;
  /** 触发本次事件的动作事实（与 `InstanceState.lastAction` / `delta.action` 同源） */
  action: ActionRecord;
}

/** 节点级（待办）事件 —— 一次 `submit()` 可能发多条 */
export interface TaskEvent extends EngineEventBase {
  name: TaskEventName;
  taskId: string;
  nodeId: string;
  nodeName?: string;
  /** 未分配时缺省（此时只发 `taskCreated`，不发 `taskAssigned`） */
  assignee?: string;
  taskStatus: TaskStatus;
  formKey?: string;
}

/** 实例级事件 —— 一次 `submit()` 至多一条 */
export interface InstanceEvent extends EngineEventBase {
  name: InstanceEventName;
  status: InstanceStatus;
  /** 实例头快照，宿主不用再 `load()` 一次 */
  instance: InstanceStateHeader;
}

export type EngineEvent = TaskEvent | InstanceEvent;

export function isTaskEvent(e: EngineEvent): e is TaskEvent {
  return (TASK_EVENT_NAMES as readonly string[]).includes(e.name);
}

export function isInstanceEvent(e: EngineEvent): e is InstanceEvent {
  return (INSTANCE_EVENT_NAMES as readonly string[]).includes(e.name);
}
