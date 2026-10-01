/**
 * T20 · 投递入口 `deliverMessage` / `deliverSignal`（`nodes/catch.ts` + `runtime/deliver.ts`）
 *
 * ★ 三条判据（与 T20 的验证项对应）：
 *   ① **等得到**：`intermediateCatchEvent` / `receiveTask` 上的令牌会**停住**并记下在等什么，
 *      且**不投递就绝不自己走过去**；
 *   ② **唤得醒**：`deliverMessage` 点对点唤醒、`deliverSignal` 广播唤醒多实例；
 *   ③ **丢不得**：投递没命中任何等待 → **抛**（`ACTION_TARGET_INVALID`），
 *      且错误里要给出「此刻在等什么」—— 名字差一个大小写如果静默丢弃，
 *      症状就是「流程永久卡住，而宿主以为自己投过了」。
 *
 * ★ ③ 的反向验收（本档最重要的两条）：
 *   - 「没命中却返回空差分」的假实现会被 ③ 抓到；
 *   - 「不等就自己走过去」的假实现会被 ① 抓到。
 */

import { describe, expect, it } from 'vitest';

import { ENGINE_ERROR_CODES } from '../src/core/errors';
import type { EngineHooks } from '../src/core/hooks';
import { STATE_SCHEMA_VERSION } from '../src/core/state';
import type { InstanceState } from '../src/core/state';
import { createProcessGraph } from '../src/nodes/graph';
import {
  DELIVER_ACTIONS,
  MESSAGE_DELIVER_ACTION,
  SIGNAL_DELIVER_ACTION,
  catchBindingOf,
  matchingTokens,
  waitingNamesOf,
  wakeTokens,
} from '../src/nodes/catch';
import type { CatchNodeLike } from '../src/nodes/catch';
import { createEngine, deliverStep } from '../src/entries/index';
import { NO_EFFECT } from '../src/nodes/tasks';
import { runToWait, tasksOf } from '../src/runtime/loop';
import { createMemoryStore } from '../src/store/memory';
import { expectCode, expectCodeAsync } from './helpers/expect';
import { makeDefinition, mapSource, userApproval } from './helpers/definition';

const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-01T00:00:01.000Z';

// ---------------- 夹具 ----------------

/** 普通 `NodeLike`（`catchBindingOf` 只吃形状，不吃整个 `FlowNode`） */
const nodeLike = (n: Partial<CatchNodeLike> & { id: string; type: string }): CatchNodeLike => n;

/**
 * `Start_1 → Catch_1（等 Msg_paid）→ Task_1（u1 审批）→ End_1`
 *
 * ★ 观测点设计：唤醒前令牌停在 `Catch_1`、无待办；唤醒后产生一条 `Task_1` 的待办 ——
 *   「到底醒没醒」一眼可辨，不用去数 rev。
 */
function catchDefinition(opts: { kind?: 'message' | 'signal'; name?: string } = {}) {
  const kind = opts.kind ?? 'message';
  const name = opts.name ?? 'Msg_paid';
  return makeDefinition({
    nodes: [
      { id: 'Start_1', type: 'startEvent' },
      {
        id: 'Catch_1',
        type: 'intermediateCatchEvent',
        name: '等付款',
        eventDefinition: kind === 'message' ? { type: 'message', messageRef: name } : { type: 'signal', signalRef: name },
      },
      { id: 'Task_1', type: 'userTask', approval: userApproval('u1') },
      { id: 'End_1', type: 'endEvent' },
    ],
    flows: [
      { from: 'Start_1', to: 'Catch_1' },
      { from: 'Catch_1', to: 'Task_1' },
      { from: 'Task_1', to: 'End_1' },
    ],
  });
}

const base = (tokens: InstanceState['tokens']): InstanceState => ({
  instanceId: 'pi_1',
  processId: 'Process_1',
  definitionVersion: 1,
  status: 'running',
  rev: 1,
  stateSchema: STATE_SCHEMA_VERSION,
  startedAt: T0,
  updatedAt: T0,
  tokens,
  completedNodes: [],
  variables: {},
  auditTrail: [],
});

const ctx = (def: ReturnType<typeof makeDefinition>) => ({
  graph: createProcessGraph(def, 'Process_1', 1),
  assigneesOf: () => ['u1'] as readonly string[],
  conditionsOf: () => true,
  effectsOf: () => NO_EFFECT,
  at: T0,
});

interface Sink {
  readonly seen: { name: string; payload: Record<string, unknown> }[];
  emit(e: { name: string; payload?: Record<string, unknown> }): void;
}

function sinkOf(): Sink {
  const seen: { name: string; payload: Record<string, unknown> }[] = [];
  return {
    seen,
    emit: (e) => {
      seen.push({ name: e.name, payload: e.payload ?? {} });
    },
  };
}

function engineOf(
  def: ReturnType<typeof makeDefinition>,
  extra: Partial<Parameters<typeof createEngine>[0]> = {},
) {
  const sink = sinkOf();
  const store = createMemoryStore();
  const engine = createEngine({
    definitionSource: mapSource({ 'Process_1@1': def }),
    clock: () => T0,
    events: { emit: sink.emit },
    ...extra,
    store,
  });
  return { engine, sink, store };
}

// ---------------- ① 绑定解析 ----------------

describe('① `catchBindingOf`：等什么（唯一入口，不许有第二份判据）', () => {
  it('`intermediateCatchEvent` + message / signal → 拿到绑定', () => {
    expect(
      catchBindingOf(nodeLike({ id: 'C_1', type: 'intermediateCatchEvent', eventDefinition: { type: 'message', messageRef: 'Msg_paid' } })),
    ).toEqual({ kind: 'message', name: 'Msg_paid' });
    expect(
      catchBindingOf(nodeLike({ id: 'C_2', type: 'intermediateCatchEvent', eventDefinition: { type: 'signal', signalRef: 'Sig_go' } })),
    ).toEqual({ kind: 'signal', name: 'Sig_go' });
  });

  it('`receiveTask` + `messageRef` → message（与事件族同形，故判据只有一份）', () => {
    expect(catchBindingOf(nodeLike({ id: 'R_1', type: 'receiveTask', messageRef: 'Msg_paid' }))).toEqual({
      kind: 'message',
      name: 'Msg_paid',
    });
  });

  it('不是等待节点 → `undefined`（不得把 `userTask` 当成在等什么）', () => {
    for (const t of ['userTask', 'endEvent', 'startEvent', 'exclusiveGateway', 'subProcess']) {
      expect(catchBindingOf(nodeLike({ id: 'N_1', type: t })), t).toBeUndefined();
    }
    expect(catchBindingOf(undefined)).toBeUndefined();
  });

  it('★ 等待节点却没写名字 → 抛（等不到 = 永久卡死，引擎不放行）', () => {
    const e1 = expectCode(
      () => catchBindingOf(nodeLike({ id: 'C_1', type: 'intermediateCatchEvent', eventDefinition: { type: 'message' } })),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
    expect(String(e1.details?.owner)).toContain('FR-E14');
    expectCode(
      () => catchBindingOf(nodeLike({ id: 'R_1', type: 'receiveTask' })),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
  });

  it('★ 等 `timer` / `error` → 抛并指名 T21（不得静默直通）', () => {
    const e = expectCode(
      () => catchBindingOf(nodeLike({ id: 'C_1', type: 'intermediateCatchEvent', eventDefinition: { type: 'timer' } })),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
    expect(String(e.details?.owner)).toContain('T21');
  });

  it('`intermediateCatchEvent` 没有 `eventDefinition` → 抛（不知道在等什么）', () => {
    expectCode(
      () => catchBindingOf(nodeLike({ id: 'C_1', type: 'intermediateCatchEvent' })),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
  });
});

// ---------------- ② 停车：不投递就绝不自己走过去 ----------------

describe('② 令牌停在等待节点上（`Token.awaiting`）', () => {
  it('★ 端到端：`start()` 后停在 `Catch_1`，无待办、实例仍在跑', async () => {
    const { engine, store } = engineOf(catchDefinition());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const st = await store.load(id);

    expect(st?.status).toBe('running');
    expect(st?.tokens[0]?.nodeId).toBe('Catch_1');
    expect(st?.tokens[0]?.awaiting).toEqual({ kind: 'message', name: 'Msg_paid' });
    // 等待节点**不是**待办：它没有办理人，宿主待办表里不该出现它
    expect(tasksOf(st as InstanceState, createProcessGraph(catchDefinition(), 'Process_1', 1))).toEqual([]);
    expect(st?.completedNodes).toContain('Start_1');
  });

  /**
   * ★ 反向验收：若「有 awaiting 就停」这条判据被漏掉，`runToWait` 会把 catch 节点
   *   当成自动直通 —— 表现是「消息从来没到，流程却自己办完了」（最难查的一类假象）。
   */
  it('★ 反向：不投递时再跑一次推进，令牌**纹丝不动**（不得自己走过去）', () => {
    const def = catchDefinition();
    const parked = runToWait(base([{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }]), ctx(def)).next;
    expect(parked.tokens[0]?.nodeId).toBe('Catch_1');

    const again = runToWait(parked, ctx(def)).next;
    expect(again.tokens[0]?.nodeId).toBe('Catch_1');
    expect(again.tokens[0]?.awaiting).toEqual({ kind: 'message', name: 'Msg_paid' });
  });

  it('并行分支：一条停在等待节点、另一条继续走 ⇒ 实例**不得**判完成', () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Fork', type: 'parallelGateway' },
        { id: 'Catch_1', type: 'intermediateCatchEvent', eventDefinition: { type: 'message', messageRef: 'Msg_paid' } },
        { id: 'Task_1', type: 'userTask', approval: userApproval('u1') },
        { id: 'Join', type: 'parallelGateway' },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { id: 'Flow_1', from: 'Start_1', to: 'Fork' },
        { id: 'Flow_2', from: 'Fork', to: 'Catch_1' },
        { id: 'Flow_3', from: 'Fork', to: 'Task_1' },
        { id: 'Flow_4', from: 'Catch_1', to: 'Join' },
        { id: 'Flow_5', from: 'Task_1', to: 'Join' },
        { id: 'Flow_6', from: 'Join', to: 'End_1' },
      ],
    });
    const r = runToWait(base([{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }]), ctx(def));
    const nodes = r.next.tokens.map((t) => t.nodeId).sort();
    expect(nodes).toEqual(['Catch_1', 'Task_1']);
    expect(r.next.status).toBe('running'); // 还有人在等 ⇒ 没结束
  });
});

// ---------------- ③ deliverMessage（点对点） ----------------

describe('③ `deliverMessage`：点对点唤醒', () => {
  it('★ 唤醒 → 推进到 `Task_1` 并产生一条待办', async () => {
    const { engine, store, sink } = engineOf(catchDefinition());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });

    const delta = await engine.deliverMessage(id, { name: 'Msg_paid', actor: 'bank' });

    expect(delta.added.map((t) => t.nodeId)).toEqual(['Task_1']);
    expect(delta.action.name).toBe(MESSAGE_DELIVER_ACTION);
    expect(delta.action.actor).toBe('bank');

    const st = await store.load(id);
    expect(st?.tokens[0]?.nodeId).toBe('Task_1');
    expect(st?.tokens[0]?.awaiting).toBeUndefined(); // 唤醒后等待态必须摘掉
    expect(st?.tokens[0]?.assignee).toBe('u1');
    expect(st?.completedNodes).toContain('Catch_1');
    expect(sink.seen.some((e) => e.name === 'taskCreated')).toBe(true);
  });

  it('审计记的是「谁投的、投到哪儿」（第四类动作名）', async () => {
    const { engine, store } = engineOf(catchDefinition());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    await engine.deliverMessage(id, { name: 'Msg_paid', actor: 'bank', at: T1 });

    const st = await store.load(id);
    const last = st?.auditTrail[st.auditTrail.length - 1];
    expect(last?.action).toBe(MESSAGE_DELIVER_ACTION);
    expect(last?.actor).toBe('bank');
    expect(last?.nodeId).toBe('Catch_1');
    expect(last?.at).toBe(T1);
    expect(st?.lastAction?.name).toBe(MESSAGE_DELIVER_ACTION);
  });

  it('`payload` 并入 `variables`（消息带来的数据要能被后面的网关读到）', async () => {
    const { engine, store } = engineOf(catchDefinition());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    await engine.deliverMessage(id, { name: 'Msg_paid', actor: 'bank', payload: { paid: true, amount: 9000 } });

    const st = await store.load(id);
    expect(st?.variables).toEqual({ paid: true, amount: 9000 });
  });

  it('★ 投递**没命中** → 抛 `ACTION_TARGET_INVALID`，且 `details.waiting` 给出此刻在等什么', async () => {
    const { engine } = engineOf(catchDefinition());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });

    const err = await expectCodeAsync(
      engine.deliverMessage(id, { name: 'msg_paid', actor: 'bank' }), // 大小写差一个
      ENGINE_ERROR_CODES.ACTION_TARGET_INVALID,
    );
    expect(err.details?.waiting).toEqual(['message:Msg_paid']); // 合法取值
    expect(err.details?.name).toBe('msg_paid');
  });

  it('★ 失败投递**不留半截状态**（rev 不前进、令牌仍在原节点）', async () => {
    const { engine, store } = engineOf(catchDefinition());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const before = await store.load(id);

    await expectCodeAsync(
      engine.deliverMessage(id, { name: 'Msg_other', actor: 'bank' }),
      ENGINE_ERROR_CODES.ACTION_TARGET_INVALID,
    );
    const after = await store.load(id);
    expect(after?.rev).toBe(before?.rev);
    expect(after?.tokens[0]?.nodeId).toBe('Catch_1');
  });

  it('投第二次 → 抛（等待已被消费；幂等去重是宿主的事，引擎不替他吞）', async () => {
    const { engine } = engineOf(catchDefinition());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    await engine.deliverMessage(id, { name: 'Msg_paid', actor: 'bank' });
    await expectCodeAsync(
      engine.deliverMessage(id, { name: 'Msg_paid', actor: 'bank' }),
      ENGINE_ERROR_CODES.ACTION_TARGET_INVALID,
    );
  });

  it('实例不存在 → `STATE_NOT_FOUND`', async () => {
    const { engine } = engineOf(catchDefinition());
    await expectCodeAsync(
      engine.deliverMessage('pi_nope', { name: 'Msg_paid', actor: 'bank' }),
      ENGINE_ERROR_CODES.STATE_NOT_FOUND,
    );
  });

  it('★ 终态实例 → `STATE_TERMINAL`（INV-2：投递也是推进）', async () => {
    const { engine } = engineOf(catchDefinition());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    await engine.deliverMessage(id, { name: 'Msg_paid', actor: 'bank' });
    await engine.submit(id, { action: 'approve', actor: 'u1' });

    await expectCodeAsync(
      engine.deliverMessage(id, { name: 'Msg_paid', actor: 'bank' }),
      ENGINE_ERROR_CODES.STATE_TERMINAL,
    );
  });

  it('挂起实例 → `STATE_SUSPENDED`（INV-5：投递也不是 `resume`）', async () => {
    const { engine } = engineOf(catchDefinition());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    await engine.submit(id, { action: 'suspend', actor: 'admin', comment: '冻结' });
    await expectCodeAsync(
      engine.deliverMessage(id, { name: 'Msg_paid', actor: 'bank' }),
      ENGINE_ERROR_CODES.STATE_SUSPENDED,
    );
  });

  it('`receiveTask` 同样能被唤醒（与事件族同一条链路）', async () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Recv_1', type: 'receiveTask', messageRef: 'Msg_paid' },
        { id: 'Task_1', type: 'userTask', approval: userApproval('u1') },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Recv_1' },
        { from: 'Recv_1', to: 'Task_1' },
        { from: 'Task_1', to: 'End_1' },
      ],
    });
    const { engine, store } = engineOf(def);
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    expect((await store.load(id))?.tokens[0]?.awaiting).toEqual({ kind: 'message', name: 'Msg_paid' });

    await engine.deliverMessage(id, { name: 'Msg_paid', actor: 'bank' });
    expect((await store.load(id))?.tokens[0]?.nodeId).toBe('Task_1');
  });

  it('★ 唤醒后一路走到结束 → 实例 `completed` 并发实例级 `completed`（ADR-006）', async () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Catch_1', type: 'intermediateCatchEvent', eventDefinition: { type: 'message', messageRef: 'Msg_paid' } },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Catch_1' },
        { from: 'Catch_1', to: 'End_1' },
      ],
    });
    const { engine, store, sink } = engineOf(def);
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const delta = await engine.deliverMessage(id, { name: 'Msg_paid', actor: 'bank' });

    expect(delta.instance.status).toBe('completed');
    expect((await store.load(id))?.status).toBe('completed');
    expect(sink.seen.map((e) => e.name)).toEqual(['started', 'completed']);
  });

  it('★ 唤醒后落到 `callActivity` → 子实例照常建起来（follow-up 链路没断）', async () => {
    const child = makeDefinition({
      processId: 'Sub_Proc',
      nodes: [
        { id: 'S_Start', type: 'startEvent' },
        { id: 'S_Task', type: 'userTask', approval: userApproval('u_sub') },
        { id: 'S_End', type: 'endEvent' },
      ],
      flows: [
        { from: 'S_Start', to: 'S_Task' },
        { from: 'S_Task', to: 'S_End' },
      ],
    });
    const main = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Catch_1', type: 'intermediateCatchEvent', eventDefinition: { type: 'message', messageRef: 'Msg_paid' } },
        { id: 'Call_1', type: 'callActivity', calledElement: 'Sub_Proc', call: { version: 1 } },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Catch_1' },
        { from: 'Catch_1', to: 'Call_1' },
        { from: 'Call_1', to: 'End_1' },
      ],
    });
    const { engine, store } = engineOf(main, {
      definitionSource: mapSource({ 'Process_1@1': main, 'Sub_Proc@1': child }),
    });
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    await engine.deliverMessage(id, { name: 'Msg_paid', actor: 'bank' });

    const st = await store.load(id);
    expect(st?.tokens[0]?.nodeId).toBe('Call_1');
    expect(st?.tokens[0]?.state).toBe('waiting');
    expect(st?.childInstanceIds).toHaveLength(1);
    const childId = st?.childInstanceIds?.[0] as string;
    expect((await store.load(childId))?.tokens[0]?.nodeId).toBe('S_Task');
  });
});

// ---------------- ④ deliverSignal（广播） ----------------

describe('④ `deliverSignal`：广播唤醒多实例', () => {
  it('★ 两个实例都在等 → 两个 delta，各走各的图', async () => {
    const def = catchDefinition({ kind: 'signal', name: 'Sig_go' });
    const { engine, store } = engineOf(def);
    const a = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const b = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });

    const deltas = await engine.deliverSignal([a, b], { name: 'Sig_go', actor: 'erp' });

    expect(deltas).toHaveLength(2);
    expect(deltas.map((d) => d.instance.instanceId)).toEqual([a, b]); // 顺序 = 入参顺序（可重放）
    for (const d of deltas) expect(d.action.name).toBe(SIGNAL_DELIVER_ACTION);
    expect((await store.load(a))?.tokens[0]?.nodeId).toBe('Task_1');
    expect((await store.load(b))?.tokens[0]?.nodeId).toBe('Task_1');
  });

  it('★ 部分命中 → 只返回命中的（BPMN 信号不要求人人接收）', async () => {
    const def = catchDefinition({ kind: 'signal', name: 'Sig_go' });
    const { engine, store } = engineOf(def);
    const a = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const b = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    // 让 b 先走完：它此刻是「候选项里的一条**过期行**」—— 订阅表总比状态滞后一拍，属正常
    await engine.deliverSignal([b], { name: 'Sig_go', actor: 'erp' });
    await engine.submit(b, { action: 'approve', actor: 'u1' });
    expect((await store.load(b))?.status).toBe('completed');

    const deltas = await engine.deliverSignal([a, b], { name: 'Sig_go', actor: 'erp' });
    expect(deltas.map((d) => d.instance.instanceId)).toEqual([a]);
    expect((await store.load(b))?.status).toBe('completed');
  });

  it('★ 一个都没命中 → 抛（完全无效果 = 静默丢弃，必须报出来）', async () => {
    const def = catchDefinition({ kind: 'signal', name: 'Sig_go' });
    const { engine } = engineOf(def);
    const a = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });

    const err = await expectCodeAsync(
      engine.deliverSignal([a], { name: 'Sig_other', actor: 'erp' }),
      ENGINE_ERROR_CODES.ACTION_TARGET_INVALID,
    );
    expect(err.details?.waiting).toEqual(['signal:Sig_go']);
    expect(err.details?.candidates).toEqual([a]);
  });

  it('空候选集 → `OPTION_INVALID`（不得返回空数组冒充成功）', async () => {
    const { engine } = engineOf(catchDefinition({ kind: 'signal' }));
    await expectCodeAsync(
      engine.deliverSignal([], { name: 'Sig_go', actor: 'erp' }),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
  });

  it('候选里有不存在的实例 → `STATE_NOT_FOUND`（说明候选集给错了）', async () => {
    const { engine } = engineOf(catchDefinition({ kind: 'signal' }));
    const a = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    await expectCodeAsync(
      engine.deliverSignal([a, 'pi_nope'], { name: 'Sig_go', actor: 'erp' }),
      ENGINE_ERROR_CODES.STATE_NOT_FOUND,
    );
  });
});

// ---------------- ⑤ 门 1 钩子与纯函数性 ----------------

describe('⑤ 门 1 钩子 / 纯函数性 / 公开面', () => {
  it('`beforeAction` 可否决 → 抛 `ACTION_VETOED` 且**一次都没写库**（宿主用来做投递幂等）', async () => {
    const { engine, store } = engineOf(catchDefinition());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const before = await store.load(id);

    const hooks: EngineHooks = { beforeAction: () => false };
    const vetoEngine = createEngine({
      definitionSource: mapSource({ 'Process_1@1': catchDefinition() }),
      store,
      clock: () => T0,
      hooks,
    });
    await expectCodeAsync(
      vetoEngine.deliverMessage(id, { name: 'Msg_paid', actor: 'bank' }),
      ENGINE_ERROR_CODES.ACTION_VETOED,
    );
    expect((await store.load(id))?.rev).toBe(before?.rev);
  });

  it('钩子拿到的动作名 = `deliverMessage`（可按名字路由到"外部回调"）', async () => {
    const seen: string[] = [];
    const store = createMemoryStore();
    const engine = createEngine({
      definitionSource: mapSource({ 'Process_1@1': catchDefinition() }),
      store,
      clock: () => T0,
      hooks: { afterAction: (c) => void seen.push(c.action.name) },
    });
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    await engine.deliverMessage(id, { name: 'Msg_paid', actor: 'bank' });

    // `start()` 不触发钩子（D-27），故这里只会有投递那一条
    expect(seen).toEqual([MESSAGE_DELIVER_ACTION]);
  });

  it('★ `deliverStep()` 是纯函数（不改入参，门 2 可独立复用）', () => {
    const def = catchDefinition();
    const parked = runToWait(base([{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }]), ctx(def)).next;
    const snapshot = JSON.parse(JSON.stringify(parked)) as InstanceState;

    const r = deliverStep(parked, ctx(def), { kind: 'message', name: 'Msg_paid' });
    expect(parked).toEqual(snapshot); // 入参未被改动
    expect(r.woken).toEqual(['tk_1']);
    expect(r.nodeIds).toEqual(['Catch_1']);
    expect(r.next.tokens[0]?.nodeId).toBe('Task_1');
  });

  it('`deliverStep()` 没命中 → 抛（门 2 下也不能静默）', () => {
    const def = catchDefinition();
    const parked = runToWait(base([{ id: 'tk_1', nodeId: 'Start_1', state: 'active' }]), ctx(def)).next;
    expectCode(
      () => deliverStep(parked, ctx(def), { kind: 'message', name: 'Msg_other' }),
      ENGINE_ERROR_CODES.ACTION_TARGET_INVALID,
    );
  });

  it('`matchingTokens` 只认**在途**令牌（已取消的等待不算数）', () => {
    const st = base([
      { id: 'tk_1', nodeId: 'Catch_1', state: 'active', awaiting: { kind: 'message', name: 'Msg_paid' } },
      { id: 'tk_2', nodeId: 'Catch_2', state: 'cancelled', awaiting: { kind: 'message', name: 'Msg_paid' } },
      { id: 'tk_3', nodeId: 'Catch_3', state: 'active', awaiting: { kind: 'signal', name: 'Msg_paid' } },
    ]);
    expect(matchingTokens(st, { kind: 'message', name: 'Msg_paid' }).map((t) => t.id)).toEqual(['tk_1']);
    expect(waitingNamesOf(st)).toEqual(['message:Msg_paid', 'signal:Msg_paid']);
  });

  it('`wakeTokens()` 只摘等待态；令牌不存在 → 抛', () => {
    const st = base([{ id: 'tk_1', nodeId: 'Catch_1', state: 'active', awaiting: { kind: 'message', name: 'Msg_paid' } }]);
    const next = wakeTokens(st, ['tk_1']);
    expect(next.tokens[0]?.awaiting).toBeUndefined();
    expect(st.tokens[0]?.awaiting).toBeDefined(); // 不改入参
    expectCode(() => wakeTokens(st, ['tk_nope']), ENGINE_ERROR_CODES.STATE_SHAPE_INVALID);
  });

  it('两个动作名是**第四类**动作名（不在 19 项里，也不等于 `start`）', () => {
    expect(DELIVER_ACTIONS).toEqual([MESSAGE_DELIVER_ACTION, SIGNAL_DELIVER_ACTION]);
    expect(MESSAGE_DELIVER_ACTION).toBe('deliverMessage');
    expect(SIGNAL_DELIVER_ACTION).toBe('deliverSignal');
  });

  it('公开面：`./index` 导出投递所需的纯函数（门 2 自己完成同一段演化）', async () => {
    const mod = await import('../src/entries/index');
    expect(typeof mod.deliverStep).toBe('function');
    expect(mod.MESSAGE_DELIVER_ACTION).toBe('deliverMessage');
    expect(mod.SIGNAL_DELIVER_ACTION).toBe('deliverSignal');
    expect(typeof mod.matchingTokens).toBe('function');
    expect(typeof createEngine).toBe('function');
  });
});
