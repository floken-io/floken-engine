/**
 * @floken-io/engine · 10 个内核原语（**业务无知**）
 *
 * ★ 分层的红线（`03` §3 / `ARCHITECTURE.md` §8 ADR-001）：
 *   **内核只认识这 10 个操作，不认识"驳回"** —— 本文件里出现 `if (action === 'reject')` 即视为分层已破。
 *   新增一个中国式审批动作时**只改 `actions/`**；若需要改本文件，说明那个动作被错误地实现成了原语。
 *
 * ★ 原语的自我定位（与 `runtime/plan.ts` 的分工）：
 *   - 原语 = **状态变换**：只动 `tokens` / `completedNodes` / `status`；
 *   - `plan()` = **一次提交的完整演化**：`rev` / `updatedAt` / `lastAction` / `auditTrail` / `delta`。
 *   ⇒ 本文件**不碰** `rev`、时间、审计 —— 否则与 `plan()` 重复记账（INV-4：一条 seq 对应一次变更）。
 *     原语级审计由 T11 的 `runtime/loop.ts` 在调用原语时追加（`TraceEntry.kind: 'primitive'`）。
 *
 * ★ 纯函数性同 `plan()`：不读时钟、不碰存储、不改入参（先 `cloneState`）。
 *   令牌 id 由入参 `groupId` **确定性生成**（`${groupId}#${i}`）—— 纯函数不能用随机数 / 计数器。
 *
 * ⚠️ **错误码的归类裁决（D-17）**：原语的「语义前置条件不满足」（如 `jumpTo` 目标不是已完成节点、
 *   `spawnInstances` 传入空办理人、`resume` 用在非挂起实例）一律抛 **`ENGINE_STATE_SHAPE_INVALID`** ——
 *   四族里没有更贴切的类别：`ACTION_` 是动作受理语义（归 T9 `gates.ts`）、`PERSIST_` 是存储、`OPTION_` 是配置。
 *   业务层的 `allowedTargets` 校验（INV-6 ②）**仍归 `actions/gates.ts`**，两层判据不同：
 *   **原语保证状态自洽，gates 保证符合设计期配置**。
 */

import { stateShapeInvalid, stateSuspended, stateTerminal } from './errors.js';
import type { InstanceState, Token, TokenState } from './state.js';
import { assertSerializable, cloneState, isTerminalStatus } from './state.js';

// ---------------- 原语名（计数的事实源） ----------------

/**
 * 10 个原语名，**顺序即契约**（分组扁平化后须与本表逐项一致，有测试守）。
 *
 * 与 `SPI_NAMES` 同款：凡能算出的数字不手列。
 */
export const PRIMITIVE_NAMES = [
  // —— 令牌级 8 ——
  'advance',
  'jumpTo',
  'rollbackTo',
  'spawnInstances',
  'cancelInstances',
  'transfer',
  'delegate',
  'halt',
  // —— 实例级 2 ——
  'suspend',
  'resume',
] as const;

/**
 * 分组：**8 令牌级 + 2 实例级**（`03` §3 的口径）。
 *
 * `halt` 会置实例终态，但它属于「清场」动作而非"冻结/恢复"控制，故归令牌级；
 * 实例级只有 `suspend` / `resume` 这对（可恢复的冻结，`03` §162 明确区分于 `halt` 的不可逆清理）。
 */
export const PRIMITIVE_GROUPS = {
  token: ['advance', 'jumpTo', 'rollbackTo', 'spawnInstances', 'cancelInstances', 'transfer', 'delegate', 'halt'],
  instance: ['suspend', 'resume'],
} as const;

export type PrimitiveName = (typeof PRIMITIVE_NAMES)[number];

/** 仍在途（可被取消 / 可被终止清场）的令牌状态 */
export const LIVE_TOKEN_STATES: readonly TokenState[] = ['active', 'waiting'];

// ---------------- 入参 ----------------

export interface AdvanceInput {
  tokenId: string;
  /** 目标节点（**出向流的另一端**，由 `runtime/loop.ts` 结合定义图算出 —— 原语不认识图） */
  to: string;
}

export interface JumpToInput {
  tokenId: string;
  /** 目标节点，**必须 ∈ `completedNodes`**（`03` §166：驳回 = 回到已完成的节点，不是走另一条线） */
  to: string;
}

export interface RollbackToInput {
  tokenId: string;
  /** 回滚目标，**必须 ∈ `completedNodes`**；其后完成的节点与下游在途令牌一并撤销 */
  to: string;
  /**
   * ★ **撤销范围收缩到本分支**（T16 · **D-47**）：只取消 `branch` 相同的在途令牌。
   *
   * 不传 = 取消**全部**其它在途令牌（单分支流程的既有行为，保持不变）。
   *
   * 为什么必须有它：并行分支下，"撤销下游"若仍按全局取消，A 分支上点一次"撤销"
   *   会把 B 分支上毫不相干的待办一起取消 —— 而 B 分支的人正办着，
   *   表现为"我的待办凭空消失了"，且**没有任何报错**可循（这是最难查的一类误伤）。
   *
   * ⚠️ 判据用**相等**而不是"前缀匹配"：嵌套并行下子分支的 `branch` 是父分支值的延伸，
   *   按前缀匹配会把兄弟分支也算进来 —— 那就等于没收缩。
   */
  branch?: string;
}

export interface SpawnInstancesInput {
  nodeId: string;
  /** 实例组（会签 / 加签的归组键）；令牌 id 由它确定性生成 */
  groupId: string;
  /** 办理人列表；**不得为空**（INV-13：不得产生 0 办待人却 active 的节点） */
  assignees: readonly string[];
  /** 被展开取代的令牌（会签展开时那一个"占位令牌"）；不给则只新增 */
  replaceTokenId?: string;
  /**
   * 新令牌是否带 `instanceGroup`（即**是否参与汇聚**）。缺省 `true`。
   *
   * ★ 为什么需要它：会签三项是"**取代**占位令牌的展开"—— 那一组人**就是**这个节点的全部办理人，
   *   必须建组才能汇聚；加签是"**新增**一个人"，原令牌还在原地且**不在组内**，
   *   若也给新令牌打组，就会得到一个「只含加签来的人」的组 —— 那个人一通过，
   *   汇聚判据满足，流程被他一个人推走，原办理人的待办变成幽灵待办（且无任何报错）。
   *
   * ⚠️ 加签的汇聚语义尚未定型（**D-33**），故加签**不建组**：宁可不汇聚，也不能静默错汇聚。
   */
  grouped?: boolean;
}

export interface CancelInstancesInput {
  /** 按实例组取消（或签"其余取消" / 减签） */
  groupId?: string;
  /** 按令牌 id 取消（精确点名）；与 `groupId` 可并存（取并集） */
  tokenIds?: readonly string[];
}

export interface TransferInput {
  tokenId: string;
  assignee: string;
}

export interface DelegateInput {
  tokenId: string;
  assignee: string;
}

export interface HaltInput {
  reason?: string;
}

export interface SuspendInput {
  reason?: string;
}

export interface ResumeInput {
  reason?: string;
}

/** 原语名 → 入参类型的映射（编译期锁：`Primitives` 少一个就红） */
export interface PrimitiveInputMap {
  advance: AdvanceInput;
  jumpTo: JumpToInput;
  rollbackTo: RollbackToInput;
  spawnInstances: SpawnInstancesInput;
  cancelInstances: CancelInstancesInput;
  transfer: TransferInput;
  delegate: DelegateInput;
  halt: HaltInput;
  suspend: SuspendInput;
  resume: ResumeInput;
}

/**
 * 10 个原语的函数签名表。
 * ★ 这是「10 个」这个数字在**类型层**的落点：将来少实现一个，`_primitivesExhaustive` 立刻红。
 */
export type Primitives = {
  [K in PrimitiveName]: (state: InstanceState, input: PrimitiveInputMap[K]) => InstanceState;
};

// ---------------- 内部 helpers ----------------

/** 变换的统一外壳：拷贝 → 改副本 → 序列化体检（INV-14）→ 返回。绝不改入参 */
function transform(
  state: InstanceState,
  mutate: (next: InstanceState) => void,
): InstanceState {
  const next = cloneState(state);
  mutate(next);
  assertSerializable(next, 'next');
  return next;
}

/**
 * 令牌级原语的公共前置（INV-5 的落点 —— `§6.4` 里 INV-5 的维护方写的就是 `core/primitives.ts`）：
 * ① 终态实例一律不可动；② `suspended` 时**除 `resume` 外**一律不受理。
 */
function requireLiveInstance(state: InstanceState, primitive: PrimitiveName): void {
  if (isTerminalStatus(state.status)) {
    throw stateTerminal(state.instanceId, state.status, primitive);
  }
  if (state.status === 'suspended') {
    throw stateSuspended(state.instanceId, primitive);
  }
}

/** 定位一个在途令牌；找不到 / 不在途 → 抛（`stateShapeInvalid`，理由见档首 D-17） */
function requireLiveToken(
  state: InstanceState,
  tokenId: string,
  primitive: PrimitiveName,
): Token {
  const token = state.tokens.find((t) => t.id === tokenId);
  if (token === undefined) {
    throw stateShapeInvalid(`primitive '${primitive}' targets unknown token '${tokenId}'`, {
      primitive,
      tokenId,
    });
  }
  if (!LIVE_TOKEN_STATES.includes(token.state)) {
    throw stateShapeInvalid(
      `primitive '${primitive}' targets a token that is already '${token.state}'`,
      { primitive, tokenId, tokenState: token.state },
    );
  }
  return token;
}

/** `to` 必须是已完成节点（`jumpTo` / `rollbackTo` 的共同前置） */
function requireCompletedTarget(
  state: InstanceState,
  to: string,
  primitive: PrimitiveName,
): number {
  const at = state.completedNodes.indexOf(to);
  if (at < 0) {
    throw stateShapeInvalid(`primitive '${primitive}' target '${to}' is not a completed node`, {
      primitive,
      target: to,
      completedNodes: [...state.completedNodes],
    });
  }
  return at;
}

function requireNonEmpty(value: string, what: string, primitive: PrimitiveName): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw stateShapeInvalid(`primitive '${primitive}' requires a non-empty ${what}`, {
      primitive,
      field: what,
    });
  }
}

/**
 * 「离开某节点」→ 记进 `completedNodes`（去重）。
 *
 * ★ 导出给 `runtime/loop.ts` 的**自动直通**复用（D-28）：直通不走 `advance` 原语，
 *   若它不记账，`completedNodes` 就会**永远是空的** —— 而 `INV-6` 要求驳回 / 退回的目标
 *   必须 ∈ `completedNodes`，于是「驳回给发起人」这类最常见的场景**永远做不到**，
 *   且症状是「目标非法」而不是「记账漏了」，极难往回查。
 */
export function markCompleted(next: InstanceState, nodeId: string): void {
  if (!next.completedNodes.includes(nodeId)) next.completedNodes.push(nodeId);
}

/**
 * ★ 令牌**换了节点** → 办理人 / 委派回归路径 / 待办创建时刻**一并作废**。
 *
 * 为什么必须在原语里做（而不是留给 `runtime/loop.ts` 判断）：
 *   办理人是**"某个节点上的某个令牌"**的属性，不是令牌的固有属性。
 *   若 `advance` 不清除，`run-to-wait` 会在新节点上看到旧办理人 → 判定「已落定」而停下，
 *   于是令牌**永远走不到终点**，且表现是"待办还在、人也对、就是推不动"，极难排查。
 *   委派回归路径同理（A→B 的回归只对那一次委派成立）。
 */
export function clearAssignment(t: Token): void {
  delete t.assignee;
  delete t.returnTo;
  delete t.createdAt;
  // ★ T20：等待态同样是**节点级**属性 —— 换了节点，旧的"等什么"立即作废
  //   （留着会让令牌在新节点上被判成稳定点而**永远推不动**）
  delete t.awaiting;
}

const isLive = (t: Token): boolean => LIVE_TOKEN_STATES.includes(t.state);

// ---------------- 令牌级原语（8） ----------------

/**
 * `advance` —— 沿出向流推进令牌。
 *
 * ★ 与 `jumpTo` 的差别（`03` §166）：`advance` 是**正向走线**，`to` 由调用方结合定义图算出；
 *   它把**离开的节点**记进 `completedNodes`（该节点办完了），而 `jumpTo` 是把**目标节点从
 *   completedNodes 里摘出来重办**。一个是"往前记"，一个是"往回摘"。
 */
export function advance(state: InstanceState, input: AdvanceInput): InstanceState {
  requireLiveInstance(state, 'advance');
  const token = requireLiveToken(state, input.tokenId, 'advance');
  requireNonEmpty(input.to, 'to', 'advance');

  const from = token.nodeId;
  return transform(state, (next) => {
    const t = next.tokens.find((x) => x.id === input.tokenId);
    /* istanbul ignore next —— 前置已定位成功 */
    if (t === undefined) return;
    t.nodeId = input.to;
    clearAssignment(t); // 换了节点 → 旧办理人作废（见 clearAssignment 注释）
    markCompleted(next, from);
  });
}

/**
 * `jumpTo` —— 跳到**已完成的某个历史节点**（驳回 / 任意退回 / 任意跳转）。
 *
 * 执行：令牌移到 `to`，并把 `to` 从 `completedNodes` **摘掉**（要重办）。
 * 下游在途令牌**保留** —— 只摘目标本身，不撤销下游；撤销下游是 `rollbackTo` 的事。
 */
export function jumpTo(state: InstanceState, input: JumpToInput): InstanceState {
  requireLiveInstance(state, 'jumpTo');
  const token = requireLiveToken(state, input.tokenId, 'jumpTo');
  requireCompletedTarget(state, input.to, 'jumpTo');
  const from = token.nodeId;

  return transform(state, (next) => {
    const t = next.tokens.find((x) => x.id === input.tokenId);
    if (t === undefined) return;
    t.nodeId = input.to;
    clearAssignment(t);
    next.completedNodes = next.completedNodes.filter((n) => n !== input.to);
    markCompleted(next, from);
  });
}

/**
 * `rollbackTo` —— 回滚到早先状态并**撤销下游**（拿回 / 撤销）。
 *
 * ★ 与 `jumpTo` 的差别就在"撤销下游"四字：
 *   ① `completedNodes` **截断**到 `to` 之前（`to` 及其之后完成的节点全部撤销）；
 *   ② 其它**在途**令牌全部 `cancelled`（INV-9 精神：不得留下残余在途令牌）。
 *   `jumpTo` 两条都不做 —— 驳回只是"回去重办"，拿回才是"这段不算"。
 */
export function rollbackTo(state: InstanceState, input: RollbackToInput): InstanceState {
  requireLiveInstance(state, 'rollbackTo');
  const token = requireLiveToken(state, input.tokenId, 'rollbackTo');
  const at = requireCompletedTarget(state, input.to, 'rollbackTo');

  return transform(state, (next) => {
    next.completedNodes = next.completedNodes.slice(0, at);
    for (const t of next.tokens) {
      if (t.id === input.tokenId) {
        t.nodeId = input.to;
        clearAssignment(t);
      } else if (isLive(t)) {
        // D-47：给了 branch 就只撤本分支；没给 = 单分支（全部撤，兼容既有行为）
        if (input.branch !== undefined && t.branch !== input.branch) continue;
        t.state = 'cancelled';
      }
    }
  });
}

/**
 * `spawnInstances` —— 同一节点上创建多个令牌实例（加签 / 会签展开）。
 *
 * ★ 令牌 id 由 `groupId` 确定性生成（`${groupId}#${i}`）—— 纯函数不能依赖随机数或全局计数器，
 *   否则同入参两次调用会得到不同结果（破 NFR-E6）。
 */
export function spawnInstances(state: InstanceState, input: SpawnInstancesInput): InstanceState {
  requireLiveInstance(state, 'spawnInstances');
  requireNonEmpty(input.nodeId, 'nodeId', 'spawnInstances');
  requireNonEmpty(input.groupId, 'groupId', 'spawnInstances');
  if (!Array.isArray(input.assignees) || input.assignees.length === 0) {
    // INV-13：解析为空集时不得产生 0 办待人却 active 的节点
    throw stateShapeInvalid("primitive 'spawnInstances' requires at least one assignee", {
      primitive: 'spawnInstances',
      nodeId: input.nodeId,
    });
  }

  return transform(state, (next) => {
    if (input.replaceTokenId !== undefined) {
      next.tokens = next.tokens.filter((t) => t.id !== input.replaceTokenId);
    }
    const grouped = input.grouped !== false;
    const created: Token[] = input.assignees.map((assignee, i) => ({
      id: `${input.groupId}#${i}`,
      nodeId: input.nodeId,
      state: 'active',
      assignee,
      ...(grouped ? { instanceGroup: input.groupId } : {}),
    }));
    next.tokens = [...next.tokens, ...created];
    // 该节点要重新办 → 摘掉它的已完成记录
    next.completedNodes = next.completedNodes.filter((n) => n !== input.nodeId);
  });
}

/**
 * `cancelInstances` —— 取消节点上的部分 / 全部实例（减签、或签的"其余取消"）。
 *
 * ★ **幂等**：范围内没有在途令牌时原样返回，不抛错 —— 汇聚取消常常已经无人可取消。
 *   但**范围本身必须是明确的**（至少给 `groupId` 或 `tokenIds` 之一）：
 *   什么都不给 = 「取消一切」，那是 `halt` 的语义，静默代劳会让缺陷查不出来。
 */
export function cancelInstances(state: InstanceState, input: CancelInstancesInput): InstanceState {
  requireLiveInstance(state, 'cancelInstances');
  const hasGroup = typeof input.groupId === 'string' && input.groupId.length > 0;
  const hasIds = Array.isArray(input.tokenIds) && input.tokenIds.length > 0;
  if (!hasGroup && !hasIds) {
    throw stateShapeInvalid(
      "primitive 'cancelInstances' requires groupId or tokenIds (use 'halt' to cancel everything)",
      { primitive: 'cancelInstances' },
    );
  }
  const ids = new Set(input.tokenIds ?? []);

  return transform(state, (next) => {
    for (const t of next.tokens) {
      const inGroup = hasGroup && t.instanceGroup === input.groupId;
      if (isLive(t) && (inGroup || ids.has(t.id))) t.state = 'cancelled';
    }
  });
}

/**
 * `transfer` —— 换办理人，**令牌位置不变**（转办）。
 *
 * ★ 与 `jumpTo` 的差别（`03` §170）：转办**不动令牌**，驳回**移动令牌**。
 *   与 `delegate` 的差别：转办**不留回归路径**（A 交给 B 就结束了）；委派留。
 */
export function transfer(state: InstanceState, input: TransferInput): InstanceState {
  requireLiveInstance(state, 'transfer');
  requireLiveToken(state, input.tokenId, 'transfer');
  requireNonEmpty(input.assignee, 'assignee', 'transfer');

  return transform(state, (next) => {
    const t = next.tokens.find((x) => x.id === input.tokenId);
    if (t === undefined) return;
    t.assignee = input.assignee;
  });
}

/**
 * `delegate` —— 委托并**保留回归路径**（委派：A → B → 回到 A）。
 *
 * 回归路径落在 `Token.returnTo`（= 委派前的 `assignee`）；B 办完后由上层依据它回到 A。
 * 委派前没有办理人时 `returnTo` 不设 —— 没有可回归的对象。
 */
export function delegate(state: InstanceState, input: DelegateInput): InstanceState {
  requireLiveInstance(state, 'delegate');
  const token = requireLiveToken(state, input.tokenId, 'delegate');
  requireNonEmpty(input.assignee, 'assignee', 'delegate');
  const previous = token.assignee;

  return transform(state, (next) => {
    const t = next.tokens.find((x) => x.id === input.tokenId);
    if (t === undefined) return;
    if (previous !== undefined) t.returnTo = previous;
    t.assignee = input.assignee;
  });
}

/**
 * `halt` —— 清空所有在途令牌（**终止，不可逆**），实例置 `terminated`。
 *
 * ★ 与 `suspend` 的差别（`03` §162）：`halt` 是**不可逆清场**（令牌全部 `cancelled`，流程消失）；
 *   `suspend` 是**可恢复冻结**（令牌原样保留，只是停走）。
 */
export function halt(state: InstanceState, _input: HaltInput = {}): InstanceState {
  if (isTerminalStatus(state.status)) {
    throw stateTerminal(state.instanceId, state.status, 'halt');
  }
  return transform(state, (next) => {
    for (const t of next.tokens) {
      if (isLive(t)) t.state = 'cancelled';
    }
    next.status = 'terminated';
  });
}

// ---------------- 实例级原语（2） ----------------

/**
 * `suspend` —— 实例级**冻结**：`status` 置 `suspended`，**令牌一律不动**（INV-5）。
 *
 * 已挂起时**幂等**返回原样（重复挂起不是错误）；终态则抛（终态不可再动）。
 */
export function suspend(state: InstanceState, _input: SuspendInput = {}): InstanceState {
  if (isTerminalStatus(state.status)) {
    throw stateTerminal(state.instanceId, state.status, 'suspend');
  }
  if (state.status === 'suspended') return transform(state, () => undefined);

  return transform(state, (next) => {
    next.status = 'suspended';
  });
}

/**
 * `resume` —— 解冻：`status` 回到 `running`，令牌从**原处**继续推进（位置不变）。
 *
 * ★ 它是 10 个原语里**唯一**能在 `suspended` 下受理的（`INV-5`）；
 *   用在非挂起实例上是误用 → 抛（不静默：静默会让"resume 了个没挂起的实例"变成无声 no-op）。
 */
export function resume(state: InstanceState, _input: ResumeInput = {}): InstanceState {
  if (isTerminalStatus(state.status)) {
    throw stateTerminal(state.instanceId, state.status, 'resume');
  }
  if (state.status !== 'suspended') {
    throw stateShapeInvalid(
      `primitive 'resume' requires a suspended instance, got '${state.status}'`,
      { primitive: 'resume', status: state.status },
    );
  }
  return transform(state, (next) => {
    next.status = 'running';
  });
}

// ---------------- 编译期锁 ----------------

/**
 * 「10 个原语」的类型层落点：少实现一个 / 名字写错，这里立刻红。
 * 与 `SPI_NAMES` 的 `_spiNamesExhaustive` 同款思路。
 */
export const primitives: Primitives = {
  advance,
  jumpTo,
  rollbackTo,
  spawnInstances,
  cancelInstances,
  transfer,
  delegate,
  halt,
  suspend,
  resume,
};

/** 分组扁平化后必须与 `PRIMITIVE_NAMES` 逐项一致（顺序也算契约） */
export const _primitiveNamesExhaustive: Record<PrimitiveName, true> = {
  advance: true,
  jumpTo: true,
  rollbackTo: true,
  spawnInstances: true,
  cancelInstances: true,
  transfer: true,
  delegate: true,
  halt: true,
  suspend: true,
  resume: true,
};
