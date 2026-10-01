/**
 * @floken-io/engine · `compileAction` —— **动作名 → 原语调用序列**
 *
 * ★ 这是「19 项动作」与「10 个原语」之间的**唯一桥梁**（`ARCHITECTURE.md` §8 ADR-001）：
 *   中国式审批的全部语义都在 `catalog.ts` 那张表里，本文件负责把它**编译**成内核能执行的原语调用。
 *   `core/primitives.ts` 因此永远不必认识"驳回" —— 加一个动作只改 `actions/`，不动内核。
 *
 * ★ 本函数的职责边界：**受理校验 + 参数解析 + 编译出调用序列**。
 *   它**不执行**原语（执行归 T11 `runtime/loop.ts`）、**不碰** `rev` / 时间 / 审计（归 `runtime/plan.ts`）。
 *
 * ★ 纯函数性同 `plan()`：不读时钟、不碰存储、不改入参。
 *
 * ⚠️ **依赖倒置**：凡是需要**外部知识**的东西都从 `CompileContext` 进来 ——
 *   后继节点要定义图（`nextOf`）、办理人要 `ApproverSource`（`assignees`）、
 *   发起节点要定义（`startNodeId`）。本文件**不 import 任何 SPI**，否则 NFR-E6 失守。
 *
 * ⚠️ **D-18**：编译期"缺少必要上下文"的错（定位不到唯一令牌 / 换人没给目标人 / 减签没点名 /
 *   后继节点解析不出）统一归 **`ENGINE_STATE_SHAPE_INVALID`**（`stateShapeInvalid`）。
 *   理由同 D-17：四族都不贴切，就近归类，**不新增码族**。
 *   唯一例外是"解析不出后继节点"→ `definitionMissing`（它本质就是定义缺失）。
 */

import type { NormalizedApproval } from '@floken-io/moddle';
import type { ActionInput } from '../core/action.js';
import {
  actionUnknown,
  addSignLimit,
  approverEmpty,
  definitionMissing,
  stateShapeInvalid,
} from '../core/errors.js';
import type { PrimitiveInputMap, PrimitiveName } from '../core/primitives.js';
import { LIVE_TOKEN_STATES } from '../core/primitives.js';
import type { InstanceState, Token, VoteOutcome } from '../core/state.js';
import type { ActionName, ActionSpec } from './catalog.js';
import { ACTION_NAMES, ACTION_SPEC_BY_NAME } from './catalog.js';
import { assertActionEnabled, assertComment, assertTarget } from './gates.js';

// ---------------- 入参 ----------------

export interface CompileContext {
  /**
   * 设计期配置 —— **必须已归一化**（`normalizeApproval()` 的输出）。
   * DV-1：engine 不自己算默认值，也**不接受未归一化的原始 `Approval`**。
   *
   * ⚠️ 可为 `undefined`：该节点**没配** `floken:approval`。
   *   此时只有「无设计期开关」的动作可用（`terminate` / `suspend` / …），
   *   其余一律被 `assertActionEnabled` 拒（白名单式）—— 详见 `gates.ts`。
   */
  readonly approval: NormalizedApproval | undefined;

  /**
   * 定义图查询：给定节点返回它的**出向后继**。T11 由 `DefinitionSource` + 图算法提供。
   *
   * 不给也能编译（只要动作不需要后继）；需要它时缺失 → `definitionMissing`。
   */
  readonly nextOf?: ((nodeId: string) => string | undefined) | undefined;

  /** 发起节点 id —— `allowedTargets` 含 `'starter'` 时必需（判不出来 = 不允许，见 `gates.assertTarget`） */
  readonly startNodeId?: string | undefined;

  /** 动作作用的令牌。不给且实例恰有 1 个在途令牌 → 取它；否则抛（不猜） */
  readonly tokenId?: string | undefined;

  /** 换人目标 / 加签与会签的办理人集合（`ApproverSource` 的输出） */
  readonly assignees?: readonly string[] | undefined;

  /** 加签 / 会签的实例组 id；不给则由 `nodeId` 派生 */
  readonly groupId?: string | undefined;

  /** 减签要点名取消的令牌 id（减签必须明确范围，不代劳） */
  readonly reduceTokenIds?: readonly string[] | undefined;
}

/** 一个原语调用（判别联合：原语名与其入参类型**绑定**，写错编译期就红） */
export type PrimitiveCall = {
  readonly [K in PrimitiveName]: { readonly primitive: K; readonly input: PrimitiveInputMap[K] };
}[PrimitiveName];

export interface CompiledAction {
  readonly name: ActionName;
  readonly spec: ActionSpec;
  /** 依次执行的原语调用（**提交时立即执行**；汇聚触发的取消归 T10 `convergence.ts`） */
  readonly calls: readonly PrimitiveCall[];
  /** 解析出的目标节点（仅回退类 6 项；其余为 `undefined`） */
  readonly target: string | undefined;
  /**
   * ★ 组内投一票（T13）。
   *
   * 会签 / 或签 / 票签下，`approve` / `reject` **不是推进或跳转** —— 那个节点上还有别人在办，
   * 一个人推走令牌就会把其余人的待办变成「挂在已离开节点上的幽灵待办」。
   * 故组内这两项动作只**记一票**，走向由 `actions/convergence.ts` 定。
   *
   * ⚠️ 有本字段时 `calls` 必为 `[]`（投票不对应任何原语 —— 10 个原语里没有"投票"，
   *    也不该有：它是审批语义，不是内核语义）。
   */
  readonly vote?: VoteCast | undefined;
  /**
   * ★ T15：原语之后的**令牌级微调**（委派回归 / 解散组），执行在 `runtime/loop.ts` 的 `applyPost()`。
   *
   * ⚠️ 与 `vote` **互斥**（组内不委派、委派不在组内）：两者同时出现即为编译期 bug。
   */
  readonly post?: PostStep | undefined;
}

/** 一次投票：谁投的、投的什么 */
export interface VoteCast {
  readonly tokenId: string;
  readonly vote: VoteOutcome;
}

/**
 * ★ T15：**原语之后的令牌级微调**（`CompiledAction.post`）。
 *
 * 为什么不是原语：这两件事都带**审批语义**，而 `core/primitives.ts` 必须业务无知（分层红线）。
 * 为什么又不能没有它：它们都是「AC-E6 / D-34 要求的**动作语义**」，落在原语里会污染内核，
 * 落在 `engine.ts` 里门 2 就复制不到 —— 所以做成 `CompiledAction` 的一个**纯数据字段**，
 * 由 `runtime/loop.ts` 的 `applyPost()` 执行（与 `vote` 同款写法）。
 */
export interface PostStep {
  /**
   * **委派回归**（AC-E6）：把该令牌的办理人换回 `Token.returnTo` 并**清除回归路径**。
   * 令牌**不推进** —— 委派是"请人代看一眼"，代完还得原主确认，不是"替他办完"。
   */
  readonly returnFromTokenId?: string | undefined;
  /**
   * **解散组**：摘掉这些令牌的 `instanceGroup`（D-34）。
   * 组内回退回单人重办时必做 —— 否则目标节点重办后，旧组的 `instanceGroup` 会跟着令牌
   * 走到下一个单人节点，那里的 `groupTallies()` 又会看到这个组并判汇聚 → **流程自己往前走**。
   */
  readonly dissolveTokenIds?: readonly string[] | undefined;
}

/**
 * 该令牌所在汇聚组的**参与者数**（含它自己）。
 *
 * ★ 计数口径必须与 `actions/convergence.ts` 的 `groupTallies()` **完全一致**
 *   （已表态的 + 仍在途的），否则编译期判「单人」、汇聚期判「多人」，两边就会打架。
 *
 * @returns `1` = 不构成组（走 `advance` / `jumpTo` 的老路径）
 */
export function groupSizeOf(state: InstanceState, token: Token): number {
  const g = token.instanceGroup;
  if (g === undefined) return 1;
  return state.tokens.filter(
    (t) => t.instanceGroup === g && (LIVE_TOKEN_STATES.includes(t.state) || t.vote !== undefined),
  ).length;
}

// ---------------- 内部 helpers ----------------

const isActionName = (v: string): v is ActionName =>
  (ACTION_NAMES as readonly string[]).includes(v);

/** 定位本次作用的令牌 */
function resolveToken(state: InstanceState, ctx: CompileContext, action: string): Token {
  if (ctx.tokenId !== undefined) {
    const t = state.tokens.find((x) => x.id === ctx.tokenId);
    if (t === undefined) {
      throw stateShapeInvalid(`action '${action}' targets unknown token '${ctx.tokenId}'`, {
        action,
        tokenId: ctx.tokenId,
        tokenIds: state.tokens.map((x) => x.id),
      });
    }
    return t;
  }
  const live = state.tokens.filter((t) => LIVE_TOKEN_STATES.includes(t.state));
  if (live.length === 1) return live[0] as Token;
  throw stateShapeInvalid(
    `action '${action}' cannot resolve a unique token: pass context.tokenId (found ${live.length} live tokens)`,
    { action, liveTokenIds: live.map((t) => t.id) },
  );
}

/** 解析后继节点；解析不出 → `definitionMissing`（本质就是定义缺这东西） */
function resolveNext(
  state: InstanceState,
  ctx: CompileContext,
  from: string,
  action: string,
): string {
  const to = ctx.nextOf?.(from);
  if (typeof to !== 'string' || to.length === 0) {
    throw definitionMissing(state.processId, state.definitionVersion);
  }
  return to;
}

/** 取换人 / 加签的办理人：空集合 → `approverEmpty`（INV-13） */
function resolveAssignees(
  ctx: CompileContext,
  nodeId: string,
  action: string,
): readonly string[] {
  const list = ctx.assignees ?? [];
  if (list.length === 0) throw approverEmpty(nodeId, action);
  return list;
}

/** 换人动作的目标人（取第一个；多人换人不是这两项动作的语义） */
function resolveSingleAssignee(ctx: CompileContext, nodeId: string, action: string): string {
  return resolveAssignees(ctx, nodeId, action)[0] as string;
}

// ---------------- 编译 ----------------

/**
 * 把一个 `ActionInput` 编译成原语调用序列。
 *
 * 校验顺序（**先便宜后昂贵、先致命后语义**）：
 *   ① 动作名合法（`ACTION_UNKNOWN`）
 *   ② 设计期开关（`ACTION_NOT_ALLOWED`，含 `AC-E15` 的 `allowArbitrary`）
 *   ③ 意见留痕（`COMMENT_REQUIRED`，`DV-3`）
 *   ④ 目标节点（`ACTION_TARGET_INVALID`，`INV-6`）
 *   ⑤ 参数解析（办理人 / 后继 / 令牌 → `APPROVER_EMPTY` / `DEFINITION_MISSING` / `STATE_SHAPE_INVALID`）
 *   ⑥ 加签上限（`ADD_SIGN_LIMIT`，`INV-12`）
 */
export function compileAction(
  input: ActionInput,
  state: InstanceState,
  ctx: CompileContext,
): CompiledAction {
  const name = input.action;
  if (!isActionName(name)) {
    throw actionUnknown(name, ACTION_NAMES);
  }

  const spec = ACTION_SPEC_BY_NAME[name];
  const approval = ctx.approval;

  // ② 设计期开关（DV-2 / AC-E15）
  assertActionEnabled(name, approval);
  // ③ 意见留痕（DV-3，默认值来自 moddle 的归一化结果）
  assertComment(name, spec, approval, input.comment);

  // `saveDraft` 没有原语可编译 —— 它不进内核（`03` §222），提交它本身就是误用
  if (spec.primitives.length === 0) {
    throw stateShapeInvalid(
      `action '${name}' is not handled by the kernel (it has no primitive mapping)`,
      { action: name },
    );
  }

  // ★ `suspend` / `resume` 是**一行两名**：动作名与原语名同名 → 按动作名取对应的那一个原语。
  //   （其余行的动作名与原语名不同名，一律取 `primitives[0]`。）
  const head: PrimitiveName =
    name === 'suspend' || name === 'resume' ? name : (spec.primitives[0] as PrimitiveName);

  /*
   * ★ T13：组内投票**优先于**推进 / 跳转。
   *
   * 位置必须在 `switch` 之前：会签下 `approve` 的 `head` 是 `advance`、`reject` 的 `head` 是
   * `jumpTo`，若让它们照常编译，一个人就把令牌推走了 —— 其余人的待办会挂在「令牌已离开的节点」上，
   * 而且**没有任何报错**（待办表里还看得见，点进去却永远办不动）。
   */
  const vote = groupVoteOf(name, state, ctx);
  if (vote !== undefined) {
    return { name, spec, calls: [], target: undefined, vote };
  }
  switch (head) {
    // —— 实例级控制（不需要令牌）——
    case 'suspend':
      return { name, spec, calls: [{ primitive: 'suspend', input: reason(input) }], target: undefined };
    case 'resume':
      return { name, spec, calls: [{ primitive: 'resume', input: reason(input) }], target: undefined };
    // —— 清场（不需要令牌）——
    case 'halt':
      return { name, spec, calls: [{ primitive: 'halt', input: reason(input) }], target: undefined };

    // —— 回退类 6 项：先校验目标（INV-6），再编译 ——
    case 'jumpTo':
    case 'rollbackTo': {
      const token = resolveToken(state, ctx, name);
      const target = assertTarget({
        name,
        approval,
        completedNodes: state.completedNodes,
        target: input.target,
        ...(ctx.startNodeId !== undefined ? { startNodeId: ctx.startNodeId } : {}),
      });

      /*
       * ★ **D-34 收口（T15）**：组内回退 = **整组重来**，不是"只动我这一票"。
       *
       * 判据（不发明、只选唯一自洽的那个）：回退之后目标节点要**重办**，
       * 而组内其余令牌若留在原节点，那个节点就同时处在「已回退」与「仍在办」两种状态 ——
       * 宿主待办表里会留下 N−1 条**幽灵待办**（看得见、点进去永远办不动、且无报错）。
       *   钉钉 / 泛微 / Camunda 多实例的通行做法也都是「退回 = 本次活动整体重来」。
       *
       * 落地 = 取消同组其余 + 一个令牌跳回 + **解散组**（否则旧组会跟着令牌走到下一节点，
       * 那里的 `groupTallies()` 会再判一次汇聚 → 流程没人在办却自己往前走）。
       * `rollbackTo`（拿回 / 撤销）的原语本身就会取消其它在途令牌，此处同样显式解散组。
       */
      const groupId = token.instanceGroup;
      if (groupId !== undefined && groupSizeOf(state, token) > 1) {
        const others = state.tokens
          .filter(
            (t) => t.instanceGroup === groupId && t.id !== token.id && LIVE_TOKEN_STATES.includes(t.state),
          )
          .map((t) => t.id);
        const calls: PrimitiveCall[] = [];
        if (others.length > 0) {
          calls.push({ primitive: 'cancelInstances', input: { tokenIds: others } });
        }
        calls.push(rollbackOrJump(head, token, target));
        return { name, spec, calls, target, post: { dissolveTokenIds: [token.id] } };
      }

      return {
        name,
        spec,
        calls: [rollbackOrJump(head, token, target)],
        target,
      };
    }

    // —— 正向推进（需要定义图算后继）——
    case 'advance': {
      const token = resolveToken(state, ctx, name);
      /*
       * ★ **AC-E6 委派回归**：令牌带着 `returnTo`（= 委派前的办理人）时，
       *   本次「通过」的语义是**代看完了、还给原主**，**不是推进到下一节点**。
       *   落地 = 办理人换回 A + 清除回归路径（`post.returnFromTokenId`），令牌原地不动。
       *
       *   只认 `approve`：驳回 / 跳转有各自的语义，不该被委派路径截胡。
       *   （`timeoutAction` 也映射 `advance`，但它属内核外，回归语义同样不适用。）
       */
      if (name === 'approve' && token.returnTo !== undefined) {
        return { name, spec, calls: [], target: undefined, post: { returnFromTokenId: token.id } };
      }
      const to = resolveNext(state, ctx, token.nodeId, name);
      return {
        name,
        spec,
        calls: [{ primitive: 'advance', input: { tokenId: token.id, to } }],
        target: undefined,
      };
    }

    // —— 换人（不动令牌）——
    case 'transfer': {
      const token = resolveToken(state, ctx, name);
      return {
        name,
        spec,
        calls: [
          {
            primitive: 'transfer',
            input: {
              tokenId: token.id,
              assignee: resolveSingleAssignee(ctx, token.nodeId, name),
            },
          },
        ],
        target: undefined,
      };
    }
    case 'delegate': {
      const token = resolveToken(state, ctx, name);
      return {
        name,
        spec,
        calls: [
          {
            primitive: 'delegate',
            input: {
              tokenId: token.id,
              assignee: resolveSingleAssignee(ctx, token.nodeId, name),
            },
          },
        ],
        target: undefined,
      };
    }

    // —— 加签 / 会签（INV-12 上限 + INV-13 空集）——
    case 'spawnInstances': {
      const token = resolveToken(state, ctx, name);
      // 前加签插在当前节点（本节点重办）；后加签插在**后继**节点
      const nodeId = name === 'addSignAfter' ? resolveNext(state, ctx, token.nodeId, name) : token.nodeId;
      const groupId = ctx.groupId ?? `${nodeId}#sign`;
      const assignees = resolveAssignees(ctx, nodeId, name);
      const isMultiInstance = spec.mode !== undefined;

      /*
       * ★ 会签三项（`spec.mode` 有值）**必须有 `floken:approval`**。
       *   理由：`mode` / `onReject` / `vote` 是汇聚判据的**全部输入**，且它们的默认值只在
       *   moddle 的 `normalizeApproval()` 落一处（DV-1）。没有配置就没有汇聚语义 ——
       *   此时 engine 若自己默认成 `all`，「提交 orSign 却按会签收敛」将成为无解的静默错误。
       */
      if (isMultiInstance && approval === undefined) {
        throw stateShapeInvalid(
          `action '${name}' requires a floken:approval config on node '${nodeId}' (mode / onReject / vote come from it)`,
          { action: name, nodeId },
        );
      }

      // INV-12：加签后组内令牌总数不得超过 `addSign.maxCount`（未配置则不限）
      const maxCount = approval?.addSign.maxCount;
      if (typeof maxCount === 'number') {
        /*
         * ★ 按「该节点上的令牌数」计，不按 `instanceGroup` 计 —— 加签**不建组**（D-33），
         *   按组数会永远数到 0，上限形同虚设。
         */
        const current = state.tokens.filter(
          (t) => t.nodeId === nodeId && LIVE_TOKEN_STATES.includes(t.state),
        ).length;
        const after = current + assignees.length;
        if (after > maxCount) throw addSignLimit(nodeId, maxCount, after);
      }

      return {
        name,
        spec,
        calls: [
          {
            primitive: 'spawnInstances',
            input: {
              nodeId,
              groupId,
              assignees,
              // 会签 / 或签 / 票签是"展开"：取代当前那个占位令牌；加签是"新增"
              ...(spec.mode !== undefined ? { replaceTokenId: token.id } : {}),
              // 展开建组（要汇聚）；加签不建组（见 `SpawnInstancesInput.grouped` 注释）
              grouped: isMultiInstance,
            },
          },
        ],
        target: undefined,
      };
    }

    // —— 减签（必须点名范围，不代劳）——
    case 'cancelInstances': {
      const tokenIds = ctx.reduceTokenIds ?? [];
      if (tokenIds.length === 0) {
        throw stateShapeInvalid(
          `action '${name}' requires context.reduceTokenIds (which tokens to cancel)`,
          { action: name },
        );
      }
      return {
        name,
        spec,
        calls: [{ primitive: 'cancelInstances', input: { tokenIds } }],
        target: undefined,
      };
    }

    default: {
      const _exhaustive: never = head;
      throw stateShapeInvalid(`action '${name}' maps to unmapped primitive`, {
        action: name,
        primitive: String(_exhaustive),
      });
    }
  }
}

/**
 * `jumpTo` / `rollbackTo` 的调用体。
 *
 * ★ **D-47**：`rollbackTo` 要把撤销范围收缩到本分支（`Token.branch`）——
 *   并行分支下"撤销下游"若仍按全局取消，会误伤另一条分支上正在办的待办。
 *   单分支时令牌没有 `branch`，原语退回"取消全部"的既有行为（无需迁移）。
 */
function rollbackOrJump(head: 'jumpTo' | 'rollbackTo', token: Token, target: string): PrimitiveCall {
  if (head === 'rollbackTo') {
    return {
      primitive: 'rollbackTo',
      input: {
        tokenId: token.id,
        to: target,
        ...(token.branch !== undefined ? { branch: token.branch } : {}),
      },
    };
  }
  return { primitive: 'jumpTo', input: { tokenId: token.id, to: target } };
}

/**
 * 组内投票的编译结果；非组内 / 非投票动作 → `undefined`。
 *
 * ⚠️ 只有 `approve` / `reject` / `rejectToPrev` 三项有"投票"语义。
 *   `jumpTo` / `returnTo` / `takeBack` / `revoke` 在组内**尚未闭环**（**D-34**，T15）——
 *   它们动的是单个令牌，组内其余令牌会留在原节点。此处**不静默代劳**（不做"顺手全取消"），
 *   因为那是在没有规格依据的情况下发明语义；宁可让它表现为可观察的现状。
 */
function groupVoteOf(
  name: ActionName,
  state: InstanceState,
  ctx: CompileContext,
): VoteCast | undefined {
  if (name !== 'approve' && name !== 'reject' && name !== 'rejectToPrev') return undefined;
  const token = resolveToken(state, ctx, name);
  if (groupSizeOf(state, token) <= 1) return undefined;
  return { tokenId: token.id, vote: name === 'approve' ? 'approved' : 'rejected' };
}

/** `reason` 是可选字段；`exactOptionalPropertyTypes` 下不能写 `undefined` */
function reason(input: ActionInput): { reason?: string } {
  return input.comment !== undefined && input.comment.length > 0
    ? { reason: input.comment }
    : {};
}
