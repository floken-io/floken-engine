/**
 * T3 验证：数据模型 + 序列化守卫
 *   · `AC-E8`：状态不得含函数 / Map / Set / 类实例
 *   · `INV-14`：`JSON.parse(JSON.stringify(state))` 与 `state` 深等
 *   · `INV-4`：`auditTrail[].seq` 严格递增、无空洞
 *   · `stateSchema` 迁移函数的三条路径
 */
import { describe, it, expect } from 'vitest';
import {
  STATE_SCHEMA_VERSION,
  STATE_MIGRATIONS,
  INSTANCE_STATUSES,
  TERMINAL_STATUSES,
  TOKEN_STATES,
  isTerminalStatus,
  assertSerializable,
  assertRoundTrip,
  assertInstanceState,
  findNonSerializableValue,
  isSerializable,
  cloneState,
  deepEqual,
  migrateState,
  type InstanceState,
  type StateMigration,
} from '../src/core/state';
import { EngineStateError, ENGINE_ERROR_CODES } from '../src/core/errors';

function makeState(over: Partial<InstanceState> = {}): InstanceState {
  return {
    instanceId: 'pi_0001',
    processId: 'Process_1',
    definitionVersion: 1,
    status: 'running',
    rev: 0,
    stateSchema: STATE_SCHEMA_VERSION,
    startedAt: '2026-09-30T00:00:00Z',
    updatedAt: '2026-09-30T00:00:00Z',
    tokens: [{ id: 'tk_1', nodeId: 'UserTask_1', state: 'active' }],
    completedNodes: [],
    variables: {},
    auditTrail: [{ seq: 1, at: '2026-09-30T00:00:00Z', actor: 'u_001', action: 'submit' }],
    ...over,
  };
}

describe('@floken-io/engine 数据模型', () => {
  describe('枚举表与类型同源', () => {
    it('三张值表与文档口径一致', () => {
      expect([...INSTANCE_STATUSES]).toEqual([
        'running',
        'suspended',
        'completed',
        'terminated',
        'cancelled',
      ]);
      expect([...TERMINAL_STATUSES]).toEqual(['completed', 'terminated', 'cancelled']);
      expect([...TOKEN_STATES]).toEqual(['active', 'waiting', 'completed', 'cancelled']);
      expect(STATE_SCHEMA_VERSION).toBe(1);
    });

    it('终态判定（INV-2 的前提）', () => {
      expect(isTerminalStatus('completed')).toBe(true);
      expect(isTerminalStatus('terminated')).toBe(true);
      expect(isTerminalStatus('cancelled')).toBe(true);
      expect(isTerminalStatus('running')).toBe(false);
      expect(isTerminalStatus('suspended')).toBe(false);
    });
  });

  describe('AC-E8 / INV-14 · 序列化守卫', () => {
    it('合法状态：可序列化 + 往返深等', () => {
      const s = makeState();
      expect(isSerializable(s)).toBe(true);
      expect(() => assertSerializable(s)).not.toThrow();
      expect(() => assertRoundTrip(s)).not.toThrow();
      expect(deepEqual(s, cloneState(s))).toBe(true);
    });

    it('rev === 0 合法 —— 它是 INSERT 信号，不是「缺省」', () => {
      expect(() => assertInstanceState(makeState({ rev: 0 }))).not.toThrow();
    });

    it.each([
      ['function', () => 1],
      ['map', new Map([['k', 1]])],
      ['set', new Set([1])],
      ['date', new Date('2026-09-30T00:00:00Z')],
      ['bigint', 10n],
      ['non-finite-number', Number.NaN],
      ['non-finite-number', Number.POSITIVE_INFINITY],
      ['circular', (() => { const o: Record<string, unknown> = {}; o['self'] = o; return o; })()],
    ])('拒绝 %s', (kind, bad) => {
      const s = makeState({ variables: { bad } });
      expect(isSerializable(s)).toBe(false);
      expect(findNonSerializableValue(s)?.kind).toBe(kind);
      const err = (() => {
        try {
          assertSerializable(s);
          return null;
        } catch (e) {
          return e as EngineStateError;
        }
      })();
      expect(err).toBeInstanceOf(EngineStateError);
      expect(err?.code).toBe(ENGINE_ERROR_CODES.STATE_SHAPE_INVALID);
      // 定位到坏值所在路径（循环引用的路径会多一段 `.self`，故用包含判定）
      expect(String(err?.details?.['path'])).toContain('$.variables.bad');
    });

    it('拒绝类实例（原型不是 Object.prototype）', () => {
      class Money {
        constructor(public amount: number) {}
      }
      expect(findNonSerializableValue({ m: new Money(1) })).toMatchObject({
        path: '$.m',
        kind: 'class-instance',
        detail: 'Money',
      });
    });

    it('拒绝 `undefined` 值键 —— 它会被 JSON 丢掉、导致不再深等', () => {
      expect(findNonSerializableValue({ a: undefined })).toMatchObject({
        path: '$.a',
        kind: 'undefined',
      });
      // 数组里的 undefined 同样会被 JSON 变成 null
      expect(findNonSerializableValue([1, undefined])).toMatchObject({
        path: '$[1]',
        kind: 'undefined',
      });
    });

    it('拒绝 symbol 键（JSON 会整条丢掉）', () => {
      const o: Record<PropertyKey, unknown> = { ok: 1 };
      o[Symbol('s')] = 2;
      expect(findNonSerializableValue(o)?.kind).toBe('symbol-key');
    });

    it('DAG（同一对象被两处引用）**合法** —— 只有真环才拒', () => {
      const shared = { x: 1 };
      expect(isSerializable({ a: shared, b: shared })).toBe(true);
    });

    it('定位到第一个坏值（路径可读）', () => {
      const s = makeState({
        variables: { ok: 1 },
        tokens: [{ id: 'tk_1', nodeId: 'UserTask_1', state: 'active' }],
      });
      // 在 auditTrail 里埋一个函数
      (s.auditTrail[0] as unknown as Record<string, unknown>)['payload'] = { fn: () => 1 };
      expect(findNonSerializableValue(s)).toMatchObject({
        path: '$.auditTrail[0].payload.fn',
        kind: 'function',
      });
    });
  });

  describe('结构断言', () => {
    it('合法状态通过', () => {
      expect(() => assertInstanceState(makeState())).not.toThrow();
    });

    it.each([
      ['instanceId 为空', { instanceId: '' }],
      ['definitionVersion 为 0', { definitionVersion: 0 }],
      ['status 非法', { status: 'done' as never }],
      ['rev 为负', { rev: -1 }],
      ['stateSchema 为 0', { stateSchema: 0 }],
      ['startedAt 为空', { startedAt: '' }],
    ])('拒绝：%s', (_name, over) => {
      expect(() => assertInstanceState(makeState(over as Partial<InstanceState>))).toThrow(
        EngineStateError,
      );
    });

    it('拒绝令牌状态非法', () => {
      const s = makeState({
        tokens: [{ id: 'tk_1', nodeId: 'UserTask_1', state: 'pending' as never }],
      });
      expect(() => assertInstanceState(s)).toThrow(/tokens\[0\]\.state/);
    });

    it('拒绝 auditTrail.seq 跳号（INV-4）', () => {
      const s = makeState({
        auditTrail: [
          { seq: 1, at: 't', actor: 'u', action: 'a' },
          { seq: 3, at: 't', actor: 'u', action: 'a' },
        ],
      });
      expect(() => assertInstanceState(s)).toThrow(/strictly increasing without gaps/);
    });

    it('拒绝 variables 非 plain object', () => {
      const s = makeState({ variables: [] as unknown as Record<string, unknown> });
      expect(() => assertInstanceState(s)).toThrow(/variables must be a plain object/);
    });
  });

  describe('stateSchema 迁移', () => {
    it('已是当前版本 → 原样返回（同一引用，不做无谓拷贝）', () => {
      const s = makeState();
      expect(migrateState(s)).toBe(s);
    });

    it('目标低于当前版本 → 抛 STATE_SCHEMA_UNSUPPORTED（只升不降）', () => {
      const s = makeState({ stateSchema: 3 });
      expect(() => migrateState(s, 1)).toThrow(EngineStateError);
      try {
        migrateState(s, 1);
      } catch (e) {
        expect((e as EngineStateError).code).toBe(ENGINE_ERROR_CODES.STATE_SCHEMA_UNSUPPORTED);
        expect((e as EngineStateError).details).toMatchObject({ from: 3, to: 1 });
      }
    });

    it('缺迁移函数 → 抛，并列出已知的 from 版本', () => {
      const s = makeState();
      try {
        migrateState(s, 2);
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as EngineStateError).code).toBe(ENGINE_ERROR_CODES.STATE_SCHEMA_UNSUPPORTED);
        expect((e as EngineStateError).details).toMatchObject({ from: 1, to: 2, knownFromVersions: [] });
      }
    });

    it('注入迁移后能升级（逐级 +1）', () => {
      const migrations: StateMigration[] = [
        {
          from: 1,
          migrate: (s) => ({
            ...s,
            stateSchema: 2,
            variables: { ...s.variables, migrated: true },
          }),
        },
        { from: 2, migrate: (s) => ({ ...s, stateSchema: 3 }) },
      ];
      const up = migrateState(makeState(), 3, migrations);
      expect(up.stateSchema).toBe(3);
      expect(up.variables['migrated']).toBe(true);
    });

    it('迁移函数没把版本 +1 → 抛 SHAPE_INVALID（防止静默打转）', () => {
      const bad: StateMigration[] = [{ from: 1, migrate: (s) => ({ ...s, stateSchema: 5 }) }];
      expect(() => migrateState(makeState(), 2, bad)).toThrow(/exactly one/);
    });

    it('生产迁移表当前为空（v1 是首版）—— 若加迁移须同步本断言', () => {
      expect(STATE_MIGRATIONS).toEqual([]);
    });
  });
});
