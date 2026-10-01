/**
 * @floken-io/engine · **连线与数据 4 类的语义**（T17 · `nodes/flows.ts`）
 *
 * 契约来源：`03-engine` §6「连线与数据（4）」。
 *
 * ★ 为什么单独一档：`SequenceFlow` 的「条件求值」与「`default` 无条件通过」此前散在
 *   `nodes/graph.ts`（`expressionOf` / `defaultFlowIdOf`）与 `nodes/gateways.ts`（`taken`）
 *   两处 —— 同一个判定有两份写法就必然漂移（D-19 的教训）。故把**连线的语义**收在这里，
 *   网关只问"要哪些流"，通不通由本档回答。
 *
 * ## 两类元素的立场
 *
 * - **`sequenceFlow`** —— 条件的载体。判据是本档的 `flowPasses()`：
 *     ① **无条件**（`expression === undefined`）→ **恒真**（D-42：空 = 明确声明"无条件"，
 *        与"写坏了"是两回事）；② 有条件 → 交求值器，且**只接受布尔**（D-38：`null` 必抛）。
 * - **数据三兄弟**（`dataObject` / `dataObjectReference` / `dataStoreReference`）——
 *     **`03` §6 原话：「引擎只读不写 —— 数据状态由业务方管理」**。
 *     它们是**数据状态**，不是可执行节点：令牌不该落在上面。落上了就抛，绝不静默直通
 *     （直通的表现是"流程图上画了个数据对象，引擎把它当空气走过去了"）。
 *
 * ## ⚠️ 诚实的能力边界
 *   数据侧的「读」当前**没有读写路径** —— 引擎既不写（规格禁止）也不读（还没有消费者：
 *   表单快照归 `FormProvider`、变量归 `InstanceState.variables`）。
 *   本档因此只提供**分类与守门**（`isDataNode` / `assertNotDataNode` / `dataRefOf`），
 *   不发明读写 API。等 T18 子流程的变量作用域落地时再一起定。
 *
 * ★ 分层：`nodes/` 可 import `core/` 与模型层；**`core/` 不得反向 import 本目录**。
 */

import type { FlowNode } from '@floken-io/moddle';

import { stateShapeInvalid } from '../core/errors.js';

// ---------------- 4 类 ----------------

/**
 * 连线与数据族的全部 4 类（`03-engine` §6 的登记名，**顺序即契约**）。
 *
 * ⚠️ 不手列第二份：外部要数类数就用 `FLOW_TYPES.length`。
 */
export const FLOW_TYPES = [
  'sequenceFlow',
  'dataObject',
  'dataObjectReference',
  'dataStoreReference',
] as const;

export type FlowKind = (typeof FLOW_TYPES)[number];

/** ★ 数据三兄弟：**不是**可执行节点（引擎只读不写） */
export const DATA_NODE_TYPES = [
  'dataObject',
  'dataObjectReference',
  'dataStoreReference',
] as const satisfies readonly FlowKind[];

export type DataNodeType = (typeof DATA_NODE_TYPES)[number];

/**
 * ★ 引擎对数据元素的立场：**只读**。
 *
 * 写数据状态是**业务副作用**，归宿主 —— `03` §6 写得很直白：「数据状态由业务方管理」。
 * 引擎若"顺手"把结果写进 `DataObject`，就等于在内核里藏了一个宿主看不见的写入点，
 * 而它的表结构、并发、事务**全都不在引擎的管辖范围内**（ADR-004：引擎内不做事务）。
 *
 * 宿主该走的三条正道：`FormProvider.snapshot()`（表单快照）/ `ServiceHandler`（服务调用）/
 * 门 1 `hooks`（业务写入）。
 */
export const DATA_ACCESS = 'readOnly' as const;

export function isDataNode(type: string | undefined): boolean {
  return (DATA_NODE_TYPES as readonly string[]).includes(type ?? '');
}

/**
 * 令牌落到数据节点 → **抛**。
 *
 * 为什么必须抛：`DataObject` 在 BPMN 里表达"这份数据存在且处于某状态"，
 * 它不是流程要经过的一步。令牌能落在上面只可能是**定义被画错了**（拿 `association`
 * 当 `sequenceFlow` 连、或建模工具导出错了）—— 静默走过去，这个错误永远不会被人发现。
 */
export function assertNotDataNode(type: string, nodeId: string): void {
  if (!isDataNode(type)) return;
  throw stateShapeInvalid(
    `token arrived at data node '${nodeId}' (${type}); data elements are not executable`,
    {
      nodeId,
      type,
      access: DATA_ACCESS,
      hint: '数据元素（dataObject / dataObjectReference / dataStoreReference）由业务方管理，引擎只读不写；令牌不该经 sequenceFlow 落到它上面',
    },
  );
}

/**
 * 数据节点的**引用目标**（`dataObjectRef` / `dataStoreRef`；都没有 → `itemSubjectRef`）。
 *
 * 只**读**，不解析（解析要模型层的知识，且当前没有消费者 —— 见档首的能力边界）。
 */
export function dataRefOf(node: FlowNode | undefined): string | undefined {
  if (node === undefined || node === null) return undefined;
  for (const key of ['dataObjectRef', 'dataStoreRef', 'itemSubjectRef'] as const) {
    const v = (node as unknown as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

// ---------------- ★ 连线通不通（唯一口径） ----------------

/**
 * 一条顺序流此刻通不通。
 *
 * ★ **无条件 = 恒真**（`expression === undefined`）—— 这不是"省事"，是 BPMN 的原语义：
 *   `sequenceFlow` 没有 `conditionExpression` 就是默认流，`Gateway.default` 指名的那条
 *   也是无条件通过。若把它交给求值器，`03` §7.2 要防的事故会立刻出现：
 *   空表达式被当成"要求值的一个表达式"，于是网关在**没配条件**时反而走不通。
 *
 * ⚠️ 求值器**不是**这里的参数默认值 —— 有条件就必须有求值器，缺了由调用方的
 *   `conditionsOf` 闭包抛哨兵（T16 的惰性解析），本档不发明"默认 false"。
 *
 * @param isTrue 条件表达式 → 布尔。**只**在有条件时被调用（D-52）
 */
export function flowPasses(
  flow: { readonly id: string; readonly expression?: string },
  isTrue: (expression: string) => boolean,
): boolean {
  if (flow.expression === undefined) return true;
  return isTrue(flow.expression);
}
