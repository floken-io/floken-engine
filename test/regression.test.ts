/**
 * T15 · 回归路径（`03-engine` §9：**AC-E6 委派回归** / **AC-E7 转办** / 拿回 / 撤销）
 *
 * ★ 本文件的判据是「**令牌该不该动**」：
 *   - 转办：令牌**不动**（`nodeId` 不变，只有 `assignee` 变）；
 *   - 委派：B 办完**不推进** —— 办理人换回 A（`AC-E6`），A 再办才推进；
 *   - 拿回 / 撤销：回滚**下游**（截断 `completedNodes` + 取消其它在途令牌）；
 *   - 组内回退：**整组重来**（D-34），不得留下幽灵待办。
 *
 * ★ 最值钱的两条断言：
 *   ① 委派回归后 **A 再办才推进**（只验"回到 A"不算 —— 回归路径没清干净会无限回归）；
 *   ② 组内回退后 **没有任何在途令牌还带着旧组**（带着就会在下一个单人节点被再判一次汇聚
 *      → 流程没人在办却自己往前走）。
 */

import { describe, expect, it } from 'vitest';

import { compileAction } from '../src/actions/compile';
import type { ActionInput } from '../src/core/action';
import { ENGINE_ERROR_CODES } from '../src/core/errors';
import { createProcessGraph } from '../src/nodes/graph';
import { createEngine } from '../src/runtime/engine';
import { applyPost, step } from '../src/runtime/loop';
import { createMemoryStore } from '../src/store/memory';
import type { InstanceState } from '../src/core/state';
import { makeDefinition, singleVersionSource, userApproval } from './helpers/definition';
import { createMemoryProjection } from './helpers/memory-projection';
import { expectCode } from './helpers/expect';

const T0 = '2026-10-01T00:00:00.000Z';
const PROCESS = 'Process_1';

/**
 * `Start_1 → Task_a（u_a）→ Task_b（u_b）→ End_1`
 *
 * ⚠️ 开关挂在**当前节点**上（引擎按令牌所在节点读配置）：
 *   - `Task_a` 开委派 / 转办 / 驳回 —— 令牌在这一站时才做这些动作；
 *   - `Task_b` 开拿回 / 撤销 —— 拿回是「**从当前节点**撤回」，故开关必须在 `Task_b` 上
 *     （实测踩到：挂在 `Task_a` 上的 `withdraw` 在 `Task_b` 提交时是 `ACTION_NOT_ALLOWED`）。
 *   `allowedTargets: ['nodeId']` 让回退类能指名任意已完成节点（`'previous'` 只许最后一个）。
 */
function flowDefinition(): ReturnType<typeof makeDefinition> {
  return makeDefinition({
    id: 'Definitions_regress',
    version: 1,
    nodes: [
      { id: 'Start_1', type: 'startEvent' },
      {
        id: 'Task_a',
        type: 'userTask',
        name: '一审',
        approval: userApproval('u_a', {
          delegate: { allowed: true },
          transfer: { allowed: true },
          reject: { allowed: true, allowArbitrary: true, allowedTargets: ['nodeId'] },
        }),
      },
      {
        id: 'Task_b',
        type: 'userTask',
        name: '二审',
        approval: userApproval('u_b', {
          withdraw: { allowed: true },
          revoke: { allowed: true },
          reject: { allowed: true, allowArbitrary: true, allowedTargets: ['nodeId'] },
        }),
      },
      { id: 'End_1', type: 'endEvent' },
    ],
    flows: [
      { from: 'Start_1', to: 'Task_a' },
      { from: 'Task_a', to: 'Task_b' },
      { from: 'Task_b', to: 'End_1' },
    ],
  });
}

function ctxOf() {
  const def = flowDefinition();
  const store = createMemoryStore();
  const projection = createMemoryProjection();
  const engine = createEngine({
    definitionSource: singleVersionSource(PROCESS, 1, def),
    store,
    projection,
    clock: () => T0,
  });
  return {
    engine,
    projection,
    graph: createProcessGraph(def, PROCESS, 1),
    load: async (id: string): Promise<InstanceState> => {
      const s = await store.load(id);
      if (s === null || s === undefined) throw new Error(`instance ${id} not found`);
      return s;
    },
  };
}

const start = (c: ReturnType<typeof ctxOf>): Promise<string> =>
  c.engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });

const submit = (
  c: ReturnType<typeof ctxOf>,
  id: string,
  action: string,
  actor: string,
  extra: Partial<ActionInput> = {},
) => c.engine.submit(id, { action, actor, ...extra } as ActionInput);

/** 待办表里某节点的办理人 */
async function assigneesAt(
  projection: ReturnType<typeof createMemoryProjection>,
  id: string,
  nodeId: string,
): Promise<string[]> {
  const all = await projection.list(id);
  return all.filter((t) => t.nodeId === nodeId).map((t) => t.assignee);
}

// ---------------- AC-E7：转办（令牌不动） ----------------

describe('AC-E7 转办 —— `nodeId` 不变，只有 `assignee` 变', () => {
  it('转办后待办是**同一条**（changed），不是新待办', async () => {
    const c = ctxOf();
    const id = await start(c);
    expect(await assigneesAt(c.projection, id, 'Task_a')).toEqual(['u_a']);

    const before = await c.projection.list(id);
    const d = await submit(c, id, 'transfer', 'u_a', {
      payload: { assignee: 'u_a2' },
      comment: '我休假',
    });

    // ★ 同一条待办：taskId 不变 → 进 `changed`，不是 added + removed
    expect(d.removed).toEqual([]);
    expect(d.added).toEqual([]);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]?.taskId).toBe(before[0]?.taskId);
    expect(d.changed[0]?.assignee).toBe('u_a2');
    expect(d.changed[0]?.nodeId).toBe('Task_a'); // ★ 令牌没动
  });

  it('★ 转办**不留**回归路径（`returnTo` 不得有值）', async () => {
    const c = ctxOf();
    const id = await start(c);
    await submit(c, id, 'transfer', 'u_a', { payload: { assignee: 'u_a2' } });

    const s = await c.load(id);
    const t = s.tokens.find((x) => x.assignee === 'u_a2');
    expect(t?.returnTo).toBeUndefined();
    // 于是 u_a2 办完 → 直接推进（不是回到 u_a）
    await submit(c, id, 'approve', 'u_a2');
    expect(await assigneesAt(c.projection, id, 'Task_b')).toEqual(['u_b']);
  });
});

// ---------------- AC-E6：委派（B 办完回到 A） ----------------

describe('AC-E6 委派 —— B 办完**不推进**，令牌回到 A', () => {
  it('委派 → 待办状态 `delegated`，`returnTo` 记下 A', async () => {
    const c = ctxOf();
    const id = await start(c);
    const d = await submit(c, id, 'delegate', 'u_a', { payload: { assignee: 'u_bak' } });

    expect(d.changed[0]?.assignee).toBe('u_bak');
    expect(d.changed[0]?.status).toBe('delegated'); // ★ 视图能看出"已委派出去"

    const s = await c.load(id);
    const t = s.tokens.find((x) => x.assignee === 'u_bak');
    expect(t?.returnTo).toBe('u_a');
  });

  it('★ B 通过 → **回到 A 且节点不变**（不是推进到下一节点）', async () => {
    const c = ctxOf();
    const id = await start(c);
    await submit(c, id, 'delegate', 'u_a', { payload: { assignee: 'u_bak' } });

    const d = await submit(c, id, 'approve', 'u_bak');
    expect(d.changed[0]?.assignee).toBe('u_a');
    expect(d.changed[0]?.nodeId).toBe('Task_a'); // ★ 关键：没推进
    expect(d.added).toEqual([]);

    const s = await c.load(id);
    const t = s.tokens.find((x) => x.nodeId === 'Task_a');
    expect(t?.assignee).toBe('u_a');
    // ★ 回归路径必须**清掉** —— 不清的话 A 办完又会回到 A，流程永远办不完
    expect(t?.returnTo).toBeUndefined();
    expect(await assigneesAt(c.projection, id, 'Task_b')).toEqual([]);
  });

  it('★ 回到 A 之后，A 再办才推进（回归只发生一次）', async () => {
    const c = ctxOf();
    const id = await start(c);
    await submit(c, id, 'delegate', 'u_a', { payload: { assignee: 'u_bak' } });
    await submit(c, id, 'approve', 'u_bak');

    const d = await submit(c, id, 'approve', 'u_a');
    expect(d.added.map((t) => t.assignee)).toEqual(['u_b']);
    expect(await assigneesAt(c.projection, id, 'Task_b')).toEqual(['u_b']);
    expect((await c.load(id)).status).toBe('running');
  });

  it('委派期间**驳回**不被回归路径截胡（驳回归驳回）', async () => {
    const c = ctxOf();
    const id = await start(c);
    await submit(c, id, 'delegate', 'u_a', { payload: { assignee: 'u_bak' } });

    const d = await submit(c, id, 'reject', 'u_bak', { target: 'Start_1', comment: '不合规' });
    expect(d.action.name).toBe('reject');
    const s = await c.load(id);
    // 令牌回到 Start_1 后自动直通回 Task_a（发起节点不是等待节点）
    expect(s.tokens.filter((t) => t.state === 'active')).toHaveLength(1);
    expect(s.tokens.find((t) => t.state === 'active')?.nodeId).toBe('Task_a');
  });
});

// ---------------- 拿回 / 撤销：回滚下游 ----------------

describe('takeBack / revoke —— 回滚下游（截断 + 取消在途）', () => {
  it('★ 拿回：截断 `completedNodes`、令牌回到目标节点重办', async () => {
    const c = ctxOf();
    const id = await start(c);
    await submit(c, id, 'approve', 'u_a'); // → Task_b
    expect(await assigneesAt(c.projection, id, 'Task_b')).toEqual(['u_b']);

    // ⚠️ `takeBack` 的开关是 `withdraw`，它在 `COMMENT_GATE_PATHS` 里 → **默认强制留痕**
    const d = await submit(c, id, 'takeBack', 'u_applicant', {
      target: 'Task_a',
      comment: '金额填错了',
    });
    expect(d.action.name).toBe('takeBack');
    // ★ 下游那条待办被摘掉、上游那条重新出现
    expect(d.removed).toHaveLength(1);
    expect(d.removed[0]).toMatch(/^Task_b:/); // ★ 摘掉的正是「下游那条」
    expect(d.added.map((t) => t.assignee)).toEqual(['u_a']);

    const s = await c.load(id);
    // Task_a 要重办 → 它必须**不在** completedNodes 里
    expect(s.completedNodes).toEqual(['Start_1']);
    expect(s.tokens.filter((t) => t.state === 'active')).toHaveLength(1);
    expect(s.tokens.find((t) => t.state === 'active')?.nodeId).toBe('Task_a');
    expect(s.status).toBe('running'); // ★ 不是 completed
  });

  it('★ 撤销（revoke）：同样回滚下游，且必须留意见', async () => {
    const c = ctxOf();
    const id = await start(c);
    await submit(c, id, 'approve', 'u_a');

    // revoke 的 `requireComment` 默认 true（DV-3 回退类）→ 不留意见应被拒
    await expect(
      submit(c, id, 'revoke', 'u_applicant', { target: 'Task_a' }),
    ).rejects.toMatchObject({ code: 'ENGINE_ACTION_COMMENT_REQUIRED' });

    const d = await submit(c, id, 'revoke', 'u_applicant', {
      target: 'Task_a',
      comment: '重复提交',
    });
    expect(d.added.map((t) => t.assignee)).toEqual(['u_a']);
    const s = await c.load(id);
    expect(s.completedNodes).toEqual(['Start_1']);
  });

  it('回滚后重新走完，实例照常 completed（回归路径不留尾巴）', async () => {
    const c = ctxOf();
    const id = await start(c);
    await submit(c, id, 'approve', 'u_a');
    await submit(c, id, 'takeBack', 'u_applicant', { target: 'Task_a', comment: '填错了' });
    await submit(c, id, 'approve', 'u_a');
    const d = await submit(c, id, 'approve', 'u_b');
    expect(d.added).toEqual([]);
    expect((await c.load(id)).status).toBe('completed');
  });
});

// ---------------- D-34：组内回退 = 整组重来 ----------------

/** `Start_1 → Task_sign（3 人会签）→ Task_next（单人 u9）→ End_1` */
function signDefinition(): ReturnType<typeof makeDefinition> {
  return makeDefinition({
    id: 'Definitions_sign',
    version: 1,
    nodes: [
      { id: 'Start_1', type: 'startEvent' },
      {
        id: 'Task_sign',
        type: 'userTask',
        name: '会签',
        approval: {
          approvers: [
            { type: 'user', value: 'u1' },
            { type: 'user', value: 'u2' },
            { type: 'user', value: 'u3' },
          ],
          mode: 'all',
          onReject: 'abort',
          reject: { allowed: true, allowArbitrary: true, allowedTargets: ['starter'] },
        },
      },
      { id: 'Task_next', type: 'userTask', name: '下一节点', approval: userApproval('u9') },
      { id: 'End_1', type: 'endEvent' },
    ],
    flows: [
      { from: 'Start_1', to: 'Task_sign' },
      { from: 'Task_sign', to: 'Task_next' },
      { from: 'Task_next', to: 'End_1' },
    ],
  });
}

function signCtx() {
  const def = signDefinition();
  const store = createMemoryStore();
  const projection = createMemoryProjection();
  const engine = createEngine({
    definitionSource: singleVersionSource(PROCESS, 1, def),
    store,
    projection,
    clock: () => T0,
  });
  return {
    engine,
    projection,
    graph: createProcessGraph(def, PROCESS, 1),
    load: async (id: string): Promise<InstanceState> => {
      const s = await store.load(id);
      if (s === null || s === undefined) throw new Error(`instance ${id} not found`);
      return s;
    },
  };
}

describe('D-34 组内回退 —— 整组重来，不留幽灵待办', () => {
  it('★ 组内 `returnTo`：其余 2 人取消、只剩 1 个在途令牌、旧组已解散', async () => {
    const c = signCtx();
    const id = await c.engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    expect((await c.projection.list(id)).map((t) => t.assignee).sort()).toEqual(['u1', 'u2', 'u3']);

    const oldGroup = (await c.load(id)).tokens.find((t) => t.instanceGroup !== undefined)
      ?.instanceGroup;
    expect(oldGroup).toBeDefined();

    const d = await c.engine.submit(id, {
      action: 'returnTo',
      actor: 'u1',
      target: 'Start_1',
      comment: '整组重来',
    } as ActionInput);

    // ① 三条旧待办全部摘掉
    expect(d.removed).toHaveLength(3);

    const s = await c.load(id);
    // ② 回到 Start_1 后自动直通到 Task_sign → **重新展开成新的一组三人**
    expect(await assigneesAt(c.projection, id, 'Task_sign')).toEqual(['u1', 'u2', 'u3']);
    // ③ ★ 没有任何**在途**令牌还带着旧组 —— 带着就会在下一个单人节点被再判一次汇聚
    const live = s.tokens.filter((t) => t.state === 'active' || t.state === 'waiting');
    expect(live).toHaveLength(3);
    expect(live.some((t) => t.instanceGroup === oldGroup)).toBe(false);
    // ④ 新组是**新 id**（旧组不能复活：否则新旧两批人的票会混着算）
    const newGroup = live[0]?.instanceGroup;
    expect(newGroup).toBeDefined();
    expect(newGroup).not.toBe(oldGroup);
    expect(new Set(live.map((t) => t.instanceGroup)).size).toBe(1);
  });

  it('★ 组内回退后流程照常能走完（不会自己往前走）', async () => {
    const c = signCtx();
    const id = await c.engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    await c.engine.submit(id, {
      action: 'returnTo',
      actor: 'u1',
      target: 'Start_1',
      comment: '重来',
    } as ActionInput);

    // 重来的这一组：两人通过不推进，第三人通过才汇聚
    await c.engine.submit(id, { action: 'approve', actor: 'u1' } as ActionInput);
    expect(await assigneesAt(c.projection, id, 'Task_next')).toEqual([]);
    await c.engine.submit(id, { action: 'approve', actor: 'u2' } as ActionInput);
    await c.engine.submit(id, { action: 'approve', actor: 'u3' } as ActionInput);
    expect(await assigneesAt(c.projection, id, 'Task_next')).toEqual(['u9']);

    await c.engine.submit(id, { action: 'approve', actor: 'u9' } as ActionInput);
    expect((await c.load(id)).status).toBe('completed');
  });

  it('编译期证据：组内 `returnTo` 编出「取消其余 + 跳转 + 解散组」', () => {
    const def = signDefinition();
    const graph = createProcessGraph(def, PROCESS, 1);
    const state: InstanceState = {
      instanceId: 'pi_1',
      processId: PROCESS,
      definitionVersion: 1,
      status: 'running',
      rev: 1,
      stateSchema: 1,
      startedAt: T0,
      updatedAt: T0,
      tokens: [
        { id: 'g#0', nodeId: 'Task_sign', state: 'active', assignee: 'u1', instanceGroup: 'g' },
        { id: 'g#1', nodeId: 'Task_sign', state: 'active', assignee: 'u2', instanceGroup: 'g' },
        { id: 'g#2', nodeId: 'Task_sign', state: 'active', assignee: 'u3', instanceGroup: 'g' },
      ],
      completedNodes: ['Start_1'],
      variables: {},
      auditTrail: [],
    };
    const compiled = compileAction(
      { action: 'returnTo', actor: 'u1', target: 'Start_1', comment: 'x', at: T0 },
      state,
      {
        approval: graph.approvalOf('Task_sign'),
        nextOf: graph.nextOf,
        startNodeId: graph.startNodeId,
        tokenId: 'g#0',
      },
    );
    expect(compiled.calls.map((c2) => c2.primitive)).toEqual(['cancelInstances', 'jumpTo']);
    expect(compiled.post?.dissolveTokenIds).toEqual(['g#0']);

    // 施加后：只剩 1 个在途令牌，且它没有组
    const after = step(
      state,
      { graph, at: T0, assigneesOf: (n) => (n === 'Task_sign' ? ['u1', 'u2', 'u3'] : ['u9']), conditionsOf: () => true },
      { calls: compiled.calls, post: compiled.post },
    ).next;
    const live = after.tokens.filter((t) => t.state === 'active' || t.state === 'waiting');
    expect(live).toHaveLength(3); // 直通回 Task_sign 后重新展开（新组）
    expect(live.every((t) => t.instanceGroup !== 'g')).toBe(true);
  });
});

// ---------------- applyPost 的边界（宿主可直接改状态，必须自己挡住） ----------------

describe('applyPost 的边界', () => {
  it('目标令牌不存在 → 抛（不静默跳过）', () => {
    const s: InstanceState = {
      instanceId: 'pi_1',
      processId: PROCESS,
      definitionVersion: 1,
      status: 'running',
      rev: 1,
      stateSchema: 1,
      startedAt: T0,
      updatedAt: T0,
      tokens: [],
      completedNodes: [],
      variables: {},
      auditTrail: [],
    };
    expect(() => applyPost(s, { returnFromTokenId: 'nope' })).toThrow();
    expectCode(
      () => applyPost(s, { returnFromTokenId: 'nope' }),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
  });

  it('令牌没有回归路径却要求回归 → 抛（防状态被宿主直接塞进 store）', () => {
    const s: InstanceState = {
      instanceId: 'pi_1',
      processId: PROCESS,
      definitionVersion: 1,
      status: 'running',
      rev: 1,
      stateSchema: 1,
      startedAt: T0,
      updatedAt: T0,
      tokens: [{ id: 'tk_1', nodeId: 'Task_a', state: 'active', assignee: 'u_a' }],
      completedNodes: ['Start_1'],
      variables: {},
      auditTrail: [],
    };
    expectCode(
      () => applyPost(s, { returnFromTokenId: 'tk_1' }),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
  });

  it('★ 纯函数：不改入参', () => {
    const s: InstanceState = {
      instanceId: 'pi_1',
      processId: PROCESS,
      definitionVersion: 1,
      status: 'running',
      rev: 1,
      stateSchema: 1,
      startedAt: T0,
      updatedAt: T0,
      tokens: [
        { id: 'tk_1', nodeId: 'Task_a', state: 'active', assignee: 'u_bak', returnTo: 'u_a' },
      ],
      completedNodes: ['Start_1'],
      variables: {},
      auditTrail: [],
    };
    const snapshot = JSON.stringify(s);
    const next = applyPost(s, { returnFromTokenId: 'tk_1' });
    expect(JSON.stringify(s)).toBe(snapshot);
    expect(next.tokens[0]?.assignee).toBe('u_a');
    expect(next.tokens[0]?.returnTo).toBeUndefined();
  });
});
