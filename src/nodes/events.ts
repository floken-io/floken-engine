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
 * ⚠️ **能力边界（诚实标注）**：本档把 6 类分成「已实现」与「未实现但已知」两组，
 *   后者**显式抛错并指名归哪个 FR**，绝不静默降级成直通（那是最难查的一类假象）。
 *
 *   未实现的三类与归属：
 *     - `intermediateCatchEvent` → **FR-E14 / T20**（`deliverMessage` / `deliverSignal` 未落地，
 *       让它"等待"会造成**没有任何手段唤醒**的永久卡死，比抛错糟得多）；
 *     - `boundaryEvent`         → **FR-E13 / T21**（要 `attachedTo` + `cancelActivity` 与宿主活动的中断语义）；
 *     - `implicitThrowEvent`    → **FR-E24 / T18**（事件子流程内的隐式抛出，随子流程一并落地）。
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
 * - `'pass'` —— 自动直通（`intermediateThrowEvent`）。
 *   ⚠️ 严格说抛事件应当通告 `EventSink`，但 ADR-006 把事件集**定死 10 个**，其中没有"抛出事件"，
 *   故 T16 只直通；真正的抛出语义归 **T20**（届时须先给 ADR-006 补事件，不能偷偷加）。
 * - `'unsupported'` —— 已知但**未实现**（见档首三行归属）。
 */
export type EventBehavior = 'start' | 'terminal' | 'pass' | 'unsupported';

/**
 * 该类型是不是事件族；是 → 返回它的执行语义；不是事件 → `undefined`。
 */
export function eventBehaviorOf(type: string | undefined): EventBehavior | undefined {
  switch (type) {
    case 'startEvent':
      return 'start';
    case 'endEvent':
      return 'terminal';
    case 'intermediateThrowEvent':
      return 'pass';
    case 'intermediateCatchEvent':
    case 'boundaryEvent':
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
 * ★ 为什么必须抛而不是"当普通节点走下去"：这三类都是**等待 / 中断**语义，
 *   静默直通的表现是"流程办完了，但那个事件从来没发生过" —— 业务上无法接受，
 *   且排查时**没有任何报错**可循。抛出来至少是一条能照着修（或照着排期）的错误。
 */
export function assertEventSupported(
  type: string,
  nodeId: string,
  behavior: EventBehavior,
): void {
  if (behavior !== 'unsupported') return;
  const owner: Record<string, string> = {
    intermediateCatchEvent: 'FR-E14 / T20（deliverMessage / deliverSignal）',
    boundaryEvent: 'FR-E13 / T21（边界事件与补偿）',
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
