/**
 * @floken-io/engine · **等待外部消息 / 信号的执行语义**（T20 · `nodes/catch.ts`）
 *
 * 契约来源：`03-engine` FR-E14 / `ARCHITECTURE.md` §7.1（`deliverMessage` / `deliverSignal`）。
 *
 * ★ 为什么单独一档（而不是塞进 `nodes/events.ts` 或 `nodes/tasks.ts`）：
 *   「等外部投递」这件事**横跨两个节点族** ——
 *     - `intermediateCatchEvent` + `<messageEventDefinition>` / `<signalEventDefinition>`（事件族）
 *     - `receiveTask`（任务族，`messageRef`）
 *   它们的 XML 形态毫不相干，执行语义却**完全一样**：令牌停住、记下在等什么、被投递唤醒。
 *   塞进任何一族，另一族就得复制一份「怎么取名 / 怎么匹配 / 怎么唤醒」——
 *   于是「消息名判据」出现第二份写法，必然漂移（与 D-52 的教训同型）。
 *
 * ★ **本档是纯的**（NFR-E6）：不读时钟、不碰存储、不调 SPI。
 *   投递的**不纯部分**（load / save / 投影 / 钩子 / 事件）在 `runtime/engine.ts`；
 *   「唤醒 + run-to-wait」的纯部分在 `runtime/deliver.ts`。
 *
 * ## ★ 三条硬判据
 *
 *   ① **没有名字 = 定义错误，抛**（`intermediateCatchEvent` 不写 `messageRef`、
 *      `receiveTask` 不写 `messageRef`）：这样的节点**永远等不到东西**，
 *      放行它等于埋一个「流程跑到这儿就停住、且没有任何报错」的坑 ——
 *      与 INV-16「拿不到版本就抛、绝不回退」同一条纪律。
 *   ② **不是 message / signal 的等待一律抛**（`timer` / `error` / `escalation` …）：
 *      它们要的是 `Scheduler` / 补偿，归 **T21**。静默直通的表现是「事件从来没发生过，
 *      流程却办完了」—— 那是最难查的一类假象。
 *   ③ **投递必须精确匹配 `name`**：名字打错（`Msg_paid` vs `msg_paid`）如果静默丢弃，
 *      流程就永久卡在等待节点上，而宿主以为自己投过了。故「一个都没命中 → 抛」。
 */

import { stateShapeInvalid } from '../core/errors.js';
import { LIVE_TOKEN_STATES } from '../core/primitives.js';
import type { InstanceState, Token, TokenAwait } from '../core/state.js';
import { cloneState } from '../core/state.js';

// ---------------- 等待的种类 ----------------

/**
 * 两类外部触发（**语义差别是投递方式**，不是名字）：
 * - `'message'` —— **点对点**：BPMN 消息有且只有一个接收者，故 `deliverMessage(instanceId, …)`；
 * - `'signal'` —— **广播**：一个信号可以被任意多个实例/节点接收，故 `deliverSignal(instanceIds[], …)`。
 */
export type CatchKind = 'message' | 'signal';

export const CATCH_KINDS = ['message', 'signal'] as const satisfies readonly CatchKind[];

/** 一个等待节点在等什么（**定义期**就定下来的事实） */
export interface CatchBinding {
  readonly kind: CatchKind;
  /** `messageRef` / `signalRef` */
  readonly name: string;
}

/**
 * ★ 投递到实例时写进审计的**第四类**动作名（D-62 那一类的扩展）。
 *
 * 为什么不复用 19 项动作名：投递**不是审批动作**，它是外部世界的一次输入
 * （与 `start` / `callActivityReturn` 同族）。混进 19 项里，`beforeAction` 按动作名路由时
 * 就会把「银行回调说已付款」当成「某人点了一次通过」。
 */
export const MESSAGE_DELIVER_ACTION = 'deliverMessage';
export const SIGNAL_DELIVER_ACTION = 'deliverSignal';

/** 两个投递动作名（顺序即契约；外部要数就用 `DELIVER_ACTIONS.length`） */
export const DELIVER_ACTIONS = [MESSAGE_DELIVER_ACTION, SIGNAL_DELIVER_ACTION] as const;

/** 动作名 → 它对应的等待种类（**唯一**映射处，别处不许再写一遍 if） */
export function catchKindOfAction(action: string): CatchKind | undefined {
  if (action === MESSAGE_DELIVER_ACTION) return 'message';
  if (action === SIGNAL_DELIVER_ACTION) return 'signal';
  return undefined;
}

// ---------------- 绑定解析 ----------------

/**
 * 「尚未实现」的等待种类 → 归属哪个 FR。
 *
 * ⚠️ 与 `nodes/events.ts` / `nodes/tasks.ts` 的 `owner` 表同一写法：
 *    报错要能直接照着排期，而不是让人去翻文档猜。
 */
const WAIT_OWNER: Record<string, string> = {
  timer: 'FR-E14 / T21（定时器：经 Scheduler SPI 排程）',
  error: 'FR-E13 / T21（异常与补偿）',
  escalation: 'FR-E13 / T21（升级事件）',
  cancel: 'FR-E13 / T21（事务取消）',
  compensate: 'FR-E13 / T21（补偿）',
  conditional: 'FR-E14 / T21（条件事件：需要变量级变更订阅）',
};

/** 定义节点的最小形状（只取本档要读的字段，避免与 moddle 的 `FlowNode` 硬耦合） */
export interface CatchNodeLike {
  readonly id: string;
  readonly type: string;
  readonly messageRef?: string | undefined;
  readonly eventDefinition?: { readonly type?: unknown; readonly [k: string]: unknown } | undefined;
}

/**
 * ★ 「这个节点在等什么」的**唯一入口**（图适配层 `graph.catchOf` 就是它）。
 *
 * - 不是等待节点（`userTask` / 网关 / …）→ `undefined`；
 * - 是等待节点、且等的是 **message / signal** → 返回 {@link CatchBinding}；
 * - 是等待节点但**没写名字**（缺 `messageRef` / `signalRef`）→ **抛**（判据 ①）；
 * - 是等待节点但等的是 `timer` / `error` / `escalation` … → **抛**（判据 ②）。
 *
 * ⚠️ 刻意**不**拆成「纯查询 + 断言」两个函数：那会让「`timer` 到底算不算没实现」
 *   出现两个答案，调用方漏调断言就成了静默直通。一个入口 = 一个答案。
 */
export function catchBindingOf(node: CatchNodeLike | undefined): CatchBinding | undefined {
  if (node === undefined) return undefined;

  if (node.type === 'receiveTask') {
    return { kind: 'message', name: requiredName(node, node.messageRef, 'messageRef') };
  }
  if (node.type !== 'intermediateCatchEvent') return undefined;

  const def = node.eventDefinition;
  const type = typeof def?.type === 'string' ? def.type : undefined;
  if (type === 'message') return { kind: 'message', name: requiredName(node, def?.messageRef, 'messageRef') };
  if (type === 'signal') return { kind: 'signal', name: requiredName(node, def?.signalRef, 'signalRef') };

  throw stateShapeInvalid(
    `node '${node.id}' is an intermediateCatchEvent waiting on '${type ?? '(no eventDefinition)'}', which is not deliverable yet`,
    {
      nodeId: node.id,
      type: node.type,
      ...(type !== undefined ? { eventDefinition: type } : {}),
      owner: type === undefined ? 'FR-E14 / T20' : (WAIT_OWNER[type] ?? 'FR-E13 / T21'),
      hint: '目前只有 message / signal 两类等待可被投递唤醒（T20）；其余等待种类归 T21，引擎刻意不把它们降级成自动直通',
    },
  );
}

function requiredName(node: CatchNodeLike, value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw stateShapeInvalid(
      `node '${node.id}' (${node.type}) has no ${field}; it would wait forever with no way to wake it`,
      {
        nodeId: node.id,
        type: node.type,
        field,
        owner: 'FR-E14 / T20',
        hint: `给该节点补 ${field}（消息 / 信号名）；引擎刻意不把它降级成自动直通 —— 那会变成"永远等不到、且不报错"`,
      },
    );
  }
  return value;
}

// ---------------- 停车 / 匹配 / 唤醒（纯） ----------------

/** 把令牌停在等待节点上（记录它在等什么） */
export function parkForCatch(token: Token, binding: CatchBinding): void {
  const awaiting: TokenAwait = { kind: binding.kind, name: binding.name };
  token.awaiting = awaiting;
}

/** 一次投递要命中的目标 */
export interface DeliverMatch {
  readonly kind: CatchKind;
  readonly name: string;
  /** 只在这些令牌里找（不给 = 全部匹配） */
  readonly tokenIds?: readonly string[] | undefined;
}

/**
 * 状态里**正在等** `match` 的那些令牌（去重、保序）。
 *
 * ⚠️ 只认**在途**令牌（`active`；`waiting` 是串行会签里没轮到的，不可能是等待节点）：
 *   已被取消的令牌可能还留着 `awaiting`（取消是改 `state` 不改本字段），
 *   把它们算进来就会"唤醒一个已经不存在的等待"。
 */
export function matchingTokens(state: InstanceState, match: DeliverMatch): readonly Token[] {
  return state.tokens.filter(
    (t) =>
      LIVE_TOKEN_STATES.includes(t.state) &&
      t.awaiting !== undefined &&
      t.awaiting.kind === match.kind &&
      t.awaiting.name === match.name &&
      (match.tokenIds === undefined || match.tokenIds.includes(t.id)),
  );
}

/**
 * 该实例**此刻在等什么**（去重、保序）—— 专供「投递没命中」的报错 `details` 用。
 *
 * ★ 为什么要列出来：`AGENTS.md` §5.4 要求错误必须给**合法取值**，
 *   否则宿主看见「没有在等 Msg_paid」也修不了 —— 他不知道这里其实在等 `Msg_Paid`。
 */
export function waitingNamesOf(state: InstanceState): readonly string[] {
  const out: string[] = [];
  for (const t of state.tokens) {
    if (!LIVE_TOKEN_STATES.includes(t.state) || t.awaiting === undefined) continue;
    const label = `${t.awaiting.kind}:${t.awaiting.name}`;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/**
 * ★ 摘掉这些令牌的等待态（**纯**：不改入参）。
 *
 * 只做一件事 —— 清 `awaiting`。**不推进**：推进是 `runToWait()` 的事，
 *   两者分开才能被门 2 独立复用（先唤醒、再自编排地推进）。
 *
 * @throws `ENGINE_STATE_SHAPE_INVALID` —— 目标令牌不存在（宿主手塞了 id）
 */
export function wakeTokens(state: InstanceState, tokenIds: readonly string[]): InstanceState {
  const next = cloneState(state);
  for (const id of tokenIds) {
    const t = next.tokens.find((x) => x.id === id);
    if (t === undefined) {
      throw stateShapeInvalid(`wakeTokens targets unknown token '${id}'`, {
        tokenId: id,
        tokenIds: next.tokens.map((x) => x.id),
      });
    }
    delete t.awaiting;
  }
  return next;
}
