/**
 * T4 验证：
 *  ① **11 项 SPI 逐项对得上**（计数断言，口径 = 存储三线 3 + 业务接入 4 + 求值 2 + 出口 2）
 *  ② 类型层**可被宿主实现** —— 用一组 fake 实现跑通 `tsc`
 *  ③ 10 个业务事件名 = 节点级 5 + 实例级 5
 */
import { describe, it, expect } from 'vitest';
import type { SpiInterfaces } from '../src/core/spi';
import { SPI_NAMES, SPI_GROUPS } from '../src/core/spi';
import {
  ENGINE_EVENT_NAMES,
  TASK_EVENT_NAMES,
  INSTANCE_EVENT_NAMES,
  isTaskEvent,
  isInstanceEvent,
  type EngineEvent,
} from '../src/core/events';
import type { InstanceState } from '../src/core/state';

/**
 * ★ 宿主侧视角的「11 项插头」：每一项都写一个最小实现。
 * 这个对象本身就是 T4 的验收 —— 它若编译不过，说明接口不可被宿主实现。
 */
const fakes: SpiInterfaces = {
  StateStore: {
    async load(_id) {
      return null;
    },
    async save(_next, expectedRev) {
      // 只演示语义：0 = INSERT 信号
      if (expectedRev === 0) return;
    },
  },
  DefinitionSource: {
    async getDefinition(_processId, _version) {
      return null;
    },
  },
  TaskProjection: {
    async apply(_instanceId, _delta) {},
    async sync(_instanceId, _tasks) {},
  },
  ApproverSource: {
    async resolve(_spec, _ctx) {
      return ['u_1007'];
    },
  },
  ServiceHandler: {
    get(_ref) {
      return async (_vars, _ctx) => ({ ok: true });
    },
  },
  AuthResolver: {
    async canAct(_actor, _nodeId, _state) {
      return true;
    },
  },
  FormProvider: {
    async getForm(_formKey, _ctx) {
      return null;
    },
    async snapshot(_formKey, _variables, _ctx) {
      return null;
    },
  },
  ConditionHandler: {
    evaluate(_expression, _ctx) {
      return true;
    },
  },
  DecisionHandler: {
    async evaluate(input, _ctx) {
      return input;
    },
  },
  EventSink: {
    emit(_event) {},
  },
  Scheduler: {
    async schedule(_req) {
      return 'handle_1';
    },
    async cancel(_handle) {},
  },
};

describe('@floken-io/engine SPI 契约', () => {
  describe('① 计数口径（勿再挪）', () => {
    it('恰好 11 项', () => {
      expect(SPI_NAMES.length).toBe(11);
    });

    it('分组 = 3 + 4 + 2 + 2', () => {
      expect(SPI_GROUPS.storage.length).toBe(3);
      expect(SPI_GROUPS.business.length).toBe(4);
      expect(SPI_GROUPS.eval.length).toBe(2);
      expect(SPI_GROUPS.exit.length).toBe(2);
      const sum =
        SPI_GROUPS.storage.length +
        SPI_GROUPS.business.length +
        SPI_GROUPS.eval.length +
        SPI_GROUPS.exit.length;
      expect(sum).toBe(11);
    });

    it('四个分组恰好覆盖全部 11 项，不重不漏', () => {
      const grouped = [
        ...SPI_GROUPS.storage,
        ...SPI_GROUPS.business,
        ...SPI_GROUPS.eval,
        ...SPI_GROUPS.exit,
      ];
      expect(new Set(grouped).size).toBe(grouped.length);
      expect([...grouped].sort()).toEqual([...SPI_NAMES].sort());
    });

    it('命名红线：求值器只有 ConditionHandler / DecisionHandler，无 ExpressionEvaluator', () => {
      expect(SPI_NAMES).toContain('ConditionHandler');
      expect(SPI_NAMES).toContain('DecisionHandler');
      expect(SPI_NAMES as readonly string[]).not.toContain('ExpressionEvaluator');
      // 存储写线只有一个名字
      expect(SPI_NAMES as readonly string[]).not.toContain('InMemoryStateStore');
    });
  });

  describe('② 可被宿主实现（fakes 的类型就是这个断言）', () => {
    it('11 项 fake 实现齐备且键名与 SPI_NAMES 一致', () => {
      expect(Object.keys(fakes).sort()).toEqual([...SPI_NAMES].sort());
    });

    it('StateStore.save 的 expectedRev === 0 分支可调用（INSERT 信号）', async () => {
      const state = {} as InstanceState;
      await expect(fakes.StateStore.save(state, 0)).resolves.toBeUndefined();
      await expect(fakes.StateStore.load('pi_1')).resolves.toBeNull();
    });

    it('ApproverSource 回答「哪一类人」→ 具体 id 列表', async () => {
      const ids = await fakes.ApproverSource.resolve({ type: 'deptLeader', of: 'starter' }, {
        instanceId: 'pi_1',
        processId: 'Process_1',
        nodeId: 'UserTask_1',
        starter: 'u_001',
        variables: {},
      });
      expect(ids).toEqual(['u_1007']);
    });

    it('DecisionHandler 未注入时是引擎侧报「未配置」—— 接口本身不兜底', async () => {
      await expect(
        fakes.DecisionHandler.evaluate({ a: 1 }, { instanceId: 'pi_1', nodeId: 'BRT_1', input: {} }),
      ).resolves.toEqual({ a: 1 });
    });

    it('Scheduler.schedule 返回可取消 handle', async () => {
      const handle = await fakes.Scheduler.schedule({
        instanceId: 'pi_1',
        nodeId: 'UserTask_1',
        tokenId: 'tk_1',
        // ★ T21：`dueAt` 不再是入参 —— 内核交「起点 + 原始配置」，到期时刻由调度方按工作日历算
        fromAt: '2026-10-01T00:00:00Z',
        timeout: { duration: 'P3D' },
        kind: 'remind',
      });
      expect(typeof handle).toBe('string');
      await expect(fakes.Scheduler.cancel(handle)).resolves.toBeUndefined();
    });
  });

  describe('③ 事件名表', () => {
    it('节点级 5 + 实例级 5 = 10', () => {
      expect([...TASK_EVENT_NAMES]).toEqual([
        'taskCreated',
        'taskAssigned',
        'taskUpdated',
        'taskCompleted',
        'taskCancelled',
      ]);
      expect([...INSTANCE_EVENT_NAMES]).toEqual([
        'started',
        'completed',
        'terminated',
        'suspended',
        'resumed',
      ]);
      expect(ENGINE_EVENT_NAMES.length).toBe(10);
    });

    it('任务事件与实例事件判据互斥', () => {
      const taskEv = { name: 'taskCreated' } as unknown as EngineEvent;
      const instEv = { name: 'started' } as unknown as EngineEvent;
      expect(isTaskEvent(taskEv)).toBe(true);
      expect(isInstanceEvent(taskEv)).toBe(false);
      expect(isTaskEvent(instEv)).toBe(false);
      expect(isInstanceEvent(instEv)).toBe(true);
    });

    it('有意不采的事件不在这张表里（flow.take / enter / leave）', () => {
      const names = ENGINE_EVENT_NAMES as readonly string[];
      for (const n of ['flow.take', 'enter', 'leave', 'start', 'end']) {
        expect(names).not.toContain(n);
      }
    });
  });
});
