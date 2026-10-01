/**
 * @floken-io/engine · 待办视图与差分（读线契约）
 *
 * 契约来源：`ARCHITECTURE.md` §6.2 / §6.4（INV-15）。
 *
 * 一句话记法：**`StateStore` = 真相（引擎的），`TaskProjection` = 视图（你的）。**
 * 引擎只吐 `TaskDelta`，**表结构归宿主** —— 所以这里只有形状，没有实现。
 */
import type { ActionRecord, InstanceStateHeader } from './state.js';

export type TaskStatus = 'active' | 'delegated' | 'suspended' | 'cancelled' | 'done';

/**
 * ★ **5 值**（不是 4 值）：
 * - `active` —— 待办，可办理
 * - `delegated` —— 已委派他人，原办理人保留可见
 * - `suspended` —— 随实例挂起而冻结（INV-5）
 * - `cancelled` —— 被汇聚/终止取消（INV-9 属此类）
 * - `done` —— 已办结
 */
export const TASK_STATUSES = [
  'active',
  'delegated',
  'suspended',
  'cancelled',
  'done',
] as const satisfies readonly TaskStatus[];

export interface TaskView {
  taskId: string;
  instanceId: string;
  nodeId: string;
  nodeName?: string;
  assignee: string;
  status: TaskStatus;
  createdAt: string;
  /** 超时截止（工作日历算出），`Scheduler` 用 */
  dueAt?: string;
  formKey?: string;
}

/**
 * 待办视图差分。
 *
 * ⚠️ 头号静默错误是**只处理 `added`**：`removed` 里的 taskId 必须**真删**
 * （INV-15 断言「apply 之后查不到」）。`removed` 是 id 列表，不是 `TaskView`。
 */
export interface TaskDelta {
  /** 对应 `InstanceState.rev` —— 投影据此判幂等与追平（INV-18） */
  rev: number;
  /** ★ 必做：不带动点名，宿主分不出「通过一步」与「被驳回」 */
  action: ActionRecord;
  added: TaskView[];
  /** taskId 列表 */
  removed: string[];
  changed: TaskView[];
  /** 供宿主取 `businessKey` / `tenantId` / `status`（不解体 body） */
  instance: InstanceStateHeader;
}

/**
 * `exportTrace()` 的返回元素，**派生自 `auditTrail`**（不新增存储）。
 * `kind` 区分「审批动作」（19 项）与「内核原语」（10 个）—— 调试时才需要这一层。
 */
export interface TraceEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  nodeId?: string;
  from?: string;
  to?: string;
  kind: 'action' | 'primitive';
}

/**
 * 待办差分（**纯函数**：`plan()` 与 `submit()` 共用同一份算法）。
 *
 * ⚠️ `removed` 是**真删**的 id 列表（INV-15）—— 只处理 `added` 是头号静默错误：
 * 驳回 / 终止之后旧待办还挂在表里，用户点进去是一个早已不存在的待办。
 *
 * ★ 为什么必须在 `plan()` 内部算（而不是 `submit()` 算完再塞回 delta）：
 *   门 2 下宿主直接调 `plan()` 也要拿到完整 delta —— 差分算法若住在 `submit()` 里，
 *   两条路径就会各算各的（§7.1 写死的一致性当场失守）。
 */
export function diffTasks(
  before: readonly TaskView[],
  after: readonly TaskView[],
): Pick<TaskDelta, 'added' | 'removed' | 'changed'> {
  const b = new Map(before.map((t) => [t.taskId, t]));
  const a = new Map(after.map((t) => [t.taskId, t]));

  const added = after.filter((t) => !b.has(t.taskId));
  const removed = [...b.keys()].filter((id) => !a.has(id));
  const changed = after.filter((t) => {
    const prev = b.get(t.taskId);
    return prev !== undefined && JSON.stringify(prev) !== JSON.stringify(t);
  });

  return { added: [...added], removed, changed: [...changed] };
}

/** 本次差分是否什么都没动（宿主可据此跳过投影写库） */
export function isEmptyDelta(delta: TaskDelta): boolean {
  return delta.added.length === 0 && delta.removed.length === 0 && delta.changed.length === 0;
}

/**
 * 本差分触碰到的全部 taskId（去重，保序：removed → added → changed）。
 * 投影实现拿它定位要写的行；契约测试用它做「同 delta 重复 apply 结果不变」（INV-15）。
 */
export function touchedTaskIds(delta: TaskDelta): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of delta.removed) push(id);
  for (const t of delta.added) push(t.taskId);
  for (const t of delta.changed) push(t.taskId);
  return out;
}
