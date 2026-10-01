/**
 * T6 · 契约测试套件自身的验收。
 *
 * ═══════════════════════════════════════════════════════════════
 * ★ 这个文件里最值钱的不是"正向全绿"，而是**反向验收**
 * ═══════════════════════════════════════════════════════════════
 * 一个只会对着正确实现点头的套件**毫无价值** —— 它和 `expect(true).toBe(true)` 等价，
 * 却让人以为"验过了"。所以这里故意写了**五个**有特定缺陷的假实现：
 *
 * | 假实现 | 缺陷 | 它模拟的真实事故 |
 * |---|---|---|
 * | `createSilentOverwriteStore()` | 把 `expectedRev` 当提示而非约束 | 两个并发审批都"成功"，后者抹掉前者 → **少了一次审批，且没有任何报错** |
 * | `createAliasingStore()` | 存引用 / 交引用 | 宿主改一下手里那个对象，就改到了"已提交状态" → **连 CAS 都失效** |
 * | `createForgetfulProjection()` | 只处理 `added` / `changed` | 或签一人通过后其余人的待办还在 → 要等**用户投诉**才发现 |
 * | `createVersionBlindSource()` | `getDefinition` **不看 `version`** | 在途实例跑到发起时**还不存在的节点**上 → 「昨天发起的单子今天忽然多出一个审批人」（AC-E10 头号事故） |
 * | `createThrowingSource()` | 取不到就**抛错**而非返回 `null` | 引擎分不清「这一版没有」与「定义库挂了」→ 错误契约失守 |
 *
 * 每个假实现都断言：**套件必须点名抓出它那一条**（而不是笼统地 `ok === false`）。
 * 这样将来有人"为了让套件跑绿"而放宽某条判据时，这里会立刻变红。
 *
 * ⚠️ 正向部分用 `createMemoryStore()` / `test/helpers/memory-projection.ts` 作为**被检对象** ——
 * 套件若没有正确实现可跑，就无法区分"套件写错了"和"实现错了"。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  formatConformanceReport,
  runDefinitionConformance,
  runProjectionConformance,
  runStoreConformance,
} from '../src/entries/conformance';
import type { ConformanceReport, DefinitionFixture } from '../src/entries/conformance';
import { persistAlreadyExists, persistConflict } from '../src/core/errors';
import type { DefinitionSource, StateStore, TaskProjection } from '../src/core/spi';
import type { InstanceState } from '../src/core/state';
import type { TaskDelta, TaskView } from '../src/core/task';
import { createMemoryStore } from '../src/store/memory';
import { makeDefinition, mapSource, userApproval } from './helpers/definition';
import type { ProcessDefinition } from '@floken-io/moddle';
import { createMemoryProjection } from './helpers/memory-projection';

// ═══════════════════════════════════════════════════════════════
// 假实现（三个"坏样本"）
// ═══════════════════════════════════════════════════════════════

/**
 * ✗ 把 `expectedRev` 当**提示**：永远写入成功，从不抛冲突。
 * CAS 在这里退化成"最后写入者赢"，而且是**静默的**。
 */
function createSilentOverwriteStore(): StateStore {
  const rows = new Map<string, string>(); // 存 JSON 串 → 深拷贝天然成立，把缺陷隔离在「冲突」这一维
  return {
    async load(id: string): Promise<InstanceState | null> {
      const raw = rows.get(id);
      return raw === undefined ? null : (JSON.parse(raw) as InstanceState);
    },
    async save(next: InstanceState, expectedRev: number): Promise<void> {
      // ✗ 忽略了"写入前必须校验 expectedRev 是否命中"
      const rev = expectedRev === 0 ? 1 : expectedRev + 1;
      rows.set(next.instanceId, JSON.stringify({ ...next, rev }));
    },
  };
}

/**
 * ✗ CAS 逻辑是对的，但**两侧都不拷贝**：`load()` 交出内部对象、`save()` 浅存引用。
 * 这个缺陷最阴 —— 单线程单次调用下完全看不出问题。
 */
function createAliasingStore(): StateStore {
  const rows = new Map<string, InstanceState>();
  return {
    async load(id: string): Promise<InstanceState | null> {
      return rows.get(id) ?? null; // ✗ 交出引用
    },
    async save(next: InstanceState, expectedRev: number): Promise<void> {
      const current = rows.get(next.instanceId);
      if (expectedRev === 0) {
        if (current !== undefined) throw persistAlreadyExists(next.instanceId);
        rows.set(next.instanceId, { ...next, rev: 1 }); // ✗ 浅拷贝 → next.variables 仍被共享
        return;
      }
      if (current === undefined) throw persistConflict(next.instanceId, expectedRev);
      if (current.rev !== expectedRev) {
        throw persistConflict(next.instanceId, expectedRev, current.rev);
      }
      rows.set(next.instanceId, { ...next, rev: expectedRev + 1 }); // ✗ 浅拷贝
    },
  };
}

/**
 * ✗ 只处理 `added` / `changed`，`removed` 被当成"以后再说"。
 * 这是 `INV-15` 点名的**头号静默错误** —— 页面看起来完全正常。
 */
function createForgetfulProjection(): {
  projection: TaskProjection;
  list: (instanceId: string) => Promise<TaskView[]>;
} {
  const tables = new Map<string, Map<string, TaskView>>();
  const table = (id: string): Map<string, TaskView> => {
    let t = tables.get(id);
    if (t === undefined) {
      t = new Map<string, TaskView>();
      tables.set(id, t);
    }
    return t;
  };
  const clone = (t: TaskView): TaskView => JSON.parse(JSON.stringify(t)) as TaskView;

  return {
    projection: {
      async apply(instanceId: string, delta: TaskDelta): Promise<void> {
        const t = table(instanceId);
        // ✗ 这里**没有** `for (const taskId of delta.removed) t.delete(taskId)`
        for (const v of delta.added) t.set(v.taskId, clone(v));
        for (const v of delta.changed) t.set(v.taskId, clone(v));
      },
      async sync(instanceId: string, tasks: TaskView[]): Promise<void> {
        const next = new Map<string, TaskView>();
        for (const v of tasks) next.set(v.taskId, clone(v));
        tables.set(instanceId, next);
      },
    },
    list: async (instanceId: string): Promise<TaskView[]> =>
      [...table(instanceId).values()].map(clone),
  };
}

// ═══════════════════════════════════════════════════════════════
// ★ `DefinitionSource` 的两个坏实现（T19 · AC-E10）
// ═══════════════════════════════════════════════════════════════

/** 同一 `processId` 的 v1 / v2：第二个节点的 id 不同 —— 这就是「version 有没有被用上」的观测点 */
function expenseV(version: 1 | 2): ProcessDefinition {
  const taskId = version === 1 ? 'Task_v1' : 'Task_v2';
  return makeDefinition({
    id: `Definitions_expense_v${version}`,
    version,
    processId: 'expense',
    nodes: [
      { id: 'Start_1', type: 'startEvent' },
      {
        id: taskId,
        type: 'userTask',
        name: `审批 v${version}`,
        approval: userApproval(version === 1 ? 'u_1' : 'u_2'),
      },
      { id: 'End_1', type: 'endEvent' },
    ],
    flows: [
      { from: 'Start_1', to: taskId },
      { from: taskId, to: 'End_1' },
    ],
  });
}

/**
 * ✗ **忽略 `version` 参数** —— 永远返回最新版。
 * 这是 `AC-E10` 的头号事故：在途实例会跑到它发起时**还不存在的节点**上，且没有任何报错。
 */
function createVersionBlindSource(latest: ProcessDefinition): DefinitionSource {
  return {
    async getDefinition(processId: string): Promise<ProcessDefinition | null> {
      // ✗ 第二个参数压根没接 —— 于是 v1 / v2 / v99 全都返回同一份
      return processId === 'expense' ? latest : null;
    },
  };
}

/**
 * ✗ 取不到就**抛错**而不是返回 `null` —— 引擎分不清「这一版没有」与「仓库挂了」，
 * `AC-E10` 的错误契约（统一翻成 `ENGINE_STATE_DEFINITION_MISSING`）当场失守。
 */
function createThrowingSource(entries: Readonly<Record<string, ProcessDefinition>>): DefinitionSource {
  return {
    async getDefinition(processId: string, version: number): Promise<ProcessDefinition | null> {
      const def = entries[`${processId}@${version}`];
      // ✗ 该返回 null 的地方抛了宿主的自定义错
      if (def === undefined) throw new Error(`definition ${processId}@${version} not found`);
      return def;
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// 正向：官方实现跑套件（顶层 await —— 用例名要在收集阶段就确定）
// ═══════════════════════════════════════════════════════════════

const memoryProjection = createMemoryProjection();

const storeReport: ConformanceReport = await runStoreConformance(createMemoryStore(), {
  subject: 'createMemoryStore()',
});
const projectionReport: ConformanceReport = await runProjectionConformance(
  memoryProjection,
  (id) => memoryProjection.list(id),
  { subject: 'test/helpers/memory-projection' },
);

// ★ `DefinitionSource` 套件要宿主先声明「库里这一格长这样」（定义是业务资产，套件造不出来）
const definitionEntries: Record<string, ProcessDefinition> = {
  'expense@1': expenseV(1),
  'expense@2': expenseV(2),
};
const definitionFixtures: readonly DefinitionFixture[] = [
  { processId: 'expense', version: 1, definition: expenseV(1) },
  { processId: 'expense', version: 2, definition: expenseV(2) },
];
const definitionReport: ConformanceReport = await runDefinitionConformance(
  mapSource(definitionEntries),
  definitionFixtures,
  { subject: 'test: mapSource（两个版本）' },
);

// 断言 = 规格说明书：把结论打出来，人扫一眼就知道覆盖了哪几条契约
console.log(formatConformanceReport(storeReport));
console.log(formatConformanceReport(projectionReport));
console.log(formatConformanceReport(definitionReport));

describe('契约测试套件 · 正向：官方实现必须全绿', () => {
  it('store 套件覆盖足够多判据（防止套件被改空后静默通过）', () => {
    expect(storeReport.total).toBeGreaterThanOrEqual(13);
  });

  it('projection 套件覆盖足够多判据', () => {
    expect(projectionReport.total).toBeGreaterThanOrEqual(9);
  });

  it('definition 套件覆盖足够多判据（AC-E10 的四条版本语义）', () => {
    expect(definitionReport.total).toBeGreaterThanOrEqual(7);
  });

  it('每条用例都标了规格锚点（否则失败时无法回溯到规范）', () => {
    const missing = [...storeReport.cases, ...projectionReport.cases, ...definitionReport.cases]
      .filter((c) => c.refs.length === 0)
      .map((c) => c.name);
    expect(missing).toEqual([]);
  });

  it('报告计数自洽（total = passed + failed，ok ≡ failed === 0）', () => {
    for (const r of [storeReport, projectionReport, definitionReport]) {
      expect(r.total).toBe(r.passed + r.failed);
      expect(r.ok).toBe(r.failed === 0);
      expect(r.cases.length).toBe(r.total);
    }
  });

  for (const c of storeReport.cases) {
    it(`store · ${c.name}${c.refs.length > 0 ? ` [${c.refs.join(' ')}]` : ''}`, () => {
      expect(c.error).toBeUndefined();
    });
  }

  for (const c of projectionReport.cases) {
    it(`projection · ${c.name}${c.refs.length > 0 ? ` [${c.refs.join(' ')}]` : ''}`, () => {
      expect(c.error).toBeUndefined();
    });
  }

  for (const c of definitionReport.cases) {
    it(`definition · ${c.name}${c.refs.length > 0 ? ` [${c.refs.join(' ')}]` : ''}`, () => {
      expect(c.error).toBeUndefined();
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// ★ 反向验收：套件必须能抓静默错误
// ═══════════════════════════════════════════════════════════════

const failingNames = (report: ConformanceReport): string =>
  report.cases.filter((c) => !c.ok).map((c) => c.name).join('\n');

describe('契约测试套件 · 反向验收：能抓出静默错误', () => {
  it('「不抛冲突」的 store 会被抓出（AC-E11 / INV-1）', async () => {
    const report = await runStoreConformance(createSilentOverwriteStore(), {
      subject: 'broken: 忽略 expectedRev（静默覆盖）',
    });
    expect(report.ok).toBe(false);

    const names = failingNames(report);
    // 必须点名到"冲突没抛"这一条，而不是笼统地红
    expect(names).toContain('PERSIST_ALREADY_EXISTS');
    expect(names).toContain('PERSIST_CONFLICT');
    expect(names).toContain('并发同 rev 的两个 save');
    // 缺陷只在「冲突」这一维：happy path 必须仍然通过，否则说明套件与缺陷无关地乱红
    expect(report.cases.find((c) => c.name.includes('INSERT 后完整内容'))?.ok).toBe(true);
  });

  it('「两侧存引用」的 store 会被抓出（隔离性）', async () => {
    const report = await runStoreConformance(createAliasingStore(), {
      subject: 'broken: load/save 不深拷贝（存引用）',
    });
    expect(report.ok).toBe(false);

    const names = failingNames(report);
    expect(names).toContain('load() 交出副本');
    expect(names).toContain('save() 存入副本');
    // CAS 两维是对的，所以不该因为隔离性缺陷而误红
    expect(report.cases.find((c) => c.name.includes('CAS 成功'))?.ok).toBe(true);
  });

  it('★ 「忽略 version 参数」的 source 会被抓出（AC-E10 头号事故）', async () => {
    const report = await runDefinitionConformance(
      createVersionBlindSource(expenseV(2)),
      definitionFixtures,
      { subject: 'broken: getDefinition 不看 version（永远返回最新版）' },
    );
    expect(report.ok).toBe(false);

    const names = failingNames(report);
    // 必须点名到"版本没被用上"这一条，而不是笼统地红
    expect(names).toContain('不同 version 返回不同内容');
    expect(names).toContain('未知 version');
    // 缺陷只在「version」这一维：未知 processId 仍返回 null，不该被误判
    expect(report.cases.find((c) => c.name.includes('未知 processId'))?.ok).toBe(true);
  });

  it('★ 「取不到就抛错」的 source 会被抓出（应返回 null，让引擎翻成 DEFINITION_MISSING）', async () => {
    const report = await runDefinitionConformance(createThrowingSource(definitionEntries), definitionFixtures, {
      subject: 'broken: 未知 (pid, version) 抛错而非返回 null',
    });
    expect(report.ok).toBe(false);

    const names = failingNames(report);
    expect(names).toContain('未知 processId');
    expect(names).toContain('未知 version');
    // 已存在的格子取回是对的 —— 红得**精准**，不是"反正它错了就全红"
    expect(report.cases.find((c) => c.name.includes('逐版本精确命中'))?.ok).toBe(true);
  });

  it('「忽略 removed」的 projection 会被抓出（INV-15 · 头号静默错误）', async () => {
    const broken = createForgetfulProjection();
    const report = await runProjectionConformance(broken.projection, broken.list, {
      subject: 'broken: 忽略 delta.removed',
    });
    expect(report.ok).toBe(false);

    const names = failingNames(report);
    expect(names).toContain('apply 真删');
    expect(names).toContain('added 与 removed 并存');
    // 其余维度（增行 / 幂等 / sync / 隔离）应当仍然通过 —— 证明红得**精准**
    expect(report.cases.find((c) => c.name.includes('apply 幂等'))?.ok).toBe(true);
    expect(report.cases.find((c) => c.name.includes('sync 全量对账'))?.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 套件自身的两条硬约束
// ═══════════════════════════════════════════════════════════════

describe('契约测试套件 · 自身约束', () => {
  it('conformance/ 不得依赖任何测试框架，也不得用 node: 内置模块（它随包发布，宿主 runner 自选）', () => {
    const dir = new URL('../src/conformance/', import.meta.url);
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => e.name);

    expect(files.length).toBeGreaterThanOrEqual(4); // store / projection / definition / report
    for (const name of files) {
      const src = readFileSync(new URL(name, dir), 'utf8');
      // ⚠️ 先剔除**注释行**再判：套件正文里恰恰在**解释**为什么不能 import vitest，
      //    不剔注释的话这条守卫会把自己的说明文字当成依赖（本用例第一次跑就踩了）。
      const code = src
        .split('\n')
        .filter((l) => {
          const t = l.trim();
          return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
        })
        .join('\n');

      expect(code, `${name} 引入了测试框架`).not.toMatch(
        /from\s+['"](vitest|jest|@jest\/globals|mocha|ava|jasmine|node:test)['"]/,
      );
      expect(code, `${name} 引入了 node: 内置模块（浏览器端将不可用）`).not.toMatch(
        /from\s+['"]node:/,
      );
    }
  });

  it('公开面 = 4 个运行时导出（防 `export *` 把内部断言工具变成契约）', async () => {
    const mod = await import('../src/entries/conformance');
    expect(Object.keys(mod).sort()).toEqual([
      'formatConformanceReport',
      'runDefinitionConformance',
      'runProjectionConformance',
      'runStoreConformance',
    ]);
  });
});
