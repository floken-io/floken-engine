/**
 * @floken-io/engine · **事件 6 类的执行语义**（T16 · `nodes/events.ts`）
 *
 * 契约来源：`01-moddle` §5.3 的覆盖率表（event 族共 **6** 类）/ `03-engine` FR-E11。
 *
 * ★ 为什么单独一档：6 类元素在 XML 里都是 `<bpmn:*Event>`，但**执行语义完全不同** ——
 *   `startEvent` 是入口、`endEvent` 是终点、`intermediateThrowEvent` 是自动直通、
 *   `intermediateCatchEvent` 要等人投递…… 若散写在 `runtime/loop.ts` 的 if 链里，
 *   「哪一类跑不了」会变成一句注释而不是一条可断言的事实。
 *
 * ★ **分类必须是穷举的**（`EVENT_TYPES` 就是那 6 个名字）：新增一类时 `eventBehaviorOf`
 *   返回 `undefined` → `runtime/loop.ts` 会在**令牌到达**时抛「未知节点类型」，
 *   而不是静默当成自动节点直通 —— 静默直通会让"这个事件没实现"表现为"流程走过去了"。
 *
 * ⚠️ **能力边界（诚实标注）**：本档把「跑不了语义」的几类分成三组 ——
 *   「**能等**」（`intermediateCatchEvent` → T20 已落地）、「**能被触发**」（`boundaryEvent` → T21 已落地）、
 *   与「**未实现但已知**」，后者**显式抛错并指名归哪个 FR**，绝不静默降级成直通（那是最难查的一类假象）。
 *
 *   未实现的两类与归属：
 *     - `intermediateThrowEvent` → **FR-E14 / T20**（**D-56 的第二半**）：它是「向**外**抛出」，
 *       而引擎没有对外的消息出口（11 项 SPI 里没有 `MessageSink`），ADR-006 的事件集又定死 10 个；
 *       静默直通的表现是「流程图上说这里发了一条消息，而它从来没发出去」；
 *     - `implicitThrowEvent` → **FR-E24 / T18**（事件子流程内的隐式抛出，随子流程一并落地）。
 *
 *   ⚠️ `intermediateCatchEvent` 只有 message / signal 两类**可投递**（其余如 `timer` 仍抛）——
 *   判据在 `nodes/catch.ts`（横跨事件族与 `receiveTask`，放哪一族都会复制一份）。
 *
 *   ⚠️ `boundaryEvent` 的**绑定与触发**在 `nodes/boundary.ts`（T21）：它不持有令牌，
 *   本档只负责「触发产生的令牌落在它上面时**直通**到它的出向」。
 *
 * ★ 分层：`nodes/` 可 import `core/` 与模型层；**`core/` 不得反向 import 本目录**。
 */

import { stateShapeInvalid } from '../core/errors.js';

// ---------------- 6 类事件 ----------------

/**
 * 事件族的全部 6 类（`01-moddle` §5.3 的登记名，**顺序即契约**）。
 *
 * ⚠️ 不手列第二份：外部（测试 / 探针）要数事件类数就用 `EVENT_TYPES.length`，
 * 覆盖率口径以 `01-moddle` 的表为准（那边也是从数据算的）。
 */
export const EVENT_TYPES = [
  'startEvent',
  'endEvent',
  'intermediateThrowEvent',
  'intermediateCatchEvent',
  'boundaryEvent',
  'implicitThrowEvent',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * 事件的执行语义。
 * - `'start'` —— 入口（`startEvent`）。令牌落在它上面时视同**自动直通**（驳回回发起节点后要自动走下去）。
 * - `'terminal'` —— 终点（`endEvent`）。令牌到达即该令牌完成。
 * - `'catch'`  —— 等**外部投递**（`intermediateCatchEvent`，T20）。令牌停住、记下在等什么，
 *   由 `deliverMessage()` / `deliverSignal()` 唤醒。**只有 message / signal 两类可投递**
 *   （其余如 `timer` 在 `nodes/catch.ts` 里抛错并指名 T21）。
 * - `'pass'` —— 直通（`boundaryEvent`，T21）。
 *   ★ 边界事件**没有入向流**，正常遍历永远走不到它 —— 它只由「触发」产生令牌
 *   （`nodes/boundary.ts`）；令牌落在它上面时直通到它的出向。
 *   把它归 `'pass'` 而不是 `'unsupported'`，是因为 T21 已把它的语义落地，
 *   只是"落在它上面"这一步由触发而非连线驱动。
 * - `'unsupported'` —— 已知但**未实现**（见档首两行归属）。
 */
export type EventBehavior = 'start' | 'terminal' | 'catch' | 'pass' | 'unsupported';

/**
 * 该类型是不是事件族；是 → 返回它的执行语义；不是事件 → `undefined`。
 */
export function eventBehaviorOf(type: string | undefined): EventBehavior | undefined {
  switch (type) {
    case 'startEvent':
      return 'start';
    case 'endEvent':
      return 'terminal';
    case 'intermediateCatchEvent':
      return 'catch';
    case 'boundaryEvent':
      return 'pass';
    case 'intermediateThrowEvent':
    case 'implicitThrowEvent':
      return 'unsupported';
    default:
      return undefined;
  }
}

export function isEventType(type: string | undefined): boolean {
  return (EVENT_TYPES as readonly string[]).includes(type ?? '');
}

// ---------------- 未实现的显式抛错 ----------------

/**
 * 令牌到达了「已知但尚未实现」的事件 → **抛**，绝不静默直通。
 *
 * ★ 为什么必须抛而不是"当普通节点走下去"：`intermediateThrowEvent` 的语义是
 *   「**向外**发出一件事」（消息 / 信号 / 升级），而引擎没有对外的消息出口
 *   （11 项 SPI 里没有 `MessageSink`），ADR-006 又把事件集定死 10 个、其中没有"抛出事件"。
 *   放行它的表现是「流程图上写着这里发了一条消息，而它从来没发出去」——
 *   业务上无法接受，且排查时**没有任何报错**可循。抛出来至少是一条能照着排期
 *   （或照着申请改 ADR）的错误。
 *
 *   `implicitThrowEvent` 同理：它是**抛出**语义，
 *   静默直通会让"这个事件没发生过"变成一个不可观测的事实。
 *
 *   ⚠️ `boundaryEvent` 已随 **T21** 落地（见 `nodes/boundary.ts`），**不在**本表内。
 */
export function assertEventSupported(
  type: string,
  nodeId: string,
  behavior: EventBehavior,
): void {
  if (behavior !== 'unsupported') return;
  const owner: Record<string, string> = {
    intermediateThrowEvent: 'FR-E14 / T20（向外抛出：无 MessageSink 出口，须先改 ADR-006 事件集）',
    implicitThrowEvent: 'FR-E24 / T18（事件子流程内的隐式抛出）',
  };
  throw stateShapeInvalid(`node '${nodeId}' is a '${type}', which is not executable yet`, {
    nodeId,
    type,
    owner: owner[type] ?? 'unknown',
    behavior,
    hint: '该事件类型已知但尚未实现；引擎刻意不把它降级成自动直通（那会让"事件没发生"变成静默事实）',
  });
}
