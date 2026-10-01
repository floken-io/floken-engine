/**
 * @floken-io/engine · 令牌轨迹（`exportTrace()` 的纯内核，T22）
 *
 * ★ 一句话：**轨迹 = `auditTrail` 的只读投影**，不新增任何存储。
 *   `03` §9.1 的 Plan A 把 `auditTrail` 定为合规主源（随状态整块落库），
 *   本档只负责把它翻成**对外承诺形状**的 `TraceEntry[]` ——
 *   ⚠️ 若这里"顺手补算"出 auditTrail 里没有的东西，审计与轨迹就会各说各话，
 *   「库里的审计和导出的轨迹对不上」将成为一类无法定位的缺陷。
 *
 * ★ **纯函数性（NFR-E6）同 `plan()` / `emit.ts`**：不读时钟、不碰存储、不改入参。
 *   于是门 2（宿主自编排）拿着手里的 `InstanceState` 直接调 `traceOf()` 也能得到
 *   与 `engine.exportTrace()` **逐字相同**的结果（§7.1 的两条路径一致性）。
 *
 * ## ★ `kind` 只有两档：审批 / 非审批（**D-87**）
 *
 *   判据是「**是不是 19 项审批动作之一**」，不是"谁发起的"。
 *   `start` / `callActivityReturn` / `deliverMessage` / `deliverSignal` 一律 `system`。
 *
 *   ⚠️ **原语级审计（旧 `kind:'primitive'`，**D-23**）已否决**，两条理由：
 *     ① `runtime/loop.ts` 的 run-to-wait **不走 `advance` 原语**（直接改 `token.nodeId`），
 *        按"原语调用"记出来的轨迹里**没有令牌移动** —— 恰恰是"轨迹"最该有的那一半；
 *     ② 一次提交会炸出几十条，`maxAuditEntries` 的语义会从「保留最近 N 次变更」
 *        扭曲成「保留最近两次提交」，且裁剪会砍在**一次提交的内部**。
 *
 * ## ★ 完整性必须可见（**INV-17** 的另一半）
 *
 *   `maxAuditEntries` 会裁掉最旧的审计。若 `exportTrace()` 只回一个数组，
 *   被裁过的轨迹看起来跟完整的**一模一样** —— 这正是本包最忌的静默降级。
 *   故返回 `TraceResult`：`truncated` + 被丢掉的 seq 区间（与 `plan()` 那条
 *   `ENGINE_AUDIT_TRUNCATED` 诊断的 `details.dropped*` 同名字、同口径）。
 *   ⚠️ 区间是**从 seq 的空洞推出来的**（INV-4 保证 seq 从 1 起、无空洞），
 *   不需要为此在状态里新增字段 —— 新增字段就要动 `stateSchema` 与迁移表。
 */

import { ACTION_NAMES } from '../actions/catalog.js';
import type { AuditEntry } from '../core/state.js';
import type { InstanceState } from '../core/state.js';
import type { TraceEntry } from '../core/task.js';

/**
 * ★ 会进 `auditTrail` 的**非审批**动作名（**D-62** 的四类动作名里的后三类）。
 *
 * 这是「19 项审批动作之外还有哪些动作名」的**唯一事实源** —— 有测试钉住它与
 * `traceKindOf()` 一致，免得将来加一个系统动作忘了同步，于是它静默变成 `approval`。
 */
export const SYSTEM_AUDIT_ACTIONS = [
  'start',
  'callActivityReturn',
  'deliverMessage',
  'deliverSignal',
] as const;

export type SystemAuditAction = (typeof SYSTEM_AUDIT_ACTIONS)[number];

/**
 * ★ 一条审计属于哪一类。
 *
 * `approval` = 19 项审批动作之一；其余（含 19 项之外由门 2 直接写入的名字）一律 `system`。
 * ⚠️ 判据取**审批名单**而不是 `SYSTEM_AUDIT_ACTIONS` 名单：
 *   前者是"已定型的 19 项"，后者只是"已知的非审批名"—— 将来多一个系统动作，
 *   按后者判会把它错标成 `approval`（静默），按前者判只是标成 `system`（正确）。
 */
export function traceKindOf(action: string): 'approval' | 'system' {
  return (ACTION_NAMES as readonly string[]).includes(action) ? 'approval' : 'system';
}

/**
 * `exportTrace()` 的返回值。
 *
 * ⚠️ 为什么不是裸数组：`maxAuditEntries` 裁剪之后，裸数组与完整轨迹**无从区分** ——
 *   宿主会把"只剩最近 3 条"当成"一共就 3 条"（INV-17 要防的就是这个）。
 */
export interface TraceResult {
  /** 与 `auditTrail` **一一对应**、同序（INV-4 保证 seq 递增） */
  entries: TraceEntry[];
  /** ★ 审计被裁剪过 → 本轨迹**不完整**（`entries` 只是最近的一段） */
  truncated: boolean;
  /** 被丢掉的最旧 seq；未裁剪时不存在 */
  droppedFromSeq?: number;
  /** 被丢掉的最新 seq；未裁剪时不存在 */
  droppedToSeq?: number;
}

/**
 * ★ 纯函数：`state → TraceResult`。
 *
 * 门 2 下宿主自己持状态、自己落库，也该得到与 `engine.exportTrace()` 相同的结果 ——
 *   故投影逻辑**必须在纯函数里**，不许长在 `runtime/engine.ts`（唯一不纯档）里。
 */
export function traceOf(state: InstanceState): TraceResult {
  const entries = (state.auditTrail ?? []).map((e) => entryOf(e));
  const first = entries[0];

  /*
   * ★ 完整性判据就是「seq 是不是从 1 开始」：
   *   INV-4 规定 seq 严格递增、无空洞且从 1 起 ⇒ 首条 seq > 1 只可能是被裁过。
   */
  if (first === undefined || first.seq <= 1) {
    return { entries, truncated: false };
  }
  return {
    entries,
    truncated: true,
    droppedFromSeq: 1,
    droppedToSeq: first.seq - 1,
  };
}

/** 单条投影。字段与 `AuditEntry` 同名同义 —— **不做任何推断或补算** */
function entryOf(e: AuditEntry): TraceEntry {
  const out: TraceEntry = {
    seq: e.seq,
    at: e.at,
    actor: e.actor,
    action: e.action,
    kind: traceKindOf(e.action),
  };
  if (e.nodeId !== undefined) out.nodeId = e.nodeId;
  if (e.tokenId !== undefined) out.tokenId = e.tokenId;
  if (e.from !== undefined) out.from = e.from;
  if (e.to !== undefined) out.to = e.to;
  if (e.payload !== undefined) out.payload = e.payload;
  return out;
}
