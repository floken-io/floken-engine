/**
 * @floken-io/engine/conformance · `StateStore` 契约测试套件
 *
 * 契约来源：`ARCHITECTURE.md` §7.2（`StateStore`）/ §6.4（INV-1）/ §9 T5~T6；
 * `03-engine` §9.1~§9.2、`AC-E11`。
 *
 * ═══════════════════════════════════════════════════════════════
 * 宿主怎么用（这一段就是它的全部用法）
 * ═══════════════════════════════════════════════════════════════
 * ```ts
 * import { runStoreConformance, formatConformanceReport } from '@floken-io/engine/conformance';
 *
 * const report = await runStoreConformance(createMyPostgresStore(), { subject: 'pg-jsonb' });
 * console.log(formatConformanceReport(report));
 * if (!report.ok) throw new Error(`${report.failed} 条契约未兑现`);
 * ```
 * 每个 `it()` 的粒度由你定 —— 套件只是把「哪条契约没兑现」拆成了一个数组。
 *
 * ═══════════════════════════════════════════════════════════════
 * ★ 它到底在抓什么（宿主自研实现的两类静默错误）
 * ═══════════════════════════════════════════════════════════════
 * `StateStore` 只有两个方法，正因为门槛低，**写错的方式都很安静**：
 *
 * - **静默覆盖**：`expectedRev` 被忽略，直接 `UPDATE ... WHERE id = ?` 或 `set()`
 *   → 两个并发审批都"成功"，后者把前者抹掉。流程没报错，只是**少了一次审批**。
 *   行业里那个 `WHERE rev = ?` + 判定影响行数 0 的写法，就是为了让这件事变成**报错**。
 * - **存引用**：`load()` 直接返回内部对象、`save()` 直接存调用方的对象
 *   → 宿主手一抖改了手里那个，就改到了「已提交状态」。**连 CAS 都会失效**（比的就是 `rev`）。
 *
 * 所以本套件的重点不是"happy path 能存能取"，而是 **失败路径** 与 **隔离性**。
 */
import { ENGINE_ERROR_CODES } from '../core/errors.js';
import type { StateStore } from '../core/spi.js';
import { STATE_SCHEMA_VERSION } from '../core/state.js';
import type { InstanceState, InstanceStatus } from '../core/state.js';
import {
  assertDeepEqual,
  assertEngineErrorValue,
  assertTrue,
  catchEngineError,
  runConformanceCases,
  show,
} from './report.js';
import type { ConformanceReport } from './report.js';

export interface StoreConformanceOptions {
  /** 被测实现的自述（进报告抬头，便于区分多套实现） */
  subject?: string;
  /** 实例 id 前缀，便于在 SQL 里定位这些行（默认 `floken-conf`） */
  idPrefix?: string;
}

// ═══════════════════════════════════════════════════════════════
// 假数据构造（★ 只造**合法**状态，套件不负责定义合法性）
// ═══════════════════════════════════════════════════════════════

const TS = '2026-09-30T00:00:00.000Z';

let seq = 0;
/**
 * 生成唯一 `instanceId`。
 *
 * ★ 这是套件**唯一**的"外部输入"：有了它，用例之间天然隔离，于是
 * `runStoreConformance(store)` 不必要求宿主提供工厂、也不必给 `StateStore` 加 `clear()`
 * （后者会破坏"内存实现门槛 ~20 行"这条底线，见 §7.2）。
 * `Math.random()` 只用于**唯一性**，不参与任何判定。
 */
function uniqueId(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 只列会被用例改动的字段 —— 比 `Partial<InstanceState>` 更窄，避免误传半合法状态 */
interface StateOverrides {
  status?: InstanceStatus;
  businessKey?: string;
  rev?: number;
  variables?: Record<string, unknown>;
}

function makeState(instanceId: string, over: StateOverrides = {}): InstanceState {
  return {
    instanceId,
    processId: 'expense',
    definitionVersion: 1,
    status: over.status ?? 'running',
    rev: over.rev ?? 0,
    stateSchema: STATE_SCHEMA_VERSION,
    startedAt: TS,
    updatedAt: TS,
    ...(over.businessKey === undefined ? {} : { businessKey: over.businessKey }),
    tokens: [{ id: `${instanceId}::t1`, nodeId: 'Task_Approve', state: 'active', assignee: 'u_1' }],
    completedNodes: [],
    variables: over.variables ?? { amount: 100 },
    auditTrail: [{ seq: 1, at: TS, actor: 'u_1', action: 'start' }],
  };
}

const conflict = ENGINE_ERROR_CODES.PERSIST_CONFLICT;
const exists = ENGINE_ERROR_CODES.PERSIST_ALREADY_EXISTS;

// ═══════════════════════════════════════════════════════════════
// 套件正文
// ═══════════════════════════════════════════════════════════════

/**
 * 跑 `StateStore` 全量契约用例。
 *
 * 前置：传入的 `store` 可用即可 —— **不需要是空的**（用例各自用唯一 id）。
 */
export async function runStoreConformance(
  store: StateStore,
  options: StoreConformanceOptions = {},
): Promise<ConformanceReport> {
  const prefix = options.idPrefix ?? 'floken-conf';
  const newId = (): string => uniqueId(prefix);

  return runConformanceCases('store', options.subject, [
    // ── 读路径 ──
    [
      'load 未知 id 返回 null（不得抛错）',
      ['§7.2'],
      async () => {
        const got = await store.load(newId());
        assertTrue(got === null, `期望 null，实得 ${show(got)}`);
      },
    ],

    // ── INSERT 路径 ──
    [
      'INSERT：expectedRev === 0 成功，且 rev 被归一化为 1（不信任 next.rev）',
      ['INV-1', 'AC-E11'],
      async () => {
        // ★ 故意在 next 里塞一个假 rev —— 存储层必须无视它
        const s = makeState(newId(), { rev: 999 });
        await store.save(s, 0);
        const got = await store.load(s.instanceId);
        assertTrue(got !== null, 'INSERT 后 load 返回 null');
        assertDeepEqual(
          got.rev,
          1,
          'INSERT 后的 rev（存储层须按 expectedRev+1 归一化，与 SQL 的 SET rev = rev + 1 同构）',
        );
      },
    ],
    [
      'INSERT 后完整内容可按 id 读回（除 rev 外逐字段深等）',
      ['§7.2'],
      async () => {
        const s = makeState(newId(), { businessKey: 'BK_1' });
        await store.save(s, 0);
        const got = await store.load(s.instanceId);
        assertTrue(got !== null, 'INSERT 后 load 返回 null');
        assertDeepEqual({ ...got, rev: 0 }, { ...s, rev: 0 }, '读回内容');
      },
    ],

    // ── 隔离性（内存与 SQL 都必须成立，实现机制不同） ──
    [
      'load() 交出副本：宿主改动手里那份不得泄漏进已提交状态',
      ['§9 T5'],
      async () => {
        const s = makeState(newId());
        await store.save(s, 0);

        const first = await store.load(s.instanceId);
        assertTrue(first !== null, 'load 返回 null');
        first.status = 'terminated';
        first.variables.leak = true;

        const second = await store.load(s.instanceId);
        assertTrue(second !== null, 'load 返回 null');
        assertTrue(
          second.status === 'running',
          `load() 未交出副本：宿主的改动泄漏进了库（status 实得 ${second.status}）`,
        );
        assertTrue(
          second.variables.leak === undefined,
          `load() 未做深拷贝：嵌套字段被泄漏（variables.leak 实得 ${show(second.variables.leak)}）`,
        );
      },
    ],
    [
      'save() 存入副本：save 之后改 next 不得影响已提交状态',
      ['§9 T5'],
      async () => {
        const s = makeState(newId(), { businessKey: 'BK_ORIGINAL' });
        await store.save(s, 0);

        // save 返回后宿主持有的就是那个 next —— 它必须已经和库里脱钩
        s.businessKey = 'BK_MUTATED_AFTER_SAVE';
        s.variables.amount = 999;

        const got = await store.load(s.instanceId);
        assertTrue(got !== null, 'load 返回 null');
        assertTrue(
          got.businessKey === 'BK_ORIGINAL',
          `save() 存了引用而非副本（businessKey 实得 ${show(got.businessKey)}）`,
        );
        assertTrue(
          got.variables.amount === 100,
          `save() 未做深拷贝：嵌套字段被改（variables.amount 实得 ${show(got.variables.amount)}）`,
        );
      },
    ],
    [
      'load() 返回值 JSON 往返深等（INV-14：库内只允许纯数据）',
      ['INV-14', 'AC-E8'],
      async () => {
        const s = makeState(newId());
        await store.save(s, 0);
        const got = await store.load(s.instanceId);
        assertTrue(got !== null, 'load 返回 null');
        assertDeepEqual(JSON.parse(JSON.stringify(got)), got, 'JSON 往返');
      },
    ],

    // ── INSERT 冲突 ──
    [
      '重复 INSERT 抛 PERSIST_ALREADY_EXISTS，且不覆盖原记录、不消费 rev',
      ['AC-E11'],
      async () => {
        const first = makeState(newId(), { businessKey: 'BK_1' });
        await store.save(first, 0);

        const second = makeState(first.instanceId, { businessKey: 'BK_2' });
        await catchEngineError(
          () => store.save(second, 0),
          exists,
          '同 id 二次 INSERT',
        );

        const got = await store.load(first.instanceId);
        assertTrue(got !== null, 'load 返回 null');
        assertTrue(
          got.businessKey === 'BK_1',
          `ALREADY_EXISTS 之后原记录被覆盖（businessKey 实得 ${show(got.businessKey)}）`,
        );
        assertTrue(got.rev === 1, `失败路径不得消费 rev（实得 ${got.rev}）`);
      },
    ],

    // ── CAS 路径 ──
    [
      'CAS 成功：expectedRev 命中 → 写入生效且 rev 恰好 +1',
      ['INV-1', 'AC-E11'],
      async () => {
        const s = makeState(newId());
        await store.save(s, 0); // rev 1

        // ★ next.rev 仍是 0（陈旧）—— 存储层必须无视它、按 expectedRev+1 写
        await store.save({ ...s, businessKey: 'BK_2' }, 1);

        const got = await store.load(s.instanceId);
        assertTrue(got !== null, 'load 返回 null');
        assertTrue(got.rev === 2, `CAS 后 rev 应为 2（实得 ${got.rev}）`);
        assertTrue(
          got.businessKey === 'BK_2',
          `CAS 内容未生效（businessKey 实得 ${show(got.businessKey)}）`,
        );
      },
    ],
    [
      'CAS 失败（rev 落后）抛 PERSIST_CONFLICT，且库内 rev 与内容都不变',
      ['INV-1', 'AC-E11'],
      async () => {
        const s = makeState(newId());
        await store.save(s, 0); // rev 1
        await store.save({ ...s, businessKey: 'BK_2' }, 1); // rev 2

        const err = await catchEngineError(
          () => store.save({ ...s, businessKey: 'BK_STALE' }, 1),
          conflict,
          '落后 rev 的 CAS',
        );
        assertDeepEqual(err.details?.actualRev, 2, 'details.actualRev');

        const got = await store.load(s.instanceId);
        assertTrue(got !== null, 'load 返回 null');
        assertTrue(got.rev === 2, `CONFLICT 后 rev 不得变（实得 ${got.rev}）`);
        assertTrue(
          got.businessKey === 'BK_2',
          `CONFLICT 后内容不得变（businessKey 实得 ${show(got.businessKey)}）`,
        );
      },
    ],
    [
      'CAS 失败（rev 超前）同样抛 PERSIST_CONFLICT（不得当成成功）',
      ['INV-1', 'AC-E11'],
      async () => {
        const s = makeState(newId());
        await store.save(s, 0); // rev 1

        const err = await catchEngineError(
          () => store.save({ ...s, businessKey: 'BK_AHEAD' }, 5),
          conflict,
          '超前 rev 的 CAS',
        );
        assertDeepEqual(err.details?.actualRev, 1, 'details.actualRev');

        const got = await store.load(s.instanceId);
        assertTrue(got !== null, 'load 返回 null');
        assertTrue(got.rev === 1, `CONFLICT 后 rev 不得变（实得 ${got.rev}）`);
      },
    ],
    [
      '实例不存在 + expectedRev > 0 → 抛 PERSIST_CONFLICT（且不建行、details 无 actualRev）',
      ['INV-1', 'AC-E11'],
      async () => {
        const s = makeState(newId());
        const err = await catchEngineError(
          () => store.save(s, 3),
          conflict,
          '未知实例的 CAS',
        );
        // `actualRev` 键的**存在性**就是"库里有没有这一行"的表达（§7.2）
        assertTrue(
          !('actualRev' in (err.details ?? {})),
          `实例不存在时 details 不应带 actualRev（实得 ${show(err.details)}）`,
        );
        assertTrue((await store.load(s.instanceId)) === null, 'CONFLICT 不得顺带建行');
      },
    ],
    [
      '并发同 rev 的两个 save：恰一胜一败（CAS 原子性，NFR-E5）',
      ['INV-1', 'NFR-E5'],
      async () => {
        const s = makeState(newId());
        await store.save(s, 0); // rev 1

        const results = await Promise.allSettled([
          store.save({ ...s, businessKey: 'A' }, 1),
          store.save({ ...s, businessKey: 'B' }, 1),
        ]);

        const won = results.filter((r) => r.status === 'fulfilled').length;
        const lost = results.filter((r) => r.status === 'rejected').length;
        assertTrue(
          won === 1 && lost === 1,
          `同一 rev 的并发 save 必须恰一胜一败（实得 ${won} 胜 ${lost} 败）—— 全胜 = 静默覆盖`,
        );

        const rejected = results.find((r) => r.status === 'rejected');
        assertTrue(rejected !== undefined, '没有失败的 save');
        assertEngineErrorValue(rejected.reason, conflict, '并发 save 的败者');

        const got = await store.load(s.instanceId);
        assertTrue(got !== null, 'load 返回 null');
        assertTrue(got.rev === 2, `CAS 只应发生一次，rev 应为 2（实得 ${got.rev}）`);
        const winner = results[0]?.status === 'fulfilled' ? 'A' : 'B';
        assertTrue(
          got.businessKey === winner,
          `库内应为胜者的内容（期望 ${winner}，实得 ${show(got.businessKey)}）`,
        );
      },
    ],

    // ── 写入前置校验 ──
    [
      '写入非纯数据必须抛错，且不污染库（AC-E8 / INV-14）',
      ['AC-E8', 'INV-14'],
      async () => {
        const s = makeState(newId());
        const dirty = { ...s, variables: { bad: () => 1 } } as unknown as InstanceState;
        await catchEngineError(() => store.save(dirty, 0), 'ENGINE_STATE_SHAPE_INVALID', '写入含函数的 state');
        assertTrue(
          (await store.load(s.instanceId)) === null,
          '脏数据不得入库：写入前就该拒绝，而不是让库里出现非纯数据',
        );
      },
    ],
  ]);
}
