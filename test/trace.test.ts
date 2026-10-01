/**
 * T22 · 令牌轨迹 `exportTrace()`（`ARCHITECTURE.md` §9-T22）
 *
 * ★ 本文件的判据只有三条：
 *   ① **一一对应** —— `entries` 与 `auditTrail` 同长同序，字段**直搬不补算**；
 *   ② **`kind` 标对** —— 19 项审批动作 = `approval`，其余 = `system`（**D-87**）；
 *   ③ **INV-17 的另一半** —— 审计被裁剪过必须**看得出来**（`truncated`），
 *      否则"只剩最近 3 条"会被当成"一共就 3 条"。
 *
 * ⚠️ 另有一条最容易被写成假断言的：**「`from` / `to` 认不出令牌时留空而不猜」**。
 *   写成 `expect(entry.tokenId).toBeUndefined()` 时，若定位逻辑整个返回 undefined
 *   （比如改坏了）也会通过 —— 故每组都配一条**能认出来**的正向用例。
 */

import { describe, expect, it } from 'vitest';

import { ACTION_NAMES } from '../src/actions/catalog';
import { ENGINE_ERROR_CODES } from '../src/core/errors';
import type { AuditEntry, InstanceState } from '../src/core/state';
import { cloneState, deepEqual } from '../src/core/state';
import { plan } from '../src/runtime/plan';
import type { PlanOptions } from '../src/runtime/plan';
import { SYSTEM_AUDIT_ACTIONS, traceKindOf, traceOf } from '../src/runtime/trace';
import { createEngine } from '../src/runtime/engine';
import { createMemoryStore } from '../src/store/memory';
import { expenseDefinition, singleVersionSource } from './helpers/definition';
import { expectCodeAsync } from './helpers/expect';
import { makeState } from './helpers/state';

const AT = '2026-10-01T00:00:00.000Z';
const PROCESS = 'Process_1';

const entry = (e: Partial<AuditEntry> & Pick<AuditEntry, 'seq' | 'action'>): AuditEntry => ({
  at: AT,
  actor: 'u1',
  ...e,
});

const stateWith = (trail: readonly AuditEntry[]): InstanceState =>
  makeState({ auditTrail: [...trail] });

// ---------------- ① kind：审批 / 非审批 ----------------

describe('T22 · traceKindOf（D-87：只有审批 / 非审批两档）', () => {
  it('19 项审批动作全部判成 approval', () => {
    for (const name of ACTION_NAMES) {
      expect(traceKindOf(name), `${name} 应当是 approval`).toBe('approval');
    }
  });

  it.each([...SYSTEM_AUDIT_ACTIONS])('%s 判成 system（不是审批动作）', (name) => {
    expect(traceKindOf(name)).toBe('system');
  });

  it('★ 判据取审批名单：19 项之外的新动作名 → system（而不是静默变 approval）', () => {
    expect(traceKindOf('someFutureKernelAction')).toBe('system');
  });

  it('★ SYSTEM_AUDIT_ACTIONS 与 19 项无交集（有交集 = 名单记错了）', () => {
    const approval = new Set<string>(ACTION_NAMES);
    for (const name of SYSTEM_AUDIT_ACTIONS) {
      expect(approval.has(name), `${name} 不该同时在两张名单里`).toBe(false);
    }
    expect(SYSTEM_AUDIT_ACTIONS).toHaveLength(4);
  });
});

// ---------------- ② 一一对应（不补算） ----------------

describe('T22 · traceOf() 是 auditTrail 的只读投影', () => {
  it('条数 / 顺序 / 字段逐一同（不增不减）', () => {
    const state = stateWith([
      entry({ seq: 1, action: 'start', actor: 'u0', nodeId: 'Start_1', from: 'Start_1', to: 'Task_1' }),
      entry({ seq: 2, action: 'approve', tokenId: 'tk_1', from: 'Task_1', to: 'Task_2' }),
    ]);
    const r = traceOf(state);
    expect(r.entries).toHaveLength(2);
    expect(r.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(r.entries[1]).toEqual({
      seq: 2,
      at: AT,
      actor: 'u1',
      action: 'approve',
      kind: 'approval',
      tokenId: 'tk_1',
      from: 'Task_1',
      to: 'Task_2',
    });
  });

  it('payload 原样带出（意见 / 表单增量是轨迹的一部分）', () => {
    const state = stateWith([entry({ seq: 1, action: 'approve', payload: { comment: '同意' } })]);
    expect(traceOf(state).entries[0]?.payload).toEqual({ comment: '同意' });
  });

  it('★ auditTrail 里没有的字段**不补算**（缺席就是缺席）', () => {
    const state = stateWith([entry({ seq: 1, action: 'approve' })]);
    const e = traceOf(state).entries[0];
    expect(e).toBeDefined();
    expect(Object.keys(e as object).sort()).toEqual(['action', 'actor', 'at', 'kind', 'seq']);
  });

  it('纯函数：不改入参、两次调用结果深等', () => {
    const state = stateWith([entry({ seq: 1, action: 'approve' })]);
    const before = cloneState(state);
    const a = traceOf(state);
    const b = traceOf(state);
    expect(deepEqual(state, before)).toBe(true);
    expect(deepEqual(a, b)).toBe(true);
  });
});

// ---------------- ③ 完整性（INV-17 的另一半） ----------------

describe('T22 · 轨迹完整性：被裁剪过必须看得出来', () => {
  it('seq 从 1 起 = 完整', () => {
    const r = traceOf(stateWith([entry({ seq: 1, action: 'start' })]));
    expect(r.truncated).toBe(false);
    expect(r.droppedFromSeq).toBeUndefined();
    expect(r.droppedToSeq).toBeUndefined();
  });

  it('★ 首条 seq > 1 = 被裁剪过，且报出丢掉的区间（不是"看起来完整"）', () => {
    const r = traceOf(stateWith([entry({ seq: 5, action: 'approve' })]));
    expect(r.truncated).toBe(true);
    expect(r.droppedFromSeq).toBe(1);
    expect(r.droppedToSeq).toBe(4);
  });

  it('空审计不算被裁剪（没有可说的区间）', () => {
    expect(traceOf(stateWith([])).truncated).toBe(false);
    expect(traceOf(stateWith([])).entries).toEqual([]);
  });
});

// ---------------- ④ plan() 填 from / to / tokenId（D-88） ----------------

describe('T22 · plan() 把令牌轨迹填进审计（D-88）', () => {
  const move = (to: string): NonNullable<PlanOptions['apply']> => (d) => ({
    ...d,
    tokens: d.tokens.map((t) => (t.id === 'tk_1' ? { ...t, nodeId: to } : t)),
  });

  it('单令牌：tokenId + from(推进前) + to(推进后)', () => {
    const state = makeState({
      tokens: [{ id: 'tk_1', nodeId: 'Task_1', state: 'active', assignee: 'u1' }],
    });
    const r = plan(state, { action: 'approve', actor: 'u1', at: AT }, { apply: move('Task_2') });
    const e = r.next.auditTrail[0];
    expect(e).toMatchObject({ tokenId: 'tk_1', from: 'Task_1', to: 'Task_2' });
  });

  it('★ 会签下按 actor 认领：u2 办的是 u2 那条（不是"第一条"）', () => {
    const state = makeState({
      tokens: [
        { id: 'tk_1', nodeId: 'Task_1', state: 'active', assignee: 'u1', instanceGroup: 'g1' },
        { id: 'tk_2', nodeId: 'Task_1', state: 'active', assignee: 'u2', instanceGroup: 'g1' },
      ],
    });
    const r = plan(state, { action: 'approve', actor: 'u2', at: AT }, { apply: move('Task_2') });
    expect(r.next.auditTrail[0]?.tokenId).toBe('tk_2');
  });

  it('★ 认不出时留空而不猜（会签里 actor 不是任何办理人 → 不填，绝不落到别人令牌上）', () => {
    const state = makeState({
      tokens: [
        { id: 'tk_1', nodeId: 'Task_1', state: 'active', assignee: 'u1' },
        { id: 'tk_2', nodeId: 'Task_1', state: 'active', assignee: 'u2' },
      ],
    });
    const r = plan(state, { action: 'approve', actor: 'u3', at: AT });
    const e = r.next.auditTrail[0];
    expect(e).toBeDefined();
    expect(e?.tokenId).toBeUndefined();
    expect(e?.from).toBeUndefined();
    expect(e?.to).toBeUndefined();
  });

  it('令牌终结（走到结束事件）仍记 to —— 那一跳正是轨迹的最后一跳', () => {
    const state = makeState({
      tokens: [{ id: 'tk_1', nodeId: 'Task_1', state: 'active', assignee: 'u1' }],
    });
    const r = plan(state, { action: 'approve', actor: 'u1', at: AT }, { apply: move('End_1') });
    expect(r.next.auditTrail[0]?.to).toBe('End_1');
  });

  it('令牌被移除（会签展开取代占位令牌）→ to 缺席', () => {
    const state = makeState({
      tokens: [{ id: 'tk_1', nodeId: 'Task_1', state: 'active', assignee: 'u1' }],
    });
    const r = plan(
      state,
      { action: 'approve', actor: 'u1', at: AT },
      { apply: (d) => ({ ...d, tokens: d.tokens.filter((t) => t.id !== 'tk_1') }) },
    );
    const e = r.next.auditTrail[0];
    expect(e?.tokenId).toBe('tk_1');
    expect(e?.from).toBe('Task_1');
    expect(e?.to).toBeUndefined();
  });
});

// ---------------- ⑤ 引擎端到端 ----------------

describe('T22 · engine.exportTrace()', () => {
  const engineOn = (extra: Record<string, unknown> = {}) => {
    const store = createMemoryStore();
    const engine = createEngine({
      definitionSource: singleVersionSource(PROCESS, 1, expenseDefinition()),
      store,
      clock: () => AT,
      ...extra,
    } as never);
    return { engine, store };
  };

  it('★ 一条报销跑完：start(system) → 两次 approve(approval)，from/to 连成一条链', async () => {
    const { engine } = engineOn();
    const id = await engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    await engine.submit(id, { action: 'approve', actor: 'u_manager' });
    await engine.submit(id, { action: 'approve', actor: 'u_finance' });

    const r = await engine.exportTrace(id);
    expect(r.truncated).toBe(false);
    expect(r.entries.map((e) => [e.action, e.kind])).toEqual([
      ['start', 'system'],
      ['approve', 'approval'],
      ['approve', 'approval'],
    ]);
    expect(r.entries[0]).toMatchObject({ actor: 'u_applicant', tokenId: 'tk_start', from: 'Start_1', to: 'Task_apply' });
    expect(r.entries[1]).toMatchObject({ actor: 'u_manager', tokenId: 'tk_start', from: 'Task_apply', to: 'Task_finance' });
    expect(r.entries[2]).toMatchObject({ actor: 'u_finance', tokenId: 'tk_start', from: 'Task_finance', to: 'End_1' });
  });

  it('★ 与门 2 的 `traceOf(state)` 逐字相同（两条路径不许分叉）', async () => {
    const { engine, store } = engineOn();
    const id = await engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    await engine.submit(id, { action: 'approve', actor: 'u_manager' });

    const state = await store.load(id);
    expect(state).not.toBeNull();
    expect(await engine.exportTrace(id)).toEqual(traceOf(state as InstanceState));
  });

  it('★ maxAuditEntries 溢出后：轨迹仍在 + `truncated` 亮出来（INV-17）', async () => {
    const { engine } = engineOn({ maxAuditEntries: 1 });
    const id = await engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    await engine.submit(id, { action: 'approve', actor: 'u_manager' });
    await engine.submit(id, { action: 'approve', actor: 'u_finance' });

    const r = await engine.exportTrace(id);
    // 只剩最后一次提交（`start` 与第一次 `approve` 都被裁掉）
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.action).toBe('approve');
    expect(r.truncated).toBe(true);
    expect(r.droppedFromSeq).toBe(1);
    expect(r.droppedToSeq).toBe(2);
  });

  it('实例不存在 → ENGINE_STATE_NOT_FOUND（不返回空数组糊过去）', async () => {
    const { engine } = engineOn();
    await expectCodeAsync(engine.exportTrace('pi_nope'), ENGINE_ERROR_CODES.STATE_NOT_FOUND);
  });

  it('导出是只读的：连导两次结果相同，且实例 rev 不变', async () => {
    const { engine, store } = engineOn();
    const id = await engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    const a = await engine.exportTrace(id);
    const b = await engine.exportTrace(id);
    expect(a).toEqual(b);
    expect((await store.load(id))?.rev).toBe(1);
  });
});
