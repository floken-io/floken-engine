/**
 * @floken-io/engine · 动作输入（`ARCHITECTURE.md` §7.1 `ActionInput`）
 *
 * ★ 这是 `submit()` 与 `plan()` **共用**的入参形状 —— 两条路径的状态演化必须完全一致
 *   （§7.1 写死），所以该类型必须住在 `core/`（最底层），不能长在 `runtime/` 里。
 *
 * ★ 本档**不含任何动作语义**：`action` 只是一个字符串名。19 项动作的合法性与开关校验
 *   归 `actions/catalog.ts` + `actions/gates.ts`（T9）—— 把名字表提前写进 core 会让
 *   「内核可脱离审批概念单独测试」（NFR-E6）失守。
 */

import { optionInvalid } from './errors.js';

/**
 * 一次提交的输入。
 *
 * `at` 是 **ADR-007 的确定性入口**：给了它，`plan()` 的结果与系统时钟彻底无关；
 * 不给则由 `EngineConfig.clock()` 在 `submit()` 内补上（槽位 3，在调 `plan()` **之前**）。
 */
export interface ActionInput {
  /** 19 项动作名之一（未开启 → 抛错，DV-2） */
  action: string;
  actor: string;
  /** `requireComment` 为 true 时必填（DV-3） */
  comment?: string;
  /** `reject` / `rejectToPrev` / `jumpTo` / `returnTo` 的目标 nodeId（INV-6） */
  target?: string;
  /**
   * ★ 本次动作**作用于哪条待办** —— `tokenId` 与 `nodeId` 可单独给、也可一起给
   * （**推荐一起给**：调度方手里两个都有，见 {@link ScheduleRequest}）。
   *
   * ⚠️ 为什么要有它：超时动作是**延迟**执行的，等它到点那条待办可能早就办完了。
   * 没有它时引擎只能按 `actor` 找"当前待办"，于是迟到的动作会**打到另一条待办上**
   * —— 实测：本该驳回 `Task_a` 的动作，把同审批人的 `Task_b` 给退回了，语义全错。
   *
   * ⚠️ 为什么光有 `tokenId` 不够：**令牌 id 在节点之间是复用的**
   * （实测 `tk_start` 从 `Task_a` 走到 `Task_b` 仍是 `tk_start`），
   * 所以只有同时校验「这个令牌**还在不在那个节点上**」才认得出"待办已经走了"。
   *
   * 给了却命中不到 / 令牌已离开该节点 → **抛错**，绝不改打别的待办。
   * 都不给 = 老行为（按 `actor` 定位），单活令牌场景下等价。
   */
  tokenId?: string | undefined;
  nodeId?: string | undefined;
  /** 表单增量 / 变量更新 → 并入 `variables` */
  payload?: Record<string, unknown>;
  /** 显式时间（ISO 8601）。缺省由 `clock()` 填 —— ADR-007 */
  at?: string;
}

/**
 * `ActionInput` 的形状校验（**只管形状，不管语义**）。
 *
 * 抛出的码选 `ENGINE_OPTION_INVALID`：它离「调用方传参非法」最近 ——
 * 既不是实例状态问题（STATE_），也不是动作受理问题（ACTION_ 的语义归 T9），
 * 更不是存储冲突（PERSIST_）。
 *
 * 参数刻意声明为 `unknown`（而不是 `ActionInput`）：本函数就是用来挡住
 * 「宿主从 HTTP 边界直接拿到、未经校验的对象」的，声明成 `ActionInput` 等于没校验。
 */
export function assertActionInput(action: unknown, path = '$'): asserts action is ActionInput {
  if (typeof action !== 'object' || action === null || Array.isArray(action)) {
    throw optionInvalid(path, 'must be a plain object', action);
  }
  const a = action as Record<string, unknown>;
  const fail = (field: string, reason: string): never => {
    throw optionInvalid(`${path}.${field}`, reason, a[field]);
  };

  if (typeof a.action !== 'string' || a.action.length === 0) {
    fail('action', 'must be a non-empty string');
  }
  if (typeof a.actor !== 'string' || a.actor.length === 0) {
    fail('actor', 'must be a non-empty string');
  }
  if (a.comment !== undefined && typeof a.comment !== 'string') {
    fail('comment', 'must be a string when present');
  }
  if (a.target !== undefined && typeof a.target !== 'string') {
    fail('target', 'must be a string when present');
  }
  if (a.at !== undefined && (typeof a.at !== 'string' || a.at.length === 0)) {
    fail('at', 'must be a non-empty ISO 8601 string when present');
  }
  if (a.tokenId !== undefined && (typeof a.tokenId !== 'string' || a.tokenId.length === 0)) {
    fail('tokenId', 'must be a non-empty string when present');
  }
  if (a.nodeId !== undefined && (typeof a.nodeId !== 'string' || a.nodeId.length === 0)) {
    fail('nodeId', 'must be a non-empty string when present');
  }
  if (a.payload !== undefined && (typeof a.payload !== 'object' || a.payload === null)) {
    fail('payload', 'must be a plain object when present');
  }
}
