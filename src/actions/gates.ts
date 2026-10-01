/**
 * @floken-io/engine · 设计期开关校验（`AC-E2` / `AC-E3` / `AC-E15` / `INV-6` / `INV-7`）
 *
 * ★ 本文件是**动作受理**的判据层。两层判据要分清（D-17）：
 *   - `core/primitives.ts`：**状态自洽**（目标是不是已完成节点、令牌在不在途）；
 *   - `actions/gates.ts`（本文件）：**符合设计期配置**（这个动作开了没有、这个目标允不允许）。
 *   两者都抛，但错误码不同 —— 前者 `ENGINE_STATE_SHAPE_INVALID`，后者 `ENGINE_ACTION_*`。
 *
 * ★ **DV-1（默认值单一事实源）**：本文件**不写任何默认值**。
 *   开关值一律从 `@floken-io/moddle` 的 `normalizeApproval()` 结果里读；
 *   在这里写 `?? true` / `?? false` 就是**第二份默认值**，是 engine 与 designer 行为分叉的开始。
 *   唯一的例外是 `reduceSign.requireComment` —— 它在 moddle 里本就是**可选字段**（未配置 = 不强制），
 *   `?? false` 是"读可选字段"，不是"另立默认值"（见 `readGate` 注释）。
 *
 * ⚠️ **白名单式**（`03` §275）：**没配 = 不允许**，不是"先让人做、事后报错"。
 *   推定不了的（如 `allowedTargets` 里的未知取值）一律**判为不允许**，绝不"猜一个"。
 */

import type { NormalizedApproval } from '@floken-io/moddle';
import {
  actionNotAllowed,
  actionTargetInvalid,
  commentRequired,
  voteConfigInvalid,
} from '../core/errors.js';
import type { ActionName, ActionSpec, GatePath } from './catalog.js';
import { ACTION_SPECS } from './catalog.js';

// ---------------- 读取开关 ----------------

export interface GateView {
  /** 设计期是否开启了该动作 */
  readonly allowed: boolean;
  /** 是否强制填写意见 */
  readonly requireComment: boolean;
}

/**
 * 从**已归一化**的配置里读一个开关。
 *
 * `switch` 必须穷尽 `GatePath`（少一个分支 → 运行时 `undefined`，且无编译期红），
 * 故末尾用 `_exhaustive` 兜底（见函数底部）。
 */
export function readGate(approval: NormalizedApproval, path: GatePath): GateView {
  switch (path) {
    case 'reject':
      return {
        allowed: approval.reject.allowed,
        requireComment: approval.reject.requireComment,
      };
    case 'withdraw':
      return {
        allowed: approval.withdraw.allowed,
        requireComment: approval.withdraw.requireComment,
      };
    case 'revoke':
      return { allowed: approval.revoke.allowed, requireComment: approval.revoke.requireComment };
    case 'transfer':
      return {
        allowed: approval.transfer.allowed,
        requireComment: approval.transfer.requireComment,
      };
    case 'delegate':
      return {
        allowed: approval.delegate.allowed,
        requireComment: approval.delegate.requireComment,
      };
    case 'reduceSign':
      // moddle 里 `reduceSign.requireComment` 是**可选**字段：未配置 = 不强制留痕。
      // 这是读可选字段，不是 engine 自写默认值。
      return {
        allowed: approval.reduceSign.allowed,
        requireComment: approval.reduceSign.requireComment ?? false,
      };
    case 'addSign.before':
      return { allowed: approval.addSign.before, requireComment: false };
    case 'addSign.after':
      return { allowed: approval.addSign.after, requireComment: false };
    case 'timeout':
      // 超时动作没有 `allowed` 布尔位：配了 `timeout.actions`（非空）= 开启
      return {
        allowed: approval.timeout !== undefined && approval.timeout.actions.length > 0,
        requireComment: false,
      };
    default: {
      const _exhaustive: never = path;
      throw new Error(`unknown gate path: ${String(_exhaustive)}`);
    }
  }
}

/**
 * 该动作的开关是否已开（含 `jumpTo` / `returnTo` 的 `allowArbitrary` 附加条件）。
 *
 * ⚠️ `approval === undefined`（该节点没配 `floken:approval`）时：
 *   - 无开关的动作（DV-5 四项 + 会签三项）→ **仍可用**（如 `terminate` / `suspend`）；
 *   - 有开关的动作 → **不允许**（白名单式：推定不了 = 不允许，见档首）。
 */
export function isActionEnabled(
  spec: ActionSpec,
  approval: NormalizedApproval | undefined,
): boolean {
  if (spec.gate === null) return true; // DV-5 / 会签三项：没有开关 = 永远可用
  if (approval === undefined) return false;
  if (!readGate(approval, spec.gate).allowed) return false;
  // ★ AC-E15：`reject.allowed` **不隐含** `allowArbitrary`
  if (spec.requiresArbitrary === true && !approval.reject.allowArbitrary) return false;
  return true;
}

/**
 * 当前配置下**已开启**的动作名（`ACTION_NOT_ALLOWED` 的 `details.allowed`）。
 *
 * 报"不允许"时只说"不允许"是不够的 —— 调用方还得知道**能用什么**（`AGENTS.md` §5.4）。
 */
export function enabledActionNames(approval: NormalizedApproval): readonly ActionName[] {
  return ACTION_SPECS.filter((s) => s.native && isActionEnabled(s, approval)).flatMap(
    (s) => s.names,
  );
}

// ---------------- 受理校验 ----------------

/** 查不到 → `ACTION_UNKNOWN`；未开启 → `ACTION_NOT_ALLOWED`（`AC-E2` / `AC-E15`） */
export function assertActionEnabled(
  name: ActionName,
  approval: NormalizedApproval | undefined,
): ActionSpec {
  const spec = ACTION_SPECS.find((s) => s.names.includes(name));
  if (spec === undefined) {
    // 表是本包的常量，理论上不可达；保留是为了「表被改坏」时给出可诊断的失败
    throw actionNotAllowed(name, []);
  }
  if (!isActionEnabled(spec, approval)) {
    // `approval === undefined` 时没有可列的自白名单 —— 传空数组并让 error 的 hint 指向"该节点未配置"
    throw actionNotAllowed(name, approval === undefined ? [] : enabledActionNames(approval));
  }
  return spec;
}

/**
 * 意见留痕校验（`DV-3`）。
 *
 * 默认值**来自 moddle**（回退类 `true`、换人类 `false`），本函数只负责"读出来后执行"。
 */
export function assertComment(
  name: ActionName,
  spec: ActionSpec,
  approval: NormalizedApproval | undefined,
  comment: string | undefined,
): void {
  if (spec.gate === null) return; // 无开关的动作一律不强制留痕
  if (approval === undefined) return; // 无配置 → 已在 `assertActionEnabled` 被拒，这里不再重复判
  if (!readGate(approval, spec.gate).requireComment) return;
  if (typeof comment === 'string' && comment.trim().length > 0) return;
  throw commentRequired(name);
}

/**
 * 目标节点校验（`INV-6` / `AC-E3`）—— 返回解析后的目标 `nodeId`。
 *
 * 判据**两条都要满足**：
 *   ① `target ∈ completedNodes`（历史节点，不是任意节点）；
 *   ② `target` 命中 `allowedTargets` 里的**某一条**语义（缺省 = `['previous']`）：
 *      - `'previous'` → 必须是 `completedNodes` 的**最后一个**；
 *      - `'nodeId'`   → 任意已完成节点（① 已覆盖）；
 *      - `'starter'`  → 必须等于发起节点（由 `startNodeId` 给出；**没给则判不了 → 不许**）。
 *
 * ⚠️ `allowedTargets` 里出现**未知取值**（拼写错 / 未来扩展）时，它不匹配任何语义 →
 *    直接导致该目标被拒，而不是"忽略这条继续"。白名单式：推定不了 = 不允许。
 */
export function assertTarget(params: {
  readonly name: ActionName;
  readonly approval: NormalizedApproval | undefined;
  readonly completedNodes: readonly string[];
  readonly target: string | undefined;
  readonly startNodeId?: string | undefined;
}): string {
  const { name, approval, completedNodes, target, startNodeId } = params;
  if (approval === undefined) {
    // 回退类的开关一定非 null（`gate:'reject'`），故走到这里说明配置缺失 —— 白名单式：不许
    throw actionTargetInvalid(name, target ?? '', completedNodes, []);
  }
  const allowedTargets = approval.reject.allowedTargets;

  const reject = (): never => {
    throw actionTargetInvalid(name, target ?? '', completedNodes, allowedTargets);
  };

  if (typeof target !== 'string' || target.length === 0) reject();
  const t = target as string;
  if (!completedNodes.includes(t)) reject();

  const last = completedNodes[completedNodes.length - 1];
  const ok = allowedTargets.some((kind) => {
    switch (kind) {
      case 'previous':
        return t === last;
      case 'nodeId':
        return true; // ① 已保证 ∈ completedNodes
      case 'starter':
        return startNodeId !== undefined && t === startNodeId;
      default:
        return false; // 未知取值 → 不许（白名单式）
    }
  });
  if (!ok) reject();

  return t;
}

/**
 * ★ 汇聚驳回时**推导**退回目标（T13）。
 *
 * 与 `assertTarget` 的差别：那是**校验**调用方给的 `target`，这是**在没有给的时候按配置推一个** ——
 * 组内驳回者通常不知道（也不该知道）该退回哪儿，目标由设计期的 `allowedTargets` 决定。
 *
 * 推导顺序（**先显式、后推导**）：
 *   ① 给了 `target` 且**通过 `assertTarget`** → 用它；
 *   ② `'previous'` → `completedNodes` 的最后一个；
 *   ③ `'starter'`  → 发起节点（`startNodeId`；没给则跳过）；
 *   ④ 都没有 → 抛 `ENGINE_ACTION_TARGET_INVALID`（宁可显式失败，也不退回"随便一个节点"）。
 *
 * ⚠️ 必须在**把组所在节点记进 `completedNodes` 之前**调用 ——
 *   否则 `'previous'` 会推到组自己所在的节点，变成"驳回后原地重办"。
 */
export function resolveRejectTarget(params: {
  readonly name: ActionName;
  readonly approval: NormalizedApproval;
  readonly completedNodes: readonly string[];
  readonly target?: string | undefined;
  readonly startNodeId?: string | undefined;
}): string {
  const { name, approval, completedNodes, startNodeId } = params;

  if (params.target !== undefined && params.target.length > 0) {
    return assertTarget({ name, approval, completedNodes, target: params.target, startNodeId });
  }

  const allowed = approval.reject.allowedTargets;
  for (const kind of allowed) {
    if (kind === 'previous') {
      const last = completedNodes[completedNodes.length - 1];
      if (last !== undefined) return last;
    }
    if (kind === 'starter' && startNodeId !== undefined && completedNodes.includes(startNodeId)) {
      return startNodeId;
    }
  }

  throw actionTargetInvalid(name, '', completedNodes, allowed);
}

// ---------------- 设计期（加载期）约束 ----------------

/**
 * `INV-7` 的 engine 侧落点：`mode === 'vote'` ⟺ `vote` 存在，且 `count` / `threshold` 恰有其一。
 *
 * ⚠️ **这不是重复实现校验** —— `vote` 的互斥与取值**已由 moddle 的 `validateApproval()` 覆盖**
 * （`union + strict` 判互斥、`mode:'vote'` 缺值 / 越界都报 error），`normalizeApproval()` 有 error 即抛。
 * 本函数是**对归一化结果的后置断言**：挡住"绕过 `normalizeApproval()` 手搓 `NormalizedApproval`"
 * 这条 DV-1 明令禁止的路径。它一旦红，说明上游没走归一化，而不是配置写错了。
 */
export function assertDesignTime(approval: NormalizedApproval): void {
  const hasVote = approval.vote !== undefined;
  if (approval.mode === 'vote' && !hasVote) {
    throw voteConfigInvalid("mode:'vote' requires a vote spec", { mode: approval.mode });
  }
  if (approval.mode !== 'vote' && hasVote) {
    throw voteConfigInvalid(`vote spec is only meaningful with mode:'vote'`, {
      mode: approval.mode,
      vote: approval.vote as unknown,
    });
  }
  if (hasVote) {
    const v = approval.vote as { threshold?: number; count?: number };
    const hasThreshold = typeof v.threshold === 'number';
    const hasCount = typeof v.count === 'number';
    if (hasThreshold === hasCount) {
      throw voteConfigInvalid('vote requires exactly one of threshold / count', {
        hasThreshold,
        hasCount,
      });
    }
  }
}
