/**
 * `plan()` 纯函数骨架的契约测试（T7）。
 *
 * 验收对应：`ARCHITECTURE.md` §9-T7「`plan()` 相同入参两次调用结果深等（**纯函数性**）」，
 * 外加本档顺手钉死的几条不变量：INV-1（rev 单调）/ INV-2（终态门禁）/ INV-4（seq 无空洞）/
 * INV-14（纯数据）/ INV-17（审计裁剪不得静默）/ ADR-007（时间只能从参数进来）。
 *
 * ★ 最关键的一条在 ①：**纯函数性不是靠注释保证的**。
 *   若有人在 `plan()` 里写了 `Date.now()`，第 ① 组用例会在两次调用之间产生不同 `at` → 立刻变红。
 */

import { describe, expect, it } from 'vitest';

import { ENGINE_DIAGNOSTIC_CODES, ENGINE_ERROR_CODES } from '../src/core/errors';
import type { ActionInput } from '../src/core/action';
import { cloneState, deepEqual } from '../src/core/state';
import { plan } from '../src/runtime/plan';
import { makeState } from './helpers/state';

const AT = '2026-09-30T10:00:00.000Z';
const approve: ActionInput = { action: 'approve', actor: 'u1', at: AT };

/**
 * ★ 断言**码**而不是 message：message 面向人、且刻意不含易变数据（`AGENTS.md` §5.6），
 *   写成 `expect(fn).toThrow(CODE)` 只能匹配到 message —— **码永远匹配不上，断言形同虚设**。
 */
function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `应当抛出 ${code}`).toMatchObject({ code });
}

describe('@floken-io/engine · plan() 纯函数骨架', () => {
  // ---------------- ① 纯函数性 ----------------

  describe('① 纯函数性（NFR-E6）', () => {
    it('相同入参两次调用：`next` 与 `delta` 都深等', () => {
      const state = makeState();
      const a = plan(state, approve);
      const b = plan(state, approve);
      expect(deepEqual(a.next, b.next)).toBe(true);
      expect(deepEqual(a.delta, b.delta)).toBe(true);
      expect(deepEqual(a.diagnostics, b.diagnostics)).toBe(true);
    });

    it('★ 不读系统时钟：不传 at 也不传 clock → 抛错（而不是悄悄取 Date.now()）', () => {
      const state = makeState();
      expectCode(
        () => plan(state, { action: 'approve', actor: 'u1' }),
        ENGINE_ERROR_CODES.OPTION_INVALID,
      );
    });

    it('★ 不读系统时钟：`action.at` 给了之后，clock 永不该被调用（给它一个会炸的 clock）', () => {
      const state = makeState();
      const boom = (): string => {
        throw new Error('clock must not be called when action.at is present');
      };
      const r = plan(state, approve, { clock: boom });
      expect(r.next.updatedAt).toBe(AT);
    });

    it('不改动入参：`plan()` 前后 `state` 深等', () => {
      const state = makeState({ variables: { n: 1 } });
      const before = cloneState(state);
      plan(state, approve);
      expect(deepEqual(state, before)).toBe(true);
    });

    it('产出是新对象（改 `next` 不影响入参）', () => {
      const state = makeState();
      const r = plan(state, approve);
      expect(r.next).not.toBe(state);
      r.next.variables.n = 99;
      expect(state.variables.n).toBeUndefined();
    });
  });

  // ---------------- ② 与动作语义无关的演化 ----------------

  describe('② 状态演化（INV-1 / INV-4）', () => {
    it('rev 单调 +1（INV-1），updatedAt 取解析出的时间', () => {
      const r = plan(makeState({ rev: 7 }), approve);
      expect(r.next.rev).toBe(8);
      expect(r.next.updatedAt).toBe(AT);
      expect(r.delta.rev).toBe(8);
    });

    it('lastAction 落全部字段；`target` 落到 `nodeId`', () => {
      const r = plan(makeState(), {
        action: 'reject',
        actor: 'u2',
        at: AT,
        comment: '不通过',
        target: 'Task_3',
      });
      expect(r.next.lastAction).toEqual({
        name: 'reject',
        actor: 'u2',
        at: AT,
        comment: '不通过',
        nodeId: 'Task_3',
      });
    });

    it('审计追加一条：seq = 现有最大 + 1（INV-4 无空洞）', () => {
      const state = makeState({
        auditTrail: [
          { seq: 1, at: AT, actor: 'u0', action: 'start' },
          { seq: 2, at: AT, actor: 'u0', action: 'approve' },
        ],
      });
      const r = plan(state, approve);
      expect(r.next.auditTrail).toHaveLength(3);
      expect(r.next.auditTrail[2]?.seq).toBe(3);
      expect(r.next.auditTrail[2]?.action).toBe('approve');
    });

    it('★ seq 取 max+1 而非 length+1：已被裁剪过的审计也不会撞号', () => {
      // 裁剪掉最旧的 1 条后只剩 seq=5；若实现写 length+1 会得到 2（撞号），max+1 才是 6
      const state = makeState({
        auditTrail: [{ seq: 5, at: AT, actor: 'u0', action: 'start' }],
      });
      const r = plan(state, approve);
      expect(r.next.auditTrail[1]?.seq).toBe(6);
    });

    it('payload 与 comment 都进审计的同一条 payload（不互相覆盖）', () => {
      const r = plan(makeState(), {
        action: 'approve',
        actor: 'u1',
        at: AT,
        comment: '同意',
        payload: { amount: 100 },
      });
      expect(r.next.auditTrail[0]?.payload).toEqual({ comment: '同意', amount: 100 });
    });
  });

  // ---------------- ③ 终态门禁 ----------------

  describe('③ 终态门禁（INV-2）', () => {
    it.each(['completed', 'terminated', 'cancelled'] as const)(
      'status=%s 时提交必须抛 ENGINE_STATE_TERMINAL（不许静默无效果）',
      (status) => {
        const state = makeState({ status });
        try {
          plan(state, approve);
          expect.unreachable('应当抛错');
        } catch (e) {
          expect((e as { code?: string }).code).toBe(ENGINE_ERROR_CODES.STATE_TERMINAL);
        }
      },
    );

    it('running / suspended 不受 INV-2 影响（挂起的门禁归 T9）', () => {
      expect(() => plan(makeState({ status: 'running' }), approve)).not.toThrow();
      expect(() => plan(makeState({ status: 'suspended' }), approve)).not.toThrow();
    });
  });

  // ---------------- ④ 时间源（ADR-007） ----------------

  describe('④ 时间源（ADR-007）', () => {
    it('无 at 时用注入的 clock', () => {
      const r = plan(makeState(), { action: 'approve', actor: 'u1' }, { clock: () => AT });
      expect(r.next.updatedAt).toBe(AT);
      expect(r.next.lastAction?.at).toBe(AT);
      expect(r.next.auditTrail[0]?.at).toBe(AT);
    });

    it('缺时间源的错误**指出怎么修**（AGENTS.md §5.4）', () => {
      const state = makeState();
      let caught: { code?: string; message?: string; details?: Record<string, unknown> } = {};
      try {
        plan(state, { action: 'approve', actor: 'u1' });
        expect.unreachable('应当抛错');
      } catch (e) {
        caught = e as typeof caught;
      }
      expect(caught.code).toBe(ENGINE_ERROR_CODES.OPTION_INVALID);
      // message 面向人且不含易变数据（§5.6）→ 修复建议落在 details.reason
      expect(String(caught.details?.reason)).toMatch(/clock|action\.at/);
      // 但 message 必须能定位到是哪个选项
      expect(caught.message).toContain('at');
    });
  });

  // ---------------- ⑤ 审计上限（INV-17） ----------------

  describe('⑤ 审计上限（INV-17：不得静默丢弃）', () => {
    function trail(n: number) {
      return Array.from({ length: n }, (_, i) => ({
        seq: i + 1,
        at: AT,
        actor: 'u0',
        action: `a${i + 1}`,
      }));
    }

    it('超限时保留**最近** N 条，并产出 ENGINE_AUDIT_TRUNCATED 诊断', () => {
      const state = makeState({ auditTrail: trail(5) });
      const r = plan(state, approve, { maxAuditEntries: 2 });
      expect(r.next.auditTrail).toHaveLength(2);
      expect(r.next.auditTrail.map((e) => e.seq)).toEqual([5, 6]);
      expect(r.diagnostics).toHaveLength(1);
      expect(r.diagnostics[0]?.code).toBe(ENGINE_DIAGNOSTIC_CODES.AUDIT_TRUNCATED);
      expect(r.diagnostics[0]?.details).toMatchObject({
        maxAuditEntries: 2,
        droppedCount: 4,
        droppedFromSeq: 1,
        droppedToSeq: 4,
      });
    });

    it('未超限则**不**产生诊断', () => {
      const r = plan(makeState({ auditTrail: trail(1) }), approve, { maxAuditEntries: 100 });
      expect(r.diagnostics).toEqual([]);
      expect(r.next.auditTrail).toHaveLength(2);
    });

    it('maxAuditEntries 非正整数 → 抛 ENGINE_OPTION_INVALID（配置错，不是状态错）', () => {
      for (const bad of [0, -1, 1.5, NaN]) {
        expectCode(
          () => plan(makeState(), approve, { maxAuditEntries: bad }),
          ENGINE_ERROR_CODES.OPTION_INVALID,
        );
      }
    });

    it('诊断是纯数据（可 JSON 序列化，能随结果返回给宿主）', () => {
      const r = plan(makeState({ auditTrail: trail(3) }), approve, { maxAuditEntries: 1 });
      expect(deepEqual(r.diagnostics, JSON.parse(JSON.stringify(r.diagnostics)))).toBe(true);
    });
  });

  // ---------------- ⑥ 入参形状 ----------------

  describe('⑥ 入参形状校验', () => {
    it.each([
      ['action 为空串', { action: '', actor: 'u1' }],
      ['actor 缺失', { action: 'approve' }],
      ['at 非字符串', { action: 'approve', actor: 'u1', at: 123 }],
      ['payload 非对象', { action: 'approve', actor: 'u1', payload: 'x' }],
    ])('%s → 抛 ENGINE_OPTION_INVALID', (_name, input) => {
      expectCode(
        () => plan(makeState(), input as unknown as ActionInput),
        ENGINE_ERROR_CODES.OPTION_INVALID,
      );
    });

    it.each([null, undefined, 'approve', []])('非对象入参 %p 同样被挡住', (input) => {
      expectCode(
        () => plan(makeState(), input as unknown as ActionInput),
        ENGINE_ERROR_CODES.OPTION_INVALID,
      );
    });
  });

  // ---------------- ⑦ delta 形状 ----------------

  describe('⑦ delta 形状（§6.2）', () => {
    it('`delta.action` 与 `next.lastAction` 同源（一份记录两处用）', () => {
      const r = plan(makeState(), approve);
      expect(deepEqual(r.delta.action, r.next.lastAction)).toBe(true);
    });

    it('`delta.instance` 只有 Header，**不含** Body 字段（不解体给宿主）', () => {
      const r = plan(makeState(), approve);
      const keys = Object.keys(r.delta.instance).sort();
      for (const body of ['tokens', 'completedNodes', 'variables', 'auditTrail']) {
        expect(keys).not.toContain(body);
      }
      expect(keys).toContain('instanceId');
      expect(keys).toContain('rev');
      expect(keys).toContain('status');
    });

    it('骨架阶段恒为空差分（added / removed / changed 由 T10-T11 的推进循环填充）', () => {
      const r = plan(makeState(), approve);
      expect(r.delta.added).toEqual([]);
      expect(r.delta.removed).toEqual([]);
      expect(r.delta.changed).toEqual([]);
    });
  });
});
