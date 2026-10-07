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
 * ★ **T20 追加**：`deliverMessage` / `deliverSignal` 与 `submit()` **同构**（同样九个槽位、
 *   同样走 `plan()` 的 `apply` 接缝、同样经 `queue.run()` 串行），差别只有两点：
 *     ① 纯执行段是 `deliverStep()`（匹配 → 唤醒 → run-to-wait）而不是 `step()`（原语 → 记票 → …）；
 *     ② 动作名是**第四类**（`deliverMessage` / `deliverSignal`），不是 19 项审批动作。
 *
 * ★ `exportTrace()`（T22）在本档只有两行 —— 投影逻辑全在 `runtime/trace.ts`（纯函数）。
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
  deliverNoTarget,
  optionInvalid,
  optionUnknown,
  stateNotFound,
  stateShapeInvalid,
  stateSuspended,
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
import type { ActionRecord, AuditEntry, InstanceParent, InstanceState, Token } from '../core/state.js';
import { STATE_SCHEMA_VERSION, cloneState, headerOf, isTerminalStatus } from '../core/state.js';
import type { TaskDelta } from '../core/task.js';
import { subjectTokenOf } from '../core/task.js';
import type { TraceResult } from './trace.js';
import type { EngineEvent, TaskEvent } from '../core/events.js';
import { assertTokensInGraph, createProcessGraph } from '../nodes/graph.js';
import type { OutFlow, ProcessGraph } from '../nodes/graph.js';
import { CALL_RETURN_ACTION, callReturnOf } from '../nodes/activities.js';
import type { PendingCall } from '../nodes/activities.js';
import {
  MESSAGE_DELIVER_ACTION,
  SIGNAL_DELIVER_ACTION,
  matchingTokens,
  waitingNamesOf,
} from '../nodes/catch.js';
import { armedBoundaries, armedNamesOf } from '../nodes/boundary.js';
import type { CatchKind, DeliverMatch } from '../nodes/catch.js';
import type { NodeEffect, TaskEffectKind } from '../nodes/tasks.js';
import {
  asUnresolvedEffect,
  assertVariablePatch,
  effectKeyOf,
  effectKindOf,
  isFeelScriptFormat,
  unresolvedEffect,
} from '../nodes/tasks.js';
import { plan } from './plan.js';
import type { PlanOptions, PlanResult } from './plan.js';
import { deliverStep } from './deliver.js';
import type { DeliverMode } from './deliver.js';
import { diffTimers } from './timers.js';
import { traceOf } from './trace.js';
import { createInstanceQueue } from './queue.js';
import { PROBE_ASSIGNEE, step, tasksOf } from './loop.js';
import type { LoopContext, LoopResult, StepInput, VoteCast } from './loop.js';
import type { PostStep } from '../actions/compile.js';
import { emitAll, eventsOf } from './emit.js';
import { createMemoryStore } from '../store/memory.js';
import {
  asUnresolved,
  createFeelConditionHandler,
  evaluateCondition,
  unresolvedCondition,
} from '../eval/condition.js';
import { evaluateScript } from '../eval/script.js';

/**
 * 条件 / 副作用惰性解析的重试上限。
 *
 * 真实上界是「条件数 + 副作用数 + 1」（每轮至少解析一个新的），故正常流程 **1 轮就够**
 * （没有网关 / 服务节点时 0 次重试）。这只是防"解析了却没被记住"这类 bug 导致无限重试的兜底闸。
 */
const MAX_RESOLVE_ROUNDS = 256;

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
  /**
   * ★ ADR-009：把宿主自定义扩展属性**并入求值上下文**（opt-in）。
   *
   * 不声明 → 只给 `ctx.nodeExtensions` / `ctx.targetExtensions` 两个**只读**字段，
   * **不并入** `variables`（0.0.1 语义逐字不变）。
   */
  extensionVars?: ExtensionVarsOption;
}

/**
 * ★ ADR-009 的 opt-in 配置。
 *
 * 为什么并入形态是**两个对象**而不是把键平铺进 `variables`：
 * 平铺的撞车面是「每个键」（表单字段 / 脚本产出的变量都可能同名），
 * 撞了就要决出胜负 —— 静默覆盖正是 §7.2 要防的头号事故。
 * 挂成 `variables.node` / `variables.target` 后，撞车面降到「两个名字」，
 * 且语义天然分层：**设计期配置** vs **运行期数据**。
 */
export interface ExtensionVarsOption {
  /**
   * ★ **当前节点**扩展属性并入后的顶层键名（默认 `'node'`）。
   *
   * ⚠️ 若流程变量里已有同名键 → 抛 `ENGINE_OPTION_INVALID`（**不静默覆盖**，细则⑦）。
   * 撞了就改这个名字，不要去改业务变量 —— 那会把业务数据挤掉。
   */
  key?: string;
  /** ★ **目标节点**扩展属性并入后的顶层键名（默认 `'target'`）；冲突处置同 `key` */
  targetKey?: string;
  /**
   * ★ 类型还原表：键 → 目标类型。例如 `{ slaHours: 'number' }`。
   *
   * 为什么必须有：模型作者**可能**把值写成字符串（`'48'` 而不是 `48`），
   * 而 `slaHours > 24` 遇到 `"48"` 会按字符串比较 → 抛错。
   * 引擎**不猜类型**（`"48"` 究竟是数字还是编号？猜 = 静默错误），按本表声明转换。
   *
   * ⚠️ 键**不带前缀**（v2 起 `extension` 无命名空间概念，且带冒号的键 FEEL 引用不到，
   * 见 `castExtensionBag`）。表的键必须与 `extension` 里的键**逐字相同**。
   */
  casts?: Readonly<Record<string, 'number' | 'boolean' | 'iso-date'>>;
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

/**
 * 一次投递的输入（T20 · `deliverMessage` / `deliverSignal`）。
 *
 * ★ 与 `ActionInput` **刻意不共用**：投递不是审批动作 —— 它没有「19 项动作名」、
 *   没有 `target` / `comment`（消息名本身就是目标）。共用会让宿主写出
 *   `submit({action:'approve', name:'Msg_paid'})` 这种四不像，且编译期挡不住。
 */
export interface DeliverInput {
  /** 消息名 / 信号名，与定义里的 `messageRef` / `signalRef` **逐字**匹配 */
  name: string;
  /** 谁投的（进审计；外部系统就写系统名，如 `'bank-callback'`） */
  actor: string;
  /** 随消息带来的数据 → 并入 `variables`（如 `{ paid: true, amount: 9000 }`） */
  payload?: Record<string, unknown>;
  /** 显式时间（ISO 8601）；缺省由 `clock()` 填 —— ADR-007 */
  at?: string;
}

function assertDeliverInput(input: unknown): asserts input is DeliverInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw optionInvalid('input', 'must be a plain object', input);
  }
  const i = input as Record<string, unknown>;
  const fail = (field: string, reason: string): never => {
    throw optionInvalid(`input.${field}`, reason, i[field]);
  };
  if (typeof i.name !== 'string' || i.name.length === 0) fail('name', 'must be a non-empty string');
  if (typeof i.actor !== 'string' || i.actor.length === 0) fail('actor', 'must be a non-empty string');
  if (i.at !== undefined && (typeof i.at !== 'string' || i.at.length === 0)) {
    fail('at', 'must be a non-empty ISO 8601 string when present');
  }
  if (i.payload !== undefined && (typeof i.payload !== 'object' || i.payload === null || Array.isArray(i.payload))) {
    fail('payload', 'must be a plain object when present');
  }
}

export interface Engine {
  /** 发起一个实例；返回 `instanceId` */
  start(processId: string, opts: StartOptions): Promise<string>;
  /** 提交一次动作；返回待办差分（INV-15） */
  submit(instanceId: string, action: ActionInput): Promise<TaskDelta>;
  /**
   * ★ **点对点**投递一条消息，唤醒该实例里正在等它的令牌（T20 · `intermediateCatchEvent` / `receiveTask`）。
   *
   * @throws `ENGINE_ACTION_TARGET_INVALID` —— 该实例没有在等这个名字（**不静默丢弃**）
   */
  deliverMessage(instanceId: string, input: DeliverInput): Promise<TaskDelta>;
  /**
   * ★ **广播**一个信号，唤醒候选实例里**所有**正在等它的实例（T20）。
   *
   * ⚠️ 候选集由宿主给：引擎不知道实例全集（`StateStore` 没有查询接口，见 §3b）。
   *
   * @throws `ENGINE_ACTION_TARGET_INVALID` —— 一个都没命中（完全无效果 = 静默丢弃）
   */
  deliverSignal(instanceIds: readonly string[], input: DeliverInput): Promise<TaskDelta[]>;
  /**
   * ★ 导出**令牌轨迹**（T22 · FR-E15）：`auditTrail` 的只读投影，**不新增存储**。
   *
   * ⚠️ 返回的是 `TraceResult` 而不是裸数组：`maxAuditEntries` 裁剪之后
   *   裸数组与完整轨迹**无从区分** —— 宿主会把"只剩最近 3 条"当成"一共就 3 条"。
   *
   * @throws `ENGINE_STATE_NOT_FOUND` —— 实例不存在
   */
  exportTrace(instanceId: string): Promise<TraceResult>;
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
  'extensionVars',
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
  assertExtensionVars(c.extensionVars);
}

/**
 * ★ ADR-009：`extensionVars` 的形状校验（**禁止静默忽略**，D-7 同款纪律）。
 *
 * 为什么连 `casts` 的取值都要一个个查：写错成 `'int'` / `'Number'` 时，
 * 引擎会"认不出 → 原样给字符串"，而运行期的表现是
 * `slaHours > 24` 拿字符串去比 → 抛一个**看不出根因**的条件错误。
 * 在配置期就拒掉，宿主一眼能改。
 */
function assertExtensionVars(v: unknown): void {
  if (v === undefined) return;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw optionInvalid('extensionVars', 'must be a plain object', v);
  }
  const o = v as Record<string, unknown>;
  const allowed = ['key', 'targetKey', 'casts'] as const;
  for (const key of Object.keys(o)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw optionUnknown(`extensionVars.${key}`, allowed);
    }
  }
  const assertKeyName = (field: string): void => {
    const k = o[field];
    if (k === undefined) return;
    if (typeof k !== 'string' || k.length === 0 || k.includes('.')) {
      throw optionInvalid(`extensionVars.${field}`, 'must be a non-empty string without "."', k);
    }
  };
  assertKeyName('key');
  assertKeyName('targetKey');
  if (o.casts !== undefined) {
    const casts = o.casts;
    if (typeof casts !== 'object' || casts === null || Array.isArray(casts)) {
      throw optionInvalid('extensionVars.casts', 'must be a plain object', casts);
    }
    const kinds = ['number', 'boolean', 'iso-date'] as const;
    for (const [key, kind] of Object.entries(casts as Record<string, unknown>)) {
      if (!(kinds as readonly string[]).includes(kind as string)) {
        throw optionInvalid(
          `extensionVars.casts['${key}']`,
          `must be one of ${kinds.join(' | ')}`,
          kind,
        );
      }
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

// ---------------- ★ ADR-009：自定义扩展属性并入求值上下文 ----------------

/** 扩展属性的声明类型（`extensionVars.casts` 的取值） */
type ExtensionCast = 'number' | 'boolean' | 'iso-date';

/**
 * ★ 按声明还原类型（ADR-009 细则⑧）。
 *
 * 为什么**不猜**：`moddle` 从 XML 读回的扩展属性一律是字符串，`"48"` 究竟是数字 48
 * 还是编号 "48"，引擎无从判断 —— 猜错的表现是「条件按字符串比较，抛一个看不出根因的错」。
 * 故：声明了就按声明转，**转不动就抛**（不是静默原样返回）。
 *
 * `iso-date` 刻意**不做解析** —— Q33：引擎 `dist` 不得出现时态库，时间语义归宿主 / 调度方。
 * 它在这里的用处是「标明这是日期字符串」，转换即原样透传。
 */
function applyExtensionCast(key: string, value: unknown, kind: ExtensionCast): unknown {
  if (kind === 'number') {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      if (!Number.isNaN(n)) return n;
    }
  } else if (kind === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
  } else {
    return value; // 'iso-date'：原样透传（引擎不解析时间）
  }
  throw optionInvalid(
    `extensionVars.casts['${key}']`,
    `declared as '${kind}' but the value cannot be converted`,
    value,
  );
}

/**
 * ★ 把一袋扩展属性转成并入用的对象（应用 cast）；空袋 → `undefined`。
 *
 * **键原样并入，引擎绝不改写**（v2 口径）。v1 曾有一道「去掉 `acme:` 命名空间前缀」的
 * 逻辑（`acme:priority` → `priority`），Q48 之后随 XML 一起作废：v2 的 `extension` 是
 * **任意 JSON，没有命名空间概念**，前缀只是宿主自己的命名习惯。留着它会**静默截断** ——
 * 实测 `order:id` → `id`、`a:b:c` → `b:c`，机缘巧合还会**命中另一个真实变量**从而判错分支。
 * 引擎不猜宿主的键名（与「引擎不解释宿主语义」同一条红线）。
 *
 * ★ **键里带冒号 → 直接抛错**，不静默跳过（实测，不是偏好）：FEEL 引用不到带冒号的键 ——
 *   - `target.acme:priority` → `FeelSyntaxError: Unexpected token ':'`
 *   - `target["acme:priority"]` → `null`（`[...]` 在 FEEL 里是列表筛选，不是对象取键）
 *   静默并入一个读不出来的变量 = 功能不存在却毫无提示，比报错糟得多。
 */
function castExtensionBag(
  bag: Readonly<Record<string, unknown>> | undefined,
  casts: Readonly<Record<string, ExtensionCast>> | undefined,
): Record<string, unknown> | undefined {
  if (bag === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (key.includes(':')) {
      throw optionInvalid(
        'extensionVars',
        `extension key '${key}' contains ':' — FEEL cannot reference it ('x.${key}' is a syntax error and 'x["${key}"]' evaluates to null); use a plain key like '${key.slice(key.lastIndexOf(':') + 1)}'`,
        { key, bag: Object.keys(bag) },
      );
    }
    const kind = casts?.[key];
    out[key] = kind === undefined ? value : applyExtensionCast(key, value, kind);
  }
  return out;
}

/**
 * ★ 并入求值上下文（ADR-009 细则⑤⑥⑦）。
 *
 * ⚠️ 只影响**求值上下文**，**绝不写进 `InstanceState.variables`** ——
 * 否则状态膨胀，且快照里存两份真相（设计期配置与运行期数据混在一起）。
 */
function mergeExtensionVars(
  base: Readonly<Record<string, unknown>>,
  nodeExt: Readonly<Record<string, unknown>> | undefined,
  targetExt: Readonly<Record<string, unknown>> | undefined,
  opt: ExtensionVarsOption | undefined,
): Readonly<Record<string, unknown>> {
  if (opt === undefined) return base; // 细则⑤：不声明 = 现状语义

  const casts = opt.casts as Readonly<Record<string, ExtensionCast>> | undefined;
  const nodeBag = castExtensionBag(nodeExt, casts);
  const targetBag = castExtensionBag(targetExt, casts);
  if (nodeBag === undefined && targetBag === undefined) return base;

  const out: Record<string, unknown> = { ...base };
  const put = (name: string, bag: Record<string, unknown> | undefined): void => {
    if (bag === undefined) return;
    // 细则⑦：撞车**抛错**，不静默覆盖
    if (Object.prototype.hasOwnProperty.call(out, name)) {
      throw optionInvalid(
        'extensionVars',
        `cannot merge extension vars: a variable named '${name}' already exists — rename via extensionVars.key / targetKey`,
        { name, existing: out[name] },
      );
    }
    out[name] = bag;
  };
  put(opt.key ?? 'node', nodeBag);
  put(opt.targetKey ?? 'target', targetBag);
  return out;
}

// ---------------- 工厂 ----------------

export function createEngine(config: EngineConfig): Engine {
  assertEngineConfig(config);

  const clock: () => string = config.clock ?? defaultClock;
  const store: StateStore = config.store ?? createMemoryStore();
  const { definitionSource } = config;
  const projection: TaskProjection | undefined = config.projection;
  /**
   * ★ 超时排程（`Scheduler`，T21）。**不注入 = 不排程** —— 与 `projection` 同款：
   *   超时是**内核外**的 2 项动作之一（19 项 = 17 内核原生 + 2 内核外），
   *   内核的职责到此为止 = 如实告诉调度方「该排了 / 该取消了」。
   *   ⚠️ 内核**不**内置一个"假的"调度器去假装排程 —— 那会让「配了超时却永远不会提醒」
   *   变成一个没有报错的静默事实（与 D-54 同一条纪律）。
   */
  const scheduler: Scheduler | undefined = config.scheduler;
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
  /** ★ ADR-009：自定义扩展属性并入求值上下文（opt-in；不声明 = 只给只读字段、不并入） */
  const extensionVars: ExtensionVarsOption | undefined = config.extensionVars;
  /** `serviceTask` / 非 FEEL `scriptTask` 的实现表（**不注入 = 该类节点报「未配置」**） */
  const handlers: ServiceHandler | undefined = config.handlers;
  /**
   * `businessRuleTask` 的决策求值（**不注入 = 该节点报「未配置」**，无内置默认）。
   *
   * ⚠️ 为什么刻意不给默认：`03` §8.3 写的是「可接 `@floken-io/dmn`」——
   *   但接 DMN 是**宿主的选择**。给一个内置默认（比如"原样返回 input"）会让
   *   「决策没生效」表现为「流程正常走完了」，那是静默失败。
   */
  const decisionHandler: DecisionHandler | undefined = config.decisionHandler;
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
   * ★ **T17 追加：节点副作用走同一套路**（`serviceTask` / `scriptTask` /
   *   `businessRuleTask` / `manualTask`）。三条与条件**不同**的地方：
   *     ① 副作用是**真实外部行为**（发邮件、建单），故解析结果按 `${nodeId}::${tokenId}`
   *        **缓存** —— 否则每重跑一轮就调一次，同一个服务被调 N 次；
   *     ② 解析时用的变量是**令牌到达该节点那一刻**的快照（哨兵带过来的），
   *        不是提交前的旧值 —— 否则「脚本把 amount 改成 9000、后面的服务还按旧值干活」；
   *     ③ 副作用产出的事件**不在这里投递**，而是攒进 `pendingEvents`，
   *        由 `start()` / `submit()` 在**槽位 9**（状态已落库之后）统一发。
   *
   * @param state 已并入 `payload` 增量的状态（与 `plan()` 交给 `apply` 的那份**同源** ——
   *              否则「表单里把 amount 改成 9000、网关却按旧值走分支」，正是 §7.2 要防的事故）
   * @param record 本次动作事实（副作用产出的事件要与它**同源**，否则重放时对不上）
   * @param run ★ 一次推进的**纯执行段**：`step()`（动作）或 `deliverStep()`（投递）。
   *   探测跑与真值跑**共用**它 —— 两者跑同一段代码，「探测问错落点」从结构上不可能发生。
   */
  async function buildApply(params: {
    readonly state: InstanceState;
    readonly graph: ProcessGraph;
    readonly at: string;
    readonly record: ActionRecord;
    readonly run: (state: InstanceState, ctx: LoopContext) => LoopResult;
  }): Promise<{
    readonly apply: (draft: InstanceState) => InstanceState;
    /** ★ 本次推进里由节点副作用产出的事件（**槽位 9** 投递，见 `pendingEvents` 注释） */
    readonly pendingEvents: readonly EngineEvent[];
    /** ★ 本次推进里停在 `callActivity` 上、待建的子实例（T18；与 `pendingEvents` 同套路） */
    readonly pendingCalls: readonly PendingCall[];
  }> {
    const { state, graph, at, record, run } = params;

    /** 已解析的条件（按 flow id）。惰性填充 —— 只算本次**真正走到**的那几条 */
    const conditions = new Map<string, boolean>();
    const conditionsOf = (
      flow: OutFlow,
      nodeId: string,
      variables: Readonly<Record<string, unknown>>,
    ): boolean => {
      // D-42：无条件（BPMN 的默认流）→ 恒真，不进求值器
      if (flow.expression === undefined) return true;
      const value = conditions.get(flow.id);
      if (value === undefined) {
        // ★ ADR-009 细则②：带上 `flow.to`，重跑时才能取「这条分支通向的节点」的扩展属性
        throw unresolvedCondition(flow.id, flow.expression, nodeId, variables, flow.to);
      }
      return value;
    };

    /** ★ 已解析的节点副作用（按 `${nodeId}::${tokenId}`）—— 缓存 = 「只调一次」的唯一保证 */
    const effects = new Map<string, NodeEffect>();
    const effectsOf = (
      nodeId: string,
      tokenId: string,
      variables: Readonly<Record<string, unknown>>,
    ): NodeEffect => {
      const effect = effects.get(effectKeyOf(nodeId, tokenId));
      if (effect === undefined) {
        const kind = effectKindOf(graph.typeOf(nodeId));
        if (kind === undefined) {
          throw stateShapeInvalid(`node '${nodeId}' is not an effect task`, {
            nodeId,
            type: graph.typeOf(nodeId) ?? null,
          });
        }
        throw unresolvedEffect({ nodeId, tokenId, kind, variables });
      }
      return effect;
    };

    /** ★ 副作用产出的事件；由 `start()` / `submit()` 在槽位 9 统一投递 */
    const pendingEvents: EngineEvent[] = [];
    /** ★ 待建的子实例（`callActivity`）；由 `start()` / `submit()` 在**队列之外**兑现 */
    const pendingCalls: PendingCall[] = [];

    for (let round = 0; ; round += 1) {
      try {
        /*
         * ★ 探测跑的是**完整的 `step()`**（含投票与汇聚），不是只跑 run-to-wait：
         *   会签最后一人通过后，落点是**汇聚之后的下一个节点**，只跑推进会问错落点。
         */
        const probe = new Set<string>();
        run(cloneState(state), {
          graph,
          at,
          assigneesOf: (nodeId) => {
            probe.add(nodeId);
            return [PROBE_ASSIGNEE];
          },
          conditionsOf,
          effectsOf,
        });

        const resolved = new Map<string, readonly string[]>();
        for (const nodeId of probe) {
          resolved.set(nodeId, await resolveAssigneesFor(nodeId, state, graph, approverSource));
        }

        return {
          pendingEvents,
          pendingCalls,
          apply: (draft: InstanceState): InstanceState => {
            const r = run(
              draft,
              { graph, at, assigneesOf: (nodeId) => resolved.get(nodeId) ?? [], conditionsOf, effectsOf },
            );
            // 只有**真值跑**产出的东西算数：探测跑的结果一律丢弃（它可能被重试掉）
            pendingEvents.length = 0;
            for (const e of r.events) pendingEvents.push(e);
            pendingCalls.length = 0;
            for (const c of r.pendingCalls) pendingCalls.push(c);
            return r.next;
          },
        };
      } catch (e) {
        const pendingEffect = asUnresolvedEffect(e);
        if (pendingEffect !== undefined) {
          if (round >= MAX_RESOLVE_ROUNDS) {
            throw stateShapeInvalid('effect resolution did not converge (retry budget exceeded)', {
              budget: MAX_RESOLVE_ROUNDS,
              instanceId: state.instanceId,
            });
          }
          effects.set(
            pendingEffect.key,
            await resolveEffect({
              nodeId: pendingEffect.nodeId,
              tokenId: pendingEffect.tokenId,
              kind: pendingEffect.kind,
              variables: pendingEffect.variables,
              graph,
              state,
              record,
              handlers,
              decisionHandler,
            }),
          );
          continue;
        }

        const pending = asUnresolved(e);
        if (pending === undefined) throw e; // 不是"未解析"→ 原样抛出，绝不吞
        if (round >= MAX_RESOLVE_ROUNDS) {
          throw stateShapeInvalid('condition resolution did not converge (retry budget exceeded)', {
            budget: MAX_RESOLVE_ROUNDS,
            instanceId: state.instanceId,
          });
        }
        const nodeExt = graph.extensionsOf(pending.nodeId);
        const targetExt =
          pending.toNodeId === undefined ? undefined : graph.extensionsOf(pending.toNodeId);
        conditions.set(
          pending.flowId,
          await evaluateCondition(condition, pending.expression, {
            instanceId: state.instanceId,
            nodeId: pending.nodeId,
            // ★ 用**到达该网关那一刻**的变量快照（哨兵带来），不是提交前的旧值
            //   ⚠️ 扩展属性只在**求值上下文**里并入，绝不写回 state（ADR-009 细则⑨）
            variables: mergeExtensionVars(pending.variables, nodeExt, targetExt, extensionVars),
            nodeExtensions: nodeExt,
            targetExtensions: targetExt,
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

    const record: ActionRecord = { name: 'start', actor: opts.starter, at };

    // 发起也要跑 run-to-wait：发起节点是自动节点，令牌要一直走到第一个等待节点
    const built = await buildApply({
      state: base,
      graph,
      at,
      record,
      run: (s, ctx) => step(s, ctx, { calls: [] }),
    });
    const looped = built.apply(cloneState(base));

    /*
     * ★ T22（**D-88**）：发起这条也要 `from` / `to` —— 它是轨迹的**第一行**，
     *   没有它 `exportTrace()` 就看不出"从开始事件走到了第一个待办"。
     *   ⚠️ 与 `plan()` 同一口径：`from` = 推进前所在节点，`to` = 推进后所在节点。
     */
    const startTokenId = 'tk_start';
    const startTo = looped.tokens.find((t) => t.id === startTokenId)?.nodeId;
    const startEntry: AuditEntry = {
      seq: 1,
      at,
      actor: opts.starter,
      action: 'start',
      nodeId: graph.startNodeId,
      tokenId: startTokenId,
      from: graph.startNodeId,
      ...(startTo !== undefined ? { to: startTo } : {}),
    };

    const next: InstanceState = {
      ...looped,
      rev: 1,
      lastAction: record,
      auditTrail: [startEntry],
    };

    const delta: TaskDelta = {
      rev: next.rev,
      action: record,
      added: tasksOf(next, graph),
      removed: [],
      changed: [],
      instance: headerOf(next),
    };

    await reconcileTimers(base, next, graph);
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
    emitAll(sink, [...eventsOf({ before: [], delta, next }), ...built.pendingEvents]);

    /*
     * ★ 后续动作（建子实例 / 唤醒父实例）**不在队列里做** —— 见 `followUp()` 档首。
     *   发起本身不入队（实例此刻还不存在，没有可串行的对象），故这里直接调。
     */
    await followUp(next, { next, pendingCalls: built.pendingCalls });
    return instanceId;
  }

  async function submit(instanceId: string, action: ActionInput): Promise<TaskDelta> {
    // 槽位 0：per-instance FIFO 串行（NFR-E5 主防线）—— 同实例的两次提交永不交错
    const outcome = await queue.run(instanceId, () => doSubmit(instanceId, action));
    await followUp(outcome.next, outcome);
    return outcome.delta;
  }

  /**
   * `submit()` 的**受队列保护**的那一段（槽位 0~9）。
   *
   * 拆出来是为了让「后续动作」落在队列**之外** —— 详见 `followUp()`。
   */
  async function doSubmit(
    instanceId: string,
    action: ActionInput,
  ): Promise<AdvanceOutcome & { readonly delta: TaskDelta }> {
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
    /*
     * ★ `record` 与 `plan()` 里的 `lastAction` **同一口径**（`{name, actor, at}`），
     *   故节点副作用产出的事件与 `delta.action` 必然同源 —— 否则重放时对不上。
     */
    const record: ActionRecord = { name: input.action, actor: input.actor, at };
    const stepInput: StepInput = {
      calls: compiled.calls,
      ...(compiled.vote !== undefined ? { vote: compiled.vote } : {}),
      ...(compiled.post !== undefined ? { post: compiled.post } : {}),
      ...(input.target !== undefined ? { rejectTarget: input.target } : {}),
    };
    const built = await buildApply({
      /*
       * ★ 传给探测/闭包的是**已并入 payload 增量**的状态。
       *   `plan()` 在 ④.5 先并变量、④.6 才调 `apply` —— 探测必须用同一份，
       *   否则「表单里把 amount 改成 9000、网关却按旧值走分支」（§7.2 要防的头号事故）。
       */
      state: withPayload(state, input.payload),
      graph,
      at,
      record,
      run: (s, ctx) => step(s, ctx, stepInput),
    });
    const result = plan(state, input, {
      clock,
      ...(maxAuditEntries !== undefined ? { maxAuditEntries } : {}),
      apply: built.apply,
      tasks: (s) => tasksOf(s, graph),
    });
    await reconcileTimers(state, result.next, graph);

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
      [
        ...eventsOf({ before, delta: result.delta, next: result.next, previousStatus: state.status }),
        // ★ 节点副作用产出的事件（`manualTask` 的留痕）—— 状态已落库，此刻投递才安全
        ...built.pendingEvents,
      ],
    );

    return { next: result.next, pendingCalls: built.pendingCalls, delta: result.delta };
  }

  // ---------------- ★ 投递入口：deliverMessage / deliverSignal（T20） ----------------

  /**
   * ★ **点对点**投递一条消息（`intermediateCatchEvent` / `receiveTask` 在等它）。
   *
   * BPMN 的消息语义是 **1:1**（一个消息只有一个接收者），故第一个参数是单个 `instanceId`。
   * 要广播请用 {@link deliverSignal} —— 两者不是"同一件事的两种写法"，别合并。
   *
   * @throws `ENGINE_ACTION_TARGET_INVALID` —— 该实例**没有**在等这个名字（**绝不静默丢弃**：
   *   名字差一个大小写就会变成"流程永久卡住、而宿主以为自己投过了"）
   */
  async function deliverMessage(instanceId: string, input: DeliverInput): Promise<TaskDelta> {
    const outcome = await queue.run(instanceId, () => doDeliver(instanceId, 'message', input, 'throw'));
    await followUp(outcome.next, outcome);
    return outcome.delta;
  }

  /**
   * ★ **广播**一个信号：唤醒 `instanceIds` 里**所有**正在等它的实例。
   *
   * ⚠️ **为什么必须由宿主给候选集**（而不是引擎自己去找订阅者）：
   *   `StateStore` 的接口只有 `load(id)` / `save(next, rev)` —— **没有**查询接口，
   *   这是刻意的（见 §3b：真相线只做单实例读写，查询能力归宿主的待办表 / 订阅表）。
   *   引擎因此**不知道实例全集**，「谁在等 `Sig_x`」这件事只有宿主答得出来。
   *
   *   正确用法：宿主自己维护一张订阅表（`instance_id, signal`），
   *   可以由 `EventSink` / 投影同步写入，也可以直接从 `InstanceState.tokens[].awaiting` 派生。
   *
   * @throws `ENGINE_ACTION_TARGET_INVALID` —— **一个都没命中**（完全无效果 = 静默丢弃，必须报出来）；
   *   部分命中是**合法**的（BPMN 的信号不要求人人接收），未命中的实例被跳过。
   * @throws 其余（实例不存在 / 终态 / 挂起）一律抛 —— 那些说明候选集本身给错了
   */
  async function deliverSignal(
    instanceIds: readonly string[],
    input: DeliverInput,
  ): Promise<TaskDelta[]> {
    assertDeliverInput(input);
    if (!Array.isArray(instanceIds) || instanceIds.length === 0) {
      throw optionInvalid('instanceIds', 'must be a non-empty array', instanceIds);
    }

    const deltas: TaskDelta[] = [];
    const waiting: string[] = [];
    for (const id of instanceIds) {
      // 顺序执行（不并发）：广播的结果顺序 = 入参顺序，可重放、可断言
      const outcome = await queue.run(id, () => doDeliver(id, 'signal', input, 'skip', waiting));
      if (outcome === null) continue;
      await followUp(outcome.next, outcome);
      deltas.push(outcome.delta);
    }

    if (deltas.length === 0) {
      throw deliverNoTarget(undefined, 'signal', input.name, waiting, {
        candidates: [...instanceIds],
      });
    }
    return deltas;
  }

  /**
   * 一次投递的**受队列保护**的那一段（槽位 1~9，与 `doSubmit` 同构）。
   *
   * @param onMiss `'throw'`（消息：没命中就是错） / `'skip'`（信号：没命中是合法的，返回 `null`）
   * @param waitingSink 收集各候选实例「此刻在等什么」—— 供广播全落空时的报错给**合法取值**
   */
  /** `doDeliver` 的结果形状（与 `submit()` 的返回值同构，故后续动作可以复用 `followUp`） */
  type DeliverOutcome = AdvanceOutcome & { readonly delta: TaskDelta };

  /** 点对点（消息）：没命中就抛 ⇒ 结果**一定**不是 `null` */
  async function doDeliver(
    instanceId: string,
    kind: CatchKind,
    input: DeliverInput,
    onMiss: 'throw',
  ): Promise<DeliverOutcome>;
  /** 广播（信号）：没命中是合法的 ⇒ 返回 `null` 表示"这个实例不在等" */
  async function doDeliver(
    instanceId: string,
    kind: CatchKind,
    input: DeliverInput,
    onMiss: 'skip',
    waitingSink?: string[],
  ): Promise<DeliverOutcome | null>;
  async function doDeliver(
    instanceId: string,
    kind: CatchKind,
    input: DeliverInput,
    onMiss: 'throw' | 'skip',
    waitingSink?: string[],
  ): Promise<DeliverOutcome | null> {
    assertDeliverInput(input);

    // 槽位 1
    const state = await store.load(instanceId);
    if (state === null || state === undefined) throw stateNotFound(instanceId);

    const actionName = kind === 'message' ? MESSAGE_DELIVER_ACTION : SIGNAL_DELIVER_ACTION;

    /*
     * INV-2（终态不再受理推进）/ INV-5（挂起 = 冻结，除 `resume` 外不受理）。
     *
     * ⚠️ 广播下这两类**跳过**而不是抛：候选集本质是「**可能**订阅者的一个超集」，
     *   里面躺着刚跑完 / 被冻结的实例是**正常**的（订阅表总比状态滞后一拍）。
     *   为了一行过期数据让整批广播失败，是拿可用性去换一条本来就不紧急的提示；
     *   真正不能吞的是「**一个都没命中**」（下面由 `deliverNoTarget` 抛）。
     */
    if (isTerminalStatus(state.status) || state.status === 'suspended') {
      if (onMiss === 'skip') return null;
      if (isTerminalStatus(state.status)) {
        throw stateTerminal(state.instanceId, state.status, actionName);
      }
      throw stateSuspended(state.instanceId, actionName);
    }

    // 槽位 2 的前置：图纸与图（INV-3 的判定点）
    const graph = await graphOf(state);
    assertTokensInGraph(state, graph);

    const match: DeliverMatch = { kind, name: input.name };
    /**
     * ★ T21：命中集合有**两类来源**（等待令牌 + 边界事件），按投递种类区别对待。
     *   故"有没有命中"不能只看 `matchingTokens()` —— 边界事件**不持有令牌**，
     *   只看等待令牌的话，挂在活动上的消息边界事件**永远收不到消息**。
     */
    const mode: DeliverMode = onMiss === 'throw' ? 'point' : 'broadcast';
    const waiters = matchingTokens(state, match);
    const armed = armedBoundaries(state, graph, match);
    const hitCount =
      mode === 'point'
        ? waiters.length > 0 || armed.length > 0
          ? 1
          : 0
        : waiters.length + armed.length;

    if (hitCount === 0) {
      const names = [...waitingNamesOf(state), ...armedNamesOf(state, graph)];
      if (waitingSink !== undefined) for (const n of names) if (!waitingSink.includes(n)) waitingSink.push(n);
      if (onMiss === 'skip') return null;
      // ★「不得静默丢弃」的落点：一个都没命中 → 抛，并把此刻在等什么列给宿主
      throw deliverNoTarget(instanceId, kind, input.name, names);
    }

    // 槽位 3（ADR-007）
    const at = input.at ?? now();

    const before = tasksOf(state, graph);
    const record: ActionRecord = { name: actionName, actor: input.actor, at };
    const ai: ActionInput = {
      action: actionName,
      actor: input.actor,
      at,
      // 审计要记「唤醒了哪儿」：多个命中时取第一个（保序，可重放）
      target: (waiters[0]?.nodeId ?? armed[0]?.boundary.nodeId) as string,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    };

    const built = await buildApply({
      state: withPayload(state, input.payload),
      graph,
      at,
      record,
      run: (s, ctx) => deliverStep(s, ctx, match, mode),
    });
    const result = plan(state, ai, {
      clock,
      ...(maxAuditEntries !== undefined ? { maxAuditEntries } : {}),
      apply: built.apply,
      tasks: (s) => tasksOf(s, graph),
    });
    await reconcileTimers(state, result.next, graph);

    const hookCtx = freezeActionContext({
      action: result.delta.action,
      state: headerOf(state),
      next: headerOf(result.next),
      delta: result.delta,
    });

    // 槽位 5：门 1 前钩子 —— 可否决（典型用法：宿主做**投递幂等去重**）
    if (hooks?.beforeAction !== undefined) {
      const verdict = await hooks.beforeAction(hookCtx);
      if (verdict === false) throw actionVetoed(actionName, instanceId);
    }

    // 槽位 6~8
    await store.save(result.next, state.rev);
    if (projection !== undefined) await projection.apply(instanceId, result.delta);
    if (hooks?.afterAction !== undefined) await hooks.afterAction(hookCtx);

    // 槽位 9
    emitAll(
      sink,
      [
        ...eventsOf({ before, delta: result.delta, next: result.next, previousStatus: state.status }),
        ...built.pendingEvents,
      ],
    );

    return { next: result.next, pendingCalls: built.pendingCalls, delta: result.delta };
  }

  /**
   * ★ 超时排程的**兑现**（T21）—— 唯一不纯的一段，故只在本文件里。
   *
   * 顺序：先 `cancel()` 旧的（待办已经不在了），再 `schedule()` 新的（新落地的待办）。
   * ⚠️ 必须在 `store.save()` **之前**调用：`schedule()` 返回的 handle 要写进 `next` 才留得住，
   *   先存库再排程 = 状态里没有 handle ⇒ 待办办完时**无从取消**（最典型的"已办结还在催办"）。
   *
   * ⚠️ 与 `hooks` 同一条容错口径：这里**不**做补偿事务（引擎内不做事务，见 §3b）。
   *   `schedule()` 失败 = 本次提交失败（状态尚未落库，故不会留下半截状态）。
   */
  async function reconcileTimers(
    prev: InstanceState,
    next: InstanceState,
    graph: ProcessGraph,
  ): Promise<void> {
    if (scheduler === undefined) return;
    const diff = diffTimers(prev, next, graph);

    const gained = new Map<string, string[]>();
    for (const p of diff.schedule) {
      const handles: string[] = [];
      for (const action of p.actions) {
        handles.push(
          await scheduler.schedule({
            instanceId: next.instanceId,
            nodeId: p.nodeId,
            tokenId: p.tokenId,
            fromAt: p.fromAt,
            timeout: p.timeout,
            kind: action.type,
            /*
             * ★ 整个动作**原样**交出（含 `remind.interval` / `remind.max` /
             * `autoReject.target` / `escalate.to`）。只给 `kind` 的话，调度方无从知道
             * 「隔多久催、催几次、驳回给谁、升级给谁」——那些是宿主的定义，内核不解读。
             */
            payload: { ...action },
          }),
        );
      }
      gained.set(p.tokenId, handles);
    }

    for (const c of diff.cancel) {
      for (const h of c.handles) await scheduler.cancel(h);
      const t = next.tokens.find((x) => x.id === c.tokenId);
      if (t !== undefined) delete t.timerHandles;
    }

    // ★ 写回必须在取消之后：否则刚排上的 handle 会被上面那一步一并删掉
    for (const [tokenId, handles] of gained) {
      const t = next.tokens.find((x) => x.id === tokenId);
      if (t === undefined) continue;
      t.timerHandles = [...(t.timerHandles ?? []), ...handles];
    }
  }

  // ---------------- ★ CallActivity：子实例的创建 / 回归 / 连坐终止（T18） ----------------

  /**
   * ★ 「后续动作」—— 建本次推进新产生的子实例 + 自己终态时的收尾。
   *
   * ⚠️ **必须在 `queue.run()` 之外调用**（这是本函数存在的全部理由）：
   *   `queue` 是「链尾 + 影子 Promise」，**不支持重入**（`runtime/queue.ts` 档首写明了
   *   「正确做法是在 engine 层拦，而不是改本档」）。而子实例一旦**立刻跑完**
   *   （被调用的流程里没有人工节点 —— 真实场景里这是常态），就要**回头唤醒父实例**；
   *   这段若留在父实例的队列里，就是「父等子、子等父」的**自锁**。
   *
   *   放到队列之外后顺序是这样：`queue.run(parent)` 已返回 → 建子实例（入**子实例**的队列）
   *   → 子实例终态 → 再 `queue.run(parent)` 唤醒 —— 每一步开始时上一步的队列都已空，不会自锁。
   */
  async function followUp(parent: InstanceState, outcome: AdvanceOutcome): Promise<void> {
    // ① 建本次推进新产生的子实例（顺序 = 定义顺序，故行为确定、可重放）
    for (const call of outcome.pendingCalls) {
      await startChild({
        instanceId: call.instanceId,
        processId: call.processId,
        definitionVersion: call.definitionVersion,
        variables: { ...call.variables },
        starter: parent.starter ?? parent.instanceId,
        ...(parent.tenantId !== undefined ? { tenantId: parent.tenantId } : {}),
        parent: { instanceId: parent.instanceId, nodeId: call.nodeId, tokenId: call.tokenId },
      });
    }

    if (isTerminalStatus(outcome.next.status)) {
      // ② 自己是别人的子实例 → 唤醒父实例
      if (outcome.next.parent !== undefined) await resumeParent(outcome.next);
      // ③ 自己终态 → 还没跑完的子实例一起停掉
      await haltLiveChildren(outcome.next);
    }
  }

  /** 建一个子实例（入它自己的队列，随后的 `followUp` 在队列之外） */
  async function startChild(spec: ChildSpec): Promise<void> {
    const outcome = await queue.run(spec.instanceId, () => doStartChild(spec));
    await followUp(outcome.next, outcome);
  }

  /**
   * 子实例的创建 —— 形状与 `start()` **逐字对齐**（同样的槽位、同样的事件、同样的审计首条），
   * 差别只有三处：instanceId 由父实例**确定性**给定、初始变量是父实例那一刻的快照、多一个 `parent` 指针。
   */
  async function doStartChild(spec: ChildSpec): Promise<AdvanceOutcome> {
    const at = now();
    // ★ INV-16 的兑现处：按**绑定的版本**取图，不是"最新版"
    const graph = await graphOf({
      processId: spec.processId,
      definitionVersion: spec.definitionVersion,
    });

    const base: InstanceState = {
      instanceId: spec.instanceId,
      processId: spec.processId,
      definitionVersion: spec.definitionVersion,
      status: 'running',
      rev: 0, // ★ INSERT 信号
      stateSchema: STATE_SCHEMA_VERSION,
      startedAt: at,
      updatedAt: at,
      tokens: [{ id: 'tk_start', nodeId: graph.startNodeId, state: 'active' }],
      completedNodes: [],
      variables: { ...spec.variables },
      auditTrail: [],
      starter: spec.starter,
      parent: spec.parent,
    };
    if (spec.tenantId !== undefined) base.tenantId = spec.tenantId;

    const record: ActionRecord = { name: 'start', actor: spec.starter, at };
    const built = await buildApply({
      state: base,
      graph,
      at,
      record,
      run: (s, ctx) => step(s, ctx, { calls: [] }),
    });
    const looped = built.apply(cloneState(base));

    const next: InstanceState = {
      ...looped,
      rev: 1,
      lastAction: record,
      auditTrail: [{ seq: 1, at, actor: spec.starter, action: 'start', nodeId: graph.startNodeId }],
    };
    const delta: TaskDelta = {
      rev: next.rev,
      action: record,
      added: tasksOf(next, graph),
      removed: [],
      changed: [],
      instance: headerOf(next),
    };

    await reconcileTimers(base, next, graph);
    await store.save(next, 0); // INSERT
    if (projection !== undefined) await projection.apply(spec.instanceId, delta);
    // 与 `start()` 同款：**不触发门 1 `hooks`**（D-27）
    emitAll(sink, [...eventsOf({ before: [], delta, next }), ...built.pendingEvents]);

    return { next, pendingCalls: built.pendingCalls };
  }

  /** 子实例到终态 → 唤醒父实例那条停在 `callActivity` 上的令牌 */
  async function resumeParent(child: InstanceState): Promise<void> {
    const p = child.parent;
    if (p === undefined) return;
    const outcome = await queue.run(p.instanceId, () => doResumeParent(child, p));
    if (outcome !== undefined) await followUp(outcome.next, outcome);
  }

  async function doResumeParent(
    child: InstanceState,
    p: InstanceParent,
  ): Promise<AdvanceOutcome | undefined> {
    const parent = await store.load(p.instanceId);
    if (parent === null || parent === undefined) throw stateNotFound(p.instanceId);

    /*
     * ★ 父已终态 / 那条令牌已经不等了 → **静默返回**（这是正常路径，不是错误）：
     *   「终止主流程时子流程还在跑」是真实场景，子实例随后自己结束，不该炸。
     */
    if (isTerminalStatus(parent.status)) return undefined;
    const token = parent.tokens.find((t) => t.id === p.tokenId);
    if (token === undefined || token.state !== 'waiting') return undefined;

    const graph = await graphOf(parent);
    const to = graph.nextOf(p.nodeId);
    if (to === undefined) throw definitionMissing(parent.processId, parent.definitionVersion);

    const at = now();
    // 审计的 `actor` = **子实例最后那个操作人**（"张三办完子流程 → 父流程继续"）
    const actor = child.lastAction?.actor ?? child.starter ?? child.instanceId;
    const record: ActionRecord = { name: CALL_RETURN_ACTION, actor, at, nodeId: p.nodeId };

    /*
     * 探测用的基准状态 = **已放行**的父状态（`callReturnOf` 是纯函数，探测与真值跑同一份）。
     */
    const resumed = callReturnOf(parent, p, to);
    const built = await buildApply({
      state: resumed,
      graph,
      at,
      record,
      run: (s, ctx) => step(s, ctx, { calls: [] }),
    });
    const before = tasksOf(parent, graph);
    const result = plan(parent, { action: CALL_RETURN_ACTION, actor, at }, {
      clock,
      ...(maxAuditEntries !== undefined ? { maxAuditEntries } : {}),
      apply: (draft) => built.apply(callReturnOf(draft, p, to)),
      tasks: (s) => tasksOf(s, graph),
    });
    await reconcileTimers(parent, result.next, graph);

    await store.save(result.next, parent.rev);
    if (projection !== undefined) await projection.apply(p.instanceId, result.delta);
    /*
     * ⚠️ **刻意不触发门 1 `hooks`**：与 `start()` 同一判据（D-27）——
     *   这不是一次用户提交，"可否决"没有意义（否决了子流程也已经跑完）。
     */
    emitAll(sink, [
      ...eventsOf({ before, delta: result.delta, next: result.next, previousStatus: parent.status }),
      ...built.pendingEvents,
    ]);

    return { next: result.next, pendingCalls: built.pendingCalls };
  }

  /** 自己终态 → 把还没跑完的子实例一起停掉 */
  async function haltLiveChildren(parent: InstanceState): Promise<void> {
    for (const childId of parent.childInstanceIds ?? []) await haltChild(childId);
  }

  /**
   * ★ 停掉一个子实例（父实例已终态）。
   *
   * 为什么必须做：父实例一终止，`resumeParent()` 就**永远不会**再触发 —— 那些子实例
   * 会继续产生待办，而宿主看主流程已经是终态了。「案子都撤了、子流程还在催人审批」
   * 是这类引擎最典型的事故之一，且没有任何报错可循。
   *
   * ⚠️ 递归（孙实例）是在 `queue.run(childId)` 里调 `queue.run(grandchildId)` ——
   *   **不同 key，不冲突**（`queue` 只保证同一个 key 串行）。
   */
  async function haltChild(childId: string): Promise<void> {
    await queue.run(childId, async () => {
      const child = await store.load(childId);
      if (child === null || child === undefined) return;
      if (isTerminalStatus(child.status)) return;

      const at = now();
      const record: ActionRecord = {
        name: 'terminate',
        actor: child.lastAction?.actor ?? child.starter ?? childId,
        at,
      };
      const next: InstanceState = {
        ...cloneState(child),
        status: 'terminated',
        rev: child.rev + 1,
        updatedAt: at,
        endedAt: at,
        lastAction: record,
        tokens: child.tokens.map((t) =>
          LIVE_TOKEN_STATES.includes(t.state) ? { ...t, state: 'cancelled' as const } : t,
        ),
        auditTrail: appendAudit(child.auditTrail, { at, actor: record.actor, action: record.name }),
      };
      if (maxAuditEntries !== undefined && next.auditTrail.length > maxAuditEntries) {
        next.auditTrail = next.auditTrail.slice(next.auditTrail.length - maxAuditEntries);
      }

      const graph = await graphOf(child);
      const before = tasksOf(child, graph);
      const delta: TaskDelta = {
        rev: next.rev,
        action: record,
        added: [],
        removed: before.map((t) => t.taskId),
        changed: [],
        instance: headerOf(next),
      };

      await store.save(next, child.rev);
      if (projection !== undefined) await projection.apply(childId, delta);
      emitAll(sink, eventsOf({ before, delta, next, previousStatus: child.status }));

      await haltLiveChildren(next);
    });
  }

  /**
   * ★ **导出令牌轨迹**（T22 · FR-E15）。
   *
   * 实现只有两行 —— 投影逻辑全在 `runtime/trace.ts` 的 `traceOf()`（纯函数）里，
   * 于是门 2（宿主自编排）拿着手里的状态直接调 `traceOf()` 得到**逐字相同**的结果
   * （§7.1：两条路径不许分叉）。
   *
   * ⚠️ **不走 `queue.run()`**：本方法只读不写，没有任何"同实例并发写"要串行；
   *   套上队列只会让"导个轨迹"去排队等前面那个提交。
   */
  async function exportTrace(instanceId: string): Promise<TraceResult> {
    const state = await store.load(instanceId);
    if (state === null || state === undefined) throw stateNotFound(instanceId);
    return traceOf(state);
  }

  return {
    start,
    submit,
    deliverMessage,
    deliverSignal,
    exportTrace,
    plan: (state, action, options) =>
      plan(state, action, {
        clock,
        ...(maxAuditEntries !== undefined ? { maxAuditEntries } : {}),
        ...options,
      }),
  };
}

// ---------------- ★ 节点副作用的解析（T17 · 唯一允许"调宿主代码"的地方） ----------------

/**
 * ★ 解析一个 `effect` 节点的副作用。
 *
 * ⚠️ **本函数是 `runtime/engine.ts` 里唯一会调宿主业务代码的地方** ——
 *   `ServiceHandler` / `DecisionHandler` 都在这里被 await。它**不在**纯循环里，
 *   正是为了让 `runToWait()` 保持纯（NFR-E6），也让「一次推进 = 一次副作用」成立。
 *
 * ## 四种 kind
 *   - `'service'`（`serviceTask`）—— 查 `handlers` 表；查不到 → **抛**（不静默跳过）
 *   - `'script'`（`scriptTask`）—— FEEL 格式 → 内置求值；非 FEEL → 查 `handlers` 表
 *   - `'decision'`（`businessRuleTask`）—— `decisionHandler`；未注入 → **抛「未配置」**
 *   - `'manual'`（`manualTask`）—— 只留痕：连发 `taskCreated` + `taskCompleted`
 *
 * @throws `ENGINE_OPTION_INVALID` —— 宿主没注入对应的实现（与 **D-24** 同口径：
 *         「没注入」这个**真因**必须原样报出来，不得包装成"解析不出结果"）
 */
async function resolveEffect(params: {
  readonly nodeId: string;
  readonly tokenId: string;
  readonly kind: TaskEffectKind;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly graph: ProcessGraph;
  readonly state: InstanceState;
  readonly record: ActionRecord;
  readonly handlers: ServiceHandler | undefined;
  readonly decisionHandler: DecisionHandler | undefined;
}): Promise<NodeEffect> {
  const { nodeId, tokenId, kind, variables, graph, state, record } = params;
  const { handlers, decisionHandler } = params;

  // —— manualTask：不产生待办、不等待，只留两条痕 ——
  if (kind === 'manual') return { nodeId, events: manualTaskEvents({ nodeId, tokenId, graph, state, record }) };

  // —— serviceTask / 非 FEEL 的 scriptTask：查 handlers 表 ——
  if (kind === 'service' || (kind === 'script' && !isFeelScriptFormat(graph.scriptFormatOf(nodeId)))) {
    const ref = graph.handlerRefOf(nodeId);
    const fn = handlers?.get(ref);
    if (fn === undefined) {
      const why =
        kind === 'script'
          ? `scriptTask '${nodeId}' 的 scriptFormat '${String(graph.scriptFormatOf(nodeId))}' 不是 FEEL`
          : `serviceTask '${nodeId}' 没有注册处理器`;
      throw optionInvalid('handlers', `${why} —— 请在 handlers 表注册 ref '${ref}'`, {
        nodeId,
        ref,
        kind,
        /*
         * ⚠️ 提示文案**刻意不逐字写**那三个禁用 API 名（`test/tasks.test.ts` 有一道
         *   「源码扫描」门禁，`src/**` 里出现它们就红，而字符串字面量不在注释剥离范围内）。
         *   语义照样讲清楚：本引擎没有任何"动态执行宿主代码"的能力，一律由宿主提供实现。
         */
        hint: '引擎不执行任意 JS（无动态求值能力，也不加载 vm 类模块）；非 FEEL 的脚本与其它实现一律由宿主提供',
      });
    }
    const out = await fn(variables, {
      instanceId: state.instanceId,
      processId: state.processId,
      definitionVersion: state.definitionVersion,
      nodeId,
    });
    return { nodeId, variables: assertVariablePatch(nodeId, kind, out) };
  }

  // —— scriptTask（FEEL）：内置求值，结果写进变量 ——
  if (kind === 'script') {
    const source = graph.scriptOf(nodeId);
    if (source === undefined) {
      throw stateShapeInvalid(`scriptTask '${nodeId}' has no <script> content`, {
        nodeId,
        hint: '给该节点写 <bpmn:script>，或改为非 FEEL 的 scriptFormat 并在 handlers 表注册处理器',
      });
    }
    const r = evaluateScript(source, variables);
    /*
     * ★ 结果落在**节点 id** 这个变量名下（**D-59**）。
     *   BPMN 的结果变量走 `ioSpecification` / `dataOutput`，而模型层未兑现该字段 ——
     *   此处不发明扩展键，也不静默丢弃结果；按「节点 id」落，可推导、可追溯。
     */
    return { nodeId, variables: { [nodeId]: r.value } };
  }

  // —— businessRuleTask：decisionHandler ——
  if (decisionHandler === undefined) {
    throw optionInvalid(
      'decisionHandler',
      `businessRuleTask '${nodeId}' 需要 decisionHandler —— 未注入即报「未配置」`,
      { nodeId, hint: '可接 @floken-io/dmn，也可以直接传一个 (input, ctx) => output 的函数' },
    );
  }
  const out = await decisionHandler.evaluate({ ...variables }, {
    instanceId: state.instanceId,
    nodeId,
    input: { ...variables },
  });
  return { nodeId, variables: assertVariablePatch(nodeId, kind, out) };
}

/**
 * `manualTask` 的留痕：**连发** `taskCreated` + `taskCompleted`。
 *
 * ★ 这就是它与裸 `task` 的**唯一**差别（`03` §6 原话：「与裸 `Task` 的差别 = 是否留痕」）：
 *   二者都不产生待办、都不等待，但 `manualTask` 在流程轨迹里**看得见**。
 *
 * ⚠️ 为什么 `taskStatus` 一条 `active` 一条 `done`：`taskCreated` 描述"产生了这个任务"，
 *   `taskCompleted` 描述"它办完了" —— 中间没有停顿，但两条事实**都发生了**，
 *   合成一条就等于承认"任务既没被创建过也没被完成过"，宿主的时间线会缺一段。
 */
function manualTaskEvents(params: {
  readonly nodeId: string;
  readonly tokenId: string;
  readonly graph: ProcessGraph;
  readonly state: InstanceState;
  readonly record: ActionRecord;
}): readonly EngineEvent[] {
  const { nodeId, tokenId, graph, state, record } = params;
  const base = {
    at: record.at,
    instanceId: state.instanceId,
    processId: state.processId,
    definitionVersion: state.definitionVersion,
    action: record,
  };
  const name = graph.nameOf(nodeId);
  const formKey = graph.formKeyOf(nodeId);

  const make = (eventName: 'taskCreated' | 'taskCompleted', taskStatus: 'active' | 'done'): TaskEvent => {
    const e: TaskEvent = { ...base, name: eventName, taskId: `${nodeId}:${tokenId}`, nodeId, taskStatus };
    if (name !== undefined) e.nodeName = name;
    if (formKey !== undefined) e.formKey = formKey;
    return e;
  };

  return [make('taskCreated', 'active'), make('taskCompleted', 'done')];
}

// ---------------- 内部 helpers ----------------

/** 一次推进的产出 —— `followUp()` 的输入（建子实例 / 收尾都要它） */
interface AdvanceOutcome {
  /** 推进后的状态（**权威**：`childInstanceIds` / `parent` / 令牌的停等都在它上面） */
  readonly next: InstanceState;
  /** 本次推进里停在 `callActivity` 上、待建的子实例 */
  readonly pendingCalls: readonly PendingCall[];
}

/** 建一个子实例所需的全部信息（instanceId 由父实例**确定性**给定） */
interface ChildSpec {
  readonly instanceId: string;
  readonly processId: string;
  readonly definitionVersion: number;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly starter: string;
  readonly tenantId?: string;
  readonly parent: InstanceParent;
}

/** 追加一条审计（INV-4：`seq` 取现有最大值 +1，对已被裁剪的审计同样成立） */
function appendAudit(
  trail: readonly AuditEntry[],
  entry: Omit<AuditEntry, 'seq'>,
): AuditEntry[] {
  let max = 0;
  for (const e of trail) {
    if (typeof e.seq === 'number' && e.seq > max) max = e.seq;
  }
  return [...trail, { ...entry, seq: max + 1 }];
}

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
 * 本次动作作用在哪个令牌上 —— **直接复用 `core/task.ts` 的 `subjectTokenOf()`**。
 *
 * ⚠️ **不许在这里另写一份定位**：`plan()` 填审计的 `tokenId` / `from` / `to` 用的也是它
 *   （**D-88**）。两处各写一份"看起来差不多"的判据，就会出现
 *   「审计说办的是 A 分支、实际推进的是 B 分支」—— 而两份代码单独看都对。
 */
function resolveSubjectToken(state: InstanceState, input: ActionInput): string | undefined {
  return subjectTokenOf(state, input.actor)?.id;
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
