/**
 * @floken-io/engine · 11 项 SPI（与业务的**全部**接触面）
 *
 * 契约来源：`ARCHITECTURE.md` §7.2 / `03-engine` §8。
 *
 * **本文件只声明、绝不实现** —— 引擎不 import 数据库 / 消息队列 / 组织架构，
 * 而是反过来：低层实现这些接口，再注入进来（依赖倒置）。
 * 判据：**任何「换个客户就要改包代码」的东西，都是解耦没做到位。**
 *
 * ★ 计数口径（勿再挪）：**11 项 = 存储三线 3 + 业务接入 4 + 求值 2 + 出口 2**。
 * ★ 命名红线：同一接口只允许一个名字 —— 求值 = `ConditionHandler` / `DecisionHandler`
 *   （旧名 `ExpressionEvaluator` **废弃、全项目不再使用**）；存储写线 = `StateStore`。
 */
import type { ApproverSpec, ProcessDefinition, WorkCalendarSpec } from '@floken-io/moddle';
import type { InstanceState } from './state.js';
import type { TaskDelta, TaskView } from './task.js';
import type { EngineEvent } from './events.js';

// ═══════════════════════════════════════════════════════════════
// 8.1 存储三线（3 项）
//   一句话记法：StateStore = 真相（引擎的）｜ TaskProjection = 视图（你的）｜ DefinitionSource = 图纸（只读的）
// ═══════════════════════════════════════════════════════════════

/**
 * 写线 · 引擎状态的**唯一权威**。
 *
 * 只两个方法 —— 这一层门槛刻意压到 ~20 行，任何库 / 内存 / 浏览器都能实现。
 * **禁止**让本接口长出事务接口：那会把内存实现的门槛抬到 100 行，
 * 也会把「引擎内不做事务」这条底线（ADR-004）毁掉。
 */
export interface StateStore {
  /** 单参定位：`instanceId` 由引擎生成、全局唯一（**不开 tenantId 口子**，见 §9.3） */
  load(id: string): Promise<InstanceState | null>;
  /**
   * 整块快照 + CAS 乐观锁。
   *
   * ★ **`expectedRev === 0` 就是 INSERT 信号**（写死，宿主据此分两条路径）：
   * - `expectedRev === 0` → INSERT；该 id 已存在则抛 `ENGINE_PERSIST_ALREADY_EXISTS`
   * - `expectedRev > 0`   → CAS UPDATE（`WHERE rev = expectedRev`）；**影响 0 行**则抛 `ENGINE_PERSIST_CONFLICT`
   *
   * ⚠️ 必须靠**影响行数**判定，不得“先查后写”（那是竞态）。
   * 行业背书：Camunda 7 的 `REV_` 乐观锁是同一设计（affected rows 0 → 抛冲突）。
   */
  save(next: InstanceState, expectedRev: number): Promise<void>;
}

/**
 * 定义线 · **只读**、按版本取图纸。
 *
 * ★ 必填。理由：`AC-E10` 要求「v1.0 改版后，在途实例仍按**旧版本**定义执行」——
 * 定义必须能被按 `(processId, version)` 取回，而不是每次 `submit()` 由宿主递进来。
 *
 * ═══════════════════════════════════════════════════════════════
 * ★★ 版本语义（T19 钉死 —— 这四条就是 `AC-E10` 的全部内容）
 * ═══════════════════════════════════════════════════════════════
 *
 * ① **版本精确**：`getDefinition(pid, v)` 是「第 v 版」的**等值查询**，不是「≤ v 的最新一版」，
 *    更不是「最新版」。宿主**不得**做就近取整（`Math.round`）或"取不到就退到上一版"。
 *    理由：一次静默回退 = 在途实例跑到了它发起时**还不存在的节点**上。
 *
 * ② **不存在 = `null`**：该 `(pid, v)` 不在库里就返回 `null`（不得抛错、不得返回任一其他版本）。
 *    引擎侧统一把 `null` 翻成 `ENGINE_STATE_DEFINITION_MISSING`。
 *    ⚠️ 宿主若抛自定义错，引擎就**分不清**「这版没有」与「仓库挂了」—— 与 `StateStore`
 *    必须用 `persistConflict()` 抛错（见 `report.ts`）同一条理由。
 *
 * ③ **不得改内容**：同一 `(pid, v)` 反复取回必须内容一致（发布即冻结）。
 *    「改一版的定义而不升版本号」会让在途实例**中途变图**，这是 `AC-E10` 的头号破防方式。
 *
 * ④ **`version` 由引擎保证 ≥ 1 的整数**（`assertStartOptions` 与 `callTargetOf` 各自校验），
 *    宿主不必重复校验；但对**异常入参**（0 / 负数 / 小数 / `NaN`）应返回 `null` 而非抛错。
 *
 * 契约自检：`runDefinitionConformance()`（`./conformance`）把这四条变成可跑的判据。
 */
export interface DefinitionSource {
  getDefinition(processId: string, version: number): Promise<ProcessDefinition | null>;
}

/**
 * 读线 · 待办视图。**可选注入** —— 不注入则宿主自管待办表。
 *
 * ⚠️ 本线是**视图**，表结构归宿主；引擎只吐 `TaskDelta`。
 * ⚠️ **禁止在本线里做业务副作用**（扣库存、发通知、改业务主表）—— 那是门 1 `hooks`
 * 或门 2 `plan()` 自编排的事（ADR-004）。
 */
export interface TaskProjection {
  /** 按 `taskId` 幂等；`delta.removed` 里的 taskId **必须真删**（INV-15） */
  apply(instanceId: string, delta: TaskDelta): Promise<void>;
  /** 全量对账：`load()` 发现 `pendingProjectionRev` 时补做（INV-18） */
  sync(instanceId: string, tasks: TaskView[]): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════
// 8.2 业务接入（4 项）
// ═══════════════════════════════════════════════════════════════

/** `ApproverSource.resolve()` 的入参上下文：引擎知道的事实，不含组织模型 */
export interface ApproverCtx {
  instanceId: string;
  processId: string;
  nodeId: string;
  /** 发起人（`start()` 传入）—— `{type:'deptLeader', of:'starter'}` 的解析依据 */
  starter: string;
  /** 当前流程变量（只读快照） */
  variables: Readonly<Record<string, unknown>>;
}

/**
 * ★ **最常被写死的一环**：「谁是发起人的部门负责人」是**业务数据**，不是引擎知识。
 *
 * 引擎只会说「我要哪一类人」（`ApproverSpec`），具体是谁由宿主回答：
 * ```ts
 * await source.resolve({ type: 'deptLeader', of: 'starter' }, { starter: 'u_001', … });
 * // → ['u_1007']
 * ```
 * 为什么必须外置：「部门负责人」到底是正职还是副职？休假期间算谁？跨部门兼职算谁？
 * —— **每家公司答案不同**，写进引擎就等于每换一个客户改一次包代码。
 */
export interface ApproverSource {
  resolve(spec: ApproverSpec, ctx: ApproverCtx): Promise<string[]>;
}

/** `serviceTask` 的宿主上下文 */
export interface ServiceCtx {
  instanceId: string;
  processId: string;
  definitionVersion: number;
  nodeId: string;
}

/** 单个 `serviceTask` 实现：入参是**只读**流程变量，返回要并入 `variables` 的增量 */
export type ServiceHandlerFn = (
  variables: Readonly<Record<string, unknown>>,
  ctx: ServiceCtx,
) => Promise<Record<string, unknown>>;

/**
 * `serviceTask` 的实现表（引擎不知道怎么发邮件）。
 * 按定义里的 `handlerRef` 取；缺省用 `nodeId` 取。
 */
export interface ServiceHandler {
  /** 未注册返回 `undefined` —— 引擎据此报「未配置」，**不得静默跳过** */
  get(ref: string): ServiceHandlerFn | undefined;
}

/**
 * 鉴权（可选）。
 * ★ 内核**默认零鉴权**（信任宿主），默认实现放行；信创 / 不可信直连场景才注入强鉴权。
 * 部署契约：任务中心是唯一对外入口，内核 API 不公开。
 */
export interface AuthResolver {
  canAct(actor: string, nodeId: string, state: InstanceState): Promise<boolean>;
}

/** `FormProvider` 的宿主上下文 */
export interface FormCtx {
  instanceId: string;
  nodeId: string;
  /** 发起人 / 当前办理人 */
  actor: string;
}

/**
 * 表单读取与快照（可选）。
 * ★ 引擎**不解析表单结构**，只存 `formKey` —— 本接口是「画面之外」的那半：
 * 读取定义 + 落快照。渲染归宿主薄渲染器（可选包 `@floken-io/form-renderer`）。
 */
export interface FormProvider {
  /** 按 `formKey` 读取表单定义；取不到返回 `null`（引擎报「未配置」） */
  getForm(formKey: string, ctx: FormCtx): Promise<unknown | null>;
  /** 每一步「看到的表单是什么」的快照（`03-engine` FR-8.1 表单快照）；不落则返回 `null` */
  snapshot(
    formKey: string,
    variables: Readonly<Record<string, unknown>>,
    ctx: FormCtx,
  ): Promise<unknown | null>;
}

// ═══════════════════════════════════════════════════════════════
// 8.3 求值（2 项）
// ═══════════════════════════════════════════════════════════════

/** `ConditionHandler` 的宿主上下文 */
export interface ConditionCtx {
  instanceId: string;
  nodeId: string;
  variables: Readonly<Record<string, unknown>>;
  /**
   * ★ **当前节点**（`nodeId`，即条件所在的网关 / 活动）上的宿主自定义扩展属性（ADR-009）。
   *
   * - 键**原样给出**，引擎**不解读、不改写、不筛选**其语义 —— `extension` 是宿主的地盘，
   *   与一等字段同名的键也照给（v2 里一等字段在 `node.approval`，不在 `node.extension` 里，
   *   所以袋里出现 `approval` 只可能是宿主自己的业务数据）；
   * - **结构化值也给**（数组 / 对象原样；只有函数与 `undefined` 排除）；
   * - 没有 → `undefined`（不填空对象）。
   *
   * ⚠️ 它**恒给**（不需任何配置）；"自动并入 `variables`"才需要 opt-in（见 `EngineConfig.extensionVars`）。
   */
  nodeExtensions: Readonly<Record<string, unknown>> | undefined;
  /**
   * ★ 该条件所在**顺序流的目标节点**上的自定义扩展属性（ADR-009 细则②）。
   *
   * 为什么必须两个都给：条件挂在**顺序流**上，而"加急等级"这类业务属性通常挂在
   * **审批节点**（目标）而不是网关（当前节点）上 —— 只给一个，另一个场景就得回退到手写 handler。
   *
   * ⚠️ 求值时**拿不到目标**（如宿主在门 2 自提供 `conditionsOf` 闭包）→ `undefined`。
   */
  targetExtensions: Readonly<Record<string, unknown>> | undefined;
}

/**
 * 网关分支 / 顺序流条件求值。**不注入 = 内置 `@floken-io/feel`**（S-FEEL 子集）。
 *
 * ⚠️ **第 0 层要求（无豁免，`AC-E9`）**：求值失败**必须抛错**，不得静默返回 `false`。
 * 「表达式出错却返回 false」会让流程**静默走错分支**，比抛错危险十倍。
 * 注入自定义实现后，§7.2 的「越界语法抛错」判定权移交宿主，但本条对**任何**实现生效。
 */
export interface ConditionHandler {
  evaluate(expression: string, ctx: ConditionCtx): boolean | Promise<boolean>;
}

/** `DecisionHandler` 的宿主上下文 */
export interface DecisionCtx {
  instanceId: string;
  nodeId: string;
  input: Readonly<Record<string, unknown>>;
}

/**
 * `BusinessRuleTask` 的决策求值。**不注入 = 该节点报「未配置」**（无内置默认）。
 * 官方实现在 `@floken-io/dmn`，旁挂接入、不进主链。
 */
export interface DecisionHandler {
  evaluate(input: Record<string, unknown>, ctx: DecisionCtx): Promise<Record<string, unknown>>;
}

// ═══════════════════════════════════════════════════════════════
// 8.4 出口（2 项）
// ═══════════════════════════════════════════════════════════════

/**
 * 领域事件出口（**通知 / 集成**，异步、不阻塞、丢了不影响流程）。
 * ⚠️ **不是审计来源** —— 审计主源是状态内 `auditTrail`（`03-engine` §9.1 Plan A）。
 */
export interface EventSink {
  emit(event: EngineEvent): void | Promise<void>;
}

/** 到点后做什么 —— `03` §4 的 `timeout.actions[]` 四选（可并存，故 `kind` 是单值、可多次 schedule） */
export type ScheduleKind = 'remind' | 'autoApprove' | 'autoReject' | 'escalate';

/**
 * ★ **原始**超时配置（`03` §4 的 `TimeoutConfig` 三选一 + 工作日历）。
 *
 * ⚠️ 为什么这里传的是**配置**而不是算好的 `dueAt`：
 *   ① **Q33** 硬性规定引擎 `dist` 不得出现时态库 —— 内核连 `P3D` 都解不了；
 *   ② 就算能解，`03` F-1 要求「3 个工作日」**必须**跳过周末与法定节假日，
 *      而节假日表是**业务配置**，属于宿主/调度方。
 *   ⇒ 内核只能如实交出「从什么时候开始 + 定义上写的什么」，**到期时刻由调度方算**。
 *      把 `dueAt` 留在内核里，等于逼内核要么违反 Q33、要么静默退化成 7×24。
 */
export interface TimeoutSpec {
  /** ISO-8601 duration：'P3D' / 'PT4H' */
  readonly duration?: string | undefined;
  /** 绝对时间 */
  readonly date?: string | undefined;
  /** 周期 */
  readonly cycle?: string | undefined;
  /**
   * 工作日历 —— **两种形态都原样交出，内核不解读、不改写、不补齐**：
   * - `string` = 日历 **id**（`'default'` 只是个名字，含义由调度方解释）；
   * - `WorkCalendarSpec` = 宿主**内联**的日历（`workdays` / `hours` / `holidays`）。
   *
   * ⚠️ 不给 = 调度方自己的默认（`03` F-1：不得退化成 7×24）。
   * ⚠️ 引擎**不内置任何节假日表**：`holidays` 一律由宿主给（每家公司的放假安排不同）。
   */
  readonly workCalendar?: string | WorkCalendarSpec | undefined;
}

export interface ScheduleRequest {
  instanceId: string;
  nodeId: string;
  /** ★ 待办对应的令牌（`cancel` 要能定位到"哪条待办"） */
  tokenId: string;
  /** ★ 待办**创建**的时刻（ISO 8601）—— 调度方按工作日历**从它**推算真实到期时刻 */
  fromAt: string;
  /** ★ 定义上写的超时配置（内核**不**算 `dueAt`，理由见 {@link TimeoutSpec}） */
  timeout: TimeoutSpec;
  /**
   * 到点后做什么 —— `03` §4 的 `timeout.actions[]` 四选
   * （可并存 ⇒ 每个动作各排一次，故 `kind` 是单值）。
   */
  kind: ScheduleKind;
  /**
   * ★ **原始动作对象**（`{ type, interval?, max?, target?, to? }` 原样）。
   *
   * ⚠️ 为什么光有 `kind` 不够：它只是个标签，调度方仍不知道
   * 「隔多久催一次（`remind.interval`）、最多催几次（`remind.max`）、
   * 驳回给谁（`autoReject.target`）、升级给谁（`escalate.to`）」——
   * 这些是宿主写在定义里的参数，内核同样**不解读、不改写**，只原样交出。
   */
  payload?: Record<string, unknown>;
}

/**
 * 定时（超时提醒 / 自动审批）。
 * ★ **内核里不允许出现定时逻辑**（把定时画进内核是最常见的架构污染）；
 * ★ **不注入 = 不排程**（没有 `createMemoryScheduler()` 这类内置实现，别信旧注释）。
 */
export interface Scheduler {
  /** 返回可取消的 handle（形状由**调度方**决定，引擎不得假定） */
  schedule(req: ScheduleRequest): Promise<string>;
  cancel(handle: string): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════
// ★ 计数单一事实源（凡能算出的数字不手列）
// ═══════════════════════════════════════════════════════════════

/**
 * 11 项 SPI 的名字，**分类顺序即文档顺序**（`03-engine` §8 四张子表）。
 * 对外报数只从这里取，不得另记一份。
 */
export const SPI_NAMES = [
  // 8.1 存储三线
  'StateStore',
  'DefinitionSource',
  'TaskProjection',
  // 8.2 业务接入
  'ApproverSource',
  'ServiceHandler',
  'AuthResolver',
  'FormProvider',
  // 8.3 求值
  'ConditionHandler',
  'DecisionHandler',
  // 8.4 出口
  'EventSink',
  'Scheduler',
] as const;

export type SpiName = (typeof SPI_NAMES)[number];

/** 分组视图（3 + 4 + 2 + 2 = 11）—— 供测试断言，也方便对外解释「为什么是 11」 */
export const SPI_GROUPS = {
  /** 存储三线：真相 / 图纸 / 视图 */
  storage: ['StateStore', 'DefinitionSource', 'TaskProjection'],
  /** 业务接入：取人 / 干活 / 鉴权 / 表单 */
  business: ['ApproverSource', 'ServiceHandler', 'AuthResolver', 'FormProvider'],
  /** 求值：网关条件 / 决策表 */
  eval: ['ConditionHandler', 'DecisionHandler'],
  /** 出口：事件 / 定时 */
  exit: ['EventSink', 'Scheduler'],
} as const satisfies Record<string, readonly SpiName[]>;

/**
 * 名字 → 接口的登记表。
 * ⚠️ 不导出成运行时值（会让 tsup 无法 tree-shake、也污了 `sideEffects:false` 声明）；
 * 它只用于下面那道**编译期锁**。
 */
export interface SpiInterfaces {
  StateStore: StateStore;
  DefinitionSource: DefinitionSource;
  TaskProjection: TaskProjection;
  ApproverSource: ApproverSource;
  ServiceHandler: ServiceHandler;
  AuthResolver: AuthResolver;
  FormProvider: FormProvider;
  ConditionHandler: ConditionHandler;
  DecisionHandler: DecisionHandler;
  EventSink: EventSink;
  Scheduler: Scheduler;
}

/** 编译期锁：新增接口却忘了登记进 `SPI_NAMES` → 本行报错 */
type MissingSpiName = Exclude<keyof SpiInterfaces, SpiName>;
const _spiNamesExhaustive: MissingSpiName extends never ? true : never = true;
void _spiNamesExhaustive;
