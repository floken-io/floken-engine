/**
 * @floken-io/engine · 事件派生与投递（T12 · ADR-006「节点级 5 + 实例级 5」）
 *
 * ★ **本文件是纯的**：`eventsOf()` 只从入参推事件，不读时钟、不碰存储、不发 I/O。
 *   为什么必须纯：**门 2（强一致自编排）下宿主自己调 `plan()`**，事件若由 `submit()` 单独推导，
 *   两条路径就会各发各的（与 D-18 同一个道理）。宿主自编排时调 `eventsOf()` 即可得到同一组事件。
 *
 * ★ **事件不是审计**：审计主源是 `InstanceState.auditTrail`（`03` §9.1 Plan A）。
 *   本文件的事件是**通知**，丢了不影响流程 —— 所以投递（下面的 `emitAll`）**不 await、不抛**。
 *
 * ## 派生规则（**顺序本身是契约**）
 *
 *   ① `started`（仅 `previousStatus === undefined`，即 `start()`）
 *   ② 非终态实例事件 `suspended` / `resumed` —— **先于**待办事件（实例状态是待办状态的原因）
 *   ③ 待办事件：`removed`（completed / cancelled）→ `added`（created → assigned）→ `changed`（updated）
 *   ④ 终态实例事件 `completed` / `terminated` —— **后于**待办事件（待办都结算了实例才终态）
 *
 *   ★ `taskCreated` **必先于** `taskAssigned`；无 `assignee` 时只发 `created`（ADR-006 的定序）。
 *
 * ## ⚠️ 一条诚实的边界
 *   `InstanceStatus` 有 5 个值，实例级事件却只有 5 个且**不含 `cancelled`** ——
 *   `cancelled` 是预留状态，**当前没有任何原语产出它**（只有 `halt` → `terminated`）。
 *   真出现了也不静默：由 `instanceEventNameOf()` 显式返回 `undefined` 并在头注释记档，
 *   将来若要有「实例取消」事件，须先改 ADR-006 的事件集，而不是在这里偷偷加。
 */
import type {
  EngineEvent,
  InstanceEvent,
  InstanceEventName,
  TaskEvent,
  TaskEventName,
} from '../core/events.js';
import type { EventSink } from '../core/spi.js';
import type { InstanceState, InstanceStatus } from '../core/state.js';
import { headerOf } from '../core/state.js';
import type { TaskDelta, TaskStatus, TaskView } from '../core/task.js';

/** `eventsOf()` 的入参 —— 全部可观测数据，无隐藏依赖 */
export interface EmitInput {
  /** 提交**前**的待办视图。`removed` 只有 taskId，事件字段（nodeId / assignee…）只能从这里取 */
  readonly before: readonly TaskView[];
  /** 本次差分（`added` / `removed` / `changed` + `action`） */
  readonly delta: TaskDelta;
  /** 提交**后**的完整状态（取 `tokens` 终态与 Header） */
  readonly next: InstanceState;
  /** 提交前的实例状态；**缺省 = 无前状态**（`start()`） */
  readonly previousStatus?: InstanceStatus | undefined;
}

/**
 * ★ 一次提交对应的全部事件（按上面 ①②③④ 的顺序）。
 *
 * 入参里没有 `at` —— 时间取 `delta.action.at`，与 `lastAction` / `auditTrail` **同源**
 * （三处各自取时间就会在重放时对不上）。
 */
export function eventsOf(input: EmitInput): EngineEvent[] {
  const { before, delta, next } = input;

  const base = {
    at: delta.action.at,
    instanceId: next.instanceId,
    processId: next.processId,
    definitionVersion: next.definitionVersion,
    action: delta.action,
  };

  const beforeMap = new Map(before.map((t) => [t.taskId, t]));
  const out: EngineEvent[] = [];

  const taskEvent = (name: TaskEventName, view: TaskView, taskStatus: TaskStatus): void => {
    const e: TaskEvent = {
      ...base,
      name,
      taskId: view.taskId,
      nodeId: view.nodeId,
      assignee: view.assignee,
      taskStatus,
    };
    if (view.nodeName !== undefined) e.nodeName = view.nodeName;
    if (view.formKey !== undefined) e.formKey = view.formKey;
    out.push(e);
  };

  const instanceEvent = (name: InstanceEventName): void => {
    const e: InstanceEvent = { ...base, name, status: next.status, instance: headerOf(next) };
    out.push(e);
  };

  // ① started
  if (input.previousStatus === undefined) instanceEvent('started');

  // ② 非终态实例事件（原因先于结果）
  const statusEvent = instanceEventNameOf(input.previousStatus, next.status);
  if (statusEvent === 'suspended' || statusEvent === 'resumed') instanceEvent(statusEvent);

  // ③ 待办事件
  for (const taskId of delta.removed) {
    const view = beforeMap.get(taskId);
    if (view === undefined) continue; // 不该发生：removed 必来自 before
    const name = removalEventName(view, next);
    taskEvent(name, view, name === 'taskCompleted' ? 'done' : 'cancelled');
  }

  for (const view of delta.added) {
    taskEvent('taskCreated', view, view.status);
    // ★ 无办理人只发 created —— 与 ADR-006 的定序一致（TaskView.assignee 必填，此守卫是防御性的）
    if (view.assignee.length > 0) taskEvent('taskAssigned', view, view.status);
  }

  for (const view of delta.changed) {
    taskEvent('taskUpdated', view, view.status);
  }

  // ④ 终态实例事件（结果后于原因）
  if (statusEvent === 'completed' || statusEvent === 'terminated') instanceEvent(statusEvent);

  return out;
}

/**
 * 实例状态迁移 → 实例级事件名。
 *
 * @returns `undefined` = 该迁移不产事件（状态没变，或 `cancelled` 这个预留状态）
 */
export function instanceEventNameOf(
  previous: InstanceStatus | undefined,
  next: InstanceStatus,
): InstanceEventName | undefined {
  if (previous === undefined) return 'started';
  if (previous === next) return undefined;
  if (next === 'suspended') return 'suspended';
  if (next === 'running') return 'resumed';
  if (next === 'completed') return 'completed';
  if (next === 'terminated') return 'terminated';
  // `cancelled`：ADR-006 的实例级 5 个里没有它，且当前无原语产出该状态
  return undefined;
}

/**
 * 一条待办是怎么没的？
 *
 * ★ 判据来自**令牌终态**（权威），不是猜：
 *   - 令牌 `completed` → `taskCompleted`
 *   - 令牌 `cancelled` → `taskCancelled`
 *   - 令牌还在途但**换了节点** → 办完了才往前走 → `taskCompleted`
 *   - 令牌还在途且**还在原节点** → 待办被摘掉（委派 / 收回 / 重解析）→ `taskCancelled`
 *   - 令牌已不存在 → `taskCancelled`
 */
function removalEventName(view: TaskView, next: InstanceState): 'taskCompleted' | 'taskCancelled' {
  const token = next.tokens.find((t) => `${view.nodeId}:${t.id}` === view.taskId);
  if (token === undefined) return 'taskCancelled';
  if (token.state === 'completed') return 'taskCompleted';
  if (token.state === 'cancelled') return 'taskCancelled';
  return token.nodeId === view.nodeId ? 'taskCancelled' : 'taskCompleted';
}

/**
 * ★ 投递：**不 await、不抛**（`EventSink` 的语义是「丢了不影响流程」）。
 *
 * ⚠️ 两个必须防的坑，宿主自己写投递时最容易踩：
 *   ① `emit()` 返回 rejected Promise 却没人接 → **unhandled rejection 会把进程拖崩**；
 *   ② `emit()` 同步抛错 → 若不加捕获会把 `submit()` 一起带崩，而状态**已经落库了**，
 *      于是宿主看到「提交失败但流程其实走完了」—— 最坏的一类不一致。
 *
 * ⇒ 两者都在这里吞掉。想要「提交返回前事件已落地」的保证，请用**门 1 `afterAction`**（引擎 await 它）。
 */
export function emitAll(sink: EventSink | undefined, events: readonly EngineEvent[]): void {
  if (sink === undefined || events.length === 0) return;
  for (const event of events) {
    try {
      const r: unknown = sink.emit(event);
      // 只接 rejected，不 await（不阻塞）
      if (r !== null && typeof r === 'object' && typeof (r as Promise<void>).then === 'function') {
        (r as Promise<void>).then(undefined, () => undefined);
      }
    } catch {
      // 事件丢了不影响流程 —— 但**不能**让它污染 submit() 的成败
    }
  }
}
