/**
 * 测试夹具：构造 `ProcessDefinition`（`DefinitionSource` 的返回物）。
 *
 * ★ 放在 `test/helpers/` 而不是 `src/` —— 定义是**业务资产**，不是引擎契约；
 *   进 `src/` 等于给引擎塞了一份"示例流程"，且会背上 semver 约束。
 *
 * ★ 只造**最小合法**的图：`createProcessGraph` 只认 `startEvent` / `userTask` / `endEvent`
 *   三类（T11 边界），多出向与子流程刻意不在本夹具里 —— 它们的语义还没实现。
 *
 * ★ **moddle v2（Q48）形状变更**：`processes[]` 已删除、节点与连线上提；
 *   `approval` / `call` 提升为**一等字段**（v1 住在 `extension['floken:*']` 里）。
 *   本夹具把这些差异**收在这一处**，701 个用例不必逐个改。
 */
import type { Flow, FlowNode, ProcessDefinition } from '@floken-io/moddle';

export interface TestNode {
  id: string;
  /** BPMN 元素名（小驼峰） */
  type: string;
  name?: string;
  formKey?: string;
  /**
   * `default`（网关 / 活动）—— 指向一条 `sequenceFlow` 的 **id**。
   * 只在「一条条件都没中」时才走。
   */
  defaultFlow?: string;
  /** ★ v2 一等字段：`approval`（v1 是 `extension['floken:approval']`） */
  approval?: Record<string, unknown>;
  /**
   * T17：任务类节点的取参。**只造引擎真的会读的那几个字段**，
   * 不做全字段映射（那是 `01-moddle` 的活）。
   */
  /** `<bpmn:script>` 子元素（`scriptTask`） */
  script?: string;
  /** `scriptFormat`（`scriptTask`） */
  scriptFormat?: string;
  /** `implementation`（`serviceTask` 的 handler 查找键；`##` 前缀的会被忽略） */
  implementation?: string;
  /** `operationRef`（`serviceTask` 的 handler 查找键） */
  operationRef?: string;
  /**
   * T18：内嵌子流程的**内嵌元素**（`FlowNode.nodes` / `flows`）。
   * 给了它（且 `triggeredByEvent` 不为 true）→ 建图时会被**展开**成父图的一部分。
   */
  nodes?: readonly TestNode[];
  flows?: readonly TestFlow[];
  /** `triggeredByEvent`（事件子流程 → 不展开，运行期显式抛错，FR-E24 / T21） */
  triggeredByEvent?: boolean;
  /** `calledElement`（`callActivity`：被调用流程的 processId） */
  calledElement?: string;
  /**
   * T20：`messageRef`（`receiveTask` 等消息的名字）。
   * 缺它 → `catchBindingOf()` 抛（等不到 = 永久卡死，引擎不放行）。
   */
  messageRef?: string;
  /**
   * T20：`eventDefinition`（各类事件的事件定义）。
   * 常用两种：`{type:'message', messageRef:'Msg_x'}` / `{type:'signal', signalRef:'Sig_x'}`；
   * 给 `{type:'timer'}` 之类 → 抛（归 T21）。
   */
  eventDefinition?: Record<string, unknown>;
  /**
   * T21：`attachedTo`（`boundaryEvent` 挂在哪個活动上）。
   * 缺它 → `boundaryBindingOf()` 抛（悬空的监听器永远不会触发）。
   */
  attachedTo?: string;
  /**
   * T21：`cancelActivity`（`boundaryEvent` 触发后是否取消宿主活动）。
   * ⚠️ **缺省 `true`**（与 BPMN 规范一致）—— 不给就是"中断"。
   */
  cancelActivity?: boolean;
  /**
   * ★ v2 一等字段：`call`（`CallSpec { processId, version }`）。
   * 旧写法 `calledElement` 仍接受 —— 夹具会把它并进 `call.processId`。
   */
  call?: Record<string, unknown>;
  /**
   * ★ ADR-009：直接挂到 `node.extension` 上的**任意额外键**（宿主自定义扩展属性）。
   *
   * v2 起 `extension` 是**任意 JSON**（无前缀、不限标量）；一等字段（`approval` / `call` …）
   * 与它分开存 —— 用来测「保留键被排除、其余原样给出」。
   */
  extension?: Record<string, unknown>;
}

export interface TestFlow {
  /** 显式给 flow id（网关的 `default` 要指名它）；不给则按序号生成 `Flow_<n>` */
  id?: string;
  from: string;
  to: string;
  /** 条件表达式（`conditionExpression`）；不给 = 无条件 */
  condition?: string;
}

function buildNodes(list: readonly TestNode[]): FlowNode[] {
  return list.map((n) => {
    const node: Record<string, unknown> = { id: n.id, type: n.type };
    if (n.name !== undefined) node.name = n.name;
    if (n.formKey !== undefined) node.formKey = n.formKey;
    if (n.defaultFlow !== undefined) node.defaultFlow = n.defaultFlow;
    if (n.approval !== undefined) node.approval = n.approval;
    // ★ v2：`call` 是一等字段；旧写法 `calledElement` 并进它的 `processId`
    if (n.call !== undefined || n.calledElement !== undefined) {
      node.call = {
        ...(n.call ?? {}),
        ...(n.calledElement === undefined ? {} : { processId: n.calledElement }),
      };
    }
    if (n.extension !== undefined) node.extension = { ...(n.extension as Record<string, unknown>) };
    if (n.script !== undefined) node.script = { body: n.script };
    if (n.scriptFormat !== undefined) {
      node.script = { ...(node.script as Record<string, unknown> | undefined), language: n.scriptFormat };
    }
    if (n.implementation !== undefined) node.implementation = n.implementation;
    if (n.operationRef !== undefined) node.operationRef = n.operationRef;
    if (n.triggeredByEvent !== undefined) node.triggeredByEvent = n.triggeredByEvent;
    // `calledElement` 已在上面并进 `call.processId`（v2 一等字段）
    if (n.attachedTo !== undefined) node.attachedTo = n.attachedTo;
    if (n.cancelActivity !== undefined) node.cancelActivity = n.cancelActivity;
    if (n.messageRef !== undefined) node.messageRef = n.messageRef;
    if (n.eventDefinition !== undefined) node.eventDefinition = n.eventDefinition;
    if (n.nodes !== undefined) node.nodes = buildNodes(n.nodes);
    if (n.flows !== undefined) node.flows = buildFlows(n.flows);
    return node as unknown as FlowNode;
  });
}

function buildFlows(list: readonly TestFlow[]): Flow[] {
  return list.map((f, i) => ({
    id: f.id ?? `Flow_${i + 1}`,
    from: f.from,
    to: f.to,
    ...(f.condition === undefined ? {} : { condition: f.condition }),
  }));
}

export function makeDefinition(opts: {
  id?: string;
  version?: number;
  /** ★ 流程 id（缺省 `Process_1`）。T18 起 `CallActivity` 要造**另一个** processId 的定义 */
  processId?: string;
  nodes: readonly TestNode[];
  flows: readonly TestFlow[];
}): ProcessDefinition {
  const nodes = buildNodes(opts.nodes);
  const flows = buildFlows(opts.flows);

  /*
   * ★ v2：一个定义**就是**一个流程，没有 `processes[]`。
   * 于是「定义 id」与「流程 id」合一 —— 取 `processId` 优先（引擎按它建图）。
   */
  return {
    schemaVersion: '2.0.0',
    // ★ `id` 选项保留仅为兼容旧夹具的书写（它不再影响建图）；身份一律由 `processId` 决定
    id: opts.processId ?? 'Process_1',
    ...(opts.version === undefined ? {} : { version: opts.version }),
    nodes,
    flows,
  };
}

/** `{type:'user'}` 的单人审批配置 —— 内置默认 `ApproverSource` 能解析的唯一一类 */
export const userApproval = (value: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  approvers: [{ type: 'user', value }],
  ...extra,
});

/**
 * ★ 「报销」三段流程（AC-E13 的贯穿场景）：
 *   `Start_1 → Task_apply（部门经理 u_manager）→ Task_finance（财务 u_finance）→ End_1`
 */
export function expenseDefinition(): ProcessDefinition {
  return makeDefinition({
    processId: 'Process_1',
    version: 1,
    nodes: [
      { id: 'Start_1', type: 'startEvent', name: '提交报销' },
      {
        id: 'Task_apply',
        type: 'userTask',
        name: '部门经理审批',
        formKey: 'form_expense',
        approval: userApproval('u_manager'),
      },
      {
        id: 'Task_finance',
        type: 'userTask',
        name: '财务审批',
        approval: userApproval('u_finance'),
      },
      { id: 'End_1', type: 'endEvent', name: '结束' },
    ],
    flows: [
      { from: 'Start_1', to: 'Task_apply' },
      { from: 'Task_apply', to: 'Task_finance' },
      { from: 'Task_finance', to: 'End_1' },
    ],
  });
}

/**
 * ★ 多流程 / 多版本的 `DefinitionSource`（T18：`CallActivity` 要按**绑定版本**取另一份定义）。
 *
 * 键 = `${processId}@${version}`。取不到返回 `null`（与 `03` §8.1 的契约一致）。
 */
export function mapSource(
  entries: Readonly<Record<string, ProcessDefinition>>,
): { getDefinition(pid: string, v: number): Promise<ProcessDefinition | null> } {
  return {
    async getDefinition(pid: string, v: number): Promise<ProcessDefinition | null> {
      return entries[`${pid}@${v}`] ?? null;
    },
  };
}

/** 单版本 `DefinitionSource`（AC-E10：按 `(processId, version)` 取，取不到返回 `null`） */
export function singleVersionSource(
  processId: string,
  version: number,
  def: ProcessDefinition,
): { getDefinition(pid: string, v: number): Promise<ProcessDefinition | null> } {
  return {
    async getDefinition(pid: string, v: number): Promise<ProcessDefinition | null> {
      return pid === processId && v === version ? def : null;
    },
  };
}
