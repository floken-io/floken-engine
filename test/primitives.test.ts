/**
 * 10 个内核原语的契约测试（T8）。
 *
 * 验收对应：`ARCHITECTURE.md` §9-T8「**NFR-E6** —— 全部用 fake SPI 单测，测试文件
 * **不得 import 任何 `actions/`**（分层守卫）；`jumpTo` vs `advance`、`transfer` vs `jumpTo`、
 * `halt` vs `suspend` 三对语义差别的对照测试」。
 *
 * ★ **三对语义差别是本档的重头**：它们正是「内核为什么必须业务无知」的论据 ——
 *   差别只在内核层讲得清（上层看都是"退回去"/"换个人"/"停掉"），
 *   若原语层把 `jumpTo` 和 `rollbackTo` 做成一回事，上层的驳回与撤销就会互相污染。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ENGINE_ERROR_CODES } from '../src/core/errors';
import {
  PRIMITIVE_GROUPS,
  PRIMITIVE_NAMES,
  advance,
  cancelInstances,
  delegate,
  halt,
  jumpTo,
  rollbackTo,
  resume,
  spawnInstances,
  suspend,
  transfer,
} from '../src/core/primitives';
import type { InstanceState } from '../src/core/state';
import { cloneState, deepEqual, isTerminalStatus } from '../src/core/state';
import { makeState } from './helpers/state';

/** 一个「开始 → 审批」的两节点状态，带一个在途令牌 */
function base(over: Partial<InstanceState> = {}): InstanceState {
  return makeState({
    tokens: [{ id: 'tk_1', nodeId: 'Task_1', state: 'active', assignee: 'u1' }],
    completedNodes: ['Start_1'],
    ...over,
  });
}

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `应当抛出 ${code}`).toMatchObject({ code });
}

const tokenOf = (s: InstanceState, id: string) => s.tokens.find((t) => t.id === id);

describe('@floken-io/engine · 10 个内核原语', () => {
  // ---------------- ① 计数契约 ----------------

  describe('① 计数契约（03 §3：8 令牌级 + 2 实例级）', () => {
    it('PRIMITIVE_NAMES 恰好 10 个', () => {
      expect(PRIMITIVE_NAMES.length).toBe(10);
      expect(new Set(PRIMITIVE_NAMES).size).toBe(10);
    });

    it('分组 8 + 2，扁平化后与名表逐项一致（顺序也算契约）', () => {
      expect(PRIMITIVE_GROUPS.token.length).toBe(8);
      expect(PRIMITIVE_GROUPS.instance.length).toBe(2);
      expect([...PRIMITIVE_GROUPS.token, ...PRIMITIVE_GROUPS.instance]).toEqual([
        ...PRIMITIVE_NAMES,
      ]);
    });

    it('实例级只有 suspend / resume（halt 属令牌级清场，不是可恢复冻结）', () => {
      expect(PRIMITIVE_GROUPS.instance).toEqual(['suspend', 'resume']);
    });
  });

  // ---------------- ② 分层守卫 ----------------

  describe('② 分层守卫（AGENTS.md §4.1：core 不得 import 域）', () => {
    it('core/ 下任何文件都不得 import 上层（actions / nodes / runtime / store / eval）', () => {
      const dir = new URL('../src/core/', import.meta.url);
      const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
      expect(files.length).toBeGreaterThanOrEqual(7);

      for (const f of files) {
        const src = readFileSync(new URL(f, dir), 'utf8');
        const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((x) => x[1] ?? '');
        const upward = imports.filter((s) =>
          /^\.\.\/(actions|nodes|runtime|store|eval|entries)\//.test(s),
        );
        expect(upward, `${f} 反向依赖了上层：${upward.join(', ')}`).toEqual([]);
      }
    });

    it('★ 本测试文件不得 import 任何 actions/（NFR-E6：内核须能脱离审批概念单测）', () => {
      const self = readFileSync(new URL('primitives.test.ts', import.meta.url), 'utf8');
      expect(self).not.toMatch(/from\s+['"][^'"]*\/actions\//);
    });
  });

  // ---------------- ③ 纯函数性 ----------------

  describe('③ 纯函数性（同 plan()：不读时钟、不改入参）', () => {
    it.each([
      ['advance', () => advance(base(), { tokenId: 'tk_1', to: 'Task_2' })],
      ['jumpTo', () => jumpTo(base(), { tokenId: 'tk_1', to: 'Start_1' })],
      ['rollbackTo', () => rollbackTo(base(), { tokenId: 'tk_1', to: 'Start_1' })],
      [
        'spawnInstances',
        () => spawnInstances(base(), { nodeId: 'Task_1', groupId: 'g1', assignees: ['u2', 'u3'] }),
      ],
      ['cancelInstances', () => cancelInstances(base(), { tokenIds: ['tk_1'] })],
      ['transfer', () => transfer(base(), { tokenId: 'tk_1', assignee: 'u9' })],
      ['delegate', () => delegate(base(), { tokenId: 'tk_1', assignee: 'u9' })],
      ['halt', () => halt(base())],
      ['suspend', () => suspend(base())],
      ['resume', () => resume(base({ status: 'suspended' }))],
    ])('%s：两次调用结果深等（纯函数）', (_name, run) => {
      expect(deepEqual(run(), run())).toBe(true);
    });

    it('原语不改入参对象（返回的是副本）', () => {
      const s = base();
      const before = cloneState(s);
      advance(s, { tokenId: 'tk_1', to: 'Task_2' });
      expect(deepEqual(s, before)).toBe(true);
    });

    it('★ 原语不碰 rev / updatedAt / auditTrail —— 那是 plan() 的账（INV-4 不重复记账）', () => {
      const s = base();
      const next = jumpTo(s, { tokenId: 'tk_1', to: 'Start_1' });
      expect(next.rev).toBe(s.rev);
      expect(next.updatedAt).toBe(s.updatedAt);
      expect(next.auditTrail).toEqual(s.auditTrail);
    });
  });

  // ---------------- ④ 令牌级原语逐个 ----------------

  describe('④ 令牌级原语（8）', () => {
    it('advance：令牌移到 to，且**离开的节点**记进 completedNodes', () => {
      const next = advance(base(), { tokenId: 'tk_1', to: 'Task_2' });
      expect(tokenOf(next, 'tk_1')?.nodeId).toBe('Task_2');
      expect(next.completedNodes).toEqual(['Start_1', 'Task_1']);
    });

    it('jumpTo：目标**必须** ∈ completedNodes（否则抛，不许凭空造历史）', () => {
      expectCode(
        () => jumpTo(base(), { tokenId: 'tk_1', to: 'Task_9' }),
        ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
      );
    });

    it('jumpTo：令牌移到 to，且把 to **摘出** completedNodes（要重办）', () => {
      const s = makeState({
        tokens: [{ id: 'tk_1', nodeId: 'Task_2', state: 'active', assignee: 'u1' }],
        completedNodes: ['Start_1', 'Task_1'],
      });
      const next = jumpTo(s, { tokenId: 'tk_1', to: 'Task_1' });
      expect(tokenOf(next, 'tk_1')?.nodeId).toBe('Task_1');
      expect(next.completedNodes).toEqual(['Start_1', 'Task_2']);
    });

    it('rollbackTo：completedNodes **截断**到 to 之前（to 及其之后全部撤销）', () => {
      const s = makeState({
        tokens: [{ id: 'tk_1', nodeId: 'Task_3', state: 'active', assignee: 'u1' }],
        completedNodes: ['Start_1', 'Task_1', 'Task_2'],
      });
      const next = rollbackTo(s, { tokenId: 'tk_1', to: 'Task_1' });
      expect(next.completedNodes).toEqual(['Start_1']);
      expect(tokenOf(next, 'tk_1')?.nodeId).toBe('Task_1');
    });

    it('spawnInstances：按 groupId 确定性生成令牌 id（纯函数不能用随机数）', () => {
      const next = spawnInstances(base(), {
        nodeId: 'Task_1',
        groupId: 'g1',
        assignees: ['u2', 'u3', 'u4'],
      });
      expect(next.tokens.map((t) => t.id)).toEqual(['tk_1', 'g1#0', 'g1#1', 'g1#2']);
      expect(next.tokens.slice(1).map((t) => t.assignee)).toEqual(['u2', 'u3', 'u4']);
      expect(next.tokens.slice(1).every((t) => t.instanceGroup === 'g1')).toBe(true);
      expect(next.tokens.slice(1).every((t) => t.state === 'active')).toBe(true);
    });

    it('spawnInstances：replaceTokenId 指代的那个令牌被移除（会签展开的占位令牌）', () => {
      const next = spawnInstances(base(), {
        nodeId: 'Task_1',
        groupId: 'g1',
        assignees: ['u2', 'u3'],
        replaceTokenId: 'tk_1',
      });
      expect(next.tokens.map((t) => t.id)).toEqual(['g1#0', 'g1#1']);
    });

    it('spawnInstances：空办理人 → 抛（INV-13：不得产生 0 办待人却 active 的节点）', () => {
      expectCode(
        () => spawnInstances(base(), { nodeId: 'Task_1', groupId: 'g1', assignees: [] }),
        ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
      );
    });

    it('cancelInstances：按 group 取消在途令牌，已终态令牌不受影响', () => {
      const s = makeState({
        tokens: [
          { id: 'tk_1', nodeId: 'Task_1', state: 'active', assignee: 'u1', instanceGroup: 'g1' },
          { id: 'tk_2', nodeId: 'Task_1', state: 'active', assignee: 'u2', instanceGroup: 'g1' },
          { id: 'tk_3', nodeId: 'Task_1', state: 'active', assignee: 'u3', instanceGroup: 'g2' },
          { id: 'tk_4', nodeId: 'Task_1', state: 'completed', assignee: 'u4', instanceGroup: 'g1' },
        ],
      });
      const next = cancelInstances(s, { groupId: 'g1' });
      expect(tokenOf(next, 'tk_1')?.state).toBe('cancelled');
      expect(tokenOf(next, 'tk_2')?.state).toBe('cancelled');
      expect(tokenOf(next, 'tk_3')?.state).toBe('active');
      expect(tokenOf(next, 'tk_4')?.state).toBe('completed');
    });

    it('cancelInstances：幂等 —— 范围内没有在途令牌时原样返回（汇聚取消常常已无人可取消）', () => {
      const s = makeState({ tokens: [{ id: 'tk_1', nodeId: 'Task_1', state: 'cancelled' }] });
      const next = cancelInstances(s, { groupId: 'nobody' });
      expect(deepEqual(next, s)).toBe(true);
    });

    it('cancelInstances：不给任何范围 → 抛（"取消一切"是 halt 的语义，不许静默代劳）', () => {
      expectCode(() => cancelInstances(base(), {}), ENGINE_ERROR_CODES.STATE_SHAPE_INVALID);
    });

    it('transfer：换人，令牌位置不变，且**不留** returnTo', () => {
      const next = transfer(base(), { tokenId: 'tk_1', assignee: 'u9' });
      expect(tokenOf(next, 'tk_1')?.assignee).toBe('u9');
      expect(tokenOf(next, 'tk_1')?.nodeId).toBe('Task_1');
      expect(tokenOf(next, 'tk_1')?.returnTo).toBeUndefined();
    });

    it('delegate：换人并**保留回归路径**（returnTo = 委派前的办理人）', () => {
      const next = delegate(base(), { tokenId: 'tk_1', assignee: 'u9' });
      expect(tokenOf(next, 'tk_1')?.assignee).toBe('u9');
      expect(tokenOf(next, 'tk_1')?.returnTo).toBe('u1');
    });

    it('delegate：委派前没有办理人 → 不设 returnTo（没有可回归的对象）', () => {
      const s = makeState({ tokens: [{ id: 'tk_1', nodeId: 'Task_1', state: 'active' }] });
      const next = delegate(s, { tokenId: 'tk_1', assignee: 'u9' });
      expect(tokenOf(next, 'tk_1')?.returnTo).toBeUndefined();
    });

    it('halt：在途令牌全部 cancelled + status = terminated', () => {
      const s = makeState({
        tokens: [
          { id: 'tk_1', nodeId: 'Task_1', state: 'active' },
          { id: 'tk_2', nodeId: 'Task_2', state: 'waiting' },
          { id: 'tk_3', nodeId: 'Task_3', state: 'completed' },
        ],
      });
      const next = halt(s);
      expect(next.status).toBe('terminated');
      expect(tokenOf(next, 'tk_1')?.state).toBe('cancelled');
      expect(tokenOf(next, 'tk_2')?.state).toBe('cancelled');
      expect(tokenOf(next, 'tk_3')?.state).toBe('completed');
    });
  });

  // ---------------- ⑤ 实例级原语 ----------------

  describe('⑤ 实例级原语（2 · INV-5）', () => {
    it('suspend：status = suspended，且**令牌一律不动**（冻结 ≠ 清场）', () => {
      const s = base();
      const next = suspend(s);
      expect(next.status).toBe('suspended');
      expect(deepEqual(next.tokens, s.tokens)).toBe(true);
      expect(next.tokens.every((t) => t.state === 'active')).toBe(true);
    });

    it('suspend：幂等 —— 重复挂起原样返回，不抛', () => {
      const s = base({ status: 'suspended' });
      const next = suspend(s);
      expect(deepEqual(next, s)).toBe(true);
    });

    it('★ INV-5：suspended 下除 resume 外**所有**令牌级原语都抛 STATE_SUSPENDED', () => {
      const s = base({ status: 'suspended' });
      const calls: Array<[string, () => unknown]> = [
        ['advance', () => advance(s, { tokenId: 'tk_1', to: 'Task_2' })],
        ['jumpTo', () => jumpTo(s, { tokenId: 'tk_1', to: 'Start_1' })],
        ['rollbackTo', () => rollbackTo(s, { tokenId: 'tk_1', to: 'Start_1' })],
        [
          'spawnInstances',
          () => spawnInstances(s, { nodeId: 'Task_1', groupId: 'g1', assignees: ['u2'] }),
        ],
        ['cancelInstances', () => cancelInstances(s, { tokenIds: ['tk_1'] })],
        ['transfer', () => transfer(s, { tokenId: 'tk_1', assignee: 'u9' })],
        ['delegate', () => delegate(s, { tokenId: 'tk_1', assignee: 'u9' })],
      ];
      for (const [name, run] of calls) {
        expectCode(run, ENGINE_ERROR_CODES.STATE_SUSPENDED);
        expect(name).toBeTruthy();
      }
    });

    it('resume：只能从 suspended 解冻，令牌从**原处**继续（位置不变）', () => {
      const s = base({ status: 'suspended' });
      const next = resume(s);
      expect(next.status).toBe('running');
      expect(tokenOf(next, 'tk_1')?.nodeId).toBe('Task_1');
    });

    it('resume：用在非挂起实例 → 抛（不静默成 no-op）', () => {
      expectCode(() => resume(base()), ENGINE_ERROR_CODES.STATE_SHAPE_INVALID);
    });

    it('★ 解冻后原语恢复可用（挂起 → 解冻 → 推进，这条链路必须通）', () => {
      const s = base({ status: 'suspended' });
      const back = resume(s);
      const next = advance(back, { tokenId: 'tk_1', to: 'Task_2' });
      expect(tokenOf(next, 'tk_1')?.nodeId).toBe('Task_2');
    });
  });

  // ---------------- ⑥ 终态门禁 ----------------

  describe('⑥ 终态门禁（INV-2）', () => {
    it.each(['completed', 'terminated', 'cancelled'] as const)(
      'status=%s：所有原语都抛 STATE_TERMINAL',
      (status) => {
        const s = base({ status });
        expect(isTerminalStatus(status)).toBe(true);
        const calls: Array<() => unknown> = [
          () => advance(s, { tokenId: 'tk_1', to: 'Task_2' }),
          () => jumpTo(s, { tokenId: 'tk_1', to: 'Start_1' }),
          () => rollbackTo(s, { tokenId: 'tk_1', to: 'Start_1' }),
          () => spawnInstances(s, { nodeId: 'Task_1', groupId: 'g1', assignees: ['u2'] }),
          () => cancelInstances(s, { tokenIds: ['tk_1'] }),
          () => transfer(s, { tokenId: 'tk_1', assignee: 'u9' }),
          () => delegate(s, { tokenId: 'tk_1', assignee: 'u9' }),
          () => halt(s),
          () => suspend(s),
          () => resume(s),
        ];
        for (const run of calls) {
          expectCode(run, ENGINE_ERROR_CODES.STATE_TERMINAL);
        }
      },
    );

    it('未知 tokenId / 已结束的令牌 → 抛（不许静默无效果）', () => {
      expectCode(
        () => advance(base(), { tokenId: 'nope', to: 'Task_2' }),
        ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
      );
      const done = makeState({ tokens: [{ id: 'tk_1', nodeId: 'Task_1', state: 'completed' }] });
      expectCode(
        () => advance(done, { tokenId: 'tk_1', to: 'Task_2' }),
        ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
      );
    });
  });

  // ---------------- ⑦ 三对语义差别（T8 的专项验收） ----------------

  describe('⑦ 三对语义差别对照（03 §164-171）', () => {
    it('★ jumpTo vs advance：jumpTo 是"往回摘"，advance 是"往前记"', () => {
      // 同一个"从 Task_1 到 Task_2"的移动，两者的 completedNodes 处理完全相反
      const s = makeState({
        tokens: [{ id: 'tk_1', nodeId: 'Task_1', state: 'active', assignee: 'u1' }],
        completedNodes: ['Start_1', 'Task_2'],
      });
      // advance：正向推进，Task_1 办完 → 记进去；Task_2 的记录**保留**
      const fwd = advance(s, { tokenId: 'tk_1', to: 'Task_2' });
      expect(fwd.completedNodes).toEqual(['Start_1', 'Task_2', 'Task_1']);

      // jumpTo：回到 Task_2 重办 → 把 Task_2 **摘出来**
      const back = jumpTo(s, { tokenId: 'tk_1', to: 'Task_2' });
      expect(back.completedNodes).toEqual(['Start_1', 'Task_1']);
    });

    it('★ jumpTo vs rollbackTo：只差"撤销下游"四字', () => {
      const s = makeState({
        tokens: [
          { id: 'tk_1', nodeId: 'Task_3', state: 'active', assignee: 'u1' },
          { id: 'tk_2', nodeId: 'Task_4', state: 'active', assignee: 'u2' },
        ],
        completedNodes: ['Start_1', 'Task_1', 'Task_2'],
      });
      // jumpTo：只摘目标本身，**下游在途令牌保留**
      const jumped = jumpTo(s, { tokenId: 'tk_1', to: 'Task_1' });
      expect(jumped.completedNodes).toEqual(['Start_1', 'Task_2', 'Task_3']);
      expect(tokenOf(jumped, 'tk_2')?.state).toBe('active');

      // rollbackTo：截断到目标之前，**下游在途令牌全部取消**
      const rolled = rollbackTo(s, { tokenId: 'tk_1', to: 'Task_1' });
      expect(rolled.completedNodes).toEqual(['Start_1']);
      expect(tokenOf(rolled, 'tk_2')?.state).toBe('cancelled');
    });

    it('★ transfer vs jumpTo：转办不动令牌，驳回移动令牌', () => {
      const s = base();
      const moved = jumpTo(s, { tokenId: 'tk_1', to: 'Start_1' });
      const stayed = transfer(s, { tokenId: 'tk_1', assignee: 'u9' });
      expect(tokenOf(moved, 'tk_1')?.nodeId).toBe('Start_1');
      expect(tokenOf(stayed, 'tk_1')?.nodeId).toBe('Task_1');
      // 两者都换了"谁在办"的含义不同：前者是节点回到起点，后者只是换人
      expect(tokenOf(stayed, 'tk_1')?.assignee).toBe('u9');
    });

    it('★ halt vs suspend：不可逆清场 vs 可恢复冻结', () => {
      const s = base();
      const frozen = suspend(s);
      const killed = halt(s);

      // suspend：令牌原样保留，可恢复
      expect(frozen.tokens.every((t) => t.state === 'active')).toBe(true);
      expect(resume(frozen).status).toBe('running');

      // halt：令牌全部取消、实例终态、且**不可逆**（再动就抛终态错）
      expect(killed.tokens.every((t) => t.state === 'cancelled')).toBe(true);
      expect(killed.status).toBe('terminated');
      expectCode(() => resume(killed), ENGINE_ERROR_CODES.STATE_TERMINAL);
    });

    it('★ transfer vs delegate：转办不留回归路径，委派留', () => {
      const s = base();
      expect(tokenOf(transfer(s, { tokenId: 'tk_1', assignee: 'u9' }), 'tk_1')?.returnTo).toBeUndefined();
      expect(tokenOf(delegate(s, { tokenId: 'tk_1', assignee: 'u9' }), 'tk_1')?.returnTo).toBe('u1');
    });
  });
});
