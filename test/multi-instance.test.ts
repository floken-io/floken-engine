/**
 * T13 · 汇聚闭环集成（`ARCHITECTURE.md` §9 T13）
 *
 * ★ 本文件的判据不是"跑通了"，而是**跑完之后状态里没有说不清的东西**：
 *   - 组内没人被落单（INV-9：判定说取消 → 组内**零个**在途令牌）；
 *   - 组结算后不会二次推进（组必须解散，否则下一次动作会再判一次 approved）；
 *   - 串行会签全程**至多 1 个 `active`**（INV-8）；
 *   - 减签之后**分母跟着变小**（`total = 已表态 + 仍在途`）；
 *   - 待办差分能表达全部走向（不新增接口方法）。
 *
 * ★ 最后一条**结构性**断言最值钱：走 `submit()` 与走 `plan()` 得到同一个 `next`。
 *   会签把"投票 + 汇聚"也纳入了演化，这条若不成立，门 2 自编排就跑不出会签。
 */

import { describe, expect, it } from 'vitest';

import { compileAction } from '../src/actions/compile';
import { ENGINE_ERROR_CODES } from '../src/core/errors';
import type { InstanceState } from '../src/core/state';
import { createProcessGraph } from '../src/nodes/graph';
import { createEngine } from '../src/runtime/engine';
import { step, tasksOf } from '../src/runtime/loop';
import { createMemoryStore } from '../src/store/memory';
import { makeDefinition, singleVersionSource, userApproval } from './helpers/definition';
import { createMemoryProjection } from './helpers/memory-projection';
import { expectCode } from './helpers/expect';

const T0 = '2026-10-01T00:00:00.000Z';
const PROCESS = 'Process_1';

/** 多办理人的 `floken:approval`（内置默认 `ApproverSource` 只认 `{type:'user'}`） */
const teamApproval = (
  users: readonly string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  approvers: users.map((value) => ({ type: 'user', value })),
  ...extra,
});

/** `Start_1 → Task_sign（多实例）→ Task_next（单人 u9）→ End_1` */
function signDefinition(approval: Record<string, unknown>): ReturnType<typeof makeDefinition> {
  return makeDefinition({
    id: 'Definitions_sign',
    version: 1,
    nodes: [
      { id: 'Start_1', type: 'startEvent' },
      { id: 'Task_sign', type: 'userTask', name: '会签节点', approval },
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

function ctxOf(approval: Record<string, unknown>) {
  const def = signDefinition(approval);
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
    def,
    graph: createProcessGraph(def, PROCESS, 1),
    load: async (id: string): Promise<InstanceState> => {
      const s = await store.load(id);
      if (s === null || s === undefined) throw new Error(`instance ${id} not found`);
      return s;
    },
  };
}

/** 待办表里某个节点上的办理人（排序只为断言稳定） */
async function assigneesAt(
  projection: ReturnType<typeof createMemoryProjection>,
  id: string,
  nodeId: string,
): Promise<string[]> {
  const all = await projection.list(id);
  return all.filter((t) => t.nodeId === nodeId).map((t) => t.assignee).sort();
}

const start = (c: ReturnType<typeof ctxOf>): Promise<string> =>
  c.engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });

// ---------------- ① 多实例展开 ----------------

describe('① 多实例展开（一个等待节点解析出 N 个办理人）', () => {
  it('3 人 → 展开成 3 条待办、同一个 `instanceGroup`', async () => {
    const c = ctxOf(teamApproval(['u1', 'u2', 'u3']));
    const id = await start(c);

    expect(await assigneesAt(c.projection, id, 'Task_sign')).toEqual(['u1', 'u2', 'u3']);

    const s = await c.load(id);
    const group = s.tokens.filter((t) => t.instanceGroup !== undefined);
    expect(group).toHaveLength(3);
    expect(new Set(group.map((t) => t.instanceGroup)).size).toBe(1); // 同组
    expect(group.every((t) => t.nodeId === 'Task_sign')).toBe(true);
  });

  it('★ `approverPolicy:first` → 只取 1 人，`mode` 不生效（单人组不判汇聚）', async () => {
    const c = ctxOf(teamApproval(['u1', 'u2', 'u3'], { approverPolicy: 'first', mode: 'all' }));
    const id = await start(c);

    const s = await c.load(id);
    expect(s.tokens).toHaveLength(1);
    expect(s.tokens[0]?.assignee).toBe('u1');
    expect(s.tokens[0]?.instanceGroup).toBeUndefined();

    // 单人 → `approve` 直接推进（不是投票）
    await c.engine.submit(id, { action: 'approve', actor: 'u1' });
    expect(await assigneesAt(c.projection, id, 'Task_next')).toEqual(['u9']);
  });
});

// ---------------- ② 会签（mode: 'all'） ----------------

describe("② 会签（`mode:'all'`）：全员通过才推进", () => {
  const countersign = () => teamApproval(['u1', 'u2', 'u3'], { mode: 'all', onReject: 'abort' });

  it('前两人通过 → **不推进**，待办只剩没表态的人', async () => {
    const c = ctxOf(countersign());
    const id = await start(c);

    const d1 = await c.engine.submit(id, { action: 'approve', actor: 'u1' });
    expect(d1.added).toEqual([]); // 没有新待办
    expect(d1.removed).toHaveLength(1); // 只有 u1 自己那条
    expect(await assigneesAt(c.projection, id, 'Task_sign')).toEqual(['u2', 'u3']);

    await c.engine.submit(id, { action: 'approve', actor: 'u2' });
    expect(await assigneesAt(c.projection, id, 'Task_sign')).toEqual(['u3']);

    const s = await c.load(id);
    expect(s.status).toBe('running');
    expect(s.tokens.filter((t) => t.instanceGroup !== undefined)).toHaveLength(3); // 组还在
  });

  it('★ 第三人通过 → 汇聚推进；组内零残留在途（INV-9）+ 组已解散', async () => {
    const c = ctxOf(countersign());
    const id = await start(c);
    await c.engine.submit(id, { action: 'approve', actor: 'u1' });
    await c.engine.submit(id, { action: 'approve', actor: 'u2' });

    const d3 = await c.engine.submit(id, { action: 'approve', actor: 'u3' });
    expect(d3.removed).toHaveLength(1); // u3 自己那条
    expect(d3.added.map((t) => t.assignee)).toEqual(['u9']); // 落到下一节点
    expect(await assigneesAt(c.projection, id, 'Task_sign')).toEqual([]);

    const s = await c.load(id);
    // INV-9：组内不得残留在途令牌
    expect(s.tokens.filter((t) => t.state === 'active' || t.state === 'waiting')).toHaveLength(1);
    // ★ 组必须解散 —— 否则下一次任何动作都会再判一次 approved → 流程自己往前走
    expect(s.tokens.every((t) => t.instanceGroup === undefined)).toBe(true);
    // 投票事实保留（审计要知道谁投了什么）
    expect(s.tokens.filter((t) => t.vote === 'approved')).toHaveLength(3);
    expect(s.completedNodes).toContain('Task_sign');
  });

  it('★ 会签中 1 人驳回（`onReject:abort`）→ 立即整体驳回，其余取消', async () => {
    const c = ctxOf(
      teamApproval(['u1', 'u2', 'u3'], {
        mode: 'all',
        onReject: 'abort',
        reject: { allowed: true }, // 白名单式：没开就是不许（DV-2）
      }),
    );
    const id = await start(c);

    const d = await c.engine.submit(id, {
      action: 'reject',
      actor: 'u2',
      comment: '金额不符',
    });
    expect(d.action.name).toBe('reject');
    // 组内三条待办全清（u2 投了驳回，u1/u3 被取消）
    expect(d.removed).toHaveLength(3);
    // 驳回到发起人 → Start_1 是自动节点 → 立刻回到 Task_sign 重新展开
    expect(d.added).toHaveLength(3);
    expect(await assigneesAt(c.projection, id, 'Task_sign')).toEqual(['u1', 'u2', 'u3']);

    const s = await c.load(id);
    // 驳回者保留 `vote:'rejected'`（不能与"被取消的人"混同）
    expect(s.tokens.filter((t) => t.vote === 'rejected')).toHaveLength(1);
    // 被取消的两个没有 `vote` —— 他们**没表态**
    const cancelled = s.tokens.filter((t) => t.state === 'cancelled');
    expect(cancelled).toHaveLength(2);
    expect(cancelled.every((t) => t.vote === undefined)).toBe(true);
    expect(s.status).toBe('running');
  });
});

// ---------------- ③ `onReject: 'wait'` ----------------

describe("③ `onReject:'wait'`：记录驳回，其余继续", () => {
  const waiter = () =>
    teamApproval(['u1', 'u2', 'u3'], {
      mode: 'all',
      onReject: 'wait',
      reject: { allowed: true },
    });

  it('1 人驳回 → 不终止，其余继续表态', async () => {
    const c = ctxOf(waiter());
    const id = await start(c);

    const d = await c.engine.submit(id, { action: 'reject', actor: 'u1', comment: '再议' });
    expect(d.removed).toHaveLength(1); // 只有 u1 自己那条没了
    expect(await assigneesAt(c.projection, id, 'Task_sign')).toEqual(['u2', 'u3']);

    const s = await c.load(id);
    expect(s.status).toBe('running');
    expect(s.tokens.filter((t) => t.vote === 'rejected')).toHaveLength(1);
  });

  it('★ 全员表态后（2 通过 1 驳回）→ 仍是**驳回**（会签不是多数决，D-31）', async () => {
    const c = ctxOf(waiter());
    const id = await start(c);
    await c.engine.submit(id, { action: 'reject', actor: 'u1', comment: '再议' });
    await c.engine.submit(id, { action: 'approve', actor: 'u2' });

    // 最后一人表态 → 全员表态完 → 会签有驳回 → 整体驳回
    const d = await c.engine.submit(id, { action: 'approve', actor: 'u3' });
    expect(d.removed).toHaveLength(1);
    expect(d.added).toHaveLength(3); // 回到 Task_sign 重新展开

    const s = await c.load(id);
    expect(s.status).toBe('running');
    expect(s.completedNodes).not.toContain('Task_next');
  });
});

// ---------------- ④ 或签 / 票签 ----------------

describe("④ 或签（`mode:'any'`）/ 票签（`mode:'vote'`）", () => {
  it('★ 或签：第 1 人通过 → 汇聚推进，其余 2 人待办**取消**', async () => {
    const c = ctxOf(teamApproval(['u1', 'u2', 'u3'], { mode: 'any' }));
    const id = await start(c);

    const d = await c.engine.submit(id, { action: 'approve', actor: 'u1' });
    expect(d.removed).toHaveLength(3); // u1 自己 + 被取消的 u2 / u3
    expect(d.added.map((t) => t.assignee)).toEqual(['u9']);
    expect(await assigneesAt(c.projection, id, 'Task_sign')).toEqual([]);

    const s = await c.load(id);
    expect(s.tokens.filter((t) => t.state === 'cancelled')).toHaveLength(2);
    expect(s.tokens.filter((t) => t.vote === 'approved')).toHaveLength(1);
  });

  it('票签：threshold 0.5 × 3 人 = 2 票；第 1 人不够，第 2 人达线', async () => {
    const c = ctxOf(
      teamApproval(['u1', 'u2', 'u3'], { mode: 'vote', vote: { threshold: 0.5 } }),
    );
    const id = await start(c);

    const d1 = await c.engine.submit(id, { action: 'approve', actor: 'u1' });
    expect(d1.added).toEqual([]);
    expect(await assigneesAt(c.projection, id, 'Task_sign')).toEqual(['u2', 'u3']);

    const d2 = await c.engine.submit(id, { action: 'approve', actor: 'u2' });
    // 达 2 票 → 汇聚：u2 自己 + u3 被取消
    expect(d2.removed).toHaveLength(2);
    expect(d2.added.map((t) => t.assignee)).toEqual(['u9']);
  });
});

// ---------------- ⑤ 串行会签（INV-8） ----------------

describe('⑤ `sequential`：组内至多 1 个 `active`（INV-8）', () => {
  it('★ 一次只激活一个，办完接力下一个', async () => {
    const c = ctxOf(
      teamApproval(['u1', 'u2', 'u3'], { mode: 'all', sequential: true }),
    );
    const id = await start(c);

    // 只有 u1 是待办 —— `waiting` 的**不是**待办（轮到他才算创建）
    expect(await assigneesAt(c.projection, id, 'Task_sign')).toEqual(['u1']);
    let s = await c.load(id);
    expect(s.tokens.filter((t) => t.state === 'active')).toHaveLength(1);
    expect(s.tokens.filter((t) => t.state === 'waiting')).toHaveLength(2);

    await c.engine.submit(id, { action: 'approve', actor: 'u1' });
    expect(await assigneesAt(c.projection, id, 'Task_sign')).toEqual(['u2']);
    s = await c.load(id);
    expect(s.tokens.filter((t) => t.state === 'active')).toHaveLength(1); // ★ 仍然只有 1 个

    await c.engine.submit(id, { action: 'approve', actor: 'u2' });
    expect(await assigneesAt(c.projection, id, 'Task_sign')).toEqual(['u3']);

    const d = await c.engine.submit(id, { action: 'approve', actor: 'u3' });
    expect(d.added.map((t) => t.assignee)).toEqual(['u9']); // 全员通过 → 汇聚推进
  });
});

// ---------------- ⑥ 减签：分母跟着变小 ----------------

describe('⑥ 减签（`reduceSign`）→ `total` 随成员减少', () => {
  it('★ 会签 3 人：2 人通过后减掉第 3 人 → 达线汇聚（不是永远等一个已不存在的人）', async () => {
    const c = ctxOf(
      teamApproval(['u1', 'u2', 'u3'], {
        mode: 'all',
        reduceSign: { allowed: true },
      }),
    );
    const id = await start(c);
    await c.engine.submit(id, { action: 'approve', actor: 'u1' });
    await c.engine.submit(id, { action: 'approve', actor: 'u2' });

    const remaining = await c.projection.list(id);
    const u3Task = remaining.find((t) => t.assignee === 'u3');
    expect(u3Task).toBeDefined();
    const u3TokenId = (u3Task?.taskId ?? '').slice('Task_sign:'.length);

    const d = await c.engine.submit(id, {
      action: 'reduceSign',
      actor: 'u1',
      payload: { reduceTokenIds: [u3TokenId] },
    });
    // u3 被取消 → 分母变 2、已通过 2 → 达线 → 推进
    expect(d.removed.map((t) => t)).toContain(`Task_sign:${u3TokenId}`);
    expect(d.added.map((t) => t.assignee)).toEqual(['u9']);
    expect(await assigneesAt(c.projection, id, 'Task_sign')).toEqual([]);
  });
});

// ---------------- ⑦ 待办差分的表达力（不新增接口方法） ----------------

describe('⑦ 投影压力测试：`{added, removed, changed}` 表达力足够', () => {
  it('`terminate` → 组内待办全清 + 实例终态', async () => {
    const c = ctxOf(teamApproval(['u1', 'u2', 'u3'], { mode: 'all' }));
    const id = await start(c);

    const d = await c.engine.submit(id, { action: 'terminate', actor: 'u_admin' });
    expect(d.removed).toHaveLength(3);
    expect(d.added).toEqual([]);
    expect(await c.projection.list(id)).toEqual([]);
    expect((await c.load(id)).status).toBe('terminated');
  });

  it('`addSignBefore` → 新增待办，且**不建组**（加签不参与汇聚，D-33）', async () => {
    const c = ctxOf(
      userApproval('u9', { addSign: { before: true } }),
    );
    const id = await start(c);
    expect(await assigneesAt(c.projection, id, 'Task_sign')).toEqual(['u9']);

    const d = await c.engine.submit(id, {
      action: 'addSignBefore',
      actor: 'u9',
      payload: { assignees: ['u_extra'] },
    });
    expect(d.added.map((t) => t.assignee)).toEqual(['u_extra']);
    expect(await assigneesAt(c.projection, id, 'Task_sign')).toEqual(['u9', 'u_extra']);

    const s = await c.load(id);
    // 加签来的令牌不带 `instanceGroup` → 不会被当成"只剩他一人"的组而独自推进流程
    expect(s.tokens.every((t) => t.instanceGroup === undefined)).toBe(true);
  });

  it('`transfer` → 只改 `assignee`，令牌与节点不动', async () => {
    const c = ctxOf(teamApproval(['u1', 'u2', 'u3'], { mode: 'all', transfer: { allowed: true } }));
    const id = await start(c);

    const d = await c.engine.submit(id, {
      action: 'transfer',
      actor: 'u1',
      payload: { assignee: 'u1_bak' },
    });
    /*
     * ★ `taskId = ${nodeId}:${tokenId}`，**不含 assignee** —— 所以转办是 `changed` 而不是
     *   "删一条加一条"。这正是要的：转办前后是**同一条待办**（AC-E7），
     *   若做成 removed+added，宿主的待办表会丢掉这条待办上的一切附加状态（已读 / 催办次数…）。
     */
    expect(d.removed).toEqual([]);
    expect(d.added).toEqual([]);
    expect(d.changed.map((t) => t.assignee)).toEqual(['u1_bak']);
    expect(await assigneesAt(c.projection, id, 'Task_sign')).toEqual(['u1_bak', 'u2', 'u3']);
    const s = await c.load(id);
    expect(s.tokens.filter((t) => t.instanceGroup !== undefined)).toHaveLength(3); // 组没散
  });
});

// ---------------- ⑧ 结构：两条路径不得分叉（§7.1） ----------------

describe('⑧ ★ `submit()` 与 `plan()` 同一结果（含投票 + 汇聚）', () => {
  it('会签最后一人通过：`plan()` 手工复算与 `submit()` 逐字段相同', async () => {
    const c = ctxOf(teamApproval(['u1', 'u2', 'u3'], { mode: 'all' }));
    const id = await start(c);
    await c.engine.submit(id, { action: 'approve', actor: 'u1' });
    await c.engine.submit(id, { action: 'approve', actor: 'u2' });

    const before = await c.load(id);
    const input = { action: 'approve', actor: 'u3', at: T0 };

    // —— 门 2：宿主自编排，独立走一遍 `compile → step → plan` ——
    const tokenId = before.tokens.find((t) => t.assignee === 'u3')?.id ?? '';
    const compiled = compileAction(input, before, {
      approval: c.graph.approvalOf('Task_sign'),
      nextOf: c.graph.nextOf,
      startNodeId: c.graph.startNodeId,
      tokenId,
    });
    expect(compiled.vote).toEqual({ tokenId, vote: 'approved' });
    expect(compiled.calls).toEqual([]); // 投票不对应任何原语

    const manual = c.engine.plan(before, input, {
      apply: (draft) =>
        step(
          draft,
          { graph: c.graph, at: T0, assigneesOf: () => ['u9'], conditionsOf: () => true },
          { calls: compiled.calls, ...(compiled.vote ? { vote: compiled.vote } : {}) },
        ).next,
      tasks: (s) => tasksOf(s, c.graph),
    });

    const d = await c.engine.submit(id, input);
    const after = await c.load(id);

    expect(manual.next).toEqual(after); // ★ 逐字段相同（rev / 审计 / 令牌全都算一遍）
    expect(d.added.map((t) => t.assignee)).toEqual(['u9']);
  });
});

// ---------------- ⑨ 边界：推定不了就抛 ----------------

describe('⑨ 边界', () => {
  it('★ 组内节点没有 `floken:approval` → 显式抛错（没有汇聚语义就不汇聚）', async () => {
    /*
     * 真实路径下 `ApproverSource` 会先抛（没有 `approvers` 就解析不出人），
     * 但状态可以被宿主直接塞进 store —— 引擎侧必须自己挡住，不能"不知道 mode 就按 all 收敛"。
     */
    const c = ctxOf(teamApproval(['u1', 'u2'], { mode: 'all' }));
    const id = await start(c);
    const s = await c.load(id);
    const bogus: InstanceState = {
      ...s,
      tokens: [
        // `Start_1` 没有 `floken:approval` → 无法判定 mode / onReject / vote
        { id: 'a', nodeId: 'Start_1', state: 'active', assignee: 'x', instanceGroup: 'g' },
        { id: 'b', nodeId: 'Start_1', state: 'active', assignee: 'y', instanceGroup: 'g' },
      ],
    };
    expectCode(
      () => step(bogus, { graph: c.graph, at: T0, assigneesOf: () => [], conditionsOf: () => true }, { calls: [] }),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
  });
});
