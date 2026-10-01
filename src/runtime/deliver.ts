/**
 * @floken-io/engine · **投递的纯执行段**（T20 · `runtime/deliver.ts`）
 *
 * ★ 与 `runtime/loop.ts` 的 `step()` **同层、同性质**：纯函数，门 1（`submit` 系）与
 *   门 2（宿主自编排）共用同一份。它做的三件事依次是：
 *
 *   ```
 *   ① 找出本次投递命中了哪些等待中的令牌（精确匹配 kind + name）
 *   ② 摘掉它们的等待态（`Token.awaiting`）并**离开等待节点**
 *   ③ run-to-wait —— 从等待节点的后继继续走到下一个稳定点（可能一路走到结束事件）
 *   ```
 *
 * ★ **② 为什么"摘等待态"必须和"离开节点"一起做**，不能只摘等待态就交给 `runToWait()`：
 *   `run-to-wait` 见到 `intermediateCatchEvent` / `receiveTask` 就会**再停一次**（那是它的职责）。
 *   只摘等待态 = 令牌被原地重新停车 —— 表现为「投递返回了差分、状态也写了，
 *   但令牌一动没动」，且**没有任何报错**。
 *   ⇒ 唤醒的语义本来就是「**离开**等待节点」（与 `callReturnOf()` 放行停在 `callActivity`
 *   上的令牌同一形态），不是"在同一个节点上再等一次"。
 * ★ **为什么必须单独一个函数**（而不是在 `engine.ts` 里"顺手改一下状态"）：
 *   门 2 下宿主自己 `load()` → `plan()` → 写库，投递这一步也得他自己做；
 *   若它只活在 `deliverMessage()` 里，门 2 就得复制一份「怎么匹配 / 怎么唤醒 / 怎么推进」，
 *   于是 §7.1「两条路径不得分叉」从**结构保证**退化成**纪律问题**（与 `step()` 必须公开同一条理由）。
 *
 * ⚠️ **本档不含任何不纯动作**：load / save / 投影 / 钩子 / 事件全在 `runtime/engine.ts`
 *   （刻意保持「`engine.ts` 是唯一不纯文件」这条不变 —— 见 NFR-E6）。
 */

import { definitionMissing, deliverNoTarget } from '../core/errors.js';
import { clearAssignment, markCompleted } from '../core/primitives.js';
import type { InstanceState } from '../core/state.js';
import { matchingTokens, waitingNamesOf, wakeTokens } from '../nodes/catch.js';
import type { DeliverMatch } from '../nodes/catch.js';
import { runToWait } from './loop.js';
import type { LoopContext, LoopResult } from './loop.js';

export type { DeliverMatch };

/** `deliverStep()` 的结果 */
export interface DeliverResult extends LoopResult {
  /** 被本次投递唤醒的令牌 id（顺序 = 状态里的顺序，故可重放） */
  readonly woken: readonly string[];
  /** 被唤醒令牌**当时所在的**节点 id（与 `woken` 一一对应）—— 审计与诊断要记「唤醒了哪儿」 */
  readonly nodeIds: readonly string[];
}

/**
 * ★ 一次投递的**纯**执行段。
 *
 * @throws `ENGINE_ACTION_TARGET_INVALID` —— 一个都没命中（**绝不静默丢弃**，理由见
 *   `core/errors.ts` 的 `deliverNoTarget`）。广播场景下调用方应先用
 *   `matchingTokens()` 判断，**只把命中的实例交给本函数**。
 */
export function deliverStep(
  state: InstanceState,
  ctx: LoopContext,
  match: DeliverMatch,
): DeliverResult {
  const matches = matchingTokens(state, match);
  if (matches.length === 0) {
    throw deliverNoTarget(state.instanceId, match.kind, match.name, waitingNamesOf(state));
  }

  const woken = matches.map((t) => t.id);
  const nodeIds = matches.map((t) => t.nodeId);

  // ② 摘等待态 + 离开等待节点（顺序不能反：带着 awaiting 推进会被判成稳定点、原地不动）
  const started = leaveWait(state, woken, ctx.graph);
  // ③ 继续推进
  const r = runToWait(started, ctx);

  return { next: r.next, landings: r.landings, events: r.events, pendingCalls: r.pendingCalls, woken, nodeIds };
}

/**
 * ★ 摘掉等待态 + **离开**等待节点（记账 + 换节点 + 清办理人，与 `run-to-wait` 的
 *   自动直通同一口径）。
 *
 * @throws `ENGINE_STATE_DEFINITION_MISSING` —— 等待节点没有出向（定义画错了：死路）
 */
function leaveWait(
  state: InstanceState,
  tokenIds: readonly string[],
  graph: LoopContext['graph'],
): InstanceState {
  const next = wakeTokens(state, tokenIds);
  for (const id of tokenIds) {
    const t = next.tokens.find((x) => x.id === id);
    if (t === undefined) continue; // `wakeTokens` 已在前面抛过
    const to = graph.nextOf(t.nodeId);
    if (to === undefined) {
      throw definitionMissing(graph.processId, graph.definitionVersion);
    }
    markCompleted(next, t.nodeId); // ★ 离开即记账（D-28 同口径）
    t.nodeId = to;
    clearAssignment(t);
  }
  return next;
}
