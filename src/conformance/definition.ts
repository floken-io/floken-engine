/**
 * @floken-io/engine/conformance · `DefinitionSource` 契约测试套件
 *
 * 契约来源：`ARCHITECTURE.md` §7.2（`DefinitionSource`）/ §6.4（INV-19）/ §9 T19；
 * `03-engine` §8.1、`AC-E10`。
 *
 * ═══════════════════════════════════════════════════════════════
 * 宿主怎么用
 * ═══════════════════════════════════════════════════════════════
 * ```ts
 * import { runDefinitionConformance, formatConformanceReport } from '@floken-io/engine/conformance';
 *
 * const report = await runDefinitionConformance(mySource, [
 *   { processId: 'expense', version: 1, definition: defV1 },
 *   { processId: 'expense', version: 2, definition: defV2 },
 * ]);
 * console.log(formatConformanceReport(report));
 * ```
 *
 * ═══════════════════════════════════════════════════════════════
 * ★ 为什么必须由宿主额外交 `fixtures`（与 `store` 套件最大的不同）
 * ═══════════════════════════════════════════════════════════════
 * `StateStore` 的用例能**自己造**假状态（状态是引擎的数据），但**定义是业务的资产** ——
 * 套件随包发布，它不可能知道你的仓库里有哪些流程。所以这里反过来：
 * 由宿主声明「我的仓库里这一格长这样」（`{ processId, version, definition }`），
 * 套件拿着它去**按格取回**并逐格比对。这不是接口缺陷，而是「引擎不认识你的定义库」
 * 这条边界必须付出的代价 —— 与 `TaskProjection` 要宿主交 `readback` 同理
 * （见 `projection.ts` 文件头）。
 *
 * ═══════════════════════════════════════════════════════════════
 * ★ 它在抓什么（`AC-E10` 的两类静默错误）
 * ═══════════════════════════════════════════════════════════════
 * ① **忽略 `version` 参数**（`getDefinition(pid, v)` 里压根没用 `v`，永远返回最新版）。
 *    症状：在途实例跑到了它发起时**还不存在的节点**上，且**没有任何报错** ——
 *    「昨天发起的单子今天忽然多出一个审批人」就是它。
 *    这是本套件的**头号目标**，判据名里直接写明了「防忽略 version」。
 * ② **未知版本回退**（取不到第 v 版就退到上一版 / 最新版）。
 *    返回 `null` 才是「这一版不存在」的唯一诚实表达 —— 引擎会把它翻成
 *    `ENGINE_STATE_DEFINITION_MISSING`（可观测、可告警）；回退则是一次静默的偷换。
 *
 * ═══════════════════════════════════════════════════════════════
 * ★ 断言边界（诚实说明，**不是**遗漏）
 * ═══════════════════════════════════════════════════════════════
 * 只断言「按格取回的内容与宿主声明的深等」+ 上述两类反例。套件**不验**定义本身的
 * 合法性（能不能建图、节点类型对不对）—— 那是 `@floken-io/moddle` 的职责，
 * 且定义不合法时引擎会在 `createProcessGraph()` 抛错，不需要两套判据。
 *
 * 比较语义与 `assertDeepEqual` **同源**（`core/state.deepEqual` = JSON 串比较，故键序
 * 也算内容的一部分）。这不是偷懒：定义一律由 moddle 产出，键序稳定；
 * 只为"比较两个定义"再发明一套比较器，才是真正会漂移的东西。
 */
import type { ProcessDefinition } from '@floken-io/moddle';
import type { DefinitionSource } from '../core/spi.js';
import { deepEqual } from '../core/state.js';
import { assertTrue, assertDeepEqual, runConformanceCases, show } from './report.js';
import type { ConformanceReport } from './report.js';

/**
 * 宿主声明的「一格图纸」。
 *
 * ⚠️ `definition` 必须是**宿主仓库里这一格的真实内容** —— 套件拿它当期望值。
 *    声明错了套件会红（第一条用例就是干这个的），不会静默放过。
 */
export interface DefinitionFixture {
  processId: string;
  version: number;
  /** 该 `(processId, version)` 期望取回的内容 */
  definition: ProcessDefinition;
}

export interface DefinitionConformanceOptions {
  /** 被测实现的自述（进报告抬头，便于区分多套实现） */
  subject?: string;
}

/** 套件用来 probe「一定不存在的 processId」的前缀（宿主不可能有同名流程） */
const UNKNOWN_PROCESS_ID = '__floken_conf_no_such_process__';

/**
 * 跑 `DefinitionSource` 全量契约用例。
 *
 * 前置：`fixtures` 须含**同一 `processId` 的 ≥2 个版本**，且这些版本的内容**互不相同**
 * —— 否则「忽略 `version`」这类缺陷**无法被观测**（返回什么都一样），套件第一条会点名。
 */
export async function runDefinitionConformance(
  source: DefinitionSource,
  fixtures: readonly DefinitionFixture[],
  options: DefinitionConformanceOptions = {},
): Promise<ConformanceReport> {
  /** 按 `processId` 归组；只保留**有多个版本**的 pid —— 单版本 pid 无法验「版本有没有被用上」 */
  const byProcess = new Map<string, DefinitionFixture[]>();
  for (const f of fixtures) {
    const list = byProcess.get(f.processId);
    if (list === undefined) byProcess.set(f.processId, [f]);
    else list.push(f);
  }
  const multi = [...byProcess.values()].filter((l) => l.length >= 2);

  /**
   * 取一组「同 pid 多版本」作为后续用例的输入。
   * 前置不成立时抛 —— 于是相关用例都会报同一句清晰的原因，而不是各报一句莫名其妙的错。
   */
  function requirePair(): DefinitionFixture[] {
    const first = multi[0];
    if (first === undefined) {
      throw new Error(
        `fixtures 不合法：须含同一 processId 的 ≥2 个版本（实得 ${fixtures.length} 条 / ${byProcess.size} 个 processId）`,
      );
    }
    return first;
  }

  return runConformanceCases('definition', options.subject, [
    // ── 输入自检（套件不会对自己的输入装瞎） ──
    [
      'fixtures 自检：须含同一 processId 的 ≥2 个版本，且内容互不相同',
      ['§7.2'],
      async () => {
        const first = requirePair();
        for (let i = 0; i < first.length; i += 1) {
          for (let j = i + 1; j < first.length; j += 1) {
            const a = first[i];
            const b = first[j];
            assertTrue(
              a !== undefined && b !== undefined && !deepEqual(a.definition, b.definition),
              `fixtures 里 ${a?.processId}@${a?.version} 与 @${b?.version} 内容相同 —— ` +
                '版本间必须有差异，否则「忽略 version」无法被观测',
            );
          }
        }
      },
    ],

    // ── ① 版本精确命中 ──
    [
      '逐版本精确命中：getDefinition(pid, v) 取回的内容与宿主声明的深等',
      ['§7.2', 'AC-E10'],
      async () => {
        for (const f of fixtures) {
          const got = await source.getDefinition(f.processId, f.version);
          assertTrue(
            got !== null,
            `${f.processId}@${f.version} 取回 null（宿主声明了这一格，实现却说没有）`,
          );
          assertDeepEqual(got, f.definition, `${f.processId}@${f.version} 的内容`);
        }
      },
    ],

    // ── ★ 头号目标：version 必须真的被用上 ──
    [
      '★ 同一 processId 的不同 version 返回不同内容（防「忽略 version 参数」的静默错误）',
      ['AC-E10', 'INV-19'],
      async () => {
        const group = requirePair();
        for (let i = 0; i < group.length; i += 1) {
          for (let j = i + 1; j < group.length; j += 1) {
            const a = group[i];
            const b = group[j];
            assertTrue(a !== undefined && b !== undefined, 'fixtures 缺失');
            const ga = await source.getDefinition(a.processId, a.version);
            const gb = await source.getDefinition(b.processId, b.version);
            assertTrue(
              !deepEqual(ga, gb),
              `${a.processId}@${a.version} 与 @${b.version} 取回了相同内容 —— ` +
                'getDefinition 多半忽略了 version 参数（在途实例会跑到发起时不存在的节点上）',
            );
          }
        }
      },
    ],

    // ── ② 不存在 = null（不得抛、不得回退） ──
    [
      `未知 processId → null（不得抛错，也不得返回任一已有版本）`,
      ['§7.2'],
      async () => {
        const got = await source.getDefinition(UNKNOWN_PROCESS_ID, 1);
        assertTrue(
          got === null,
          `未知 processId 期望 null，实得 ${show(got)} —— 返回任一版本会让引擎拿到错误的图纸`,
        );
      },
    ],
    [
      '★ 未知 version → null（不得回退到最新版 / 任一已有版本）',
      ['AC-E10', 'INV-19'],
      async () => {
        const group = requirePair();
        const versions = group.map((f) => f.version);
        const max = Math.max(...versions);
        const min = Math.min(...versions);
        // 探两个点：最新之后一版、以及（若存在）最旧之前一版 —— 覆盖"向上回退"与"向下回退"
        const probes = [max + 1, ...(min > 1 ? [min - 1] : [])];
        for (const v of probes) {
          const got = await source.getDefinition(group[0]?.processId ?? '', v);
          assertTrue(
            got === null,
            `@${v} 期望 null（这一版不存在），实得 ${show(got)} —— ` +
              '回退到别的版本 = 在途实例被静默换成另一套图纸',
          );
        }
      },
    ],

    // ── ③ 取回不得有副作用 / 不得交共享可变对象 ──
    [
      '重复取回同一 (pid, v) 内容不变；取过别的版本后回来仍不变（不得交出会被后续调用覆盖的对象）',
      ['AC-E10'],
      async () => {
        const f = fixtures[0];
        assertTrue(f !== undefined, 'fixtures 为空');
        const first = await source.getDefinition(f.processId, f.version);
        assertDeepEqual(first, f.definition, `首次取回 ${f.processId}@${f.version}`);

        const other = fixtures[fixtures.length - 1];
        if (other !== undefined) await source.getDefinition(other.processId, other.version);

        const again = await source.getDefinition(f.processId, f.version);
        assertDeepEqual(
          again,
          f.definition,
          `再次取回 ${f.processId}@${f.version}（取过别的版本后，内容被改写了）`,
        );
      },
    ],

    // ── ④ 异常入参不得炸（引擎已保证 ≥1 整数，宿主只需返回 null） ──
    [
      '非法 version（0 / -1 / 小数 / NaN）→ null 且不得抛错（防「就近取整」）',
      ['§7.2'],
      async () => {
        const f = fixtures[0];
        assertTrue(f !== undefined, 'fixtures 为空');
        for (const bad of [0, -1, 1.5, Number.NaN]) {
          const got = await source.getDefinition(f.processId, bad);
          assertTrue(
            got === null,
            `version=${bad} 期望 null，实得 ${show(got)} —— 就近取整会让 v1.5 静默跑成别的版本`,
          );
        }
      },
    ],
  ]);
}
