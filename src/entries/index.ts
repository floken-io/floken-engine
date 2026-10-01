/**
 * @floken-io/engine · 主入口（package 的 `.` 导出 → dist/index.js）
 *
 * 本档只做「汇总再导出」，不放实现：实现住在 `core/`（内核契约层）、
 * `actions/`（19 项动作）、`runtime/`（执行器）、`nodes/`（27 类节点）、`store/`（默认内存实现）。
 * ★ 本档是**唯一**的公开出口（`06-仓库脚手架与发布约定` §3）：`tsup` 的 `entry` 直指这里，
 *   `src/` 下**不再有第二个 `index.ts`**。为什么这条要写成硬规定，见 `ARCHITECTURE.md` §5 注。
 *
 * ★ **导出面判据：「宿主为了接入引擎，必须能 import 的东西」**
 *
 *   ① 契约类型 —— SPI（11 项）/ 状态模型 / 待办视图 / 事件 / 钩子；
 *   ② 错误契约 —— 错误类（宿主 `instanceof` 判定）+ 码表 + 宿主自研 `StateStore` 时必须抛的工厂。
 *
 *   `core/` 的**内部工具刻意不导出**：序列化守卫、`cloneState` / `deepEqual` / `assertRoundTrip`、
 *   `assertInstanceState`、迁移执行器、`isEmptyDelta` / `touchedTaskIds`，以及引擎内部使用的
 *   其余错误工厂。它们**不是契约**，改动不应受 semver 约束。
 */

// ---------------- 包标识 ----------------

/** 五包同款：供宿主做错误归属 / 版本探测 */
export const PACKAGE = '@floken-io/engine' as const;

// ---------------- 状态模型（`ARCHITECTURE.md` §6.1） ----------------

export {
  STATE_SCHEMA_VERSION,
  INSTANCE_STATUSES,
  TERMINAL_STATUSES,
  TOKEN_STATES,
  isTerminalStatus,
} from '../core/state.js';
export type {
  InstanceStatus,
  TokenState,
  Token,
  VoteOutcome,
  AuditEntry,
  ActionRecord,
  InstanceParent,
  TokenAwait,
  InstanceStateHeader,
  InstanceStateBody,
  InstanceState,
} from '../core/state.js';

// ---------------- 待办视图与差分（§6.2） ----------------

export { TASK_STATUSES } from '../core/task.js';
export type { TaskStatus, TaskView, TaskDelta, TraceEntry } from '../core/task.js';

// ---------------- 11 项 SPI（§7.2） ----------------

export { SPI_NAMES, SPI_GROUPS } from '../core/spi.js';
export type {
  SpiName,
  SpiInterfaces,
  StateStore,
  DefinitionSource,
  TaskProjection,
  ApproverSource,
  ApproverCtx,
  ServiceHandler,
  ServiceHandlerFn,
  ServiceCtx,
  AuthResolver,
  FormProvider,
  FormCtx,
  ConditionHandler,
  ConditionCtx,
  DecisionHandler,
  DecisionCtx,
  EventSink,
  Scheduler,
  ScheduleRequest,
} from '../core/spi.js';

// ---------------- 门 1 钩子（§7.3） ----------------

export type { ActionContext, EngineHooks } from '../core/hooks.js';

// ---------------- 事件（§7.3 · 节点级 5 + 实例级 5） ----------------

export {
  TASK_EVENT_NAMES,
  INSTANCE_EVENT_NAMES,
  ENGINE_EVENT_NAMES,
  isTaskEvent,
  isInstanceEvent,
} from '../core/events.js';
export type {
  TaskEventName,
  InstanceEventName,
  EngineEventName,
  TaskEvent,
  InstanceEvent,
  EngineEvent,
} from '../core/events.js';

// ---------------- 错误与诊断契约（§7.4） ----------------

export {
  EngineError,
  EngineActionError,
  EngineStateError,
  EnginePersistError,
  EngineOptionError,
  ENGINE_ERROR_CODES,
  ENGINE_DIAGNOSTIC_CODES,
  // ★ 诊断**不抛**，随结果返回（`PlanResult.diagnostics`）；构造工厂公开，
  //   便于宿主自研实现产出同款诊断（与 `persistConflict` 同理）。
  engineDiagnostic,
  // ★ 这两个工厂必须公开：宿主自研 StateStore 时要靠它们抛同款冲突错误，
  //   否则引擎侧无法把「宿主抛的错」与「引擎抛的错」归一（`ARCHITECTURE.md` §7.2 StateStore）。
  persistConflict,
  persistAlreadyExists,
} from '../core/errors.js';
export type {
  NodeRef,
  EngineErrorInit,
  EngineErrorCode,
  EngineDiagnosticCode,
  EngineSeverity,
  EngineDiagnostic,
  EngineDiagnosticInit,
} from '../core/errors.js';

// ---------------- 内核原语（§8 ADR-001 · 10 个，业务无知） ----------------

/**
 * ★ **只导出"计数契约"，不导出原语函数本体** ——
 *   原语是内核内部实现（"驳回"不存在于这一层），宿主接引擎用的是 **19 项动作**，不是原语；
 *   把函数导出会让内核改动背上 semver 约束，与「`cloneState` 等内部工具不导出」同一判据。
 *   但「**恰好 10 个原语**」是 `03` §3 的对外承诺 → 必须**可观测**，故导出名表与分组。
 */
export { PRIMITIVE_NAMES, PRIMITIVE_GROUPS } from '../core/primitives.js';
export type { PrimitiveName } from '../core/primitives.js';

// ---------------- 19 项动作（§9 T9 · 动作名是宿主唯一需要认识的那一层） ----------------

/**
 * ★ 与「原语只导出计数」相反，**动作名必须公开**：
 *   宿主 UI 渲染可点按钮、宿主后端拼 `ActionInput` 都要它 —— 它是 `03` §4 的对外承诺。
 *   但**不导出 `ACTION_SPECS` / `compileAction`**：前者会把表的内部结构钉成 semver 约束，
 *   后者是引擎内部执行路径（宿主走 `submit()` / `plan()`，不需要自己编译）。
 */
export { ACTION_NAMES } from '../actions/catalog.js';
export type { ActionName } from '../actions/catalog.js';

/**
 * 「当前配置下哪些动作可用」—— 灰按钮的判据。
 * 公开它而非让宿主自己读 `NormalizedApproval`，是为了**只有一处判定口径**（DV-2 / AC-E15）。
 */
export { enabledActionNames } from '../actions/gates.js';

// ---------------- 汇聚判定（§9 T10 · 会签 / 或签 / 票签） ----------------

/**
 * ★ 与「原语只导出计数」相反，**汇聚判定必须公开** —— 判据不同：
 *   门 2（宿主自编排）要求宿主能**独立完成一次完整的状态演化**，而「够票了没 / 该不该终止 /
 *   终止后取消谁」正是演化的核心。缺了它，宿主自编排只能做「单人审批」。
 *
 *   算法本身仍在 `@floken-io/moddle`（单一事实源），这里只做**入参校验 + 结果翻译**
 *   （含 D-21 的规则一优先级修正）。详见 `actions/convergence.ts` 的头注释。
 */
export {
  evaluateConvergence,
  shouldConverge,
  shouldTerminate,
  requiredOf,
  restTokenIds,
  // T13：组计数与「组 → ConvergeCtx」的翻译。门 2 自编排要独立完成汇聚，
  // 就必须能从 `tokens` 算出票数 —— 缺了它，宿主只能自己发明一份计票口径。
  groupTallies,
  convergeCtxOf,
} from '../actions/convergence.js';
export type {
  ConvergeCtx,
  ConvergeMode,
  ConvergenceResult,
  GroupTally,
} from '../actions/convergence.js';

// ---------------- 动作输入 + `plan()` 纯函数（§7.1 / §3.3 槽位 4） ----------------

export type { ActionInput } from '../core/action.js';

/**
 * ★ `plan()` 是门 2（强一致）的入口：宿主拿 `{ next, delta }` 自己包事务。
 *   `submit()` 只是它的便利封装 —— 两条路径的状态演化必须完全一致。
 */
export { plan } from '../runtime/plan.js';
export type { PlanOptions, PlanResult } from '../runtime/plan.js';

/**
 * ★ 公开它是因为**门 2 下宿主同样需要串行**：宿主自己编排时若不做 per-instance 串行，
 *   NFR-E5 的第一道防线就断了（CAS 只是兜底，不该被当成主防线用）。
 */
export { createInstanceQueue } from '../runtime/queue.js';
export type { InstanceQueue } from '../runtime/queue.js';

// ---------------- ★ 推进循环（§7.1 · T13 会签闭环） ----------------

/**
 * ★ 为什么**必须公开** `step()`：它是「一次动作的完整推进」= 原语 → 记票 → 串行接力
 *   → 汇聚 → run-to-wait。门 2（宿主自编排）拿 `plan()` 的 `apply` 接缝组装演化时，
 *   要的就是这一个函数 —— 若它只活在 `submit()` 里，门 2 就得复制一份，
 *   §7.1「两条路径不得分叉」立刻从**结构保证**退化成**纪律问题**。
 *
 *   其余几个（`castVote` / `promoteSequential` / `settleGroups`）同理：它们都是
 *   「宿主自己编排时必须能独立完成的演化步骤」。
 */
export { step, castVote, promoteSequential, settleGroups, applyPost } from '../runtime/loop.js';
export type { LoopContext, LoopResult, StepInput } from '../runtime/loop.js';

// ---------------- ★ 子流程 / 调用活动（§6 / T18 · 门 2 同样要能完成） ----------------

/**
 * ★ 为什么**必须公开** `callReturnOf()` 与 `CALL_RETURN_ACTION`：
 *
 *   门 2（宿主自编排）下 `step()` 会返回 `pendingCalls` —— 子实例由宿主自己建、自己存。
 *   而当子实例走到终态时，**父实例那条停在 `callActivity` 上的令牌要放它继续走**，
 *   这一步同样是宿主自己包事务做。缺了本函数，宿主就得自己写一份
 *   「放行 `waiting` 令牌 + 记账 + 清办理人」，于是 §7.1「两条路径不得分叉」
 *   从**结构保证**退化成**纪律问题**（与 `step()` 必须公开同一条理由）。
 *
 *   `CALL_RETURN_ACTION` 是写进父实例审计的那个动作名 —— 宿主用自己的 `plan()`
 *   完成回归时要传同一个名字，审计才对得上（它是**第三类**动作名，见该函数注释）。
 */
export { CALL_RETURN_ACTION, callReturnOf } from '../nodes/activities.js';
export type { PendingCall } from '../nodes/activities.js';

// ---------------- ★ 投递：等外部消息 / 信号（§7.1 · T20 · 门 2 同样要能完成） ----------------

/**
 * ★ 为什么**必须公开** `deliverStep()` 与两个动作名：与 `step()` / `callReturnOf()` 同一条理由 ——
 *   门 2（宿主自编排）下投递也得由宿主自己落库，若「匹配 → 唤醒 → run-to-wait」只活在
 *   `deliverMessage()` 里，门 2 就得复制一份，§7.1 两条路径立刻分叉。
 *
 *   `matchingTokens()` / `waitingNamesOf()` 一并公开：宿主做**订阅表**时要读
 *   `Token.awaiting`（"谁在等什么"），而那份判据只能有一份（就在 `nodes/catch.ts`）。
 */
export {
  MESSAGE_DELIVER_ACTION,
  SIGNAL_DELIVER_ACTION,
  DELIVER_ACTIONS,
  CATCH_KINDS,
  catchBindingOf,
  matchingTokens,
  waitingNamesOf,
} from '../nodes/catch.js';
export type { CatchKind, CatchBinding, CatchNodeLike, DeliverMatch } from '../nodes/catch.js';

export { deliverStep } from '../runtime/deliver.js';
export type { DeliverResult } from '../runtime/deliver.js';

// ---------------- 事件派生与投递（§7.3 · ADR-006） ----------------

/**
 * ★ 为什么**必须公开** `eventsOf()`：门 2（宿主自编排）下宿主自己调 `plan()`，
 *   若事件只能由 `submit()` 推导，门 2 路径就**一条事件都发不出来** ——
 *   与「`apply` / `tasks` 接缝必须走 `plan()`」（D-18）是同一条理由。
 *
 * `emitAll()` 也一并公开：它吞掉同步抛错与 rejected promise，
 * 这两件事宿主自己写投递时最容易漏（漏了就是 unhandled rejection 崩进程）。
 */
export { eventsOf, instanceEventNameOf, emitAll } from '../runtime/emit.js';
export type { EmitInput } from '../runtime/emit.js';

// ---------------- ★ 引擎门面（§7.1 / §3.3 九个槽位） ----------------

/**
 * ★ `createEngine()` 是宿主接入的**唯一入口**。
 *
 * `start` / `submit` 是日常路径；`deliverMessage`（点对点）/ `deliverSignal`（广播）是
 * T20 的**投递入口**（唤醒停在 `intermediateCatchEvent` / `receiveTask` 上的令牌）；
 * `plan()` 是门 2（强一致自编排）的入口，
 * 引擎实例上的 `plan` 只是给它补上 `EngineConfig.clock` / `maxAuditEntries`（ADR-007）。
 *
 * ⚠️ `exportTrace`（T22）尚未实现 —— `Engine` 接口会随它的落地扩展，
 *   此处**刻意不提前声明**（声明了就得给实现）。
 */
export { createEngine } from '../runtime/engine.js';
export type { Engine, EngineConfig, StartOptions, DeliverInput } from '../runtime/engine.js';

// ---------------- 条件求值（§7 / §8.3 · AC-E9） ----------------

/**
 * ★ 为什么**必须公开** `createFeelConditionHandler()`：
 *   ① 它就是「不注入 `conditionHandler` 时的那个默认实现」 —— 藏起来 = 宿主无法确证
 *      「零配置装出来的引擎，条件分支到底是不是好的」（NFR-E10 / Q30）；
 *   ② 宿主想**收窄**到 S-FEEL 子集（`allowedFunctions`）时，要用它包一层再注入，
 *      不该逼他自己去 import `@floken-io/feel` 重造一个。
 *
 * `evaluateCondition()` 一并公开：它是条件求值的**唯一出口**，
 * 承载 AC-E9 那条「求值失败必须抛错、无豁免」的第 0 层要求；
 * 宿主自研 `conditionHandler` 时，应走同一个出口才能保证「非布尔不静默」。
 */
export { createFeelConditionHandler, evaluateCondition } from '../eval/condition.js';
export type { FeelConditionOptions } from '../eval/condition.js';

// ---------------- 默认实现（NFR-E10「默认内存、可切换」） ----------------

/**
 * `createEngine()` **不传 `store`** 时用的就是它。
 *
 * 公开导出有两个用处：① 宿主在**测试**里直接拿它跑（零依赖、零配置）；
 * ② 明确「默认就是内存」这件事是**可观测**的，而不是藏在引擎内部的实现细节。
 */
export { createMemoryStore } from '../store/memory.js';
