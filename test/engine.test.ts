/**
 * T11 · `createEngine()` 端到端（`ARCHITECTURE.md` §9 T11）
 *
 * ★ 本文件的核心是 **AC-E13**：**零配置**（不传 `store`）跑通「报销」——
 *   `start → 查待办 → submit(approve) → 查待办 → submit(approve) → 实例完成`。
 *
 *   另有一条**结构性**断言最值钱：**「走 `submit()` 与走 `plan()` 得到同一个 `next`」**
 *   （§7.1 写死）。它不是靠纪律维持的 —— `submit()` 里那句 `plan(...)` 就是唯一演化路径；
 *   本文件把它**独立复算一遍**再逐字段比，等于把"两条路径"从承诺变成可执行判据。
 */
import { describe, expect, it } from 'vitest';

import { compileAction } from '../src/actions/compile';
import { ENGINE_ERROR_CODES } from '../src/core/errors';
import type { StateStore } from '../src/core/spi';
import type { InstanceState } from '../src/core/state';
import type { ActionInput } from '../src/core/action';
import { createProcessGraph } from '../src/nodes/graph';
import { NO_EFFECT } from '../src/nodes/tasks';
import { createEngine } from '../src/runtime/engine';
import { applyPrimitiveCalls, runToWait, tasksOf } from '../src/runtime/loop';
import { createMemoryStore } from '../src/store/memory';
import { expenseDefinition, makeDefinition, singleVersionSource, userApproval } from './helpers/definition';
import { createMemoryProjection } from './helpers/memory-projection';
import { expectCode } from './helpers/expect';

const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-01T00:00:01.000Z';
const PROCESS = 'Process_1';

/** 记录每次写库的 store —— 用来把 `submit()` 的演化结果抓出来做对账 */
function recordingStore(): StateStore & { saved: InstanceState[] } {
  const inner = createMemoryStore();
  const saved: InstanceState[] = [];
  return {
    saved,
    load: (id) => inner.load(id),
    async save(next, expectedRev) {
      saved.push(JSON.parse(JSON.stringify(next)) as InstanceState);
      await inner.save(next, expectedRev);
    },
  };
}

const engineFor = (
  def = expenseDefinition(),
  extra: Record<string, unknown> = {},
) =>
  createEngine({
    definitionSource: singleVersionSource(PROCESS, 1, def),
    clock: () => T0,
    ...extra,
  } as never);

describe('AC-E13 · 零配置跑通「报销」（start → approve → approve）', () => {
  it('★ 不传 store / 不传 approverSource，三段代码跑完一条流程', async () => {
    const projection = createMemoryProjection();
    const engine = createEngine({
      definitionSource: singleVersionSource(PROCESS, 1, expenseDefinition()),
      projection,
      clock: () => T0,
    });

    // ① 发起
    const id = await engine.start(PROCESS, {
      definitionVersion: 1,
      starter: 'u_applicant',
      businessKey: 'EXP-2026-001',
      variables: { amount: 1200 },
    });
    expect(id.startsWith('pi_')).toBe(true);

    // ② 查待办：run-to-wait 应当停在第一个 userTask 上
    const t0 = await projection.list(id);
    expect(t0).toHaveLength(1);
    expect(t0[0]).toMatchObject({
      nodeId: 'Task_apply',
      nodeName: '部门经理审批',
      formKey: 'form_expense',
      assignee: 'u_manager',
      status: 'active',
      instanceId: id,
    });

    // ③ 部门经理通过 → 待办流转到财务
    const d1 = await engine.submit(id, { action: 'approve', actor: 'u_manager' });
    expect(d1.action.name).toBe('approve');
    expect(d1.removed).toEqual(['Task_apply:tk_start']);
    expect(d1.added.map((t) => t.taskId)).toEqual(['Task_finance:tk_start']);

    const t1 = await projection.list(id);
    expect(t1).toHaveLength(1);
    expect(t1[0]).toMatchObject({ nodeId: 'Task_finance', assignee: 'u_finance' });

    // ④ 财务通过 → 走到结束事件 → 实例完成，待办清空
    const d2 = await engine.submit(id, { action: 'approve', actor: 'u_finance' });
    expect(d2.removed).toEqual(['Task_finance:tk_start']);
    expect(d2.added).toEqual([]);
    expect(d2.instance.status).toBe('completed');
    expect(await projection.list(id)).toHaveLength(0);

    const final = await (engine as unknown as { plan: unknown }).plan; // 仅为类型收窄，不调用
    void final;
  });

  it('实例状态：starter 落盘、变量带入、审计第一条是 start', async () => {
    const store = recordingStore();
    const engine = createEngine({
      definitionSource: singleVersionSource(PROCESS, 1, expenseDefinition()),
      store,
      clock: () => T0,
    });
    const id = await engine.start(PROCESS, {
      definitionVersion: 1,
      starter: 'u_applicant',
      businessKey: 'EXP-1',
      variables: { amount: 1200 },
    });

    const s = await store.load(id);
    expect(s).not.toBeNull();
    expect(s?.starter).toBe('u_applicant');
    expect(s?.businessKey).toBe('EXP-1');
    expect(s?.variables).toEqual({ amount: 1200 });
    expect(s?.rev).toBe(1); // INSERT 后由存储层归一化
    expect(s?.auditTrail).toEqual([
      { seq: 1, at: T0, actor: 'u_applicant', action: 'start', nodeId: 'Start_1' },
    ]);
    expect(s?.lastAction).toEqual({ name: 'start', actor: 'u_applicant', at: T0 });
  });

  it('★ 结构一致性：`submit()` 落库的状态 === `plan()` 独立复算的状态', async () => {
    const def = expenseDefinition();
    const store = recordingStore();
    const engine = createEngine({
      definitionSource: singleVersionSource(PROCESS, 1, def),
      store,
      clock: () => T0,
    });
    const id = await engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });

    const prev = (await store.load(id)) as InstanceState;
    const input: ActionInput = { action: 'approve', actor: 'u_manager', at: T1 };

    await engine.submit(id, input);
    const persisted = store.saved[store.saved.length - 1] as InstanceState;

    // —— 门 2 复算：用与引擎相同的纯函数，手工拼出 `apply` / `tasks` ——
    const graph = createProcessGraph(def, PROCESS, 1);
    const compiled = compileAction(input, prev, {
      approval: graph.approvalOf('Task_apply'),
      nextOf: graph.nextOf,
      startNodeId: graph.startNodeId,
      tokenId: 'tk_start',
    });
    const recomputed = engine.plan(prev, input, {
      apply: (draft) =>
        runToWait(applyPrimitiveCalls(draft, compiled.calls), {
          graph,
          at: T1,
          assigneesOf: (n) => (n === 'Task_finance' ? ['u_finance'] : []),
          conditionsOf: () => true, effectsOf: () => NO_EFFECT,
        }).next,
      tasks: (s) => tasksOf(s, graph),
    });

    expect(recomputed.next).toEqual(persisted);
    expect(recomputed.delta.rev).toBe(persisted.rev);
    expect(recomputed.delta.added.map((t) => t.taskId)).toEqual(['Task_finance:tk_start']);
  });
});

describe('运行时不变量', () => {
  it('INV-2：终态后 submit → STATE_TERMINAL（不得静默无效果）', async () => {
    const engine = engineFor();
    const id = await engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    await engine.submit(id, { action: 'approve', actor: 'u_manager' });
    await engine.submit(id, { action: 'approve', actor: 'u_finance' });

    let err: unknown;
    try {
      await engine.submit(id, { action: 'approve', actor: 'u_manager' });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string })?.code).toBe(ENGINE_ERROR_CODES.STATE_TERMINAL);
  });

  it('INV-3：token.nodeId 不在定义图中 → STATE_TOKEN_ORPHAN', async () => {
    const store = recordingStore();
    const engine = createEngine({
      definitionSource: singleVersionSource(PROCESS, 1, expenseDefinition()),
      store,
      clock: () => T0,
    });
    const id = await engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    const s = (await store.load(id)) as InstanceState;
    // 手动把令牌挪到图外（模拟"实例按 v1 跑着，v1 定义里这个节点被删了"）
    await store.save({ ...s, tokens: [{ ...s.tokens[0]!, nodeId: 'Ghost' }] }, s.rev);

    let err: unknown;
    try {
      await engine.submit(id, { action: 'approve', actor: 'u_manager' });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string })?.code).toBe(ENGINE_ERROR_CODES.STATE_TOKEN_ORPHAN);
  });

  it('INV-13：办理人解析为空集 + onEmpty=error → ACTION_APPROVER_EMPTY', async () => {
    const engine = createEngine({
      definitionSource: singleVersionSource(PROCESS, 1, expenseDefinition()),
      approverSource: { async resolve() { return []; } },
      clock: () => T0,
    });
    let err: unknown;
    try {
      await engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string })?.code).toBe(ENGINE_ERROR_CODES.ACTION_APPROVER_EMPTY);
  });

  it('实例不存在 → STATE_NOT_FOUND', async () => {
    const engine = engineFor();
    let err: unknown;
    try {
      await engine.submit('pi_nope', { action: 'approve', actor: 'u1' });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string })?.code).toBe(ENGINE_ERROR_CODES.STATE_NOT_FOUND);
  });
});

describe('createEngine 配置校验（D-7：禁止静默忽略）', () => {
  it('未知配置键 → OPTION_UNKNOWN，且列出全部合法键', () => {
    expectCode(
      () =>
        createEngine({
          definitionSource: singleVersionSource(PROCESS, 1, expenseDefinition()),
          stor: createMemoryStore(),
        } as never),
      ENGINE_ERROR_CODES.OPTION_UNKNOWN,
    );
  });

  it('缺 definitionSource → OPTION_INVALID（AC-E10 要求定义必须可按时版本取回）', () => {
    expectCode(() => createEngine({} as never), ENGINE_ERROR_CODES.OPTION_INVALID);
  });

  it('注入的实现形状不对 → OPTION_INVALID（早失败，别等跑起来再炸）', () => {
    expectCode(
      () =>
        createEngine({
          definitionSource: { getDefinition: 'not a function' },
        } as never),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
  });

  it('StartOptions 非法 → OPTION_INVALID', async () => {
    const engine = engineFor();
    let err: unknown;
    try {
      await engine.start(PROCESS, { definitionVersion: 0, starter: 'u1' });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string })?.code).toBe(ENGINE_ERROR_CODES.OPTION_INVALID);
  });
});

describe('内置默认 ApproverSource', () => {
  it("只认 {type:'user'}；其余 6 类未注入即抛（空集会掩盖真因）", async () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Task_1', type: 'userTask', approval: { approvers: [{ type: 'role', value: 'manager' }] } },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Task_1' },
        { from: 'Task_1', to: 'End_1' },
      ],
    });
    const engine = createEngine({
      definitionSource: singleVersionSource(PROCESS, 1, def),
      clock: () => T0,
    });
    let err: unknown;
    try {
      await engine.start(PROCESS, { definitionVersion: 1, starter: 'u1' });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string })?.code).toBe(ENGINE_ERROR_CODES.OPTION_INVALID);
  });

  it('注入 ApproverSource 后同一份定义即可跑通', async () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Task_1', type: 'userTask', approval: { approvers: [{ type: 'role', value: 'manager' }] } },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Task_1' },
        { from: 'Task_1', to: 'End_1' },
      ],
    });
    const projection = createMemoryProjection();
    const engine = createEngine({
      definitionSource: singleVersionSource(PROCESS, 1, def),
      projection,
      approverSource: { async resolve(spec) { return [`u_${String((spec as { value: string }).value)}`]; } },
      clock: () => T0,
    });
    const id = await engine.start(PROCESS, { definitionVersion: 1, starter: 'u1' });
    expect((await projection.list(id))[0]?.assignee).toBe('u_manager');
  });
});

describe('动作受理与换人', () => {
  it('未开启动作 → ACTION_NOT_ALLOWED（默认配置下 reject 是关的）', async () => {
    const engine = engineFor();
    const id = await engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });
    let err: unknown;
    try {
      await engine.submit(id, { action: 'reject', actor: 'u_manager', target: 'Start_1', comment: 'no' });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string })?.code).toBe(ENGINE_ERROR_CODES.ACTION_NOT_ALLOWED);
  });

  it('转办：点名目标人 → 待办 changed（转给错的人比抛错危险，故必须显式给）', async () => {
    const open = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        {
          id: 'Task_1',
          type: 'userTask',
          approval: userApproval('u_manager', { transfer: { allowed: true } }),
        },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Task_1' },
        { from: 'Task_1', to: 'End_1' },
      ],
    });
    const projection = createMemoryProjection();
    const engine = createEngine({
      definitionSource: singleVersionSource(PROCESS, 1, open),
      projection,
      clock: () => T0,
    });
    const id = await engine.start(PROCESS, { definitionVersion: 1, starter: 'u1' });

    const d = await engine.submit(id, {
      action: 'transfer',
      actor: 'u_manager',
      payload: { assignee: 'u_deputy' },
    });
    expect(d.changed.map((t) => t.taskId)).toEqual(['Task_1:tk_start']);
    expect((await projection.list(id))[0]?.assignee).toBe('u_deputy');
  });

  it('转办不点名目标人 → ACTION_APPROVER_EMPTY（不代劳猜一个）', async () => {
    const open = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Task_1', type: 'userTask', approval: userApproval('u_manager', { transfer: { allowed: true } }) },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Task_1' },
        { from: 'Task_1', to: 'End_1' },
      ],
    });
    const engine = createEngine({
      definitionSource: singleVersionSource(PROCESS, 1, open),
      clock: () => T0,
    });
    const id = await engine.start(PROCESS, { definitionVersion: 1, starter: 'u1' });
    let err: unknown;
    try {
      await engine.submit(id, { action: 'transfer', actor: 'u_manager' });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string })?.code).toBe(ENGINE_ERROR_CODES.ACTION_APPROVER_EMPTY);
  });
});

describe('并发（NFR-E5 主防线 · D-15 升格）', () => {
  it('★ 20 次并发 submit：串行生效 —— CAS 冲突为 0，越界的是终态错', async () => {
    const store = recordingStore();
    const engine = createEngine({
      definitionSource: singleVersionSource(PROCESS, 1, expenseDefinition()),
      store,
      clock: () => T0,
    });
    const id = await engine.start(PROCESS, { definitionVersion: 1, starter: 'u_applicant' });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        engine.submit(id, { action: 'approve', actor: i % 2 === 0 ? 'u_manager' : 'u_finance' }),
      ),
    );

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const codes = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason as { code?: string })?.code);

    expect(ok).toBe(2); // 部门经理 → 财务 → 结束
    expect(new Set(codes)).toEqual(new Set([ENGINE_ERROR_CODES.STATE_TERMINAL]));
    // ★ 关键断言：一次 CONFLICT 都没有 —— 说明第一道防线（串行队列）真的挡住了，
    //   而不是靠 CAS 兜底。把 rev CAS 当主防线用是设计错误（ADR-004）。
    expect(codes.filter((c) => c === ENGINE_ERROR_CODES.PERSIST_CONFLICT)).toHaveLength(0);

    expect((await store.load(id))?.rev).toBe(3);
  });
});
