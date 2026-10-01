/**
 * @floken-io/engine · 核心数据模型：`InstanceState`（**分两层**）
 *
 * 契约来源：`ARCHITECTURE.md` §6.1 / §6.4（INV-1/3/4/5/14/18）/ §6.5。
 *
 * 三条硬约束（改这里之前先读）：
 *  1. **属性名逐字为契约**，跨模块传参不得改名（`AGENTS.md` 防静默 Bug 铁律 1）。
 *  2. **纯数据**：不得出现函数 / `Map` / `Set` / 类实例 / `undefined` 值键 / 非有限数字
 *     —— 否则内存模式与 DB 模式的行为会分叉，而这类 bug **只在切库时才爆**（`AC-E8`）。
 *  3. **分层准入判据**：Header 的字段必须是「**宿主会为它建列 / 建索引**，且**引擎一定知道**」。
 *     **禁止线**：不得出现 `tableName` / `schema` / `driver` / `dialect` / `connection`
 *     这类「存储实现配置」—— 一旦出现，`StateStore` 就退化成 ORM。
 */
import { stateSchemaUnsupported, stateShapeInvalid } from './errors.js';

/** 当前快照结构版本。新增字段破坏兼容时 +1，并**必须**在 `STATE_MIGRATIONS` 登记迁移。 */
export const STATE_SCHEMA_VERSION = 1;

// ---------------- 枚举（值表与类型同源，禁止两处手写） ----------------

export type InstanceStatus = 'running' | 'suspended' | 'completed' | 'terminated' | 'cancelled';

export const INSTANCE_STATUSES = [
  'running',
  'suspended',
  'completed',
  'terminated',
  'cancelled',
] as const satisfies readonly InstanceStatus[];

/** 终态三值：进入后 `submit()` / `deliver*()` **必须抛错**（INV-2） */
export const TERMINAL_STATUSES = [
  'completed',
  'terminated',
  'cancelled',
] as const satisfies readonly InstanceStatus[];

export function isTerminalStatus(status: InstanceStatus): boolean {
  return (TERMINAL_STATUSES as readonly InstanceStatus[]).includes(status);
}

export type TokenState = 'active' | 'waiting' | 'completed' | 'cancelled';

export const TOKEN_STATES = [
  'active',
  'waiting',
  'completed',
  'cancelled',
] as const satisfies readonly TokenState[];

/**
 * ★ 令牌在汇聚组里的**表态**（T13）。
 *
 * 为什么必须单开一个字段、而不是从 `state` 推：
 *   `state` 只有四值，而「投了通过」与「投了驳回」在生命周期上是**同一件事**（都办完了），
 *   在语义上是**两件事**。若用 `completed` / `cancelled` 兼表，那么「或签里被取消的那个人」
 *   与「投了驳回的那个人」将不可区分 —— 事后审计答不出「谁驳回的」。
 *
 * ⇒ `state` 管**在不在途**，`vote` 管**投了什么**，两者正交。
 *   投票后令牌一律 `state:'completed'`（他的办理结束了），方向记在本字段。
 */
export type VoteOutcome = 'approved' | 'rejected';

export const VOTE_OUTCOMES = ['approved', 'rejected'] as const satisfies readonly VoteOutcome[];

// ---------------- 体：引擎内部结构（宿主当不透明 JSON，不解包） ----------------

export interface Token {
  id: string;
  nodeId: string;
  state: TokenState;
  /** 分配层（`ApproverSource`）解析后落地的结果 */
  assignee?: string;
  /** 同节点多实例归组 —— 会签 / 票签的汇聚单元 */
  instanceGroup?: string;
  /** 委派（delegate）时的回归目标 */
  returnTo?: string;
  /**
   * 汇聚组内的表态（T13）。**只在组内投票后才有值**；被取消 / 未表态的令牌没有它。
   * 组解散（`instanceGroup` 被摘）后本字段**保留** —— 它是审计事实，不是组状态。
   */
  vote?: VoteOutcome;
  /**
   * ★ 落到等待节点（成为一条待办）的时刻 —— `TaskView.createdAt` 由它派生。
   *
   * 为什么必须落在令牌上而不是"取 `state.startedAt` 兜底"：
   * 待办的创建时刻是**这条待办自己的事实**，加签 / 驳回重办产生的新待办各有各的时刻；
   * 拿实例启动时刻顶替会让「这条待办挂了多久」永远算错（超时判定的输入）。
   *
   * 可选：由 `runtime/loop.ts` 在令牌首次落到等待节点时填（`primitives.ts` 是纯函数、没有时间源，故不填）。
   */
  createdAt?: string;
  /**
   * ★ **并行分支标记**（T16 · D-47 的落点）。
   *
   * 网关分叉时写入：同一网关**同一批**分裂出的令牌及其后代共享一个 `branch` 值。
   * 汇聚合流后**清除**（合流点之后又回到单干）。
   *
   * 为什么需要它：`rollbackTo`（拿回 / 撤销）的语义是「撤销下游」，
   *   而"下游"在并行分支下必须**收缩到本分支** —— 否则 A 分支上点一次"撤销"，
   *   会把 B 分支上毫不相干的在途待办一起取消（**D-47** 记录的那处误伤）。
   *
   * ⚠️ 它与 `instanceGroup` 正交：`instanceGroup` 是"**同一节点上的多个人**"（会签 / 或签），
   *   `branch` 是"**同一条并行分支**"。一个会签节点整体处在某条分支上，
   *   故组内令牌的 `branch` 相同、而 `instanceGroup` 各异。
   *
   * ⚠️ 无分支（单干）的令牌**不写本字段**：此时"撤销下游"= 撤销全部在途，
   *   与 T15 之前的既有行为一致（向后兼容，不需要迁移）。
   */
  branch?: string;
}

/**
 * 审计条目 —— **合规主源**（`AGENTS.md` §6 / `03-engine` §9.1 Plan A）。
 * 由内核在每次状态变更时生成，随状态被 `StateStore` **整块持久化**；
 * ⚠️ 与「变量快照」不同源：这里记**谁做了什么**，变量快照记**数据怎么变**。
 */
export interface AuditEntry {
  /** 严格递增、无空洞（INV-4） */
  seq: number;
  at: string;
  /** 19 项动作名 或 内核原语名 */
  actor: string;
  action: string;
  nodeId?: string;
  tokenId?: string;
  /** 前后状态 */
  from?: string;
  to?: string;
  /** 意见、表单增量等 */
  payload?: Record<string, unknown>;
}

/**
 * 动作事实记录。
 * ★ **同源**：一份进 `InstanceState.lastAction`（给 store 填审计列），
 * 一份进 `TaskDelta.action`（给投影路由）—— 两处不得各造一份。
 */
export interface ActionRecord {
  /** 19 项动作名之一 */
  name: string;
  nodeId?: string;
  tokenId?: string;
  actor: string;
  at: string;
  comment?: string;
}

// ---------------- 头：扁平、稳定 —— 宿主为它建列 / 建索引 / 分片路由 / 填审计列 ----------------

export interface InstanceStateHeader {
  /** 引擎生成、全局唯一（带前缀）；`load(id)` 单参即可定位 */
  instanceId: string;
  processId: string;
  /** ★ 实例绑定定义版本：改版不影响在途（`AC-E10`） */
  definitionVersion: number;
  /** 关联宿主业务行（`start()` 传入） */
  businessKey?: string;
  /** 多租户分片 */
  tenantId?: string;
  /** 宿主靠它做归档路由（终态 → 历史表），不用解 JSON */
  status: InstanceStatus;
  /** CAS 版本；**`0` = 尚未落库 = INSERT 信号**（写死，宿主据此分两条路径） */
  rev: number;
  /** 快照结构版本，供迁移（≠ moddle 的 `schemaVersion`） */
  stateSchema: number;
  /** 审计列 `updated_by` / `last_action` 直接取，不用挖数组 */
  lastAction?: ActionRecord;
  /** ★ 投影未追平的 rev（INV-18）；补做完成后**必须删除该键** */
  pendingProjectionRev?: number;
  startedAt: string;
  updatedAt: string;
  /** 终态时间，归档表要这个 */
  endedAt?: string;
}

// ---------------- 体 ----------------

/**
 * ★ `CallActivity` 子实例指回父实例的指针（T18）。
 *
 * 只带**定位用的三元组**，不带状态副本：子实例结束时要靠它把父实例里那条
 * 停在 `callActivity` 上的令牌唤醒，而"父实例现在什么样"必须**现读**（读快照、CAS 写），
 * 缓存一份下来就是典型的脏读。
 *
 * ⚠️ 与 `childInstanceIds` 是**两个方向**的记录：父记"我起了哪些子实例"（终止时要连坐），
 *   子记"我该回哪里去"（结束时要唤醒）。缺任何一条，父子之间就会断。
 */
export interface InstanceParent {
  readonly instanceId: string;
  /** 父实例上那个 `callActivity` 节点 */
  readonly nodeId: string;
  /** 父实例上停在那个节点的令牌（**令牌 id 在实例内唯一**，故它是可靠的定位键） */
  readonly tokenId: string;
}

/**
 * 实例状态 —— **分两层**（§6.1）。
 *
 * ⚠️ 本接口是 `Header` 与 `Body` 的交叉类型，字段**不分组**存放；
 * 取 Header 用 `headerOf()`（逐字段列举，绝不用 rest 解构）。
 */
export interface InstanceStateBody {
  /** 引擎内部结构，宿主当不透明 JSON */
  tokens: Token[];
  /** 驳回目标只能从这里选（INV-6） */
  completedNodes: string[];
  variables: Record<string, unknown>;
  /** ★ 合规主源：任何状态变更都追加一条 */
  auditTrail: AuditEntry[];
  /**
   * 发起人（`start()` 传入）。
   *
   * ★ 为什么必须落在状态里而不是"从 `auditTrail[0].actor` 反推"：`ApproverCtx.starter`
   *   是**已发布的 SPI 契约**（`{type:'deptLeader', of:'starter'}` 全靠它解析），
   *   而 `auditTrail` 会被 `maxAuditEntries` 裁剪（INV-17）—— 用一条**可能被裁掉的**记录
   *   去支撑一个**永久需要**的契约，是典型的"省一个字段、埋一个偶发 bug"。
   *   ⚠️ `03` §9.1 尚未列出本字段 → 见 `ARCHITECTURE.md` **D-25**（待回写）。
   */
  starter?: string;
  /** `CallActivity` 子实例（不新增接口） */
  childInstanceIds?: string[];
  /** ★ 本实例是某个 `CallActivity` 的子实例时的回归指针；父实例**没有**本字段 */
  parent?: InstanceParent;
}

export type InstanceState = InstanceStateHeader & InstanceStateBody;

/**
 * 抽 Header（§6.1 两层：Header 给宿主建列，Body 是引擎的不透明 JSON）。
 *
 * ★ 逐字段显式列举，不用 rest 解构 —— `InstanceState` 是交叉类型，rest 会把 Body 字段一起带出去。
 */
export function headerOf(s: InstanceState): InstanceStateHeader {
  const h: InstanceStateHeader = {
    instanceId: s.instanceId,
    processId: s.processId,
    definitionVersion: s.definitionVersion,
    status: s.status,
    rev: s.rev,
    stateSchema: s.stateSchema,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
  };
  if (s.businessKey !== undefined) h.businessKey = s.businessKey;
  if (s.tenantId !== undefined) h.tenantId = s.tenantId;
  if (s.lastAction !== undefined) h.lastAction = s.lastAction;
  if (s.pendingProjectionRev !== undefined) h.pendingProjectionRev = s.pendingProjectionRev;
  if (s.endedAt !== undefined) h.endedAt = s.endedAt;
  return h;
}

// ---------------- ★ 序列化守卫（AC-E8 / INV-14） ----------------

export type NonSerializableKind =
  | 'undefined'
  | 'function'
  | 'symbol'
  | 'symbol-key'
  | 'bigint'
  | 'non-finite-number'
  | 'map'
  | 'set'
  | 'date'
  | 'class-instance'
  | 'circular';

export interface NonSerializable {
  path: string;
  kind: NonSerializableKind;
  detail?: string;
}

function findNonSerializable(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): NonSerializable | null {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return null;
    case 'number':
      return Number.isFinite(value)
        ? null
        : { path, kind: 'non-finite-number', detail: String(value) };
    case 'undefined':
      // JSON 会把这个键整个丢掉 → `JSON.parse(JSON.stringify(x))` 不再深等（INV-14）
      return { path, kind: 'undefined' };
    case 'bigint':
      return { path, kind: 'bigint', detail: `${value}n` };
    case 'symbol':
      return { path, kind: 'symbol', detail: value.description ?? '' };
    case 'function':
      return { path, kind: 'function', detail: value.name || '(anonymous)' };
    case 'object':
      break;
    default:
      return { path, kind: 'class-instance', detail: typeof value };
  }
  if (value === null) return null;

  const obj = value as object;
  // 只拦「祖先链上重复」= 真环；DAG（同一对象被两处引用）合法，JSON 会复制一份
  if (ancestors.has(obj)) return { path, kind: 'circular' };
  if (obj instanceof Map) return { path, kind: 'map' };
  if (obj instanceof Set) return { path, kind: 'set' };
  if (obj instanceof Date) return { path, kind: 'date', detail: obj.toISOString() };

  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i += 1) {
        const bad = findNonSerializable(obj[i], `${path}[${i}]`, ancestors);
        if (bad) return bad;
      }
      return null;
    }

    const proto = Object.getPrototypeOf(obj) as object | null;
    if (proto !== Object.prototype && proto !== null) {
      const ctor = (obj as { constructor?: { name?: string } }).constructor?.name ?? 'Object';
      return { path, kind: 'class-instance', detail: ctor };
    }

    const syms = Object.getOwnPropertySymbols(obj);
    if (syms.length > 0) {
      return { path, kind: 'symbol-key', detail: String(syms[0]) };
    }

    for (const [key, v] of Object.entries(obj)) {
      const bad = findNonSerializable(v, `${path}.${key}`, ancestors);
      if (bad) return bad;
    }
    return null;
  } finally {
    ancestors.delete(obj);
  }
}

/** 定位第一个「非纯数据」的值；全部合格返回 `null` */
export function findNonSerializableValue(value: unknown, path = '$'): NonSerializable | null {
  return findNonSerializable(value, path, new Set<object>());
}

export function isSerializable(value: unknown): boolean {
  return findNonSerializableValue(value) === null;
}

/** 断言「纯数据」；不合格抛 `ENGINE_STATE_SHAPE_INVALID` */
export function assertSerializable(value: unknown, path = '$'): void {
  const bad = findNonSerializableValue(value, path);
  if (!bad) return;
  throw stateShapeInvalid(`non-serializable ${bad.kind} at ${bad.path}`, {
    path: bad.path,
    kind: bad.kind,
    ...(bad.detail === undefined ? {} : { detail: bad.detail }),
  });
}

/** JSON 深拷贝（同时充当一次序列化体检） */
export function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 深等判据 **就是** `JSON.stringify` 口径 —— INV-14 要求的正是这一条 */
export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** INV-14：序列化往返后必须与原值深等 */
export function assertRoundTrip<T>(value: T, path = '$'): void {
  assertSerializable(value, path);
  const cloned = cloneState(value);
  if (!deepEqual(value, cloned)) {
    throw stateShapeInvalid('state is not JSON round-trip stable', { path });
  }
}

// ---------------- 结构断言 ----------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * `InstanceState` 的结构体检。
 * ⚠️ 这是**开发期守卫**（关键路径可开），不是业务校验 —— 业务校验归 `actions/gates.ts`。
 */
export function assertInstanceState(state: InstanceState, path = '$'): void {
  assertSerializable(state, path);
  /*
   * ★ 必须给**变量**带显式类型标注（而不是只写在箭头函数上）：
   * TS 只对「带类型标注的标识符调用」启用 never 收窄，否则下面 `if (...) fail(...)`
   * 之后的 `t` / `e` 不会被收窄（`noUncheckedIndexedAccess` 下仍是 `T | undefined`）。
   */
  const fail: (reason: string, details?: Record<string, unknown>) => never = (
    reason,
    details = {},
  ) => {
    throw stateShapeInvalid(reason, { path, ...details });
  };

  if (!isNonEmptyString(state.instanceId)) fail('instanceId must be a non-empty string');
  if (!isNonEmptyString(state.processId)) fail('processId must be a non-empty string');
  if (!Number.isInteger(state.definitionVersion) || state.definitionVersion < 1) {
    fail('definitionVersion must be a positive integer', { value: state.definitionVersion });
  }
  if (!(INSTANCE_STATUSES as readonly string[]).includes(state.status)) {
    fail('status is not one of the five values', { value: state.status });
  }
  // rev === 0 是合法且重要的：它是 INSERT 信号
  if (!isNonNegativeInt(state.rev)) fail('rev must be a non-negative integer', { value: state.rev });
  if (!Number.isInteger(state.stateSchema) || state.stateSchema < 1) {
    fail('stateSchema must be a positive integer', { value: state.stateSchema });
  }
  if (!isNonEmptyString(state.startedAt)) fail('startedAt must be a non-empty string');
  if (!isNonEmptyString(state.updatedAt)) fail('updatedAt must be a non-empty string');
  if (state.endedAt !== undefined && !isNonEmptyString(state.endedAt)) {
    fail('endedAt must be a non-empty string when present');
  }
  if (state.pendingProjectionRev !== undefined && !isNonNegativeInt(state.pendingProjectionRev)) {
    fail('pendingProjectionRev must be a non-negative integer when present');
  }

  if (!Array.isArray(state.tokens)) fail('tokens must be an array');
  for (let i = 0; i < state.tokens.length; i += 1) {
    const t = state.tokens[i];
    if (!t || !isNonEmptyString(t.id)) fail(`tokens[${i}].id must be a non-empty string`);
    if (!isNonEmptyString(t.nodeId)) fail(`tokens[${i}].nodeId must be a non-empty string`);
    if (!(TOKEN_STATES as readonly string[]).includes(t.state)) {
      fail(`tokens[${i}].state is not one of the four values`, { value: t.state });
    }
    if (t.vote !== undefined && !(VOTE_OUTCOMES as readonly string[]).includes(t.vote)) {
      fail(`tokens[${i}].vote must be 'approved' or 'rejected' when present`, { value: t.vote });
    }
    if (t.branch !== undefined && !isNonEmptyString(t.branch)) {
      fail(`tokens[${i}].branch must be a non-empty string when present`, { value: t.branch });
    }
  }

  if (!Array.isArray(state.completedNodes)) fail('completedNodes must be an array');
  for (let i = 0; i < state.completedNodes.length; i += 1) {
    if (!isNonEmptyString(state.completedNodes[i])) {
      fail(`completedNodes[${i}] must be a non-empty string`);
    }
  }

  if (state.childInstanceIds !== undefined) {
    if (!Array.isArray(state.childInstanceIds)) fail('childInstanceIds must be an array when present');
    for (let i = 0; i < state.childInstanceIds.length; i += 1) {
      if (!isNonEmptyString(state.childInstanceIds[i])) {
        fail(`childInstanceIds[${i}] must be a non-empty string`);
      }
    }
  }

  const p = state.parent;
  if (p !== undefined) {
    if (p === null || typeof p !== 'object') fail('parent must be an object when present');
    if (!isNonEmptyString(p.instanceId)) fail('parent.instanceId must be a non-empty string');
    if (!isNonEmptyString(p.nodeId)) fail('parent.nodeId must be a non-empty string');
    if (!isNonEmptyString(p.tokenId)) fail('parent.tokenId must be a non-empty string');
  }

  if (!isPlainObject(state.variables)) fail('variables must be a plain object');

  if (!Array.isArray(state.auditTrail)) fail('auditTrail must be an array');
  for (let i = 0; i < state.auditTrail.length; i += 1) {
    const e = state.auditTrail[i];
    if (!e || !Number.isInteger(e.seq) || e.seq < 1) {
      fail(`auditTrail[${i}].seq must be a positive integer`);
    }
    // INV-4：严格递增、无空洞
    if (i > 0) {
      const prev = state.auditTrail[i - 1];
      if (prev && e && e.seq !== prev.seq + 1) {
        fail('auditTrail.seq must be strictly increasing without gaps', {
          index: i,
          previous: prev.seq,
          current: e.seq,
        });
      }
    }
    if (!isNonEmptyString(e?.at)) fail(`auditTrail[${i}].at must be a non-empty string`);
    if (!isNonEmptyString(e?.actor)) fail(`auditTrail[${i}].actor must be a non-empty string`);
    if (!isNonEmptyString(e?.action)) fail(`auditTrail[${i}].action must be a non-empty string`);
  }
}

// ---------------- `stateSchema` 迁移 ----------------

export interface StateMigration {
  /** 源版本；迁移必须产出 `from + 1` 版本 */
  from: number;
  migrate(state: InstanceState): InstanceState;
}

/**
 * 迁移表。**v1 是首版，故为空**。
 * 新增 v1→v2 时在此追加 `{ from: 1, migrate }`；`migrate` 必须是纯函数且只升版本。
 */
export const STATE_MIGRATIONS: readonly StateMigration[] = [];

/**
 * 把快照升到目标结构版本。
 * 只升不降：目标低于快照版本、或中间缺迁移函数 → 抛 `ENGINE_STATE_SCHEMA_UNSUPPORTED`。
 *
 * `migrations` 可注入：生产走 `STATE_MIGRATIONS`，测试用它验证升级/降级/跳号三条路径。
 */
export function migrateState(
  state: InstanceState,
  to: number = STATE_SCHEMA_VERSION,
  migrations: readonly StateMigration[] = STATE_MIGRATIONS,
): InstanceState {
  let current = state;
  while (current.stateSchema < to) {
    const step = migrations.find((m) => m.from === current.stateSchema);
    if (!step) {
      throw stateSchemaUnsupported(current.stateSchema, to, migrations.map((m) => m.from));
    }
    const next = step.migrate(current);
    if (next.stateSchema !== step.from + 1) {
      throw stateShapeInvalid('state migration must bump stateSchema by exactly one', {
        from: step.from,
        produced: next.stateSchema,
      });
    }
    current = next;
  }
  if (current.stateSchema > to) {
    throw stateSchemaUnsupported(current.stateSchema, to, migrations.map((m) => m.from));
  }
  return current;
}
