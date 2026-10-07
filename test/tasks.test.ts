/**
 * T17 · 任务 8 类的执行语义
 *
 * ★ 本档的重点不是"分类表能跑通"，而是三条**红线**：
 *   ① **引擎绝不执行任意 JS**（源码扫描 + 运行期路径双向钉死）；
 *   ② **副作用只发生一次**（`serviceTask` 不得因惰性解析的重跑被调 N 次）；
 *   ③ **未配置必须报错**（`businessRuleTask` 没注入 `decisionHandler` 就报"未配置"，不静默跳过）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ENGINE_ERROR_CODES } from '../src/core/errors';
import type { EngineEvent, TaskEvent } from '../src/core/events';
import { createProcessGraph } from '../src/nodes/graph';
import {
  NO_EFFECT,
  TASK_TYPES,
  assertTaskSupported,
  assertVariablePatch,
  asUnresolvedEffect,
  effectKindOf,
  isFeelScriptFormat,
  taskBehaviorOf,
  unresolvedEffect,
} from '../src/nodes/tasks';
import { createEngine } from '../src/runtime/engine';
import { createMemoryStore } from '../src/store/memory';
import { makeDefinition, singleVersionSource, userApproval } from './helpers/definition';
import { expectCodeAsync } from './helpers/expect';

const T0 = '2026-10-01T00:00:00.000Z';

/** 收事件的假 `EventSink` */
function sinkOf(): { events: EngineEvent[]; emit(e: EngineEvent): void } {
  const events: EngineEvent[] = [];
  return { events, emit: (e) => void events.push(e) };
}

function engineOf(
  def: ReturnType<typeof makeDefinition>,
  extra: Partial<Parameters<typeof createEngine>[0]> = {},
) {
  const sink = sinkOf();
  const store = createMemoryStore();
  const engine = createEngine({
    definitionSource: singleVersionSource('Process_1', 1, def),
    clock: () => T0,
    events: { emit: sink.emit },
    ...extra,
    // ★ `store` 放最后：本档的测试要拿它读 `variables`，调用方不得顶掉
    store,
  });
  return { engine, sink, store };
}

/** 一个节点 + 起止；`node` 由调用方给全 */
function defWith(node: Record<string, unknown>): ReturnType<typeof makeDefinition> {
  return makeDefinition({
    nodes: [
      { id: 'Start_1', type: 'startEvent' },
      { id: 'Node_1', type: 'manualTask', ...node } as never,
      { id: 'Task_1', type: 'userTask', approval: userApproval('u1') },
      { id: 'End_1', type: 'endEvent' },
    ],
    flows: [
      { from: 'Start_1', to: 'Node_1' },
      { from: 'Node_1', to: 'Task_1' },
      { from: 'Task_1', to: 'End_1' },
    ],
  });
}

// ---------------- ① 分类 ----------------

describe('① 任务 8 类的分类（`03-engine` §6）', () => {
  it('TASK_TYPES 恰好 8 类，且行为映射全覆盖', () => {
    expect(TASK_TYPES).toHaveLength(8);
    for (const t of TASK_TYPES) {
      expect(taskBehaviorOf(t), t).toBeDefined();
    }
  });

  it('行为归类：1 等待 / 4 副作用 / 1 等投递 / 1 直通 / 1 未实现', () => {
    expect(taskBehaviorOf('userTask')).toBe('wait');
    for (const t of ['serviceTask', 'scriptTask', 'businessRuleTask', 'manualTask']) {
      expect(taskBehaviorOf(t), t).toBe('effect');
    }
    // ★ T20：`receiveTask` 从「未实现」变成「等外部消息」（与 intermediateCatchEvent 同档）
    expect(taskBehaviorOf('receiveTask')).toBe('catch');
    expect(taskBehaviorOf('task')).toBe('pass');
    expect(taskBehaviorOf('sendTask')).toBe('unsupported');
  });

  it('非任务类型 → `undefined`（留给事件 / 网关 / 数据的分类）', () => {
    for (const t of ['startEvent', 'endEvent', 'exclusiveGateway', 'subProcess', 'nonsense']) {
      expect(taskBehaviorOf(t), t).toBeUndefined();
    }
  });

  it('effectKindOf 与行为表**不打架**（是 effect 就有 kind，不是就没有）', () => {
    for (const t of TASK_TYPES) {
      const isEffect = taskBehaviorOf(t) === 'effect';
      expect(effectKindOf(t) !== undefined, t).toBe(isEffect);
    }
  });
});

// ---------------- ② ★ 禁止执行任意 JS ----------------

describe('② ★ 禁止 `eval` / `new Function` / `node:vm`（`03` §6 红线）', () => {
  /** 递归列出 `src/` 下全部 `.ts` */
  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...tsFiles(p));
      else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  /**
   * 去掉注释再扫。
   *
   * ⚠️ 必须去：**本包的注释里正大光明地写着「禁止 `eval` / `new Function` / `node:vm`」**
   *    （那是规格引用，不是代码）。不去注释的话，这道门禁会因为"文档里提到了它"而红 ——
   *    那等于逼着实现把红线从注释里删掉，是本末倒置。
   */
  function stripComments(src: string): string {
    let out = '';
    let inBlock = false;
    for (const line of src.split('\n')) {
      let s = '';
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        const next = line[i + 1];
        if (inBlock) {
          if (c === '*' && next === '/') {
            inBlock = false;
            i += 1;
          }
          continue;
        }
        if (c === '/' && next === '*') {
          inBlock = true;
          i += 1;
          continue;
        }
        if (c === '/' && next === '/') break;
        s += c;
      }
      out += `${s}\n`;
    }
    return out;
  }

  it('源码扫描：`src/**` 里不出现这三种写法', () => {
    const files = tsFiles(join(process.cwd(), 'src'));
    expect(files.length).toBeGreaterThan(10); // 别让扫描悄悄变成 0 个文件
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'));
      expect(src, `${f} 出现 new Function`).not.toMatch(/new\s+Function/);
      expect(src, `${f} 出现 node:vm`).not.toMatch(/['"`]node:vm['"`]/);
      // `eval(` —— 排除 `.evaluate(` / `reevaluate(` 等以 eval 结尾的标识符
      expect(src, `${f} 出现 eval(`).not.toMatch(/(^|[^\w.])eval\s*\(/);
    }
  });

  it('★ 唯一的脚本执行入口是 `@floken-io/feel`，不是 JS 引擎', async () => {
    // `scriptFormat: 'javascript'` 且**没有**注册 handler → 必须报错，绝不执行
    const { engine } = engineOf(
      defWith({ type: 'scriptTask', scriptFormat: 'javascript', script: '1 + 1' }),
    );
    await expectCodeAsync(engine.start('Process_1', { definitionVersion: 1, starter: 'u0' }),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
  });
});

// ---------------- ③ `scriptFormat` = FEEL 的识别 ----------------

describe('③ `isFeelScriptFormat`（白名单，不是"含 feel 就算"）', () => {
  it.each(['feel', 'FEEL', ' feel ', 'feel/', 'text/feel', 'application/feel'])('%p → true', (f) => {
    expect(isFeelScriptFormat(f)).toBe(true);
  });

  it('OMG 的 FEEL URN 也认（按"以 /feel 结尾"判，列不全就不穷举）', () => {
    expect(isFeelScriptFormat('http://www.omg.org/spec/FEEL/20140401')).toBe(true);
  });

  it.each(['javascript', 'groovy', 'python', '##unspecified', '', '   ', undefined])(
    '%p → false',
    (f) => {
      expect(isFeelScriptFormat(f)).toBe(false);
    },
  );
});

// ---------------- ④ 未实现的两类：显式抛 ----------------

describe('④ `sendTask`：显式抛并指名归属（不静默直通；`receiveTask` 已随 T20 落地为等投递）', () => {
  it.each(['sendTask'])('%s → 抛 STATE_SHAPE_INVALID 且带 owner', (type) => {
    expect(() => assertTaskSupported(type, 'Node_1', 'unsupported')).toThrow(/not executable yet/);
    try {
      assertTaskSupported(type, 'Node_1', 'unsupported');
    } catch (e) {
      const d = (e as { details?: Record<string, unknown> }).details ?? {};
      expect(String(d.owner)).toContain('FR-E14');
    }
  });

  it('已实现的 6 类**不抛**（判据是 behavior，不是类型名）', () => {
    for (const t of TASK_TYPES) {
      const b = taskBehaviorOf(t);
      if (b === undefined || b === 'unsupported') continue;
      expect(() => assertTaskSupported(t, 'Node_1', b)).not.toThrow();
    }
  });

  it('★ 运行期：令牌落到 `receiveTask` → 停在它上面等投递（T20；端到端断言见 `deliver.test.ts`）', async () => {
    const { engine, store } = engineOf(defWith({ type: 'receiveTask', messageRef: 'Msg_paid' }));
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const st = await store.load(id);
    expect(st?.tokens[0]?.nodeId).toBe('Node_1');
    expect(st?.tokens[0]?.awaiting).toEqual({ kind: 'message', name: 'Msg_paid' });
    expect(st?.status).toBe('running');
  });

  it('★ 运行期：`receiveTask` 缺 `messageRef` → 抛（等不到 = 永久卡死，不得放行）', async () => {
    const { engine } = engineOf(defWith({ type: 'receiveTask' }));
    await expectCodeAsync(engine.start('Process_1', { definitionVersion: 1, starter: 'u0' }),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
  });

  it('★ 运行期：令牌落到 `sendTask` → 抛（D-56：ADR-006 事件集定死 10 个，无"抛出事件"）', async () => {
    const { engine } = engineOf(defWith({ type: 'sendTask' }));
    await expectCodeAsync(engine.start('Process_1', { definitionVersion: 1, starter: 'u0' }),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
  });
});

// ---------------- ⑤ `serviceTask` ----------------

describe('⑤ `serviceTask`：查 `handlers` 表', () => {
  it('★ 调用**一次**，返回值并入变量', async () => {
    const fn = vi.fn(async () => ({ ticket: 'T-1' }));
    const { engine, store } = engineOf(
      defWith({ type: 'serviceTask', implementation: 'createTicket' }),
      { handlers: { get: (ref) => (ref === 'createTicket' ? fn : undefined) } },
    );
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    expect(fn).toHaveBeenCalledTimes(1);

    const state = await store.load(id);
    expect(state?.variables.ticket).toBe('T-1');
  });

  it('★ `handlerRef` 的三级回退：`implementation`（非 `##`）→ `operationRef` → `nodeId`', () => {
    const g = createProcessGraph(
      makeDefinition({
        nodes: [
          { id: 'Start_1', type: 'startEvent' },
          { id: 'A', type: 'serviceTask', implementation: 'impl_a' },
          { id: 'B', type: 'serviceTask', implementation: '##WebService', operationRef: 'op_b' },
          { id: 'C', type: 'serviceTask' },
        ],
        flows: [],
      }),
      'Process_1',
      1,
    );
    expect(g.handlerRefOf('A')).toBe('impl_a');
    // `##WebService` 是 BPMN 的**实现标识**，不是宿主处理器的名字 —— 必须被跳过
    expect(g.handlerRefOf('B')).toBe('op_b');
    expect(g.handlerRefOf('C')).toBe('C'); // 缺省用 nodeId：零配置可用形态
  });

  it('未注册 handler → 抛 OPTION_INVALID，且 message 指名 `handlers`', async () => {
    const { engine } = engineOf(defWith({ type: 'serviceTask', implementation: 'nope' }), {
      handlers: { get: () => undefined },
    });
    await expectCodeAsync(engine.start('Process_1', { definitionVersion: 1, starter: 'u0' }),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
  });

  it('handler 返回非对象 → 抛（静默当"没有变量"= 最难查的一类失败）', async () => {
    const { engine } = engineOf(defWith({ type: 'serviceTask' }), {
      handlers: { get: () => (async () => undefined) as never },
    });
    await expectCodeAsync(engine.start('Process_1', { definitionVersion: 1, starter: 'u0' }),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
  });
});

// ---------------- ⑥ `scriptTask` ----------------

describe('⑥ `scriptTask`：FEEL 走内置求值，其余走 `handlers`', () => {
  it('★ 非 FEEL 格式 + 注册了 handler → 调 handler（宿主执行，引擎不碰 JS）', async () => {
    const fn = vi.fn(async () => ({ ok: true }));
    const { engine } = engineOf(
      defWith({ type: 'scriptTask', scriptFormat: 'groovy', script: 'x = 1' }),
      { handlers: { get: () => fn } },
    );
    await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('非 FEEL 格式 + 没 handler → 抛，且错误里指名 `handlers`', async () => {
    const { engine } = engineOf(
      defWith({ type: 'scriptTask', scriptFormat: 'groovy', script: 'x = 1' }),
    );
    await expectCodeAsync(engine.start('Process_1', { definitionVersion: 1, starter: 'u0' }),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
  });

  it('★ FEEL 格式 → 内置求值，结果落在 `variables[nodeId]`（**D-59**）', async () => {
    const { engine, store } = engineOf(
      defWith({ type: 'scriptTask', scriptFormat: 'feel', script: '1 + 2' }),
    );
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const state = await store.load(id);
    expect(state?.variables.Node_1).toBe(3);
  });

  it('★ FEEL 结果是 `null` 也照写（脚本要的是**数据**，不是二值 —— 与条件相反）', async () => {
    const { engine, store } = engineOf(
      defWith({ type: 'scriptTask', scriptFormat: 'feel', script: 'unknownVar' }),
    );
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const state = await store.load(id);
    expect(state?.variables.Node_1).toBeNull();
  });

  it('FEEL 语法错 → 抛（不得"脚本写坏了也跑下去"）', async () => {
    const { engine } = engineOf(
      defWith({ type: 'scriptTask', scriptFormat: 'feel', script: '1 +' }),
    );
    await expect(engine.start('Process_1', { definitionVersion: 1, starter: 'u0' })).rejects.toThrow();
  });

  it('★ `${...}`（JUEL）在脚本里同样被拦（与条件走同一条越界判定）', async () => {
    const { engine } = engineOf(
      defWith({ type: 'scriptTask', scriptFormat: 'feel', script: '${vars.a}' }),
    );
    await expectCodeAsync(engine.start('Process_1', { definitionVersion: 1, starter: 'u0' }),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
  });

  it('★ 不写 `scriptFormat`（= `script.language`）→ **按 FEEL 求值**（"缺省按 FEEL"是真的）', async () => {
    const { engine, store } = engineOf(defWith({ type: 'scriptTask', script: '1 + 2' }));
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    const state = await store.load(id);
    expect(state?.variables.Node_1).toBe(3);
  });

  it('FEEL 但没有 `<script>` → 抛（定义不完整，不得静默跳过）', async () => {
    const { engine } = engineOf(defWith({ type: 'scriptTask', scriptFormat: 'feel' }));
    await expectCodeAsync(engine.start('Process_1', { definitionVersion: 1, starter: 'u0' }),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
  });
});

// ---------------- ⑦ `businessRuleTask` ----------------

describe('⑦ `businessRuleTask`：走 `decisionHandler`', () => {
  it('★ 未注入 → 报「未配置」（D-24 同口径：真因是"没注入"，不是"算不出"）', async () => {
    const { engine } = engineOf(defWith({ type: 'businessRuleTask' }));
    await expectCodeAsync(engine.start('Process_1', { definitionVersion: 1, starter: 'u0' }),
      ENGINE_ERROR_CODES.OPTION_INVALID,
    );
  });

  it('注入后并入返回值', async () => {
    const fn = vi.fn(async () => ({ grade: 'A' }));
    const { engine } = engineOf(defWith({ type: 'businessRuleTask' }), {
      decisionHandler: { evaluate: fn },
    });
    await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ---------------- ⑧ ★ `manualTask` 与裸 `task` 的差别 = 是否留痕 ----------------

describe('⑧ `manualTask` vs 裸 `task`（差别 = 是否留痕）', () => {
  it('★ `manualTask`：连发 `taskCreated` + `taskCompleted`，且不产生待办、不等待', async () => {
    const { engine, sink, store } = engineOf(defWith({ type: 'manualTask', name: '人工归档' }));
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });

    // 不等待：起点 → manualTask → userTask 一步到位（令牌没停在 Node_1 上）
    const state = await store.load(id);
    expect(state?.tokens.filter((t) => t.state === 'active').map((t) => t.nodeId)).toEqual([
      'Task_1',
    ]);

    const manual = sink.events.filter(
      (e) => (e as TaskEvent).nodeId === 'Node_1' && (e.name === 'taskCreated' || e.name === 'taskCompleted'),
    );
    expect(manual.map((e) => e.name)).toEqual(['taskCreated', 'taskCompleted']);
    const first = manual[0] as TaskEvent;
    expect(first.taskId).toBe('Node_1:tk_start');
    expect(first.nodeName).toBe('人工归档');
    expect(first.taskStatus).toBe('active');
    expect((manual[1] as TaskEvent).taskStatus).toBe('done');
    // ★ 与裸 `task` 的对照：`taskCreated` 那条**没有** assignee（不产生待办）
    expect(first.assignee).toBeUndefined();
    // 两条事件与本次动作同源（`start`）
    expect(first.action.name).toBe('start');
  });

  it('★ 裸 `task`：**一条事件都不发**（直通、无副作用）', async () => {
    const { engine, sink } = engineOf(defWith({ type: 'task', name: '空任务' }));
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
    await engine.submit(id, { action: 'approve', actor: 'u1', at: T0 });
    expect(sink.events.some((e) => (e as TaskEvent).nodeId === 'Node_1')).toBe(false);
  });
});

// ---------------- ⑨ ★ 副作用只发生一次 ----------------

describe('⑨ ★ 副作用只发生一次（惰性解析的重跑不得重复调宿主）', () => {
  it('★ `serviceTask` + 依赖其结果的排他网关：两个惰性解析交叉，服务仍只被调 1 次', async () => {
    const def = makeDefinition({
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Svc_1', type: 'serviceTask', implementation: 'score' },
        {
          id: 'GW_1',
          type: 'exclusiveGateway',
          defaultFlow: 'F_low',
        },
        { id: 'Task_high', type: 'userTask', approval: userApproval('u_boss') },
        { id: 'Task_low', type: 'userTask', approval: userApproval('u_staff') },
        { id: 'End_1', type: 'endEvent' },
      ],
      flows: [
        { from: 'Start_1', to: 'Svc_1' },
        { id: 'F_high', from: 'GW_1', to: 'Task_high', condition: 'score > 80' },
        { id: 'F_low', from: 'GW_1', to: 'Task_low' },
        { from: 'Svc_1', to: 'GW_1' },
        { from: 'Task_high', to: 'End_1' },
        { from: 'Task_low', to: 'End_1' },
      ],
    });

    const fn = vi.fn(async () => ({ score: 90 }));
    const { engine, store } = engineOf(def, { handlers: { get: () => fn } });
    const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });

    expect(fn).toHaveBeenCalledTimes(1); // ★ 关键断言：重跑不得重复调
    /*
     * ★ 并且条件确实用的是**服务写进去的** score（不是提交前的旧变量）：
     *   90 > 80 ⇒ 落在 `Task_high`。若这里落到 `Task_low`，说明条件拿的是旧变量 ——
     *   「脚本/服务把 amount 改了、网关却按旧值走分支」这条事故就真的存在。
     */
    const state = await store.load(id);
    expect(state?.tokens.filter((t) => t.state === 'active').map((t) => t.nodeId)).toEqual([
      'Task_high',
    ]);
  });
});

// ---------------- ⑩ 副作用的形状与哨兵 ----------------

describe('⑩ `NodeEffect` 与哨兵', () => {
  it('哨兵往返：`asUnresolvedEffect` 认得出自己，也认不出别的错', () => {
    const e = unresolvedEffect({ nodeId: 'N', tokenId: 'tk', kind: 'service', variables: { a: 1 } });
    expect(e.key).toBe('N::tk');
    expect(asUnresolvedEffect(e)?.nodeId).toBe('N');
    expect(asUnresolvedEffect(new Error('boom'))).toBeUndefined();
    expect(asUnresolvedEffect(undefined)).toBeUndefined();
  });

  it('★ 缓存键必须带 tokenId（并行分支上两个令牌会同时到达同一个服务节点）', () => {
    const a = unresolvedEffect({ nodeId: 'N', tokenId: 'tk_1', kind: 'service', variables: {} });
    const b = unresolvedEffect({ nodeId: 'N', tokenId: 'tk_2', kind: 'service', variables: {} });
    expect(a.key).not.toBe(b.key);
  });

  it('`assertVariablePatch`：只接受扁平对象', () => {
    expect(assertVariablePatch('N', 'service', { a: 1 })).toEqual({ a: 1 });
    for (const bad of [undefined, null, [], 'x', 1]) {
      expect(() => assertVariablePatch('N', 'service', bad), String(bad)).toThrow();
    }
  });

  it('`NO_EFFECT` 是"什么都没有"（既无变量也无事件）', () => {
    expect(NO_EFFECT.variables).toBeUndefined();
    expect(NO_EFFECT.events).toBeUndefined();
  });
});
