/**
 * @floken-io/engine · **任务 8 类的执行语义**（T17 · `nodes/tasks.ts`）
 *
 * 契约来源：`03-engine` §6「任务（8）」/ `01-moddle` §5.3 的覆盖率表。
 *
 * ★ 为什么单独一档（与 `nodes/events.ts` 同一个理由）：8 类在 XML 里都是 `<bpmn:*Task>`，
 *   但**执行语义完全不同** —— `userTask` 要等人办、`serviceTask` 要调宿主代码、
 *   `scriptTask` 只能跑 FEEL（**不得**跑任意 JS）、`manualTask` 只是留痕、
 *   裸 `task` 什么都不做。散写在 `runtime/loop.ts` 的 if 链里，「哪一类跑不了」
 *   就会变成一句注释而不是一条**可断言的事实**。
 *
 * ★ **分类必须是穷举的**（`TASK_TYPES` 就是那 8 个名字）：新增一类时 `taskBehaviorOf`
 *   返回 `undefined` → `runtime/loop.ts` 把它当**自动直通**处理；本档的 8 类里
 *   `sendTask` 是 **`unsupported`（显式抛错）**，绝不静默直通。
 *
 * ## ★ 两类消息节点的处置（T20 已分家）
 *   - `receiveTask` → **`'catch'`（等外部消息）**，T20 随 `deliverMessage()` 一并落地。
 *     它与 `intermediateCatchEvent` 的等待语义**完全同形**，故判据不在本档 ——
 *     见 `nodes/catch.ts`（横跨任务族与事件族，放哪一族都会长出第二份写法）。
 *   - `sendTask` → **仍抛错（D-56）**：`03` 自己写明它「与 `IntermediateThrowEvent`
 *     同构」，而后者在 T16 就是因为 **ADR-006 把事件集定死 10 个、其中没有"抛出事件"**
 *     才推迟的。此处若"顺手发一条"，只有两条路：① 偷偷加第 11 个事件（违反 ADR-006，
 *     且必须走 ADR 修订而不是代码）；② 复用 `taskCreated` + `taskCompleted`
 *     ⇒ 与 `manualTask` **完全同形**，等于把两条规格写明的语义**静默合并成一条**。
 *     两条都不接受 ⇒ 与 `intermediateThrowEvent` 同处置：抛错并指名归属。
 *
 * ## ★ `effect` 类为什么必须外源解析（与 `assigneesOf` / `conditionsOf` 同款）
 *   `serviceTask` 调宿主代码、`scriptTask` 跑 FEEL、`businessRuleTask` 走 `decisionHandler` ——
 *   全是**副作用**，而 `runToWait()` 必须同步纯（NFR-E6）。
 *   故与办理人 / 条件同一套路：纯循环里只调 `LoopContext.effectsOf()` 这个**同步闭包**，
 *   闭包在还没有结果时抛 `NodeEffectUnresolved` 哨兵 → `runtime/engine.ts` 解析 → **重跑**。
 *
 *   ⚠️ **副作用只发生一次**：解析结果按 `${nodeId}::${tokenId}` 缓存，重跑时直接命中。
 *   若无缓存，"重跑"就会把 `serviceTask` 调 N 次（发 N 封邮件），那比不实现更糟。
 *
 * ★ 分层：`nodes/` 可 import `core/` 与模型层；**`core/` 不得反向 import 本目录**。
 */

import type { EngineEvent } from '../core/events.js';
import { stateShapeInvalid } from '../core/errors.js';

// ---------------- 8 类任务 ----------------

/**
 * 任务族的全部 8 类（`03-engine` §6 的登记名，**顺序即契约**）。
 *
 * ⚠️ 不手列第二份：外部（测试 / 探针）要数任务类数就用 `TASK_TYPES.length`。
 */
export const TASK_TYPES = [
  'userTask',
  'serviceTask',
  'scriptTask',
  'sendTask',
  'receiveTask',
  'manualTask',
  'businessRuleTask',
  'task',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

/**
 * 任务的执行语义。
 * - `'wait'` —— 等人办（`userTask`）。令牌落定办理人后停下（ADR-003 的稳定点）。
 * - `'effect'` —— **有副作用**（`serviceTask` / `scriptTask` / `businessRuleTask` / `manualTask`）。
 *   副作用**不在本档**：由 `runtime/engine.ts` 解析成 `NodeEffect` 后，纯循环只负责**消费**它。
 * - `'catch'` —— **等外部消息**（`receiveTask`，T20）。与 `intermediateCatchEvent` 同处置，
 *   判据在 `nodes/catch.ts`（令牌停住 → 由 `deliverMessage()` 唤醒）。
 * - `'pass'` —— 直通（裸 `task`）：无副作用、不产生待办、**不发事件**，令牌到达即离开。
 * - `'unsupported'` —— 已知但**未实现**（`sendTask`，见档首）。
 */
export type TaskBehavior = 'wait' | 'effect' | 'catch' | 'pass' | 'unsupported';

/** 该类型是不是任务族；是 → 返回它的执行语义；不是任务 → `undefined` */
export function taskBehaviorOf(type: string | undefined): TaskBehavior | undefined {
  switch (type) {
    case 'userTask':
      return 'wait';
    case 'serviceTask':
    case 'scriptTask':
    case 'businessRuleTask':
    case 'manualTask':
      return 'effect';
    case 'receiveTask':
      return 'catch';
    case 'task':
      return 'pass';
    case 'sendTask':
      return 'unsupported';
    default:
      return undefined;
  }
}

export function isTaskType(type: string | undefined): boolean {
  return (TASK_TYPES as readonly string[]).includes(type ?? '');
}

// ---------------- 未实现的显式抛错 ----------------

/**
 * 令牌到达了「已知但尚未实现」的任务 → **抛**，绝不静默直通。
 *
 * ★ 与 `nodes/events.ts` 的 `assertEventSupported` 同一判据：这两类都是
 *   「**消息**」语义（一个发、一个收），`deliverMessage` / 抛出事件未落地之前，
 *   静默直通的表现是"流程走过去了，但那条消息从来没有过" —— 业务上无法接受，
 *   且排查时**没有任何报错**可循。
 */
export function assertTaskSupported(
  type: string,
  nodeId: string,
  behavior: TaskBehavior,
): void {
  if (behavior !== 'unsupported') return;
  const owner: Record<string, string> = {
    sendTask: 'FR-E14 / T20（向外抛出：ADR-006 事件集定死 10 个，须先改 ADR 再加）',
  };
  throw stateShapeInvalid(`node '${nodeId}' is a '${type}', which is not executable yet`, {
    nodeId,
    type,
    owner: owner[type] ?? 'unknown',
    behavior,
    hint: '该任务类型已知但尚未实现；引擎刻意不把它降级成自动直通（那会让"消息没发生"变成静默事实）',
  });
}

// ---------------- 副作用的种类 ----------------

/**
 * `effect` 类任务的副作用种类 —— **决定了 `runtime/engine.ts` 去哪解析**。
 *
 * - `'service'` —— 查 `handlers` 表（`ServiceHandler`）：`serviceTask`
 * - `'script'` —— `scriptFormat` 是 FEEL 就内置求值，否则查 `handlers` 表：`scriptTask`
 * - `'decision'` —— 走 `decisionHandler` SPI：`businessRuleTask`
 * - `'manual'` —— 只留痕（连发 `taskCreated` + `taskCompleted`）：`manualTask`
 */
export type TaskEffectKind = 'service' | 'script' | 'decision' | 'manual';

export const TASK_EFFECT_KINDS = ['service', 'script', 'decision', 'manual'] as const satisfies readonly TaskEffectKind[];

export function effectKindOf(type: string | undefined): TaskEffectKind | undefined {
  switch (type) {
    case 'serviceTask':
      return 'service';
    case 'scriptTask':
      return 'script';
    case 'businessRuleTask':
      return 'decision';
    case 'manualTask':
      return 'manual';
    default:
      return undefined;
  }
}

// ---------------- `scriptFormat` = FEEL 的识别 ----------------

/**
 * 认作 FEEL 的 `scriptFormat`（**白名单**，不是"含 feel 就算"）。
 *
 * 归一化：trim + 转小写 + 去掉结尾的 `/`。故 `FEEL` / `feel/` / `text/feel` 都认。
 * 另外接受**以 `/feel` 结尾**的 URI（`http://www.omg.org/spec/FEEL/20140401` 之类）——
 * 这类 MIME / URN 写法列不全，按"尾巴"判比穷举可靠。
 *
 * ⚠️ 不认的就是不认（`'groovy'` / `'javascript'` / `'python'` …）→ 走 `handlers` 表，
 *   查不到就报错要求宿主注册 —— **绝不**自己执行（见档首"禁止 eval"）。
 */
export const FEEL_SCRIPT_FORMATS: readonly string[] = [
  'feel',
  'text/feel',
  'application/feel',
  'http://www.omg.org/spec/feel/20140401',
];

export function isFeelScriptFormat(format: string | undefined): boolean {
  if (typeof format !== 'string') return false;
  const norm = format.trim().toLowerCase().replace(/\/+$/, '');
  if (norm === '') return false;
  if ((FEEL_SCRIPT_FORMATS as readonly string[]).includes(norm)) return true;
  return norm.endsWith('/feel');
}

// ---------------- ★ 副作用的解析结果（`NodeEffect`）与哨兵 ----------------

/**
 * 一个 `effect` 节点的**已解析**副作用。
 *
 * ⚠️ 它是**外源产物**：由 `runtime/engine.ts`（唯一允许不纯的地方）解析，
 * 纯循环只读它。这样「一次副作用只发生一次」与「`runToWait` 保持纯」才可能同时成立。
 */
export interface NodeEffect {
  readonly nodeId: string;
  /** 并入 `variables` 的增量（`serviceTask` 返回 / `scriptTask` 结果 / `decision` 输出） */
  readonly variables?: Readonly<Record<string, unknown>>;
  /**
   * 要投递的事件（**只** `manualTask` 用：连发 `taskCreated` + `taskCompleted` 留痕）。
   *
   * ⚠️ 为什么不在解析处直接 `emit`：`EventSink` 的投递时点是**槽位 9**（状态已落库之后）。
   *   在解析处就发，一旦后续步骤抛错（比如后面的节点解析不出办理人），
   *   就会出现「事件说这个任务办完了、状态却没落库」—— 正是 §7.1 要防的那类不一致。
   */
  readonly events?: readonly EngineEvent[];
}

/** 什么都没有的副作用（直通节点的返回；测试夹具的默认值） */
export const NO_EFFECT: NodeEffect = { nodeId: '' };

/**
 * ★ **副作用尚未解析**的哨兵（与 `eval/condition.ts` 的 `ConditionUnresolved` 同款，
 *   **不是** 19 个抛出码之一，也不进 `EngineError` 家族）。
 *
 * 为什么需要它：`ServiceHandler` / `DecisionHandler` 都是**异步** SPI，而 `runToWait()`
 * 必须同步纯。两个显而易见的写法都错：
 *   ① **预解析全图** —— 那些节点引用的变量此刻可能还不存在，且会把**本次走不到的**
 *      服务也调一遍（发不该发的邮件）；
 *   ② **闭包缺值时返回空副作用** —— `serviceTask` 静默变成"什么都没干"，
 *      流程照走、变量没变，是最难查的一类静默失败。
 *
 * ⇒ 缺值就**抛本哨兵**，引擎解析后**重跑**；结果按 `${nodeId}::${tokenId}` 缓存 ⇒ 只调一次。
 *
 * ⚠️ 宿主**不会**从公开 API 收到它（引擎吞掉并重试）；门 2 自编排下宿主自己提供
 *   `effectsOf` 闭包，用不用本哨兵由他决定。
 */
export class NodeEffectUnresolved extends Error {
  override readonly name = 'NodeEffectUnresolved';
  /** 内部信号：便于与其它错误一眼区分（不依赖 instanceof，跨包 / 跨产物都稳） */
  readonly unresolved = true;
  readonly key: string;
  readonly nodeId: string;
  readonly tokenId: string;
  readonly kind: TaskEffectKind;
  /** ★ 到达该节点**此刻**的变量快照 —— 解析要用它，不能拿提交前的旧值 */
  readonly variables: Readonly<Record<string, unknown>>;

  constructor(args: {
    readonly key: string;
    readonly nodeId: string;
    readonly tokenId: string;
    readonly kind: TaskEffectKind;
    readonly variables: Readonly<Record<string, unknown>>;
  }) {
    super(`effect of node '${args.nodeId}' on token '${args.tokenId}' is not resolved yet`);
    this.key = args.key;
    this.nodeId = args.nodeId;
    this.tokenId = args.tokenId;
    this.kind = args.kind;
    this.variables = args.variables;
  }
}

/** 抛出哨兵（`effectsOf` 闭包在缺值时用） */
export function unresolvedEffect(args: {
  readonly nodeId: string;
  readonly tokenId: string;
  readonly kind: TaskEffectKind;
  readonly variables: Readonly<Record<string, unknown>>;
}): NodeEffectUnresolved {
  return new NodeEffectUnresolved({
    key: effectKeyOf(args.nodeId, args.tokenId),
    nodeId: args.nodeId,
    tokenId: args.tokenId,
    kind: args.kind,
    variables: args.variables,
  });
}

/** ⚠️ 缓存键**必须**带 `tokenId`：并行分支上两个令牌会同时到达同一个 `serviceTask` */
export function effectKeyOf(nodeId: string, tokenId: string): string {
  return `${nodeId}::${tokenId}`;
}

/** 判定并取出哨兵内容；不是哨兵 → `undefined`（**原样交给上层，绝不吞**） */
export function asUnresolvedEffect(e: unknown): NodeEffectUnresolved | undefined {
  if (e instanceof NodeEffectUnresolved) return e;
  if (
    typeof e === 'object' &&
    e !== null &&
    (e as { unresolved?: unknown }).unresolved === true &&
    typeof (e as { key?: unknown }).key === 'string' &&
    typeof (e as { kind?: unknown }).kind === 'string'
  ) {
    return e as NodeEffectUnresolved;
  }
  return undefined;
}

// ---------------- 结果校验（`eval/condition.ts` 的同款纪律） ----------------

/**
 * ★ 宿主处理器返回值形状校验：**必须是扁平的普通对象**。
 *
 * 不校验的后果：`serviceTask` 返回 `undefined`（忘了 return）会被静默当成"没有变量要并"，
 * 流程照走、值没写进去 —— 与「求值失败必须抛错」（AC-E9 第 0 层要求）同一类事故。
 */
export function assertVariablePatch(
  nodeId: string,
  kind: TaskEffectKind,
  value: unknown,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw stateShapeInvalid(
      `${kind} handler of node '${nodeId}' must return a plain object of variables`,
      { nodeId, kind, returned: value === undefined ? 'undefined' : Array.isArray(value) ? 'array' : typeof value },
    );
  }
  return { ...(value as Record<string, unknown>) };
}
