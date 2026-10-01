/**
 * @floken-io/engine · per-instance FIFO 串行队列（NFR-E5 的**主防线**）
 *
 * ★ 并发三道防线（§6.4 INV-1 的维护方之一）：
 *   ① **本档**：进程内按 `instanceId` 串行 —— 同一实例的两次提交永不交错；
 *   ② **`rev` CAS**（`StateStore.save`）：跨进程 / 跨实例的兜底；
 *   ③ 不开读从库、不加悲观锁。
 *
 * 为什么必须串行：`submit()` 是「load → plan → save」三步，中间有 `await`。
 * 两个并发提交会各自 load 到同一个 `rev`，后者覆盖前者 —— **典型脏写**。
 * 串行化后同实例内不存在「读到旧 rev」的窗口。
 *
 * ★ 刻意**不做**的事：
 *   - **不做重入检测**：`fn` 内再次对同一 key 调 `run()` 会**死锁**（自己等自己）。
 *     检测它需要在调用栈上打标记，收益不抵复杂度；正确做法是钩子里不要二次提交。
 *     若将来确有必要，应在 `runtime/engine.ts` 层用「提交中」标记拦，而不是改本档。
 *   - **不提供 `clear()` / `cancel()`**：队列里挂着的都是「已受理」的提交，取消它们没有安全语义。
 */

/** 排队中的一个任务 */
type Task = () => Promise<unknown>;

export interface InstanceQueue {
  /**
   * 把 `fn` 排到 `instanceId` 这条队列的**队尾**并等待其执行完成。
   *
   * - 同一 `instanceId`：严格 FIFO、两两不重叠；
   * - 不同 `instanceId`：**并行**，互不阻塞（NFR-E5 只要求同实例串行）。
   *
   * @returns `fn` 的结果 / 异常原样透传（**不包装**：包装会让宿主的 `instanceof` 判定失效）
   */
  run<T>(instanceId: string, fn: () => Promise<T> | T): Promise<T>;
  /** 等待**当前已排队**的全部任务完成（测试 / 优雅退出用；不阻止期间新进的任务） */
  drain(): Promise<void>;
  /** 仍有任务在队列（含正在执行）的 key 数 */
  size(): number;
  /** 某个 key 上未完成的任务数（含正在执行的那个） */
  depth(instanceId: string): number;
}

/**
 * 建一个 per-instance 串行队列。
 *
 * 实现要点（改动前务必理解）：
 * 1. **链尾法**：每个 key 只保存「链尾 Promise」，新任务 `prev.then(fn)` 挂上去 → FIFO 天然成立，
 *    无需自己维护数组和调度器。
 * 2. **前驱失败不得卡死队列**：链尾保存的是「吞掉异常的影子 Promise」（`cleanup`），
 *    所以前一个任务抛错不会让后续任务**永远排不上**。真实异常仍由 `run()` 返回的 Promise 抛给调用方。
 * 3. **用完后必须删 key**：否则 `Map` 会随实例数无限增长（长跑进程的内存泄漏）。
 *    在影子 Promise 的 `.then` 里递减 `depth`，归零即删。
 */
export function createInstanceQueue(): InstanceQueue {
  /** key → 链尾（**永不 reject**，见要点 2） */
  const tails = new Map<string, Promise<unknown>>();
  /** key → 未完成任务数（含正在执行的那个） */
  const depths = new Map<string, number>();

  function run<T>(instanceId: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = tails.get(instanceId) ?? Promise.resolve();
    depths.set(instanceId, (depths.get(instanceId) ?? 0) + 1);

    // `async` 包一层：让**同步抛错**的 fn 也变成 rejected Promise，与异步失败走同一条路径
    const task: Task = async () => fn();
    const result = prev.then(task, task) as Promise<T>;

    // 影子 Promise：吞掉异常，只用于串联与清理
    const cleanup = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(instanceId, cleanup);
    void cleanup.then(() => {
      const left = (depths.get(instanceId) ?? 1) - 1;
      if (left <= 0) {
        depths.delete(instanceId);
        tails.delete(instanceId);
      } else {
        depths.set(instanceId, left);
      }
    });

    return result;
  }

  async function drain(): Promise<void> {
    // 快照：drain 只保证「调用时已在队列里的任务」完成，不受期间新任务影响
    await Promise.all([...tails.values()]);
  }

  return {
    run,
    drain,
    size: () => depths.size,
    depth: (instanceId: string) => depths.get(instanceId) ?? 0,
  };
}
