/**
 * @floken-io/engine · 默认内存版 `StateStore`
 *
 * 契约来源：`ARCHITECTURE.md` §7.2（`StateStore`）/ §9 T5；`03-engine` §9.1~§9.2、`AC-E11`。
 *
 * 定位：**零依赖、零配置、浏览器可跑**（NFR-E10）—— `createEngine()` 不传 `store` 时就是它。
 * 生产请换 `@floken-io/store`（独立可选包，自带建表 DDL）。
 *
 * ★ 三个最容易写错的点（也正是本文件存在的意义）：
 *
 * 1. **两侧都要深拷贝**：`load()` 交出副本、`save()` 存入副本。
 *    内存实现若直接存引用，宿主改一下手里那个对象，"已提交状态"就被改了 ——
 *    连 `rev` CAS 都会跟着失效（CAS 比的就是那个被改过的 `rev`）。
 *
 * 2. **`save()` 体内不得出现 `await`**：JS 单线程下"一路同步跑到底"就是内存版的原子性来源。
 *    一旦中途 `await`，两次并发 `save()` 就会交错 —— 而 CAS 存在的意义恰恰是防这个。
 *    （SQL 版靠事务拿同一保证。）`async` 函数不含 `await` 时是**同步执行完**再返回已决议的
 *    Promise，所以这里的原子性不靠运气。
 *
 * 3. **`rev` 由 store 归一化，不信任 `next.rev`**：写入时恒取 `expectedRev + 1`（INSERT 恒为 `1`）。
 *    这与 SQL 版 `SET rev = rev + 1 WHERE … AND rev = ?` **同构** —— 那里 `rev` 也是库算的。
 *    好处：`INV-1`（`rev` 单调递增）由存储层直接保证，而不是指望每个调用点都记得递增。
 */
import { persistAlreadyExists, persistConflict } from '../core/errors.js';
import type { StateStore } from '../core/spi.js';
import { assertSerializable, cloneState } from '../core/state.js';
import type { InstanceState } from '../core/state.js';

/**
 * 创建内存版 `StateStore`。
 *
 * 每个实例**独占**一份存储 —— 测试里想要干净状态就再调一次。
 * 刻意**不提供** `clear()` / `size()`：那会让 `StateStore` 接口长出非契约方法，
 * 与「禁止长出事务接口」是同一条理由（内存实现的门槛必须压在 ~20 行，见 §7.2）。
 */
export function createMemoryStore(): StateStore {
  const rows = new Map<string, InstanceState>();

  return {
    async load(id: string): Promise<InstanceState | null> {
      const row = rows.get(id);
      // 交出副本：否则宿主手一抖就改到了"库里已提交的状态"
      return row === undefined ? null : cloneState(row);
    },

    async save(next: InstanceState, expectedRev: number): Promise<void> {
      // ① 纯数据体检（`AC-E8` / INV-14）—— 保证 `rows` 里永远只有纯数据。
      //    放进写入前，于是"存进来的一定是干净的"是**不变量**，而不是每次读取时再赌一把。
      assertSerializable(next, 'next');

      const current = rows.get(next.instanceId);

      if (expectedRev === 0) {
        // ── INSERT 路径 ──
        if (current !== undefined) throw persistAlreadyExists(next.instanceId);
        rows.set(next.instanceId, cloneState({ ...next, rev: 1 }));
        return;
      }

      // ── CAS 路径 ──
      // 实例不存在也归 CONFLICT：语义是「期望的 rev 与库里对不上」，
      // 而"库里根本没有这一行"正是一种对不上。`actualRev` 留空即表达"没有行"
      // （`persistConflict` 不传该参就不生成该键，宿主可用 `'actualRev' in details` 区分）。
      if (current === undefined) throw persistConflict(next.instanceId, expectedRev);
      if (current.rev !== expectedRev) {
        throw persistConflict(next.instanceId, expectedRev, current.rev);
      }

      rows.set(next.instanceId, cloneState({ ...next, rev: expectedRev + 1 }));
    },
  };
}
