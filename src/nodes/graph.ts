/**
 * @floken-io/engine · 定义图适配层（`ProcessDefinition` → 引擎能问的问题）
 *
 * ★ 为什么要单独一层：`ProcessDefinition` 是**模型层**的形状（XML 的镜像），
 *   引擎要问的是另一套问题（"发起节点是谁"、"这个节点的下一个节点是谁"、"它的审批配置是什么"）。
 *   直接在 `runtime/` 里散写 `def.processes[0].flows.find(...)` 有三个后果：
 *     ① 同一份查询逻辑复制 N 份，改一处漏一处；
 *     ② `INV-3`（token.nodeId 必须在定义图中）没有唯一的判定点；
 *     ③ 图算法（T16 网关 / T18 子流程）深化时，`runtime/` 会被改烂。
 *   故收敛成**只读适配器**：本文件**不持有状态**，也不改 `ProcessDefinition`。
 *
 * ★ 分层：`nodes/` 可 import `core/` 与模型层；`core/` 不得反向 import 本目录。
 *
 * ⚠️ **T16 / T17 / T18 落地后的能力边界（诚实标注，勿含糊成"支持"）**：
 *   - 认得全部 **6 类事件 + 5 类网关 + 8 类任务**（分类与可达性见图适配层），但其中
 *     `intermediateThrowEvent` / `implicitThrowEvent` /
 *     `complexGateway` / `sendTask` 一律**显式抛错**（分属 T20 / FR-E24 / FR-E17 / T20）；
 *   - ★ **T20 起 `intermediateCatchEvent` / `receiveTask` 可执行**：令牌停在它们上面
 *     **等外部投递**（`deliverMessage` / `deliverSignal`）；但等 `timer` / `error` 之类
 *     仍抛（归 v1.x），没写 `messageRef` / `signalRef` 也抛（等不到 = 永久卡死）；
 *   - ★ **T21 起 `boundaryEvent` / `eventBasedGateway` 可执行**：前者挂在活动上监听、
 *     按 `cancelActivity` 决定中断与否；后者**竞速**（第一个到达的事件赢，其余分支取消）；
 *   - **单出向的普通节点**（`userTask` 等）有多条 `sequenceFlow` → 仍抛 `D-22`
 *     （"隐式排他 / 隐式包容"没有规格依据，不发明）；多出向**只**在网关上被路由；
 *   - **T18 起内嵌子流程在建图时展开**（`nodes/activities.ts` 的 `expandSubProcesses`），
 *     故本档拿到的 `nodes` / `flows` 已是**拍平后**的全表 —— 展开规则见该文件档首。
 *   把这三点写成显式抛错而不是"取第一条流走下去"，是为了让"这条流程现在跑不了"
 *   表现为**一条能照着修的错误**，而不是"流程静默走错分支"。
 */

import type { Flow, FlowNode, NormalizedApproval, ProcessDefinition } from '@floken-io/moddle';

import { requirePeer } from '../core/peer.js';

import { definitionMissing, stateShapeInvalid, tokenOrphan } from '../core/errors.js';
import { SUBPROCESS_PATH_SEP, callTargetOf, expandSubProcesses } from './activities.js';
import type { CallTarget } from './activities.js';
import { boundaryBindingOf } from './boundary.js';
import type { BoundaryBinding } from './boundary.js';
import { catchBindingOf } from './catch.js';
import type { CatchBinding } from './catch.js';

/**
 * 惰性取 `@floken-io/moddle`（Q49：peer 依赖，不再内置）。
 *
 * ★ 只取**本档真正用到的**那一个函数，并把解析结果缓存到模块级变量 ——
 *   建图时每个带审批配置的节点都要走一次，不能每次都做一遍模块解析。
 * ★ 首次**用到**才解析：只 import engine 不建图不会被缺失的 peer 打断。
 */
type ModdleSlice = Pick<typeof import('@floken-io/moddle'), 'normalizeApproval'>;

let moddleCache: ModdleSlice | undefined;
function moddle(): ModdleSlice {
  return (moddleCache ??= requirePeer<ModdleSlice>('@floken-io/moddle', {
      neededFor: 'approval semantics: normalizeApproval() when building the definition graph',
      range: '>=0.1.0 <0.2.0',
    },
  ));
}

// ---------------- 引擎关心的节点分类 ----------------

/**
 * **等待类**：令牌到这里要等人办，run-to-wait 在此停下（ADR-003 的"稳定点"）。
 *
 * T11 只有 `userTask`；`manualTask` / `receiveTask` 在 T17 补。
 */
export const WAITING_NODE_TYPES: readonly string[] = ['userTask'];

/** **结束类**：令牌到达即该令牌完成；全部令牌完成 → 实例 `completed`。 */
export const TERMINAL_NODE_TYPES: readonly string[] = ['endEvent'];

/*
 * ★ **这里曾经有一道"排除模型一等字段键"的逻辑，2026-10-06 删除**（ADR-009 细则③）。
 *
 * 它的来龙去脉：v1 排除 `floken:*` 前缀（那时审批语义**住在** `extension['floken:approval']`
 * 里，前缀是 XML 命名空间的产物）；v2 把 `approval` / `call` / `eventDefinition` 提升为
 * 一等字段后，判据改成"排除 `NODE_RESERVED_KEYS`"。
 *
 * **v2 里这道逻辑已经没有对象了**：一等字段在 `node.approval`，**不在** `node.extension` 里。
 * 于是 `extension` 里出现 `approval` 只有一种可能 —— **宿主自己的业务数据**。
 * 再排除它就不是"不外泄内部语义"，而是**静默吃掉宿主的数据**，
 * 直接违背「`extension` 是宿主的地盘，引擎不解读、不改写、**不筛选**」这条承诺。
 *
 * 那"作者把审批误写进 extension"谁来管？—— **moddle 校验层给 warn 指路**（不拒绝数据）。
 * 引擎不接管这件事：它连模型是哪儿来的都不知道，判不了"你是不是想配审批"。
 */

/**
 * ★ ADR-009 细则④：**结构化值也给**（v2 起放开，2026-10-03 改定）。
 *
 * v1 只给标量，理由是「结构化值写不进 XML 属性」。**那个理由随 XML 一起消失了** ——
 * moddle v2 的 `extension` 就是 `Record<string, unknown>`，对象和数组天然保真。
 * 继续只给标量的代价是：宿主能**存** `rule: {maxAmount: 5000}`，却**读不进**条件表达式。
 *
 * 唯一仍然排除的是**函数**：它会让后续任何 `JSON.stringify`
 * （state 落库、诊断详情）静默丢字段或直接炸掉。
 */
function isUsableExtensionValue(v: unknown): boolean {
  return typeof v !== 'function' && typeof v !== 'undefined';
}

/** `moddle` 保全袋里第三方原样快照的键（不是属性，不给宿主） */
const RAW_SNAPSHOT_KEY = '_extensionElements';

/** 一条**出向流**（引擎视角）：条件已归一化成"表达式文本或空" */
export interface OutFlow {
  readonly id: string;
  readonly to: string;
  /** 条件表达式；无条件（BPMN 的默认流）→ `undefined`（D-42：空 = 走） */
  readonly expression?: string;
}

/** 一条**入向流** */
export interface InFlow {
  readonly id: string;
  readonly from: string;
}

export function isWaitingNode(type: string): boolean {
  return WAITING_NODE_TYPES.includes(type);
}

export function isTerminalNode(type: string): boolean {
  return TERMINAL_NODE_TYPES.includes(type);
}

/**
 * 取 `Flow.condition` 的表达式文本（`string` 简写 / `FormalExpression` 全写两种都收）。
 *
 * ⚠️ 只认 **trim 后非空** 的：`''` 与 `'   '` 一律视为**无条件**（D-42），
 * 而不是"有一个空表达式要去求值" —— 空 = 明确声明"无条件"，与"写坏了"是两回事。
 */
export function expressionOf(condition: Flow['condition']): string | undefined {
  if (condition === undefined || condition === null) return undefined;
  const text =
    typeof condition === 'string'
      ? condition
      : typeof condition === 'object' && typeof condition.body === 'string'
        ? condition.body
        : undefined;
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  return trimmed === '' ? undefined : trimmed;
}

// ---------------- 适配器 ----------------

export interface ProcessGraph {
  readonly processId: string;
  readonly definitionVersion: number;
  /** 发起节点 id（第一个 `startEvent`） */
  readonly startNodeId: string;
  /** 图中全部节点 id（含 startEvent / endEvent） */
  nodeIds(): readonly string[];
  /** `INV-3` 的判定点 */
  has(nodeId: string): boolean;
  /** 节点类型；不在图里返回 `undefined` */
  typeOf(nodeId: string): string | undefined;
  nameOf(nodeId: string): string | undefined;
  formKeyOf(nodeId: string): string | undefined;
  /**
   * 出向的**唯一**后继。
   * - 无出向（如 `endEvent`）→ `undefined`
   * - 恰好 1 条 → 目标 id
   * - 2 条及以上 → **抛错**（D-22：多出向只在**网关**上被路由，
   *   普通节点的多出向语义无规格依据，不得静默取第一条）
   */
  nextOf(nodeId: string): string | undefined;
  /** ★ 出向流全表（T16：网关路由的输入）。顺序 = 定义里的顺序，**即分支判定的优先级** */
  outFlowsOf(nodeId: string): readonly OutFlow[];
  /** ★ 入向流全表（T16：网关汇聚要判"还有没有人能来"） */
  inFlowsOf(nodeId: string): readonly InFlow[];
  /**
   * 默认流（`Gateway.default` / `Activity.default`）—— 指向一条 `sequenceFlow` 的 id。
   * 只在「**一条都没选中**」时才走（`exclusive` / `inclusive` 同口径）。
   */
  defaultFlowIdOf(nodeId: string): string | undefined;
  /**
   * ★ 图上可达性：`from` 沿出向能否走到 `to`（T16 汇聚判据的基础）。
   *
   * - `from === to` → **false**（"我自己在网关上"不算"还有人能来"）；
   * - 只走 `sequenceFlow`，不判条件 —— 判据要的是「**可能**到达」，
   *   按条件剪枝会把"条件此刻为假但稍后可能为真"算成不可达，从而提前合流。
   */
  reachable(from: string, to: string): boolean;
  /** 该节点的审批配置（**已归一化**）；未配置 → `undefined` */
  approvalOf(nodeId: string): NormalizedApproval | undefined;
  /**
   * 该节点上配的 `floken:approval` 键是否**存在**（未归一化前）。
   * 用于区分「没配」与「配了但归一化失败」—— 后者由 `normalizeApproval` 自己抛。
   */
  hasApproval(nodeId: string): boolean;
  // —— T17：任务类节点的取参（`nodes/tasks.ts` 的分类决定要不要读）——
  /** `<bpmn:script>` 子元素（`scriptTask`）；未配 / 空白 → `undefined` */
  scriptOf(nodeId: string): string | undefined;
  /** `scriptFormat`（`scriptTask`）；未配 → `undefined`（⇒ 不是 FEEL，走 `handlers` 表） */
  scriptFormatOf(nodeId: string): string | undefined;
  /**
   * ★ `serviceTask` / 非 FEEL 的 `scriptTask` 在 `handlers` 表里的**查找键**。
   *
   * 三级回退：`implementation`（非 `##` 前缀的内置标识）→ `operationRef` → **`nodeId`**。
   *
   * ⚠️ 为什么 `##unspecified` / `##WebService` 不算：那是 BPMN 的**实现标识**，
   *    不是宿主处理器的名字 —— 拿它去查 `handlers` 必然查不到，报错还会指错方向。
   *
   * ⚠️ 为什么最后回退到 `nodeId`：让「每个服务节点一个 handler」成为零配置可用形态
   *    （`AC-E13` 的精神），而不是逼宿主为每个节点写一遍 `implementation`。
   */
  handlerRefOf(nodeId: string): string;
  /**
   * ★ `callActivity` 的被调用目标（T18 · **INV-16** 的落点）。
   *
   * - 不是 `callActivity` → `undefined`；
   * - 是 `callActivity` 但**没绑定版本** → **抛**（绝不回退到"最新版"，理由见
   *   `nodes/activities.ts` 的 `callTargetOf`）。
   */
  callTargetOf(nodeId: string): CallTarget | undefined;
  /**
   * ★ 该节点在等什么（T20 · `intermediateCatchEvent` / `receiveTask`）。
   *
   * - 不是等待节点 → `undefined`；
   * - 是等待节点但**没写名字**（缺 `messageRef` / `signalRef`）→ **抛**
   *   （这样的节点永远等不到东西，放行 = 埋一个不报错的永久卡死）；
   * - 是等待节点但等的是 `timer` / `error` 之类 → **抛**（归 T21）。
   *
   * ⚠️ 判据不在本档而在 `nodes/catch.ts`：等待语义**横跨**事件族与任务族。
   */
  catchOf(nodeId: string): CatchBinding | undefined;
  /**
   * ★ 挂在 `nodeId` 上的**边界事件**（T21）。没有 → 空数组（**不是** `undefined`，
   * 免得每个调用点都要判空）。
   *
   * ⚠️ 索引在**建图时**建好并**eager 校验**（与 `expandSubProcesses` 同口径）：
   * 边界事件的定义缺陷（悬空 / 触发种类不可投递 / 没有出向）在建图时就会抛出，
   * 而不是等触发 —— 那时已经写了一半状态。
   */
  boundaryOf(nodeId: string): readonly BoundaryBinding[];
  /**
   * ★ 该节点上的**宿主自定义**扩展属性（ADR-009 细则①②③④）。
   *
   * 给出去的是**原样键值**，引擎**不解释**任何宿主属性是什么意思 ——
   * 解释权 100% 在宿主（源码里不得出现任何具体宿主键名）。
   *
   * - **原样给出**：`extension` 是宿主的地盘，引擎**不解读、不改写、不筛选** ——
   *   与一等字段同名的键也照给（那是宿主自己的数据，引擎没资格替他决定要不要）；
   * - **结构化值也给**（数组 / 对象原样；只有函数与 `undefined` 排除）；
   * - **一个都没有 → `undefined`**（不填空对象 —— 调用方要能区分「没配」与「配了但被过滤空」）。
   */
  extensionsOf(nodeId: string): Readonly<Record<string, unknown>> | undefined;
}

/**
 * 建一张只读图。
 *
 * @throws `ENGINE_STATE_DEFINITION_MISSING` —— 找不到该 `processId` 的 process / 没有 `startEvent`
 */
export function createProcessGraph(
  definition: ProcessDefinition,
  processId: string,
  definitionVersion: number,
): ProcessGraph {
  if (definition === null || typeof definition !== 'object') {
    throw definitionMissing(processId, definitionVersion);
  }
  /*
   * ★ moddle v2（Q48）：`processes[]` 这一层**已删除**，节点与连线上提到顶层。
   * 一个定义就是一个流程 —— 于是「找 process」退化为「校验 definition.id」。
   */
  if (typeof definition.id !== 'string' || definition.id !== processId) {
    throw definitionMissing(processId, definitionVersion);
  }
  if (!Array.isArray(definition.nodes) || !Array.isArray(definition.flows)) {
    throw definitionMissing(processId, definitionVersion);
  }

  /*
   * ★ T18：**先拍平再建图**。
   *
   * 内嵌子流程在此展开成"父图的一部分"（节点 id 带层级前缀），于是下游全部逻辑
   * —— `nextOf` / `reachable` / 网关汇聚 / `completedNodes` / `tasksOf` ——
   * **一行都不用改**就知道"子流程里还有哪些节点"。这是选择"展开"而不是
   * "运行期另起一套子令牌树"的全部理由：后者要给上面每一处都加一遍"如果在子流程里"。
   */
  const flat = expandSubProcesses(definition.nodes, definition.flows);
  const flatNodes = flat.nodes;
  const flatFlows = flat.flows;

  const nodes = new Map<string, FlowNode>();
  for (const n of flatNodes) {
    if (n === null || typeof n !== 'object' || typeof n.id !== 'string') continue;
    // 重复 id 是定义自身的问题；取最后一个会掩盖它，取第一个同样会 —— 这里直接抛，
    // 与「推定不了 = 不允许」同一条纪律（白名单式，见 `actions/gates.ts`）。
    if (nodes.has(n.id)) {
      throw stateShapeInvalid(`duplicate node id '${n.id}' in process '${processId}'`, {
        processId,
        nodeId: n.id,
      });
    }
    nodes.set(n.id, n);
  }

  /** from → 出向流列表（只收 `sequenceFlow`；`association` 是节点不是流） */
  const out = new Map<string, OutFlow[]>();
  /** to → 入向流列表（T16：汇聚判据要用） */
  const inn = new Map<string, InFlow[]>();
  for (const f of flatFlows) {
    if (f === null || typeof f !== 'object') continue;
    if (typeof f.from !== 'string' || typeof f.to !== 'string') continue;
    const flowId = typeof f.id === 'string' ? f.id : `flow:${f.from}->${f.to}`;
    const expr = expressionOf(f.condition);
    const outList = out.get(f.from);
    if (outList === undefined) out.set(f.from, [{ id: flowId, to: f.to, ...(expr === undefined ? {} : { expression: expr }) }]);
    else outList.push({ id: flowId, to: f.to, ...(expr === undefined ? {} : { expression: expr }) });
    const inList = inn.get(f.to);
    if (inList === undefined) inn.set(f.to, [{ id: flowId, from: f.from }]);
    else inList.push({ id: flowId, from: f.from });
  }

  const startNode = flatNodes.find(
    (n) => n !== null && typeof n === 'object' && n.type === 'startEvent',
  );
  if (startNode === undefined) {
    throw definitionMissing(processId, definitionVersion);
  }

  const approvalCache = new Map<string, NormalizedApproval | undefined>();
  /** ADR-009：宿主自定义扩展属性袋（按节点缓存，与 `approvalCache` 同套路） */
  const extCache = new Map<string, Readonly<Record<string, unknown>> | undefined>();
  /**
   * ★ 边界事件索引：`attachedTo` → 挂在它上面的边界事件（T21）。
   *
   * 为什么**建图时**就建好而不是投递时按需扫全图：投递是在热路径上
   *   （每个候选实例、每次 `deliverSignal` 都要问一遍"谁在等"），每次扫全图是 O(节点)。
   */
  const boundaries = new Map<string, BoundaryBinding[]>();
  for (const n of flatNodes) {
    if (n === null || typeof n !== 'object' || n.type !== 'boundaryEvent') continue;
    // ① 绑定本身的缺陷（悬空 / 不可投递的触发种类）在此抛出 —— 定义错就是定义错
    const b = boundaryBindingOf(n);
    if (b === undefined) continue;
    /*
     * ② 宿主必须存在：挂到一个不存在的活动上 = 这盏监听器永远不会亮。
     *
     * ⚠️ 判据要认**内嵌作用域**：`transaction` / `subProcess` 在拍平后**自身已不在图里**
     *   （它变成了 `Tx_1/...` 那一批节点）。挂在 `Tx_1` 上的边界事件因此
     *   「宿主不存在」是**正常的** —— 它管的正是那一整片作用域。
     *   若这里只认 `nodes.has()`，所有事务边界事件都会在建图时报"宿主不存在"。
     */
    const scopeSep = `${b.attachedTo}${SUBPROCESS_PATH_SEP}`;
    const inScope = [...nodes.keys()].some((id) => id === b.attachedTo || id.startsWith(scopeSep));
    if (!inScope) {
      throw stateShapeInvalid(
        `boundaryEvent '${b.nodeId}' is attached to unknown node '${b.attachedTo}'`,
        { nodeId: b.nodeId, attachedTo: b.attachedTo, processId },
      );
    }
    // ③ 必须有且只有一条出向：边界事件触发后**只有一个去向**，0 条 = 触发即断线
    const outCount = (out.get(b.nodeId) ?? []).length;
    if (outCount !== 1) {
      throw stateShapeInvalid(
        `boundaryEvent '${b.nodeId}' must have exactly one outgoing flow (found ${outCount})`,
        { nodeId: b.nodeId, found: outCount, processId },
      );
    }
    const list = boundaries.get(b.attachedTo);
    if (list === undefined) boundaries.set(b.attachedTo, [b]);
    else list.push(b);
  }
  /**
   * 可达性缓存（`${from}→${to}`）。
   * 图是**只读**的（本文件不持有、也不改 `ProcessDefinition`），故缓存不会失效。
   */
  const reachCache = new Map<string, boolean>();

  /**
   * BFS。为什么要缓存：汇聚判定在每次 `runToWait` 里对每个网关都要问一遍
   * 「还有没有人能来」，而 `joinPass` 又是循环 —— 没有缓存就是 O(令牌 × 网关 × 边)。
   */
  const reachable = (from: string, to: string): boolean => {
    if (from === to) return false;
    const key = `${from}→${to}`;
    const cached = reachCache.get(key);
    if (cached !== undefined) return cached;
    const seen = new Set<string>([from]);
    const queue: string[] = [from];
    let found = false;
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      for (const e of out.get(cur) ?? []) {
        if (e.to === to) {
          found = true;
          break;
        }
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        queue.push(e.to);
      }
      if (found) break;
    }
    reachCache.set(key, found);
    return found;
  };

  return {
    processId,
    definitionVersion,
    startNodeId: startNode.id,

    nodeIds: () => [...nodes.keys()],

    has: (nodeId) => nodes.has(nodeId),

    typeOf: (nodeId) => nodes.get(nodeId)?.type,

    nameOf: (nodeId) => nodes.get(nodeId)?.name,

    formKeyOf: (nodeId) => nodes.get(nodeId)?.formKey,

    outFlowsOf: (nodeId) => [...(out.get(nodeId) ?? [])],

    inFlowsOf: (nodeId) => [...(inn.get(nodeId) ?? [])],

    defaultFlowIdOf: (nodeId) => {
      const id = nodes.get(nodeId)?.defaultFlow;
      return typeof id === 'string' && id.length > 0 ? id : undefined;
    },

    reachable,

    nextOf(nodeId) {
      const list = out.get(nodeId) ?? [];
      if (list.length === 0) return undefined;
      if (list.length === 1) return (list[0] as OutFlow).to;
      /*
       * ★ D-22：多出向只在**网关**上被路由（`nodes/gateways.ts` 的 `routeGateway`）。
       *   普通节点（如 `userTask` 挂两条流）的语义 BPMN 未定义（隐式排他？隐式包容？），
       *   此处若"取第一条"，流程会静默走错分支 —— 那比抛错危险得多。
       */
      throw stateShapeInvalid(
        `node '${nodeId}' has ${list.length} outgoing flows; only gateways may route multiple branches (D-22)`,
        { nodeId, outgoing: list.map((f) => f.to) },
      );
    },

    approvalOf(nodeId) {
      const cached = approvalCache.get(nodeId);
      if (cached !== undefined || approvalCache.has(nodeId)) return cached;
      // ★ moddle v2：`approval` 是**一等字段**，不再从 extension 袋里掏
      const raw = nodes.get(nodeId)?.approval;
      // DV-1：默认值只在 moddle 的 normalizeApproval 落一处；这里只做「取与归一化」
      const value = raw === undefined ? undefined : moddle().normalizeApproval(raw, { nodeId });
      approvalCache.set(nodeId, value);
      return value;
    },

    hasApproval: (nodeId) => nodes.get(nodeId)?.approval !== undefined,

    extensionsOf(nodeId) {
      if (extCache.has(nodeId)) return extCache.get(nodeId);
      const raw = nodes.get(nodeId)?.extension;
      let value: Readonly<Record<string, unknown>> | undefined;
      if (raw !== undefined && typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        const out: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(raw)) {
          if (key === RAW_SNAPSHOT_KEY) continue;
          if (!isUsableExtensionValue(v)) continue; // 细则④：结构化值也给，只有函数排除
          out[key] = v;
        }
        // 细则「没配 → undefined」：全被过滤掉时也算"没有"，不返回空对象
        value = Object.keys(out).length > 0 ? Object.freeze(out) : undefined;
      }
      extCache.set(nodeId, value);
      return value;
    },

    /** ★ moddle v2：脚本是 `ScriptSpec { body, language }`，不再是 `script` + `scriptFormat` 两个字符串 */
    scriptOf: (nodeId) => {
      const s = nodes.get(nodeId)?.script as { body?: unknown } | undefined;
      if (s === null || typeof s !== 'object' || typeof s.body !== 'string') return undefined;
      const trimmed = s.body.trim();
      return trimmed === '' ? undefined : trimmed;
    },

    scriptFormatOf: (nodeId) => {
      const f = (nodes.get(nodeId)?.script as { language?: unknown } | undefined)?.language;
      return typeof f === 'string' && f.trim() !== '' ? f : undefined;
    },

    handlerRefOf(nodeId) {
      const node = nodes.get(nodeId);
      const impl = node?.implementation;
      if (typeof impl === 'string' && impl.length > 0 && !impl.startsWith('##')) return impl;
      const op = node?.operationRef;
      if (typeof op === 'string' && op.length > 0) return op;
      return nodeId;
    },

    callTargetOf: (nodeId) => callTargetOf(nodes.get(nodeId)),

    catchOf: (nodeId) => catchBindingOf(nodes.get(nodeId)),

    /*
     * ★ 为什么要**沿内嵌作用域向上找**：`transaction` / `subProcess` 拍平后自身不在图里，
     *   令牌停的是 `Tx_1/Task_a`。挂在 `Tx_1` 上的边界事件必须能被**它里面的令牌**看见 ——
     *   否则事务边界事件永远不会被触发（而它唯一的意义就是管这一整片作用域）。
     *   逐段去掉 `/` 后缀向上找，嵌套几层都成立。
     */
    boundaryOf: (nodeId) => {
      const out: BoundaryBinding[] = [];
      const push = (key: string): void => {
        for (const b of boundaries.get(key) ?? []) out.push(b);
      };
      push(nodeId);
      let cut = nodeId.lastIndexOf(SUBPROCESS_PATH_SEP);
      while (cut > 0) {
        const scope = nodeId.slice(0, cut);
        push(scope);
        cut = scope.lastIndexOf(SUBPROCESS_PATH_SEP);
      }
      return out;
    },
  };
}

/**
 * **INV-3**：`tokens[].nodeId` 必须在该实例绑定版本的定义图中。
 *
 * 为什么必须抛而不是跳过："实例按 v1 跑着，宿主从 v2 里删了这个节点" 是真实场景，
 * 静默忽略会让令牌永远卡在一个不存在的节点上，且没有任何报错。
 */
export function assertTokensInGraph(state: { instanceId: string; tokens: readonly { id: string; nodeId: string }[] }, graph: ProcessGraph): void {
  for (const t of state.tokens) {
    if (!graph.has(t.nodeId)) {
      throw tokenOrphan(state.instanceId, t.id, t.nodeId);
    }
  }
}
