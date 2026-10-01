/**
 * 测试用内存版 `TaskProjection`。
 *
 * ⚠️ **刻意不放进 `src/`**：T6 只授权 `runStoreConformance` / `runProjectionConformance`
 * 两个套件函数，没有授权官方 `createMemoryProjection()`。`TaskProjection` 是**可选** SPI
 * （不注入则宿主自管待办表），所以"官方内存投影"这一步等真有需求再加 —— 先别长 API。
 *
 * 它在这里的角色：**套件自身的被检对象**。契约套件若没有一个正确实现可跑，
 * 就没法区分"套件写错了"和"实现错了"。
 */
import type { TaskProjection } from '../../src/core/spi';
import type { TaskDelta, TaskView } from '../../src/core/task';

/** 加了测试专用读取口 —— 正好充当 `runProjectionConformance` 要求的 `readback` */
export interface TestMemoryProjection extends TaskProjection {
  /** 按 taskId 排序返回（顺序不是契约，排序只为断言稳定） */
  list(instanceId: string): Promise<TaskView[]>;
}

const clone = (t: TaskView): TaskView => JSON.parse(JSON.stringify(t)) as TaskView;

export function createMemoryProjection(): TestMemoryProjection {
  const tables = new Map<string, Map<string, TaskView>>();

  const table = (instanceId: string): Map<string, TaskView> => {
    let t = tables.get(instanceId);
    if (t === undefined) {
      t = new Map<string, TaskView>();
      tables.set(instanceId, t);
    }
    return t;
  };

  return {
    async apply(instanceId: string, delta: TaskDelta): Promise<void> {
      const t = table(instanceId);
      // 顺序与 `touchedTaskIds()` 一致：removed → added → changed
      for (const taskId of delta.removed) t.delete(taskId);
      for (const v of delta.added) t.set(v.taskId, clone(v));
      for (const v of delta.changed) t.set(v.taskId, clone(v));
    },

    async sync(instanceId: string, tasks: TaskView[]): Promise<void> {
      const next = new Map<string, TaskView>();
      for (const v of tasks) next.set(v.taskId, clone(v));
      // ★ 全量对账 = 整表替换（含清掉多余行），不是"并进去"
      tables.set(instanceId, next);
    },

    async list(instanceId: string): Promise<TaskView[]> {
      return [...table(instanceId).values()]
        .map(clone)
        .sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    },
  };
}
