/**
 * @floken-io/engine · `plan()` 纯函数（**骨架**，T7）
 *
 * ★ 它是 §3.3 九个槽位里的**槽位 4**：`submit()` 只是把它包了一层「load → … → save → …」。
 *   门 2（强一致）下宿主直接调它，自己把 `{ next, delta }` 并入业务事务。
 *   ⇒ **两条路径的状态演化必须完全一致**（§7.1 写死），因此这里不许出现任何「只有 submit 才走」的分支。
 *
 * ★ **纯函数性的三条硬约束（NFR-E6）**，改动本档前先默念：
 *   ① **不读系统时钟** —— 时间只能来自 `action.at` 或 `options.clock`（ADR-007）；
 *   ② **不碰存储 / 不发事件 / 不调 SPI** —— 本档只 import `core/`（另加 `runtime/loop.ts` 的类型与
 *      `core/task.ts` 的差分算法，都是纯的）；不 import `store/`、`nodes/` 的运行时实现、`eval/`；
 *   ③ **不改入参** —— 先 `cloneState`，只改副本；`plan(s, a)` 前后 `s` 必须深等。
 *
 * ⚠️ 动作语义**不在本档**（那是 `actions/` 的事），它通过 `options.apply` 这个**纯函数接缝**（D-18）
 *    进来 —— 于是「`submit()` 与门 2 自编排走同一条演化路径」是结构保证，而不是靠人记得同步两处。
 * 注：`suspended` 的受理门禁**不在这里** —— INV-5 的维护方是 `core/primitives.ts`（T8 已落实：
 * suspended 下除 `resume` 外所有原语抛 `ENGINE_STATE_SUSPENDED`），`plan()` 不重复实现，
 * 否则两处门禁会各说各话。
 * 即：**本档只做「与动作语义无关的那部分演化」**。
 */

import { assertActionInput } from '../core/action.js';
import type { ActionInput } from '../core/action.js';
import {
  ENGINE_DIAGNOSTIC_CODES,
  engineDiagnostic,
  optionInvalid,
  stateShapeInvalid,
  stateTerminal,
} from '../core/errors.js';
import type { EngineDiagnostic } from '../core/errors.js';
import type { ActionRecord, AuditEntry, InstanceState } from '../core/state.js';
import { assertRoundTrip, cloneState, headerOf, isTerminalStatus } from '../core/state.js';
import type { TaskDelta, TaskView } from '../core/task.js';
import { diffTasks } from '../core/task.js';

/** `plan()` 的第三个入参：**不确定性一律从参数进来**（ADR-007） */
export interface PlanOptions {
  /** 时间源；缺省则要求 `action.at` 必须显式给（否则抛 `ENGINE_OPTION_INVALID`） */
  clock?: () => string;
  /** 审计上限（INV-17）；溢出裁剪并产出 `ENGINE_AUDIT_TRUNCATED` 诊断 */
  maxAuditEntries?: number;
  /**
   * ★ **状态演化的接缝**（D-18）：`(draft) => next`，在 ④ 拷贝之后、`rev` +1 之前施加。
   *
   * 为什么必须有它：`compileAction()`（T9）产出的是**原语调用序列**，而原语调用是
   * 「动作语义」的一部分，归 `runtime/` 而不是 `core/`。没有这个接缝，`submit()` 就只能在
   * 调 `plan()` 之后自己再改一次状态 —— 于是出现**两套演化路径**，
   * 「走 `submit()` 和走 `plan()` 得到不同 `next`」（§7.1 写死的一致性）当场失守。
   *
   * ⚠️ **必须是纯函数**：只依赖入参与闭包里**已解析好的**外部知识
   * （办理人、后继节点由 `submit()` 预先取好再闭包进来 —— 本函数不得调任何 SPI）。
   * 不纯的话 `plan()` 的纯函数性（NFR-E6）就被这个接缝整段毁掉。
   */
  apply?: (draft: InstanceState) => InstanceState;
  /**
   * ★ **待办视图投影**（纯函数）：`plan()` 据此算 `delta.added/removed/changed`。
   *
   * 与 `apply` 同一条理由（D-18）：待办差分若由 `submit()` 单独算一份，
   * 门 2 下宿主直接调 `plan()` 就拿不到差分 —— 两套算法必然漂移。
   * 引擎侧的实现见 `runtime/loop.ts` 的 `tasksOf()`（结合定义图才有 `nodeName` / `formKey`）。
   */
  tasks?: (state: InstanceState) => TaskView[];
}

export interface PlanResult {
  /** 演化的结果（**新对象**，入参 `state` 不受影响） */
  next: InstanceState;
  /** 待办差分（骨架阶段恒为空差分；填充分 T10/T11） */
  delta: TaskDelta;
  /** 诊断（不抛）：如 INV-17 的审计裁剪。「不得静默丢弃」的落点就是这里 */
  diagnostics: EngineDiagnostic[];
}

/**
 * ★ 纯函数：`(state, action) → { next, delta, diagnostics }`
 *
 * 演化顺序（**顺序本身是契约** —— 审计 seq 依赖它）：
 *   ① 形状校验 → ② 终态门禁（INV-2）→ ③ 时间解析（ADR-007）→ ④ 拷贝
 *   → ④.5 变量并入（`action.payload`）→ ④.6 `apply()` 施加动作语义（D-18）
 *   → ⑤ `rev` +1（INV-1）→ ⑥ `lastAction` → ⑦ 审计追加（INV-4）
 *   → ⑧ 审计裁剪（INV-17）→ ⑨ 终态时间戳 → ⑩ 序列化体检（INV-14）→ ⑪ 组装 delta
 *
 * ⚠️ ④.5 / ④.6 必须在 ⑤ 之前：动作语义（含网关条件）要看到**本次提交的变量增量**，
 *    否则「提交表单里把 amount 改成 9000、网关却按旧值走分支」—— 静默走错分支。
 */
export function plan(state: InstanceState, action: ActionInput, options: PlanOptions = {}): PlanResult {
  assertActionInput(action, 'action');
  assertSerializableInput(state);

  // ② 终态门禁（INV-2）：终态后任何提交都必须是错误，不允许「静默无效果」
  if (isTerminalStatus(state.status)) {
    throw stateTerminal(state.instanceId, state.status, action.action);
  }

  // ③ 时间解析：优先显式 `at`，其次注入的 clock。**两者都没有 = 纯函数性无从保证，直接抛**
  const at = resolveAt(action, options);

  const diagnostics: EngineDiagnostic[] = [];

  // ④ 拷贝（不改入参）
  let next = cloneState(state);

  // ④.5 变量并入（表单增量 → variables）。必须在 apply 之前，让动作语义看到本次改动。
  if (action.payload !== undefined) {
    next.variables = { ...next.variables, ...action.payload };
  }

  // ④.6 动作语义（D-18 的接缝）：原语调用 + run-to-wait 都在这里，由调用方闭包进来
  if (options.apply !== undefined) {
    const applied = options.apply(next);
    if (typeof applied !== 'object' || applied === null) {
      throw optionInvalid('options.apply', 'must return an InstanceState object', applied);
    }
    next = applied;
    // 接缝不得偷改 `rev`（那是 plan 的账，INV-1）—— 改了说明调用方在重复记账
    if (next.rev !== state.rev) {
      throw stateShapeInvalid('options.apply must not touch rev (plan() owns it)', {
        expected: state.rev,
        got: next.rev,
      });
    }
  }

  // ⑤ rev + 1（INV-1 单调）。与 `store/memory.ts` 的归一化口径一致：写入恒取 `expectedRev + 1`
  next.rev = state.rev + 1;
  next.updatedAt = at;

  // ⑥ lastAction（★ 与 `delta.action` 同源：同一次调用产出同一份记录）
  const record: ActionRecord = {
    name: action.action,
    actor: action.actor,
    at,
  };
  if (action.comment !== undefined) record.comment = action.comment;
  if (action.target !== undefined) record.nodeId = action.target;
  next.lastAction = record;

  // ⑦ 审计追加（INV-4：seq 严格递增、无空洞 —— 取 max+1 而非 length+1，容错于裁剪）
  const entry: AuditEntry = {
    seq: nextAuditSeq(state.auditTrail),
    at,
    actor: action.actor,
    action: action.action,
  };
  if (action.target !== undefined) entry.nodeId = action.target;
  if (action.comment !== undefined) entry.payload = { comment: action.comment };
  if (action.payload !== undefined) {
    entry.payload = { ...(entry.payload ?? {}), ...action.payload };
  }
  next.auditTrail = [...state.auditTrail, entry];

  // ⑧ 审计裁剪（INV-17）：保留**最近** `maxAuditEntries` 条，溢出的是最旧的。
  //    「不得静默丢弃」的落点 = 诊断（溢出区间记在 `details.dropped*`）。
  //    ⚠️ 引擎**不**把溢出条目投 `EventSink`：事件集由 ADR-006 定死 10 个，审计也不走事件通道
  //    （审计主源就是 `auditTrail`；要归档请宿主从 `diagnostics` 转存）。
  const maxEntries = options.maxAuditEntries;
  if (maxEntries !== undefined) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw optionInvalid('maxAuditEntries', 'must be a positive integer', maxEntries);
    }
    if (next.auditTrail.length > maxEntries) {
      const dropped = next.auditTrail.slice(0, next.auditTrail.length - maxEntries);
      next.auditTrail = next.auditTrail.slice(next.auditTrail.length - maxEntries);
      diagnostics.push(
        engineDiagnostic({
          code: ENGINE_DIAGNOSTIC_CODES.AUDIT_TRUNCATED,
          message: `auditTrail exceeded maxAuditEntries and was truncated`,
          instanceId: state.instanceId,
          details: {
            maxAuditEntries: maxEntries,
            droppedCount: dropped.length,
            droppedFromSeq: dropped[0]?.seq,
            droppedToSeq: dropped[dropped.length - 1]?.seq,
          },
        }),
      );
    }
  }

  // ⑨ 终态时间戳（骨架阶段 status 不变，逻辑先就位；T10 汇聚后开始生效）
  if (isTerminalStatus(next.status) && next.endedAt === undefined) {
    next.endedAt = at;
  }

  // ⑩ INV-14：产出前必须能通过 JSON 往返
  assertRoundTrip(next, 'next');

  // ⑪ 组装 delta。`added/removed/changed` 由 `options.tasks` 投影算出（不给则为空差分）
  const tasks = options.tasks;
  const diff =
    tasks === undefined
      ? { added: [] as TaskView[], removed: [] as string[], changed: [] as TaskView[] }
      : diffTasks(tasks(state), tasks(next));

  const delta: TaskDelta = {
    rev: next.rev,
    action: record,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    instance: headerOf(next),
  };

  return { next, delta, diagnostics };
}

// ---------------- 内部helpers（均不导出：纯函数内部细节） ----------------

// ---------------- 内部helpers（均不导出：纯函数内部细节） ----------------

/** 输入侧只做序列化体检；结构体检（`assertInstanceState`）归 T11 的 load 之后，避免每次提交全量遍历 */
function assertSerializableInput(state: InstanceState): void {
  if (typeof state !== 'object' || state === null) {
    throw optionInvalid('state', 'must be a plain object', state);
  }
  if (typeof state.instanceId !== 'string' || state.instanceId.length === 0) {
    throw optionInvalid('state.instanceId', 'must be a non-empty string', state.instanceId);
  }
  if (!Number.isInteger(state.rev) || state.rev < 0) {
    throw optionInvalid('state.rev', 'must be a non-negative integer', state.rev);
  }
}

/**
 * 时间解析（ADR-007 的落点）。
 *
 * ⚠️ 这里**绝不**回退到 `Date.now()`：那会让 `plan()` 变成非纯函数，
 * 同一入参两次调用得到不同 `next`，既不可测也不可重放（NFR-E6 失守）。
 */
function resolveAt(action: ActionInput, options: PlanOptions): string {
  if (action.at !== undefined) return action.at;
  const clocked = options.clock?.();
  if (typeof clocked === 'string' && clocked.length > 0) return clocked;
  throw optionInvalid(
    'at',
    'plan() needs a time source: pass action.at, or pass PlanOptions.clock (EngineConfig.clock in submit())',
    undefined,
  );
}

/** INV-4：seq 取现有最大值 +1（对已被裁剪的审计同样成立） */
function nextAuditSeq(trail: readonly AuditEntry[]): number {
  let max = 0;
  for (const e of trail) {
    if (typeof e.seq === 'number' && e.seq > max) max = e.seq;
  }
  return max + 1;
}

// （`toHeader` 已上移到 `core/state.ts` 的 `headerOf` —— T11 的 `runtime/engine.ts` 同样需要它，
//   复制一份就会有两处"哪些字段算 Header"的判据。）
