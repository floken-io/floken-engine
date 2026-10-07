/**
 * @floken-io/engine · **超时排程的纯计算段**（T21 · `runtime/timers.ts`）
 *
 * ★ 与 `runtime/deliver.ts` 同一个套路：把「该排什么 / 该取消什么」算成**纯数据**，
 *   由 `runtime/engine.ts`（唯一不纯的文件）去调 `Scheduler`。
 *
 * ## ★ 为什么要 diff 而不是"进入就排、离开就消"
 *
 *   直觉写法是在 `run-to-wait` 里"落到等待节点时 schedule" —— 但推进循环是**纯**的，
 *   拿不到 `Scheduler`（它是 SPI，且 `schedule()` 是异步的）。于是只剩两条路：
 *     ① 让纯循环吐出意图（本档的做法）；
 *     ② 在不纯层**比对前后两个状态**，问出「谁刚停下、谁刚离开」。
 *   本档走 ②（diff），因为 ① 会让 `LoopResult` 再多一个字段、且**门 2** 得自己再算一遍；
 *   而 ② 的判据就是一个纯函数 `timingKeysOf(state)`，门 1 / 门 2 **共用同一份**。
 *
 * ## ★ 判据：什么算「正在计时」
 *
 *   `active` + **有 `assignee`** + 该节点的 `floken:approval.timeout` 存在。
 *
 *   ⚠️ 为什么要求 `assignee`：「在途」不等于「有人在办」——
 *   刚分叉出来还没落定的令牌、停在 catch 节点上的令牌都是 `active` 却没有办理人，
 *   给它们排超时会产出「催办一条根本不存在的待办」。
 *
 *   ⚠️ 为什么按 `${nodeId}::${tokenId}` 而不是 nodeId：会签组里同节点有 N 个令牌，
 *   每个人的待办**各自**计时（驳回重办后也是新令牌 = 新计时），按节点去重会漏掉其余人。
 *
 * ## ★ handle 的回收
 *
 *   `Scheduler.schedule()` **返回**一个 handle（形状由调度方定），故取消必须**拿着它**。
 *   引擎把它写回 `Token.timerHandles`，离开该节点时由不纯层 `cancel()` 后**删除**。
 *
 *   ⚠️ 为什么不自己拼一个确定性 handle：那等于规定调度方的数据形状（SPI 要避免的耦合）。
 *   ⚠️ 为什么不在 `clearAssignment()` 里删：那是纯函数，删了就没地方记"要取消谁"——
 *   定时器会在待办办完之后照样触发（最典型的"已办结还在催办"）。
 */

import type { NormalizedTimeout, TimeoutAction, WorkCalendarSpec } from '@floken-io/moddle';

import type { InstanceState } from '../core/state.js';
import type { TimeoutSpec } from '../core/spi.js';
import type { ProcessGraph } from '../nodes/graph.js';

// ---------------- 纯数据 ----------------

/** 到点后做什么（`03` §4 的 `timeout.actions[]` 四选） */
export type TimerKind = TimeoutAction['type'];

/** ★ 一个"该排程"的意图（纯数据，由不纯层兑现） */
export interface PendingTimeout {
  readonly tokenId: string;
  readonly nodeId: string;
  /** 待办创建时刻 —— 调度方据此按工作日历推算到期时刻 */
  readonly fromAt: string;
  readonly timeout: TimeoutSpec;
  /**
   * ★ **原始**动作对象数组（`timeout.actions` 原样，含 `interval` / `max` / `target` / `to`）。
   * 一个动作排一次，故数组长度 = 该待办要排几个定时器。
   *
   * ⚠️ 这里早期只留 `kinds: TimerKind[]`（光秃秃的类型字符串），**动作参数被静默丢弃**：
   * 调度方不知道隔多久催一次（`remind.interval`）、最多催几次（`remind.max`）、
   * 驳回给谁（`autoReject.target`）、升级给谁（`escalate.to`）
   * ⇒ `03` F-3 的 AC1 / AC3 / AC4 **根本无法兑现**。动作参数与 `timeout` 一样属宿主数据，
   * 内核**不解读、不改写、不筛选**，只负责原样交出。
   */
  readonly actions: readonly TimeoutAction[];
}

/** ★ 一个"该取消"的意图 */
export interface PendingCancel {
  readonly tokenId: string;
  /** 当初 `schedule()` 返回的 handle（可能为空 —— 例如排程失败过） */
  readonly handles: readonly string[];
}

/** `diffTimers()` 的结果 */
export interface TimerDiff {
  readonly schedule: readonly PendingTimeout[];
  readonly cancel: readonly PendingCancel[];
}

// ---------------- 判据 ----------------

/** 计时键：`${nodeId}::${tokenId}`（见档首"为什么按令牌"） */
export function timerKeyOf(nodeId: string, tokenId: string): string {
  return `${nodeId}::${tokenId}`;
}

/**
 * ★ 把 moddle 的归一化超时配置裁成 `TimeoutSpec`（只交**原始配置**，不交算好的时刻）
 *
 * ⚠️ `workCalendar` 的两种形态（`string` 日历 id / 内联 `WorkCalendarSpec` 对象）
 * **都原样交出**。早期只在它是字符串时透传，内联对象被**静默丢弃** ——
 * 模型层允许写、归一化也留着，到调度方手里却没了，全程无提示（= 静默吞掉宿主的配置）。
 *
 * 内核**不解读**日历内容（`workdays` / `hours` / `holidays` 是什么、怎么跳过节假日
 * 都是业务数据），也不补齐默认值 —— 那些是调度方的事。
 */
export function timeoutSpecOf(t: NormalizedTimeout): TimeoutSpec {
  const out: {
    duration?: string;
    date?: string;
    cycle?: string;
    workCalendar?: string | WorkCalendarSpec;
  } = {};
  if (typeof t.duration === 'string') out.duration = t.duration;
  if (typeof t.date === 'string') out.date = t.date;
  if (typeof t.cycle === 'string') out.cycle = t.cycle;
  if (t.workCalendar !== undefined) out.workCalendar = t.workCalendar;
  return out;
}

/**
 * ★ 该状态里**正在计时**的那些（键 → 意图）。
 *
 * 保序（按 `tokens` 顺序），故两次运行的结果可重放。
 */
export function timingKeysOf(
  state: InstanceState,
  graph: ProcessGraph,
): ReadonlyMap<string, PendingTimeout> {
  const out = new Map<string, PendingTimeout>();

  for (const t of state.tokens) {
    if (t.state !== 'active') continue;
    if (t.assignee === undefined) continue;
    const approval = graph.approvalOf(t.nodeId);
    const timeout = approval?.timeout;
    if (timeout === undefined) continue;
    /* ★ 原样留下**整个动作对象**（含参数），不是只留 `type` —— 见 `PendingTimeout.actions` */
    const actions = (timeout.actions ?? []).filter(
      (a): a is TimeoutAction =>
        typeof a === 'object' && a !== null && typeof (a as TimeoutAction).type === 'string',
    );
    if (actions.length === 0) continue;

    out.set(timerKeyOf(t.nodeId, t.id), {
      tokenId: t.id,
      nodeId: t.nodeId,
      // ★ 计时的起点 = **这条待办的创建时刻**，不是实例的启动时刻
      fromAt: t.createdAt ?? state.startedAt,
      timeout: timeoutSpecOf(timeout),
      actions,
    });
  }

  return out;
}

// ---------------- diff ----------------

/**
 * ★ 比对前后两个状态，算出「该排什么 / 该取消什么」。
 *
 * - **新增**的计时键 → 排程；
 * - **消失**的计时键 → 取消（handle 从 `next` 里那个令牌上取 —— 令牌本身还在 `tokens` 里，
 *   只是不再 `active`）；
 * - 两边都在的键 → **不动**（不重复排程；重排会让"3 个工作日"从头再数一次）。
 *
 * @param prev 推进**前**的状态
 * @param next 推进**后**的状态（取消用的 handle 从它这里读）
 */
export function diffTimers(
  prev: InstanceState,
  next: InstanceState,
  graph: ProcessGraph,
): TimerDiff {
  const before = timingKeysOf(prev, graph);
  const after = timingKeysOf(next, graph);

  const schedule: PendingTimeout[] = [];
  for (const [key, intent] of after) {
    if (!before.has(key)) schedule.push(intent);
  }

  const cancel: PendingCancel[] = [];
  for (const key of before.keys()) {
    if (after.has(key)) continue;
    const [, tokenId] = splitKey(key);
    const token = next.tokens.find((t) => t.id === tokenId);
    const handles = token?.timerHandles ?? [];
    if (handles.length === 0) continue;
    cancel.push({ tokenId, handles });
  }

  return { schedule, cancel };
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf('::');
  return [key.slice(0, i), key.slice(i + 2)];
}
