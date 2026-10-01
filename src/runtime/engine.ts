/**
 * @floken-io/engine · `createEngine()` —— 对外唯一门面（T11）
 *
 * 契约来源：`ARCHITECTURE.md` §3.3（九个槽位）/ §7.1（`Engine`）/ ADR-003（run-to-wait）/ ADR-007（时钟）。
 *
 * ★ **本文件是唯一"允许不纯"的地方**：它是 `runtime/`，可以读时钟、调 SPI、写存储。
 *   反过来，`plan()`（门 2 入口）与本文件调用的 `runtime/loop.ts` 都必须保持纯 ——
 *   因此**所有外部知识都在这里取好，再以闭包交给纯函数**：
 *
 *   ```
 *   submit = 入队 → load → 图/配置 → 【★ 探测落点 → 异步解析办理人】 → plan(纯) → save → 投影
 *                                          ↑ 这一步是本文件的关键设计
 *   ```
 *
 *   为什么必须"先探测再解析"：`runToWait()` 要走完图才知道**会落到哪些等待节点**，
 *   而办理人要 `ApproverSource`（异步 SPI）才拿得到。`plan()` 的 `apply` 接缝（D-18）又要求**同步纯**，
 *   所以不能把 SPI 塞进 `apply` 里。解法是**跑两次纯函数**：第一次带"占位办理人"问出落点，
 *   解析完再跑第二次 —— 两次都是纯的，且第二次的结果与门 2 自编排**逐字节相同**。
 *
 * ★ **九个槽位全部到位**（§3.3）：T11 落了 0~4 / 6~7，T12 补齐 5（门 1 前）、8（门 1 后）、9（事件）。
 *
 *   ⑤ `beforeAction` 在 `plan()` **之后**、`save()` **之前** —— 这个位置不是随手放的：
 *      放 save 之后就成了「写了再问能不能写」，否决时状态已经落库；放 plan 之前则拿不到
 *      `ctx.next`（宿主最常见的用法是「看下下一步是谁再决定要不要放行」）。
 *   ⑨ 事件在**最后**且**不 await**：`EventSink` 的语义是「丢了不影响流程」（ADR-006）。
 *
 * ⚠️ `deliverMessage` / `deliverSignal` / `exportTrace` 属 T20 / T18，不在本档。
 */

import type { ApproverSpec } from '@floken-io/moddle';

import type { PrimitiveCall } from '../actions/compile.js';
import { compileAction } from '../actions/compile.js';
import { HANDOVER_ACTIONS, SPAWN_ACTIONS } from '../actions/catalog.js';
import { assertActionInput } from '../core/action.js';
import type { ActionInput } from '../core/action.js';
import {
  actionVetoed,
  approverEmpty,
  definitionMissing,
  optionInvalid,
  optionUnknown,
  stateNotFound,
  stateShapeInvalid,
  stateTerminal,
} from '../core/errors.js';
import type { EngineHooks } from '../core/hooks.js';
import { freezeActionContext } from '../core/hooks.js';
import { LIVE_TOKEN_STATES } from '../core/primitives.js';
import type {
  ApproverCtx,
  ApproverSource,
  AuthResolver,
  ConditionHandler,
  DecisionHandler,
  DefinitionSource,
  EventSink,
  FormProvider,
  Scheduler,
  ServiceHandler,
  StateStore,
  TaskProjection,
} from '../core/spi.js';
import type { ActionRecord, InstanceState, Token } from '../core/state.js';
import { STATE_SCHEMA_VERSION, cloneState, headerOf, isTerminalStatus } from '../core/state.js';
import type { TaskDelta } from '../core/task.js';
import { assertTokensInGraph, createProcessGraph } from '../nodes/graph.js';
import type { OutFlow, ProcessGraph } from '../nodes/graph.js';
import { plan } from './plan.js';
import type { PlanOptions, PlanResult } from './plan.js';
import { createInstanceQueue } from './queue.js';
import { PROBE_ASSIGNEE, step, tasksOf } from './loop.js';
import type { StepInput, VoteCast } from './loop.js';
import type { PostStep } from '../actions/compile.js';
import { emitAll, eventsOf } from './emit.js';
import { createMemoryStore } from '../store/memory.js';
import { asUnresolved, createFeelConditionHandler, evaluateCondition, unresolvedCondition } from '../eval/condition.js';

/**
 * 条件惰性解析的重试上限。
 *
 * 真实上界是「条件数 + 1」（每轮至少解析一条新的），故正常流程 **1 轮就够**
 * （没有网关时 0 次重试）。这只是防"解析了却没被记住"这类 bug 导致无限重试的兜底闸。
 */
const MAX_CONDITION_ROUNDS = 256;

// ---------------- 配置 ----------------

export interface EngineConfig {
  /** 不传 = 内置 `createMemoryStore()`（NFR-E10「默认内存、可切换」） */
  store?: StateStore;
  /** ✅ 必填：`AC-E10` 要求按 `(processId, version)` 取图纸 */
  definitionSource: DefinitionSource;
  /** 不传 = 宿主自管待办表 */
  projection?: TaskProjection;
  /**
   * 不传 = 内置默认（**只认 `{type:'user'}`**，见 `DEFAULT_APPROVER_SOURCE`）。
   *
   * ★ 为什么给默认而不是"必填"：只有"内置默认 + 未注入即明确报错"两者结合，
   *   才能让「零配置跑通一条报销流程」（`AC-E13`）与「换人 / 角色解析必须显式注入」同时成立。
   */
  approverSource?: ApproverSource;
  handlers?: ServiceHandler;
  authResolver?: AuthResolver;
  formProvider?: FormProvider;
  conditionHandler?: ConditionHandler;
  decisionHandler?: DecisionHandler;
  events?: EventSink;
  scheduler?: Scheduler;
  /** 门 1（T12 接线） */
  hooks?: EngineHooks;
  /** ADR-007；不传 = 系统时钟 */
  clock?: () => string;
  /** INV-17 审计上限 */
  maxAuditEntries?: number;
}

export interface StartOptions {
  /** ✅ 必填（AC-E10：实例绑定定义版本，改版不影响在途） */
  definitionVersion: number;
  /** ✅ 必填（审计第一条的 `actor`） */
  starter: string;
  businessKey?: string;
  tenantId?: string;
  variables?: Record<string, unknown>;
}

export interface Engine {
  /** 发起一个实例；返回 `instanceId` */
  start(processId: string, opts: StartOptions): Promise<string>;
  /** 提交一次动作；返回待办差分（INV-15） */
  submit(instanceId: string, action: ActionInput): Promise<TaskDelta>;
  /**
   * ★ 门 2 入口：纯函数，不碰存储。
   * 本档只补上 `EngineConfig` 里的 `clock` / `maxAuditEntries`，其余交给调用方。
   */
  plan(state: InstanceState, action: ActionInput, options?: PlanOptions): PlanResult;
}

// ---------------- 配置校验（禁止静默忽略，D-7） ----------------

const ENGINE_CONFIG_KEYS = [
  'store',
  'definitionSource',
  'projection',
  'approverSource',
  'handlers',
  'authResolver',
  'formProvider',
  'conditionHandler',
  'decisionHandler',
  'events',
  'scheduler',
  'hooks',
  'clock',
  'maxAuditEntries',
] as const;

function assertEngineConfig(config: unknown): void {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw optionInvalid('config', 'must be a plain object', config);
  }
  const c = config as Record<string, unknown>;

  for (const key of Object.keys(c)) {
    if (!(ENGINE_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw optionUnknown(key, ENGINE_CONFIG_KEYS);
    }
  }

  const needFn = (key: string, methods: readonly string[]): void => {
    const v = c[key];
    if (v === undefined) return;
    if (typeof v !== 'object' || v === null) {
      throw optionInvalid(key, 'must be an object', v);
    }
    const o = v as Record<string, unknown>;
    for (const m of methods) {
      if (typeof o[m] !== 'function') {
        throw optionInvalid(`${key}.${m}`, 'must be a function', o[m]);
      }
    }
  };

  needFn('store', ['load', 'save']);
  needFn('definitionSource', ['getDefinition']);
  needFn('projection', ['apply', 'sync']);
  needFn('approverSource', ['resolve']);
  needFn('conditionHandler', ['evaluate']);
  needFn('decisionHandler', ['evaluate']);

  if (c.definitionSource === undefined) {
    throw optionInvalid('definitionSource', 'is required (AC-E10: definitions are fetched by processId + version)', undefined);
  }
  if (c.clock !== undefined && typeof c.clock !== 'function') {
    throw optionInvalid('clock', 'must be a function returning an ISO 8601 string', c.clock);
  }
  if (c.maxAuditEntries !== undefined) {
    const n = c.maxAuditEntries;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      throw optionInvalid('maxAuditEntries', 'must be a positive integer', n);
    }
  }
}

function assertStartOptions(opts: unknown): void {
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
    throw optionInvalid('opts', 'must be a plain object', opts);
  }
  const o = opts as Record<string, unknown>;
  const fail = (field: string, reason: string): never => {
    throw optionInvalid(`opts.${field}`, reason, o[field]);
  };
  if (!Number.isInteger(o.definitionVersion) || (o.definitionVersion as number) < 1) {
    fail('definitionVersion', 'must be a positive integer');
  }
  if (typeof o.starter !== 'string' || o.starter.length === 0) {
    fail('starter', 'must be a non-empty string');
  }
  if (o.businessKey !== undefined && typeof o.businessKey !== 'string') {
    fail('businessKey', 'must be a string when present');
  }
  if (o.tenantId !== undefined && typeof o.tenantId !== 'string') {
    fail('tenantId', 'must be a string when present');
  }
  if (o.variables !== undefined && (typeof o.variables !== 'object' || o.variables === null || Array.isArray(o.variables))) {
    fail('variables', 'must be a plain object when present');
  }
}

// ---------------- 默认实现 ----------------

/** 系统时钟（唯一允许出现 `Date.now()` 的地方 —— 见 ADR-007：`plan()` 绝不回退它） */
const defaultClock = (): string => new Date().toISOString();

/**
 * ★ 内置默认 `ApproverSource`：只认 `{type:'user', value}`。
 *
 * 其余 6 类（`role` / `dept` / `starterLeader` / `deptLeader` / `formField` / `expr`）**一律抛错**，
 * 不静默返回空集 —— 空集会触发 INV-13 的 `ACTION_APPROVER_EMPTY`，
 * 把「没注入 `ApproverSource`」这个**真因**包装成「解析不出人」，排查方向直接跑偏。
 */
const DEFAULT_APPROVER_SOURCE: ApproverSource = {
  async resolve(spec: ApproverSpec): Promise<string[]> {
    if (spec !== null && typeof spec === 'object' && spec.type === 'user' && typeof spec.value === 'string') {
      return [spec.value];
    }
    const type = (spec as { type?: unknown } | null)?.type;
    throw optionInvalid(
      'approverSource',
      `cannot resolve approver spec type '${String(type)}' without an injected ApproverSource`,
      spec,
    );
  },
};

let instanceSeq = 0;

/**
 * 实例 id：`pi_` 前缀 + 时间基线 + 进程内序号 + 随机尾。
 *
 * 不用 `crypto.randomUUID()`：`Math.random` 尾已足够避免同毫秒内的碰撞，
 * 且不引入对 `crypto` 全局的依赖（同一份代码要能在浏览器里跑）。
 */
function newInstanceId(): string {
  instanceSeq += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `pi_${Date.now().toString(36)}_${instanceSeq.toString(36)}_${rand}`;
}

// ---------------- 工厂 ----------------

export function createEngine(config: EngineConfig): Engine {
  assertEngineConfig(config);

  const clock: () => string = config.clock ?? defaultClock;
  const store: StateStore = config.store ?? createMemoryStore();
  const { definitionSource } = config;
  const projection: TaskProjection | undefined = config.projection;
  const approverSource: ApproverSource = config.approverSource ?? DEFAULT_APPROVER_SOURCE;
  /**
   * 条件求值（网关分支 / 顺序流）。不注入 = 内置 `@floken-io/feel`（NFR-E10 零配置可跑）。
   *
   * ★ **T16 接线完成**：网关的每条出向条件经 `evaluateCondition()` 求值（唯一出口，**D-40**）。
   *
   * ⚠️ 求值**不是**在拿到图之后一次性把全图条件算完 —— 那样会让「本次根本走不到的分支」
   *   也被求值，而那些分支引用的变量此刻可能还不存在（`amount` 要第二步表单才填），
   *   按 D-38（`null` 必抛）流程会在**第一步就炸**。故走 **惰性解析 + 重跑**：
   *   `conditionsOf` 闭包在缺值时抛 `ConditionUnresolved` → 本档求值 → 重跑 `step()`
   *   （每轮至少多解析一条 ⇒ 轮数 ≤ 条件数 + 1，必然收敛）。
   */
  const condition: ConditionHandler = config.conditionHandler ?? createFeelConditionHandler();
  const maxAuditEntries: number | undefined = config.maxAuditEntries;
  const hooks: EngineHooks | undefined = config.hooks;
  /** 事件出口（槽位 9）；不注入 = 不发事件（AuditTrail 仍是完整的，见 ADR-006） */
  const sink: EventSink | undefined = config.events;

  const queue = createInstanceQueue();

  function now(): string {
    const t = clock();
    if (typeof t !== 'string' || t.length === 0) {
      throw optionInvalid('clock', 'must return a non-empty ISO 8601 string', t);
    }
    return t;
  }

  /** 取图纸 + 建图（`AC-E10`：按实例**绑定**的版本取，不是最新版） */
  async function graphOf(state: Pick<InstanceState, 'processId' | 'definitionVersion'>): Promise<ProcessGraph> {
    const def = await definitionSource.getDefinition(state.processId, state.definitionVersion);
    if (def === null || def === undefined) {
      throw definitionMissing(state.processId, state.definitionVersion);
    }
    return createProcessGraph(def, state.processId, state.definitionVersion);
  }

  /**
   * ★ 组装 `plan()` 的 `apply` 接缝（D-18）。
   *
   * 两次调用同一个纯函数：第一次用占位办理人问出落点，解析完再跑第二次。
   * 第二次的结果与「门 2 下宿主自己调 `plan()`」**完全一致** —— 这是 §7.1 那条硬约束的落点。
   *
   * ★ **T16 追加：条件走「惰性解析 + 重跑」**（理由见 `condition` 的注释）。
   *   重试循环**包住整个探测 + 闭包构造**：探测跑本身也会撞上未解析的条件，
   *   解析完重跑一次，探测路径与真值路径就必然一致（不会问错落点）。
   *
   * @param state 已并入 `payload` 增量的状态（与 `plan()` 交给 `apply` 的那份**同源** ——
   *              否则「表单里把 amount 改成 9000、网关却按旧值走分支」，正是 §7.2 要防的事故）
   */
  async function buildApply(params: {
    readonly state: InstanceState;
    readonly calls: readonly PrimitiveCall[];
    readonly graph: ProcessGraph;
    readonly at: string;
    /** 组内投票（`CompiledAction.vote`）；非组内动作为 `undefined` */
    readonly vote?: VoteCast | undefined;
    /** ★ T15 令牌级微调（`CompiledAction.post`：委派回归 / 解散组） */
    readonly post?: PostStep | undefined;
    /** 汇聚驳回时的显式退回目标 */
    readonly rejectTarget?: string | undefined;
  }): Promise<(draft: InstanceState) => InstanceState> {
    const { state, calls, graph, at } = params;
    const stepInput: StepInput = {
      calls,
      ...(params.vote !== undefined ? { vote: params.vote } : {}),
      ...(params.post !== undefined ? { post: params.post } : {}),
      ...(params.rejectTarget !== undefined ? { rejectTarget: params.rejectTarget } : {}),
    };

    /** 已解析的条件（按 flow id）。惰性填充 —— 只算本次**真正走到**的那几条 */
    const conditions = new Map<string, boolean>();
    const conditionsOf = (flow: OutFlow, nodeId: string): boolean => {
      // D-42：无条件（BPMN 的默认流）→ 恒真，不进求值器
      if (flow.expression === undefined) return true;
      const value = conditions.get(flow.id);
      if (value === undefined) throw unresolvedCondition(flow.id, flow.expression, nodeId);
      return value;
    };

    for (let round = 0; ; round += 1) {
      try {
        /*
         * ★ 探测跑的是**完整的 `step()`**（含投票与汇聚），不是只跑 run-to-wait：
         *   会签最后一人通过后，落点是**汇聚之后的下一个节点**，只跑推进会问错落点。
         */
        const probe = new Set<string>();
        step(cloneState(state), {
          graph,
          at,
          assigneesOf: (nodeId) => {
            probe.add(nodeId);
            return [PROBE_ASSIGNEE];
          },
          conditionsOf,
        }, stepInput);

        const resolved = new Map<string, readonly string[]>();
        for (const nodeId of probe) {
          resolved.set(nodeId, await resolveAssigneesFor(nodeId, state, graph, approverSource));
        }

        return (draft: InstanceState): InstanceState =>
          step(draft, { graph, at, assigneesOf: (nodeId) => resolved.get(nodeId) ?? [], conditionsOf }, stepInput)
            .next;
      } catch (e) {
        const pending = asUnresolved(e);
        if (pending === undefined) throw e; // 不是"条件未解析"→ 原样抛出，绝不吞
        if (round >= MAX_CONDITION_ROUNDS) {
          throw stateShapeInvalid('condition resolution did not converge (retry budget exceeded)', {
            budget: MAX_CONDITION_ROUNDS,
            instanceId: state.instanceId,
          });
        }
        conditions.set(
          pending.flowId,
          await evaluateCondition(condition, pending.expression, {
            instanceId: state.instanceId,
            nodeId: pending.nodeId,
            variables: state.variables,
          }),
        );
      }
    }
  }

  async function start(processId: string, opts: StartOptions): Promise<string> {
    assertStartOptions(opts);
    const at = now();
    const graph = await graphOf({ processId, definitionVersion: opts.definitionVersion });

    const instanceId = newInstanceId();
    const base: InstanceState = {
      instanceId,
      processId,
      definitionVersion: opts.definitionVersion,
      status: 'running',
      rev: 0, // ★ INSERT 信号（store 据此分两条路径）
      stateSchema: STATE_SCHEMA_VERSION,
      startedAt: at,
      updatedAt: at,
      tokens: [{ id: 'tk_start', nodeId: graph.startNodeId, state: 'active' }],
      completedNodes: [],
      variables: { ...(opts.variables ?? {}) },
      auditTrail: [],
      starter: opts.starter,
    };
    if (opts.businessKey !== undefined) base.businessKey = opts.businessKey;
    if (opts.tenantId !== undefined) base.tenantId = opts.tenantId;

    // 发起也要跑 run-to-wait：发起节点是自动节点，令牌要一直走到第一个等待节点
    const apply = await buildApply({ state: base, calls: [], graph, at });
    const looped = apply(cloneState(base));

    const record: ActionRecord = { name: 'start', actor: opts.starter, at };
    const next: InstanceState = {
      ...looped,
      rev: 1,
      lastAction: record,
      auditTrail: [
        { seq: 1, at, actor: opts.starter, action: 'start', nodeId: graph.startNodeId },
      ],
    };

    const delta: TaskDelta = {
      rev: next.rev,
      action: record,
      added: tasksOf(next, graph),
      removed: [],
      changed: [],
      instance: headerOf(next),
    };

    await store.save(next, 0); // INSERT
    if (projection !== undefined) await projection.apply(instanceId, delta);

    /*
     * 槽位 9：`started` + 首批待办的 `taskCreated` / `taskAssigned`。
     *
     * ⚠️ **`start()` 刻意不触发门 1 `hooks`**（D-27）：`beforeAction` 的语义是「可否决本次动作」，
     *    而 `start()` 之前实例**根本不存在**，没有"否决后回滚到的那个状态"，`ctx.state` 也无意义。
     *    宿主要拦发起（如业务键去重）请**在调 `start()` 之前自己判** ——
     *    那时也拿得到更完整的上下文。
     */
    emitAll(sink, eventsOf({ before: [], delta, next }));
    return instanceId;
  }

  async function submit(instanceId: string, action: ActionInput): Promise<TaskDelta> {
    // 槽位 0：per-instance FIFO 串行（NFR-E5 主防线）—— 同实例的两次提交永不交错
    return queue.run(instanceId, async () => {
      assertActionInput(action, 'action');

      // 槽位 1
      const state = await store.load(instanceId);
      if (state === null || state === undefined) throw stateNotFound(instanceId);

      /*
       * ★ INV-2 必须在**编译之前**判（不能只靠 `plan()` 里那道）：
       *   终态实例一个活令牌都没有，`compileAction()` 会先撞上「无法唯一定位令牌」而抛
       *   `STATE_SHAPE_INVALID` —— 真因（实例已结束）被包装成一条完全无关的错。
       */
      if (isTerminalStatus(state.status)) {
        throw stateTerminal(state.instanceId, state.status, action.action);
      }

      // 槽位 3（ADR-007）：时间在调 plan() **之前**填好
      const at = action.at ?? now();
      const input: ActionInput = action.at === undefined ? { ...action, at } : action;

      // 槽位 2 的前置：图纸与图（INV-3 的判定点）
      const graph = await graphOf(state);
      assertTokensInGraph(state, graph);

      const tokenId = resolveSubjectToken(state, input);
      const subject = tokenId === undefined ? undefined : state.tokens.find((t) => t.id === tokenId);
      const nodeId = subject?.nodeId;
      const approval = nodeId === undefined ? undefined : graph.approvalOf(nodeId);

      // 槽位 2：受理校验 + 编译（换人 / 加签需要办理人，先解析）
      const assignees = await resolveActionAssignees(input, nodeId, state, graph, approverSource);
      const compiled = compileAction(input, state, {
        approval,
        nextOf: graph.nextOf,
        startNodeId: graph.startNodeId,
        ...(tokenId !== undefined ? { tokenId } : {}),
        ...(assignees !== undefined ? { assignees } : {}),
        ...(payloadString(input.payload, 'groupId') !== undefined
          ? { groupId: payloadString(input.payload, 'groupId') as string }
          : {}),
        ...(payloadStringArray(input.payload, 'reduceTokenIds') !== undefined
          ? { reduceTokenIds: payloadStringArray(input.payload, 'reduceTokenIds') as string[] }
          : {}),
      });

      // 事件的字段来源：`removed` 只有 taskId，事件里的 nodeId / assignee 只能从旧视图取
      const before = tasksOf(state, graph);

      // 槽位 4（纯函数）：动作语义经 D-18 的接缝进来
      const apply = await buildApply({
        /*
         * ★ 传给探测/闭包的是**已并入 payload 增量**的状态。
         *   `plan()` 在 ④.5 先并变量、④.6 才调 `apply` —— 探测必须用同一份，
         *   否则「表单里把 amount 改成 9000、网关却按旧值走分支」（§7.2 要防的头号事故）。
         */
        state: withPayload(state, input.payload),
        calls: compiled.calls,
        graph,
        at,
        ...(compiled.vote !== undefined ? { vote: compiled.vote } : {}),
        ...(compiled.post !== undefined ? { post: compiled.post } : {}),
        ...(input.target !== undefined ? { rejectTarget: input.target } : {}),
      });
      const result = plan(state, input, {
        clock,
        ...(maxAuditEntries !== undefined ? { maxAuditEntries } : {}),
        apply,
        tasks: (s) => tasksOf(s, graph),
      });

      /*
       * 槽位 5 / 8 共用的只读上下文。
       * ★ `action` 取 `result.delta.action` —— 与 `lastAction` / `auditTrail` **同一份对象**，
       *   宿主从三个通道看到的动作事实必然一致（各造一份就会在重放时对不上）。
       */
      const ctx = freezeActionContext({
        action: result.delta.action,
        state: headerOf(state),
        next: headerOf(result.next),
        delta: result.delta,
      });

      // 槽位 5：门 1 前钩子 —— **可否决**（在 save 之前，故否决 = 状态未变）
      if (hooks?.beforeAction !== undefined) {
        const verdict = await hooks.beforeAction(ctx);
        if (verdict === false) throw actionVetoed(input.action, instanceId);
      }

      // 槽位 6：唯一权威提交点（CAS）
      await store.save(result.next, state.rev);
      // 槽位 7：投影（可选）
      if (projection !== undefined) await projection.apply(instanceId, result.delta);
      // 槽位 8：门 1 后钩子 —— await 且**不吞**（至少一次，宿主幂等；失败时状态已落库）
      if (hooks?.afterAction !== undefined) await hooks.afterAction(ctx);

      // 槽位 9：事件（不 await、失败不影响流程）
      emitAll(
        sink,
        eventsOf({ before, delta: result.delta, next: result.next, previousStatus: state.status }),
      );

      return result.delta;
    });
  }

  return {
    start,
    submit,
    plan: (state, action, options) =>
      plan(state, action, {
        clock,
        ...(maxAuditEntries !== undefined ? { maxAuditEntries } : {}),
        ...options,
      }),
  };
}

// ---------------- 内部 helpers ----------------

/**
 * 并入本次提交的变量增量（与 `plan()` ④.5 **同一口径**）。
 *
 * ⚠️ 不改入参，只产出新对象 —— 探测跑、`resolveAssigneesFor`、条件上下文都基于它，
 *   而真正的落库状态仍由 `plan()` 自己并（那里才是权威）。
 */
function withPayload(
  state: InstanceState,
  payload: ActionInput['payload'],
): InstanceState {
  if (payload === undefined) return state;
  return { ...state, variables: { ...state.variables, ...payload } };
}

/**
 * 解析某等待节点的办理人 —— `ApproverSource` 是**唯一**知道"谁是部门负责人"的地方
 * （`03` §8.2：`{type:'deptLeader', of:'starter'}` 到底是谁，每家公司答案不同）。
 *
 * ⚠️ 未配 `floken:approval` 的节点 → `ACTION_APPROVER_EMPTY`（INV-13）：
 * 让"这个节点没配审批"表现为一条能照着修的错误，而不是"流程静默卡住"。
 */
async function resolveAssigneesFor(
  nodeId: string,
  state: InstanceState,
  graph: ProcessGraph,
  approverSource: ApproverSource,
): Promise<readonly string[]> {
  const approval = graph.approvalOf(nodeId);
  if (approval === undefined) {
    throw approverEmpty(nodeId, 'error', {
      instanceId: state.instanceId,
      reason: `node '${nodeId}' has no ${'floken:approval'} config`,
    });
  }
  const ctx: ApproverCtx = {
    instanceId: state.instanceId,
    processId: state.processId,
    nodeId,
    starter: state.starter ?? '',
    variables: state.variables,
  };
  const out: string[] = [];
  for (const spec of approval.approvers) {
    const list = await approverSource.resolve(spec, ctx);
    for (const id of list ?? []) {
      if (typeof id === 'string' && id.length > 0) out.push(id);
    }
  }
  return [...new Set(out)];
}

/**
 * 本次动作作用在哪个令牌上。
 *
 * 判据（**与 `compileAction.resolveToken` 同一口径**，只是这里优先按 `actor` 认领）：
 *   ① 办理人 == `actor` 的在途令牌恰好 1 个 → 它（会签下"我办我那条"就是靠这条）；
 *   ② 否则若全局在途令牌恰好 1 个 → 它；
 *   ③ 否则 → `undefined`（交给 `compileAction` 报"无法唯一定位"，或该动作本就不需要令牌）。
 *
 * ⚠️ ① 与 ② 都不命中时**不猜**：猜错令牌 = 改到了别人的待办，是最难查的一类误伤。
 */
function resolveSubjectToken(state: InstanceState, input: ActionInput): string | undefined {
  const live = state.tokens.filter((t) => LIVE_TOKEN_STATES.includes(t.state));
  if (live.length === 0) return undefined;

  const mine = live.filter((t) => t.assignee !== undefined && t.assignee === input.actor);
  if (mine.length === 1) return (mine[0] as Token).id;
  if (live.length === 1) return (live[0] as Token).id;
  return undefined;
}

/** 换人类动作必须**点名**目标人；加签 / 会签未点名时展开该节点配置的办理人 */
async function resolveActionAssignees(
  input: ActionInput,
  nodeId: string | undefined,
  state: InstanceState,
  graph: ProcessGraph,
  approverSource: ApproverSource,
): Promise<readonly string[] | undefined> {
  if (nodeId === undefined) return undefined;
  const explicit = explicitAssignees(input.payload);

  if ((HANDOVER_ACTIONS as readonly string[]).includes(input.action)) {
    // 转办 / 委派：**不自动猜**目标人 —— 猜错就是把待办转给了错的人
    return explicit;
  }
  if ((SPAWN_ACTIONS as readonly string[]).includes(input.action)) {
    if (explicit !== undefined) return explicit;
    return await resolveAssigneesFor(nodeId, state, graph, approverSource);
  }
  return undefined;
}

/** `payload.assignee`（单）或 `payload.assignees`（多）；都没有 → `undefined` */
function explicitAssignees(payload: Record<string, unknown> | undefined): readonly string[] | undefined {
  if (payload === undefined) return undefined;
  const one = payload['assignee'];
  if (typeof one === 'string' && one.length > 0) return [one];
  const many = payload['assignees'];
  if (Array.isArray(many)) {
    const list = many.filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (list.length > 0) return list;
  }
  return undefined;
}

function payloadString(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = payload?.[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function payloadStringArray(
  payload: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const v = payload?.[key];
  if (!Array.isArray(v)) return undefined;
  const list = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return list.length > 0 ? list : undefined;
}
