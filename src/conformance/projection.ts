/**
 * @floken-io/engine/conformance · `TaskProjection` 契约测试套件
 *
 * 契约来源：`ARCHITECTURE.md` §7.2（`TaskProjection`）/ §6.4（INV-15、INV-18）/ §9 T6；
 * `03-engine` §9.3、`AC-E12`。
 *
 * ═══════════════════════════════════════════════════════════════
 * ★ 为什么必须由宿主额外交一个 `readback`
 * ═══════════════════════════════════════════════════════════════
 * `TaskProjection` 只有 `apply()` / `sync()` —— **刻意没有读方法**：待办表是**宿主的表**，
 * 列怎么建、要不要分表、要不要加业务字段，全是宿主的决定（引擎只管吐 `TaskDelta`）。
 *
 * 但「`removed` 必须真删」这条判据**只有读一下才能验**。所以套件要求宿主提供
 * `readback(instanceId)`：**怎么读你自己的表，只有你知道**。这不是接口缺陷，
 * 而是那条边界（引擎不认识你的表）必须付出的代价。
 *
 * ═══════════════════════════════════════════════════════════════
 * ★ 头号静默错误：`removed` 被当成 `changed`（或干脆没实现）
 * ═══════════════════════════════════════════════════════════════
 * 只处理 `added` 的投影**看起来工作正常** —— 新增待办都出现了，页面也能点。
 * 症状要等到「或签一人通过后其余人的待办还在」被人投诉时才暴露，
 * 而那时流程已经跑了几百个实例。`AC-E12` 与 INV-15 就是为这条设的。
 *
 * ═══════════════════════════════════════════════════════════════
 * ★ 断言边界（诚实说明，**不是**遗漏）
 * ═══════════════════════════════════════════════════════════════
 * 只断言 `TaskView` 的**必填**字段（`taskId` / `instanceId` / `nodeId` / `assignee` /
 * `status` / `createdAt`）能原样读回。`nodeName` / `dueAt` / `formKey` 是否落库
 * **由宿主表结构决定**（比如不接 `Scheduler` 就完全可以不存 `dueAt`），
 * 套件不对它们提要求 —— 过强的断言会把宿主的合理设计判成失败。
 */
import { STATE_SCHEMA_VERSION } from '../core/state.js';
import type { ActionRecord, InstanceStateHeader } from '../core/state.js';
import type { TaskProjection } from '../core/spi.js';
import { assertTrue, assertDeepEqual, runConformanceCases, show } from './report.js';
import type { ConformanceReport } from './report.js';
import type { TaskDelta, TaskStatus, TaskView } from '../core/task.js';

/**
 * 宿主提供的「读自己的待办表」。
 * ⚠️ 顺序不作要求（套件内部按 `taskId` 归一），但**必须只返回该实例的行**。
 */
export type ProjectionReadback = (instanceId: string) => Promise<TaskView[]>;

export interface ProjectionConformanceOptions {
  /** 被测实现的自述（进报告抬头） */
  subject?: string;
  /** 实例 id 前缀（默认 `floken-conf`） */
  idPrefix?: string;
}

const TS = '2026-09-30T00:00:00.000Z';

let seq = 0;
/** 同 `store.ts`：唯一 id 只用于隔离，不参与判定 */
function uniqueId(prefix: string): string {
  seq += 1;
  return `${prefix}_p${seq.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function header(instanceId: string, rev: number): InstanceStateHeader {
  return {
    instanceId,
    processId: 'expense',
    definitionVersion: 1,
    status: 'running',
    rev,
    stateSchema: STATE_SCHEMA_VERSION,
    startedAt: TS,
    updatedAt: TS,
  };
}

function task(args: {
  instanceId: string;
  taskId: string;
  nodeId?: string;
  assignee?: string;
  status?: TaskStatus;
}): TaskView {
  return {
    taskId: args.taskId,
    instanceId: args.instanceId,
    nodeId: args.nodeId ?? 'Task_Approve',
    assignee: args.assignee ?? 'u_1',
    status: args.status ?? 'active',
    createdAt: TS,
  };
}

function delta(
  instanceId: string,
  over: {
    rev?: number;
    action?: ActionRecord;
    added?: TaskView[];
    removed?: string[];
    changed?: TaskView[];
  } = {},
): TaskDelta {
  const rev = over.rev ?? 1;
  return {
    rev,
    action: over.action ?? { name: 'approve', actor: 'u_1', at: TS },
    added: over.added ?? [],
    removed: over.removed ?? [],
    changed: over.changed ?? [],
    instance: header(instanceId, rev),
  };
}

/** 按 taskId 归一成 `Map` —— 投影返回顺序不是契约，但**幂等**是 */
function index(tasks: readonly TaskView[]): Map<string, TaskView> {
  return new Map(tasks.map((t) => [t.taskId, t]));
}

/** 必填字段逐项比对（可选字段不在契约内，见文件头「断言边界」） */
function assertSameTask(actual: TaskView | undefined, expected: TaskView, what: string): void {
  assertTrue(actual !== undefined, `${what}：taskId=${expected.taskId} 读不回来（可能被误当成 removed？）`);
  assertDeepEqual(
    {
      taskId: actual.taskId,
      instanceId: actual.instanceId,
      nodeId: actual.nodeId,
      assignee: actual.assignee,
      status: actual.status,
      createdAt: actual.createdAt,
    },
    {
      taskId: expected.taskId,
      instanceId: expected.instanceId,
      nodeId: expected.nodeId,
      assignee: expected.assignee,
      status: expected.status,
      createdAt: expected.createdAt,
    },
    what,
  );
}

/** 断言「读回来的行集合，恰好是这些」 */
function assertRows(
  actual: readonly TaskView[],
  expected: readonly TaskView[],
  what: string,
): void {
  const got = index(actual);
  const want = index(expected);
  assertDeepEqual(
    [...got.keys()].sort(),
    [...want.keys()].sort(),
    `${what}（可见 taskId 集合）`,
  );
  for (const t of want.values()) assertSameTask(got.get(t.taskId), t, what);
}

// ═══════════════════════════════════════════════════════════════
// 套件正文
// ═══════════════════════════════════════════════════════════════

/**
 * 跑 `TaskProjection` 全量契约用例。
 *
 * @param projection 被测投影实现
 * @param readback   宿主提供的「读自己的待办表」（见文件头说明）；**必须**只返回该实例的行
 */
export async function runProjectionConformance(
  projection: TaskProjection,
  readback: ProjectionReadback,
  options: ProjectionConformanceOptions = {},
): Promise<ConformanceReport> {
  const prefix = options.idPrefix ?? 'floken-conf';
  const newId = (): string => uniqueId(prefix);

  return runConformanceCases('projection', options.subject, [
    [
      'apply 增行：added 每行都能按 taskId 读回，必填字段一致',
      ['§7.2'],
      async () => {
        const id = newId();
        const a = task({ instanceId: id, taskId: 'T_a', assignee: 'u_1' });
        const b = task({ instanceId: id, taskId: 'T_b', assignee: 'u_2' });
        await projection.apply(id, delta(id, { added: [a, b] }));
        assertRows(await readback(id), [a, b], 'apply 后的待办');
      },
    ],
    [
      'apply 幂等：同一 delta 连续两次 → 待办集合不变（AC-E12）',
      ['AC-E12', 'INV-15'],
      async () => {
        const id = newId();
        const a = task({ instanceId: id, taskId: 'T_a' });
        const b = task({ instanceId: id, taskId: 'T_b' });
        const d = delta(id, { added: [a, b] });
        // 引擎产出的 delta 是纯数据 —— 投影**不得就地改它**（否则会污染引擎手里那份）
        const before = JSON.stringify(d);

        await projection.apply(id, d);
        const once = await readback(id);
        await projection.apply(id, d);
        const twice = await readback(id);

        assertRows(once, [a, b], '首次 apply');
        assertRows(twice, [a, b], '重复 apply');
        assertDeepEqual(twice.length, once.length, '重复 apply 后的行数（不得翻倍）');
        assertTrue(JSON.stringify(d) === before, '投影不得修改传入的 delta（应视为只读）');
      },
    ],
    [
      'apply 真删：removed 里的 taskId 必须查不到（INV-15 · 头号静默错误）',
      ['INV-15', 'AC-E12'],
      async () => {
        const id = newId();
        const a = task({ instanceId: id, taskId: 'T_a' });
        const b = task({ instanceId: id, taskId: 'T_b' });
        await projection.apply(id, delta(id, { added: [a, b] }));

        await projection.apply(id, delta(id, { rev: 2, removed: ['T_a'] }));

        const rows = await readback(id);
        assertTrue(
          !index(rows).has('T_a'),
          `removed 里的 taskId 仍能读到 —— 投影没实现真删（读回 ${show(rows.map((t) => t.taskId))}）`,
        );
        assertRows(rows, [b], '删除后的待办');
      },
    ],
    [
      '同一 delta 内 added 与 removed 并存：两者都生效',
      ['INV-15'],
      async () => {
        const id = newId();
        const oldTask = task({ instanceId: id, taskId: 'T_old' });
        await projection.apply(id, delta(id, { added: [oldTask] }));

        const fresh = task({ instanceId: id, taskId: 'T_new', assignee: 'u_9' });
        await projection.apply(
          id,
          delta(id, { rev: 2, added: [fresh], removed: ['T_old'] }),
        );

        assertRows(await readback(id), [fresh], '混合 delta 后的待办');
      },
    ],
    [
      'changed 生效：状态被更新，而不是被忽略',
      ['§7.2', 'AC-E12'],
      async () => {
        const id = newId();
        const active = task({ instanceId: id, taskId: 'T_a', status: 'active' });
        await projection.apply(id, delta(id, { added: [active] }));

        const done: TaskView = { ...active, status: 'done' };
        await projection.apply(id, delta(id, { rev: 2, changed: [done] }));

        assertRows(await readback(id), [done], 'changed 后的待办');
      },
    ],
    [
      '空 delta：不得产生任何副作用',
      ['§6.2'],
      async () => {
        const id = newId();
        const a = task({ instanceId: id, taskId: 'T_a' });
        await projection.apply(id, delta(id, { added: [a] }));
        const before = await readback(id);

        await projection.apply(id, delta(id, { rev: 2 }));

        assertRows(await readback(id), before, '空 delta 后的待办');
      },
    ],
    [
      'sync 全量对账：读回与传入 tasks 一致，多余行被清理（INV-18）',
      ['INV-18'],
      async () => {
        const id = newId();
        // 先造出"漂移"：两条本该被删的行留在表里
        await projection.apply(
          id,
          delta(id, {
            added: [
              task({ instanceId: id, taskId: 'T_stale1' }),
              task({ instanceId: id, taskId: 'T_stale2' }),
            ],
          }),
        );

        const truth = task({ instanceId: id, taskId: 'T_truth', assignee: 'u_7' });
        await projection.sync(id, [truth]);

        assertRows(
          await readback(id),
          [truth],
          'sync 后的待办（"全量对账"= 以传入列表为准：多余行必须清掉，否则补做等于没做）',
        );
      },
    ],
    [
      'sync 传空数组 → 该实例待办清空',
      ['INV-18'],
      async () => {
        const id = newId();
        await projection.apply(id, delta(id, { added: [task({ instanceId: id, taskId: 'T_a' })] }));
        await projection.sync(id, []);
        assertRows(await readback(id), [], 'sync 空列表后的待办');
      },
    ],
    [
      '跨实例隔离：apply 一个实例不得影响另一个',
      ['§7.2'],
      async () => {
        const idA = newId();
        const idB = newId();
        const a = task({ instanceId: idA, taskId: 'T_a' });
        const b = task({ instanceId: idB, taskId: 'T_b' });
        await projection.apply(idA, delta(idA, { added: [a] }));
        await projection.apply(idB, delta(idB, { added: [b] }));

        assertRows(await readback(idA), [a], '实例 A 的待办');
        assertRows(await readback(idB), [b], '实例 B 的待办');
      },
    ],
  ]);
}
