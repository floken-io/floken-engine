/**
 * `createMemoryStore()` 契约测试。
 *
 * 验收对应：`AC-E11`（`expectedRev` 不匹配抛 `ENGINE_PERSIST_CONFLICT`；
 * `expectedRev === 0` 且 id 已存在抛 `ENGINE_PERSIST_ALREADY_EXISTS`）+ `INV-1`（rev 单调递增）。
 *
 * ★ 除了 AC，这里还钉死三条**内存实现专属**的保证 —— 它们不会写进 `StateStore` 接口，
 *   但任何一个 SQL 实现都必须等效满足（括号里是对应的 SQL 机制）：
 *   · 两侧深拷贝（库里的行 ≠ 宿主手里的对象）
 *   · `save()` 同步生效、不可交错（事务）
 *   · `rev` 由存储层归一化（`SET rev = rev + 1`）
 */
import { describe, it, expect } from 'vitest';
import { createMemoryStore } from '../src/store/memory';
import { ENGINE_ERROR_CODES } from '../src/core/errors';
import { STATE_SCHEMA_VERSION } from '../src/core/state';
import type { InstanceState, InstanceStatus } from '../src/core/state';

function makeState(instanceId: string, over: Partial<InstanceState> = {}): InstanceState {
  const status: InstanceStatus = 'running';
  return {
    instanceId,
    processId: 'leave-approval',
    definitionVersion: 1,
    status,
    rev: 0,
    stateSchema: STATE_SCHEMA_VERSION,
    startedAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    tokens: [],
    completedNodes: [],
    variables: {},
    auditTrail: [],
    ...over,
  };
}

const NEW = 0; // expectedRev === 0 = INSERT 信号

describe('createMemoryStore — AC-E11 两条冲突路径', () => {
  it('INSERT 成功：expectedRev === 0 且 id 不存在', async () => {
    const store = createMemoryStore();
    await store.save(makeState('pi_1'), NEW);
    const loaded = await store.load('pi_1');
    expect(loaded?.instanceId).toBe('pi_1');
    expect(loaded?.processId).toBe('leave-approval');
  });

  it('load() 不存在返回 null（不是抛错）', async () => {
    const store = createMemoryStore();
    await expect(store.load('nope')).resolves.toBeNull();
  });

  it('AC-E11-a：expectedRev 不匹配 → ENGINE_PERSIST_CONFLICT', async () => {
    const store = createMemoryStore();
    await store.save(makeState('pi_1'), NEW); // rev → 1
    const err = await store.save(makeState('pi_1'), 99).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: ENGINE_ERROR_CODES.PERSIST_CONFLICT,
      instanceId: 'pi_1',
      details: { expectedRev: 99, actualRev: 1 },
    });
  });

  it('AC-E11-b：expectedRev === 0 但 id 已存在 → ENGINE_PERSIST_ALREADY_EXISTS', async () => {
    const store = createMemoryStore();
    await store.save(makeState('pi_1'), NEW);
    const err = await store.save(makeState('pi_1'), NEW).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: ENGINE_ERROR_CODES.PERSIST_ALREADY_EXISTS,
      instanceId: 'pi_1',
    });
  });

  it('expectedRev > 0 但实例不存在 → 也归 CONFLICT，且不产生 actualRev 键', async () => {
    const store = createMemoryStore();
    const err = (await store.save(makeState('pi_1'), 3).catch((e: unknown) => e)) as {
      code: string;
      details?: Record<string, unknown>;
    };
    expect(err.code).toBe(ENGINE_ERROR_CODES.PERSIST_CONFLICT);
    // 「库里没有这一行」与「rev 对不上」的区别，只能靠 actualRev 在不在来区分
    expect(Object.keys(err.details ?? {})).not.toContain('actualRev');
  });

  it('失败不得留下痕迹：冲突后库里的行原样不动', async () => {
    const store = createMemoryStore();
    await store.save(makeState('pi_1', { variables: { a: 1 } }), NEW);

    // ① ALREADY_EXISTS 路径不得覆盖
    await expect(store.save(makeState('pi_1', { variables: { b: 2 } }), NEW)).rejects.toThrow();
    expect((await store.load('pi_1'))?.variables).toEqual({ a: 1 });

    // ② CAS 冲突不得改动 rev
    await expect(store.save(makeState('pi_1', { variables: { c: 3 } }), 7)).rejects.toThrow();
    const after = await store.load('pi_1');
    expect(after?.variables).toEqual({ a: 1 });
    expect(after?.rev).toBe(1);
  });
});

describe('createMemoryStore — INV-1 rev 单调递增', () => {
  it('INSERT 后 rev 恒为 1；每次 CAS 成功后 +1', async () => {
    const store = createMemoryStore();
    await store.save(makeState('pi_1'), NEW);
    expect((await store.load('pi_1'))?.rev).toBe(1);

    await store.save(makeState('pi_1'), 1);
    expect((await store.load('pi_1'))?.rev).toBe(2);

    await store.save(makeState('pi_1'), 2);
    expect((await store.load('pi_1'))?.rev).toBe(3);
  });

  it('rev 由存储层归一化：调用方传错的 next.rev 不会污染库里', async () => {
    const store = createMemoryStore();

    // INSERT 传了一个荒唐的 next.rev
    await store.save(makeState('pi_1', { rev: 999 }), NEW);
    expect((await store.load('pi_1'))?.rev).toBe(1);

    // CAS 同样：库里只看 expectedRev
    await store.save(makeState('pi_1', { rev: 0 }), 1);
    expect((await store.load('pi_1'))?.rev).toBe(2);
  });

  it('同一 expectedRev 的第二次 CAS 必然失败（乐观锁不能形同虚设）', async () => {
    const store = createMemoryStore();
    await store.save(makeState('pi_1'), NEW); // rev 1
    await store.save(makeState('pi_1'), 1); // rev 2
    await expect(store.save(makeState('pi_1'), 1)).rejects.toMatchObject({
      code: ENGINE_ERROR_CODES.PERSIST_CONFLICT,
    });
  });
});

describe('createMemoryStore — 深拷贝（两侧都不许交出引用）', () => {
  it('load() 交出副本：改返回值不影响库里', async () => {
    const store = createMemoryStore();
    await store.save(makeState('pi_1', { variables: { n: 1 } }), NEW);

    const first = await store.load('pi_1');
    first!.variables.n = 42;
    // ★ 同时改**嵌套对象**与**数组**：只做浅拷贝的实现会漏掉后面这一条
    first!.tokens.push({ id: 'tk_1', nodeId: 'Task_1', state: 'active', assignee: 'u_1' });

    const second = await store.load('pi_1');
    expect(second?.variables).toEqual({ n: 1 });
    expect(second?.tokens).toEqual([]);
  });

  it('save() 存入副本：之后改原对象不影响库里', async () => {
    const store = createMemoryStore();
    const s = makeState('pi_1', { variables: { n: 1 } });
    await store.save(s, NEW);

    s.variables.n = 42;
    s.variables.injected = true;

    const loaded = await store.load('pi_1');
    expect(loaded?.variables).toEqual({ n: 1 });
  });
});

describe('createMemoryStore — 原子性（save 体内不得有 await）', () => {
  it('save() 同步生效：不 await 直接 load 也能读到', async () => {
    const store = createMemoryStore();
    // ★ 不 await。若 save() 体内引入了 await，这里必然读不到 —— 测试的作用就是钉死这一点。
    const pending = store.save(makeState('pi_1'), NEW);
    const loaded = await store.load('pi_1');
    expect(loaded?.instanceId).toBe('pi_1');
    await pending;
  });

  it('两次并发 INSERT 同一 id：恰好一个成功', async () => {
    const store = createMemoryStore();
    const results = await Promise.allSettled([
      store.save(makeState('pi_1'), NEW),
      store.save(makeState('pi_1'), NEW),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      code: ENGINE_ERROR_CODES.PERSIST_ALREADY_EXISTS,
    });
  });
});

describe('createMemoryStore — 纯数据准入（AC-E8 / INV-14）', () => {
  it('含函数的 state 在写入前就被拒（库内永不出现非纯数据）', async () => {
    const store = createMemoryStore();
    const bad = makeState('pi_1', { variables: { fn: () => 1 } }) as unknown as InstanceState;
    await expect(store.save(bad, NEW)).rejects.toMatchObject({
      code: ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    });
    // 被拒之后库里不该有半条记录
    await expect(store.load('pi_1')).resolves.toBeNull();
  });

  it('含 Map / undefined 值同样被拒', async () => {
    const store = createMemoryStore();
    const withMap = makeState('pi_1', { variables: { m: new Map() } }) as unknown as InstanceState;
    await expect(store.save(withMap, NEW)).rejects.toMatchObject({
      code: ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    });

    const withUndef = makeState('pi_2', {
      variables: { u: undefined },
    }) as unknown as InstanceState;
    await expect(store.save(withUndef, NEW)).rejects.toMatchObject({
      code: ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    });
  });
});

describe('createMemoryStore — 隔离性', () => {
  it('不同 instanceId 互不影响，各自独立计 rev', async () => {
    const store = createMemoryStore();
    await store.save(makeState('pi_1'), NEW);
    await store.save(makeState('pi_2'), NEW);
    await store.save(makeState('pi_1'), 1);

    expect((await store.load('pi_1'))?.rev).toBe(2);
    expect((await store.load('pi_2'))?.rev).toBe(1);
  });

  it('两个 store 实例互不可见（每次 createMemoryStore() 独占一份）', async () => {
    const a = createMemoryStore();
    const b = createMemoryStore();
    await a.save(makeState('pi_1'), NEW);
    await expect(b.load('pi_1')).resolves.toBeNull();
  });
});
