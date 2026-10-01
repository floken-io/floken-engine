/**
 * T12 · 门 1 `hooks`（`ARCHITECTURE.md` §9 T12 / §7.3 / ADR-004）
 *
 * ★ 本文件最值钱的三条：
 *   ① **否决 = 状态未变**（`beforeAction` 在 `save()` **之前**，返回 false 就一行都没写）；
 *   ② **只读是真只读**（改 `ctx.action` 会**抛 `TypeError`**，且引擎自己的 delta 不受影响）——
 *      若只是"改了不生效"，宿主会以为自己改成功了，是最难查的一类误伤；
 *   ③ **`afterAction` 失败不吞，但状态已落库** —— 这是「至少一次投递」的代价，
 *      必须写成断言而不是藏在注释里，否则将来有人"顺手"把它吞掉。
 */
import { describe, expect, it } from 'vitest';

import { ENGINE_ERROR_CODES } from '../src/core/errors';
import type { ActionContext, EngineHooks } from '../src/core/hooks';
import type { StateStore, TaskProjection } from '../src/core/spi';
import type { InstanceState } from '../src/core/state';
import { createEngine } from '../src/runtime/engine';
import type { Engine } from '../src/runtime/engine';
import { createMemoryStore } from '../src/store/memory';
import { expenseDefinition, singleVersionSource } from './helpers/definition';

const T0 = '2026-10-01T00:00:00.000Z';
const PROCESS = 'Process_1';

/** 记录写库次数的 store —— 用来证明「否决 = 一次都没写」 */
function countingStore(): StateStore & { saves: number; last: InstanceState | null } {
  const inner = createMemoryStore();
  const box = { saves: 0, last: null as InstanceState | null };
  return {
    get saves(): number {
      return box.saves;
    },
    get last(): InstanceState | null {
      return box.last;
    },
    load: (id) => inner.load(id),
    async save(next, expectedRev) {
      box.saves += 1;
      box.last = JSON.parse(JSON.stringify(next)) as InstanceState;
      await inner.save(next, expectedRev);
    },
  };
}

interface Harness {
  engine: Engine;
  store: StateStore;
  /** 发起并停在 `Task_apply` */
  start(): Promise<string>;
}

/**
 * ★ **一个 harness = 一个引擎 = 一个 store**：
 *   `start()` 与 `submit()` 必须共用同一个实例，否则后者直接 `STATE_NOT_FOUND`
 *   （`NFR-E10` 默认内存 store 是**每引擎一份**的，这点第一次写测试就会踩）。
 */
function harness(opts: {
  hooks?: EngineHooks;
  projection?: TaskProjection;
  store?: StateStore;
} = {}): Harness {
  const store: StateStore = opts.store ?? createMemoryStore();
  const engine = createEngine({
    definitionSource: singleVersionSource(PROCESS, 1, expenseDefinition()),
    clock: () => T0,
    store,
    ...(opts.projection === undefined ? {} : { projection: opts.projection }),
    ...(opts.hooks === undefined ? {} : { hooks: opts.hooks }),
  });
  return {
    engine,
    store,
    start: () => engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' }),
  };
}

describe('槽位 5 · beforeAction：可否决', () => {
  it('返回 `false` → 抛 `ENGINE_ACTION_VETOED`，且**状态一行都没写**', async () => {
    const store = countingStore();
    const h = harness({ hooks: { beforeAction: () => false }, store });
    const id = await h.start();
    const savesBefore = store.saves;

    let thrown: unknown;
    try {
      await h.engine.submit(id, { action: 'approve', actor: 'u_manager' });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code?: string })?.code).toBe(ENGINE_ERROR_CODES.ACTION_VETOED);
    // ★ 否决的核心：save 一次都没被调用（不是"写了再回滚"）
    expect(store.saves).toBe(savesBefore);

    const loaded = await store.load(id);
    expect(loaded?.rev).toBe(1);
    expect(loaded?.tokens[0]?.nodeId).toBe('Task_apply');
  });

  it('★ 否决必须抛错 —— 静默返回空差分会让用户以为办完了', async () => {
    const h = harness({ hooks: { beforeAction: () => false } });
    const id = await h.start();
    await expect(h.engine.submit(id, { action: 'approve', actor: 'u_manager' })).rejects.toThrow();
  });

  it('返回 `true` / `undefined` → 放行', async () => {
    const h = harness({ hooks: { beforeAction: () => true } });
    const id = await h.start();
    await expect(
      h.engine.submit(id, { action: 'approve', actor: 'u_manager' }),
    ).resolves.toBeDefined();
  });

  it('宿主抛自己的错 → **原样冒泡**（带原因的唯一途径）', async () => {
    class BudgetFrozen extends Error {
      override name = 'BudgetFrozen';
      code = 'BIZ_BUDGET_FROZEN';
    }
    const veto = (): never => {
      throw new BudgetFrozen('预算已冻结');
    };
    const h = harness({ hooks: { beforeAction: veto } });
    const id = await h.start();

    const err = await h.engine
      .submit(id, { action: 'approve', actor: 'u_manager' })
      .then(() => null)
      .catch((e: unknown) => e);
    expect((err as BudgetFrozen).code).toBe('BIZ_BUDGET_FROZEN');
    expect((err as Error).message).toBe('预算已冻结');
  });

  it('支持 async（SPI 全是异步的，钩子若只同步会逼宿主放弃查库）', async () => {
    const h = harness({
      hooks: {
        beforeAction: async () => {
          await new Promise((r) => setTimeout(r, 0));
          return true;
        },
      },
    });
    const id = await h.start();
    await expect(
      h.engine.submit(id, { action: 'approve', actor: 'u_manager' }),
    ).resolves.toBeDefined();
  });
});

describe('槽位 8 · afterAction：save 之后，失败不吞', () => {
  it('★ 时序：before → save → 投影 apply → after（顺序本身是契约）', async () => {
    const order: string[] = [];
    const projection: TaskProjection = {
      async apply(): Promise<void> {
        order.push('apply');
      },
      async sync(): Promise<void> {
        order.push('sync');
      },
    };
    const inner = countingStore();
    const h = harness({
      hooks: {
        beforeAction: () => {
          order.push('before');
          return true;
        },
        afterAction: () => {
          order.push('after');
        },
      },
      projection,
      store: {
        load: (id) => inner.load(id),
        async save(next, rev) {
          order.push('save');
          await inner.save(next, rev);
        },
      },
    });
    const id = await h.start();
    order.length = 0;

    await h.engine.submit(id, { action: 'approve', actor: 'u_manager' });
    expect(order).toEqual(['before', 'save', 'apply', 'after']);
  });

  it('★ 失败不吞：`submit()` 拒绝 —— 但**状态已经落库**（至少一次的代价，宿主必须幂等）', async () => {
    const store = countingStore();
    let calls = 0;
    const h = harness({
      hooks: {
        afterAction: () => {
          calls += 1;
          throw new Error('after boom');
        },
      },
      store,
    });
    const id = await h.start();

    await expect(h.engine.submit(id, { action: 'approve', actor: 'u_manager' })).rejects.toThrow(
      'after boom',
    );

    // ★ 诚实断言：抛错 ≠ 回滚。宿主看到"提交失败"时必须先查状态，不能盲目重放
    const loaded = await store.load(id);
    expect(loaded?.rev).toBe(2);
    expect(loaded?.tokens[0]?.nodeId).toBe('Task_finance');
    expect(calls).toBe(1);
  });

  it('ctx.next 是**写库后**的状态，ctx.state 是写库前的', async () => {
    let seen: ActionContext | undefined;
    const h = harness({
      hooks: {
        afterAction: (ctx) => {
          seen = ctx;
        },
      },
    });
    const id = await h.start();
    await h.engine.submit(id, { action: 'approve', actor: 'u_manager' });
    expect(seen).toBeDefined();
    expect(seen?.state.rev).toBe(1);
    expect(seen?.next.rev).toBe(2);
  });
});

describe('★ 门 1 只读：`ctx` 改不动', () => {
  it('试图改写 `ctx.action` → 抛 TypeError（严格模式），且引擎自己的 delta 不受影响', async () => {
    let caught: unknown;
    const h = harness({
      hooks: {
        beforeAction: (ctx) => {
          try {
            (ctx.action as { name: string }).name = 'HACKED';
          } catch (e) {
            caught = e;
          }
          return true;
        },
      },
    });
    const id = await h.start();
    const delta = await h.engine.submit(id, { action: 'approve', actor: 'u_manager' });

    expect(caught).toBeInstanceOf(TypeError);
    // ★ 引擎自己那份照旧：钩子看到的 ctx 是**拷贝 + 冻结**，不是同一对象
    expect(delta.action.name).toBe('approve');
  });

  it('试图改写 `ctx.delta.added` → 同样抛，且不污染返回给宿主的 delta', async () => {
    let caught: unknown;
    const h = harness({
      hooks: {
        beforeAction: (ctx) => {
          try {
            (ctx.delta.added as unknown as { length: number }).length = 0;
          } catch (e) {
            caught = e;
          }
          return true;
        },
      },
    });
    const id = await h.start();
    const delta = await h.engine.submit(id, { action: 'approve', actor: 'u_manager' });
    expect(caught).toBeInstanceOf(TypeError);
    expect(delta.added).toHaveLength(1);
  });

  it('★ `ctx.state` / `ctx.next` 是 Header —— 不许泄漏 body（§6.1 两层的硬约束）', async () => {
    let seen: ActionContext | undefined;
    const h = harness({
      hooks: {
        beforeAction: (ctx) => {
          seen = ctx;
          return true;
        },
      },
    });
    const id = await h.start();
    await h.engine.submit(id, { action: 'approve', actor: 'u_manager' });

    for (const key of ['tokens', 'variables', 'auditTrail', 'completedNodes', 'starter']) {
      expect(Object.keys(seen?.state ?? {})).not.toContain(key);
      expect(Object.keys(seen?.next ?? {})).not.toContain(key);
    }
    expect(Object.keys(seen?.next ?? {})).toContain('rev');
  });
});

describe('D-27 · `start()` 不触发门 1 钩子', () => {
  it('发起没有"否决后回滚到的状态" —— 宿主应在调 `start()` 之前自己判', async () => {
    const calls: string[] = [];
    const h = harness({
      hooks: {
        beforeAction: () => {
          calls.push('before');
          return true;
        },
        afterAction: () => {
          calls.push('after');
        },
      },
    });
    await h.start();
    expect(calls).toEqual([]);
  });
});
