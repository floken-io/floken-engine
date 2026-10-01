/**
 * 测试专用：构造合法的 `InstanceState`。
 *
 * ★ 放进 `test/helpers/` 而不是 `src/` —— 它是**测试夹具**，不是契约；
 *   进 `src/` 会让它变成事实上的公开 API（改个默认值就要走 semver）。
 *
 * ★ 产出后自带一次 `assertInstanceState`：夹具本身不合法会**当场红**，
 *   避免「测试红了但其实是夹具写错」这种最费时间的误判。
 */

import { assertInstanceState, STATE_SCHEMA_VERSION } from '../../src/core/state';
import type { InstanceState } from '../../src/core/state';

export function makeState(overrides: Partial<InstanceState> = {}): InstanceState {
  const state: InstanceState = {
    instanceId: 'pi_1',
    processId: 'Process_1',
    definitionVersion: 1,
    status: 'running',
    rev: 1,
    stateSchema: STATE_SCHEMA_VERSION,
    startedAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    tokens: [],
    completedNodes: [],
    variables: {},
    auditTrail: [],
    ...overrides,
  };
  // `exactOptionalPropertyTypes` 下显式写 undefined 是合法的，但会留下值为 undefined 的键，
  // 与 INV-14「不得有 undefined 值键」冲突 —— 这里统一剔掉。
  for (const key of Object.keys(state) as (keyof InstanceState)[]) {
    if (state[key] === undefined) delete state[key];
  }
  assertInstanceState(state, 'fixture');
  return state;
}
