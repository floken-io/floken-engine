/**
 * @floken-io/engine · 错误与诊断契约（engine 侧实现）
 *
 * 五包通用的错误处理契约见仓库根 `AGENTS.md` §5「错误处理契约」。本档落实 engine 这一侧：
 *
 * 1. **两条通道不许混**：`EngineError` 系（抛出，调用方无法继续） vs `Diagnostic`（随结果返回，可继续）。
 *    口诀：「重试也救不回来」→ 抛；「换个输入还有救」→ 诊断。
 * 2. **结构契约，不共享基类**：五包各自独立仓，**禁止跨包 import 错误基类**；
 *    改为逐字约定字段形状（`name` / `code` / `pkg` / `node` / `instanceId` / `hint` / `details`）。
 * 3. **错误码是稳定契约**：一旦发布不得改名（性质同 XML 前缀），只能新增。
 *    命名规则 `<域>_<类别>_<对象>`，全大写蛇形，域 = `ENGINE`（本包短名）。
 * 4. **message 面向人、不含易变数据**：计数 / id / 名字一律进 `details`，否则宿主断言会碎。
 *
 * 参考实现：`项目文件/floken-feel/src/core/errors.ts`（形状逐字对齐，基类各自实现）。
 */

/**
 * 模型定位：engine / moddle / dmn 用（`path` 形如 `a.b[0].c`）。
 * engine 侧另附 `EngineError.instanceId`（`AGENTS.md` §5.4 定位双轨）。
 */
export interface NodeRef {
  id?: string;
  path?: string;
}

// ---------------- 错误码 ----------------

/**
 * 抛出类错误的码表（`EngineError` 家族）。
 *
 * ★ 类别只允许五个：`ACTION_`（动作受理）/ `STATE_`（实例状态与不变量）/
 * `PERSIST_`（StateStore 写入冲突）/ `OPTION_`（createEngine 配置）/
 * `PEER_`（**peer 依赖缺失**，Q49 新增 —— 五个包之间一律 peer 后，缺失在运行期才暴露）。
 */
export const ENGINE_ERROR_CODES = {
  // —— 动作层：19 项动作的受理、开关、目标与意见校验 ——
  /** 动作名不在 19 项之内 */
  ACTION_UNKNOWN: 'ENGINE_ACTION_UNKNOWN',
  /** 设计期开关未开启（`approval.X.allowed === false`，DV-2） */
  ACTION_NOT_ALLOWED: 'ENGINE_ACTION_NOT_ALLOWED',
  /**
   * 门 1 `beforeAction` 返回 `false` 否决了本次动作（T12）。
   *
   * ★ 与 `ACTION_NOT_ALLOWED` 的区别：后者是**设计期**开关（读定义就知道），
   *   本码是**运行期**宿主否决（只有跑起来才知道）。合成一个码的话，宿主分不清
   *   「按钮本来就不该显示」与「业务条件不满足」—— 前者是前端 bug，后者要提示用户。
   * ⚠️ 否决**必须**抛错：静默返回空差分会让用户以为办完了（红线：不得静默无效果）。
   */
  ACTION_VETOED: 'ENGINE_ACTION_VETOED',
  /** 驳回 / 退回目标非法（INV-6：须同时满足 ∈ `completedNodes` 且 ∈ `allowedTargets`） */
  ACTION_TARGET_INVALID: 'ENGINE_ACTION_TARGET_INVALID',
  /** `requireComment` 为 true 但未填意见（DV-3） */
  ACTION_COMMENT_REQUIRED: 'ENGINE_ACTION_COMMENT_REQUIRED',
  /** 审批人解析为空集且 `onEmpty === 'error'`（INV-13，不得产生 0 办待人的 active 节点） */
  ACTION_APPROVER_EMPTY: 'ENGINE_ACTION_APPROVER_EMPTY',
  /** 加签超出设计期 `addSign.maxCount`（INV-12） */
  ACTION_ADD_SIGN_LIMIT: 'ENGINE_ACTION_ADD_SIGN_LIMIT',
  /** 票签配置非法（INV-7：`mode:'vote'` ⟺ `vote` 存在，且 `count` / `threshold` 恰有其一） */
  ACTION_VOTE_CONFIG: 'ENGINE_ACTION_VOTE_CONFIG',

  // —— 状态层：实例定位、生命周期、结构不变量 ——
  /** `StateStore.load()` 返回 null */
  STATE_NOT_FOUND: 'ENGINE_STATE_NOT_FOUND',
  /** 实例已终态（completed / terminated / cancelled）后仍尝试推进（INV-2） */
  STATE_TERMINAL: 'ENGINE_STATE_TERMINAL',
  /** 实例处于 suspended，除 `resume` 外一律不受理（INV-5） */
  STATE_SUSPENDED: 'ENGINE_STATE_SUSPENDED',
  /** 状态结构不合契约（含 AC-E8 / INV-14：出现函数 / Map / Set / 类实例） */
  STATE_SHAPE_INVALID: 'ENGINE_STATE_SHAPE_INVALID',
  /** `tokens[].nodeId` 不在该实例**绑定版本**的定义图中（INV-3，不得静默忽略） */
  STATE_TOKEN_ORPHAN: 'ENGINE_STATE_TOKEN_ORPHAN',
  /** `DefinitionSource.getDefinition()` 返回 null（AC-E10 要求按实例绑定版本取定义） */
  STATE_DEFINITION_MISSING: 'ENGINE_STATE_DEFINITION_MISSING',
  /** 快照结构版本无迁移路径（`stateSchema` 只升不降；升级须登记迁移函数） */
  STATE_SCHEMA_UNSUPPORTED: 'ENGINE_STATE_SCHEMA_UNSUPPORTED',

  // —— 持久层：StateStore 的 INSERT / CAS 两条路径 ——
  /** CAS UPDATE 影响 0 行：`expectedRev` 与库中当前 rev 不符（INV-1） */
  PERSIST_CONFLICT: 'ENGINE_PERSIST_CONFLICT',
  /** INSERT 冲突：`expectedRev === 0` 但该 `instanceId` 已存在 */
  PERSIST_ALREADY_EXISTS: 'ENGINE_PERSIST_ALREADY_EXISTS',

  // —— 选项层：createEngine 配置 ——
  /** 未知配置项（**禁止静默忽略**，与 feel 的 `FEEL_OPTION_UNKNOWN` 同口径） */
  OPTION_UNKNOWN: 'ENGINE_OPTION_UNKNOWN',
  /** 配置项取值非法（如 `maxAuditEntries` 非正整数） */
  OPTION_INVALID: 'ENGINE_OPTION_INVALID',

  // —— 依赖层：peer 依赖（Q49：五个包之间一律 peer，不再内置）——
  /**
   * peer 包未安装且当前操作需要它（`core/peer.ts` 的 `requirePeer()` 抛出）。
   *
   * ★ 与 `STATE_DEFINITION_MISSING` 之类别混：后者是**数据**缺失（流程定义取不到），
   *   本码是**代码**缺失（`node_modules` 里没有那个包），照 `details.install` 装完即解决。
   */
  PEER_MISSING: 'ENGINE_PEER_MISSING',
} as const;

/**
 * 诊断码表（**不抛**，随结果返回）。
 *
 * ★ 命名空间隔离规则：诊断码**不得使用抛出码的四个类别**
 * （`ACTION_` / `STATE_` / `PERSIST_` / `OPTION_`）—— 由 `test/errors.test.ts` 的
 * 「双命名空间不重叠」断言守（`AGENTS.md` §5.3 两条硬约束之二）。
 *
 * engine 产生诊断的场合只有「**已经发生、流程可以继续、但宿主应当知道**」的观测；
 * 上游（`@floken-io/feel` 求值降级 / `@floken-io/moddle` 校验）的诊断**原样透传、不重新包装**。
 */
export const ENGINE_DIAGNOSTIC_CODES = {
  /** INV-18：`pendingProjectionRev` 存在 —— 该 rev 的投影尚未追平，`load()` 会先 `sync()` 补做 */
  EFFECT_PENDING: 'ENGINE_EFFECT_PENDING',
  /** INV-17：`auditTrail` 达 `maxAuditEntries` 上限已裁剪；溢出区间记在 `details.dropped*`，**未静默丢弃**
   *  ⚠️ engine **不**把溢出条目投 `EventSink`：事件集由 ADR-006 定死为 10 个，审计不走事件通道
   *  （审计主源是 `auditTrail` 本身；被裁掉的部分宿主应从 `diagnostics` 转存到自己的归档） */
  AUDIT_TRUNCATED: 'ENGINE_AUDIT_TRUNCATED',
} as const;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[keyof typeof ENGINE_ERROR_CODES];

export type EngineDiagnosticCode =
  (typeof ENGINE_DIAGNOSTIC_CODES)[keyof typeof ENGINE_DIAGNOSTIC_CODES];

// ---------------- 诊断通道（不抛，随结果返回） ----------------

/**
 * 诊断的严重级别（与 `@floken-io/feel` / `@floken-io/dmn` 的 `Diagnostic` 同口径）。
 *
 * engine 侧目前只用 `warn`（**已发生、流程继续、但宿主应当知道**）；
 * `error` / `info` 保留给后续可能的设计期校验与观测类诊断。
 */
export type EngineSeverity = 'error' | 'warn' | 'info';

/**
 * 诊断条目。
 *
 * ★ 与兄弟包 `Diagnostic` 的两处**刻意差异**：
 *   ① 无 `start` / `end` —— 那是**源码文本**偏移，engine 处理的是对象树，没有文本可指；
 *   ② 定位改用 `node?: NodeRef` + `instanceId?`（`AGENTS.md` §5.4 的「定位双轨」）。
 */
export interface EngineDiagnostic {
  severity: EngineSeverity;
  code: string;
  message: string;
  node?: NodeRef;
  instanceId?: string;
  details?: Record<string, unknown>;
}

export interface EngineDiagnosticInit {
  code: EngineDiagnosticCode | (string & {});
  message: string;
  severity?: EngineSeverity;
  node?: NodeRef;
  instanceId?: string;
  details?: Record<string, unknown>;
}

/**
 * 构造一条诊断（缺省 `severity: 'warn'`）。
 *
 * ⚠️ 可选字段一律**条件展开**（开了 `exactOptionalPropertyTypes`，显式赋 `undefined` 不合法），
 * 且诊断必须保持**纯数据**（会随 `PlanResult` 一起进 JSON 序列化）。
 */
export function engineDiagnostic(init: EngineDiagnosticInit): EngineDiagnostic {
  const out: EngineDiagnostic = {
    severity: init.severity ?? 'warn',
    code: init.code,
    message: init.message,
  };
  if (init.node !== undefined) out.node = init.node;
  if (init.instanceId !== undefined) out.instanceId = init.instanceId;
  if (init.details !== undefined) out.details = init.details;
  return out;
}

// ---------------- 抛出类错误 ----------------

export interface EngineErrorInit {
  code: string;
  /** 模型定位（定义图中的元素 / 路径） */
  node?: NodeRef;
  /** engine 专属定位：出问题的流程实例 */
  instanceId?: string;
  /** 一句修复提示（人读；照着做就能解决） */
  hint?: string;
  /** 结构化补充：计数、名字、合法取值等**可断言**的数据都放这里 */
  details?: Record<string, unknown>;
}

/**
 * engine 错误基类。
 * ⚠️ 本类**不出现在任何跨包依赖里**：其余四包各有自己的基类，只保证字段形状一致。
 */
export class EngineError extends Error {
  /** 五包统一印记：宿主可据此判断「这是 floken 的结构化错误」 */
  readonly floken = true;
  readonly pkg = 'engine';
  readonly code: string;
  /*
   * 可选字段一律用 `declare`：**不生成实例字段**，于是未赋值时不会留下
   * `instanceId: undefined` 这种键（`JSON.stringify` / `Object.keys` 保持干净）。
   */
  declare readonly node?: NodeRef;
  declare readonly instanceId?: string;
  declare readonly hint?: string;
  declare readonly details?: Record<string, unknown>;

  constructor(message: string, init: EngineErrorInit) {
    super(message);
    this.name = new.target.name;
    this.code = init.code;
    if (init.node) this.node = init.node;
    if (init.instanceId) this.instanceId = init.instanceId;
    if (init.hint) this.hint = init.hint;
    if (init.details) this.details = init.details;
  }
}

/** 动作层：19 项动作的受理被拒（未开启 / 未知 / 目标非法 / 意见缺失 / 加签超限 …） */
export class EngineActionError extends EngineError {}

/** 状态层：实例定位失败、生命周期冲突、结构不变量被破坏 */
export class EngineStateError extends EngineError {}

/** 持久层：`StateStore.save()` 的 INSERT 或 CAS 冲突 */
export class EnginePersistError extends EngineError {}

/** 选项层：`createEngine()` 的配置非法（**禁止静默忽略**） */
export class EngineOptionError extends EngineError {}

// ---------------- 工厂（动作层） ----------------

/** 未知动作名：必须列出合法取值，宿主才能照修（`AGENTS.md` §5.4） */
export function actionUnknown(name: string, allowed: readonly string[]): EngineActionError {
  return new EngineActionError(`Unknown action '${name}'`, {
    code: ENGINE_ERROR_CODES.ACTION_UNKNOWN,
    hint: '动作名必须是 19 项之一；合法取值见 details.allowed',
    details: { action: name, allowed: [...allowed] },
  });
}

/** 动作未在设计期开启（DV-2：禁止静默忽略） */
export function actionNotAllowed(name: string, allowed: readonly string[]): EngineActionError {
  return new EngineActionError(`Action '${name}' is not enabled for this node`, {
    code: ENGINE_ERROR_CODES.ACTION_NOT_ALLOWED,
    hint: '在流程定义的 approval 配置中打开该开关，或改用已开启的动作',
    details: { action: name, allowed: [...allowed] },
  });
}

/**
 * 门 1 `beforeAction` 否决（T12）。
 *
 * ⚠️ 宿主**应当自己抛带原因的错误**（`beforeAction` 里 `throw new Error('预算已冻结')`）——
 *    那条错误会原样冒泡给调用方，UI 才能显示原因。本工厂只服务 `return false` 这种
 *    「懒得造错误」的写法，代价就是拿不到原因。
 */
export function actionVetoed(action: string, instanceId: string): EngineActionError {
  return new EngineActionError(`Action '${action}' was vetoed by hooks.beforeAction`, {
    code: ENGINE_ERROR_CODES.ACTION_VETOED,
    hint: '宿主在 beforeAction 里返回了 false；需要带原因请改为在钩子中 throw',
    details: { action, instanceId },
  });
}

/**
 * 驳回 / 退回目标非法（`AC-E3` / `AC-E15`）。
 * 合法取值必须完整放进 `details`：`completed`（历史节点）+ `allowedTargets`（设计期白名单）。
 */
export function actionTargetInvalid(
  action: string,
  target: string,
  completed: readonly string[],
  allowedTargets: readonly string[],
): EngineActionError {
  return new EngineActionError(`Action '${action}' cannot target node '${target}'`, {
    code: ENGINE_ERROR_CODES.ACTION_TARGET_INVALID,
    node: { id: target },
    hint: '目标必须同时属于 details.completedNodes 与 details.allowedTargets',
    details: {
      action,
      target,
      completedNodes: [...completed],
      allowedTargets: [...allowedTargets],
    },
  });
}

/**
 * `requireComment` 为 true 但未填意见（DV-3）。
 * 回退类默认 true（reject / rejectToPrev / jumpTo / returnTo / takeBack / revoke），换人类默认 false。
 */
export function commentRequired(action: string): EngineActionError {
  return new EngineActionError(`Action '${action}' requires a comment`, {
    code: ENGINE_ERROR_CODES.ACTION_COMMENT_REQUIRED,
    hint: '在 ActionInput.comment 中补充意见；该类动作默认要求留痕',
    details: { action },
  });
}

/**
 * 审批人解析为空集且 `onEmpty === 'error'`（INV-13）。
 * ★ 不得产生「0 个办待人却 active」的节点 —— 那会让流程永久卡住且无任何报错。
 */
export function approverEmpty(
  nodeId: string,
  onEmpty: string,
  details: Record<string, unknown> = {},
): EngineActionError {
  return new EngineActionError(`No approver resolved for node '${nodeId}'`, {
    code: ENGINE_ERROR_CODES.ACTION_APPROVER_EMPTY,
    node: { id: nodeId },
    hint: "改 ApproverSource 的解析规则，或把该节点的 approval.onEmpty 设为 'skip' / 显式使用 {type:'all'}",
    details: { nodeId, onEmpty, ...details },
  });
}

/** 加签超出设计期 `addSign.maxCount`（INV-12） */
export function addSignLimit(nodeId: string, limit: number, current: number): EngineActionError {
  return new EngineActionError(`Add-sign limit exceeded on node '${nodeId}'`, {
    code: ENGINE_ERROR_CODES.ACTION_ADD_SIGN_LIMIT,
    node: { id: nodeId },
    hint: '调大该节点 approval.addSign.maxCount，或减少加签人数',
    details: { nodeId, limit, current },
  });
}

/**
 * ★ 投递**没有命中任何等待**（T20 · 「不得静默丢弃」的落点）。
 *
 * 为什么必须抛：名字差一个大小写（`Msg_paid` vs `msg_paid`）如果静默丢弃，
 * 表现是「流程永久卡在等待节点上，而宿主以为自己投过了」—— 与 INV-13 同型的静默事故。
 *
 * ⚠️ 码复用 `ACTION_TARGET_INVALID`（**不新增第 20 个码**）：投递本质是一次动作，
 *   它失败的原因是「**目标**不存在」。与驳回目标非法的区别只在 `details` 的形状上
 *   （这里是 `waiting` = 该实例此刻在等的东西，即**合法取值**）。
 */
export function deliverNoTarget(
  instanceId: string | undefined,
  kind: string,
  name: string,
  waiting: readonly string[],
  details: Record<string, unknown> = {},
): EngineActionError {
  const message =
    instanceId === undefined
      ? `No instance among the candidates is waiting for ${kind} '${name}'`
      : `No token in instance '${instanceId}' is waiting for ${kind} '${name}'`;
  return new EngineActionError(message, {
    code: ENGINE_ERROR_CODES.ACTION_TARGET_INVALID,
    ...(instanceId === undefined ? {} : { instanceId }),
    hint:
      waiting.length === 0
        ? '此刻**没有**任何等待中的令牌（可能已经走过那个节点，或实例已不在等待）；请确认投递目标与时机'
        : '消息 / 信号名必须与定义里的 messageRef / signalRef **逐字一致**；details.waiting 是此刻在等的东西',
    details: { kind, name, waiting: [...waiting], ...details },
  });
}

/** 票签配置非法（INV-7） */
export function voteConfigInvalid(message: string, details: Record<string, unknown> = {}): EngineActionError {
  return new EngineActionError(message, {
    code: ENGINE_ERROR_CODES.ACTION_VOTE_CONFIG,
    hint: "mode:'vote' 要求 vote 字段存在，且 count / threshold 恰有其一",
    details,
  });
}

// ---------------- 工厂（状态层） ----------------

/** 实例不存在 */
export function stateNotFound(instanceId: string): EngineStateError {
  return new EngineStateError(`Process instance '${instanceId}' not found`, {
    code: ENGINE_ERROR_CODES.STATE_NOT_FOUND,
    instanceId,
    hint: '确认 instanceId 正确，且该实例已 start() 并成功落库',
    details: { instanceId },
  });
}

/** 终态后仍尝试推进（INV-2） */
export function stateTerminal(instanceId: string, status: string, action: string): EngineStateError {
  return new EngineStateError(`Process instance '${instanceId}' is already '${status}'`, {
    code: ENGINE_ERROR_CODES.STATE_TERMINAL,
    instanceId,
    hint: '终态实例不可再推进；如需继续请以新实例发起',
    details: { instanceId, status, action },
  });
}

/** 挂起态推进（INV-5：仅 `resume` 可解） */
export function stateSuspended(instanceId: string, action: string): EngineStateError {
  return new EngineStateError(`Process instance '${instanceId}' is suspended`, {
    code: ENGINE_ERROR_CODES.STATE_SUSPENDED,
    instanceId,
    hint: "先提交 { action: 'resume' } 再推进",
    details: { instanceId, action },
  });
}

/** 状态结构不合契约（含 `AC-E8` / INV-14） */
export function stateShapeInvalid(
  reason: string,
  details: Record<string, unknown> = {},
): EngineStateError {
  return new EngineStateError(`InstanceState shape is invalid: ${reason}`, {
    code: ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    hint: '状态必须是纯数据（无函数 / Map / Set / 类实例），且 JSON 往返深等',
    details: { reason, ...details },
  });
}

/** 令牌指向定义图中不存在的节点（INV-3） */
export function tokenOrphan(
  instanceId: string,
  tokenId: string,
  nodeId: string,
): EngineStateError {
  return new EngineStateError(`Token '${tokenId}' points to unknown node '${nodeId}'`, {
    code: ENGINE_ERROR_CODES.STATE_TOKEN_ORPHAN,
    instanceId,
    node: { id: nodeId },
    hint: '检查定义版本绑定：实例按 definitionVersion 执行，节点必须存在于该版本',
    details: { instanceId, tokenId, nodeId },
  });
}

/** 取不到定义（AC-E10） */
export function definitionMissing(processId: string, version: number): EngineStateError {
  return new EngineStateError(`Definition '${processId}' version ${version} not found`, {
    code: ENGINE_ERROR_CODES.STATE_DEFINITION_MISSING,
    hint: '确认 DefinitionSource 已发布该 processId 的该版本',
    details: { processId, definitionVersion: version },
  });
}

/**
 * 快照结构版本无迁移路径。
 * `stateSchema` **只升不降**：目标低于当前、或中间缺迁移函数时抛本错。
 */
export function stateSchemaUnsupported(
  from: number,
  to: number,
  known: readonly number[],
): EngineStateError {
  return new EngineStateError(`Cannot migrate state schema from ${from} to ${to}`, {
    code: ENGINE_ERROR_CODES.STATE_SCHEMA_UNSUPPORTED,
    hint: '快照结构版本只升不降；升级请在 STATE_MIGRATIONS 登记 from → from+1 的迁移函数',
    details: { from, to, knownFromVersions: [...known] },
  });
}

// ---------------- 工厂（持久层） ----------------

/**
 * CAS 冲突（INV-1）。
 * ★ 宿主实现 `StateStore` 时：`save()` 必须靠**影响行数**判定，不得"先查后写"（那是竞态）。
 */
export function persistConflict(
  instanceId: string,
  expectedRev: number,
  actualRev?: number,
): EnginePersistError {
  const init: EngineErrorInit = {
    code: ENGINE_ERROR_CODES.PERSIST_CONFLICT,
    instanceId,
    hint: '重新 load() 取最新状态后重试；本错误表示并发的另一笔写入已先提交',
    details: { instanceId, expectedRev, ...(actualRev === undefined ? {} : { actualRev }) },
  };
  return new EnginePersistError(`Rev conflict on instance '${instanceId}'`, init);
}

/** INSERT 冲突：`expectedRev === 0` 但实例已存在 */
export function persistAlreadyExists(instanceId: string): EnginePersistError {
  return new EnginePersistError(`Process instance '${instanceId}' already exists`, {
    code: ENGINE_ERROR_CODES.PERSIST_ALREADY_EXISTS,
    instanceId,
    hint: 'expectedRev === 0 表示新建；同一 instanceId 不得重复插入',
    details: { instanceId },
  });
}

// ---------------- 工厂（选项层） ----------------

/** 未知配置项（**禁止静默忽略**） */
export function optionUnknown(key: string, allowed: readonly string[]): EngineOptionError {
  return new EngineOptionError(`Unknown engine option '${key}'`, {
    code: ENGINE_ERROR_CODES.OPTION_UNKNOWN,
    hint: '合法配置项见 details.allowed',
    details: { option: key, allowed: [...allowed] },
  });
}

/** 配置项取值非法 */
export function optionInvalid(key: string, reason: string, value?: unknown): EngineOptionError {
  const init: EngineErrorInit = {
    code: ENGINE_ERROR_CODES.OPTION_INVALID,
    hint: '按 details.reason 修正该配置项取值',
    details: { option: key, reason, ...(value === undefined ? {} : { value }) },
  };
  return new EngineOptionError(`Invalid value for engine option '${key}'`, init);
}

/**
 * **peer 依赖缺失**（Q49：五个包之间一律 peer，不再内置）。
 *
 * ★ 本构造器是「友好提示」的落点 —— 把 Node 原生的
 *   `Cannot find module '@floken-io/moddle'` 翻译成「缺什么 / 为什么需要它 / 怎么装 /
 *   浏览器怎么注入」四件套。只透传原生错误的话，pnpm 严格模式与
 *   `--legacy-peer-deps` 用户看不出该装哪个包、装什么版本。
 *
 * ⚠️ 用基类 `EngineError` 而不是某个子类：peer 缺失不属于动作受理 / 状态 / 持久 / 配置任一类，
 *    硬塞进 `OPTION_` 会让宿主以为是 `createEngine()` 传错了参数。
 *
 * @param peer peer 包名（如 `@floken-io/moddle`）
 * @param info.neededFor 为什么需要它（进 `details.neededFor`，让人判断该不该装）
 * @param info.range 声明的版本范围（进 `details.range`；**不参与运行期校验**，范围由包管理器负责）
 * @param info.optional optional peer —— `details.optional` 为 true，文案说明「用不到就不必装」
 */
export function peerMissing(
  peer: string,
  info: { neededFor?: string; range?: string; optional?: boolean } = {},
): EngineError {
  const install = `npm i ${peer}${info.range ? `@"${info.range}"` : ''}`;
  return new EngineError(`Missing peer dependency '${peer}'`, {
    code: ENGINE_ERROR_CODES.PEER_MISSING,
    hint: `install it: ${install}  —  or inject explicitly: registerPeer('${peer}', mod)`,
    details: {
      peer,
      install,
      optional: info.optional === true,
      ...(info.range ? { range: info.range } : {}),
      ...(info.neededFor ? { neededFor: info.neededFor } : {}),
    },
  });
}

/**
 * 条件表达式求值不可用（`AC-E9`：**求值失败必须抛错，不得返回 `false`**，无豁免）。
 *
 * 三种触发（都归 `OPTION_INVALID`，不新增错误族 —— 抛出码仍是 19 个）：
 *   ① `${...}` —— JUEL 插值，**不是 FEEL**（`03-engine` §7.2：一律按越界抛错）；
 *   ② 求值为 `null` —— 三值逻辑的「未知」，网关条件必须**二值**，静默转 `false` = 静默走错分支；
 *   ③ 非布尔结果 —— 条件表达式的真值必须是 `true` / `false`。
 *
 * @param warnings 上游 `@floken-io/feel` 的诊断（`03-engine` §7.2：原样透传、不重新包装）
 */
export function conditionInvalid(
  expression: string,
  reason: string,
  details: Record<string, unknown> = {},
): EngineOptionError {
  const init: EngineErrorInit = {
    code: ENGINE_ERROR_CODES.OPTION_INVALID,
    hint: '条件表达式必须是求值为 true / false 的 FEEL 表达式；变量直接写名字（amount），不要写 ${...}',
    details: { option: 'condition', expression, reason, ...details },
  };
  return new EngineOptionError(`Invalid condition expression '${expression}'`, init);
}
