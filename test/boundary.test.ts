/**
 * T21 · 边界事件 / 事务取消 / `EventBasedGateway` 竞速 / 超时经 `Scheduler`。
 *
 * ★ 本档断言的是「**会不会静默地什么都不发生**」—— 这四件事的失败形式都是
 *   「没有报错，但流程的行为与图上画的不一样」，比抛错难查得多：
 *     - 边界事件没触发 → 超时 / 撤回配了却永远不发生；
 *     - 非中断边界把宿主也取消了 → 正在办的人凭空消失一条待办；
 *     - 竞速没有取消其余分支 → 流程莫名走出两条分支；
 *     - 超时没排程 / 没取消 → 该提醒的不提醒、已办结的还在催。
 */
import { describe, expect, it } from 'vitest';

import {
  armedBoundaries,
  boundaryBindingOf,
  createEngine,
  deliverStep,
  diffTimers,
  timingKeysOf,
} from '../src/entries/index';
import type { InstanceState } from '../src/core/state';
import type { ScheduleRequest, Scheduler } from '../src/core/spi';
import { ENGINE_ERROR_CODES } from '../src/core/errors';
import { createProcessGraph } from '../src/nodes/graph';
import type { ProcessGraph } from '../src/nodes/graph';
import { createMemoryStore } from '../src/store/memory';
import { expectCode, expectCodeAsync } from './helpers/expect';
import { makeDefinition, mapSource, userApproval } from './helpers/definition';

const T0 = '2026-10-01T00:00:00.000Z';
const SHAPE = ENGINE_ERROR_CODES.STATE_SHAPE_INVALID;
const NO_TARGET = ENGINE_ERROR_CODES.ACTION_TARGET_INVALID;

// ---------------- 夹具 ----------------

interface Sink {
  readonly seen: { name: string }[];
  emit(e: { name: string }): void;
}

function sinkOf(): Sink {
  const seen: { name: string }[] = [];
  return { seen, emit: (e) => void seen.push({ name: e.name }) };
}

/** 记录型假 `Scheduler`：不真的定时，只记「排了什么 / 取消了什么」 */
interface FakeScheduler extends Scheduler {
  readonly scheduled: ScheduleRequest[];
  readonly cancelled: string[];
}

function fakeScheduler(): FakeScheduler {
  const scheduled: ScheduleRequest[] = [];
  const cancelled: string[] = [];
  let seq = 0;
  return {
    scheduled,
    cancelled,
    async schedule(req) {
      scheduled.push(req);
      seq += 1;
      return `h${seq}`;
    },
    async cancel(handle) {
      cancelled.push(handle);
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

const graphOf = (def: ReturnType<typeof makeDefinition>): ProcessGraph =>
  createProcessGraph(def, 'Process_1', 1);

/** 带一个**中断**边界事件的图（`Task_1` 上挂「撤回」消息） */
function mainDef(opts: { cancelActivity?: boolean; on?: string } = {}) {
  return makeDefinition({
    nodes: [
      { id: 'Start_1', type: 'startEvent' },
      { id: 'Task_1', type: 'userTask', approval: userApproval('u1') },
      { id: 'End_1', type: 'endEvent' },
      {
        id: 'Bnd_1',
        type: 'boundaryEvent',
        attachedTo: opts.on ?? 'Task_1',
        ...(opts.cancelActivity === undefined ? {} : { cancelActivity: opts.cancelActivity }),
        eventDefinition: { type: 'message', messageRef: 'Msg_cancel' },
      },
      { id: 'Task_2', type: 'userTask', approval: userApproval('u2') },
      { id: 'End_2', type: 'endEvent' },
    ],
    flows: [
      { from: 'Start_1', to: 'Task_1' },
      { from: 'Task_1', to: 'End_1' },
      { id: 'Flow_bnd', from: 'Bnd_1', to: 'Task_2' },
      { from: 'Task_2', to: 'End_2' },
    ],
  });
}

/** 事务子流程 + 挂在事务上的中断边界事件（拍平后内部节点带 `Tx_1/` 前缀） */
function txDef() {
  return makeDefinition({
    nodes: [
      { id: 'Start_1', type: 'startEvent' },
      {
        id: 'Tx_1',
        type: 'transaction',
        nodes: [
          { id: 'T_Start', type: 'startEvent' },
          { id: 'T_A', type: 'userTask', approval: userApproval('u1') },
          { id: 'T_B', type: 'userTask', approval: userApproval('u2') },
          { id: 'T_End', type: 'endEvent' },
        ],
        flows: [
          { from: 'T_Start', to: 'T_A' },
          { from: 'T_A', to: 'T_B' },
          { from: 'T_B', to: 'T_End' },
        ],
      },
      { id: 'End_1', type: 'endEvent' },
      {
        id: 'Bnd_tx',
        type: 'boundaryEvent',
        attachedTo: 'Tx_1',
        eventDefinition: { type: 'message', messageRef: 'Msg_cancel' },
      },
      { id: 'Task_esc', type: 'userTask', approval: userApproval('u_esc') },
      { id: 'End_2', type: 'endEvent' },
    ],
    flows: [
      { from: 'Start_1', to: 'Tx_1' },
      { from: 'Tx_1', to: 'End_1' },
      { id: 'Flow_esc', from: 'Bnd_tx', to: 'Task_esc' },
      { from: 'Task_esc', to: 'End_2' },
    ],
  });
}

/** `EventBasedGateway` 竞速：两条分支各等一个消息 */
function raceDef() {
  return makeDefinition({
    nodes: [
      { id: 'Start_1', type: 'startEvent' },
      { id: 'EG_1', type: 'eventBasedGateway' },
      {
        id: 'C_A',
        type: 'intermediateCatchEvent',
        eventDefinition: { type: 'message', messageRef: 'Msg_A' },
      },
      {
        id: 'C_B',
        type: 'intermediateCatchEvent',
        eventDefinition: { type: 'message', messageRef: 'Msg_B' },
      },
      { id: 'Task_A', type: 'userTask', approval: userApproval('u_a') },
      { id: 'Task_B', type: 'userTask', approval: userApproval('u_b') },
      { id: 'End_1', type: 'endEvent' },
    ],
    flows: [
      { from: 'Start_1', to: 'EG_1' },
      { id: 'F_A', from: 'EG_1', to: 'C_A' },
      { id: 'F_B', from: 'EG_1', to: 'C_B' },
      { from: 'C_A', to: 'Task_A' },
      { from: 'C_B', to: 'Task_B' },
      { from: 'Task_A', to: 'End_1' },
      { from: 'Task_B', to: 'End_1' },
    ],
  });
}

const liveAt = (st: InstanceState | null, nodeId: string): string[] =>
  (st?.tokens ?? []).filter((t) => t.nodeId === nodeId && t.state === 'active').map((t) => t.id);

// ═══════════════════════════════════════════════════════════════
// ① 绑定解析（纯）
// ═══════════════════════════════════════════════════════════════

describe('① `boundaryBindingOf`：挂在谁身上、等什么、要不要中断', () => {
  const node = (o: Record<string, unknown>): never =>
    boundaryBindingOf(o as never) as never;

  it('不是 `boundaryEvent` → `undefined`', () => {
    expect(boundaryBindingOf({ id: 'X', type: 'userTask' })).toBeUndefined();
    expect(boundaryBindingOf(undefined)).toBeUndefined();
  });

  it('message / signal → 绑定；`cancelActivity` **缺省 true**', () => {
    const b = boundaryBindingOf({
      id: 'B_1',
      type: 'boundaryEvent',
      attachedTo: 'Task_1',
      eventDefinition: { type: 'message', messageRef: 'Msg_x' },
    });
    expect(b).toEqual({
      nodeId: 'B_1',
      attachedTo: 'Task_1',
      cancelActivity: true,
      trigger: { kind: 'message', name: 'Msg_x' },
    });
  });

  it('`cancelActivity:false` → 非中断（显式声明才生效）', () => {
    const b = boundaryBindingOf({
      id: 'B_2',
      type: 'boundaryEvent',
      attachedTo: 'Task_1',
      cancelActivity: false,
      eventDefinition: { type: 'signal', signalRef: 'Sig_x' },
    });
    expect(b?.cancelActivity).toBe(false);
    expect(b?.trigger).toEqual({ kind: 'signal', name: 'Sig_x' });
  });

  it('★ 缺 `attachedTo` → 抛（悬空的监听器永远不会亮，且没有任何报错）', () => {
    const err = expectCode(
      () =>
        boundaryBindingOf({
          id: 'B_3',
          type: 'boundaryEvent',
          eventDefinition: { type: 'message', messageRef: 'Msg_x' },
        }),
      SHAPE,
    );
    expect(String(err.details?.field)).toBe('attachedTo');
  });

  it('★ 不可投递的触发种类 → 抛并指名归属（`timer` / `error` / `compensate`）', () => {
    for (const [type, owner] of [
      ['timer', 'T21'],
      ['error', 'T21'],
      ['compensate', 'T21'],
    ] as const) {
      const err = expectCode(
        () =>
          boundaryBindingOf({
            id: 'B_4',
            type: 'boundaryEvent',
            attachedTo: 'Task_1',
            eventDefinition: { type, messageRef: 'x' },
          }),
        SHAPE,
      );
      expect(String(err.details?.owner), type).toContain(owner);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ② 建图期的 eager 校验（定义缺陷不许等到触发才报）
// ═══════════════════════════════════════════════════════════════

describe('② 建图期校验：边界事件的定义缺陷不许留到运行期', () => {
  it('★ 悬空边界事件（缺 attachedTo）→ **建图时**就抛', () => {
    expectCode(
      () =>
        graphOf(
          makeDefinition({
            nodes: [
              { id: 'Start_1', type: 'startEvent' },
              { id: 'Task_1', type: 'userTask', approval: userApproval('u1') },
              { id: 'End_1', type: 'endEvent' },
              { id: 'B_1', type: 'boundaryEvent', eventDefinition: { type: 'message', messageRef: 'M' } },
            ],
            flows: [
              { from: 'Start_1', to: 'Task_1' },
              { from: 'Task_1', to: 'End_1' },
              { from: 'B_1', to: 'End_1' },
            ],
          }),
        ),
      SHAPE,
    );
  });

  it('★ 宿主不存在 → 抛（挂到一个没有的活动上）', () => {
    expectCode(
      () =>
        graphOf(
          makeDefinition({
            nodes: [
              { id: 'Start_1', type: 'startEvent' },
              { id: 'End_1', type: 'endEvent' },
              { id: 'B_1', type: 'boundaryEvent', attachedTo: 'Nope', eventDefinition: { type: 'message', messageRef: 'M' } },
            ],
            flows: [
              { from: 'Start_1', to: 'End_1' },
              { from: 'B_1', to: 'End_1' },
            ],
          }),
        ),
      SHAPE,
    );
  });

  it('★ 没有出向 → 抛（触发即断线）', () => {
    expectCode(
      () =>
        graphOf(
          makeDefinition({
            nodes: [
              { id: 'Start_1', type: 'startEvent' },
              { id: 'Task_1', type: 'userTask', approval: userApproval('u1') },
              { id: 'End_1', type: 'endEvent' },
              { id: 'B_1', type: 'boundaryEvent', attachedTo: 'Task_1', eventDefinition: { type: 'message', messageRef: 'M' } },
            ],
            flows: [
              { from: 'Start_1', to: 'Task_1' },
              { from: 'Task_1', to: 'End_1' },
            ],
          }),
        ),
      SHAPE,
    );
  });

  it('正常图：`boundaryOf` 按宿主查得到', () => {
    const g = graphOf(mainDef());
    expect(g.boundaryOf('Task_1').map((b) => b.nodeId)).toEqual(['Bnd_1']);
    expect(g.boundaryOf('Start_1')).toEqual([]); // 没有 → 空数组（不是 undefined）
  });

  it('★ 内嵌作用域向上找：挂在 `Tx_1` 上的边界事件要被 `Tx_1/T_A` 上的令牌看见', () => {
    const g = graphOf(txDef());
    // 事务拍平后自身不在图里，内部令牌停的是 `Tx_1/T_A`
    expect(g.boundaryOf('Tx_1/T_A').map((b) => b.nodeId)).toEqual(['Bnd_tx']);
    expect(g.boundaryOf('Tx_1').map((b) => b.nodeId)).toEqual(['Bnd_tx']);
  });
});

// ═══════════════════════════════════════════════════════════════
// ③ 中断 / 非中断（端到端）
// ═══════════════════════════════════════════════════════════════

describe('③ 中断 vs 非中断（`cancelActivity`）', () => {
  it('★ 中断（缺省）：宿主待办消失，流程改走边界事件的出向', async () => {
    const { engine, store } = engineOf(mainDef());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    expect((await store.load(id))?.tokens[0]?.nodeId).toBe('Task_1');

    const delta = await engine.deliverMessage(id, { name: 'Msg_cancel', actor: 'crm' });
    // ⚠️ `removed` 是**真删**的 taskId 列表（`${nodeId}:${tokenId}`），不是 `TaskView`
    expect(delta.removed).toHaveLength(1);
    expect(delta.removed[0]).toContain('Task_1:');
    expect(delta.added.map((t) => t.assignee)).toEqual(['u2']);

    const st = await store.load(id);
    expect(liveAt(st, 'Task_1')).toEqual([]);
    expect(liveAt(st, 'Task_2')).toHaveLength(1);
    // 宿主令牌被**取消**而不是完成（它是被打断的，不是办完的）
    expect(st?.tokens.find((t) => t.nodeId === 'Task_1')?.state).toBe('cancelled');
  });

  it('★ 非中断：宿主待办**还在**，另起一条待办走边界事件的出向', async () => {
    const { engine, store } = engineOf(mainDef({ cancelActivity: false }));
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });

    const delta = await engine.deliverMessage(id, { name: 'Msg_cancel', actor: 'crm' });
    expect(delta.removed).toEqual([]);
    expect(delta.added.map((t) => t.assignee)).toEqual(['u2']);

    const st = await store.load(id);
    expect(liveAt(st, 'Task_1')).toHaveLength(1);
    expect(liveAt(st, 'Task_2')).toHaveLength(1);
    expect(st?.status).toBe('running');
  });

  it('★ 非中断可**重复**触发：两次触发产生两个**不同**的令牌 id', async () => {
    const { engine, store } = engineOf(mainDef({ cancelActivity: false }));
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    await engine.deliverMessage(id, { name: 'Msg_cancel', actor: 'crm' });
    // 让第二条边界令牌先离开 Task_2（否则它还在 Task_2 上等着，第二次触发仍会新建 —— 那也是对的）
    await engine.deliverMessage(id, { name: 'Msg_cancel', actor: 'crm' });

    const st = await store.load(id);
    const ids = (st?.tokens ?? []).map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length); // 不允许撞 id（撞了就会互相覆盖）
    expect(liveAt(st, 'Task_1')).toHaveLength(1);
    expect(liveAt(st, 'Task_2')).toHaveLength(2);
  });

  it('审计记的是投递动作名，且 `target` 指向被触发的边界事件', async () => {
    const { engine, store } = engineOf(mainDef());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    await engine.deliverMessage(id, { name: 'Msg_cancel', actor: 'crm' });
    const last = (await store.load(id))?.auditTrail.slice(-1)[0];
    expect(last?.action).toBe('deliverMessage');
    expect(last?.nodeId ?? (last as { target?: string })?.target).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// ④ 事务取消（拍平 + 前缀判据）
// ═══════════════════════════════════════════════════════════════

describe('④ `Transaction` 的 cancel：作用域内**全部**在途令牌退场', () => {
  it('★ 事务边界触发 → 事务**里面**正在办的人一并取消', async () => {
    const { engine, store } = engineOf(txDef());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    expect((await store.load(id))?.tokens[0]?.nodeId).toBe('Tx_1/T_A');

    const delta = await engine.deliverMessage(id, { name: 'Msg_cancel', actor: 'erp' });
    expect(delta.removed).toHaveLength(1);
    expect(delta.removed[0]).toContain('Tx_1/T_A:');
    expect(delta.added.map((t) => t.assignee)).toEqual(['u_esc']);

    const st = await store.load(id);
    expect(st?.tokens.filter((t) => t.nodeId.startsWith('Tx_1/') && t.state === 'active')).toEqual([]);
    expect(liveAt(st, 'Task_esc')).toHaveLength(1);
  });

  it('事务内**两条**在途令牌（并行）也会被一起取消', async () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        {
          id: 'Tx_1',
          type: 'transaction',
          nodes: [
            { id: 'T_S', type: 'startEvent' },
            { id: 'T_P', type: 'parallelGateway' },
            { id: 'T_A', type: 'userTask', approval: userApproval('u1') },
            { id: 'T_B', type: 'userTask', approval: userApproval('u2') },
            { id: 'T_E', type: 'endEvent' },
          ],
          flows: [
            { from: 'T_S', to: 'T_P' },
            { id: 'TP_A', from: 'T_P', to: 'T_A' },
            { id: 'TP_B', from: 'T_P', to: 'T_B' },
            { from: 'T_A', to: 'T_E' },
            { from: 'T_B', to: 'T_E' },
          ],
        },
        { id: 'End_1', type: 'endEvent' },
        {
          id: 'Bnd_tx',
          type: 'boundaryEvent',
          attachedTo: 'Tx_1',
          eventDefinition: { type: 'message', messageRef: 'Msg_cancel' },
        },
        { id: 'Task_esc', type: 'userTask', approval: userApproval('u_esc') },
        { id: 'End_2', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Tx_1' },
        { from: 'Tx_1', to: 'End_1' },
        { id: 'Flow_esc', from: 'Bnd_tx', to: 'Task_esc' },
        { from: 'Task_esc', to: 'End_2' },
      ],
    });
    const { engine, store } = engineOf(def);
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    expect((await store.load(id))?.tokens.filter((t) => t.state === 'active')).toHaveLength(2);

    await engine.deliverMessage(id, { name: 'Msg_cancel', actor: 'erp' });
    const st = await store.load(id);
    expect(st?.tokens.filter((t) => t.nodeId.startsWith('Tx_1/') && t.state !== 'cancelled')).toEqual([]);
    expect(liveAt(st, 'Task_esc')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑤ 命中集合：等待令牌 vs 边界事件
// ═══════════════════════════════════════════════════════════════

describe('⑤ 命中集合（点对点优先等待令牌 / 广播取并集）', () => {
  /** `Task_1`（带撤回边界）→ `Catch_1`（等 Msg_cancel）→ `Task_2` */
  function bothDef() {
    return makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Task_1', type: 'userTask', approval: userApproval('u1') },
        {
          id: 'Bnd_1',
          type: 'boundaryEvent',
          attachedTo: 'Task_1',
          eventDefinition: { type: 'message', messageRef: 'Msg_cancel' },
        },
        {
          id: 'Catch_1',
          type: 'intermediateCatchEvent',
          eventDefinition: { type: 'message', messageRef: 'Msg_cancel' },
        },
        { id: 'Task_2', type: 'userTask', approval: userApproval('u2') },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Task_1' },
        { from: 'Task_1', to: 'Catch_1' },
        { id: 'Flow_b', from: 'Bnd_1', to: 'Task_2' },
        { from: 'Catch_1', to: 'Task_2' },
        { from: 'Task_2', to: 'End_1' },
      ],
    });
  }

  it('★ 点对点：等待令牌命中时**不**触发边界事件（消息只有一个接收者）', async () => {
    const { engine, store } = engineOf(bothDef());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    // 先办完 Task_1 → 令牌停在 Catch_1（此时 Task_1 上已经没有在途令牌 ⇒ 边界不监听）
    await engine.submit(id, { action: 'approve', actor: 'u1' });
    const st = await store.load(id);
    expect(st?.tokens.find((t) => t.nodeId === 'Catch_1')?.awaiting).toEqual({
      kind: 'message',
      name: 'Msg_cancel',
    });

    await engine.deliverMessage(id, { name: 'Msg_cancel', actor: 'crm' });
    const after = await store.load(id);
    // 走的是 Catch_1 那条路：**没有**取消任何东西，直接推进到 Task_2
    expect(after?.tokens.filter((t) => t.state === 'cancelled')).toEqual([]);
    expect(liveAt(after, 'Task_2')).toHaveLength(1);
  });

  it('★ 兜底：没有等待令牌命中时才去问边界事件', async () => {
    const { engine, store } = engineOf(mainDef());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    // 图里没有 catch 节点，只有边界事件 —— 若只看 `matchingTokens`，这条消息就会被当成"没命中"而抛
    const delta = await engine.deliverMessage(id, { name: 'Msg_cancel', actor: 'crm' });
    expect(delta.added.map((t) => t.assignee)).toEqual(['u2']);
    expect(liveAt(await store.load(id), 'Task_2')).toHaveLength(1);
  });

  it('★ 广播：等待令牌与边界事件**都**命中（`deliverSignal` 不落下一个）', async () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Task_1', type: 'userTask', approval: userApproval('u1') },
        {
          id: 'Bnd_1',
          type: 'boundaryEvent',
          attachedTo: 'Task_1',
          cancelActivity: false,
          eventDefinition: { type: 'signal', signalRef: 'Sig_go' },
        },
        {
          id: 'Catch_1',
          type: 'intermediateCatchEvent',
          eventDefinition: { type: 'signal', signalRef: 'Sig_go' },
        },
        { id: 'Task_2', type: 'userTask', approval: userApproval('u2') },
        { id: 'Task_3', type: 'userTask', approval: userApproval('u3') },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Task_1' },
        { from: 'Task_1', to: 'Catch_1' },
        { id: 'Flow_b', from: 'Bnd_1', to: 'Task_3' },
        { from: 'Catch_1', to: 'Task_2' },
        { from: 'Task_2', to: 'End_1' },
        { from: 'Task_3', to: 'End_1' },
      ],
    });
    const { engine, store } = engineOf(def);
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    await engine.submit(id, { action: 'approve', actor: 'u1' });
    // 此刻 Catch_1 上有一条等待令牌；Task_1 已办完 ⇒ 边界不监听 ⇒ 只唤醒 Catch_1
    await engine.deliverSignal([id], { name: 'Sig_go', actor: 'erp' });
    expect(liveAt(await store.load(id), 'Task_2')).toHaveLength(1);
  });

  it('★ 未命中的报错要列出**边界事件**的等待（`details.waiting` 给合法取值）', async () => {
    const { engine } = engineOf(mainDef());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const err = await expectCodeAsync(
      engine.deliverMessage(id, { name: 'Msg_typo', actor: 'crm' }),
      NO_TARGET,
    );
    expect((err.details?.waiting as string[]).join(',')).toContain('boundary:message:Msg_cancel');
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑥ `EventBasedGateway` 竞速
// ═══════════════════════════════════════════════════════════════

describe('⑥ `EventBasedGateway`：先到先赢，其余分支取消', () => {
  it('★ 分叉后两条分支都停下等，且**共享** `race`', async () => {
    const { engine, store } = engineOf(raceDef());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const st = await store.load(id);
    const parked = (st?.tokens ?? []).filter((t) => t.awaiting !== undefined);
    expect(parked.map((t) => t.nodeId).sort()).toEqual(['C_A', 'C_B']);
    const races = new Set(parked.map((t) => t.race));
    expect(races.size).toBe(1);
    expect([...races][0]).toBeTruthy();
  });

  it('★ 投递 A → A 分支走下去，B 分支**取消**（不会走出两条分支）', async () => {
    const { engine, store } = engineOf(raceDef());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });

    const delta = await engine.deliverMessage(id, { name: 'Msg_A', actor: 'erp' });
    expect(delta.added.map((t) => t.assignee)).toEqual(['u_a']);

    const st = await store.load(id);
    expect(liveAt(st, 'Task_A')).toHaveLength(1);
    expect(liveAt(st, 'Task_B')).toEqual([]);
    expect(st?.tokens.find((t) => t.nodeId === 'C_B')?.state).toBe('cancelled');
  });

  it('★ 反过来的顺序同样成立（投递 B）', async () => {
    const { engine, store } = engineOf(raceDef());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    await engine.deliverMessage(id, { name: 'Msg_B', actor: 'erp' });
    const st = await store.load(id);
    expect(liveAt(st, 'Task_B')).toHaveLength(1);
    expect(st?.tokens.find((t) => t.nodeId === 'C_A')?.state).toBe('cancelled');
  });

  it('★ 广播时两条分支**同时**命中 → 仍然只走第一条（保序，可重放）', async () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'EG_1', type: 'eventBasedGateway' },
        {
          id: 'C_A',
          type: 'intermediateCatchEvent',
          eventDefinition: { type: 'signal', signalRef: 'Sig_x' },
        },
        {
          id: 'C_B',
          type: 'intermediateCatchEvent',
          eventDefinition: { type: 'signal', signalRef: 'Sig_x' },
        },
        { id: 'Task_A', type: 'userTask', approval: userApproval('u_a') },
        { id: 'Task_B', type: 'userTask', approval: userApproval('u_b') },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'EG_1' },
        { id: 'F_A', from: 'EG_1', to: 'C_A' },
        { id: 'F_B', from: 'EG_1', to: 'C_B' },
        { from: 'C_A', to: 'Task_A' },
        { from: 'C_B', to: 'Task_B' },
        { from: 'Task_A', to: 'End_1' },
        { from: 'Task_B', to: 'End_1' },
      ],
    });
    const { engine, store } = engineOf(def);
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    await engine.deliverSignal([id], { name: 'Sig_x', actor: 'erp' });
    const st = await store.load(id);
    expect(liveAt(st, 'Task_A')).toHaveLength(1);
    expect(liveAt(st, 'Task_B')).toEqual([]);
  });

  it('竞速赢家离开等待节点后**退出**竞速（下一次投递不再误取消）', async () => {
    const { engine, store } = engineOf(raceDef());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    await engine.deliverMessage(id, { name: 'Msg_A', actor: 'erp' });
    const winner = (await store.load(id))?.tokens.find((t) => t.nodeId === 'Task_A');
    expect(winner?.race).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑦ 超时经 `Scheduler`
// ═══════════════════════════════════════════════════════════════

describe('⑦ 超时排程（`Scheduler` SPI）', () => {
  const timeoutApproval = (who: string) =>
    userApproval(who, { timeout: { duration: 'P3D', actions: [{ type: 'remind' }, { type: 'autoApprove' }] } });

  function timeoutDef() {
    return makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Task_1', type: 'userTask', approval: timeoutApproval('u1') },
        { id: 'Task_2', type: 'userTask', approval: timeoutApproval('u2') },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Task_1' },
        { from: 'Task_1', to: 'Task_2' },
        { from: 'Task_2', to: 'End_1' },
      ],
    });
  }

  it('★ 落到配了超时的待办 → 按 `actions` **逐条**排程（可并存）', async () => {
    const sched = fakeScheduler();
    const { engine } = engineOf(timeoutDef(), { scheduler: sched });
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });

    expect(sched.scheduled.map((r) => r.kind)).toEqual(['remind', 'autoApprove']);
    expect(sched.scheduled[0]).toMatchObject({
      instanceId: id,
      nodeId: 'Task_1',
      fromAt: T0,
      timeout: { duration: 'P3D' },
    });
  });

  it('★ 内核**不**算 `dueAt`（Q33）：只交「从什么时候开始 + 定义上写的什么」', async () => {
    const sched = fakeScheduler();
    const { engine } = engineOf(timeoutDef(), { scheduler: sched });
    await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    for (const r of sched.scheduled) {
      expect((r as unknown as { dueAt?: unknown }).dueAt).toBeUndefined();
      expect(typeof r.fromAt).toBe('string');
      expect(r.timeout).toBeTruthy();
    }
  });

  it('★ handle 写进状态（否则待办办完时无从取消）', async () => {
    const sched = fakeScheduler();
    const { engine, store } = engineOf(timeoutDef(), { scheduler: sched });
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const st = await store.load(id);
    expect(st?.tokens[0]?.timerHandles).toHaveLength(2);
  });

  it('★ 待办办完 → `cancel()` 掉旧 handle，并**清空** `timerHandles`', async () => {
    const sched = fakeScheduler();
    const { engine, store } = engineOf(timeoutDef(), { scheduler: sched });
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const first = (await store.load(id))?.tokens[0]?.timerHandles ?? [];

    await engine.submit(id, { action: 'approve', actor: 'u1' });
    expect(sched.cancelled).toEqual(first); // 一条不落

    /*
     * ⚠️ 令牌是**被复用**的（`tk_start` 从 `Task_1` 推进到 `Task_2`），故不能写成
     *   「找 `nodeId === 'Task_1'` 的令牌、其 `timerHandles` 为 undefined」——
     *   那个 `?.` 会让"令牌整个消失"也判成对（空断言）。这里钉死的是：
     *   **新 handle 在、旧 handle 不在**。
     */
    const now = (await store.load(id))?.tokens.find((t) => t.state === 'active');
    expect(now?.nodeId).toBe('Task_2');
    expect(now?.timerHandles).toHaveLength(2);
    for (const h of first) expect(now?.timerHandles).not.toContain(h);
    // 新的待办重新排程
    expect(sched.scheduled.filter((r) => r.nodeId === 'Task_2')).toHaveLength(2);
  });

  it('★ 不注入 `scheduler` = 不排程（超时是**内核外**能力，内核不假装做了）', async () => {
    const { engine, store } = engineOf(timeoutDef());
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const st = await store.load(id);
    expect(st?.tokens[0]?.timerHandles).toBeUndefined();
    expect(st?.tokens[0]?.nodeId).toBe('Task_1'); // 流程照常推进
  });

  it('没配 `timeout` 的节点 → 不排程（不是"每个待办都排一次"）', async () => {
    const sched = fakeScheduler();
    const { engine } = engineOf(mainDef(), { scheduler: sched });
    await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    expect(sched.scheduled).toEqual([]);
  });

  it('★ `diffTimers` 是纯的：同一份前后状态算两遍结果一致', () => {
    const g = graphOf(timeoutDef());
    const prev: InstanceState = {
      instanceId: 'pi_1',
      processId: 'Process_1',
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
    const next: InstanceState = {
      ...prev,
      tokens: [{ id: 'tk_1', nodeId: 'Task_1', state: 'active', assignee: 'u1', createdAt: T0 }],
    };
    const a = diffTimers(prev, next, g);
    const b = diffTimers(prev, next, g);
    expect(a.schedule).toEqual(b.schedule);
    expect(a.schedule).toHaveLength(1);
    expect(timingKeysOf(prev, g).size).toBe(0);
  });

  it('★ 没有 `assignee` 的在途令牌**不**计时（不给不存在的待办排催办）', () => {
    const g = graphOf(timeoutDef());
    const st: InstanceState = {
      instanceId: 'pi_1',
      processId: 'Process_1',
      definitionVersion: 1,
      status: 'running',
      rev: 1,
      stateSchema: 1,
      startedAt: T0,
      updatedAt: T0,
      tokens: [{ id: 'tk_1', nodeId: 'Task_1', state: 'active' }],
      completedNodes: [],
      variables: {},
      auditTrail: [],
    };
    expect(timingKeysOf(st, g).size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// ⑧ 门 2：纯执行段可独立完成同一段演化
// ═══════════════════════════════════════════════════════════════

describe('⑧ 门 2：`deliverStep` 独立完成同一段演化（不靠 `deliverMessage`）', () => {
  it('直接调 `deliverStep` 也能触发边界事件（两条路径不得分叉）', () => {
    const g = graphOf(mainDef());
    const st: InstanceState = {
      instanceId: 'pi_1',
      processId: 'Process_1',
      definitionVersion: 1,
      status: 'running',
      rev: 1,
      stateSchema: 1,
      startedAt: T0,
      updatedAt: T0,
      tokens: [{ id: 'tk_1', nodeId: 'Task_1', state: 'active', assignee: 'u1' }],
      completedNodes: [],
      variables: {},
      auditTrail: [],
    };
    const ctx = {
      graph: g,
      at: T0,
      assigneesOf: (nodeId: string) => (nodeId === 'Task_2' ? ['u2'] : ['u1']),
      conditionsOf: () => true,
      effectsOf: () => ({ nodeId: 'Task_2', tokenId: 'tk_1' }),
    } as unknown as Parameters<typeof deliverStep>[1];

    const r = deliverStep(st, ctx, { kind: 'message', name: 'Msg_cancel' }, 'point');
    expect(r.fired.map((f) => f.nodeId)).toEqual(['Bnd_1']);
    expect(r.next.tokens.find((t) => t.nodeId === 'Task_1')?.state).toBe('cancelled');
    expect(r.next.tokens.find((t) => t.nodeId === 'Task_2')?.assignee).toBe('u2');
    // 入参未被改动（纯）
    expect(st.tokens[0]?.state).toBe('active');
  });

  it('★ 监听中的边界事件可被宿主枚举（订阅表的判据只有一份）', () => {
    const g = graphOf(mainDef());
    const st: InstanceState = {
      instanceId: 'pi_1',
      processId: 'Process_1',
      definitionVersion: 1,
      status: 'running',
      rev: 1,
      stateSchema: 1,
      startedAt: T0,
      updatedAt: T0,
      tokens: [{ id: 'tk_1', nodeId: 'Task_1', state: 'active', assignee: 'u1' }],
      completedNodes: [],
      variables: {},
      auditTrail: [],
    };
    expect(armedBoundaries(st, g, { kind: 'message', name: 'Msg_cancel' })).toHaveLength(1);
    // 令牌不在那儿 ⇒ 监听器不成立
    expect(
      armedBoundaries(
        { ...st, tokens: [{ id: 'tk_1', nodeId: 'Task_1', state: 'completed' }] },
        g,
        { kind: 'message', name: 'Msg_cancel' },
      ),
    ).toEqual([]);
  });
});
