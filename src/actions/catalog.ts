/**
 * @floken-io/engine · **19 项审批动作映射表**（中国式审批的护城河，**单一事实源**）
 *
 * ★ 本表与 `03-包需求-floken-engine.md` §4 主表**逐行对应**；
 *   `primitiveExpr` 字段存的是文档「→ 原语」列的**逐字原文**，
 *   于是「文档与代码是否还对得上」从**人肉核对**变成 `test/catalog.test.ts` 里的一条断言。
 *
 * ★ 计数口径（`03` §192~197，别混）：
 *   - 主表 **19 行**（`ACTION_SPECS.length`）；
 *   - 其中 **17 行内核原生**（`native: true`），2 行内核外（`timeoutAction` 由调度层触发、`saveDraft` 不进内核）；
 *   - `suspend` / `resume` 是**一对**实例级控制动作，**按 1 项计入** → 本表里它是 **1 行、2 个名字**；
 *   - 因此**可提交的动作名有 20 个**（`ACTION_NAMES.length`），而**动作项数是 19**（`ACTION_SPECS.length`）。
 *     「19」与「20」的差就在这一行，已由自检断言钉死，不是笔误。
 *   - 另有 2 条**机制约束不算动作**（动作开关校验、动作留轨迹），全表项合计 21。
 *
 * ★ **DV-1（默认值单一事实源）**：本表**不存任何默认值**，只存「去 `NormalizedApproval` 的哪个字段读」。
 *   默认值一律由 `@floken-io/moddle` 的 `normalizeApproval()` 填好后再进来 ——
 *   在这里写 `requireComment: true` 就是**第二份默认值**，是分叉的开始。
 *
 * ⚠️ **分层红线**（`AGENTS.md` §4.1）：`actions/` 可以认识"驳回"，
 *   `core/primitives.ts` **不认识** —— 这正是分层本身。
 */

import type { ApprovalMode } from '@floken-io/moddle';
import type { PrimitiveName } from '../core/primitives.js';

// ---------------- 动作名 ----------------

/**
 * 20 个可提交的动作名。
 *
 * ⚠️ 与「19 项动作」不矛盾：`suspend` / `resume` 属同一项（一对控制动作）。
 */
export type ActionName =
  // —— 流转 ——
  | 'approve'
  | 'reject'
  | 'rejectToPrev'
  | 'jumpTo'
  | 'returnTo'
  | 'takeBack'
  | 'revoke'
  | 'terminate'
  // —— 换人 ——
  | 'transfer'
  | 'delegate'
  // —— 改待办集合 ——
  | 'addSignBefore'
  | 'addSignAfter'
  | 'reduceSign'
  // —— 多实例 ——
  | 'countersign'
  | 'orSign'
  | 'voteSign'
  // —— 内核外 ——
  | 'timeoutAction'
  // —— 实例级控制（1 项，2 个名字）——
  | 'suspend'
  | 'resume'
  | 'saveDraft';

/**
 * 设计期开关在 `NormalizedApproval` 上的**读取位置**。
 *
 * 只存"读哪儿"，不存"值多少"（DV-1）。`null` = 该动作无设计期开关。
 */
export type GatePath =
  // —— 有 `allowed` + `requireComment` 的动作门 ——
  | 'reject'
  | 'withdraw'
  | 'revoke'
  | 'transfer'
  | 'delegate'
  | 'reduceSign'
  // —— 只有布尔标志的配置项 ——
  | 'addSign.before'
  | 'addSign.after'
  | 'timeout';

/**
 * 有 `requireComment` 语义的五个门 —— 必须与 moddle 的 `REQUIRE_COMMENT_DEFAULTS`
 * **键集完全一致**（`test/catalog.test.ts` 有断言守）：
 * 这五个之外的动作（加签 / 减签 / 会签 / 终止 / 通过…）moddle 没有定型默认值，
 * engine **不自己发明**（DV-1）→ 一律"不强制意见"。
 */
export const COMMENT_GATE_PATHS = [
  'reject',
  'withdraw',
  'revoke',
  'transfer',
  'delegate',
] as const;

export type CommentGatePath = (typeof COMMENT_GATE_PATHS)[number];

// ---------------- 主表 ----------------

export interface ActionSpec {
  /** 该行的动作名（多数 1 个；`suspend`/`resume` 那一行 2 个） */
  readonly names: readonly ActionName[];
  readonly label: string;
  /** ★ `03` §4 主表「→ 原语」列的**逐字原文**，仅用于对账，**不是执行依据** */
  readonly primitiveExpr: string;
  /** 提交时**立即执行**的原语序列（执行依据） */
  readonly primitives: readonly PrimitiveName[];
  /** 设计期开关的读取位置；`null` = 无开关 */
  readonly gate: GatePath | null;
  /** 是否必须带 `target`（回退类 6 项） */
  readonly needsTarget: boolean;
  /**
   * ★ `jumpTo` / `returnTo` 专属：开关开了 `reject.allowed` **还不够**，
   * 另需 `reject.allowArbitrary === true`（`AC-E15`：`allowed` 不隐含 `allowArbitrary`）——
   * 它们打破图的拓扑约束，是比"驳回"更强的能力，必须单独授权。
   */
  readonly requiresArbitrary?: boolean;
  /** 是否内核原生执行（`false` 的两项不进内核） */
  readonly native: boolean;
  /** 会签三项的汇聚模式；非会签动作无 */
  readonly mode?: ApprovalMode;
}

/**
 * ★ 主表 —— **19 行**，顺序同 `03` §4。
 *
 * `primitiveExpr` 与文档逐字一致，改表时**两处必须一起改**（有测试守）。
 */
export const ACTION_SPECS: readonly ActionSpec[] = Object.freeze([
  // —— 流转 ——
  {
    names: ['approve'],
    label: '通过',
    primitiveExpr: 'advance',
    primitives: ['advance'],
    gate: null,
    needsTarget: false,
    native: true,
  },
  {
    names: ['reject'],
    label: '驳回',
    primitiveExpr: 'jumpTo',
    primitives: ['jumpTo'],
    gate: 'reject',
    needsTarget: true,
    native: true,
  },
  {
    names: ['rejectToPrev'],
    label: '驳回到上一节点',
    primitiveExpr: 'jumpTo',
    primitives: ['jumpTo'],
    gate: 'reject',
    needsTarget: true,
    native: true,
  },
  {
    names: ['jumpTo'],
    label: '任意跳转',
    primitiveExpr: 'jumpTo',
    primitives: ['jumpTo'],
    gate: 'reject',
    needsTarget: true,
    requiresArbitrary: true,
    native: true,
  },
  {
    names: ['returnTo'],
    label: '任意退回',
    primitiveExpr: 'jumpTo',
    primitives: ['jumpTo'],
    gate: 'reject',
    needsTarget: true,
    requiresArbitrary: true,
    native: true,
  },
  {
    names: ['takeBack'],
    label: '拿回',
    primitiveExpr: 'rollbackTo',
    primitives: ['rollbackTo'],
    gate: 'withdraw',
    needsTarget: true,
    native: true,
  },
  {
    names: ['revoke'],
    label: '撤销',
    primitiveExpr: 'rollbackTo',
    primitives: ['rollbackTo'],
    gate: 'revoke',
    needsTarget: true,
    native: true,
  },
  {
    names: ['terminate'],
    label: '终止',
    primitiveExpr: 'halt',
    primitives: ['halt'],
    gate: null,
    needsTarget: false,
    native: true,
  },
  // —— 换人 ——
  {
    names: ['transfer'],
    label: '转办',
    primitiveExpr: 'transfer',
    primitives: ['transfer'],
    gate: 'transfer',
    needsTarget: false,
    native: true,
  },
  {
    names: ['delegate'],
    label: '委派',
    primitiveExpr: 'delegate',
    primitives: ['delegate'],
    gate: 'delegate',
    needsTarget: false,
    native: true,
  },
  // —— 改待办集合 ——
  {
    names: ['addSignBefore'],
    label: '前加签',
    primitiveExpr: 'spawnInstances',
    primitives: ['spawnInstances'],
    gate: 'addSign.before',
    needsTarget: false,
    native: true,
  },
  {
    names: ['addSignAfter'],
    label: '后加签',
    primitiveExpr: 'spawnInstances',
    primitives: ['spawnInstances'],
    gate: 'addSign.after',
    needsTarget: false,
    native: true,
  },
  {
    names: ['reduceSign'],
    label: '减签',
    primitiveExpr: 'cancelInstances',
    primitives: ['cancelInstances'],
    gate: 'reduceSign',
    needsTarget: false,
    native: true,
  },
  // —— 多实例（汇聚模式由 `mode` 承载，不是动作开关）——
  {
    names: ['countersign'],
    label: '会签',
    primitiveExpr: 'spawnInstances',
    primitives: ['spawnInstances'],
    gate: null,
    needsTarget: false,
    native: true,
    mode: 'all',
  },
  {
    names: ['orSign'],
    label: '或签',
    primitiveExpr: 'spawnInstances+cancelInstances',
    // ★ `cancelInstances` 不在提交时执行 —— 它在**汇聚时**由 T10 `actions/convergence.ts` 触发
    //   （一人通过 → 取消其余）。`primitiveExpr` 保留文档原文以便对账。
    primitives: ['spawnInstances'],
    gate: null,
    needsTarget: false,
    native: true,
    mode: 'any',
  },
  {
    names: ['voteSign'],
    label: '票签',
    primitiveExpr: 'spawnInstances+cancelInstances',
    primitives: ['spawnInstances'],
    gate: null,
    needsTarget: false,
    native: true,
    mode: 'vote',
  },
  // —— 内核外 ——
  {
    names: ['timeoutAction'],
    label: '超时自动处理',
    primitiveExpr: 'advance',
    primitives: ['advance'],
    gate: 'timeout',
    needsTarget: false,
    native: false,
  },
  {
    names: ['suspend', 'resume'],
    label: '挂起 / 恢复',
    primitiveExpr: 'suspend + resume',
    primitives: ['suspend', 'resume'],
    gate: null,
    needsTarget: false,
    native: true,
  },
  {
    names: ['saveDraft'],
    label: '暂存',
    primitiveExpr: '（空）',
    primitives: [],
    gate: null,
    needsTarget: false,
    native: false,
  },
]);

// ---------------- 派生（凡能算出的数字不手列） ----------------

/** 20 个可提交的动作名（由主表展开；顺序同表，`suspend` 先于 `resume`） */
export const ACTION_NAMES: readonly ActionName[] = Object.freeze(
  ACTION_SPECS.flatMap((s) => s.names),
);

/** 动作名 → 所在行（查表 O(1)；`suspend` / `resume` 指向同一行） */
export const ACTION_SPEC_BY_NAME: Readonly<Record<ActionName, ActionSpec>> = Object.freeze(
  Object.fromEntries(ACTION_SPECS.flatMap((s) => s.names.map((n) => [n, s]))) as Record<
    ActionName,
    ActionSpec
  >,
);

/** 回退类 6 项（DV-3「回退类」列的动作集合；由 `needsTarget` 派生，不另列一份） */
export const ROLLBACK_ACTIONS: readonly ActionName[] = Object.freeze(
  ACTION_SPECS.filter((s) => s.needsTarget).flatMap((s) => s.names),
);

/** 换人类 2 项（DV-3「换人类」列） */
export const HANDOVER_ACTIONS: readonly ActionName[] = Object.freeze(['transfer', 'delegate']);

/**
 * 会展开多实例的动作（加签 2 + 会签 3）—— 由主表派生（`primitives` 含 `spawnInstances`），不另列一份。
 *
 * 用途：`runtime/engine.ts` 据此决定「要不要调 `ApproverSource` 把节点配置展开成办理人集合」。
 */
export const SPAWN_ACTIONS: readonly ActionName[] = Object.freeze(
  ACTION_SPECS.filter((s) => s.primitives.includes('spawnInstances')).flatMap((s) => s.names),
);

/**
 * ★ DV-5 的 4 项「没有设计期开关」的动作 —— 由表派生：
 * `gate === null` 且**不是会签三项**（会签的开关是 `mode` 汇聚配置，不是动作开关）。
 */
export const UNGATED_ACTIONS: readonly ActionName[] = Object.freeze(
  ACTION_SPECS.filter((s) => s.gate === null && s.mode === undefined).flatMap((s) => s.names),
);

// ---------------- 编译期锁 ----------------

/** 少一个动作名 / 名字写错，这里立刻红（与 `SPI_NAMES` 的锁同款） */
export const _actionNamesExhaustive: Record<ActionName, true> = {
  approve: true,
  reject: true,
  rejectToPrev: true,
  jumpTo: true,
  returnTo: true,
  takeBack: true,
  revoke: true,
  terminate: true,
  transfer: true,
  delegate: true,
  addSignBefore: true,
  addSignAfter: true,
  reduceSign: true,
  countersign: true,
  orSign: true,
  voteSign: true,
  timeoutAction: true,
  suspend: true,
  resume: true,
  saveDraft: true,
};

/** `GatePath` 的每个分支都必须在主表里被用到过（否则是死配置） */
export const _gatePathsExhaustive: Record<GatePath, true> = {
  reject: true,
  withdraw: true,
  revoke: true,
  transfer: true,
  delegate: true,
  reduceSign: true,
  'addSign.before': true,
  'addSign.after': true,
  timeout: true,
};
