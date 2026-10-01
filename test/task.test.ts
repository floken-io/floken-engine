/**
 * T3 验证：待办视图与差分
 *   · `TaskStatus` 是 **5 值**（含 `delegated`）—— 少一个值就会让「已委派」退化成 `active`
 *   · `INV-15` 的前提：`removed` 是 id 列表，必须能定位到要真删的行
 */
import { describe, it, expect } from 'vitest';
import {
  TASK_STATUSES,
  isEmptyDelta,
  touchedTaskIds,
  type TaskDelta,
  type TaskView,
} from '../src/core/task';
import type { ActionRecord, InstanceStateHeader } from '../src/core/state';

const action: ActionRecord = { name: 'reject', actor: 'u_007', at: '2026-09-30T00:00:00Z' };

const header: InstanceStateHeader = {
  instanceId: 'pi_0001',
  processId: 'Process_1',
  definitionVersion: 1,
  status: 'running',
  rev: 6,
  stateSchema: 1,
  startedAt: '2026-09-30T00:00:00Z',
  updatedAt: '2026-09-30T00:00:00Z',
};

function task(taskId: string, over: Partial<TaskView> = {}): TaskView {
  return {
    taskId,
    instanceId: 'pi_0001',
    nodeId: 'UserTask_1',
    assignee: 'u_007',
    status: 'active',
    createdAt: '2026-09-30T00:00:00Z',
    ...over,
  };
}

function delta(over: Partial<TaskDelta> = {}): TaskDelta {
  return { rev: 6, action, added: [], removed: [], changed: [], instance: header, ...over };
}

describe('@floken-io/engine 待办差分', () => {
  it('TaskStatus 是 5 值', () => {
    expect([...TASK_STATUSES]).toEqual(['active', 'delegated', 'suspended', 'cancelled', 'done']);
  });

  it('isEmptyDelta：什么都没动', () => {
    expect(isEmptyDelta(delta())).toBe(true);
    expect(isEmptyDelta(delta({ removed: ['tk_1'] }))).toBe(false);
    expect(isEmptyDelta(delta({ added: [task('tk_1')] }))).toBe(false);
    expect(isEmptyDelta(delta({ changed: [task('tk_1')] }))).toBe(false);
  });

  it('touchedTaskIds：removed → added → changed 保序去重', () => {
    const d = delta({
      removed: ['tk_2', 'tk_3'],
      added: [task('tk_1'), task('tk_2')],
      changed: [task('tk_3'), task('tk_4')],
    });
    expect(touchedTaskIds(d)).toEqual(['tk_2', 'tk_3', 'tk_1', 'tk_4']);
  });

  it('touchedTaskIds 覆盖 removed —— 只处理 added 是头号静默错误', () => {
    const d = delta({ removed: ['tk_gone'] });
    expect(touchedTaskIds(d)).toContain('tk_gone');
  });
});
