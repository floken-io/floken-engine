/**
 * @floken-io/engine · 待办视图与差分（读线契约）
 *
 * 契约来源：`ARCHITECTURE.md` §6.2 / §6.4（INV-15）。
 *
 * 一句话记法：**`StateStore` = 真相（引擎的），`TaskProjection` = 视图（你的）。**
 * 引擎只吐 `TaskDelta`，**表结构归宿主** —— 所以这里只有形状，没有实现。
 */
import { LIVE_TOKEN_STATES } from './primitives.js';
import type { ActionRecord, InstanceState, InstanceStateHeader, Token } from './state.js';

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
 *
 * ★ **`kind` 的两档判据是「是不是 19 项审批动作之一」**，不是「谁发起的」：
 *   `start` / `callActivityReturn` / `deliverMessage` / `deliverSignal` 一律 `system`。
 *   ⚠️ 早期草案写的是 `'action' | 'primitive'`（原语级审计，**D-23**），**已否决** ——
 *   理由见 `ARCHITECTURE.md` **D-87**：`run-to-wait` 的令牌推进**不走 `advance` 原语**
 *   （`runtime/loop.ts` 直接改 `token.nodeId`），按原语记出来的"轨迹"里**没有令牌移动**，
 *   恰恰是"轨迹"最该有的那一半；且一次提交会炸出几十条，把 `maxAuditEntries` 的
 *   「保留最近 N 次变更」扭曲成「保留最近两次提交」。故 `kind` 只标**审批 / 非审批**这一档。
 *
 * ★ `from` / `to` / `tokenId` 由 `runtime/plan.ts` 填：取**动作实际作用的那个令牌**
 *   在推进前后的节点（`subjectTokenOf()` 是唯一口径 —— 与 `submit()` 认领令牌同一套判据，
 *   不是另写一份"看起来差不多"的定位逻辑）。
 */
export interface TraceEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  kind: 'approval' | 'system';
  nodeId?: string;
  tokenId?: string;
  /** 推进**前**令牌所在节点（动作发生地） */
  from?: string;
  /** 推进**后**令牌所在节点；令牌已终结则无 */
  to?: string;
  payload?: Record<string, unknown>;
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

/**
 * ★ 本次动作作用在**哪个令牌**上 —— **唯一口径**。
 *
 * 判据（与 `actions/compile.ts` 的 `resolveToken` 同一套，只是这里优先按 `actor` 认领）：
 *   ① 办理人 == `actor` 的在途令牌恰好 1 个 → 它（会签下"我办我那条"就是靠这条）；
 *   ② 否则若全局在途令牌恰好 1 个 → 它；
 *   ③ 否则 → `undefined`（交给 `compileAction` 报"无法唯一定位"，或该动作本就不需要令牌）。
 *
 * ⚠️ ① 与 ② 都不命中时**不猜**：猜错令牌 = 改到了别人的待办，是最难查的一类误伤。
 *
 * ★ 为什么必须收口到这一处：`submit()` 用它认领令牌，`plan()` 用它填审计的
 *   `tokenId` / `from` / `to`（**D-88**）。两处各写一份"看起来差不多"的定位逻辑，
 *   就会出现「审计说办的是 A 分支、实际推进的是 B 分支」—— 而两份代码单独看都对。
 */
export function subjectTokenOf(state: InstanceState, actor: string): Token | undefined {
  const live = state.tokens.filter((t) => LIVE_TOKEN_STATES.includes(t.state));
  if (live.length === 0) return undefined;

  const mine = live.filter((t) => t.assignee !== undefined && t.assignee === actor);
  if (mine.length === 1) return mine[0];
  if (live.length === 1) return live[0];
  return undefined;
}
