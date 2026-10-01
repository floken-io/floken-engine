/**
 * @floken-io/engine · **边界事件的执行语义**（T21 · `nodes/boundary.ts`）
 *
 * 契约来源：`03-engine` §6「事件（6）」的 `BoundaryEvent` 一行 + FR-E13。
 *
 * ★ 为什么单独一档（与 `nodes/catch.ts` 同为"事件语义"，但**不是一回事**）：
 *   `catch.ts` 管的是「**令牌停下来等**」—— 等的时候令牌**就是**那个等待节点上的指针；
 *   边界事件**不持有令牌**：它挂在活动上（`attachedTo`），是活动执行期间的**一盏监听器**，
 *   触发时才**产生**令牌（或**夺走**宿主的令牌）。两者的状态变更形状完全不同，
 *   混在一档会让「`awaiting` 到底是给谁的」出现第二个答案。
 *
 * ## ★ 两条硬判据
 *
 *   ① **没有 `attachedTo` 的边界事件 = 定义错误，抛**：它挂不到任何活动上 ⇒
 *      永远不会被监听 ⇒ 等于"写了个不存在的分支"。放行它，宿主会以为配了超时/撤回
 *      而实际什么都不会发生 —— 且**没有任何报错**。
 *   ② **只有 message / signal 两类触发可被投递**（与 `nodes/catch.ts` 判据 ② 同一条线）：
 *      `timer` / `error` / `escalation` / `cancel` / `compensate` 一律抛并指名归属。
 *      ⚠️ 其中 **`compensate`（补偿处理器）是 `03` §11 明确登记到 v1.x 的例外**
 *      （FR-E13 S 级），本档**不**把它降级成"可触发但什么都不做"。
 *
 * ## ★ `cancelActivity`：中断还是继续
 *
 *   | `cancelActivity` | 宿主令牌 | 触发后 |
 *   |---|---|---|
 *   | `true`（**缺省**） | **取消** | 宿主活动的令牌及其**作用域内**全部在途令牌一并取消，令牌改走边界事件的出向 |
 *   | `false` | **保留** | 宿主活动继续办，另**新造**一个令牌走边界事件的出向 |
 *
 *   ★ 「作用域内」= `nodeId === attachedTo` **或** `nodeId` 以 `attachedTo + '/'` 开头
 *   （内嵌子流程 / `transaction` 在建图时已**拍平**，内部节点 id 带该前缀 —— 见
 *   `nodes/activities.ts` 的 `SUBPROCESS_PATH_SEP`）。于是「事务被 cancel →
 *   里面正在办的全部撤销」这件事**不需要第二套遍历**：拍平 + 前缀判据就够了。
 *
 * ★ **本档是纯的**（NFR-E6）：不读时钟、不碰存储、不调 SPI。
 *   触发的**不纯部分**（load / save / 投影 / 钩子 / 事件）在 `runtime/engine.ts`；
 *   「匹配 + 触发 + run-to-wait」的纯部分在 `runtime/deliver.ts`。
 */

import { stateShapeInvalid } from '../core/errors.js';
import { LIVE_TOKEN_STATES } from '../core/primitives.js';
import type { InstanceState, Token } from '../core/state.js';
import { catchBindingOf } from './catch.js';
import type { CatchBinding, CatchKind } from './catch.js';
import type { ProcessGraph } from './graph.js';

// ---------------- 边界事件 ----------------

export const BOUNDARY_TYPE = 'boundaryEvent';

/** 一个边界事件在**建图期**就定下来的事实 */
export interface BoundaryBinding {
  /** 边界事件自己的节点 id */
  readonly nodeId: string;
  /** 宿主活动 id（`attachedTo`） */
  readonly attachedTo: string;
  /**
   * 触发后是否取消宿主活动（BPMN `cancelActivity`）。
   * ⚠️ **缺省 `true`** 与规范一致：BPMN 的 `cancelActivity` 默认是 `true`，
   * 且"非中断"是个**显式**声明（`cancelActivity="false"`），不能反过来默认。
   */
  readonly cancelActivity: boolean;
  /** 它在等什么（只有 message / signal 两类能到这一步） */
  readonly trigger: CatchBinding;
}

/** 定义节点的最小形状（只取本档要读的字段，避免与 moddle 的 `FlowNode` 硬耦合） */
export interface BoundaryNodeLike {
  readonly id: string;
  readonly type: string;
  readonly attachedTo?: string | undefined;
  readonly cancelActivity?: boolean | undefined;
  readonly eventDefinition?: { readonly type?: unknown; readonly [k: string]: unknown } | undefined;
}

/**
 * ★ 读一个边界事件的绑定。
 *
 * - 不是 `boundaryEvent` → `undefined`（让调用方照常处理别的事）；
 * - 是 `boundaryEvent` → 绑定；
 *
 * @throws `ENGINE_STATE_SHAPE_INVALID` —— 缺 `attachedTo`（判据 ①）/ 触发种类不可投递（判据 ②）
 */
export function boundaryBindingOf(node: BoundaryNodeLike | undefined): BoundaryBinding | undefined {
  if (node === undefined || node.type !== BOUNDARY_TYPE) return undefined;

  const attachedTo = node.attachedTo;
  if (typeof attachedTo !== 'string' || attachedTo.trim() === '') {
    throw stateShapeInvalid(
      `boundaryEvent '${node.id}' has no attachedTo; it would listen to nothing`,
      {
        nodeId: node.id,
        field: 'attachedTo',
        owner: 'FR-E13 / T21',
        hint: '边界事件必须挂在某个活动上（attachedTo = 宿主活动 id）；悬空的边界事件永远不会触发，引擎刻意不放行',
      },
    );
  }

  /*
   * 触发种类复用 `catch.ts` 的判据 —— **不另写一份**。
   * 做法：把边界事件伪装成 `intermediateCatchEvent` 交给它（两者的事件定义形状相同），
   * 于是「哪些种类可投递」永远只有一个答案。
   *
   * ⚠️ `catchBindingOf` 对不可投递的种类会抛，且抛出的 `owner` 已指名归属 —— 直接透传即可，
   *    不要在这里改写 message（那会让同一个缺陷出现两种报错文案）。
   */
  const trigger = catchBindingOf({
    id: node.id,
    type: 'intermediateCatchEvent',
    ...(node.eventDefinition === undefined ? {} : { eventDefinition: node.eventDefinition }),
  });
  if (trigger === undefined) {
    // `catchBindingOf` 对 intermediateCatchEvent 要么给绑定、要么抛；真到这儿说明形状不对
    throw stateShapeInvalid(`boundaryEvent '${node.id}' has no deliverable eventDefinition`, {
      nodeId: node.id,
      owner: 'FR-E13 / T21',
    });
  }

  return {
    nodeId: node.id,
    attachedTo,
    cancelActivity: node.cancelActivity !== false,
    trigger,
  };
}

// ---------------- 监听中的边界事件 ----------------

/** 一次「某盏监听器被触发」 */
export interface BoundaryFire {
  readonly boundary: BoundaryBinding;
  /** 宿主活动的令牌 id（中断时要取消它；非中断时它是"继续办的那一个"） */
  readonly hostTokenId: string;
}

/**
 * ★ 此刻**监听中**且**命中** `match` 的边界事件（保序）。
 *
 * 「监听中」= 宿主活动上有**在途**令牌（`active` / `waiting`）。
 * 令牌不在那儿 ⇒ 那个活动根本没在跑 ⇒ 它的边界事件此刻**不成立**
 * （投递到一个已经办完的活动上，"取消"就无从谈起）。
 */
export function armedBoundaries(
  state: InstanceState,
  graph: ProcessGraph,
  match: { readonly kind: CatchKind; readonly name: string },
): readonly BoundaryFire[] {
  const out: BoundaryFire[] = [];
  const seen = new Set<string>();

  for (const t of state.tokens) {
    if (!LIVE_TOKEN_STATES.includes(t.state)) continue;
    for (const b of graph.boundaryOf(t.nodeId)) {
      if (b.trigger.kind !== match.kind || b.trigger.name !== match.name) continue;
      // 同一个宿主节点上有多条在途令牌（会签组）时，只触发**一次**
      const key = `${b.nodeId}::${b.attachedTo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ boundary: b, hostTokenId: t.id });
    }
  }

  return out;
}

/**
 * 「此刻监听中的东西」的可读清单（去重、保序）—— 专供投递未命中的 `details.waiting`。
 *
 * ★ 为什么要连边界事件一起列：`AGENTS.md` §5.4 要求错误必须给**合法取值**。
 *   只列 catch 节点的话，宿主看见「没有在等 Msg_cancel」也修不了 ——
 *   他不知道自己其实把消息名写在了**边界事件**上。
 */
export function armedNamesOf(state: InstanceState, graph: ProcessGraph): readonly string[] {
  const out: string[] = [];
  for (const t of state.tokens) {
    if (!LIVE_TOKEN_STATES.includes(t.state)) continue;
    for (const b of graph.boundaryOf(t.nodeId)) {
      const label = `boundary:${b.trigger.kind}:${b.trigger.name}`;
      if (!out.includes(label)) out.push(label);
    }
  }
  return out;
}

// ---------------- 取消范围 / 令牌构造 ----------------

/** 内嵌作用域的分隔符（与 `nodes/activities.ts` 同一个常量语义） */
export const SCOPE_SEP = '/';

/**
 * ★ 该令牌是否处在 `hostId` **及其内嵌作用域**里。
 *
 * `transaction` / `subProcess` 建图时已拍平，内部节点 id 形如 `Tx_1/Task_a` ——
 * 于是「取消事务内所有在途令牌」= 前缀判据，不需要第二套子令牌树。
 */
export function inScopeOf(tokenNodeId: string, hostId: string): boolean {
  return tokenNodeId === hostId || tokenNodeId.startsWith(`${hostId}${SCOPE_SEP}`);
}

/** 中断边界事件要取消的那些在途令牌 id（保序） */
export function cancelTargetsOf(state: InstanceState, hostId: string): readonly string[] {
  return state.tokens
    .filter((t) => LIVE_TOKEN_STATES.includes(t.state) && inScopeOf(t.nodeId, hostId))
    .map((t) => t.id);
}

/**
 * ★ 触发产生的新令牌 id —— **必须唯一**。
 *
 * ⚠️ 为什么不能直接用 `${hostTokenId}#${boundaryId}`：非中断边界事件可以被**重复**触发
 *   （宿主还在办，第二条同样的消息又来了），两次会撞出同一个 id ——
 *   于是两条令牌在 `tokens` 里互相覆盖（按 id 查找永远只找到第一个），
 *   表现为「第二次触发好像没生效」，且没有任何报错。
 */
export function boundaryTokenIdOf(state: InstanceState, hostTokenId: string, boundaryId: string): string {
  const base = `${hostTokenId}#${boundaryId}`;
  if (!state.tokens.some((t) => t.id === base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}#${n}`;
    if (!state.tokens.some((t) => t.id === candidate)) return candidate;
  }
}

/**
 * 触发令牌（**纯**：只造对象，不改入参）。
 *
 * - `branch` **继承**宿主：边界事件触发后走的这段路仍处在原来那条并行分支上
 *   （否则 `rollbackTo` 会把兄弟分支一起撤销 —— D-47 那处误伤的另一副面孔）；
 * - **不带** `assignee`：交给下面的 `runToWait()` 在新节点上重新解析；
 * - **不带** `race`：边界触发不是竞速（它不是从 `EventBasedGateway` 分出来的）。
 */
export function boundaryTokenOf(state: InstanceState, fire: BoundaryFire, host: Token): Token {
  const out: Token = {
    id: boundaryTokenIdOf(state, fire.hostTokenId, fire.boundary.nodeId),
    nodeId: fire.boundary.nodeId,
    state: 'active',
  };
  if (host.branch !== undefined) out.branch = host.branch;
  return out;
}
