/**
 * T10 · 汇聚判定（正向 + 反向三条提前终止）
 *
 * ★ **算法不在本文件** —— 复用 `@floken-io/moddle` 的 `shouldTerminate()` / `requiredVotes()`。
 *
 * 为什么不复写一份：
 *   `01-moddle` §4.4.1 的原话是「这三条是 `03-engine` M3 必须实现的汇聚语义，
 *   **写在模型层是为了让引擎没有自由心证的空间**」。既然判定已在模型层落地且可执行，
 *   引擎再写一份就是**两份事实源** —— 它们必然漂移，而漂移的表现是「同一份流程定义，
 *   设计器预览的走向和实际跑出来的走向不一样」，极难排查（见 **D-19**）。
 *
 * 本文件只承担 moddle 不负责的三件事：
 *   ① **`ConvergeCtx` 的形状校验** —— 模型层信任入参，引擎不能（`pending` 不自洽要抛）；
 *   ② **结果语义翻译** —— 把 `done / outcome / cancelRest / reason` 收敛成引擎侧的统一形状，
 *      并补一个 `required`（本次判定用的需通过数），供审计与诊断解释「为什么这时候结束」；
 *   ③ **INV-9 的落点** —— `restTokenIds()`：判定说「取消其余」时，到底取消哪些令牌。
 *      这一步**必须**在引擎侧，因为「令牌」是引擎的概念，模型层没有。
 */

import {
  requiredVotes,
  // ★ 加别名：本文件要导出**引擎侧**的 `shouldTerminate`，与模型层同名会撞车。
  //   用 `model` 前缀也顺带提醒读者：算法在模型层，这里只是适配。
  shouldTerminate as modelShouldTerminate,
} from '@floken-io/moddle';
import type { ApprovalMode, NormalizedApproval, OnReject, VoteSpec } from '@floken-io/moddle';

import { voteConfigInvalid, stateShapeInvalid } from '../core/errors.js';
import { LIVE_TOKEN_STATES } from '../core/primitives.js';
import type { Token, TokenState } from '../core/state.js';

// ---------------- 上下文（`ARCHITECTURE.md` §6.3） ----------------

/** 汇聚模式 = `01-moddle` §4.4.1 的 `ApprovalMode`（`countersign` / `orSign` / `voteSign`） */
export type ConvergeMode = ApprovalMode;

/**
 * 汇聚判定的输入。**全部是数，不含任何令牌 / 节点信息** ——
 * 判定本身是纯算术，与引擎无关，所以它才能放在模型层。
 */
export interface ConvergeCtx {
  mode: ConvergeMode;
  /** 该实例组的办理人总数 */
  total: number;
  approved: number;
  rejected: number;
  /** 尚未表态数 —— 必须与 `total − approved − rejected` 一致（否则视为状态不自洽） */
  pending: number;
  /** `vote.count`（与 `threshold` 互斥） */
  count?: number | undefined;
  /** `vote.threshold`（比例，(0,1]） */
  threshold?: number | undefined;
  onReject: OnReject;
}

// ---------------- 结果 ----------------

export interface ConvergenceResult {
  /** `pending` = 还没结束，继续等 */
  outcome: 'approved' | 'rejected' | 'pending';
  /**
   * 是否取消该组内**残余**的在途令牌（INV-9）。
   * 注意：正向汇聚时 `cancelRest` 也可能是 `true`（如或签一人通过 → 取消其余 2 人）。
   */
  cancelRest: boolean;
  /** 人可读的判定依据 —— 进审计 / 诊断，**不进 `message`**（`AGENTS.md` §5.6） */
  reason: string;
  /** 本次判定所用的「需通过数」：`vote` 用 `requiredVotes`，其余 = `total` */
  required: number;
}

// ---------------- 形状校验 ----------------

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/**
 * ★ 模型层信任入参，引擎不能。
 *
 * `pending` 与 `total / approved / rejected` 不自洽意味着「状态已经被算错了」——
 * 此时任何判定结果都不可信，静默按某个口径算下去会把错账写进状态。
 */
function assertConvergeCtx(ctx: ConvergeCtx): void {
  if (ctx === null || typeof ctx !== 'object') {
    throw stateShapeInvalid('ConvergeCtx must be an object', { ctx });
  }
  if (ctx.mode !== 'all' && ctx.mode !== 'any' && ctx.mode !== 'vote') {
    throw stateShapeInvalid(`unknown converge mode '${String(ctx.mode)}'`, {
      mode: ctx.mode,
      allowed: ['all', 'any', 'vote'],
    });
  }
  if (!isNonNegativeInt(ctx.total) || ctx.total < 1) {
    // total === 0 不该出现：INV-13 要求办理人解析为空集时**抛错**，不得产生 0 办理人的组
    throw stateShapeInvalid(`total must be an integer >= 1, got ${String(ctx.total)}`, {
      total: ctx.total,
    });
  }
  for (const key of ['approved', 'rejected', 'pending'] as const) {
    if (!isNonNegativeInt(ctx[key])) {
      throw stateShapeInvalid(`${key} must be a non-negative integer, got ${String(ctx[key])}`, {
        [key]: ctx[key],
      });
    }
  }
  const expectedPending = ctx.total - ctx.approved - ctx.rejected;
  if (ctx.pending !== expectedPending) {
    throw stateShapeInvalid(
      `pending (${ctx.pending}) !== total − approved − rejected (${expectedPending})`,
      { total: ctx.total, approved: ctx.approved, rejected: ctx.rejected, pending: ctx.pending },
    );
  }
  if (ctx.approved + ctx.rejected > ctx.total) {
    throw stateShapeInvalid('approved + rejected exceeds total', {
      total: ctx.total,
      approved: ctx.approved,
      rejected: ctx.rejected,
    });
  }
  if (ctx.onReject !== 'abort' && ctx.onReject !== 'wait') {
    throw stateShapeInvalid(`unknown onReject '${String(ctx.onReject)}'`, {
      onReject: ctx.onReject,
      allowed: ['abort', 'wait'],
    });
  }
}

/**
 * 把 `count` / `threshold` 折成 `VoteSpec`（INV-7：恰有其一）。
 *
 * ⚠️ **只在 `mode === 'vote'` 时强制**；其它模式下允许带 `vote` 字段但**不参与判定** ——
 * 实测 `normalizeApproval({ mode:'all', vote:{count:2} })` 合法且保留该字段（见 **D-20**），
 * 若在此抛错会把「合法的设计期配置」判成非法。
 */
function voteSpecOf(ctx: ConvergeCtx): VoteSpec | undefined {
  const hasCount = ctx.count !== undefined;
  const hasThreshold = ctx.threshold !== undefined;

  if (ctx.mode !== 'vote') return undefined;

  if (hasCount === hasThreshold) {
    throw voteConfigInvalid(
      hasCount
        ? "mode:'vote' requires exactly one of vote.count / vote.threshold, got both"
        : "mode:'vote' requires vote.count or vote.threshold, got neither",
      { mode: ctx.mode, count: ctx.count, threshold: ctx.threshold },
    );
  }
  if (hasCount) {
    if (!Number.isInteger(ctx.count) || (ctx.count as number) < 1) {
      throw voteConfigInvalid('vote.count must be a positive integer', { count: ctx.count });
    }
    return { count: ctx.count as number };
  }
  const t = ctx.threshold as number;
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t > 1) {
    throw voteConfigInvalid('vote.threshold must be a ratio in (0, 1]', { threshold: t });
  }
  return { threshold: t };
}

// ---------------- 判定 ----------------

/**
 * 票签需要几票；非票签 = 全员。
 * 与 `requiredVotes()` 同口径：`count` 优先，否则 `ceil(total × threshold)`，**且不超过 `total`**。
 */
export function requiredOf(ctx: ConvergeCtx): number {
  assertConvergeCtx(ctx);
  return requiredVotes(ctx.total, voteSpecOf(ctx));
}

/**
 * ★ 汇聚判定的**唯一入口**：一次算完正向与反向，返回统一形状。
 *
 * 之所以不直接暴露 moddle 的 `shouldTerminate` 而包这一层，是为了：
 *   - 入参先过形状校验（模型层不做）；
 *   - 结果补 `required`，让「为什么这时候结束」可被审计解释；
 *   - 引擎侧的类型稳定 —— 将来 moddle 的返回形状演进，只改这一处。
 */
export function evaluateConvergence(ctx: ConvergeCtx): ConvergenceResult {
  assertConvergeCtx(ctx);
  const vote = voteSpecOf(ctx);
  const required = requiredVotes(ctx.total, vote);

  /*
   * ★ D-21 / D-31 —— **已在模型层修正（2026-10-01），引擎侧短路随之删除**。
   *
   * 原缺陷：`shouldTerminate()` 把「全员表态后按多数定（`pending === 0`）」放在最前面且不看 `mode`，
   * 于是会签 3 人「2 通过 1 驳回」被判成 **approved**，与会签的全票决定义冲突（违反 INV-11）。
   * 当时引擎在此加了一段 `mode:'all' && rejected > 0` 的短路来兜住语义。
   *
   * 现模型层已按 §4.4.1 的原意重排规则序（先按 `mode` 判，"全员已表态"兜底只对票签生效），
   * 短路遂整块删除 —— 否则就是**两份事实源**，将来必然漂移（D-19 的教训）。
   * 对账测试（③）已去掉该格的例外，一旦模型层再退化会立即红。
   */
  const r = modelShouldTerminate(ctx.mode, ctx.total, ctx.approved, ctx.rejected, {
    onReject: ctx.onReject,
    ...(vote === undefined ? {} : { vote }),
  });

  return {
    outcome: r.outcome,
    cancelRest: r.cancelRest,
    reason: r.reason,
    required,
  };
}

/**
 * **正向**判定：够票了没（`03` §5.2）。
 *
 * ⚠️ 语义边界：它在 `mode:'all'` 下**只在 `rejected === 0` 时成立**（INV-11）——
 * 会签有人驳回时走的是反向终止（规则一），不是「有人驳回也汇聚」。
 */
export function shouldConverge(ctx: ConvergeCtx): boolean {
  return evaluateConvergence(ctx).outcome === 'approved';
}

/**
 * **反向**判定：票数已不可能达标，不该继续等（`03` §5.3 三条规则）。
 *
 * 与正向判定的关系是**互斥且完备**的：`outcome ∈ {approved, rejected, pending}` 三选一，
 * 所以「既不汇聚也不终止」= `pending`（继续等），不存在「两者都 false 却已结束」的中间态。
 */
export function shouldTerminate(ctx: ConvergeCtx): boolean {
  return evaluateConvergence(ctx).outcome === 'rejected';
}

// ---------------- ★ 组计数（T13：引擎侧唯一的计票口径） ----------------

/**
 * 一个汇聚组的当前票数。
 *
 * ★ **计票口径（`total = approved + rejected + pending`）** —— 这一步必须由引擎定，
 *   因为「令牌」是引擎的概念，模型层只有抽象的 `total`。三条硬规则：
 *
 *   ① `approved` / `rejected` = 组内**带 `vote`** 的令牌数（投过票的）；
 *   ② `pending` = 组内**仍在途**（`active` / `waiting`）的令牌数；
 *   ③ **被取消且未表态的令牌自动退出计数**（`total` 随之变小）。
 *
 *   ③ 不是省事，是语义：**减签 = 少一个人 = 分母少一**；**或签"其余取消" = 那些人不再参与**。
 *   若把它们算进 `total`，`pending = total − approved − rejected` 就会大于实际在途人数，
 *   `assertConvergeCtx` 会抛「状态不自洽」—— 那是在用"计数口径"掩盖"成员变了"这个事实。
 */
export interface GroupTally {
  readonly groupId: string;
  /** 组所在的节点（组内令牌必然同节点） */
  readonly nodeId: string;
  readonly total: number;
  readonly approved: number;
  readonly rejected: number;
  readonly pending: number;
}

/**
 * 列出**所有还能被判定**的组（按令牌顺序，保证确定性）。
 *
 * `total === 0` 的组（全员被取消且无人表态）不返回 —— 它没有可判定的内容，
 * 且 `ConvergeCtx` 要求 `total >= 1`。
 */
export function groupTallies(tokens: readonly Token[]): GroupTally[] {
  const order: string[] = [];
  const byGroup = new Map<string, Token[]>();
  for (const t of tokens) {
    const g = t.instanceGroup;
    if (g === undefined) continue;
    const list = byGroup.get(g);
    if (list === undefined) {
      byGroup.set(g, [t]);
      order.push(g);
    } else {
      list.push(t);
    }
  }

  const out: GroupTally[] = [];
  for (const groupId of order) {
    const members = byGroup.get(groupId) ?? [];
    const approved = members.filter((t) => t.vote === 'approved').length;
    const rejected = members.filter((t) => t.vote === 'rejected').length;
    const pending = members.filter((t) => LIVE_TOKEN_STATES.includes(t.state)).length;
    const total = approved + rejected + pending;
    if (total < 1) continue;
    out.push({ groupId, nodeId: members[0]?.nodeId ?? '', total, approved, rejected, pending });
  }
  return out;
}

/**
 * 组 → `ConvergeCtx`（把引擎侧的票翻译成模型层要的那四个数）。
 *
 * ⚠️ `approval` **必填**：`mode` / `onReject` / `vote` 的默认值一律由 moddle 的
 * `normalizeApproval()` 填好（DV-1），没有配置就没有汇聚语义 —— 由调用方在**拿不到配置时抛**，
 * 本函数不自己发明默认值。
 */
export function convergeCtxOf(
  tally: GroupTally,
  approval: NormalizedApproval,
): ConvergeCtx {
  const v = approval.vote;
  return {
    mode: approval.mode,
    total: tally.total,
    approved: tally.approved,
    rejected: tally.rejected,
    pending: tally.pending,
    onReject: approval.onReject,
    ...(v !== undefined && 'count' in v && typeof v.count === 'number' ? { count: v.count } : {}),
    ...(v !== undefined && 'threshold' in v && typeof v.threshold === 'number'
      ? { threshold: v.threshold }
      : {}),
  };
}

// ---------------- INV-9：判定之后该取消谁 ----------------

/**
 * 判定说「取消其余」时，返回该组内**仍需在途中**的令牌 id（供 `cancelInstances` 原语消费）。
 *
 * ★ INV-9 的落点：汇聚触发 `cancelRest` 后，组内**残余令牌必须全部 `cancelled`**，
 * 不得留下 `active` —— 留下 active 会造成「待办还在、实例却已推进」的幽灵待办。
 *
 * @param keep 本次表态者自己（以及任何不该被取消的令牌）的 id
 */
export function restTokenIds(
  tokens: readonly Token[],
  groupId: string,
  keep: readonly string[] = [],
): string[] {
  const live: readonly TokenState[] = LIVE_TOKEN_STATES;
  return tokens
    .filter((t) => t.instanceGroup === groupId && live.includes(t.state) && !keep.includes(t.id))
    .map((t) => t.id);
}
