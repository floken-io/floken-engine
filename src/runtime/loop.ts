/**
 * @floken-io/engine · run-to-wait 推进循环（ADR-003 的执行模型）
 *
 * ★ **ADR-003 的一句话**：一次 `submit()` 同步推进到**下一个稳定点**就返回 ——
 *   不停在"中间态"（比如刚 `advance` 完、令牌还悬在网关上），也不异步挂起等回调。
 *   稳定点的定义就两条：① 令牌停在**等待节点**（`userTask`，要人办）；② 令牌已终结（结束事件 / 被取消）。
 *
 * ★ **纯函数性（NFR-E6）**：本文件整个是纯的 —— 不读时钟、不碰存储、不发事件、不改入参。
 *   于是它可以被 `plan()`（门 2）与 `submit()`（门 1）**同一份**地调用，
 *   「两条路径演化不一致」这类事从结构上就不可能发生。
 *
 * ⚠️ **外部知识一律从 `LoopContext` 进来**（依赖倒置）：
 *   办理人要 `ApproverSource`（异步 SPI），而本文件必须同步纯 ——
 *   故由 `runtime/engine.ts` **先探测落点、异步解析、再闭包成同步的 `assigneesOf`** 传进来。
 *   探测用的解析器返回一个非空占位（`PROBE_ASSIGNEE`），以免触发 INV-13 的空集报错。
 *
 * ## ★ 一次动作的完整推进 = `step()`（**顺序本身是契约**）
 *
 *   ① 施加原语（换人 / 加签 / 单实例的推进与跳转…）
 *   ①b **微调**（`applyPost`：委派回归 / 解散组 —— T15）
 *   ② **记票**（组内 `approve` / `reject` —— 见 `actions/compile.ts` 的 `CompiledAction.vote`）
 *   ③ **串行会签的接力**（`sequential`：上一个办完 → 下一个 `waiting` 转 `active`）
 *   ④ **汇聚判定**（`actions/convergence.ts`）—— 可能触发取消其余 / 推进 / 驳回
 *   ⑤ run-to-wait（落到下一个稳定点）
 *
 *   ③④ 必须在 ⑤ **之前**：否则令牌会先被推进走，汇聚再判时组里已经没人了。
 *
 * ⚠️ **能力边界（诚实标注）**：
 *   - 原语级审计（旧 `TraceEntry.kind:'primitive'`）→ **已否决**，见 **D-23 / D-87**；
 *   - **T20 已落地**：`IntermediateCatchEvent` / `receiveTask` 是本循环**第三种稳定点**
 *     （前两种 = 等人办的 `userTask`、停在 `callActivity` 上等子实例）；
 *   - **T22 已落地**：`exportTrace()` 的 `from` / `to` / `tokenId` 由 `runtime/plan.ts` 填
 *     （定位令牌走 `subjectTokenOf()`，与本档认领令牌同一套判据）。
 *
 * ## ★ T16：并行分支在这里落地（分叉 / 汇聚两条新路径）
 *
 *   **分叉**（`forkToken`）：网关路由出 N 条出向 → 令牌分裂成 N 个。
 *   第 0 条**沿用原令牌**（id 不变，内层循环接着推它），其余 N−1 个**新建**并插在它后面
 *   —— 于是外层下标循环自然地把它们逐个推到各自的稳定点，不需要另写一套遍历。
 *
 *   **汇聚**（`joinPass`）：`parallelGateway` / `inclusiveGateway` 入向 ≥2 时**等待**，
 *   判据是「不存在别的在途令牌**可达**本网关」（不是"来了几个"—— 详见 `nodes/gateways.ts` 档首）。
 *   合流 = 其余令牌 `completed` + 承接令牌**摘掉 `branch`**（合流点之后又回到单干）。
 *
 *   ⚠️ 分叉写入的 `Token.branch` 同时是 **D-47** 的解药：`rollbackTo`（拿回 / 撤销）
 *   据此把"撤销下游"收缩到**本分支**，不再误伤另一条分支上正在办的待办。
 */

import type { ApproverPolicy } from '@floken-io/moddle';

import type { PostStep, PrimitiveCall } from '../actions/compile.js';
import type { VoteCast } from '../actions/compile.js';
import { convergeCtxOf, evaluateConvergence, groupTallies } from '../actions/convergence.js';
import type { ConvergenceResult, GroupTally } from '../actions/convergence.js';
import { resolveRejectTarget } from '../actions/gates.js';
import {
  approverEmpty,
  definitionMissing,
  stateShapeInvalid,
  tokenOrphan,
} from '../core/errors.js';
import type { EngineEvent } from '../core/events.js';
import { LIVE_TOKEN_STATES, clearAssignment, markCompleted, primitives } from '../core/primitives.js';
import type { InstanceState, Token } from '../core/state.js';
import { cloneState, isTerminalStatus } from '../core/state.js';
import type { TaskStatus, TaskView } from '../core/task.js';
import { assertEventSupported, eventBehaviorOf } from '../nodes/events.js';
import { activityBehaviorOf, assertActivitySupported, parkForCall } from '../nodes/activities.js';
import type { PendingCall } from '../nodes/activities.js';
import { assertNotDataNode } from '../nodes/flows.js';
import type { OutFlow } from '../nodes/graph.js';
import { isWaitingNode } from '../nodes/graph.js';
import type { ProcessGraph } from '../nodes/graph.js';
import { canJoin, isConverging, isGatewayType, routeGateway, waitingAt } from '../nodes/gateways.js';
import type { RoutedFlow } from '../nodes/gateways.js';
import type { NodeEffect } from '../nodes/tasks.js';
import { assertTaskSupported, taskBehaviorOf } from '../nodes/tasks.js';
import { parkForCatch } from '../nodes/catch.js';

/** 探测阶段用的办理人占位：**非空**（否则会触发 INV-13 的空集报错），仅用于问出落点 */
export const PROBE_ASSIGNEE = '__probe__';

/**
 * 单次推进的步骤预算。
 *
 * 它是**死循环的最后一道闸**：定义图有环（A→B→A）时，没有它进程会直接挂死。
 * 取 10 000 而不是"图节点数 ×2"，是因为同一节点可能被合法地反复经过（循环审批），
 * 而这里的语义是"一次提交的推进步数"，10 000 已远超任何真实流程。
 */
const MAX_STEPS = 10_000;

// ---------------- 原语施加 ----------------

/**
 * 依次施加 `compileAction()` 编出的原语调用。
 *
 * ★ 只施加**提交时立即执行**的那些；汇聚触发的取消在下面的 `settleGroups()` 里做。
 *   原语本身就是纯的（各自 `cloneState` 后改副本），故本函数也是纯的。
 */
export function applyPrimitiveCalls(
  state: InstanceState,
  calls: readonly PrimitiveCall[],
): InstanceState {
  let current = state;
  for (const call of calls) {
    const fn = primitives[call.primitive] as (s: InstanceState, i: unknown) => InstanceState;
    current = fn(current, call.input);
  }
  return current;
}

// ---------------- 上下文 ----------------

export interface LoopContext {
  readonly graph: ProcessGraph;
  /**
   * 该节点解析出的办理人 —— **同步**。
   * 由调用方（`runtime/engine.ts`）预先解析并以闭包传入，本文件才可能保持纯。
   */
  readonly assigneesOf: (nodeId: string) => readonly string[];
  /**
   * ★ 出向流的条件真值 —— **同步**（T16）。
   *
   * `ConditionHandler` 是异步 SPI，而本文件必须同步纯 —— 故与 `assigneesOf` 同款：
   *   由调用方预先求值并闭包进来。**尚未求值**时闭包抛 `ConditionUnresolved` 哨兵，
   *   引擎解析后重跑（详见 `eval/condition.ts` 的哨兵注释）。
   *
   * @param flow 出向流（`expression` 为 `undefined` = 无条件，恒真）
   * @param nodeId 该网关的 id（条件上下文要用）
   * @param variables ★ **到达该网关此刻**的变量快照（T17）。
   *   为什么必须传：`scriptTask` / `serviceTask` 会在本次推进里**改写**变量，
   *   拿提交前的旧快照去求值，就是「脚本把 amount 改成了 9000、网关却按旧值走分支」
   *   —— §7.2 要防的头号事故的另一副面孔。
   */
  readonly conditionsOf: (
    flow: OutFlow,
    nodeId: string,
    variables: Readonly<Record<string, unknown>>,
  ) => boolean;
  /**
   * ★ **任务副作用**（T17 · `serviceTask` / `scriptTask` / `businessRuleTask` / `manualTask`）
   * —— **同步**，与 `assigneesOf` / `conditionsOf` 同一套路。
   *
   * `ServiceHandler` / `DecisionHandler` 是**异步** SPI，且带真实副作用（发邮件、建单），
   * 而本文件必须同步纯。故：尚未解析时闭包抛 `NodeEffectUnresolved` 哨兵 →
   * `runtime/engine.ts` 解析 → **重跑**；结果按 `${nodeId}::${tokenId}` 缓存 ⇒ **只调一次**。
   *
   * ⚠️ 本档只**消费** `NodeEffect`（并变量 / 收事件），**绝不**在这里调宿主代码。
   */
  readonly effectsOf: (
    nodeId: string,
    tokenId: string,
    variables: Readonly<Record<string, unknown>>,
  ) => NodeEffect;
  /** 本次推进的时刻（填 `Token.createdAt`） */
  readonly at: string;
}

export type { VoteCast };

/** `step()` 的入参 */
export interface StepInput {
  readonly calls: readonly PrimitiveCall[];
  /** 组内投票（`CompiledAction.vote`）；非组内动作不给 */
  readonly vote?: VoteCast | undefined;
  /** ★ T15 令牌级微调（`CompiledAction.post`：委派回归 / 解散组） */
  readonly post?: PostStep | undefined;
  /** 汇聚驳回时的显式退回目标；不给则由 `reject.allowedTargets` 推导 */
  readonly rejectTarget?: string | undefined;
}

export interface LoopResult {
  readonly next: InstanceState;
  /** 令牌停下来的等待节点（去重、保序）—— 调用方据此预先解析办理人 */
  readonly landings: readonly string[];
  /**
   * ★ 本次推进里**由节点副作用产出**的事件（T17：目前只有 `manualTask` 的留痕）。
   *
   * ⚠️ 为什么不在本文件里 `emit`：本文件是纯的（NFR-E6）。事件由 `runtime/engine.ts`
   *   在**槽位 9**（状态已落库之后）统一投递 —— 在推进过程中就发，一旦后续步骤抛错，
   *   就会出现「事件说办完了、状态却没落库」的不一致。
   */
  readonly events: readonly EngineEvent[];
  /**
   * ★ 本次推进里**停在 `callActivity` 上、需要建子实例**的那些（T18）。
   *
   * 与 `events` 同一套路：纯循环**建不了**实例（那要写存储），只能把"该建什么"
   * 作为**纯数据**交出去，由 `runtime/engine.ts` 兑现。
   *
   * ⚠️ 门 2（宿主自编排）下宿主自己兑现：子实例的 `parent` 指针与父实例的
   *   `childInstanceIds` 都由 `parkForCall()` 算好并在 `next` 里，宿主只需按
   *   `PendingCall` 建出实例；子实例到终态后调 `plan()` 并施加 `callReturnOf()`
   *   即可完成回归 —— 两条路径的形状因此仍然一致。
   */
  readonly pendingCalls: readonly PendingCall[];
}

/**
 * ★ 一次动作的完整推进（①~⑤，见档首）。
 *
 * 为什么必须是一个**导出**的函数而不是 `engine.ts` 里的几行：
 *   门 2（宿主自编排）下没有 `submit()`，事件与状态都得宿主自己算 ——
 *   若推进逻辑长在 `submit()` 里，门 2 就复制一份，于是「两条路径演化不一致」
 *   （§7.1 的硬约束）从**纪律问题**退化成**必然会发生的分叉**。
 */
export function step(state: InstanceState, ctx: LoopContext, input: StepInput): LoopResult {
  let cur = applyPrimitiveCalls(state, input.calls);
  // ①b 必须紧跟 ①：委派回归要在**记票之前**把办理人换回来，否则组内逻辑会看到一个
  //     「办理人已换、票还没投」的中间态
  if (input.post !== undefined) cur = applyPost(cur, input.post);
  if (input.vote !== undefined) cur = castVote(cur, input.vote);
  cur = promoteSequential(cur, ctx);
  cur = settleGroups(cur, ctx, input.rejectTarget);
  return runToWait(cur, ctx);
}

// ---------------- ①b 令牌级微调（`CompiledAction.post`） ----------------

/**
 * ★ 执行 `CompiledAction.post`（T15）—— **纯函数**，门 2 自编排要独立完成同样的演化。
 *
 * 两件事都带审批语义，故**不做成原语**（`core/primitives.ts` 必须业务无知），
 * 但也**不能长在 `engine.ts` 里**（门 2 复制不到 → §7.1 两条路径分叉）。
 */
export function applyPost(state: InstanceState, post: PostStep): InstanceState {
  const next = cloneState(state);

  if (post.returnFromTokenId !== undefined) {
    const t = next.tokens.find((x) => x.id === post.returnFromTokenId);
    if (t === undefined) {
      throw stateShapeInvalid(`applyPost targets unknown token '${post.returnFromTokenId}'`, {
        tokenId: post.returnFromTokenId,
        tokenIds: next.tokens.map((x) => x.id),
      });
    }
    if (t.returnTo === undefined) {
      // 编译期已确认有回归路径才产出本字段；这里再挡一次，防止状态被宿主直接塞进 store
      throw stateShapeInvalid(`token '${t.id}' has no delegation return path (returnTo)`, {
        tokenId: t.id,
      });
    }
    /*
     * ★ 委派回归的两步**缺一不可**：
     *   换回 A 而不清 `returnTo` → A 办完又会回到 A（无限回归，流程永远办不完）；
     *   清了却不换回 → 待办落在 B 名下，而 B 已经办过了。
     */
    t.assignee = t.returnTo;
    delete t.returnTo;
  }

  for (const id of post.dissolveTokenIds ?? []) {
    const t = next.tokens.find((x) => x.id === id);
    if (t !== undefined) delete t.instanceGroup;
  }

  return next;
}

// ---------------- ② 记票 ----------------

/**
 * 记一票：**令牌一律 `completed`**（他的办理结束了），方向记在 `vote`。
 *
 * ⚠️ 不要试图用 `cancelled` 表示"投了驳回" —— 那会让它与「被汇聚取消的人」不可区分，
 * 事后审计答不出"是谁驳回的"（详见 `core/state.ts` 里 `VoteOutcome` 的注释）。
 */
export function castVote(state: InstanceState, vote: VoteCast): InstanceState {
  const next = cloneState(state);
  const token = next.tokens.find((t) => t.id === vote.tokenId);
  if (token === undefined) {
    throw stateShapeInvalid(`castVote targets unknown token '${vote.tokenId}'`, {
      tokenId: vote.tokenId,
      tokenIds: next.tokens.map((t) => t.id),
    });
  }
  if (!LIVE_TOKEN_STATES.includes(token.state)) {
    throw stateShapeInvalid(`castVote targets a token that is already '${token.state}'`, {
      tokenId: vote.tokenId,
      tokenState: token.state,
    });
  }
  token.vote = vote.vote;
  token.state = 'completed';
  return next;
}

// ---------------- ③ 串行会签接力（INV-8） ----------------

/**
 * `sequential:true` —— 组内**至多 1 个 `active`**（INV-8）。
 *
 * 组内没人 `active` 且有 `waiting` → 激活最早那一个，并**此时**才填 `createdAt`
 * （它是"这条待办的创建时刻"，轮到他了才算创建）。
 */
export function promoteSequential(state: InstanceState, ctx: LoopContext): InstanceState {
  const next = cloneState(state);
  let changed = false;

  for (const tally of groupTallies(next.tokens)) {
    const approval = ctx.graph.approvalOf(tally.nodeId);
    if (approval === undefined || approval.sequential !== true) continue;
    const members = next.tokens.filter((t) => t.instanceGroup === tally.groupId);
    if (members.some((t) => t.state === 'active')) continue;
    const firstWaiting = members.find((t) => t.state === 'waiting');
    if (firstWaiting === undefined) continue;
    firstWaiting.state = 'active';
    firstWaiting.createdAt = ctx.at;
    changed = true;
  }

  return changed ? next : state;
}

// ---------------- ④ 汇聚 ----------------

/**
 * 反复结算**所有**已定局的组，直到没有可结算的为止。
 *
 * ★ 为什么是循环：减签 / 或签取消会让**别的**组立刻达线，一次判定不够。
 *   终止性由「**组一旦结算就解散**」保证（见 `applySettlement`）—— 组数严格递减。
 */
export function settleGroups(
  state: InstanceState,
  ctx: LoopContext,
  rejectTarget?: string | undefined,
): InstanceState {
  let cur = state;
  for (let i = 0; i < MAX_STEPS; i += 1) {
    const found = nextSettledGroup(cur, ctx);
    if (found === undefined) return cur;
    cur = applySettlement(cur, ctx, found, rejectTarget);
  }
  throw stateShapeInvalid('convergence did not settle within the step budget', {
    budget: MAX_STEPS,
    instanceId: cur.instanceId,
  });
}

interface SettledGroup {
  readonly tally: GroupTally;
  readonly result: ConvergenceResult;
  readonly approval: NonNullable<ReturnType<ProcessGraph['approvalOf']>>;
}

/** 第一个**已定局**（`outcome !== 'pending'`）的组；全是 pending → `undefined` */
function nextSettledGroup(state: InstanceState, ctx: LoopContext): SettledGroup | undefined {
  for (const tally of groupTallies(state.tokens)) {
    const approval = ctx.graph.approvalOf(tally.nodeId);
    if (approval === undefined) {
      // 组内节点没有 `floken:approval` = 没有汇聚语义（mode / onReject / vote 全在那儿）
      throw stateShapeInvalid(
        `instance group '${tally.groupId}' on node '${tally.nodeId}' has no floken:approval config; convergence needs mode / onReject / vote`,
        { groupId: tally.groupId, nodeId: tally.nodeId },
      );
    }
    const result = evaluateConvergence(convergeCtxOf(tally, approval));
    if (result.outcome !== 'pending') return { tally, result, approval };
  }
  return undefined;
}

/**
 * 结算一个组：取消残余 → 记账 → **解散组** → 造一个承接令牌走下去。
 *
 * ★ **为什么必须解散组**（摘掉 `instanceGroup`）：
 *   组结算完，它的成员还留在 `tokens` 里（审计要留）。若不解散，下一次任何动作都会
 *   `groupTallies()` 再次看到这个组，而它的票数仍是"全员通过" → 再次判定 approved →
 *   **再推进一次** —— 表现为"流程没人在办却自己往前走"。
 *
 * ★ **为什么另造一个承接令牌**、而不是复用某个投票者的令牌：
 *   组内的令牌是**投票记录**（`completed` + `vote`）。复用它就得抹掉 `vote`，
 *   于是「谁投了什么」在状态里就没了 —— 省一个对象，赔掉整条审计链。
 */
function applySettlement(
  state: InstanceState,
  ctx: LoopContext,
  g: SettledGroup,
  rejectTarget: string | undefined,
): InstanceState {
  const next = cloneState(state);
  const { groupId, nodeId } = g.tally;
  const approved = g.result.outcome === 'approved';

  // ① INV-9：组内残余在途令牌一律取消（或签的"其余取消" / 达线后收尾）
  for (const id of restIdsOf(next, groupId)) {
    const t = next.tokens.find((x) => x.id === id);
    if (t !== undefined) t.state = 'cancelled';
  }

  // ② 目标节点。**驳回的目标必须在记账之前推导**（否则 'previous' 会推到本节点自己）
  let to: string;
  if (approved) {
    const nxt = ctx.graph.nextOf(nodeId);
    if (nxt === undefined) {
      throw definitionMissing(ctx.graph.processId, ctx.graph.definitionVersion);
    }
    to = nxt;
  } else {
    to = resolveRejectTarget({
      name: 'reject',
      approval: g.approval,
      completedNodes: next.completedNodes,
      ...(rejectTarget !== undefined ? { target: rejectTarget } : {}),
      startNodeId: ctx.graph.startNodeId,
    });
  }

  // ③ 离开该节点 → 记账（D-28）
  markCompleted(next, nodeId);
  // 驳回的目标要重办 → 从 `completedNodes` 摘掉
  if (!approved) next.completedNodes = next.completedNodes.filter((n) => n !== to);

  // ④ 组解散（保留 `vote`，它已是审计事实）
  for (const t of next.tokens) {
    if (t.instanceGroup === groupId) delete t.instanceGroup;
  }

  // ⑤ 承接令牌：`state:'active'`、**不带** assignee / instanceGroup ——
  //   交给下面的 `runToWait()` 去落定（它会在新节点上重新解析办理人）
  next.tokens.push({
    id: `${groupId}#${approved ? 'out' : 'back'}`,
    nodeId: to,
    state: 'active',
  });

  return next;
}

/** 组内仍需在途的令牌 id（复用 `convergence.ts` 的口径，不另写一份） */
function restIdsOf(state: InstanceState, groupId: string): string[] {
  return state.tokens
    .filter((t) => t.instanceGroup === groupId && LIVE_TOKEN_STATES.includes(t.state))
    .map((t) => t.id);
}

// ---------------- ⑤ run-to-wait ----------------

/**
 * ★ 推进到下一个稳定点。
 *
 * 每个在途令牌各自走到「等待节点」或「终结」为止：
 *   - 等待节点（`userTask`）→ 落定办理人后停下（`Token.createdAt` 此时才填）；
 *     解析出**多个**办理人 → **展开成汇聚组**（会签 / 或签 / 票签，T13）；
 *   - **等外部投递**（`intermediateCatchEvent` / `receiveTask`，T20）→ 记下 `Token.awaiting` 后停下，
 *     由 `deliverMessage()` / `deliverSignal()` 唤醒；★ **T21 起亦可由边界事件触发**
 *     （`nodes/boundary.ts`：它挂在活动上监听，触发时**夺走或另造**令牌）；
 *   - **`eventBasedGateway`**（T21）→ 全部分叉并标 `Token.race`，谁先被唤醒谁赢、
 *     其余分支在 `runtime/deliver.ts` 里被取消；
 *   - 结束事件 → 该令牌 `completed`；
 *   - **网关**（T16）→ 先判要不要**汇聚等待**，再按类型路由：
 *     一条出向 = 直通过去；多条 = **令牌分裂**（见档首 `forkToken`）；
 *   - 其余类型 → **自动直通**（沿唯一出向继续走；多出向由图适配层抛错，见 `nodes/graph.ts` D-22）。
 *
 * 全部令牌都不在途 → 实例置 `completed`（`plan()` 随后据此填 `endedAt`）。
 * 已进终态的实例（`halt` 之后）**不覆盖**其状态。
 */
export function runToWait(state: InstanceState, ctx: LoopContext): LoopResult {
  let cur = cloneState(state);
  const landings: string[] = [];
  const events: EngineEvent[] = [];
  const pendingCalls: PendingCall[] = [];
  const budget = { steps: 0 };

  /*
   * ★ 外层的 `joinPass` 循环有两个要点：
   *
   *   ① **合流必须在推进之前**：合流本身不推进令牌（只是把 N 个驻留令牌并成 1 个），
   *      若先推进，N 个令牌会**各自**走出网关 —— 表现为"并行两条分支合完之后，
   *      下一个节点出现两条一模一样的待办"。这比"停在网关不动"难查得多。
   *   ② 合流完那个令牌还得**继续往下走**（可能又是网关）→ 再推进一轮。
   *
   *   终止性：每轮至少合流掉一个网关，而合流后该网关不再有驻留令牌 ⇒ 严格递减。
   */
  for (let round = 0; round < MAX_STEPS; round += 1) {
    const merged = joinPass(cur, ctx);
    cur = advanceTokens(cur, ctx, landings, budget, events, pendingCalls);
    if (!merged) break;
  }

  const liveLeft = cur.tokens.filter((t) => LIVE_TOKEN_STATES.includes(t.state)).length;
  if (liveLeft === 0 && !isTerminalStatus(cur.status)) {
    cur.status = 'completed';
  }

  return { next: cur, landings, events, pendingCalls };
}

/**
 * 一轮「各令牌推进到稳定点」。
 *
 * @param budget 步数预算在**多轮之间共享**（防环的最后一道闸，不能每轮重置）
 */
function advanceTokens(
  state: InstanceState,
  ctx: LoopContext,
  landings: string[],
  budget: { steps: number },
  events: EngineEvent[],
  pendingCalls: PendingCall[],
): InstanceState {
  const next = cloneState(state);
  /*
   * ★ 用下标循环而不是 `for...of`：展开 / 分叉会把「当前令牌」换成 N 个新令牌插回原位置，
   *   `for...of` 的迭代器语义在这里容易踩坑（改 length 后游标错位）。
   */
  for (let i = 0; i < next.tokens.length; i += 1) {
    const token = next.tokens[i];
    if (token === undefined) continue;
    if (!LIVE_TOKEN_STATES.includes(token.state)) continue;
    // 串行会签里还没轮到的令牌：**不是**稳定点，也不该被推进
    if (token.state === 'waiting') continue;
    /*
     * ★ **正在等外部投递**的令牌（`Token.awaiting`，T20）同样是稳定点 —— 而且必须在这里判，
     *   不能靠"节点类型是 catch 就停"：若靠类型，`advanceTokens` 每轮都会重新走到这里，
     *   于是令牌停在同一个 catch 节点上被反复停车（幂等但无意义）；更糟的是
     *   投递唤醒后 `awaiting` 已被摘掉，若只看类型它会被**再次停住** —— 永远醒不过来。
     */
    if (token.awaiting !== undefined) continue;

    for (;;) {
      budget.steps += 1;
      if (budget.steps > MAX_STEPS) {
        throw stateShapeInvalid('run-to-wait exceeded the step budget (cycle in the definition graph?)', {
          budget: MAX_STEPS,
          instanceId: next.instanceId,
        });
      }

      // INV-3：令牌必须落在图里（否则它会永远卡在一个不存在的节点上）
      const type = ctx.graph.typeOf(token.nodeId);
      if (type === undefined) {
        throw tokenOrphan(next.instanceId, token.id, token.nodeId);
      }

      // ⓪ 数据节点：**不是**可执行节点（引擎只读不写），令牌落到它上面 = 定义画错了
      assertNotDataNode(type, token.nodeId);

      // ① 事件族：未实现的 2 类在这里显式抛；**catch** 类停住等投递（T20）
      const behavior = eventBehaviorOf(type);
      if (behavior !== undefined) {
        assertEventSupported(type, token.nodeId, behavior);
        if (behavior === 'terminal') {
          token.state = 'completed';
          break;
        }
        if (behavior === 'catch') {
          parkCatch(token, ctx);
          break;
        }
        // 'start' / 'pass'（boundaryEvent）→ 落到下面的自动直通
      }

      // ② 网关（T16）
      if (isGatewayType(type)) {
        // ②a 汇聚等待：还有别的在途令牌能到本网关 → 停在这，等它们
        if (isConverging(type) && !canJoin(next, token.nodeId, ctx.graph)) break;

        const routed = routeGateway({
          type,
          nodeId: token.nodeId,
          outFlows: ctx.graph.outFlowsOf(token.nodeId),
          defaultFlowId: ctx.graph.defaultFlowIdOf(token.nodeId),
          // ★ 条件上下文取**此刻**的变量（T17：脚本 / 服务可能在本次推进里改过它）
          isTrue: (f) => ctx.conditionsOf(f, token.nodeId, next.variables),
        });
        // ★ 离开网关也要记账（D-28 同口径）
        markCompleted(next, token.nodeId);

        /*
         * ★ T21：事件网关分叉出的令牌**同批竞速**（`Token.race`）——
         *   谁先被唤醒谁赢，其余在 `runtime/deliver.ts` 里被取消。
         *   ⚠️ 单出向也要标记：那一条分支同样参加了竞速（赢家可能就地被取消）。
         */
        const race = type === 'eventBasedGateway' ? `${token.nodeId}#${token.id}` : undefined;
        if (routed.length === 1) {
          token.nodeId = (routed[0] as RoutedFlow).to;
          clearAssignment(token);
          if (race !== undefined) token.race = race;
          continue;
        }
        // 多条出向 → 令牌分裂。第 0 条沿用原令牌，故此处 `continue` 接着推它
        forkToken(next, token, i, routed, race);
        continue;
      }

      // ③ 任务族（T17）：未实现的 1 类显式抛；有副作用的先**消费**已解析的结果
      const taskBehavior = taskBehaviorOf(type);
      if (taskBehavior !== undefined) {
        assertTaskSupported(type, token.nodeId, taskBehavior);
        if (taskBehavior === 'effect') applyEffect(next, token, ctx, events);
        // 'catch'（receiveTask）→ 停住等投递，与 intermediateCatchEvent 同一处置
        if (taskBehavior === 'catch') {
          parkCatch(token, ctx);
          break;
        }
        // 'wait' → 落到下面的 `settleAssignee`；'pass' 与已消费的 'effect' → 自动直通
      }

      // ④ 活动族（T18）
      const activityBehavior = activityBehaviorOf(type);
      if (activityBehavior !== undefined) {
        assertActivitySupported(type, token.nodeId, activityBehavior);
        if (activityBehavior === 'call') {
          /*
           * ★ INV-16 的落点：`callTargetOf` 在「没绑定版本」时**抛**（不回退到最新版）。
           *   兜底那条 `stateShapeInvalid` 只是防"节点不在图里"这种不可能状态 ——
           *   真发生了也要报出来，绝不静默当成"不用调用、直接走过去"。
           */
          const target = ctx.graph.callTargetOf(token.nodeId);
          if (target === undefined) {
            throw stateShapeInvalid(`node '${token.nodeId}' is a callActivity without a call target`, {
              nodeId: token.nodeId,
              instanceId: next.instanceId,
            });
          }
          pendingCalls.push(parkForCall(next, token, target));
          /*
           * ★ 稳定点：令牌停在这里等子实例回来。
           *   ⚠️ **不**进 `landings` —— 它不是待办（没有办理人要解析），
           *   塞进去会让引擎去 `ApproverSource` 问一个根本不存在的人。
           */
          break;
        }
      }

      if (isWaitingNode(type)) {
        const settled = settleAssignee(token, ctx, next, i);
        if (settled === 'wait') {
          if (token.createdAt === undefined) token.createdAt = ctx.at;
          if (!landings.includes(token.nodeId)) landings.push(token.nodeId);
          break;
        }
        // `'expanded'` = 已展开成汇聚组：当前令牌已被 N 个新令牌取代 → 跳出内层循环
        if (settled === 'expanded') break;
        // `'skipped'` = 无人可办（`onEmpty:'skip'`）→ **落到下面**，视同自动节点直通到下一节点。
        // ⚠️ 这里**不能** `continue` —— 那会跳过直通、在同一节点上再判一次 skip，直到撞步骤预算。
      }

      // —— 自动直通 ——
      const to = ctx.graph.nextOf(token.nodeId);
      if (to === undefined) {
        // 走到没有出向的非结束节点 = 定义本身不完整（死路），不得静默停住
        throw definitionMissing(next.processId, ctx.graph.definitionVersion);
      }
      // ★ 离开的节点必须记账（D-28）：INV-6 的驳回目标 ∈ `completedNodes` 全靠它
      markCompleted(next, token.nodeId);
      token.nodeId = to;
      // ★ 与 `core/primitives.ts` 同一口径（D-25）：换了节点 → 旧办理人 / 回归路径 / 建单时刻作废
      clearAssignment(token);
    }
  }

  return next;
}

/**
 * ★ 消费一个已解析的**节点副作用**（T17）。
 *
 * 只做两件事：并变量、收事件。**不调宿主代码** —— 那是 `runtime/engine.ts` 在解析阶段做的。
 *
 * ⚠️ 并变量必须**就地**改 `next.variables` 且不改原对象：`runToWait` 全程是纯的
 *    （入参 `state` 由 `cloneState` 保护），而后续的条件求值要读到**并完之后**的值。
 *
 * @throws `NodeEffectUnresolved` —— `effectsOf` 闭包尚未解析（引擎捕获后解析并重跑）
 */
function applyEffect(
  next: InstanceState,
  token: Token,
  ctx: LoopContext,
  events: EngineEvent[],
): void {
  const effect = ctx.effectsOf(token.nodeId, token.id, next.variables);
  const patch = effect.variables;
  if (patch !== undefined && Object.keys(patch).length > 0) {
    next.variables = { ...next.variables, ...patch };
  }
  for (const e of effect.events ?? []) events.push(e);
}

/**
 * ★ 令牌分裂（网关分叉）。
 *
 * - 第 0 条**沿用原令牌**（id 不变）：内层循环正在推它，接着推就完事，不必另写遍历；
 * - 其余**新建**令牌紧插在它后面：外层下标循环会逐个推到各自的稳定点。
 *
 * ⚠️ `branch` 的取值 = `${分支根}#${flowId}`：
 *   ① 分支根取 `token.branch ?? token.id`，于是嵌套并行下**子分支值是父分支值的延伸**，
 *      而 `rollbackTo` 按**相等**判定（不是前缀匹配），兄弟分支不会被算进来（D-47）；
 *   ② 带 `flowId` 是为了让同一次分叉的两条分支必然不同（只写序号会与另一次分叉撞车）。
 */
function forkToken(
  next: InstanceState,
  token: Token,
  index: number,
  routed: readonly RoutedFlow[],
  race?: string | undefined,
): void {
  const first = routed[0] as RoutedFlow;
  const root = token.branch ?? token.id;

  token.nodeId = first.to;
  token.branch = `${root}#${first.flowId}`;
  clearAssignment(token);
  // ⚠️ `clearAssignment` 会摘 `race`，故**必须在它之后**写回（顺序反了就白标）
  if (race !== undefined) token.race = race;

  const created: Token[] = [];
  for (let j = 1; j < routed.length; j += 1) {
    const r = routed[j] as RoutedFlow;
    created.push({
      id: `${token.id}#${r.flowId}`,
      nodeId: r.to,
      state: 'active',
      branch: `${root}#${r.flowId}`,
      ...(race === undefined ? {} : { race }),
    });
  }
  next.tokens = [
    ...next.tokens.slice(0, index + 1),
    ...created,
    ...next.tokens.slice(index + 1),
  ];
}

/**
 * ★ 一轮汇合：把**已达成**的汇聚网关合并掉；返回是否发生了合并。
 *
 * 判据 `canJoin` = 「不存在别的在途令牌可达本网关」—— 详见 `nodes/gateways.ts` 档首
 * （包容网关只等被激活的分支、被取消的分支自动退出等待，全靠这一条）。
 *
 * 合并的三步：其余驻留令牌 `completed`（它们走到了汇聚点，旅程结束，**留在 tokens 里供审计**）
 * → 承接令牌**摘掉 `branch`**（合流之后又回到单干）。
 */
function joinPass(state: InstanceState, ctx: LoopContext): boolean {
  let merged = false;
  const visited = new Set<string>();

  for (const t of state.tokens) {
    if (!LIVE_TOKEN_STATES.includes(t.state)) continue;
    const nodeId = t.nodeId;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const type = ctx.graph.typeOf(nodeId);
    if (type === undefined || !isGatewayType(type) || !isConverging(type)) continue;
    // 入向 1 条的网关是**分叉**不是汇聚（BPMN 里同一元素两种用法）
    if (ctx.graph.inFlowsOf(nodeId).length < 2) continue;
    if (!canJoin(state, nodeId, ctx.graph)) continue;

    const idxs = waitingAt(state, nodeId);
    if (idxs.length === 0) continue;
    for (let k = 1; k < idxs.length; k += 1) {
      const other = state.tokens[idxs[k] as number];
      if (other !== undefined) other.state = 'completed';
    }
    const head = state.tokens[idxs[0] as number];
    if (head !== undefined) delete head.branch;
    merged = true;
  }

  return merged;
}

/** `settleAssignee` 的返回值 */
type Settled = 'wait' | 'skipped' | 'expanded';

/**
 * ★ 令牌**停在等待节点上**（T20）—— 记下它在等什么。
 *
 * 与 `settleAssignee` 对称：那一个是"等人"，这一个"等外部世界"。
 * 两处的 `createdAt` 同一口径 = **进入等待的时刻**（T21 的超时判定要用它）。
 *
 * ⚠️ 不进 `landings`：等待节点**没有办理人**要解析，塞进去会让引擎去
 *   `ApproverSource` 问一个根本不存在的人（与 `callActivity` 的停车同一理由）。
 */
function parkCatch(token: Token, ctx: LoopContext): void {
  const binding = ctx.graph.catchOf(token.nodeId);
  if (binding === undefined) {
    // 兜底：能走到这里的只有 intermediateCatchEvent / receiveTask，
    // 而 `catchOf` 对它们要么给绑定、要么抛（见 `nodes/catch.ts`）。真发生了也要报出来。
    throw stateShapeInvalid(`node '${token.nodeId}' is a catch node without a catch binding`, {
      nodeId: token.nodeId,
      type: ctx.graph.typeOf(token.nodeId) ?? null,
      instanceId: ctx.graph.processId,
    });
  }
  parkForCatch(token, binding);
  if (token.createdAt === undefined) token.createdAt = ctx.at;
}

/**
 * 等待节点上落定办理人；解析出多人时**展开成汇聚组**。
 *
 * ★ 展开是"多实例"的**唯一入口**：`floken:approval.approvers` 解析出 N 个人，
 *   N 个令牌同节点、同 `instanceGroup`，此后的走向由 `actions/convergence.ts` 定。
 *
 * @param index 当前令牌在 `next.tokens` 里的下标（展开要把它就地换掉）
 */
function settleAssignee(token: Token, ctx: LoopContext, next: InstanceState, index: number): Settled {
  // ★ 已有办理人 = 该令牌在这一节点上已落定（换人动作设的），不再重新解析
  if (token.assignee !== undefined) return 'wait';

  const approval = ctx.graph.approvalOf(token.nodeId);
  const chosen = selectAssignees(ctx.assigneesOf(token.nodeId), approval?.approverPolicy);

  if (chosen.length === 0) {
    const onEmpty = approval?.onEmpty ?? 'error';
    if (onEmpty === 'error') {
      // INV-13：不得产生「0 个办待人却 active」的节点 —— 流程会永久卡住且无报错
      throw approverEmpty(token.nodeId, onEmpty, {
        instanceId: next.instanceId,
        tokenId: token.id,
      });
    }
    // `onEmpty: 'skip'` —— 该节点无人可办 → **跳过该节点**（不是结束令牌），由调用方继续往下推进
    return 'skipped';
  }

  if (chosen.length === 1) {
    token.assignee = chosen[0] as string;
    return 'wait';
  }

  expandGroup(token, ctx, next, index, chosen, approval?.sequential === true);
  return 'expanded';
}

/**
 * `approverPolicy` —— **取人策略**（`01-moddle` §4.4.1）：
 *   - `'all'`（缺省）→ 全部展开，由 `mode` 决定怎么汇聚；
 *   - `'any'` / `'first'` → **只取 1 人** ⇒ 单人审批，`mode` 自然不生效
 *     （单人组不判汇聚，见 `compile.groupSizeOf`）。
 *
 * ⚠️ 这不是"省事"：`approverPolicy:'first'` 时把 3 个人展开成 3 条待办是**错的**，
 *    设计器里那一项写的就是"第一个"。
 */
function selectAssignees(list: readonly string[], policy: ApproverPolicy | undefined): readonly string[] {
  if (policy === 'first' || policy === 'any') return list.slice(0, 1);
  return list;
}

/**
 * 把一个"占位令牌"就地换成 N 个组内令牌。
 *
 * - 组 id 由 `nodeId` **和原令牌 id** 共同决定：同一节点被多次到达（驳回重办）必须是**新组**，
 *   否则新旧两批人的票会混在一个组里算。
 * - `sequential` → 只有第 1 个 `active`，其余 `waiting`（INV-8）。
 */
function expandGroup(
  token: Token,
  ctx: LoopContext,
  next: InstanceState,
  index: number,
  assignees: readonly string[],
  sequential: boolean,
): void {
  const groupId = `${token.nodeId}#${token.id}`;
  const created: Token[] = assignees.map((assignee, i) => {
    const active = i === 0 || !sequential;
    const t: Token = {
      id: `${groupId}#${i}`,
      nodeId: token.nodeId,
      state: active ? 'active' : 'waiting',
      assignee,
      instanceGroup: groupId,
      // ★ 分支标记**继承**：这一组人整体处在某条并行分支上（T16）
      ...(token.branch !== undefined ? { branch: token.branch } : {}),
    };
    // `createdAt` = "这条待办的创建时刻" —— 串行会签里没轮到的，等激活时再填
    if (active) t.createdAt = ctx.at;
    return t;
  });

  next.tokens = [...next.tokens.slice(0, index), ...created, ...next.tokens.slice(index + 1)];
}

// ---------------- 待办视图（读线的数据源） ----------------

/** 等待中的待办状态：实例挂起时冻结（INV-5），委派出去的原办理人保留可见 */
function taskStatusOf(state: InstanceState, token: Token): TaskStatus {
  if (state.status === 'suspended') return 'suspended';
  if (token.returnTo !== undefined) return 'delegated';
  return 'active';
}

/**
 * 当前状态对应的待办视图。
 *
 * ★ 判据：**`active` + 有办理人** = 一条待办。
 *   - 没有办理人的在途令牌不构成待办（INV-13 保证它不会出现）；
 *   - 已 `completed` / `cancelled` 的令牌不在视图里 —— 视图只表达"现在要谁办"；
 *   - ★ `waiting`（串行会签里还没轮到）**不是待办**：它还没有"现在要他办"这回事，
 *     若算进去，宿主待办表里会出现 N 条待办却只有 1 个人能点，其余点了也没用。
 */
export function tasksOf(state: InstanceState, graph: ProcessGraph): TaskView[] {
  const out: TaskView[] = [];
  for (const t of state.tokens) {
    if (t.state !== 'active') continue;
    if (t.assignee === undefined) continue;

    const view: TaskView = {
      /*
       * ★ `taskId` = `${nodeId}:${tokenId}` —— **不是**裸 `token.id`。
       *   同一个令牌会依次流经多个等待节点（approve → 下一节点 → …），
       *   若 taskId 就是令牌 id，那么"驳回后重办"与"推进到下一步"会复用同一行，
       *   宿主的待办表就分不出「这是新待办」还是「还是原来那条」。
       */
      taskId: `${t.nodeId}:${t.id}`,
      instanceId: state.instanceId,
      nodeId: t.nodeId,
      assignee: t.assignee,
      status: taskStatusOf(state, t),
      createdAt: t.createdAt ?? state.startedAt,
    };
    const name = graph.nameOf(t.nodeId);
    if (name !== undefined) view.nodeName = name;
    const formKey = graph.formKeyOf(t.nodeId);
    if (formKey !== undefined) view.formKey = formKey;
    out.push(view);
  }
  return out;
}
