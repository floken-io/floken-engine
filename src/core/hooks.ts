/**
 * @floken-io/engine · 门 1 `hooks`（同步、阻塞的动作级钩子）
 *
 * 契约来源：`ARCHITECTURE.md` §7.3 / ADR-004。
 *
 * ★ **选门 1 还是门 2 的判据只有一句：这个写失败了，流程还能不能继续？**
 *
 * | 场景 | 失败后果 | 走哪条 |
 * |---|---|---|
 * | 驳回后发消息、写埋点、同步搜索索引 | 能继续 | **门 1**（本文件）/ `EventSink` —— 最终一致 |
 * | 票签更新计票表、驳回改业务主表状态 | **流程会走错分支** | **门 2** `plan()` 自编排（同一事务） |
 *
 * ⚠️ 与 `EventSink` 的区别（两张网，别混）：本线是**动作级**（一次 `submit()` 恰一对
 * `before`/`after`）、**同步阻塞**、失败不吞；`EventSink` 是**事件级**（一次可能多条）、
 * **异步不阻塞**、丢了不影响流程。
 */
import type { InstanceStateHeader } from './state.js';
import type { ActionRecord } from './state.js';
import type { TaskDelta } from './task.js';

/**
 * 钩子上下文。
 * ★ `action` 与 `delta.action` **同源**（引擎只造一份 `ActionRecord`）——
 * 宿主据此把「通过了一步」与「被驳回了」路由到不同处理。
 */
export interface ActionContext {
  /** 动作事实（与 `delta.action` 同源） */
  readonly action: ActionRecord;
  /** 动作**前**的状态快照（只读；Header 已够路由，需要体请用 `plan()` 或 `load()`） */
  readonly state: InstanceStateHeader;
  /** `save()` **之后**的状态快照 */
  readonly next: InstanceStateHeader;
  readonly delta: TaskDelta;
}

export interface EngineHooks {
  /**
   * 写入**前**调用，**可否决**：返回 `false` 或抛错 → 中止本次动作（不写库）。
   *
   * ⚠️ **只可读**：不允许改写 `ctx.action` / `ctx.state`。
   * 想改行为请改定义或改 `ActionInput` 后重新提交 —— 允许就地改写会让
   * 「走 `submit()` 和走 `plan()` 得到不同 `next`」成为可能，直接破坏两条路径一致性。
   *
   * 实现手段见 `freezeActionContext()`：**深拷贝 + 深冻结**，改写在严格模式下直接抛 `TypeError`。
   *
   * @returns `false` = 否决（引擎抛 `ENGINE_ACTION_VETOED`）；其余返回值视为放行。
   *   需要带原因时请**抛自己的错误**（会原样冒泡），别只 `return false`。
   */
  beforeAction?(ctx: ActionContext): boolean | void | Promise<boolean | void>;
  /**
   * `save()` **之后**、引擎 `await` 它；**失败不吞**，按可重试上报。
   *
   * 语义 = **至少一次投递，宿主必须幂等**（与 `EventSink` 同一保证，但同步、且按
   * `ctx.action.name` 路由到 19 项动作名）。
   *
   * ⚠️ 抛错时**状态已落库** —— 宿主会看到「`submit()` 失败但流程其实走完了」。
   * 这不是 bug，是「至少一次」的代价：重试时请先查状态，别盲目重放。
   */
  afterAction?(ctx: ActionContext): void | Promise<void>;
}

// ---------------- 只读保证（T12） ----------------

/**
 * ★ 把 `ActionContext` 变成**宿主改不动**的快照（门 1 只读契约的实现手段）。
 *
 * 为什么是「**深拷贝 + 深冻结**」两步，不能只冻结：
 *   - 只冻结 → 冻的是引擎自己要用的对象，返回给调用方的 `TaskDelta` 也跟着不可变（越权）；
 *   - 只拷贝 → 宿主改了也没痕迹，但「改了不生效」比「改了抛错」更难查
 *     （红笔写错作业和铅笔写错作业的区别）。
 *
 * ESM 恒为严格模式 ⇒ 给冻结对象赋值会**抛 `TypeError`**，
 * 于是「不允许改写 `ctx.action`」这条从**纪律**变成了**可测的事实**。
 *
 * ⚠️ 内部工具，**不对外导出**（`src/entries/index.ts` 的导出判据：不是宿主接入所必需）。
 */
export function freezeActionContext(ctx: ActionContext): ActionContext {
  return deepFreeze(jsonClone(ctx));
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
