/**
 * @floken-io/engine · **网关 5 类的路由与汇聚语义**（T16 · `nodes/gateways.ts`）
 *
 * 契约来源：`01-moddle` §5.3（gateway 族共 **5** 类，其中 L3 承诺 **3** 类）/
 * `03-engine` FR-E7（网关分支求值）/ FR-E11（22 类 L3）+ FR-E17 / FR-E14（另两类归 v1.x）。
 *
 * ★ 引擎只做**两件事**：路由（分叉出去几条）与汇聚（要不要等、等谁）。
 *   算法与判定式**不在这里** —— 那属于模型层 / 收敛层（`actions/convergence.ts`）。
 *
 * ## ★ 三条路由语义（`03` §6 与 BPMN 规范的共识，**不是发明**）
 *
 * | 类型 | 分叉 | 汇聚 |
 * |---|---|---|
 * | `exclusiveGateway` | 取**第一条**为真的出向；全假 → `default`；都没有 → **抛** | **不等**（先到先过） |
 * | `parallelGateway` | **全部**出向（不判条件 —— 规范里它的条件是被忽略的） | 等**全部**入向 |
 * | `inclusiveGateway` | **所有**为真的出向；全假 → `default`；都没有 → **抛** | 只等**被激活**的入向 |
 *
 * ⚠️ `exclusive` 的"第一条"：BPMN 规范说条件互斥，多条为真时取哪条**未定义**。
 *    我们按**定义里的顺序**取第一条并**保持确定性**（纯函数不能靠 `Math.random`），
 *    这与 Camunda / Flowable 的实际行为一致。
 *
 * ## ★ 汇聚判据为什么是「还有没有人能来」而不是「来了几个」
 *
 *   直觉写法是「到达数 == 入向数」，它在**包容网关**上是错的：
 *   只激活了 A 分支时，B 分支永远不会有令牌来 → 判定永远不成立 → **死锁**。
 *   同理，并行分支上若某条分支的令牌被取消（终止 / 减签），按入向数等也是死锁。
 *
 *   故统一判据 = 「**不存在**另一个在途令牌，从它所在节点**可达**本网关」。
 *   - 并行：所有分支都有在途令牌 → 可达 → 等；全部到齐 → 推进（等价于"等全部入向"，但**不会死锁**）；
 *   - 包容：未激活的分支**没有令牌** → 不可达 → 不等（正是"只等被激活的分支"）；
 *   - 被取消的分支同理自动退出等待。
 *
 *   ⚠️ 可达性**不按条件剪枝**：条件此刻为假不代表稍后不会为真（变量会被表单改写），
 *   剪枝会让引擎提前合流 —— 那是静默走错分支。
 *
 * ★ 分层：`nodes/` 可 import `core/` 与模型层；**`core/` 不得反向 import 本目录**。
 */

import { definitionMissing, stateShapeInvalid } from '../core/errors.js';
import type { InstanceState } from '../core/state.js';
import { LIVE_TOKEN_STATES } from '../core/primitives.js';
import { flowPasses } from './flows.js';
import type { OutFlow } from './graph.js';
import type { ProcessGraph } from './graph.js';

// ---------------- 5 类网关 ----------------

/**
 * 网关族的全部 5 类（`01-moddle` §5.3 的登记名，**顺序即契约**）。
 *
 * ⚠️ L3 只承诺其中 3 类；`complexGateway`（FR-E17）/ `eventBasedGateway`（FR-E14）归 v1.x。
 */
export const GATEWAY_TYPES = [
  'exclusiveGateway',
  'parallelGateway',
  'inclusiveGateway',
  'complexGateway',
  'eventBasedGateway',
] as const;

export type GatewayType = (typeof GATEWAY_TYPES)[number];

/** ★ 可执行的 3 类（FR-E11 的落点：5 − 2 = 3） */
export const EXECUTABLE_GATEWAY_TYPES: readonly string[] = [
  'exclusiveGateway',
  'parallelGateway',
  'inclusiveGateway',
];

export function isGatewayType(type: string | undefined): boolean {
  return (GATEWAY_TYPES as readonly string[]).includes(type ?? '');
}

/**
 * 该网关**是否需要等待汇聚**。
 *
 * - `exclusiveGateway` → **false**：BPMN 里它是"先到先过"（每条到达的令牌各自继续），
 *   若让它等待，`A → G ← B` 这种常见的"两个分支汇到一处"会永久卡住；
 * - `parallelGateway` / `inclusiveGateway` → **true**（入向 ≥2 时）；
 * - 未实现的 2 类 → 由 `routeGateway` 先抛（走不到这里）。
 */
export function isConverging(type: string): boolean {
  return type === 'parallelGateway' || type === 'inclusiveGateway';
}

// ---------------- 路由（分叉） ----------------

/** `routeGateway` 的选中结果 —— **带 flowId**，分支标记（`Token.branch`）要靠它 */
export interface RoutedFlow {
  readonly flowId: string;
  readonly to: string;
}

export interface RouteInput {
  readonly type: string;
  readonly nodeId: string;
  /** 出向流全表（**定义顺序 = 优先级**） */
  readonly outFlows: readonly OutFlow[];
  /** `Gateway.default` 指向的 flow id；没有 → `undefined` */
  readonly defaultFlowId: string | undefined;
  /**
   * 条件判定（**同步**）。
   *
   * ⚠️ 由 `runtime/engine.ts` 以闭包注入（依赖倒置）：`ConditionHandler` 是异步 SPI，
   *   而 `runToWait()` 必须同步纯。未解析的条件会由闭包抛 `ConditionUnresolved` 哨兵，
   *   引擎解析后**重跑** —— 这样既保住纯函数性，又不会去求值"本次根本走不到的分支"
   *   （那些分支引用的变量此时可能还不存在，按 D-38 会误抛）。
   */
  readonly isTrue: (flow: OutFlow) => boolean;
}

/**
 * ★ 网关路由：算出**本次要走哪几条出向**。
 *
 * @throws `ENGINE_STATE_SHAPE_INVALID` —— 未实现的 2 类网关 / 选中 0 条（`exclusive` / `inclusive` 无匹配且无 default）
 * @throws `ENGINE_STATE_DEFINITION_MISSING` —— 网关没有出向（定义不完整）
 */
export function routeGateway(input: RouteInput): readonly RoutedFlow[] {
  const { type, nodeId, outFlows, defaultFlowId, isTrue } = input;

  if (!isGatewayType(type)) {
    throw stateShapeInvalid(`node '${nodeId}' is not a gateway (type '${type}')`, {
      nodeId,
      type,
      gateways: [...GATEWAY_TYPES],
    });
  }
  if (outFlows.length === 0) {
    throw definitionMissing(nodeId, 0);
  }

  // —— 未实现的 2 类：显式抛，绝不静默取第一条 ——
  if (type === 'complexGateway' || type === 'eventBasedGateway') {
    throw stateShapeInvalid(`gateway '${nodeId}' ('${type}') is not executable yet`, {
      nodeId,
      type,
      owner: type === 'complexGateway' ? 'FR-E17（自定义表达式，C 级）' : 'FR-E14（事件驱动路由，S 级）',
      hint: '该网关已知但归 v1.x；引擎刻意不把它降级成「取第一条出向」（那会静默走错分支）',
    });
  }

  // —— parallelGateway：全部出向，**不判条件**（规范里它的条件被忽略）——
  if (type === 'parallelGateway') {
    return outFlows.map((f) => ({ flowId: f.id, to: f.to }));
  }

  const isDefault = (f: OutFlow): boolean => f.id === defaultFlowId;
  const candidates = outFlows.filter((f) => !isDefault(f));
  /*
   * ★ **无条件流恒真，且不进求值器**（D-42）。
   *   把它交给 `isTrue` 有两个坏处：① 宿主注入的 handler 可以把它判成 false，
   *   于是"没写条件"这条 BPMN 的既有语义被悄悄改写；② 白白多一次求值
   *   （并行分支上每条无条件流都要问一遍，而这些分支在真实图里占多数）。
   *
   *   判据本身在 `nodes/flows.ts` 的 `flowPasses()` —— 连线的语义只有一个口径。
   */
  const taken = (f: OutFlow): boolean => flowPasses(f, () => isTrue(f));

  // —— exclusiveGateway：第一条为真的（不判 default；它只在"一条都没中"时才走）——
  if (type === 'exclusiveGateway') {
    for (const f of candidates) {
      if (taken(f)) return [{ flowId: f.id, to: f.to }];
    }
    return fallbackOf(input);
  }

  // —— inclusiveGateway：所有为真的（至少一条，否则 default，再否则抛）——
  const chosen = candidates.filter((f) => taken(f));
  if (chosen.length > 0) return chosen.map((f) => ({ flowId: f.id, to: f.to }));
  return fallbackOf(input);
}

/** 一条都没选中 → `default`；连 `default` 都没有 → **抛**（静默"哪都不走"= 流程消失） */
function fallbackOf(input: RouteInput): readonly RoutedFlow[] {
  const { nodeId, outFlows, defaultFlowId } = input;
  const fallback = outFlows.find((f) => f.id === defaultFlowId);
  if (fallback !== undefined) return [{ flowId: fallback.id, to: fallback.to }];
  throw stateShapeInvalid(
    `gateway '${nodeId}' ('${input.type}') has no branch to take: no condition matched and no default flow`,
    {
      nodeId,
      type: input.type,
      outgoing: outFlows.map((f) => f.id),
      defaultFlowId: defaultFlowId ?? null,
      hint: '给该网关配一条 default 流，或让至少一条出向的条件为真（BPMN 规范要求至少走一条）',
    },
  );
}

// ---------------- 汇聚（join） ----------------

/**
 * ★ 汇聚判据：本网关**可以合流**了吗。
 *
 * 判据 = 「不存在**别的**在途令牌，从它所在节点**可达**本网关」（理由见档首）。
 *
 * @param nodeId 网关节点 id
 */
export function canJoin(state: InstanceState, nodeId: string, graph: ProcessGraph): boolean {
  for (const t of state.tokens) {
    if (!LIVE_TOKEN_STATES.includes(t.state)) continue;
    if (t.nodeId === nodeId) continue; // 已经到网关的（含自己）不算"还能来"
    if (graph.reachable(t.nodeId, nodeId)) return false;
  }
  return true;
}

/**
 * 停在该网关上等待的在途令牌（**按 `tokens` 顺序** —— 合并时第 0 个是承接者，顺序必须确定）。
 */
export function waitingAt(state: InstanceState, nodeId: string): number[] {
  const out: number[] = [];
  state.tokens.forEach((t, i) => {
    if (t.nodeId === nodeId && LIVE_TOKEN_STATES.includes(t.state)) out.push(i);
  });
  return out;
}
