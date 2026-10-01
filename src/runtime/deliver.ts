/**
 * @floken-io/engine · **投递的纯执行段**（T20 落地 / T21 扩展 · `runtime/deliver.ts`）
 *
 * ★ 与 `runtime/loop.ts` 的 `step()` **同层、同性质**：纯函数，门 1（`submit` 系）与
 *   门 2（宿主自编排）共用同一份。它做的事依次是：
 *
 *   ```
 *   ① 找出本次投递命中了哪些等待中的令牌（精确匹配 kind + name）
 *   ② 竞速结算：同一 `Token.race` 里只留**第一个**，其余取消（T21 · `EventBasedGateway`）
 *   ③ 兜底 / 并集：命中不到等待令牌时，改问**边界事件**（`nodes/boundary.ts`）
 *   ④ 摘掉等待态（`Token.awaiting`）并**离开等待节点**
 *   ⑤ run-to-wait —— 从等待节点的后继继续走到下一个稳定点（可能一路走到结束事件）
 *   ```
 *
 * ★ **④ 为什么"摘等待态"必须和"离开节点"一起做**，不能只摘等待态就交给 `runToWait()`：
 *   `run-to-wait` 见到 `intermediateCatchEvent` / `receiveTask` 就会**再停一次**（那是它的职责）。
 *   只摘等待态 = 令牌被原地重新停车 —— 表现为「投递返回了差分、状态也写了，
 *   但令牌一动没动」，且**没有任何报错**。
 *   ⇒ 唤醒的语义本来就是「**离开**等待节点」（与 `callReturnOf()` 放行停在 `callActivity`
 *   上的令牌同一形态），不是"在同一个节点上再等一次"。
 *
 * ★ **为什么必须单独一个函数**（而不是在 `engine.ts` 里"顺手改一下状态"）：
 *   门 2 下宿主自己 `load()` → `plan()` → 写库，投递这一步也得他自己做；
 *   若它只活在 `deliverMessage()` 里，门 2 就得复制一份「怎么匹配 / 怎么唤醒 / 怎么推进」，
 *   于是 §7.1「两条路径不得分叉」从**结构保证**退化成**纪律问题**（与 `step()` 必须公开同一条理由）。
 *
 * ## ★ T21 新增的两件事
 *
 *   **② 竞速（`EventBasedGateway`）**：事件网关分叉出来的令牌共享一个 `Token.race`。
 *   BPMN 的语义是「**只走第一个到达的事件**，其余分支**取消**」。少了这一步会变成
 *   「两个事件都到了、流程走了两条分支」—— 而它**不会报错**，只是莫名多出一条待办。
 *   ⚠️ 取消范围是**同 race 的全部在途令牌**，不只是"本次也匹配上的那些"：
 *   另一条分支在等一个**别的**消息时，它同样输了这场竞速，必须一并退场
 *   （否则它会永远停在那里，而流程已经沿赢家的分支走完了）。
 *
 *   **③ 边界事件**：边界事件**不持有令牌**，故 `matchingTokens()` 永远看不到它。
 *   命中集合因此有两类来源，按投递种类区别对待（★ 这是 BPMN 的既有语义，不是发明）：
 *     - `message`（**点对点**，1:1）→ **先在等待令牌里找**；找不到才去问边界事件，
 *       且只取**第一个**。消息只有一个接收者，"两个都命中"是定义问题，引擎按**顺序**取定。
 *     - `signal`（**广播**，1:N）→ 等待令牌与边界事件**全都命中**，一个都不落。
 *
 * ⚠️ **本档不含任何不纯动作**：load / save / 投影 / 钩子 / 事件全在 `runtime/engine.ts`
 *   （刻意保持「`engine.ts` 是唯一不纯文件」这条不变 —— 见 NFR-E6）。
 */

import { definitionMissing, deliverNoTarget } from '../core/errors.js';
import { LIVE_TOKEN_STATES, clearAssignment, markCompleted } from '../core/primitives.js';
import type { InstanceState, Token } from '../core/state.js';
import { cloneState } from '../core/state.js';
import { armedBoundaries, armedNamesOf, boundaryTokenOf, cancelTargetsOf } from '../nodes/boundary.js';
import type { BoundaryBinding, BoundaryFire } from '../nodes/boundary.js';
import { matchingTokens, waitingNamesOf, wakeTokens } from '../nodes/catch.js';
import type { CatchKind, DeliverMatch } from '../nodes/catch.js';
import { runToWait } from './loop.js';
import type { LoopContext, LoopResult } from './loop.js';

export type { DeliverMatch };

/**
 * 投递种类决定**命中集合怎么取**。
 * - `'point'` —— 点对点（`deliverMessage`）：等待令牌优先，兜底边界事件且只取第一个；
 * - `'broadcast'` —— 广播（`deliverSignal`）：等待令牌与边界事件**并集**，一个都不落。
 */
export type DeliverMode = 'point' | 'broadcast';

/** 一次边界触发的事实（供审计 / 诊断） */
export interface FiredBoundary {
  /** 边界事件自己的节点 id */
  readonly nodeId: string;
  /** 宿主活动 id */
  readonly attachedTo: string;
  readonly cancelActivity: boolean;
  readonly hostTokenId: string;
}

/** `deliverStep()` 的结果 */
export interface DeliverResult extends LoopResult {
  /** 被本次投递唤醒的令牌 id（顺序 = 状态里的顺序，故可重放） */
  readonly woken: readonly string[];
  /** 被唤醒令牌**当时所在的**节点 id（与 `woken` 一一对应）—— 审计与诊断要记「唤醒了哪儿」 */
  readonly nodeIds: readonly string[];
  /**
   * ★ 因本次投递而**输掉竞速**被取消的令牌 id（T21）。
   * 没有事件网关时恒为空数组（**不是** `undefined` —— 免得每个调用点判空）。
   */
  readonly racedOut: readonly string[];
  /** ★ 本次触发的边界事件（T21） */
  readonly fired: readonly FiredBoundary[];
}

/**
 * ★ 一次投递的**纯**执行段。
 *
 * @throws `ENGINE_ACTION_TARGET_INVALID` —— 一个都没命中（**绝不静默丢弃**，理由见
 *   `core/errors.ts` 的 `deliverNoTarget`）。广播场景下调用方应先用
 *   `matchingTokens()` / `armedBoundaries()` 判断，**只把命中的实例交给本函数**。
 */
export function deliverStep(
  state: InstanceState,
  ctx: LoopContext,
  match: DeliverMatch,
  mode: DeliverMode = 'point',
): DeliverResult {
  const graph = ctx.graph;
  const matches = matchingTokens(state, match);

  // ② 竞速：同一 race 只留第一个
  const winners = pickRaceWinners(matches);

  // ③ 边界事件：点对点只在"一个等待令牌都没命中"时兜底且取第一个；广播取全部
  const fires: readonly BoundaryFire[] =
    mode === 'broadcast'
      ? armedBoundaries(state, graph, match)
      : winners.length === 0
        ? armedBoundaries(state, graph, match).slice(0, 1)
        : [];

  if (winners.length === 0 && fires.length === 0) {
    /*
     * ★ 报错要给**合法取值**，边界事件也要列出来：宿主常常把消息名写在**边界事件**上，
     *   若只列 catch 节点，他看见「没有在等 Msg_cancel」也无从修起。
     */
    throw deliverNoTarget(state.instanceId, match.kind, match.name, [
      ...waitingNamesOf(state),
      ...armedNamesOf(state, graph),
    ]);
  }

  // ②b 输掉竞速的同批分支一律退场（不只是"本次也匹配上的"）
  const racedOut = resolveRace(state, winners);

  // ④+⑤ 先落边界触发（取消宿主 / 造令牌），再摘等待态离开节点，最后统一推进
  let cur = applyBoundaryFires(state, fires, racedOut);
  if (winners.length > 0) cur = leaveWait(cur, winners.map((t) => t.id), graph);
  const r = runToWait(cur, ctx);

  return {
    next: r.next,
    landings: r.landings,
    events: r.events,
    pendingCalls: r.pendingCalls,
    woken: winners.map((t) => t.id),
    nodeIds: winners.map((t) => t.nodeId),
    racedOut,
    fired: fires.map((f) => ({
      nodeId: f.boundary.nodeId,
      attachedTo: f.boundary.attachedTo,
      cancelActivity: f.boundary.cancelActivity,
      hostTokenId: f.hostTokenId,
    })),
  };
}

// ---------------- 竞速（EventBasedGateway） ----------------

/**
 * 同一 `race` 里只留**第一个**（顺序 = 状态里的顺序，故结果确定）。
 *
 * ⚠️ 没有 `race` 的令牌一律保留 —— 它们不在任何竞速里，投递命中几个就唤醒几个。
 */
function pickRaceWinners(matches: readonly Token[]): readonly Token[] {
  const winners: Token[] = [];
  const seen = new Set<string>();
  for (const t of matches) {
    if (t.race === undefined) {
      winners.push(t);
      continue;
    }
    if (seen.has(t.race)) continue;
    seen.add(t.race);
    winners.push(t);
  }
  return winners;
}

/**
 * ★ 该取消哪些"输掉竞速"的在途令牌。
 *
 * 判据 = 「与某个赢家**同 race**」且「不是赢家本人」且「还在途」。
 *
 * ⚠️ 为什么不能只取消 `matches` 里的落选者：另一条分支可能在等**另一个**消息
 *   （比如 A 等 `Msg_paid`、B 等 `Msg_cancel`），它**不在**本次 `matches` 里 ——
 *   但它同样输了这场竞速。不取消它，它会永远停在分支上：表现为流程沿赢家走完了，
 *   而 `tokens` 里还躺着一个"活着"的令牌，实例状态却已经终态。
 */
function resolveRace(state: InstanceState, winners: readonly Token[]): readonly string[] {
  const races = new Set<string>();
  for (const w of winners) if (w.race !== undefined) races.add(w.race);
  if (races.size === 0) return [];

  const winnerIds = new Set(winners.map((t) => t.id));
  return state.tokens
    .filter(
      (t) =>
        t.race !== undefined &&
        races.has(t.race) &&
        !winnerIds.has(t.id) &&
        LIVE_TOKEN_STATES.includes(t.state),
    )
    .map((t) => t.id);
}

// ---------------- 边界触发 ----------------

/**
 * ★ 施加边界触发 + 竞速退场（**纯**：不改入参）。
 *
 * 顺序：先取消（竞速落选 / 中断边界的宿主作用域），再**造**触发令牌 ——
 * 造出来的令牌不能被随后的取消误伤（它的 `nodeId` 是边界事件，不在宿主作用域里）。
 */
function applyBoundaryFires(
  state: InstanceState,
  fires: readonly BoundaryFire[],
  racedOut: readonly string[],
): InstanceState {
  const next = cloneState(state);

  for (const id of racedOut) {
    const t = next.tokens.find((x) => x.id === id);
    if (t !== undefined) t.state = 'cancelled';
  }

  for (const fire of fires) {
    const host = next.tokens.find((t) => t.id === fire.hostTokenId);
    if (host === undefined) continue; // 宿主令牌没了 ⇒ 那盏监听器已不成立
    if (fire.boundary.cancelActivity) {
      for (const id of cancelTargetsOf(next, fire.boundary.attachedTo)) {
        const t = next.tokens.find((x) => x.id === id);
        if (t !== undefined) t.state = 'cancelled';
      }
    }
    next.tokens.push(boundaryTokenOf(next, fire, host));
  }

  return next;
}

// ---------------- 唤醒 ----------------

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
