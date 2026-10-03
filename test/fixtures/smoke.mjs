#!/usr/bin/env node
/**
 * 冷启动探针 —— **真跑 `dist/` 产物**，不是跑 `src/`。
 *
 * 为什么必须单独有它：`vitest` 的全部用例都经 transform 跑 `src/`，因此它们**无法回答**
 * 「发布出去的那个包，宿主到底能不能 import、能不能用」。本文件刻意用纯 JS + `.mjs`，
 * 只依赖 `package.json` 的 `exports` 解析，复刻宿主的最小使用场景。
 *
 * 前置：已 `npm run build`（`verify` 的 `check:pack` 会兜底检查产物存在）。
 * 用法：`node test/fixtures/smoke.mjs`；全绿则打印 `SMOKE OK` 且退出码 0。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const results = [];
const ok = (name) => results.push([true, name]);
const fail = (name, msg) => results.push([false, `${name} — ${msg}`]);

function check(name, fn) {
  try {
    fn();
    ok(name);
  } catch (e) {
    fail(name, e instanceof Error ? e.message : String(e));
  }
}

/** 异步版 —— 用于真的要跑一遍存储等异步路径的冒烟 */
async function checkAsync(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(name, e instanceof Error ? e.message : String(e));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, what) {
  assert(actual === expected, `${what}：期望 ${expected}，实得 ${actual}`);
}
function sameArray(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  assert(a === b, `${what} 不一致：\n    实得 ${a}\n    期望 ${b}`);
}
const byPrefix = (codes, prefix) => codes.filter((c) => c.startsWith(`ENGINE_${prefix}_`)).length;

// ① 先证明「跑的是产物」—— 否则后面的断言可能全在测 src 的幻觉
const resolved = import.meta.resolve('@floken-io/engine');
check('自引用解析落在 dist/index.js（证明跑的是产物而非源码）', () => {
  assert(resolved.endsWith('/dist/index.js'), `解析到 ${resolved}`);
});

const m = await import('@floken-io/engine');

// ---------------- 包标识 ----------------

check('包标识', () => eq(m.PACKAGE, '@floken-io/engine', 'PACKAGE'));

// ---------------- SPI 11 项 ----------------

check('SPI 共 11 项', () => eq(m.SPI_NAMES.length, 11, 'SPI_NAMES.length'));

check('SPI 分组 3+4+2+2，且扁平化后与 SPI_NAMES 逐项一致', () => {
  const g = m.SPI_GROUPS;
  eq(g.storage.length, 3, 'storage 组');
  eq(g.business.length, 4, 'business 组');
  eq(g.eval.length, 2, 'eval 组');
  eq(g.exit.length, 2, 'exit 组');
  const flat = [...g.storage, ...g.business, ...g.eval, ...g.exit];
  sameArray(flat, m.SPI_NAMES, '分组扁平化结果 vs SPI_NAMES（顺序也算契约）');
});

// ---------------- 错误码 ----------------

check('抛出码 20 个（ACTION 8 / STATE 7 / PERSIST 2 / OPTION 2 / PEER 1）', () => {
  const codes = Object.values(m.ENGINE_ERROR_CODES);
  eq(codes.length, 20, '总数');
  eq(byPrefix(codes, 'ACTION'), 8, 'ACTION 族');
  eq(byPrefix(codes, 'STATE'), 7, 'STATE 族');
  eq(byPrefix(codes, 'PERSIST'), 2, 'PERSIST 族');
  eq(byPrefix(codes, 'OPTION'), 2, 'OPTION 族');
  // Q49（2026-10-03）：五个包之间一律 peer，缺失在运行期才暴露 → 新增 PEER 族。
  eq(byPrefix(codes, 'PEER'), 1, 'PEER 族');
  eq(
    byPrefix(codes, 'ACTION') +
      byPrefix(codes, 'STATE') +
      byPrefix(codes, 'PERSIST') +
      byPrefix(codes, 'OPTION') +
      byPrefix(codes, 'PEER'),
    20,
    '五族之和',
  );
  assert(new Set(codes).size === codes.length, '码值有重复');
  // T12 新增：门 1 否决。与 ACTION_NOT_ALLOWED 的区别是「设计期开关 vs 运行期宿主否决」
  eq(m.ENGINE_ERROR_CODES.ACTION_VETOED, 'ENGINE_ACTION_VETOED', 'ACTION_VETOED');
});

check('诊断码 2 个，且与抛出码零交集（双命名空间不重叠）', () => {
  const t = Object.values(m.ENGINE_ERROR_CODES);
  const d = Object.values(m.ENGINE_DIAGNOSTIC_CODES);
  eq(d.length, 2, '诊断码数');
  const overlap = d.filter((c) => t.includes(c));
  eq(overlap.length, 0, `交集：${overlap.join(', ') || '无'}`);
});

// ---------------- 错误类 ----------------

check('EngineError 可用：instanceof / floken 印记 / pkg / code', () => {
  const e = new m.EngineError('boom', { code: m.ENGINE_ERROR_CODES.STATE_NOT_FOUND });
  assert(e instanceof Error, '不是 Error 实例');
  assert(e instanceof m.EngineError, '不是 EngineError 实例');
  eq(e.floken, true, 'floken');
  eq(e.pkg, 'engine', 'pkg');
  eq(e.name, 'EngineError', 'name');
  eq(e.code, 'ENGINE_STATE_NOT_FOUND', 'code');
});

check('四个错误子类均已公开且继承链正确', () => {
  for (const n of ['EngineActionError', 'EngineStateError', 'EnginePersistError', 'EngineOptionError']) {
    assert(typeof m[n] === 'function', `缺少导出 ${n}`);
    const e = new m[n]('x', { code: m.ENGINE_ERROR_CODES.STATE_NOT_FOUND });
    assert(e instanceof m.EngineError, `${n} 未继承 EngineError`);
    eq(e.name, n, `${n}.name`);
  }
});

check('persistConflict / persistAlreadyExists 已公开（宿主自研 StateStore 必需）', () => {
  const c = m.persistConflict('pi_1', 3);
  eq(c.code, 'ENGINE_PERSIST_CONFLICT', 'persistConflict.code');
  assert(c instanceof m.EnginePersistError, 'persistConflict 类型不对');
  eq(c.instanceId, 'pi_1', 'persistConflict.instanceId');

  const a = m.persistAlreadyExists('pi_1');
  eq(a.code, 'ENGINE_PERSIST_ALREADY_EXISTS', 'persistAlreadyExists.code');
  assert(a instanceof m.EnginePersistError, 'persistAlreadyExists 类型不对');
});

// ---------------- 事件（节点级 5 + 实例级 5） ----------------

check('事件名 5 + 5 = 10，且全表与两个分表一致', () => {
  eq(m.TASK_EVENT_NAMES.length, 5, 'TASK_EVENT_NAMES');
  eq(m.INSTANCE_EVENT_NAMES.length, 5, 'INSTANCE_EVENT_NAMES');
  eq(m.ENGINE_EVENT_NAMES.length, 10, 'ENGINE_EVENT_NAMES');
  sameArray([...m.TASK_EVENT_NAMES, ...m.INSTANCE_EVENT_NAMES], m.ENGINE_EVENT_NAMES, 'ENGINE_EVENT_NAMES vs 两个分表');
});

// ---------------- 状态枚举 ----------------

check('状态枚举与状态机辅助', () => {
  eq(m.STATE_SCHEMA_VERSION, 1, 'STATE_SCHEMA_VERSION');
  eq(m.INSTANCE_STATUSES.length, 5, 'INSTANCE_STATUSES');
  eq(m.TERMINAL_STATUSES.length, 3, 'TERMINAL_STATUSES');
  eq(m.TOKEN_STATES.length, 4, 'TOKEN_STATES');
  eq(m.TASK_STATUSES.length, 5, 'TASK_STATUSES');

  assert(m.isTerminalStatus('completed') === true, "isTerminalStatus('completed') 应为 true");
  assert(m.isTerminalStatus('running') === false, "isTerminalStatus('running') 应为 false");
  for (const s of m.TERMINAL_STATUSES) {
    assert(m.INSTANCE_STATUSES.includes(s), `终态 '${s}' 不在 INSTANCE_STATUSES 中`);
  }
});

// ---------------- 内核原语（`03` §3：10 个，业务无知） ----------------

check('内核原语 10 个（8 令牌级 + 2 实例级）', () => {
  eq(m.PRIMITIVE_NAMES.length, 10, 'PRIMITIVE_NAMES.length');
  eq(m.PRIMITIVE_GROUPS.token.length, 8, '令牌级');
  eq(m.PRIMITIVE_GROUPS.instance.length, 2, '实例级');
  sameArray(
    [...m.PRIMITIVE_GROUPS.token, ...m.PRIMITIVE_GROUPS.instance],
    m.PRIMITIVE_NAMES,
    '分组扁平化结果 vs PRIMITIVE_NAMES（顺序也算契约）',
  );
  sameArray(m.PRIMITIVE_GROUPS.instance, ['suspend', 'resume'], '实例级成员');
});

/**
 * ★ 反向断言：**原语函数本体不导出**（只导出计数契约）。
 * 原语是内核内部实现（这一层不认识"驳回"），宿主接引擎用的是 19 项动作；
 * 导出函数会让内核改动背上 semver 约束。没有这条，将来一句 `export *` 就破了。
 */
check('原语函数本体未泄漏进公开面（只导出计数契约）', () => {
  const primitives = [
    'advance', 'jumpTo', 'rollbackTo', 'spawnInstances', 'cancelInstances',
    'transfer', 'delegate', 'halt', 'suspend', 'resume', 'primitives',
  ];
  const leaked = primitives.filter((k) => k in m);
  eq(leaked.length, 0, `被意外导出的原语：${leaked.join(', ') || '无'}`);
});

// ---------------- 反向断言：内部符号不得泄漏 ----------------

/**
 * 把 `entries/index.ts` 的**导出面裁决**变成可执行断言。
 * 没有这条，将来有人图省事写一句 `export * from '../core/state.js'` 就能把
 * `cloneState` / `migrateState` 这类内部工具变成事实上的公开 API（受 semver 约束）。
 */
check('内部工具未泄漏进公开面（导出面裁决被遵守）', () => {
  const forbidden = [
    'cloneState',
    'deepEqual',
    'assertRoundTrip',
    'assertSerializable',
    'findNonSerializableValue',
    'isSerializable',
    'assertInstanceState',
    'migrateState',
    'STATE_MIGRATIONS',
    'isEmptyDelta',
    'touchedTaskIds',
    'actionUnknown',
    'optionInvalid',
    // T12：门 1 只读的实现手段是**内部工具**，宿主不需要（也不该依赖）它
    'freezeActionContext',
    'markCompleted',
  ];
  const leaked = forbidden.filter((k) => k in m);
  eq(leaked.length, 0, `被意外导出的内部符号：${leaked.join(', ') || '无'}`);
});

// ---------------- T5 冒烟：内存 store 真的跑一遍 ----------------

check('createMemoryStore 已公开（NFR-E10「默认内存」可观测）', () => {
  eq(typeof m.createMemoryStore, 'function', 'createMemoryStore');
  const s = m.createMemoryStore();
  // ★ 顺手钉死「StateStore 只该有两个方法」—— 禁止长出事务接口，也禁止长出 clear()/size()
  sameArray(Object.keys(s).sort(), ['load', 'save'], 'StateStore 的方法集');
});

/**
 * 最小使用路径：`save(INSERT) → load → save(CAS) → load`，并验证陈旧 `rev` 必抛冲突。
 * 这是 `AC-E11` 在**产物层面**的复现 —— vitest 里那份跑的是 `src/`，这份跑的是 `dist/`。
 */
const T0 = '2026-09-30T00:00:00.000Z';
await checkAsync('内存 store 冒烟（AC-E11）：INSERT → load → CAS → load → 冲突', async () => {
  const store = m.createMemoryStore();
  const base = {
    instanceId: 'pi_smoke',
    processId: 'leave-approval',
    definitionVersion: 1,
    status: 'running',
    rev: 0,
    stateSchema: m.STATE_SCHEMA_VERSION,
    startedAt: T0,
    updatedAt: T0,
    tokens: [],
    completedNodes: [],
    variables: { days: 3 },
    auditTrail: [],
  };

  await store.save(base, 0); // INSERT
  const s1 = await store.load('pi_smoke');
  eq(s1.rev, 1, 'INSERT 后 rev');
  eq(s1.variables.days, 3, '变量 JSON 往返');

  await store.save({ ...s1, variables: { days: 5 } }, s1.rev); // CAS
  const s2 = await store.load('pi_smoke');
  eq(s2.rev, 2, 'CAS 后 rev');
  eq(s2.variables.days, 5, 'CAS 后变量');

  // 拿陈旧 rev 再写，必须抛冲突而不是静默覆盖
  let conflict = null;
  try {
    await store.save(s2, s1.rev);
  } catch (e) {
    conflict = e;
  }
  assert(conflict !== null, '陈旧 rev 必须抛错（不得静默覆盖）');
  eq(conflict.code, 'ENGINE_PERSIST_CONFLICT', '冲突码');
  assert(conflict.floken === true, '冲突错误缺 floken 印记');

  // 冲突之后库里应原样不动
  eq((await store.load('pi_smoke')).rev, 2, '冲突后 rev 不得被改动');

  // load() 交给宿主的必须是副本
  const copy = await store.load('pi_smoke');
  copy.variables.days = 999;
  eq((await store.load('pi_smoke')).variables.days, 5, 'load() 必须交出副本');
});

// ---------------- T6 冒烟：`./conformance` 子路径（复刻宿主的真实用法） ----------------

const confPath = import.meta.resolve('@floken-io/engine/conformance');
check('./conformance 子路径解析落在 dist/conformance.js（三处同步生效）', () => {
  assert(confPath.endsWith('/dist/conformance.js'), `解析到 ${confPath}`);
});

const conf = await import('@floken-io/engine/conformance');

check('conformance 公开面 = 4 个运行时导出（内部断言工具未泄漏成契约）', () => {
  sameArray(
    Object.keys(conf).sort(),
    [
      'formatConformanceReport',
      'runDefinitionConformance',
      'runProjectionConformance',
      'runStoreConformance',
    ],
    '导出键',
  );
});

/**
 * ★ T19：三套里唯一要宿主**额外交输入**的（`DefinitionSource` 是只读线，套件造不出定义）。
 *   探针直接拿自己造的两版定义跑一遍 —— 既验公开面，也验「套件在真实产物上跑得动」。
 */
await checkAsync('T19 · `runDefinitionConformance` 可跑：合规实现全绿，忽略 version 的必红', async () => {
  const v1 = { schemaVersion: '2.0.0', id: 'probe', version: 1, nodes: [], flows: [] };
  const v2 = { schemaVersion: '2.0.0', id: 'probe', version: 2, nodes: [{ id: 'X', type: 'userTask' }], flows: [] };
  const fixtures = [
    { processId: 'probe', version: 1, definition: v1 },
    { processId: 'probe', version: 2, definition: v2 },
  ];

  const good = await conf.runDefinitionConformance(
    { async getDefinition(pid, v) { return pid === 'probe' ? (v === 1 ? v1 : v === 2 ? v2 : null) : null; } },
    fixtures,
    { subject: 'probe: 合规实现' },
  );
  eq(good.ok, true, `合规实现应全绿，实得 ${good.failed} 条失败：${good.cases.filter((c) => !c.ok).map((c) => c.name).join(' / ')}`);

  // ✗ 永远返回最新版（不看 version）—— AC-E10 的头号事故
  const blind = await conf.runDefinitionConformance(
    { async getDefinition(pid) { return pid === 'probe' ? v2 : null; } },
    fixtures,
    { subject: 'probe: 忽略 version' },
  );
  eq(blind.ok, false, '忽略 version 的实现必须被判不合格');
  assert(
    blind.cases.some((c) => !c.ok && c.name.includes('不同 version 返回不同内容')),
    `必须点名「不同 version 返回不同内容」，实得失败项：${blind.cases.filter((c) => !c.ok).map((c) => c.name).join(' / ')}`,
  );
});

/**
 * ★ T6 的核心承诺：套件**随包发布**，宿主 runner 自选 —— 所以产物里既不能有测试框架，
 * 也不能有 `node:` 内置模块（同一份代码要能在浏览器里跑）。判据直接读产物：
 * `^import` 只允许指向同包的 chunk。**这条只有读 dist 才能验**，源码层看不出来。
 */
check('dist 的 conformance 依赖链无任何外部运行时依赖', () => {
  const dir = new URL('./', confPath);
  const entry = readFileSync(new URL('conformance.js', dir), 'utf8');
  const specs = [...entry.matchAll(/^import\s+[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((x) => x[1]);
  const external = specs.filter((s) => !s.startsWith('./chunk-'));
  eq(external.length, 0, `conformance.js 有非本包来源的 import：${external.join(', ') || '无'}`);

  const js = readdirSync(dir).filter((f) => f.endsWith('.js'));
  const dirty = js.filter((f) =>
    /from\s*['"](node:|vitest|jest|mocha|ava)/.test(readFileSync(new URL(f, dir), 'utf8')),
  );
  eq(dirty.length, 0, `产物中出现外部来源：${dirty.join(', ') || '无'}`);
});

await checkAsync('dist 的 store 套件：跑 createMemoryStore() 必须全绿（13/13）', async () => {
  const report = await conf.runStoreConformance(m.createMemoryStore(), { subject: 'dist smoke' });
  eq(report.total, 13, 'store 用例数');
  assert(report.ok, `未全绿：\n${conf.formatConformanceReport(report)}`);
});

/**
 * 探针**自造**一个最小 `TaskProjection`（不是从包里拿的）——
 * 这正好证明「宿主任意实现都能被验」，而不是只对官方实现有效。
 */
await checkAsync('dist 的 projection 套件：跑探针内联投影必须全绿（9/9）', async () => {
  const tables = new Map();
  const table = (id) => {
    let t = tables.get(id);
    if (t === undefined) {
      t = new Map();
      tables.set(id, t);
    }
    return t;
  };
  const clone = (t) => JSON.parse(JSON.stringify(t));
  const projection = {
    async apply(instanceId, delta) {
      const t = table(instanceId);
      for (const taskId of delta.removed) t.delete(taskId);
      for (const v of delta.added) t.set(v.taskId, clone(v));
      for (const v of delta.changed) t.set(v.taskId, clone(v));
    },
    async sync(instanceId, tasks) {
      const next = new Map();
      for (const v of tasks) next.set(v.taskId, clone(v));
      tables.set(instanceId, next);
    },
  };

  const report = await conf.runProjectionConformance(projection, async (id) => [...table(id).values()].map(clone), {
    subject: 'probe inline',
  });
  eq(report.total, 9, 'projection 用例数');
  assert(report.ok, `未全绿：\n${conf.formatConformanceReport(report)}`);
});

/** 反向验收在**产物层**再复现一次：只会点头的套件比没有套件更危险 */
await checkAsync('dist 的套件能抓出「不抛冲突」的 store（反向验收）', async () => {
  const silent = { async load() { return null; }, async save() {} };
  const report = await conf.runStoreConformance(silent, { subject: 'broken: 静默覆盖' });
  assert(report.ok === false, '反向验收失败：套件对坏实现点了头');
  const names = report.cases.filter((c) => !c.ok).map((c) => c.name).join(' ｜ ');
  assert(names.includes('PERSIST_CONFLICT'), `未点名冲突用例，只报了：${names}`);
});

// ---------------- T7 冒烟：`plan()` 纯函数 + per-instance 串行队列 ----------------

/**
 * T7 的两条核心承诺都**只有跑产物才验得出来**：
 * ① 纯函数性 —— 若有人在 `plan()` 里写了 `Date.now()`，vitest 那份可能碰巧也是绿的
 *    （两次调用间隔为 0），但这里是产物层，同样是「间隔为 0」却不许有任何偏差可躲；
 *    更关键的是**缺时钟必须抛错**那条 —— 它直接证明 plan 里**没有**回退到系统时钟。
 * ② per-instance 串行 —— 它是 NFR-E5 的主防线，失效后只有并发下才暴露。
 */
check('plan / createInstanceQueue 已公开（门 2 自编排的入口）', () => {
  eq(typeof m.plan, 'function', 'plan');
  eq(typeof m.createInstanceQueue, 'function', 'createInstanceQueue');
});

const P0 = '2026-09-30T01:00:00.000Z';
const planState = (over = {}) => ({
  instanceId: 'pi_plan',
  processId: 'leave-approval',
  definitionVersion: 1,
  status: 'running',
  rev: 1,
  stateSchema: m.STATE_SCHEMA_VERSION,
  startedAt: T0,
  updatedAt: T0,
  tokens: [],
  completedNodes: [],
  variables: {},
  auditTrail: [],
  ...over,
});

await checkAsync('plan() 在产物层真的纯：两次调用深等，且入参不被改动', async () => {
  const s = planState();
  const before = JSON.stringify(s);
  const a = m.plan(s, { action: 'approve', actor: 'u1', at: P0 });
  const b = m.plan(s, { action: 'approve', actor: 'u1', at: P0 });
  eq(JSON.stringify(a.next), JSON.stringify(b.next), 'next 深等');
  eq(JSON.stringify(a.delta), JSON.stringify(b.delta), 'delta 深等');
  eq(a.next.rev, 2, 'rev +1（INV-1）');
  eq(a.delta.instance.rev, 2, 'delta.rev 与 next.rev 同源');
  eq(JSON.stringify(s), before, '入参未被改动');
  assert(!('tokens' in a.delta.instance), 'delta.instance 不得含 Body 字段');
});

await checkAsync('plan() 两条硬约束：终态门禁 + 缺时钟必抛（不许偷读 Date.now）', async () => {
  let terminal = null;
  try {
    m.plan(planState({ status: 'completed' }), { action: 'approve', actor: 'u1', at: P0 });
  } catch (e) {
    terminal = e;
  }
  assert(terminal !== null, '终态后提交必须抛错，不许静默无效果');
  eq(terminal.code, 'ENGINE_STATE_TERMINAL', '终态码');
  assert(terminal.floken === true, '终态错误缺 floken 印记');

  let noClock = null;
  try {
    m.plan(planState(), { action: 'approve', actor: 'u1' });
  } catch (e) {
    noClock = e;
  }
  assert(noClock !== null, '缺时间源必须抛错（而不是悄悄取系统时钟）');
  eq(noClock.code, 'ENGINE_OPTION_INVALID', '缺时钟码');
});

await checkAsync('per-instance 串行队列：同实例串行（FIFO）、不同实例并行', async () => {
  const q = m.createInstanceQueue();
  const tick = () => new Promise((r) => setTimeout(r, 0));
  let concurrent = 0;
  let maxConcurrent = 0;
  const order = [];

  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      q.run('pi_1', async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(i);
        await tick();
        concurrent -= 1;
      }),
    ),
  );
  eq(maxConcurrent, 1, '同实例最大并发数（NFR-E5 主防线）');
  sameArray(order, Array.from({ length: 50 }, (_, i) => i), '执行顺序 === 入队顺序（FIFO）');

  const t0 = Date.now();
  await Promise.all([
    q.run('pi_a', () => new Promise((r) => setTimeout(r, 40))),
    q.run('pi_b', () => new Promise((r) => setTimeout(r, 40))),
  ]);
  const spent = Date.now() - t0;
  assert(spent < 80, `不同实例必须并行（串行会约 80ms），实测 ${spent}ms`);

  await q.drain();
  eq(q.size(), 0, '跑完必须清空（长跑进程不得漏 key）');
});

// ---------------- T9 冒烟：19 项动作表 + 「当前能点哪些按钮」 ----------------

/**
 * ★ `03` §4 承诺「19 项动作 = 17 内核原生 + 2 内核外」—— 这是**对外口径红线**，
 *   必须能在产物里数出来，否则「文档说 19、包里其实 18」无人知晓。
 */
check('19 项动作：20 个可提交名字（suspend/resume 一行两名）', () => {
  eq(m.ACTION_NAMES.length, 20, 'ACTION_NAMES.length');
  eq(new Set(m.ACTION_NAMES).size, 20, '动作名不得重复');
  for (const n of ['approve', 'reject', 'jumpTo', 'returnTo', 'takeBack', 'revoke', 'terminate']) {
    assert(m.ACTION_NAMES.includes(n), `${n} 不在动作名表里`);
  }
});

/**
 * 全关配置下「哪些动作可用」= DV-2 白名单式默认的可观测结论。
 * 这里用**硬编码期望值**而不是复算 —— 复算等于让实现给自己打分。
 */
await checkAsync('enabledActionNames：全关配置只剩无开关的 7 个', async () => {
  const moddle = await import('@floken-io/moddle');
  const closed = moddle.normalizeApproval({ approvers: [{ type: 'user', value: 'u1' }] });
  sameArray(
    m.enabledActionNames(closed),
    ['approve', 'terminate', 'countersign', 'orSign', 'voteSign', 'suspend', 'resume'],
    '全关时的可用动作（会签三项的开关是节点 mode，不是动作开关）',
  );
});

/**
 * ★ 反向断言：动作表的**内部结构**与编译函数不导出。
 * 导出 `ACTION_SPECS` 会把「一行几列」钉成 semver 约束；导出 `compileAction` 等于
 * 让宿主绕开 `submit()` / `plan()` 自己编排 —— 门 2 的强一致就守不住了。
 */
check('动作表内部结构未泄漏（只公开动作名，不公开表体与编译函数）', () => {
  const leaked = ['ACTION_SPECS', 'ACTION_SPEC_BY_NAME', 'compileAction', 'readGate'].filter(
    (k) => k in m,
  );
  eq(leaked.length, 0, `被意外导出：${leaked.join(', ') || '无'}`);
});

// ---------------- T10 冒烟：汇聚判定在产物层真的能跑 ----------------

/**
 * ★ `03` §5 的三条规则是**对外承诺**，必须在产物里可观测 ——
 * 否则「包里的汇聚算法与文档说的不是一回事」无人知晓（D-21 就是这么发现的）。
 */
check('T10 汇聚判定：会签 / 或签 / 票签三条路径（03 §5.2 + §5.3）', () => {
  const mk = (mode, total, approved, rejected, extra = {}) => ({
    mode,
    total,
    approved,
    rejected,
    pending: total - approved - rejected,
    onReject: 'abort',
    ...extra,
  });

  // AC-E5：会签 3 人中 1 人通过 → 不推进
  eq(m.evaluateConvergence(mk('all', 3, 1, 0)).outcome, 'pending', '会签 1/3 通过');
  // AC-E16 规则一：会签 1 人驳回 + abort → 立即整体驳回
  eq(m.evaluateConvergence(mk('all', 3, 0, 1)).outcome, 'rejected', '会签驳回即终止');
  // AC-E4：或签 1 人通过 → 汇聚且取消其余
  const orSign = m.evaluateConvergence(mk('any', 3, 1, 0));
  eq(orSign.outcome, 'approved', '或签 1 人通过');
  eq(orSign.cancelRest, true, '或签 cancelRest（其余待办要取消）');
  // 规则二：票签 4 人 0 通过 3 驳回 → 剩余票不可能达标 → 立即驳回
  const vote = m.evaluateConvergence(mk('vote', 4, 0, 3, { threshold: 0.5 }));
  eq(vote.outcome, 'rejected', '票签反向提前终止');
  eq(vote.required, 2, '4 人 × 0.5 → ceil(2.0) = 2 票');
});

/** D-21 在**产物层**同样成立：会签 2 通过 1 驳回必须是 rejected（不得按多数判成 approved） */
check('T10 · D-21 修正可观测：会签 2 通过 1 驳回 → rejected', () => {
  const r = m.evaluateConvergence({
    mode: 'all',
    total: 3,
    approved: 2,
    rejected: 1,
    pending: 0,
    onReject: 'abort',
  });
  eq(r.outcome, 'rejected', '会签不得因「通过票多」而通过');
});

/** INV-9 的落点：或签第 1 人通过 → 其余 2 个在途令牌被点名取消 */
check('T10 · INV-9：restTokenIds 精确点名残余在途令牌', () => {
  const tokens = [
    { id: 'tk_1', nodeId: 'Task_1', state: 'completed', instanceGroup: 'g1' },
    { id: 'tk_2', nodeId: 'Task_1', state: 'active', instanceGroup: 'g1' },
    { id: 'tk_3', nodeId: 'Task_1', state: 'waiting', instanceGroup: 'g1' },
    { id: 'tk_9', nodeId: 'Task_1', state: 'active', instanceGroup: 'g2' },
  ];
  sameArray(m.restTokenIds(tokens, 'g1', ['tk_1']), ['tk_2', 'tk_3'], '只清同组的在途令牌');
});

/**
 * ★ **Q49（2026-10-03 拍板）的落点**：五个包之间**一律 peer，不再内置**。
 *
 * 于是本条判据整个反过来 —— 产物里**不该再出现任何静态 import 的 `@floken-io/*`**：
 * 兄弟包改由 `core/peer.ts` 在运行期按名字解析（Node 侧 `createRequire`，
 * 浏览器侧 `registerPeer()` 注入），「依赖谁」从**构建期**挪到了**运行期**。
 *
 * ⚠️ D-19 的红线**没放松**（汇聚算法仍必须在模型层、引擎不得自带一份副本）：
 *    上面那条白名单删了，改由「peer 解析目标必须在产物里出现」继续守 ——
 *    加载器把包名写成字符串常量，若哪天被误删 / 被摇树掉，这条会立刻红。
 */
const PEER_SPECIFIERS = ['@floken-io/moddle', '@floken-io/feel'];

check('T10 · D-19：产物**零静态**兄弟包依赖（Q49 peer 化）', () => {
  const src = readFileSync(new URL('../../dist/index.js', import.meta.url), 'utf8');
  const externals = [...src.matchAll(/^import[\s\S]*?from\s+'([^']+)'/gm)]
    .map((x) => x[1])
    .filter((s) => !s.startsWith('./'));
  const flokenStatic = externals.filter((s) => s.startsWith('@floken-io/'));
  eq(flokenStatic.length, 0, `产物不得静态 import 兄弟包（实得 ${flokenStatic.join(', ') || '无'}）`);
  // 除 node: 内置外不许有别的静态外部依赖
  const thirdParty = externals.filter((s) => !s.startsWith('node:'));
  eq(thirdParty.length, 0, `计划外的外部依赖：${thirdParty.join(', ') || '无'}`);
  for (const name of PEER_SPECIFIERS) {
    assert(src.includes(name), `peer 解析目标 ${name} 应出现在产物中（证明接线未被摇掉）`);
  }
});

// ---------------- T11 冒烟：createEngine 端到端（AC-E13「零配置跑通报销」） ----------------

/**
 * ★ 与前面各段不同，这一段是**真的端到端**：不 mock 任何东西，
 *   只给一张流程定义 + 一个内存待办表，然后 `start → submit → submit`。
 *   它是 `AC-E13` 在**产物层**的复现 —— vitest 里那份跑的是 `src/`。
 */
const T_SMOKE = '2026-10-01T00:00:00.000Z';

const expenseDef = {
  schemaVersion: '2.0.0',
  id: 'Process_1',
  version: 1,
nodes: [
        { id: 'Start_1', type: 'startEvent', name: '提交报销' },
        {
          id: 'Task_apply',
          type: 'userTask',
          name: '部门经理审批',
          formKey: 'form_expense',
          approval: { approvers: [{ type: 'user', value: 'u_manager' }] },
        },
        {
          id: 'Task_finance',
          type: 'userTask',
          name: '财务审批',
          approval: { approvers: [{ type: 'user', value: 'u_finance' }] },
        },
        { id: 'End_1', type: 'endEvent', name: '结束' },
      ],
  flows: [
        { id: 'Flow_1', from: 'Start_1', to: 'Task_apply' },
        { id: 'Flow_2', from: 'Task_apply', to: 'Task_finance' },
        { id: 'Flow_3', from: 'Task_finance', to: 'End_1' },
      ],
};

const makeProjection = () => {
  const tables = new Map();
  const table = (id) => {
    let t = tables.get(id);
    if (t === undefined) {
      t = new Map();
      tables.set(id, t);
    }
    return t;
  };
  return {
    async apply(instanceId, delta) {
      const t = table(instanceId);
      for (const id of delta.removed) t.delete(id);
      for (const v of delta.added) t.set(v.taskId, v);
      for (const v of delta.changed) t.set(v.taskId, v);
    },
    async sync(instanceId, tasks) {
      const next = new Map();
      for (const v of tasks) next.set(v.taskId, v);
      tables.set(instanceId, next);
    },
    list: async (id) => [...table(id).values()].sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
  };
};

const makeEngine = (extra = {}) =>
  m.createEngine({
    definitionSource: {
      async getDefinition(pid, v) {
        return pid === 'Process_1' && v === 1 ? expenseDef : null;
      },
    },
    clock: () => T_SMOKE,
    ...extra,
  });

check('createEngine 已公开（宿主接入的唯一入口）', () => {
  eq(typeof m.createEngine, 'function', 'createEngine');
});

/**
 * ★ D-8 / D-10 的收口：T1 与 T5 的验证项当年**前向引用**了 T11 的 `createEngine` / `start()`，
 *   被迫裁剪。这里把它们补回来 —— 「包可 import」升级成「包能真跑一条流程」。
 */
await checkAsync('AC-E13：零配置（不传 store / 不传 approverSource）跑通「报销」', async () => {
  const projection = makeProjection();
  const engine = makeEngine({ projection });

  const id = await engine.start('Process_1', {
    definitionVersion: 1,
    starter: 'u_applicant',
    businessKey: 'EXP-2026-001',
    variables: { amount: 1200 },
  });
  assert(typeof id === 'string' && id.startsWith('pi_'), `instanceId 形如 pi_xxx，实得 ${id}`);

  // ① run-to-wait 停在第一个 userTask
  const t0 = await projection.list(id);
  eq(t0.length, 1, '发起后的待办数');
  eq(t0[0].nodeId, 'Task_apply', '第一个待办所在节点');
  eq(t0[0].assignee, 'u_manager', '办理人（内置默认 ApproverSource 解析 {type:user}）');
  eq(t0[0].formKey, 'form_expense', 'formKey 由定义带出');
  eq(t0[0].status, 'active', '待办状态');

  // ② 部门经理通过 → 待办流转到财务
  const d1 = await engine.submit(id, { action: 'approve', actor: 'u_manager' });
  eq(d1.action.name, 'approve', 'delta.action.name（INV：必带动作事实）');
  sameArray(d1.removed, ['Task_apply:tk_start'], '旧待办必须真删（INV-15）');
  sameArray(d1.added.map((t) => t.taskId), ['Task_finance:tk_start'], '新待办');

  const t1 = await projection.list(id);
  eq(t1.length, 1, '一次只能通过一步');
  eq(t1[0].assignee, 'u_finance', '第二步办理人');

  // ③ 财务通过 → 结束事件 → 实例完成、待办清空
  const d2 = await engine.submit(id, { action: 'approve', actor: 'u_finance' });
  eq(d2.instance.status, 'completed', '实例终态');
  eq((await projection.list(id)).length, 0, '终态后待办必须清空');
});

await checkAsync('INV-2：终态后 submit → ENGINE_STATE_TERMINAL（真因不被包装）', async () => {
  const engine = makeEngine();
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u1' });
  await engine.submit(id, { action: 'approve', actor: 'u_manager' });
  await engine.submit(id, { action: 'approve', actor: 'u_finance' });

  let err = null;
  try {
    await engine.submit(id, { action: 'approve', actor: 'u_manager' });
  } catch (e) {
    err = e;
  }
  assert(err !== null, '终态后提交必须抛错');
  eq(err.code, 'ENGINE_STATE_TERMINAL', '终态码（不得是 STATE_SHAPE_INVALID）');
  assert(err.floken === true, '缺 floken 印记');
});

await checkAsync('INV-13：办理人解析为空集 → ENGINE_ACTION_APPROVER_EMPTY', async () => {
  const engine = makeEngine({ approverSource: { async resolve() { return []; } } });
  let err = null;
  try {
    await engine.start('Process_1', { definitionVersion: 1, starter: 'u1' });
  } catch (e) {
    err = e;
  }
  assert(err !== null, '0 办理人的 active 节点必须抛错（否则流程永久卡住且无报错）');
  eq(err.code, 'ENGINE_ACTION_APPROVER_EMPTY', '空集码');
});

check('D-7：未知配置键 → ENGINE_OPTION_UNKNOWN（禁止静默忽略）', () => {
  let err = null;
  try {
    m.createEngine({ stor: m.createMemoryStore() });
  } catch (e) {
    err = e;
  }
  assert(err !== null, '未知配置项必须抛错');
  eq(err.code, 'ENGINE_OPTION_UNKNOWN', '未知配置码');
});

/**
 * ★ 反向断言：图适配层未泄漏成公开面。
 *   `createProcessGraph` 接受的是模型层的 `ProcessDefinition`，属于**引擎内部**的读法；
 *   公开它等于把"引擎怎么读定义"钉成 semver 约束（`nodes/` 的图算法在 T16/T18 还会大改）。
 */
check('定义图适配层未泄漏进公开面（nodes/ 是内部实现）', () => {
  const leaked = ['createProcessGraph', 'assertTokensInGraph', 'runToWait', 'tasksOf', 'compileAction'].filter(
    (k) => k in m,
  );
  eq(leaked.length, 0, `被意外导出：${leaked.join(', ') || '无'}`);
});

// ---------------- T12 冒烟：事件发射（槽位 9）+ 门 1 钩子（槽位 5 / 8） ----------------

/**
 * ★ T12 的三条承诺都**只有跑产物才验得出来**：
 *   ① 事件顺序（`taskCreated` 先于 `taskAssigned`、终态排在待办之后）—— 宿主按它发通知；
 *   ② 事件与 `delta.action` **同源**（同一个对象）—— 三处各造一份就会在重放时对不上；
 *   ③ 门 1 `ctx` **改不动**（严格模式抛 `TypeError`）—— 若只是"改了不生效"，
 *      宿主会以为自己改成功了，是最难查的一类误伤。
 */
check('eventsOf / emitAll 已公开（门 2 自编排也要能发同一组事件）', () => {
  eq(typeof m.eventsOf, 'function', 'eventsOf');
  eq(typeof m.emitAll, 'function', 'emitAll');
});

await checkAsync('AC-E14：发起 = started → taskCreated → taskAssigned（created 必先于 assigned）', async () => {
  const seen = [];
  const engine = makeEngine({
    events: {
      emit(e) {
        seen.push(e.name);
      },
    },
  });
  await engine.start('Process_1', { definitionVersion: 1, starter: 'u_applicant' });
  sameArray(seen, ['started', 'taskCreated', 'taskAssigned'], '发起的事件序列');
  assert(seen.indexOf('taskCreated') < seen.indexOf('taskAssigned'), 'created 必先于 assigned');
});

await checkAsync('AC-E14：推进 = 旧待办 completed → 新待办 created/assigned；终态 completed 在最后', async () => {
  const seen = [];
  const engine = makeEngine({
    events: {
      emit(e) {
        seen.push(e);
      },
    },
  });
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u_applicant' });

  seen.length = 0;
  await engine.submit(id, { action: 'approve', actor: 'u_manager' });
  sameArray(seen.map((e) => e.name), ['taskCompleted', 'taskCreated', 'taskAssigned'], '推进的事件序列');

  seen.length = 0;
  const d2 = await engine.submit(id, { action: 'approve', actor: 'u_finance' });
  sameArray(seen.map((e) => e.name), ['taskCompleted', 'completed'], '终态事件排在待办之后');

  // ★ 同源：事件的 action 与 delta.action 是**同一个对象**，at 也不另取时钟
  for (const e of seen) {
    assert(e.action === d2.action, '事件的 action 必须是 delta.action 本身（不是复制品）');
    eq(e.at, T_SMOKE, '事件的 at 与本次动作同源');
  }
});

await checkAsync('门 1 · 槽位 5：beforeAction 返回 false → ACTION_VETOED，且**一行都没写**', async () => {
  const store = m.createMemoryStore();
  const engine = makeEngine({ store, hooks: { beforeAction: () => false } });
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u1' });

  let err = null;
  try {
    await engine.submit(id, { action: 'approve', actor: 'u_manager' });
  } catch (e) {
    err = e;
  }
  assert(err !== null, '否决必须抛错（静默返回空差分会让用户以为办完了）');
  eq(err.code, 'ENGINE_ACTION_VETOED', '否决码');
  eq((await store.load(id)).rev, 1, '否决后 rev 不变（save 一次都没调用）');
});

await checkAsync('★ 门 1 只读：改写 ctx.action 抛 TypeError，且不污染引擎自己的 delta', async () => {
  let caught = null;
  const engine = makeEngine({
    hooks: {
      beforeAction(ctx) {
        try {
          ctx.action.name = 'HACKED';
        } catch (e) {
          caught = e;
        }
        return true;
      },
    },
  });
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u1' });
  const d = await engine.submit(id, { action: 'approve', actor: 'u_manager' });
  assert(caught instanceof TypeError, `应当抛 TypeError，实得 ${caught}`);
  eq(d.action.name, 'approve', '引擎自己那份 delta 不受影响');
});

await checkAsync('门 1 · 槽位 8：afterAction 失败不吞 —— 但**状态已落库**（至少一次的代价）', async () => {
  const store = m.createMemoryStore();
  const engine = makeEngine({
    store,
    hooks: {
      afterAction() {
        throw new Error('after boom');
      },
    },
  });
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u1' });

  let err = null;
  try {
    await engine.submit(id, { action: 'approve', actor: 'u_manager' });
  } catch (e) {
    err = e;
  }
  eq(err?.message, 'after boom', 'afterAction 的失败必须冒泡（不得吞）');
  eq((await store.load(id)).rev, 2, '抛错 ≠ 回滚：宿主必须幂等，不能盲目重放');
});

await checkAsync('EventSink 抛错不影响流程（丢了不影响流程，ADR-006）', async () => {
  const projection = makeProjection();
  const engine = makeEngine({
    projection,
    events: {
      emit() {
        throw new Error('sink boom');
      },
    },
  });
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u1' });
  const d = await engine.submit(id, { action: 'approve', actor: 'u_manager' });
  eq(d.rev, 2, '提交照常成功');
  eq((await projection.list(id))[0]?.nodeId, 'Task_finance', '待办照常推进');
});

// ---------------- T13 冒烟：会签闭环在产物层真的能跑 ----------------

check('T13 新增导出齐备（门 2 自编排要独立完成汇聚就靠它们）', () => {
  /*
   * ⚠️ `runToWait` **刻意不在其中**：它是 `step()` 内部的第 ⑤ 步，单独公开会多一条 semver 约束，
   *   且宿主拿它拼演化会**漏掉投票与汇聚**（会签就退化成单人审批）—— 入口只能是 `step()`。
   */
  for (const k of ['step', 'castVote', 'promoteSequential', 'settleGroups', 'groupTallies', 'convergeCtxOf']) {
    eq(typeof m[k], 'function', k);
  }
});

/**
 * ★ 会签三段：`3 人展开 → 前两人通过不推进 → 第三人通过汇聚推进`。
 * 这是「中国式审批」的头号场景在**产物层**的复现 —— vitest 那份跑的是 `src/`。
 */
const countersignDef = {
  schemaVersion: '2.0.0',
  id: 'Process_cs',
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
            },
        },
        {
          id: 'Task_next',
          type: 'userTask',
          name: '下一节点',
          approval: { approvers: [{ type: 'user', value: 'u9' }] },
        },
        { id: 'End_1', type: 'endEvent' },
      ],
  flows: [
        { id: 'F1', from: 'Start_1', to: 'Task_sign' },
        { id: 'F2', from: 'Task_sign', to: 'Task_next' },
        { id: 'F3', from: 'Task_next', to: 'End_1' },
      ],
};

await checkAsync('会签冒烟（T13）：3 人展开 → 全员通过 → 汇聚推进 → 完成', async () => {
  const seen = [];
  const engine = m.createEngine({
    definitionSource: {
      async getDefinition(pid, v) {
        return pid === 'Process_cs' && v === 1 ? countersignDef : null;
      },
    },
    projection: {
      async apply(_id, delta) {
        seen.push({
          added: delta.added.map((t) => t.assignee),
          removed: delta.removed.length,
        });
      },
      async sync() {},
    },
    clock: () => T0,
  });

  const id = await engine.start('Process_cs', { definitionVersion: 1, starter: 'u0' });
  eq(seen[0].added.length, 3, '发起后展开出 3 条待办');

  await engine.submit(id, { action: 'approve', actor: 'u1' });
  eq(seen[1].added.length, 0, '第 1 人通过不推进');
  await engine.submit(id, { action: 'approve', actor: 'u2' });
  eq(seen[2].added.length, 0, '第 2 人通过不推进');
  await engine.submit(id, { action: 'approve', actor: 'u3' });
  sameArray(seen[3].added, ['u9'], '第 3 人通过 → 汇聚推进到下一节点');
  eq(seen[3].removed, 1, '第 3 人自己那条待办被结算');

  await engine.submit(id, { action: 'approve', actor: 'u9' });
  // 最后一人办完 → 实例完成
  const store = m.createMemoryStore();
  void store;
  eq(seen[4].added.length, 0, '走到结束事件，无新待办');
});

// ---------------- T14 冒烟：条件求值在产物层真的能跑（AC-E9） ----------------

check('T14 条件求值导出齐备（默认实现 + 唯一出口）', () => {
  for (const k of ['createFeelConditionHandler', 'evaluateCondition']) {
    eq(typeof m[k], 'function', k);
  }
});

/**
 * ★ 产物层真跑一遍「金额 > N 走谁」—— 这是中国式审批最高频的场景，
 *   Q30 把它定为**默认依赖**的理由就是它；所以这里验的不是「能 import」，是**真能算对**。
 */
check('T14 · 内置默认：零配置即可求 `amount > 5000`（NFR-E10 / Q30）', () => {
  const h = m.createFeelConditionHandler();
  const c = (variables) => ({ instanceId: 'pi_1', nodeId: 'Gateway_1', variables });
  eq(h.evaluate('amount > 5000', c({ amount: 6000 })), true, '6000 → true');
  eq(h.evaluate('amount > 5000', c({ amount: 1000 })), false, '1000 → false');
  eq(h.evaluate('urgent and amount > 5000', c({ urgent: true, amount: 9000 })), true, 'and');
  eq(h.evaluate('days in [3..5]', c({ days: 4 })), true, '区间');
  eq(h.evaluate('reason = null', c({ reason: null })), true, '空值语义');
  eq(h.evaluate('order.amount > 100', c({ order: { amount: 200 } })), true, '路径');
});

/** ★ AC-E9 的**双向**判据：求不了值必须抛，绝不返回 false */
check('T14 · AC-E9：语法错 / JUEL / null → 抛错，不返回 false', () => {
  const h = m.createFeelConditionHandler();
  const c = { instanceId: 'pi_1', nodeId: 'Gateway_1', variables: {} };
  const codeOf = (fn) => {
    try {
      fn();
      return 'NO_THROW';
    } catch (e) {
      return e?.code ?? 'NO_CODE';
    }
  };
  // ① 语法错 → feel 的语法错（原样传播，不是 false）
  assert(codeOf(() => h.evaluate('amount >', c)).startsWith('FEEL_SYNTAX'), '语法错 → FEEL_SYNTAX_*');
  // ② `${...}` → 引擎自己的 OPTION_INVALID（指名是 JUEL）
  eq(codeOf(() => h.evaluate('${variables.amount > 1}', c)), 'ENGINE_OPTION_INVALID', 'JUEL → OPTION_INVALID');
  // ③ ★ null（变量缺失）→ 抛（unary 语义下这里会静默返回 **true**，是最危险的那一档）
  eq(codeOf(() => h.evaluate('amount > 5000', c)), 'ENGINE_OPTION_INVALID', 'null → OPTION_INVALID');
  // ④ 非布尔 → 抛
  eq(codeOf(() => h.evaluate('"abc"', c)), 'ENGINE_OPTION_INVALID', '非布尔 → OPTION_INVALID');
  // ⑤ 空 = 无条件（BPMN 既有语义，D-42）
  eq(h.evaluate('', c), true, "'' → true");
});

/** ★ 第 0 层要求对**注入的** handler 同样生效（无豁免） */
await checkAsync('T14 · AC-E9 无豁免：坏 handler 的返回值被挡在出口', async () => {
  const c = { instanceId: 'pi_1', nodeId: 'Gateway_1', variables: { amount: 1 } };
  const codeOf = async (p) => {
    try {
      await p;
      return 'NO_THROW';
    } catch (e) {
      return e?.code ?? 'NO_CODE';
    }
  };
  const boom = new Error('宿主求值器炸了');
  let caught;
  try {
    await m.evaluateCondition(
      {
        evaluate() {
          throw boom;
        },
      },
      'x',
      c,
    );
  } catch (e) {
    caught = e;
  }
  assert(caught === boom, 'handler 抛错 → 原样传播（同一实例，不吞不包装）');
  eq(
    await codeOf(m.evaluateCondition({ evaluate: () => undefined }, 'x', c)),
    'ENGINE_OPTION_INVALID',
    '返回 undefined → 抛',
  );
  eq(
    await codeOf(m.evaluateCondition({ evaluate: () => 'yes' }, 'x', c)),
    'ENGINE_OPTION_INVALID',
    '返回字符串 → 抛',
  );
  eq(
    await m.evaluateCondition({ evaluate: async () => true }, 'x', c),
    true,
    '正常 async handler 照常返回',
  );
});

/**
 * ★ Q33：产物不背时态开销 —— 口径是「**dist 里没有时态的说明符**」。
 * 运行时加载与否由 `@floken-io/feel` 自己的动态 import 决定，引擎侧能守的只有这一条。
 */
check('T14 · Q33：dist 内无时态说明符（条件求值路径不碰时态）', () => {
  const files = readdirSync('dist').filter((f) => f.endsWith('.js'));
  const specifiers = new Set();
  let all = '';
  for (const f of files) {
    const src = readFileSync(`dist/${f}`, 'utf8');
    all += src;
    for (const mm of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      specifiers.add(mm[1]);
    }
  }
  const hits = [...specifiers].filter((s) => /^temporal|^@floken-io\/feel\/temporal/.test(s));
  eq(hits.length, 0, `时态说明符（实得 ${JSON.stringify(hits)}）`);
  /*
   * ★ Q49 后条件求值**不再静态 import** `@floken-io/feel`（改由 peer 加载器按名字解析），
   *   所以「默认依赖已接线」这条改守**解析目标字符串**是否还在产物里 ——
   *   包名被摇树掉 / 写错名字，这条立刻红。
   */
  assert(
    all.includes('@floken-io/feel'),
    '条件求值的 peer 解析目标 @floken-io/feel 仍在产物中（接线未被摇掉）',
  );
});

// ---------------- T15 冒烟：回归路径在产物层真的能跑（AC-E6 / AC-E7 / D-34） ----------------

/** `Start_1 → Task_a（u_a，可委派/转办）→ Task_b（u_b）→ End_1` */
const regressDef = {
  schemaVersion: '2.0.0',
  id: 'Process_1',
  version: 1,
nodes: [
        { id: 'Start_1', type: 'startEvent' },
        {
          id: 'Task_a',
          type: 'userTask',
          name: '一审',
          approval: {
              approvers: [{ type: 'user', value: 'u_a' }],
              delegate: { allowed: true },
              transfer: { allowed: true },
            },
        },
        {
          id: 'Task_b',
          type: 'userTask',
          name: '二审',
          approval: { approvers: [{ type: 'user', value: 'u_b' }] },
        },
        { id: 'End_1', type: 'endEvent' },
      ],
  flows: [
        { id: 'Flow_1', from: 'Start_1', to: 'Task_a' },
        { id: 'Flow_2', from: 'Task_a', to: 'Task_b' },
        { id: 'Flow_3', from: 'Task_b', to: 'End_1' },
      ],
};

/** `Start_1 → Task_sign（3 人会签，可任意退回）→ Task_next（u9）→ End_1` */
const csRollbackDef = {
  schemaVersion: '2.0.0',
  id: 'Process_1',
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
        {
          id: 'Task_next',
          type: 'userTask',
          name: '下一节点',
          approval: { approvers: [{ type: 'user', value: 'u9' }] },
        },
        { id: 'End_1', type: 'endEvent' },
      ],
  flows: [
        { id: 'Flow_1', from: 'Start_1', to: 'Task_sign' },
        { id: 'Flow_2', from: 'Task_sign', to: 'Task_next' },
        { id: 'Flow_3', from: 'Task_next', to: 'End_1' },
      ],
};

const regressCtx = () => {
  const projection = makeProjection();
  const engine = m.createEngine({
    definitionSource: {
      async getDefinition(pid, v) {
        return pid === 'Process_1' && v === 1 ? regressDef : null;
      },
    },
    projection,
    clock: () => T_SMOKE,
  });
  return { engine, projection };
};

/**
 * ★ AC-E6 的完整闭环：**委派 → 代办人办完 → 回到原主 → 原主办才推进**。
 * 只验「回到 A」是不够的 —— 回归路径没清干净会**无限回归**，
 * 所以最后一步必须断言"原主再办就真的往前走了"。
 */
await checkAsync('T15 · AC-E6：委派 A→B，B 办完回到 A；A 再办才推进', async () => {
  const c = regressCtx();
  const id = await c.engine.start('Process_1', { definitionVersion: 1, starter: 'u_applicant' });

  const d1 = await c.engine.submit(id, { action: 'delegate', actor: 'u_a', payload: { assignee: 'u_bak' } });
  eq(d1.changed[0]?.assignee, 'u_bak', '委派后办理人换成 B');
  eq(d1.changed[0]?.status, 'delegated', '待办视图能看出"已委派出去"');

  const d2 = await c.engine.submit(id, { action: 'approve', actor: 'u_bak' });
  eq(d2.changed[0]?.assignee, 'u_a', '★ B 办完 → 回到 A');
  eq(d2.changed[0]?.nodeId, 'Task_a', '★ 节点没变（不是推进）');
  eq(d2.added.length, 0, '没有新待办');

  const d3 = await c.engine.submit(id, { action: 'approve', actor: 'u_a' });
  eq(d3.added.length, 1, '★ A 再办 → 推进（回归只发生一次）');
  eq(d3.added[0]?.assignee, 'u_b', '推进到二审 u_b');
  eq((await c.projection.list(id)).length, 1, '待办表只有一条');
});

/** ★ AC-E7：转办**不留下**回归路径 —— 否则"转办"会退化成"委派" */
await checkAsync('T15 · AC-E7：转办后不留回归路径（转办 ≠ 委派）', async () => {
  const c = regressCtx();
  const id = await c.engine.start('Process_1', { definitionVersion: 1, starter: 'u_applicant' });

  const d = await c.engine.submit(id, { action: 'transfer', actor: 'u_a', payload: { assignee: 'u_a2' } });
  eq(d.removed.length, 0, '同一条待办（不是删了重建）');
  eq(d.added.length, 0, '同一条待办');
  eq(d.changed[0]?.nodeId, 'Task_a', '★ 令牌没动');

  const d2 = await c.engine.submit(id, { action: 'approve', actor: 'u_a2' });
  eq(d2.added[0]?.assignee, 'u_b', '★ u_a2 办完直接推进（没有回到 u_a）');
});

/** ★ D-34：组内回退 = **整组重来**（不留幽灵待办、旧组不复活） */
await checkAsync('T15 · D-34：组内 returnTo → 整组取消 + 重新展开新组', async () => {
  const projection = makeProjection();
  const engine = m.createEngine({
    definitionSource: {
      async getDefinition(pid, v) {
        return pid === 'Process_1' && v === 1 ? csRollbackDef : null;
      },
    },
    projection,
    clock: () => T_SMOKE,
  });
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u_applicant' });
  const before = await projection.list(id);
  eq(before.length, 3, '会签 3 条待办');

  const d = await engine.submit(id, {
    action: 'returnTo',
    actor: 'u1',
    target: 'Start_1',
    comment: '整组重来',
  });
  eq(d.removed.length, 3, '★ 三条旧待办全部摘掉（不是只摘我这一条）');

  const after = await projection.list(id);
  // 回到 Start_1 → 自动直通回 Task_sign → 重新展开成**新的一组**三人
  eq(after.length, 3, '重新展开');
  sameArray(after.map((t) => t.assignee).sort(), ['u1', 'u2', 'u3'], '还是这三个人');
  // taskId = `${nodeId}:${groupId}#${i}` → 去掉末段 `#i` 就是组 id
  const groups = new Set(
    after.map((t) => t.taskId.split(':')[1].split('#').slice(0, -1).join('#')),
  );
  eq(groups.size, 1, '同属一个新组');

  // ★ 关键：重来之后流程照常走完，不会"没人在办却自己往前走"
  await engine.submit(id, { action: 'approve', actor: 'u1' });
  await engine.submit(id, { action: 'approve', actor: 'u2' });
  eq((await projection.list(id)).filter((t) => t.nodeId === 'Task_next').length, 0, '两人通过不推进');
  await engine.submit(id, { action: 'approve', actor: 'u3' });
  eq((await projection.list(id)).filter((t) => t.nodeId === 'Task_next').length, 1, '三人通过 → 汇聚推进');
});

// ---------------- T16 冒烟：网关 5 类 + 事件 6 类在产物层真跑 ----------------

/**
 * `Start_1 → Fork(并行) → Task_a(u_a) / Task_b(u_b) → Join(并行) → Task_end(u_z) → End_1`
 *
 * ★ 这是 T16 的头号场景在**产物层**的复现：并行分叉 / 汇聚合流 / 全分支结束。
 */
const parallelDef = {
  schemaVersion: '2.0.0',
  id: 'Process_par',
  version: 1,
nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Fork', type: 'parallelGateway', name: '并行分叉' },
        {
          id: 'Task_a',
          type: 'userTask',
          name: 'A 分支',
          approval: { approvers: [{ type: 'user', value: 'u_a' }] },
        },
        {
          id: 'Task_b',
          type: 'userTask',
          name: 'B 分支',
          approval: { approvers: [{ type: 'user', value: 'u_b' }] },
        },
        { id: 'Join', type: 'parallelGateway', name: '并行汇聚' },
        {
          id: 'Task_end',
          type: 'userTask',
          name: '终审',
          approval: { approvers: [{ type: 'user', value: 'u_z' }] },
        },
        { id: 'End_1', type: 'endEvent' },
      ],
  flows: [
        { id: 'F1', from: 'Start_1', to: 'Fork' },
        { id: 'F2', from: 'Fork', to: 'Task_a' },
        { id: 'F3', from: 'Fork', to: 'Task_b' },
        { id: 'F4', from: 'Task_a', to: 'Join' },
        { id: 'F5', from: 'Task_b', to: 'Join' },
        { id: 'F6', from: 'Join', to: 'Task_end' },
        { id: 'F7', from: 'Task_end', to: 'End_1' },
      ],
};

const parEngine = () => {
  const projection = makeProjection();
  const engine = m.createEngine({
    definitionSource: {
      async getDefinition(pid, v) {
        return pid === 'Process_par' && v === 1 ? parallelDef : null;
      },
    },
    projection,
    clock: () => T_SMOKE,
  });
  return { engine, projection };
};

await checkAsync('T16 · 并行：分叉出两条 → 都办完合流成一条 → 实例完成', async () => {
  const c = parEngine();
  const id = await c.engine.start('Process_par', { definitionVersion: 1, starter: 'u_app' });

  const t0 = await c.projection.list(id);
  eq(t0.length, 2, '分叉后两条待办');
  sameArray(t0.map((t) => t.assignee).sort(), ['u_a', 'u_b'], '两条分支各一人');

  // 只办完 A：B 还在办 → 不得推进到终审
  const d1 = await c.engine.submit(id, { action: 'approve', actor: 'u_a' });
  eq(d1.added.length, 0, '只办完一条分支不推进');
  eq((await c.projection.list(id)).filter((t) => t.nodeId === 'Task_end').length, 0, '终审未出现');

  // B 办完 → 合流 → 终审**只有一条**（合流必须在推进之前，否则会出现两条一模一样的待办）
  const d2 = await c.engine.submit(id, { action: 'approve', actor: 'u_b' });
  sameArray(d2.added.map((t) => t.assignee), ['u_z'], '合流后推进到终审');
  eq((await c.projection.list(id)).length, 1, '终审只有一条待办');

  const d3 = await c.engine.submit(id, { action: 'approve', actor: 'u_z' });
  eq(d3.instance.status, 'completed', '全部分支结束 → 实例 completed');
});

/**
 * `Start_1 → Task_1 → G(排他) → [amount > 5000] Task_boss / default Task_lead`
 *
 * ★ Q30 把 `@floken-io/feel` 定为**默认依赖**的理由就是这一条：
 *   「金额 > N 走谁」是中国式审批最高频的场景，装出来的引擎必须**默认就会算**。
 */
const amountDef = {
  schemaVersion: '2.0.0',
  id: 'Process_amt',
  version: 1,
nodes: [
        { id: 'Start_1', type: 'startEvent' },
        {
          id: 'Task_1',
          type: 'userTask',
          approval: { approvers: [{ type: 'user', value: 'u_1' }] },
        },
        { id: 'G', type: 'exclusiveGateway', defaultFlow: 'F_lead' },
        {
          id: 'Task_boss',
          type: 'userTask',
          approval: { approvers: [{ type: 'user', value: 'u_boss' }] },
        },
        {
          id: 'Task_lead',
          type: 'userTask',
          approval: { approvers: [{ type: 'user', value: 'u_lead' }] },
        },
        { id: 'End_1', type: 'endEvent' },
      ],
  flows: [
        { id: 'F1', from: 'Start_1', to: 'Task_1' },
        { id: 'F2', from: 'Task_1', to: 'G' },
        { id: 'F_boss', from: 'G', to: 'Task_boss', condition: 'amount > 5000' },
        { id: 'F_lead', from: 'G', to: 'Task_lead' },
        { id: 'F3', from: 'Task_boss', to: 'End_1' },
        { id: 'F4', from: 'Task_lead', to: 'End_1' },
      ],
};

const amtEngine = () => {
  const projection = makeProjection();
  const engine = m.createEngine({
    definitionSource: {
      async getDefinition(pid, v) {
        return pid === 'Process_amt' && v === 1 ? amountDef : null;
      },
    },
    projection,
    clock: () => T_SMOKE,
  });
  return { engine, projection };
};

await checkAsync('T16 · 排他网关：零配置 FEEL 按金额走分支（Q30 / AC-E9）', async () => {
  const c = amtEngine();

  const big = await c.engine.start('Process_amt', { definitionVersion: 1, starter: 'u_app', variables: { amount: 9000 } });
  await c.engine.submit(big, { action: 'approve', actor: 'u_1' });
  sameArray((await c.projection.list(big)).map((t) => t.assignee), ['u_boss'], '9000 → 老板批');

  const small = await c.engine.start('Process_amt', { definitionVersion: 1, starter: 'u_app', variables: { amount: 100 } });
  await c.engine.submit(small, { action: 'approve', actor: 'u_1' });
  sameArray((await c.projection.list(small)).map((t) => t.assignee), ['u_lead'], '100 → 主管批（default）');
});

/**
 * ★ **惰性解析**：走不到的分支上的坏表达式**不得**被求值。
 *   若"拿到图就把全图条件算一遍"，`missingVar > 1` 会在**第一步**就炸，
 *   而那条分支本来根本走不到 —— 这条只有端到端跑才验得出来。
 */
await checkAsync('T16 · 条件惰性解析：走不到的分支不求值（不误伤、不静默走错）', async () => {
  const c = amtEngine();
  // 提交时把 amount 改成 9000 → 网关必须按**新值**走（payload 与条件同源）
  const id = await c.engine.start('Process_amt', { definitionVersion: 1, starter: 'u_app', variables: { amount: 100 } });
  await c.engine.submit(id, { action: 'approve', actor: 'u_1', payload: { amount: 9000 } });
  sameArray((await c.projection.list(id)).map((t) => t.assignee), ['u_boss'], '表单改值 → 走老板批');
});

/**
 * ★ 反向断言补强：`nodes/` 的**新**模块同样不得泄漏进公开面。
 *   T16 刚加了 `nodes/gateways.ts` / `nodes/events.ts` / 图适配层的新方法，
 *   没有这条，将来一句 `export *` 就会把"引擎怎么读图"钉成 semver 约束。
 */
check('T16 · nodes/ 新模块同样未泄漏进公开面', () => {
  const leaked = [
    'createProcessGraph',
    'assertTokensInGraph',
    'runToWait',
    'tasksOf',
    'compileAction',
    'routeGateway',
    'canJoin',
    'eventBehaviorOf',
    'isGatewayType',
    'waitingAt',
  ].filter((k) => k in m);
  eq(leaked.length, 0, `被意外导出：${leaked.join(', ') || '无'}`);
});

// ---------------- T17 · 任务 8 类 + 连线与数据 4 类 ----------------

const T17 = '2026-10-01T00:00:00.000Z';

/**
 * ★ **运行期探针**：产物 `dist/*.js` 里**不得**出现动态执行 API。
 *   单元测试那道扫的是 `src/`（去注释）；这道扫的是**真正发出去的那份代码** ——
 *   `03` §6 的 `ScriptTask` 红线是「禁止动态执行」，两层都绿才算收口。
 */
check('T17 · ★ dist 产物无动态执行 API（无 new Function / node:vm / eval(）', () => {
  const distDir = fileURLToPath(new URL('.', resolved));
  const files = readdirSync(distDir).filter((f) => f.endsWith('.js'));
  assert(files.length > 0, `dist 下没有 .js（${distDir}）`);
  for (const f of files) {
    const src = readFileSync(distDir + f, 'utf8');
    assert(!/new\s+Function/.test(src), `${f} 出现 new Function`);
    assert(!/['"`]node:vm['"`]/.test(src), `${f} 引用 node:vm`);
    assert(!/(^|[^\w.])eval\s*\(/.test(src), `${f} 出现 eval(`);
  }
});

/** 一条「自动任务 + 人工审批」的最小流程；`auto` 节点的类型由调用方给 */
const autoDef = (auto) => ({
  schemaVersion: '2.0.0',
  id: 'Process_auto',
nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'Auto_1', type: auto.type, name: '自动节点', ...auto },
        {
          id: 'Task_1',
          type: 'userTask',
          approval: { approvers: [{ type: 'user', value: 'u_1' }] },
        },
        { id: 'End_1', type: 'endEvent' },
      ],
  flows: [
        { id: 'F1', from: 'Start_1', to: 'Auto_1' },
        { id: 'F2', from: 'Auto_1', to: 'Task_1' },
        { id: 'F3', from: 'Task_1', to: 'End_1' },
      ],
});

function autoEngine(auto, extra = {}) {
  const events = [];
  const store = m.createMemoryStore();
  const engine = m.createEngine({
    definitionSource: {
      async getDefinition(pid, v) {
        return pid === 'Process_auto' && v === 1 ? autoDef(auto) : null;
      },
    },
    store,
    events: { emit: (e) => void events.push(e) },
    clock: () => T17,
    ...extra,
  });
  return { engine, store, events };
}

await checkAsync('T17 · ★ manualTask：连发 created + completed，且不等待、无 assignee', async () => {
  const c = autoEngine({ type: 'manualTask' });
  const id = await c.engine.start('Process_auto', { definitionVersion: 1, starter: 'u_0' });
  // 不等待：起点 → manualTask → userTask 一步到位
  const st = await c.store.load(id);
  sameArray(
    st.tokens.filter((t) => t.state === 'active').map((t) => t.nodeId),
    ['Task_1'],
    '令牌没停在 manualTask 上',
  );
  const trace = c.events.filter((e) => e.nodeId === 'Auto_1').map((e) => e.name);
  sameArray(trace, ['taskCreated', 'taskCompleted'], '留痕两条');
  assert(c.events.filter((e) => e.nodeId === 'Auto_1').every((e) => e.assignee === undefined), '不该有 assignee');
});

await checkAsync('T17 · ★ 裸 task：一条事件都不发（与 manualTask 的差别 = 是否留痕）', async () => {
  const c = autoEngine({ type: 'task' });
  const id = await c.engine.start('Process_auto', { definitionVersion: 1, starter: 'u_0' });
  const st = await c.store.load(id);
  sameArray(st.tokens.filter((t) => t.state === 'active').map((t) => t.nodeId), ['Task_1'], '直通到 Task_1');
  eq(c.events.filter((e) => e.nodeId === 'Auto_1').length, 0, '裸 task 的事件数');
});

await checkAsync('T17 · serviceTask：调 handler 一次，返回值并入变量', async () => {
  let calls = 0;
  const c = autoEngine(
    { type: 'serviceTask', implementation: 'mkTicket' },
    { handlers: { get: (ref) => (ref === 'mkTicket' ? async () => { calls += 1; return { ticket: 'T-9' }; } : undefined) } },
  );
  const id = await c.engine.start('Process_auto', { definitionVersion: 1, starter: 'u_0' });
  eq(calls, 1, 'handler 调用次数');
  eq((await c.store.load(id)).variables.ticket, 'T-9', '并入的变量');
});

await checkAsync('T17 · scriptTask（FEEL）：内置求值，结果落在 variables[nodeId]', async () => {
  // ★ v2：脚本是 `ScriptSpec { body, language }`，不再是 `script` + `scriptFormat` 两个字符串
  const c = autoEngine({ type: 'scriptTask', script: { body: '1 + 2', language: 'feel' } });
  const id = await c.engine.start('Process_auto', { definitionVersion: 1, starter: 'u_0' });
  eq((await c.store.load(id)).variables.Auto_1, 3, 'FEEL 脚本结果');
});

await checkAsync('T17 · ★ businessRuleTask 未注入 decisionHandler → 报「未配置」', async () => {
  const c = autoEngine({ type: 'businessRuleTask' });
  let code = null;
  try {
    await c.engine.start('Process_auto', { definitionVersion: 1, starter: 'u_0' });
  } catch (e) {
    code = e.code;
  }
  eq(code, 'ENGINE_OPTION_INVALID', '未注入 decisionHandler 的错误码');
});

await checkAsync('T17 · ★ sendTask / receiveTask → 显式抛（不得静默直通）', async () => {
  for (const type of ['sendTask', 'receiveTask']) {
    const c = autoEngine({ type });
    let code = null;
    try {
      await c.engine.start('Process_auto', { definitionVersion: 1, starter: 'u_0' });
    } catch (e) {
      code = e.code;
    }
    eq(code, 'ENGINE_STATE_SHAPE_INVALID', `${type} 的错误码`);
  }
});

await checkAsync('T17 · ★ 数据节点：令牌落到 dataObject → 抛（引擎只读不写）', async () => {
  const def = {
    schemaVersion: '2.0.0',
    id: 'Process_data',
nodes: [
          { id: 'Start_1', type: 'startEvent' },
          { id: 'Data_1', type: 'dataObject' },
          {
            id: 'Task_1',
            type: 'userTask',
            approval: { approvers: [{ type: 'user', value: 'u_1' }] },
          },
        ],
    flows: [
          { id: 'F1', from: 'Start_1', to: 'Data_1' },
          { id: 'F2', from: 'Data_1', to: 'Task_1' },
        ],
  };
  const engine = m.createEngine({
    definitionSource: { async getDefinition(pid, v) { return pid === 'Process_data' && v === 1 ? def : null; } },
    store: m.createMemoryStore(),
    clock: () => T17,
  });
  let code = null;
  try {
    await engine.start('Process_data', { definitionVersion: 1, starter: 'u_0' });
  } catch (e) {
    code = e.code;
  }
  eq(code, 'ENGINE_STATE_SHAPE_INVALID', '令牌落到数据节点的错误码');
});

check('T17 · nodes/ 新模块同样未泄漏进公开面', () => {
  const leaked = [
    'taskBehaviorOf',
    'assertTaskSupported',
    'effectKindOf',
    'isFeelScriptFormat',
    'unresolvedEffect',
    'isDataNode',
    'assertNotDataNode',
    'flowPasses',
    'dataRefOf',
    'evaluateScript',
  ].filter((k) => k in m);
  eq(leaked.length, 0, `被意外导出：${leaked.join(', ') || '无'}`);
});

// ---------------- T18 · 活动 / 子流程 4 类 ----------------

const T18 = '2026-10-01T00:00:00.000Z';

/** 最小 `ProcessDefinition`（探针不 import 测试夹具 —— 它只该跑**产物**） */
function defOf(processId, nodes, flows) {
  return {
    // ★ v2：一个定义就是一个流程 —— `id` 即 processId，节点与连线在顶层
    schemaVersion: '2.0.0',
    id: processId,
    nodes,
    flows,
  };
}
/** ★ v2：`approval` 是一等字段，故它直接返回审批配置本体（不再包一层 extension） */
const userApprovalOf = (value) => ({ approvers: [{ type: 'user', value }] });

await checkAsync('T18 · 内嵌子流程：令牌走进去、再从出口出来（子流程自身不在图里）', async () => {
  const def = defOf(
    'Process_1',
    [
      { id: 'Start_1', type: 'startEvent' },
      {
        id: 'Sub_1',
        type: 'subProcess',
        nodes: [
          { id: 'S_Start', type: 'startEvent' },
          { id: 'S_Task', type: 'userTask', approval: userApprovalOf('u_child') },
          { id: 'S_End', type: 'endEvent' },
        ],
        flows: [
          { id: 'fs1', from: 'S_Start', to: 'S_Task' },
          { id: 'fs2', from: 'S_Task', to: 'S_End' },
        ],
      },
      { id: 'Task_2', type: 'userTask', approval: userApprovalOf('u_boss') },
      { id: 'End_1', type: 'endEvent' },
    ],
    [
      { id: 'f1', from: 'Start_1', to: 'Sub_1' },
      { id: 'f2', from: 'Sub_1', to: 'Task_2' },
      { id: 'f3', from: 'Task_2', to: 'End_1' },
    ],
  );
  const store = m.createMemoryStore();
  const engine = m.createEngine({
    definitionSource: { async getDefinition(pid, v) { return pid === 'Process_1' && v === 1 ? def : null; } },
    store,
    clock: () => T18,
  });
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u_0' });

  const live = (s) => s.tokens.filter((t) => t.state === 'active');
  let st = await store.load(id);
  eq(live(st)[0].nodeId, 'Sub_1/S_Task', '展开后落点 = 内嵌的 userTask');
  eq(live(st)[0].assignee, 'u_child', '内嵌节点的办理人');

  await engine.submit(id, { action: 'approve', actor: 'u_child', at: T18 });
  st = await store.load(id);
  eq(live(st)[0].nodeId, 'Task_2', '子流程出口 → 主流程下一节点');
  assert(st.completedNodes.includes('Sub_1/S_Task'), 'completedNodes 应记内嵌节点');

  await engine.submit(id, { action: 'approve', actor: 'u_boss', at: T18 });
  st = await store.load(id);
  eq(st.status, 'completed', '走完全程');
});

await checkAsync('T18 · CallActivity：版本绑定（INV-16）+ 子实例回归', async () => {
  const main = defOf(
    'Process_1',
    [
      { id: 'Start_1', type: 'startEvent' },
      {
        id: 'Call_1',
        type: 'callActivity',
        // ★ v2：`call` 是一等字段 `CallSpec { processId, version }`（v1 是 calledElement + extension['floken:call']）
        call: { processId: 'Sub_Proc', version: 1 },
      },
      { id: 'Task_2', type: 'userTask', approval: userApprovalOf('u_boss') },
      { id: 'End_1', type: 'endEvent' },
    ],
    [
      { id: 'f1', from: 'Start_1', to: 'Call_1' },
      { id: 'f2', from: 'Call_1', to: 'Task_2' },
      { id: 'f3', from: 'Task_2', to: 'End_1' },
    ],
  );
  const subOf = (v) =>
    defOf(
      'Sub_Proc',
      [
        { id: 'S_Start', type: 'startEvent' },
        { id: `S_Task_v${v}`, type: 'userTask', approval: userApprovalOf(`u_v${v}`) },
        { id: 'S_End', type: 'endEvent' },
      ],
      [
        { id: 'g1', from: 'S_Start', to: `S_Task_v${v}` },
        { id: 'g2', from: `S_Task_v${v}`, to: 'S_End' },
      ],
    );

  const store = m.createMemoryStore();
  const engine = m.createEngine({
    definitionSource: {
      async getDefinition(pid, v) {
        if (pid === 'Process_1' && v === 1) return main;
        if (pid === 'Sub_Proc' && v === 1) return subOf(1);
        if (pid === 'Sub_Proc' && v === 2) return subOf(2); // ★ 存在更新的版本，但绑定的是 1
        return null;
      },
    },
    store,
    clock: () => T18,
  });
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u_0' });

  const parent = await store.load(id);
  eq(parent.childInstanceIds.length, 1, '父实例记下了子实例');
  eq(parent.tokens.filter((t) => t.state === 'waiting').length, 1, '父令牌在 callActivity 上等待');

  const childId = parent.childInstanceIds[0];
  const child = await store.load(childId);
  eq(child.processId, 'Sub_Proc', '子实例的 processId');
  eq(child.definitionVersion, 1, '★ 子实例用的是**绑定**的 v1（v2 存在也不理）');
  eq(child.parent.instanceId, id, '子实例指回父实例');
  eq(child.tokens[0].nodeId, 'S_Task_v1', '子实例停在 v1 的那个节点');

  await engine.submit(childId, { action: 'approve', actor: 'u_v1', at: T18 });
  eq((await store.load(childId)).status, 'completed', '子实例终态');

  const woken = await store.load(id);
  eq(woken.tokens.filter((t) => t.state === 'active')[0].nodeId, 'Task_2', '父实例被唤醒并继续');
  eq(woken.lastAction.name, 'callActivityReturn', '★ 审计记的是"子流程回归"，不是"某人审批"');

  await engine.submit(id, { action: 'approve', actor: 'u_boss', at: T18 });
  eq((await store.load(id)).status, 'completed', '主流程走完');
});

await checkAsync('T18 · 未实现的活动（transaction）→ 显式抛并指名 FR-E13', async () => {
  const def = defOf(
    'Process_1',
    [
      { id: 'Start_1', type: 'startEvent' },
      { id: 'T_1', type: 'transaction' },
      { id: 'End_1', type: 'endEvent' },
    ],
    [
      { id: 'f1', from: 'Start_1', to: 'T_1' },
      { id: 'f2', from: 'T_1', to: 'End_1' },
    ],
  );
  const engine = m.createEngine({
    definitionSource: { async getDefinition(pid, v) { return pid === 'Process_1' && v === 1 ? def : null; } },
    store: m.createMemoryStore(),
    clock: () => T18,
  });
  let err = null;
  try {
    await engine.start('Process_1', { definitionVersion: 1, starter: 'u_0' });
  } catch (e) {
    err = e;
  }
  eq(err?.code, 'ENGINE_STATE_SHAPE_INVALID', 'transaction 的错误码');
  assert(String(err?.details?.owner).includes('FR-E13'), `owner 应指名 FR-E13，实得 ${err?.details?.owner}`);
});

check('T18 · 门 2 需要的两个出口已公开；`nodes/activities` 其余内部未泄漏', () => {
  eq(typeof m.callReturnOf, 'function', 'callReturnOf（门 2 完成子流程回归）');
  eq(m.CALL_RETURN_ACTION, 'callActivityReturn', 'CALL_RETURN_ACTION');
  const leaked = [
    'activityBehaviorOf',
    'assertActivitySupported',
    'expandSubProcesses',
    'parkForCall',
    'callInstanceIdOf',
    'callTargetOf',
    'SUBPROCESS_EXIT_TYPE',
    'SUBPROCESS_PATH_SEP',
    'CALL_EXT_KEY',
  ].filter((k) => k in m);
  eq(leaked.length, 0, `被意外导出：${leaked.join(', ') || '无'}`);
});

// ---------------- T19 · DefinitionSource 版本语义与在途绑定（AC-E10） ----------------

/**
 * 同一 processId 的两版：**v2 在中间插入了 `Task_new`**。
 * 于是「走的是哪一版」一眼可辨 —— 在途实例若跑到 `Task_new`，就是偷偷换了图。
 */
function expenseVersioned(version) {
  const nodes = [
    { id: 'Start_1', type: 'startEvent' },
    { id: 'Task_a', type: 'userTask', approval: userApprovalOf('u_a') },
    ...(version === 2
      ? [{ id: 'Task_new', type: 'userTask', approval: userApprovalOf('u_new') }]
      : []),
    { id: 'Task_b', type: 'userTask', approval: userApprovalOf('u_b') },
    { id: 'End_1', type: 'endEvent' },
  ];
  const flows =
    version === 1
      ? [
          { id: 'f1', from: 'Start_1', to: 'Task_a' },
          { id: 'f2', from: 'Task_a', to: 'Task_b' },
          { id: 'f3', from: 'Task_b', to: 'End_1' },
        ]
      : [
          { id: 'f1', from: 'Start_1', to: 'Task_a' },
          { id: 'f2', from: 'Task_a', to: 'Task_new' },
          { id: 'f3', from: 'Task_new', to: 'Task_b' },
          { id: 'f4', from: 'Task_b', to: 'End_1' },
        ];
  return { schemaVersion: '2.0.0', id: 'expense', version, nodes, flows };
}

/** 可增删版本的 source（改版 / 下线只能靠它模拟）；取不到即 `null`，**不做任何回退** */
function versionedSource(initial) {
  const entries = { ...initial };
  return {
    entries,
    async getDefinition(pid, v) {
      return entries[`${pid}@${v}`] ?? null;
    },
  };
}

const activeNodesOf = (state) => state.tokens.filter((t) => t.state === 'active').map((t) => t.nodeId);

await checkAsync('T19 · 冒烟：同一 processId 两个版本各启一个实例，走的是各自的图', async () => {
  const store = m.createMemoryStore();
  const engine = m.createEngine({
    definitionSource: versionedSource({ 'expense@1': expenseVersioned(1), 'expense@2': expenseVersioned(2) }),
    store,
    clock: () => T18,
  });

  const oldOne = await engine.start('expense', { definitionVersion: 1, starter: 'u_0' });
  const newOne = await engine.start('expense', { definitionVersion: 2, starter: 'u_0' });

  await engine.submit(oldOne, { action: 'approve', actor: 'u_a', at: T18 });
  await engine.submit(newOne, { action: 'approve', actor: 'u_a', at: T18 });

  sameArray(activeNodesOf(await store.load(oldOne)), ['Task_b'], 'v1 实例的下一步');
  sameArray(activeNodesOf(await store.load(newOne)), ['Task_new'], 'v2 实例的下一步');
});

await checkAsync('T19 · 改版不影响在途：发布 v2 后，v1 实例仍按旧图走完（不去 Task_new）', async () => {
  const store = m.createMemoryStore();
  const source = versionedSource({ 'expense@1': expenseVersioned(1) });
  const engine = m.createEngine({ definitionSource: source, store, clock: () => T18 });

  const id = await engine.start('expense', { definitionVersion: 1, starter: 'u_0' });
  source.entries['expense@2'] = expenseVersioned(2); // 改版

  await engine.submit(id, { action: 'approve', actor: 'u_a', at: T18 });
  sameArray(activeNodesOf(await store.load(id)), ['Task_b'], '改版后在途实例的下一步');

  await engine.submit(id, { action: 'approve', actor: 'u_b', at: T18 });
  const done = await store.load(id);
  eq(done.status, 'completed', '实例状态');
  assert(!done.completedNodes.includes('Task_new'), '在途实例不得经过 v2 新增的节点');
});

await checkAsync('T19 · 绑定的版本被下线 → 抛 DEFINITION_MISSING（绝不静默改跑 v2）', async () => {
  const source = versionedSource({ 'expense@1': expenseVersioned(1), 'expense@2': expenseVersioned(2) });
  const store = m.createMemoryStore();
  const engine = m.createEngine({ definitionSource: source, store, clock: () => T18 });

  const id = await engine.start('expense', { definitionVersion: 1, starter: 'u_0' });
  delete source.entries['expense@1']; // v1 下线，库里只剩 v2

  let err = null;
  try {
    await engine.submit(id, { action: 'approve', actor: 'u_a', at: T18 });
  } catch (e) {
    err = e;
  }
  eq(err?.code, 'ENGINE_STATE_DEFINITION_MISSING', '错误码');
  eq(err?.details?.definitionVersion, 1, 'details.definitionVersion（仍指向绑定的那一版）');

  // 失败的提交不得留下半截状态
  const after = await store.load(id);
  sameArray(activeNodesOf(after), ['Task_a'], '失败后仍停在原节点');
  eq(after.rev, 1, '失败后 rev 不得前移');
});

// ---------------- T20 · 投递入口 deliverMessage / deliverSignal ----------------

const T20 = '2026-10-01T00:00:00.000Z';

/** `Start_1 → Catch_1（等 Msg_paid）→ Task_1（u1）→ End_1` */
const catchDefOf = (kind, name) =>
  defOf(
    'Process_1',
    [
      { id: 'Start_1', type: 'startEvent' },
      {
        id: 'Catch_1',
        type: 'intermediateCatchEvent',
        name: '等付款',
        eventDefinition: kind === 'signal' ? { type: 'signal', signalRef: name } : { type: 'message', messageRef: name },
      },
      { id: 'Task_1', type: 'userTask', approval: userApprovalOf('u1') },
      { id: 'End_1', type: 'endEvent' },
    ],
    [
      { id: 'Flow_1', from: 'Start_1', to: 'Catch_1' },
      { id: 'Flow_2', from: 'Catch_1', to: 'Task_1' },
      { id: 'Flow_3', from: 'Task_1', to: 'End_1' },
    ],
  );

const engineOn = (def, extra = {}) => {
  const store = m.createMemoryStore();
  const events = [];
  const engine = m.createEngine({
    definitionSource: { async getDefinition(pid, v) { return pid === 'Process_1' && v === 1 ? def : null; } },
    store,
    clock: () => T20,
    events: { emit: (e) => void events.push(e.name) },
    ...extra,
  });
  return { engine, store, events };
};

await checkAsync('T20 · ★ 令牌停在 `intermediateCatchEvent` 上等投递（不投递就绝不自己走过去）', async () => {
  const { engine, store } = engineOn(catchDefOf('message', 'Msg_paid'));
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u_0' });

  const parked = await store.load(id);
  eq(parked.status, 'running', '实例仍在跑（等待不算结束）');
  eq(parked.tokens[0].nodeId, 'Catch_1', '令牌停在等待节点');
  sameArray([parked.tokens[0].awaiting], [{ kind: 'message', name: 'Msg_paid' }], 'awaiting');

  const delta = await engine.deliverMessage(id, { name: 'Msg_paid', actor: 'bank' });
  eq(delta.instance.status, 'running', '唤醒后仍在跑（落到 Task_1）');
  const after = await store.load(id);
  eq(after.tokens[0].nodeId, 'Task_1', '唤醒后走到下一个节点');
  eq(after.tokens[0].awaiting, undefined, '等待态已摘掉');
  sameArray(delta.added.map((t) => t.nodeId), ['Task_1'], '产出一条待办');
});

await checkAsync('T20 · ★ 投递没命中 → 抛 ACTION_TARGET_INVALID 并给出「此刻在等什么」', async () => {
  const { engine, store } = engineOn(catchDefOf('message', 'Msg_paid'));
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u_0' });
  const before = await store.load(id);

  let err = null;
  try {
    await engine.deliverMessage(id, { name: 'msg_paid', actor: 'bank' }); // 差一个大小写
  } catch (e) {
    err = e;
  }
  eq(err?.code, 'ENGINE_ACTION_TARGET_INVALID', '错误码');
  sameArray(err?.details?.waiting, ['message:Msg_paid'], 'details.waiting（合法取值）');

  const after = await store.load(id);
  eq(after.rev, before.rev, '失败投递不得推进 rev');
  eq(after.tokens[0].nodeId, 'Catch_1', '失败投递不得留下半截状态');
});

await checkAsync('T20 · ★ `deliverSignal` 广播：两个实例各走各的图', async () => {
  const { engine, store } = engineOn(catchDefOf('signal', 'Sig_go'));
  const a = await engine.start('Process_1', { definitionVersion: 1, starter: 'u_0' });
  const b = await engine.start('Process_1', { definitionVersion: 1, starter: 'u_0' });

  const deltas = await engine.deliverSignal([a, b], { name: 'Sig_go', actor: 'erp' });
  eq(deltas.length, 2, '两个 delta');
  sameArray(deltas.map((d) => d.instance.instanceId), [a, b], '顺序 = 入参顺序（可重放）');
  eq((await store.load(a)).tokens[0].nodeId, 'Task_1', 'a 被唤醒');
  eq((await store.load(b)).tokens[0].nodeId, 'Task_1', 'b 被唤醒');

  // 一个都没命中 → 抛（完全无效果 = 静默丢弃）
  let err = null;
  try {
    await engine.deliverSignal([a], { name: 'Sig_other', actor: 'erp' });
  } catch (e) {
    err = e;
  }
  eq(err?.code, 'ENGINE_ACTION_TARGET_INVALID', '全落空 → 抛');
});

await checkAsync('T20 · ★ `intermediateThrowEvent` 显式抛（D-56 第二半：无对外消息出口）', async () => {
  const def = defOf(
    'Process_1',
    [
      { id: 'Start_1', type: 'startEvent' },
      { id: 'Throw_1', type: 'intermediateThrowEvent', name: '通知' },
      { id: 'End_1', type: 'endEvent' },
    ],
    [
      { id: 'Flow_1', from: 'Start_1', to: 'Throw_1' },
      { id: 'Flow_2', from: 'Throw_1', to: 'End_1' },
    ],
  );
  const { engine } = engineOn(def);
  let err = null;
  try {
    await engine.start('Process_1', { definitionVersion: 1, starter: 'u_0' });
  } catch (e) {
    err = e;
  }
  eq(err?.code, 'ENGINE_STATE_SHAPE_INVALID', '错误码');
  eq(String(err?.details?.owner).includes('FR-E14'), true, 'owner 指向 FR-E14');
});

check('T20 · 公开面：投递所需的纯函数已导出，`wakeTokens` 未泄漏（它会让人"只摘等待态不离开节点"）', () => {
  for (const k of [
    'deliverStep',
    'matchingTokens',
    'waitingNamesOf',
    'catchBindingOf',
    'MESSAGE_DELIVER_ACTION',
    'SIGNAL_DELIVER_ACTION',
    'DELIVER_ACTIONS',
  ]) {
    const want = k === 'DELIVER_ACTIONS' ? 'object' : k.startsWith('MESSAGE') || k.startsWith('SIGNAL') ? 'string' : 'function';
    eq(typeof m[k], want, `导出 ${k}`);
  }
  eq(m.MESSAGE_DELIVER_ACTION, 'deliverMessage', '消息动作名');
  eq(m.SIGNAL_DELIVER_ACTION, 'deliverSignal', '信号动作名');
  eq(m.wakeTokens, undefined, 'wakeTokens 不得导出（单独用会把令牌原地重新停车）');
});

// ---------------- T21 · 边界事件 / 事务取消 / 竞速 / 超时经 Scheduler ----------------

/**
 * ★ 这一段断言的是「**会不会静默地什么都不发生**」—— T21 这四件事的失败形式全是
 *   「没报错，但流程的行为跟图上画的不一样」，比抛错难查得多：
 *     - 边界事件没触发 → 撤回/超时配了却永远不发生；
 *     - 非中断边界把宿主也取消了 → 正在办的人凭空少一条待办；
 *     - 竞速没取消其余分支 → 流程莫名走出两条；
 *     - 超时没排程 / 没取消 → 该催的不催、已办结的还在催。
 */
const liveAt = (state, nodeId) =>
  (state?.tokens ?? []).filter((t) => t.nodeId === nodeId && t.state === 'active');

/** 记录型假 `Scheduler`：不真的定时，只记「排了什么 / 取消了什么」 */
const fakeScheduler = () => {
  const scheduled = [];
  const cancelled = [];
  let seq = 0;
  return {
    scheduled,
    cancelled,
    async schedule(req) {
      scheduled.push(req);
      seq += 1;
      return `h${seq}`;
    },
    async cancel(h) {
      cancelled.push(h);
    },
  };
};

const approvalWithTimeout = (who) => ({
  // ★ v2：`approval` 是一等字段（v1 是 extension['floken:approval']）
  approvers: [{ type: 'user', value: who }],
  timeout: { duration: 'P3D', actions: [{ type: 'remind' }, { type: 'autoApprove' }] },
});

/** `Task_1` 上挂一个消息边界事件（`cancelActivity` 不给 = 中断） */
const bndDefOf = (cancelActivity) =>
  defOf(
    'Process_1',
    [
      { id: 'Start_1', type: 'startEvent' },
      { id: 'Task_1', type: 'userTask', approval: userApprovalOf('u1') },
      { id: 'End_1', type: 'endEvent' },
      {
        id: 'Bnd_1',
        type: 'boundaryEvent',
        attachedTo: 'Task_1',
        ...(cancelActivity === undefined ? {} : { cancelActivity }),
        eventDefinition: { type: 'message', messageRef: 'Msg_cancel' },
      },
      { id: 'Task_2', type: 'userTask', approval: userApprovalOf('u2') },
      { id: 'End_2', type: 'endEvent' },
    ],
    [
      { id: 'Flow_1', from: 'Start_1', to: 'Task_1' },
      { id: 'Flow_2', from: 'Task_1', to: 'End_1' },
      { id: 'Flow_b', from: 'Bnd_1', to: 'Task_2' },
      { id: 'Flow_3', from: 'Task_2', to: 'End_2' },
    ],
  );

await checkAsync('T21 · ★ 中断边界事件（缺省 `cancelActivity`）：宿主待办消失，流程改走边界事件的出向', async () => {
  const { engine, store } = engineOn(bndDefOf());
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
  eq((await store.load(id)).tokens[0].nodeId, 'Task_1', '启动后停在宿主任务');

  const delta = await engine.deliverMessage(id, { name: 'Msg_cancel', actor: 'crm' });
  // ⚠️ `removed` 是**真删**的 taskId 列表（`${nodeId}:${tokenId}`），不是 `TaskView`
  eq(delta.removed.length, 1, '宿主待办被删掉一条');
  eq(String(delta.removed[0]).includes('Task_1:'), true, '删的是宿主那条');
  sameArray(delta.added.map((t) => t.assignee), ['u2'], '新增边界出向的待办');

  const st = await store.load(id);
  eq(liveAt(st, 'Task_1').length, 0, '宿主不再在途');
  eq(liveAt(st, 'Task_2').length, 1, '走到边界出向');
  eq(st.tokens.find((t) => t.nodeId === 'Task_1').state, 'cancelled', '宿主是**被打断**而非办完');
});

await checkAsync('T21 · ★ 非中断边界事件（`cancelActivity:false`）：宿主待办**还在**，另起一条', async () => {
  const { engine, store } = engineOn(bndDefOf(false));
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });

  const delta = await engine.deliverMessage(id, { name: 'Msg_cancel', actor: 'crm' });
  sameArray(delta.removed, [], '宿主待办一条都不许删');
  sameArray(delta.added.map((t) => t.assignee), ['u2'], '新增边界出向的待办');

  const st = await store.load(id);
  eq(liveAt(st, 'Task_1').length, 1, '宿主还在办');
  eq(liveAt(st, 'Task_2').length, 1, '边界那条并行在办');
  eq(st.status, 'running', '实例仍在跑');
});

await checkAsync('T21 · ★ 事务取消：作用域内**全部**在途令牌一并退场（拍平后靠 `Tx_1/` 前缀判）', async () => {
  const def = defOf(
    'Process_1',
    [
      { id: 'Start_1', type: 'startEvent' },
      {
        id: 'Tx_1',
        type: 'transaction',
        nodes: [
          { id: 'T_S', type: 'startEvent' },
          { id: 'T_P', type: 'parallelGateway' },
          { id: 'T_A', type: 'userTask', approval: userApprovalOf('u1') },
          { id: 'T_B', type: 'userTask', approval: userApprovalOf('u2') },
          { id: 'T_E', type: 'endEvent' },
        ],
        flows: [
          { id: 'ft1', from: 'T_S', to: 'T_P' },
          { id: 'ft2', from: 'T_P', to: 'T_A' },
          { id: 'ft3', from: 'T_P', to: 'T_B' },
          { id: 'ft4', from: 'T_A', to: 'T_E' },
          { id: 'ft5', from: 'T_B', to: 'T_E' },
        ],
      },
      { id: 'End_1', type: 'endEvent' },
      {
        id: 'Bnd_tx',
        type: 'boundaryEvent',
        attachedTo: 'Tx_1',
        eventDefinition: { type: 'message', messageRef: 'Msg_cancel' },
      },
      { id: 'Task_esc', type: 'userTask', approval: userApprovalOf('u_esc') },
      { id: 'End_2', type: 'endEvent' },
    ],
    [
      { id: 'f1', from: 'Start_1', to: 'Tx_1' },
      { id: 'f2', from: 'Tx_1', to: 'End_1' },
      { id: 'f3', from: 'Bnd_tx', to: 'Task_esc' },
      { id: 'f4', from: 'Task_esc', to: 'End_2' },
    ],
  );
  const { engine, store } = engineOn(def);
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
  eq(
    (await store.load(id)).tokens.filter((t) => t.state === 'active').length,
    2,
    '事务内两条并行在途',
  );

  await engine.deliverMessage(id, { name: 'Msg_cancel', actor: 'erp' });
  const st = await store.load(id);
  sameArray(
    st.tokens.filter((t) => t.nodeId.startsWith('Tx_1/') && t.state === 'active'),
    [],
    '作用域内不准留下任何在途令牌（只取消宿主会漏掉并行那条）',
  );
  eq(liveAt(st, 'Task_esc').length, 1, '走到边界出向');
});

await checkAsync('T21 · ★ `EventBasedGateway` 竞速：投递 A → A 分支走下去，B 分支取消', async () => {
  const def = defOf(
    'Process_1',
    [
      { id: 'Start_1', type: 'startEvent' },
      { id: 'EG_1', type: 'eventBasedGateway' },
      { id: 'C_A', type: 'intermediateCatchEvent', eventDefinition: { type: 'message', messageRef: 'Msg_A' } },
      { id: 'C_B', type: 'intermediateCatchEvent', eventDefinition: { type: 'message', messageRef: 'Msg_B' } },
      { id: 'Task_A', type: 'userTask', approval: userApprovalOf('u_a') },
      { id: 'Task_B', type: 'userTask', approval: userApprovalOf('u_b') },
      { id: 'End_1', type: 'endEvent' },
    ],
    [
      { id: 'f0', from: 'Start_1', to: 'EG_1' },
      { id: 'F_A', from: 'EG_1', to: 'C_A' },
      { id: 'F_B', from: 'EG_1', to: 'C_B' },
      { id: 'f1', from: 'C_A', to: 'Task_A' },
      { id: 'f2', from: 'C_B', to: 'Task_B' },
      { id: 'f3', from: 'Task_A', to: 'End_1' },
      { id: 'f4', from: 'Task_B', to: 'End_1' },
    ],
  );
  const { engine, store } = engineOn(def);
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });

  const parked = (await store.load(id)).tokens.filter((t) => t.awaiting !== undefined);
  sameArray(parked.map((t) => t.nodeId).sort(), ['C_A', 'C_B'], '两条分支都停下等');
  eq(new Set(parked.map((t) => t.race)).size, 1, '★ 两条分支**共享**同一个 `race`（否则取消不了对手）');

  const delta = await engine.deliverMessage(id, { name: 'Msg_A', actor: 'erp' });
  sameArray(delta.added.map((t) => t.assignee), ['u_a'], '赢家产出待办');

  const st = await store.load(id);
  eq(liveAt(st, 'Task_A').length, 1, 'A 分支走下去');
  eq(liveAt(st, 'Task_B').length, 0, 'B 分支不得也走下去');
  eq(st.tokens.find((t) => t.nodeId === 'C_B').state, 'cancelled', 'B 分支被取消');
  eq(st.tokens.find((t) => t.nodeId === 'Task_A').race, undefined, '赢家离开等待节点后退出竞速');
});

await checkAsync('T21 · ★ 超时经 `Scheduler`：按 `actions` 逐条排程，且内核**不**算 `dueAt`（Q33）', async () => {
  const def = defOf(
    'Process_1',
    [
      { id: 'Start_1', type: 'startEvent' },
      { id: 'Task_1', type: 'userTask', approval: approvalWithTimeout('u1') },
      { id: 'Task_2', type: 'userTask', approval: approvalWithTimeout('u2') },
      { id: 'End_1', type: 'endEvent' },
    ],
    [
      { id: 'f1', from: 'Start_1', to: 'Task_1' },
      { id: 'f2', from: 'Task_1', to: 'Task_2' },
      { id: 'f3', from: 'Task_2', to: 'End_1' },
    ],
  );
  const sched = fakeScheduler();
  const { engine, store } = engineOn(def, { scheduler: sched });
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });

  sameArray(sched.scheduled.map((r) => r.kind), ['remind', 'autoApprove'], '两个动作各排一次（可并存）');
  eq(sched.scheduled[0].instanceId, id, 'instanceId');
  eq(sched.scheduled[0].nodeId, 'Task_1', 'nodeId');
  eq(typeof sched.scheduled[0].tokenId, 'string', '★ tokenId（取消时要能定位到"哪条待办"）');
  eq(sched.scheduled[0].fromAt, T20, 'fromAt = 待办创建时刻');
  eq(sched.scheduled[0].timeout.duration, 'P3D', 'timeout = 定义上的**原始配置**（原样透传）');
  eq(
    typeof sched.scheduled[0].timeout.workCalendar,
    'string',
    '★ 工作日历只透传 id，内核不解释内容（`03` F-1：不得退化成 7×24）',
  );
  for (const r of sched.scheduled) {
    eq(r.dueAt, undefined, '★ 内核不得交 `dueAt`（Q33 禁止时态库；工作日历是业务数据）');
  }

  eq((await store.load(id)).tokens[0].timerHandles.length, 2, '★ handle 落进状态（否则办完时无从取消）');
});

await checkAsync('T21 · ★ 待办办完 → `cancel()` 掉旧 handle 并**清空** `timerHandles`', async () => {
  const def = defOf(
    'Process_1',
    [
      { id: 'Start_1', type: 'startEvent' },
      { id: 'Task_1', type: 'userTask', approval: approvalWithTimeout('u1') },
      { id: 'Task_2', type: 'userTask', approval: approvalWithTimeout('u2') },
      { id: 'End_1', type: 'endEvent' },
    ],
    [
      { id: 'f1', from: 'Start_1', to: 'Task_1' },
      { id: 'f2', from: 'Task_1', to: 'Task_2' },
      { id: 'f3', from: 'Task_2', to: 'End_1' },
    ],
  );
  const sched = fakeScheduler();
  const { engine, store } = engineOn(def, { scheduler: sched });
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
  const first = (await store.load(id)).tokens[0].timerHandles ?? [];

  await engine.submit(id, { action: 'approve', actor: 'u1', at: T20 });
  sameArray(sched.cancelled, first, '★ 旧 handle 一条不落（否则"已办结还在催办"）');

  /*
   * ⚠️ 令牌是**被复用**的（`tk_start` 从 `Task_1` 推进到 `Task_2`），所以不能写
   *   「找 `nodeId === 'Task_1'` 的令牌、其 `timerHandles` 应为 undefined」——
   *   那样"令牌整个消失"也会被判成对。这里钉死的是：**新 handle 在、旧 handle 不在**。
   */
  const now = (await store.load(id)).tokens.find((t) => t.state === 'active');
  eq(now?.nodeId, 'Task_2', '令牌被复用到下一个节点');
  eq(now?.timerHandles.length, 2, '新节点重新排了两条');
  for (const h of first) eq((now?.timerHandles ?? []).includes(h), false, `旧 handle ${h} 不得残留`);
  eq(sched.scheduled.filter((r) => r.nodeId === 'Task_2').length, 2, '新待办重新排程');
});

await checkAsync('T21 · ★ 不注入 `scheduler` = 不排程（超时是内核外能力，内核不假装做了）', async () => {
  const def = defOf(
    'Process_1',
    [
      { id: 'Start_1', type: 'startEvent' },
      { id: 'Task_1', type: 'userTask', approval: approvalWithTimeout('u1') },
      { id: 'End_1', type: 'endEvent' },
    ],
    [
      { id: 'f1', from: 'Start_1', to: 'Task_1' },
      { id: 'f2', from: 'Task_1', to: 'End_1' },
    ],
  );
  const { engine, store } = engineOn(def);
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
  const st = await store.load(id);
  eq(st.tokens[0].timerHandles, undefined, '没有 handle');
  eq(st.tokens[0].nodeId, 'Task_1', '流程照常推进（不注入只是没定时，不是不能跑）');
});

await checkAsync('T21 · ★ 投递未命中的报错要列出**边界事件**的等待（`details.waiting` 给合法取值）', async () => {
  const { engine } = engineOn(bndDefOf());
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u0' });
  let err = null;
  try {
    await engine.deliverMessage(id, { name: 'Msg_typo', actor: 'crm' });
  } catch (e) {
    err = e;
  }
  eq(err?.code, 'ENGINE_ACTION_TARGET_INVALID', '错误码');
  eq(
    err?.details?.waiting.includes('boundary:message:Msg_cancel'),
    true,
    '★ 边界事件**不持有令牌**，只看 `Token.awaiting` 会把它整个漏掉',
  );
});

check('T21 · 公开面：边界事件与定时器的纯函数已导出（宿主做订阅表要能枚举「谁在监听什么」）', () => {
  for (const k of [
    'BOUNDARY_TYPE',
    'boundaryBindingOf',
    'boundaryTokenIdOf',
    'armedBoundaries',
    'armedNamesOf',
    'cancelTargetsOf',
    'inScopeOf',
    'diffTimers',
    'timingKeysOf',
    'timeoutSpecOf',
    'timerKeyOf',
  ]) {
    const want = k === 'BOUNDARY_TYPE' ? 'string' : 'function';
    eq(typeof m[k], want, `导出 ${k}`);
  }
  eq(m.BOUNDARY_TYPE, 'boundaryEvent', 'BOUNDARY_TYPE');
  eq(m.inScopeOf('Task_1', 'Task_1'), true, 'inScopeOf：自己是自己的作用域');
  eq(m.inScopeOf('Tx_1/T_A', 'Tx_1'), true, 'inScopeOf：内嵌节点在宿主作用域里');
  eq(m.inScopeOf('Task_2', 'Task_1'), false, 'inScopeOf：别的节点不在');
  eq(m.timerKeyOf('Task_1', 'tk_1'), 'Task_1::tk_1', 'timerKeyOf（按令牌而非节点）');
});

// ---------------- T22 · 令牌轨迹 exportTrace() ----------------

/**
 * ★ 这一段断言的是「**轨迹能不能当证据用**」—— T22 的失败形式不是抛错，而是
 *   「导出来的东西看着挺全，其实少了一半 / `kind` 全标错 / 认错了令牌」：
 *     - `kind` 把 `start` 标成 `approval` → 审批统计把发起也数进去；
 *     - `from` / `to` 认错令牌 → 会签下张三的动作记到李四头上（"李四办了两次"）；
 *     - 审计被裁剪却不说 → 只剩最近 3 条被当成"一共就 3 条"（INV-17 要防的那个）。
 */

/** 简版报销三段（发起 → 部门经理 → 财务 → 结束） */
const traceDef = defOf(
  'Process_1',
  [
    { id: 'Start_1', type: 'startEvent' },
    { id: 'Task_1', type: 'userTask', approval: userApprovalOf('u_manager') },
    { id: 'Task_2', type: 'userTask', approval: userApprovalOf('u_finance') },
    { id: 'End_1', type: 'endEvent' },
  ],
  [
    { id: 'Flow_1', from: 'Start_1', to: 'Task_1' },
    { id: 'Flow_2', from: 'Task_1', to: 'Task_2' },
    { id: 'Flow_3', from: 'Task_2', to: 'End_1' },
  ],
);

check('T22 · `traceKindOf`：19 项审批动作 = approval，start / deliver* = system', () => {
  eq(typeof m.traceKindOf, 'function', 'traceKindOf 已导出');
  eq(m.traceKindOf('approve'), 'approval', 'approve 是审批动作');
  eq(m.traceKindOf('reject'), 'approval', 'reject 是审批动作');
  for (const s of m.SYSTEM_AUDIT_ACTIONS) {
    eq(m.traceKindOf(s), 'system', `${s} 不是审批动作`);
  }
  sameArray([...m.SYSTEM_AUDIT_ACTIONS].sort(), ['callActivityReturn', 'deliverMessage', 'deliverSignal', 'start'], 'SYSTEM_AUDIT_ACTIONS = D-62 的四类非审批动作名');
  // ★ 判据取**审批名单**：将来多一个系统动作也不会被静默标成 approval
  eq(m.traceKindOf('someFutureKernelAction'), 'system', '19 项之外一律 system');
});

check('T22 · `traceOf` 是 auditTrail 的只读投影：不增不减、不补算', () => {
  const st = m.subjectTokenOf; // 顺带确认定位口径已公开
  eq(typeof st, 'function', 'subjectTokenOf 已导出（plan 与 submit 共用一份判据）');
  const one = m.traceOf({
    instanceId: 'pi_1',
    auditTrail: [{ seq: 1, at: 'T', actor: 'u1', action: 'approve', payload: { comment: '同意' } }],
  });
  eq(one.entries.length, 1, '一一对应');
  eq(one.entries[0].kind, 'approval', 'kind 标对');
  sameArray(one.entries[0].payload, { comment: '同意' }, 'payload 原样带出');
  sameArray(Object.keys(one.entries[0]).sort(), ['action', 'actor', 'at', 'kind', 'payload', 'seq'], 'auditTrail 里没有的字段不补算');
  eq(one.truncated, false, 'seq 从 1 起 = 完整');
});

check('T22 · ★ 完整性：首条 seq > 1 ⇒ `truncated` 亮出来，且报出丢掉的区间', () => {
  const r = m.traceOf({ instanceId: 'pi_1', auditTrail: [{ seq: 5, at: 'T', actor: 'u1', action: 'approve' }] });
  eq(r.truncated, true, '被裁剪过');
  eq(r.droppedFromSeq, 1, 'dropFrom');
  eq(r.droppedToSeq, 4, 'dropTo');
});

await checkAsync('T22 · ★ 一条报销跑完：轨迹连成一条链，kind 全对', async () => {
  const { engine } = engineOn(traceDef);
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u_applicant' });
  await engine.submit(id, { action: 'approve', actor: 'u_manager' });
  await engine.submit(id, { action: 'approve', actor: 'u_finance' });

  const r = await engine.exportTrace(id);
  eq(r.truncated, false, '未裁剪');
  sameArray(r.entries.map((e) => [e.action, e.kind]), [['start', 'system'], ['approve', 'approval'], ['approve', 'approval']], '动作序列与 kind');
  sameArray(r.entries.map((e) => [e.from, e.to]), [['Start_1', 'Task_1'], ['Task_1', 'Task_2'], ['Task_2', 'End_1']], '★ from→to 首尾相接（轨迹真的连起来了）');
  eq(r.entries[1].actor, 'u_manager', '第二条是部门经理办的');
  eq(r.entries[1].tokenId, 'tk_start', 'tokenId 落上了');
});

await checkAsync('T22 · ★ 与门 2 的 `traceOf(state)` 逐字相同（两条路径不许分叉）', async () => {
  const { engine, store } = engineOn(traceDef);
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u_applicant' });
  await engine.submit(id, { action: 'approve', actor: 'u_manager' });
  const st = await store.load(id);
  sameArray(await engine.exportTrace(id), m.traceOf(st), 'exportTrace === traceOf(load)');
});

await checkAsync('T22 · ★ maxAuditEntries 溢出后：轨迹仍在 + `truncated` 亮出来（INV-17）', async () => {
  const { engine } = engineOn(traceDef, { maxAuditEntries: 1 });
  const id = await engine.start('Process_1', { definitionVersion: 1, starter: 'u_applicant' });
  await engine.submit(id, { action: 'approve', actor: 'u_manager' });
  await engine.submit(id, { action: 'approve', actor: 'u_finance' });

  const r = await engine.exportTrace(id);
  eq(r.entries.length, 1, '只剩最近一条');
  eq(r.entries[0].action, 'approve', '剩的是最后一次提交');
  eq(r.truncated, true, '★ 必须说"不完整"，否则会被当成一共就一条');
  eq(r.droppedFromSeq, 1, 'dropFrom');
  eq(r.droppedToSeq, 2, 'dropTo');
});

await checkAsync('T22 · 实例不存在 → ENGINE_STATE_NOT_FOUND（不返回空数组糊过去）', async () => {
  const { engine } = engineOn(traceDef);
  try {
    await engine.exportTrace('pi_nope');
    throw new Error('应当抛错');
  } catch (e) {
    eq(e.code, 'ENGINE_STATE_NOT_FOUND', '错误码');
  }
});

// ---------------- ADR-009 · 宿主自定义扩展属性（真跑 dist 产物） ----------------

const extDef = () =>
  defOf(
    'Process_1',
    [
      { id: 'Start_1', type: 'startEvent' },
      {
        id: 'GW',
        type: 'exclusiveGateway',
        extension: { 'acme:gwTag': 'main' },
      },
      {
        id: 'Task_urgent',
        type: 'userTask',
        approval: { approvers: [{ type: 'user', value: 'u_boss' }] },
        // ★ v2：`extension` 只装宿主自己的东西；结构化值**也给**（ADR-009 细则④ 已放开）
        extension: {
          'acme:priority': 'high',
          'acme:slaHours': '48',
          'acme:tags': ['finance'],
          'acme:rule': { limit: 1 },
        },
      },
      {
        id: 'Task_normal',
        type: 'userTask',
        approval: { approvers: [{ type: 'user', value: 'u_staff' }] },
        extension: { 'acme:priority': 'low' },
      },
      { id: 'End_1', type: 'endEvent' },
    ],
    [
      { id: 'Flow_1', from: 'Start_1', to: 'GW' },
      { id: 'Flow_2', from: 'GW', to: 'Task_urgent', condition: 'target.priority = "high"' },
      { id: 'Flow_3', from: 'GW', to: 'Task_normal' },
      { id: 'Flow_4', from: 'Task_urgent', to: 'End_1' },
      { id: 'Flow_5', from: 'Task_normal', to: 'End_1' },
    ],
  );

/** 收集落到的待办（`nodeId/assignee`） */
const projectionOf = (seen) => ({
  async apply(_id, delta) { for (const v of delta.added) seen.push(`${v.nodeId}/${v.assignee}`); },
  async sync() { /* 无对账场景 */ },
});

await checkAsync('ADR-009 · ★ opt-in 后 **内置 FEEL** 写 `target.priority = "high"` 真选中加急分支', async () => {
  const seen = [];
  const { engine } = engineOn(extDef(), { extensionVars: {}, projection: projectionOf(seen) });
  await engine.start('Process_1', { definitionVersion: 1, starter: 'u_x' });
  sameArray(seen, ['Task_urgent/u_boss'], '★ 判据是真走了哪条分支，不是"调过并入函数"');
});

await checkAsync('ADR-009 · ★ 不 opt-in → 同一个表达式**静默走另一条分支**（行为钉死，文档要如实警示）', async () => {
  const seen = [];
  const { engine } = engineOn(extDef(), { projection: projectionOf(seen) });
  await engine.start('Process_1', { definitionVersion: 1, starter: 'u_x' });
  // `target` 未定义 → 等值比较求值为 false（不是 null），故**不抛错**地走错分支
  sameArray(seen, ['Task_normal/u_staff'], '不 opt-in 的代价：安静地走错');
});

await checkAsync('ADR-009 · 只读字段恒给：一等字段不外泄、结构化值也给出、键带前缀', async () => {
  const seen = [];
  const { engine } = engineOn(extDef(), {
    projection: projectionOf(seen),
    conditionHandler: {
      evaluate(_expr, ctx) {
        seen.push(JSON.stringify({ n: ctx.nodeExtensions, t: ctx.targetExtensions }));
        return false;
      },
    },
  });
  await engine.start('Process_1', { definitionVersion: 1, starter: 'u_x' });
  const bag = JSON.parse(seen.find((s) => s.includes('gwTag')));
  eq(bag.n['acme:gwTag'], 'main', '当前节点 = 网关自己的属性');
  eq(bag.t['acme:priority'], 'high', '目标节点 = 分支通向的节点');
  // ★ v2：排除判据从「`floken:*` 前缀」改为「模型一等字段键」（前缀随 XML 一起消失）
  eq(bag.t['approval'], undefined, '★ 模型的一等字段不外泄');
  // ★ v2 起结构化值**也给出**（旧口径"只给标量"的理由是 XML 属性装不下，已不成立）
  eq(JSON.stringify(bag.t['acme:tags']), '["finance"]', '★ 结构化值原样给出');
  eq(bag.t['acme:slaHours'], '48', '★ XML 往返后是字符串 —— cast 由宿主声明');
});

await checkAsync('ADR-009 · cast：声明 number 后 `"48"` 变 48；不声明则原样（引擎不猜类型）', async () => {
  const seen = [];
  const { engine } = engineOn(extDef(), {
    extensionVars: { casts: { 'acme:slaHours': 'number' } },
    projection: projectionOf(seen),
    conditionHandler: {
      evaluate(_expr, ctx) { seen.push(ctx.variables); return false; },
    },
  });
  await engine.start('Process_1', { definitionVersion: 1, starter: 'u_x' });
  const vars = seen.find((v) => typeof v === 'object' && 'target' in v);
  eq(vars.target.slaHours, 48, '按声明还原成数字');
  eq(typeof vars.target.slaHours, 'number', '类型是 number，不是 "48"');
  eq(vars.node.gwTag, 'main', '并入层已去前缀（FEEL 引用不到带冒号的键）');
});

await checkAsync('ADR-009 · 变量名撞车 → 抛 OPTION_INVALID（不静默覆盖业务变量）', async () => {
  const { engine } = engineOn(extDef(), { extensionVars: {} });
  try {
    await engine.start('Process_1', { definitionVersion: 1, starter: 'u_x', variables: { node: { mine: 1 } } });
    throw new Error('应当抛错');
  } catch (e) {
    eq(e.code, 'ENGINE_OPTION_INVALID', '错误码');
    assert(String(e.details?.reason ?? '').includes('node'), 'reason 要点名撞了哪个键');
  }
});

// ---------------- 汇总 ----------------

let failed = 0;
for (const [good, name] of results) {
  if (good) console.log(`\u2713 ${name}`);
  else {
    failed += 1;
    console.error(`\u2717 ${name}`);
  }
}
console.log('');
if (failed > 0) {
  console.error(`SMOKE FAILED — ${results.length - failed}/${results.length} 项通过`);
  process.exit(1);
}
console.log(`SMOKE OK — ${results.length}/${results.length} 项通过`);
