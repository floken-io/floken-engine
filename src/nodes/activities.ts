/**
 * @floken-io/engine · **活动 / 子流程 4 类的执行语义**（T18 · `nodes/activities.ts`）
 *
 * 契约来源：`03-engine` §6「活动 / 子流程（4）」+ FR-E12 / E13 / E18 / E24 的例外登记。
 *
 * ★ 为什么单独一档（与 `nodes/events.ts` / `nodes/tasks.ts` 同一个理由）：4 类在 XML 里
 *   都是容器 / 调用，但**执行语义完全不同** —— 内嵌子流程要**展开成图的一部分**，
 *   调用活动要**另起一个实例**并等它回来，另外两类已知但**跑不了**。
 *
 * ## ★ 四类怎么分（判据：能不能在**单实例的扁平令牌模型**里正确表达）
 *
 * | 类型 | 处置 | 理由 |
 * |---|---|---|
 * | `SubProcess` | **内嵌展开**（建图时拍平进父图） | 它没有自己的实例、自己的 rev、自己的待办；所谓"子令牌树"在本引擎里就是**令牌走进展开后的那几个节点**。拍平后 `nextOf` / `reachable` / 汇聚 / `completedNodes` 全部照旧工作，不需要第二套遍历 |
 * | `CallActivity` | **子实例 + 等待 + 自动回归** | 被调用的是**另一个 processId**：它有自己的版本绑定（INV-16）、自己的实例 id、自己的待办 —— 这三件事拍平都表达不了，必须另起实例 |
 * | `AdHocSubProcess` | **显式抛错**（FR-E18，C 级） | "由运行时决定执行哪些节点"是一整套编排语义，本引擎尚未定义它的输入 |
 * | `Transaction` | **显式抛错**（FR-E13 / T21） | 它的全部意义在**补偿**，而补偿要靠边界事件（`cancel` / `compensate`），那是 T21 |
 *
 * ## ★ 内嵌展开的三条硬规则
 *
 *   ① **只展 `triggeredByEvent !== true` 的 `subProcess`** —— 事件子流程是"被事件触发"的，
 *      与"走进去再出来"是两回事（FR-E24 / T21），展开它等于把它当成顺序执行。
 *   ② **内嵌的 `endEvent` 改写成一个引擎内部类型**（`SUBPROCESS_EXIT_TYPE`）。
 *      不改的话令牌到达内嵌结束事件会按"结束事件"处理 → **令牌直接终结**，
 *      子流程出口后面的节点永远走不到 —— 那是最难查的一类静默截断。
 *   ③ **进 / 出的流要重接**：指向子流程的流改指它的**内嵌 startEvent**；
 *      子流程的出向流改由**每个内嵌出口**各发一份（多出口 = 多份，条件照抄）。
 *
 * ## ★ `CallActivity` 的版本绑定（INV-16）
 *
 *   被调用定义的版本**必须**是设计期显式写的，引擎**不**替宿主"取最新版" ——
 *   那正是 `AC-E10` 要防的事：主流程没改，被调用的子流程悄悄换了版本，
 *   在途实例的行为随发布而变。故版本读 `extension['floken:call'].version`，
 *   **没有就抛**（不是回退、不是猜）。
 *
 *   ⚠️ 为什么是 extension 而不是一等字段：BPMN **没有**"被调用版本"这个标准属性
 *   （Camunda 用自家 `calledElementVersion` 属性，不是 OMG 的），而模型层目前也没有对应的一等字段。
 *   此处按 `01-moddle` §4.5 的 extension 袋约定落键 `floken:call`，
 *   待模型层把它升成一等字段后本档只需改取值处 —— **语义不变**。
 */

import type { Flow, FlowNode } from '@floken-io/moddle';

import { stateShapeInvalid } from '../core/errors.js';
import { clearAssignment, markCompleted } from '../core/primitives.js';
import type { InstanceParent, InstanceState, Token } from '../core/state.js';
import { cloneState } from '../core/state.js';

// ---------------- 4 类活动 / 子流程 ----------------

/**
 * 活动族的全部 4 类（`03-engine` §6 的登记名，**顺序即契约**）。
 *
 * ⚠️ 不手列第二份：外部（测试 / 探针）要数活动类数就用 `ACTIVITY_TYPES.length`。
 */
export const ACTIVITY_TYPES = [
  'subProcess',
  'adHocSubProcess',
  'transaction',
  'callActivity',
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** 该类型是不是活动族 */
export function isActivityType(type: string | undefined): boolean {
  return (ACTIVITY_TYPES as readonly string[]).includes(type ?? '');
}

/**
 * 活动的执行语义。
 * - `'call'` —— 调用另一个流程定义：令牌**停在这里**（`waiting`，不产生待办）等子实例回来。
 * - `'unsupported'` —— 已知但**未实现**（AdHoc / Transaction / 事件子流程），见档首表格。
 *
 * ⚠️ 表里**没有** `'inline'`：`SubProcess` 在建图时就已经被拍平，运行期**不该**再遇到它。
 *   运行期还能看到一个 `subProcess` 节点，只有一种可能 = 它是**没被展开**的那类
 *   （`triggeredByEvent` 的事件子流程）—— 于是它归 `unsupported`，归属 FR-E24 / T21。
 */
export type ActivityBehavior = 'call' | 'unsupported';

/** 是活动 → 返回它的执行语义；不是活动 → `undefined` */
export function activityBehaviorOf(type: string | undefined): ActivityBehavior | undefined {
  switch (type) {
    case 'callActivity':
      return 'call';
    case 'subProcess':
    case 'adHocSubProcess':
    case 'transaction':
      return 'unsupported';
    default:
      return undefined;
  }
}

/** 令牌到达了「已知但尚未实现」的活动 → **抛**，绝不静默直通 */
export function assertActivitySupported(
  type: string,
  nodeId: string,
  behavior: ActivityBehavior,
): void {
  if (behavior !== 'unsupported') return;
  const owner: Record<string, string> = {
    subProcess: 'FR-E24 / T21（事件子流程 triggeredByEvent）',
    adHocSubProcess: 'FR-E18（运行时编排）',
    transaction: 'FR-E13 / T21（边界事件与补偿）',
  };
  throw stateShapeInvalid(`node '${nodeId}' is a '${type}', which is not executable yet`, {
    nodeId,
    type,
    owner: owner[type] ?? 'unknown',
    behavior,
    hint: '该活动类型已知但尚未实现；引擎刻意不把它降级成自动直通（那会让"这段子流程从来没执行过"变成静默事实）',
  });
}

// ---------------- 内嵌展开（SubProcess → 父图的一部分） ----------------

/** 展开后的节点 id 分隔符（`Sub_1/Start_1`）。用 `/` 是为了与 `taskId` 的 `:` 不撞。 */
export const SUBPROCESS_PATH_SEP = '/';

/**
 * ★ 内嵌子流程的**出口节点**在展开后的类型 —— **引擎内部类型，不是 BPMN 类型**。
 *
 * 为什么必须换掉 `endEvent`：`runtime/loop.ts` 一见 `endEvent` 就把令牌判终结。
 * 内嵌子流程的结束事件语义是"**离开子流程**"，不是"实例结束"。
 * 换成专用类型后它落到**自动直通**那条路，沿重接好的出向流继续走 —— 语义才对得上。
 */
export const SUBPROCESS_EXIT_TYPE = 'subProcessExit';

/** 拍平后的一份定义（`nodes` + `flows`；节点 id 已按层级加前缀） */
export interface FlattenedProcess {
  readonly nodes: readonly FlowNode[];
  readonly flows: readonly Flow[];
}

/**
 * ★ 把一份定义里的内嵌子流程**递归拍平**。
 *
 * @throws `ENGINE_STATE_SHAPE_INVALID` —— 内嵌子流程缺节点 / 缺 `startEvent` / 缺 `endEvent`
 *         （这三条都是"画不出来却说跑了"的定义缺陷，必须在**建图时**就报出来，
 *          不能等令牌走进去才发现 —— 那时已经写了一半状态）
 */
export function expandSubProcesses(
  nodes: readonly FlowNode[],
  flows: readonly Flow[],
): FlattenedProcess {
  return flatten(nodes, flows, '');
}

/** 只展这一类：普通内嵌子流程（**不是**事件子流程） */
function isExpandable(n: FlowNode): boolean {
  return (
    n.type === 'subProcess' &&
    n.triggeredByEvent !== true &&
    Array.isArray(n.nodes) &&
    n.nodes.length > 0
  );
}

function flatten(
  nodes: readonly FlowNode[],
  flows: readonly Flow[],
  prefix: string,
): FlattenedProcess {
  const outNodes: FlowNode[] = [];
  const outFlows: Flow[] = [];
  /** 本层被展开的子流程：原 id → { 入口（内嵌 startEvent 的展开后 id）, 出口[] } */
  const subs = new Map<string, { readonly entry: string; readonly exits: readonly string[] }>();

  for (const n of nodes) {
    if (n === null || typeof n !== 'object' || typeof n.id !== 'string') continue;

    if (!isExpandable(n)) {
      outNodes.push(rename(n, prefix));
      continue;
    }

    const children = (n.nodes ?? []).filter(
      (c) => c !== null && typeof c === 'object' && typeof c.id === 'string',
    );
    const childPrefix = `${prefix}${n.id}${SUBPROCESS_PATH_SEP}`;

    const starts = children.filter((c) => c.type === 'startEvent');
    const ends = children.filter((c) => c.type === 'endEvent');
    if (starts.length !== 1) {
      throw stateShapeInvalid(
        `embedded subProcess '${prefix}${n.id}' must have exactly one startEvent (found ${starts.length})`,
        { nodeId: `${prefix}${n.id}`, found: starts.length },
      );
    }
    if (ends.length === 0) {
      throw stateShapeInvalid(
        `embedded subProcess '${prefix}${n.id}' has no endEvent —— 令牌进去就出不来了`,
        { nodeId: `${prefix}${n.id}` },
      );
    }

    const inner = flatten(children, n.flows ?? [], childPrefix);
    const endIds = new Set(ends.map((e) => e.id));
    for (const c of inner.nodes) {
      // ② 内嵌结束事件 → 出口节点（不改的话令牌到达即终结，子流程出口后的节点永远走不到）
      const local = c.id.startsWith(childPrefix) ? c.id.slice(childPrefix.length) : c.id;
      outNodes.push(endIds.has(local) ? { ...c, type: SUBPROCESS_EXIT_TYPE } : c);
    }
    outFlows.push(...inner.flows);

    const entry = `${childPrefix}${(starts[0] as FlowNode).id}`;
    const exits = ends.map((e) => `${childPrefix}${e.id}`);
    subs.set(n.id, { entry, exits });
  }

  // ③ 重接本层的流：进子流程 → 进它的入口；出子流程 → 由它的每个出口各发一份
  for (const f of flows) {
    if (f === null || typeof f !== 'object') continue;
    if (typeof f.from !== 'string' || typeof f.to !== 'string') continue;

    const fromSub = subs.get(f.from);
    const toSub = subs.get(f.to);
    const fromIds: readonly string[] = fromSub === undefined
      ? [`${prefix}${f.from}`]
      : fromSub.exits;
    const to = toSub === undefined ? `${prefix}${f.to}` : toSub.entry;

    for (const from of fromIds) {
      const base = typeof f.id === 'string' ? `${prefix}${f.id}` : undefined;
      // 多出口时 flow id 必须区分（同一条出向流被复制成 N 份，id 撞车会让条件缓存互相覆盖）
      const id = base === undefined
        ? undefined
        : fromIds.length > 1
          ? `${base}@${from}`
          : base;
      outFlows.push({ ...f, ...(id === undefined ? {} : { id }), from, to });
    }
  }

  return { nodes: outNodes, flows: outFlows };
}

/** 加层级前缀；同时修正引用了节点 / 流 id 的一等字段（不加前缀就会指到不存在的节点） */
function rename(n: FlowNode, prefix: string): FlowNode {
  if (prefix === '') return n;
  const out: FlowNode = { ...n, id: `${prefix}${n.id}` };
  if (typeof n.defaultFlow === 'string' && n.defaultFlow.length > 0) {
    out.defaultFlow = `${prefix}${n.defaultFlow}`;
  }
  if (typeof n.attachedTo === 'string' && n.attachedTo.length > 0) {
    out.attachedTo = `${prefix}${n.attachedTo}`;
  }
  return out;
}

// ---------------- CallActivity 的版本绑定（INV-16） ----------------

/** ★ `callActivity` 的版本绑定扩展键（见档首"版本绑定"一节） */
export const CALL_EXT_KEY = 'floken:call';

/** 被调用目标：`processId` + **设计期显式绑定**的 `definitionVersion` */
export interface CallTarget {
  readonly processId: string;
  readonly definitionVersion: number;
}

/**
 * ★ 读一个 `callActivity` 的被调用目标。
 *
 * @returns 非 `callActivity` → `undefined`；是 `callActivity` → 目标
 * @throws `ENGINE_STATE_SHAPE_INVALID` —— 是 `callActivity` 但**没绑定版本**（INV-16）：
 *         此处**绝不**回退到"最新版"。回退的代价是「主流程没改、子流程悄悄换了版本，
 *         在途实例行为随发布而变」—— 正是 `AC-E10` 要防的那件事，且它**没有任何报错**。
 */
export function callTargetOf(node: FlowNode | undefined): CallTarget | undefined {
  if (node === undefined || node.type !== 'callActivity') return undefined;

  const raw = node.extension?.[CALL_EXT_KEY];
  const version =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)['version']
      : undefined;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw stateShapeInvalid(
      `callActivity '${node.id}' must bind an explicit definition version (INV-16)`,
      {
        nodeId: node.id,
        // 诊断文案**刻意不逐字写**禁用 API 名（有一道源码扫描门禁），语义照样讲清楚
        hint: `在该节点的 extension['${CALL_EXT_KEY}'] 上写 { version: <正整数> }；引擎不替宿主取最新版（AC-E10）`,
        got: version === undefined ? 'undefined' : String(version),
      },
    );
  }

  const processId = typeof node.calledElement === 'string' ? node.calledElement.trim() : '';
  if (processId === '') {
    throw stateShapeInvalid(`callActivity '${node.id}' has no calledElement (the process to call)`, {
      nodeId: node.id,
      hint: '给该节点写 calledElement = 被调用流程的 processId',
    });
  }

  return { processId, definitionVersion: version };
}

// ---------------- ★ 令牌停在 `callActivity` 上等子实例 ----------------

/**
 * 一次"调用子流程"的**待创建规格**（纯数据，由纯循环产出、由 `runtime/engine.ts` 兑现）。
 *
 * ⚠️ 为什么 `variables` 要**自带快照**：子实例的初始变量是「令牌停在 `callActivity`
 *   那一刻」的父变量，而不是提交前的旧值 —— 不带上就是「脚本 / 服务刚改过 amount，
 *   子流程却按旧值跑」，与 D-60 同一类事故。
 */
export interface PendingCall {
  readonly nodeId: string;
  readonly tokenId: string;
  /** ★ 子实例的 instanceId（**确定性**，见 `callInstanceIdOf`） */
  readonly instanceId: string;
  readonly processId: string;
  readonly definitionVersion: number;
  readonly variables: Readonly<Record<string, unknown>>;
}

/**
 * ★ 子实例的 instanceId —— **确定性**，由父实例 + 节点 + 令牌唯一决定。
 *
 * 为什么必须确定性：纯循环里就要把它写进父 state 的 `childInstanceIds`（审计与
 * 「父终止时顺带停掉子实例」都靠这份名单）。若让 `runtime/engine.ts` 随机生成一个再回填，
 * 就得多写一次父状态 —— 而多一次写 = 多一个 rev = 多一处可能的不一致。
 *
 * ⚠️ 为什么带序号后缀：循环回到同一个 `callActivity`（驳回重办）时基名会完全相同，
 *   直接复用的话 `save(next, 0)` 会撞 `ENGINE_PERSIST_ALREADY_EXISTS`。
 *   序号从**已有的同名个数**推出来 —— 纯函数可算，且与执行顺序无关。
 */
export function callInstanceIdOf(
  state: Pick<InstanceState, 'instanceId' | 'childInstanceIds'>,
  nodeId: string,
  tokenId: string,
): string {
  const base = `${state.instanceId}::${nodeId}::${tokenId}`;
  const taken = (state.childInstanceIds ?? []).filter(
    (id) => id === base || id.startsWith(`${base}#`),
  );
  return taken.length === 0 ? base : `${base}#${taken.length}`;
}

/**
 * ★ 把令牌停在 `callActivity` 上等子实例 —— **纯函数**（改的是调用方给的那份副本）。
 *
 * 三件事，一件都不能少：
 *   ① `state = 'waiting'` —— 它不是待办（`tasksOf` 只认 `active`），但**算在途**
 *      （`LIVE_TOKEN_STATES` 含 `waiting`）⇒ 实例不会因此被判完成、也不会被并发推进；
 *   ② 子实例 id 进 `childInstanceIds` —— 父终止时要靠这份名单把子实例一起停掉，
 *      否则「主流程终止了、子流程还在产生待办」；
 *   ③ 返回 `PendingCall` —— 由 `runtime/engine.ts` 兑现（建实例要写存储，纯循环干不了）。
 *
 * ⚠️ **不**在这里 `markCompleted(nodeId)`：节点是"离开时才记账"，而令牌此刻还没离开 ——
 *    记账要等子实例回来（`runtime/engine.ts` 的回归路径）。提前记账会让它成为合法的驳回目标，
 *    而它其实还压着一条没回来的子流程。
 */
export function parkForCall(
  next: InstanceState,
  token: Token,
  target: CallTarget,
): PendingCall {
  const instanceId = callInstanceIdOf(next, token.nodeId, token.id);
  token.state = 'waiting';

  const known = next.childInstanceIds ?? [];
  if (!known.includes(instanceId)) next.childInstanceIds = [...known, instanceId];

  return {
    nodeId: token.nodeId,
    tokenId: token.id,
    instanceId,
    processId: target.processId,
    definitionVersion: target.definitionVersion,
    variables: { ...next.variables },
  };
}

// ---------------- ★ 子实例回归（父实例那一侧） ----------------

/**
 * ★ 子实例结束时写在**父实例**审计里的动作名。
 *
 * ⚠️ 它**不是** 19 项动作之一（宿主提交不了它），也不是 10 个内核原语之一 ——
 * 它是"子实例回来了"这条**内核内部事实**。`03` §9.1 的 `AuditEntry.action`
 * 原文写「19 项动作名 或 内核原语名」，此处是第三类：**内核内部推进名**，
 * 目前已登记的只有这一个（见 `ARCHITECTURE.md` 的 D-62）。
 *
 * 为什么不复用 `approve` 之类的现有名字：审计是**合规主源**，
 * 把"子流程自己跑完了"记成"某人审批通过"，等于伪造一条操作记录。
 */
export const CALL_RETURN_ACTION = 'callActivityReturn';

/**
 * ★ 子实例回归 —— 把父实例里那条停在 `callActivity` 上的令牌**放行**：纯函数。
 *
 * 三步，顺序是契约：
 *   ① **先记账**（`markCompleted`）：节点是"离开时才记账"，而这一步正是离开 ——
 *      它是 `INV-6` 驳回目标的来源，漏了就永远退不回这个节点；
 *   ② 令牌转 `active` 并挪到后继节点 —— 转回 `active` 才会被 `runToWait` 继续推进；
 *   ③ **清办理人**（`clearAssignment`）：新节点的办理人要重新解析，带着旧人的
 *      `assignee` 走过去会让下一条待办落在错误的人名下（与 D-25 同口径）。
 *
 * @param nextNodeId 后继节点 —— 由调用方从 `graph.nextOf(parent.nodeId)` 取好传进来
 *        （本档不 import `ProcessGraph`，避免与 `nodes/graph.ts` 形成值层面的循环依赖）
 * @throws `ENGINE_STATE_SHAPE_INVALID` —— 找不到那条令牌 / 它不在 `waiting`
 *         （"该等的人不等了"是状态被外部改坏的信号，必须报出来）
 */
export function callReturnOf(
  state: InstanceState,
  parent: InstanceParent,
  nextNodeId: string,
): InstanceState {
  const next = cloneState(state);
  const token = next.tokens.find((t) => t.id === parent.tokenId);
  if (token === undefined) {
    throw stateShapeInvalid(
      `callActivity return: parent instance '${state.instanceId}' has no token '${parent.tokenId}'`,
      { instanceId: state.instanceId, tokenId: parent.tokenId },
    );
  }
  if (token.state !== 'waiting') {
    throw stateShapeInvalid(
      `callActivity return: token '${token.id}' is '${token.state}', expected 'waiting'`,
      { instanceId: state.instanceId, tokenId: token.id, tokenState: token.state },
    );
  }
  markCompleted(next, parent.nodeId);
  token.state = 'active';
  token.nodeId = nextNodeId;
  clearAssignment(token);
  return next;
}
