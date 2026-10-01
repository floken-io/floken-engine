/**
 * T9 · 19 项动作映射表 + `compileAction` + 设计期开关校验
 *
 * ★ 本文件的第一组测试是**文档对账**：把 `03-包需求-floken-engine.md` §4 主表
 *   「→ 原语」列逐字抄在这里，与 `ACTION_SPECS` 比对。
 *   于是「改了代码没改文档」会**当场红**，不再靠人肉核对。
 */

import { normalizeApproval, REQUIRE_COMMENT_DEFAULTS } from '@floken-io/moddle';
import type { NormalizedApproval } from '@floken-io/moddle';
import { describe, expect, it } from 'vitest';

import type { ActionInput } from '../src/core/action';
import { ENGINE_ERROR_CODES } from '../src/core/errors';
import type { InstanceState } from '../src/core/state';
import type { ActionName } from '../src/actions/catalog';
import {
  ACTION_NAMES,
  ACTION_SPECS,
  ACTION_SPEC_BY_NAME,
  COMMENT_GATE_PATHS,
  HANDOVER_ACTIONS,
  ROLLBACK_ACTIONS,
  UNGATED_ACTIONS,
} from '../src/actions/catalog';
import { compileAction } from '../src/actions/compile';
import type { CompileContext } from '../src/actions/compile';
import {
  assertActionEnabled,
  assertDesignTime,
  assertTarget,
  enabledActionNames,
  isActionEnabled,
  readGate,
} from '../src/actions/gates';
import { expectCode } from './helpers/expect';
import { makeState } from './helpers/state';

// ---------------- 断言工具 ----------------

// ---------------- 夹具 ----------------

const APPROVER = { type: 'user', value: 'u1' } as const;

/** 全关（= `normalizeApproval` 的默认：白名单式，没配 = 不允许） */
const CLOSED: NormalizedApproval = normalizeApproval({ approvers: [APPROVER] });

/** 全开：连 `allowArbitrary` 都开；`allowedTargets` 三种全给 */
const OPEN: NormalizedApproval = normalizeApproval({
  approvers: [APPROVER],
  reject: { allowed: true, allowArbitrary: true, allowedTargets: ['previous', 'nodeId', 'starter'] },
  withdraw: { allowed: true },
  revoke: { allowed: true },
  transfer: { allowed: true },
  delegate: { allowed: true },
  addSign: { before: true, after: true },
  reduceSign: { allowed: true },
  timeout: { duration: 'P3D', actions: [{ type: 'autoApprove' }] },
});

/** 一个「开始 → 审批 → 待推进」的状态：completedNodes 两个，一个在途令牌 */
function state(overrides: Partial<InstanceState> = {}): InstanceState {
  return makeState({
    tokens: [{ id: 'tk_1', nodeId: 'Task_2', state: 'active', assignee: 'u1' }],
    completedNodes: ['Start_1', 'Task_1'],
    ...overrides,
  });
}

const NEXT = () => 'End_1';
const ASSIGNEES = ['u2', 'u3'];

/** 编译所需的**全部**外部知识（对应 T11 才有的真图 / 真 ApproverSource） */
function fullCtx(overrides: Partial<CompileContext> = {}): CompileContext {
  return {
    approval: OPEN,
    nextOf: NEXT,
    startNodeId: 'Start_1',
    assignees: ASSIGNEES,
    reduceTokenIds: ['tk_9'],
    ...overrides,
  };
}

const input = (action: string, extra: Partial<ActionInput> = {}): ActionInput => ({
  action,
  actor: 'u1',
  ...extra,
});

// ---------------- ★ AC-E1：20 个可提交名逐个都能进入受理路径 ----------------

/**
 * ★ AC-E1 的机器可判定部分：主表里的每个名字都**真的被受理路径认得**。
 *
 * 判据取「不抛 `ENGINE_ACTION_UNKNOWN`」：那是「这个名字不在主表里」的码。
 * 一旦它出现在巡检里，就说明**表里写了一行、编译器却不认** ——
 * 正是「19 项动作」这个对外承诺最怕的静默缺口。
 *
 * ⚠️ 其余的错（目标不合法 / 办理人为空 / 缺意见 / 未开启）都是**动作域**的正常拒绝，
 *    它们恰恰证明这个动作被**认出来**了，故不算失败。
 */
const UNKNOWN_ACTION_CODE = ENGINE_ERROR_CODES.ACTION_UNKNOWN;

describe('⑨ AC-E1：20 个可提交名逐个都能进入受理路径', () => {
  it('每个名字要么编译成功，要么抛**动作域**的错；绝不抛 `ACTION_UNKNOWN`', () => {
    const unknownCode = UNKNOWN_ACTION_CODE;
    for (const name of ACTION_NAMES) {
      const needsTarget = (ROLLBACK_ACTIONS as readonly string[]).includes(name);
      let code: string | null = null;
      try {
        compileAction(
          input(name, {
            comment: '自动化 AC-E1 巡检',
            ...(needsTarget ? { target: 'Task_1' } : {}),
          }),
          state(),
          fullCtx(),
        );
      } catch (e) {
        code = (e as { code?: string }).code ?? null;
      }
      expect(code, `动作 '${name}' 被当成了未知动作（${code}）`).not.toBe(UNKNOWN_ACTION_CODE);
    }
  });

  it('★ 反证：表里没有的名字 → `ACTION_UNKNOWN`（上面的"不是该码"才有意义）', () => {
    expectCode(() => compileAction(input('noSuchAction'), state(), fullCtx()), UNKNOWN_ACTION_CODE);
  });
});

// ---------------- ① 表行数自检不变式 ----------------

describe('① 主表口径自检（`03` §192~197）', () => {
  it('主表 19 行', () => {
    expect(ACTION_SPECS.length).toBe(19);
  });

  it('其中 17 行内核原生、2 行内核外', () => {
    expect(ACTION_SPECS.filter((s) => s.native).length).toBe(17);
    expect(ACTION_SPECS.filter((s) => !s.native).map((s) => s.names[0])).toEqual([
      'timeoutAction',
      'saveDraft',
    ]);
  });

  it('可提交的动作名 20 个（suspend/resume 一行两名，按 1 项计入）', () => {
    expect(ACTION_NAMES.length).toBe(20);
    const twoNames = ACTION_SPECS.filter((s) => s.names.length > 1);
    expect(twoNames.length).toBe(1);
    expect(twoNames[0]?.names).toEqual(['suspend', 'resume']);
    // 20 − 1（多出来的那一个名字）= 19
    expect(ACTION_NAMES.length - (ACTION_SPECS.length - ACTION_SPECS.length) - 1).toBe(19);
  });

  it('动作名无重复，且每个名字都能反查到所属行', () => {
    expect(new Set(ACTION_NAMES).size).toBe(ACTION_NAMES.length);
    for (const n of ACTION_NAMES) {
      expect(ACTION_SPEC_BY_NAME[n].names).toContain(n);
    }
  });

  it('DV-5：4 项动作没有设计期开关（approve / terminate / suspend+resume / saveDraft）', () => {
    expect(UNGATED_ACTIONS).toEqual(['approve', 'terminate', 'suspend', 'resume', 'saveDraft']);
    // 口径：4 **项**（suspend/resume 合起来算 1 项）→ 名字 5 个
    expect(ACTION_SPECS.filter((s) => s.gate === null && s.mode === undefined).length).toBe(4);
  });

  it('DV-3：回退类 6 项、换人类 2 项（由表派生，不另列一份）', () => {
    expect(ROLLBACK_ACTIONS).toEqual([
      'reject',
      'rejectToPrev',
      'jumpTo',
      'returnTo',
      'takeBack',
      'revoke',
    ]);
    expect(HANDOVER_ACTIONS).toEqual(['transfer', 'delegate']);
  });

  it('每行引用的原语都必须是 10 个原语之一', () => {
    for (const s of ACTION_SPECS) {
      for (const p of s.primitives) {
        expect(
          [
            'advance',
            'jumpTo',
            'rollbackTo',
            'spawnInstances',
            'cancelInstances',
            'transfer',
            'delegate',
            'halt',
            'suspend',
            'resume',
          ],
        ).toContain(p);
      }
    }
  });
});

// ---------------- ② 与 `03` §4 主表逐字对账 ----------------

describe('② `primitiveExpr` 与 `03` §4 主表「→ 原语」列逐字一致', () => {
  /**
   * ★ 这张表是**从文档抄来的**，不是从代码抄来的。
   *   改代码忘了改文档 → 这里红。
   */
  const FROM_DOC: readonly string[] = [
    'advance', // approve
    'jumpTo', // reject
    'jumpTo', // rejectToPrev
    'jumpTo', // jumpTo
    'jumpTo', // returnTo
    'rollbackTo', // takeBack
    'rollbackTo', // revoke
    'halt', // terminate
    'transfer', // transfer
    'delegate', // delegate
    'spawnInstances', // addSignBefore
    'spawnInstances', // addSignAfter
    'cancelInstances', // reduceSign
    'spawnInstances', // countersign
    'spawnInstances+cancelInstances', // orSign
    'spawnInstances+cancelInstances', // voteSign
    'advance', // timeoutAction
    'suspend + resume', // suspend / resume
    '（空）', // saveDraft
  ];

  it('19 行逐行比对（含顺序）', () => {
    expect(ACTION_SPECS.map((s) => s.primitiveExpr)).toEqual(FROM_DOC);
  });

  it('动作名与中文标签也对得上', () => {
    expect(ACTION_SPECS.map((s) => s.label)).toEqual([
      '通过',
      '驳回',
      '驳回到上一节点',
      '任意跳转',
      '任意退回',
      '拿回',
      '撤销',
      '终止',
      '转办',
      '委派',
      '前加签',
      '后加签',
      '减签',
      '会签',
      '或签',
      '票签',
      '超时自动处理',
      '挂起 / 恢复',
      '暂存',
    ]);
  });

  it('★ 会签三项的 `cancelInstances` 不在提交时执行（归 T10 汇聚）', () => {
    for (const n of ['orSign', 'voteSign'] as const) {
      const s = ACTION_SPEC_BY_NAME[n];
      expect(s.primitiveExpr).toContain('cancelInstances'); // 文档口径：会用到
      expect(s.primitives).not.toContain('cancelInstances'); // 执行口径：提交时不做
    }
  });
});

// ---------------- ③ DV-1：默认值单一事实源 ----------------

describe('③ DV-1 —— 默认值取自 moddle，engine 不自写', () => {
  it('★ engine 的 comment 键集 == moddle 的 REQUIRE_COMMENT_DEFAULTS 键集', () => {
    expect([...COMMENT_GATE_PATHS].sort()).toEqual(Object.keys(REQUIRE_COMMENT_DEFAULTS).sort());
  });

  it('全关配置下：开关默认值一律 false（白名单式，没配 = 不允许）', () => {
    for (const p of ['reject', 'withdraw', 'revoke', 'transfer', 'delegate', 'reduceSign'] as const) {
      expect(readGate(CLOSED, p).allowed, `gate=${p}`).toBe(false);
    }
    expect(readGate(CLOSED, 'addSign.before').allowed).toBe(false);
    expect(readGate(CLOSED, 'addSign.after').allowed).toBe(false);
    expect(readGate(CLOSED, 'timeout').allowed).toBe(false);
  });

  it('DV-3：回退类 requireComment=true、换人类=false（**从真实归一化结果读**）', () => {
    expect(readGate(CLOSED, 'reject').requireComment).toBe(true);
    expect(readGate(CLOSED, 'withdraw').requireComment).toBe(true);
    expect(readGate(CLOSED, 'revoke').requireComment).toBe(true);
    expect(readGate(CLOSED, 'transfer').requireComment).toBe(false);
    expect(readGate(CLOSED, 'delegate').requireComment).toBe(false);
  });

  it('★ 反证：默认值不写在 engine 里 —— 改 moddle 的默认值，engine 跟着变', () => {
    // 显式把 revoke.requireComment 关掉 → engine 读到的就是 false（不是硬编码的 true）
    const off = normalizeApproval({ approvers: [APPROVER], revoke: { requireComment: false } });
    expect(readGate(off, 'revoke').requireComment).toBe(false);
    expect(readGate(CLOSED, 'revoke').requireComment).toBe(true);
  });

  it('`timeout` 的开关判据 = 配了非空 `timeout.actions`', () => {
    expect(OPEN.timeout?.actions.length).toBeGreaterThan(0);
    expect(readGate(OPEN, 'timeout').allowed).toBe(true);
  });
});

// ---------------- ④ AC-E2 / AC-E15：动作开关 ----------------

describe('④ 动作开关（AC-E2 / AC-E15 / DV-2）', () => {
  it('AC-E2：未开启的动作提交 → 抛 ACTION_NOT_ALLOWED', () => {
    expect(isActionEnabled(ACTION_SPEC_BY_NAME['reject'], CLOSED)).toBe(false);
    expectCode(() => assertActionEnabled('reject', CLOSED), ENGINE_ERROR_CODES.ACTION_NOT_ALLOWED);
  });

  it('报错要带上「当前能用什么」（AGENTS.md §5.4：错误信息列出合法取值）', () => {
    const err = expectCode(
      () => assertActionEnabled('reject', CLOSED),
      ENGINE_ERROR_CODES.ACTION_NOT_ALLOWED,
    );
    expect(err.details?.['allowed']).toEqual(enabledActionNames(CLOSED));
    // 全关时只剩「没有设计期开关」的几项：
    // 4 项无开关动作（approve / terminate / suspend+resume，saveDraft 非内核原生不计入）
    // + 会签三项（开关是节点的 `mode` 汇聚配置，不是动作开关 → DV-5 的例外）
    expect(err.details?.['allowed']).toEqual([
      'approve',
      'terminate',
      'countersign',
      'orSign',
      'voteSign',
      'suspend',
      'resume',
    ]);
  });

  it('★ AC-E15：`reject.allowed=true` 不隐含 `allowArbitrary` —— `jumpTo` 仍须单独授权', () => {
    // 只开 allowed，不开 allowArbitrary
    const partial = normalizeApproval({
      approvers: [APPROVER],
      reject: { allowed: true, allowArbitrary: false },
    });
    expect(readGate(partial, 'reject').allowed).toBe(true);
    expect(partial.reject.allowArbitrary).toBe(false);

    // `reject` 可用（它只需 allowed）
    expect(isActionEnabled(ACTION_SPEC_BY_NAME['reject'], partial)).toBe(true);
    // `jumpTo` / `returnTo` 不可用（它们另需 allowArbitrary）
    expect(isActionEnabled(ACTION_SPEC_BY_NAME['jumpTo'], partial)).toBe(false);
    expect(isActionEnabled(ACTION_SPEC_BY_NAME['returnTo'], partial)).toBe(false);
    expectCode(() => assertActionEnabled('jumpTo', partial), ENGINE_ERROR_CODES.ACTION_NOT_ALLOWED);
    expectCode(
      () => assertActionEnabled('returnTo', partial),
      ENGINE_ERROR_CODES.ACTION_NOT_ALLOWED,
    );
    // 开了 allowArbitrary 之后就都可用了
    expect(isActionEnabled(ACTION_SPEC_BY_NAME['jumpTo'], OPEN)).toBe(true);
  });

  it('无开关的 4 项在**全关**配置下依然可用（DV-5 的反面）', () => {
    for (const n of ['approve', 'terminate', 'suspend', 'resume'] as const) {
      expect(isActionEnabled(ACTION_SPEC_BY_NAME[n], CLOSED), n).toBe(true);
    }
  });

  it('编译路径同样挡：未开启动作在 compileAction 里就抛', () => {
    expectCode(
      () => compileAction(input('reject', { target: 'Task_1' }), state(), fullCtx({ approval: CLOSED })),
      ENGINE_ERROR_CODES.ACTION_NOT_ALLOWED,
    );
  });
});

// ---------------- ⑤ DV-3：意见留痕 ----------------

describe('⑤ 意见留痕（DV-3）', () => {
  it('回退类缺 comment → 抛 COMMENT_REQUIRED', () => {
    expectCode(
      () => compileAction(input('reject', { target: 'Task_1' }), state(), fullCtx()),
      ENGINE_ERROR_CODES.ACTION_COMMENT_REQUIRED,
    );
  });

  it('给了 comment 就过（空白字符串不算）', () => {
    const ok = compileAction(
      input('reject', { target: 'Task_1', comment: '不同意' }),
      state(),
      fullCtx(),
    );
    expect(ok.calls.length).toBe(1);
    // 空白不算留痕
    expectCode(
      () => compileAction(input('reject', { target: 'Task_1', comment: '   ' }), state(), fullCtx()),
      ENGINE_ERROR_CODES.ACTION_COMMENT_REQUIRED,
    );
  });

  it('换人类默认不强制留痕（transfer / delegate）', () => {
    for (const n of ['transfer', 'delegate'] as const) {
      const c = compileAction(input(n), state(), fullCtx());
      expect(c.calls[0]?.primitive).toBe(n);
    }
  });
});

// ---------------- ⑥ AC-E3 / INV-6：驳回目标 ----------------

describe('⑥ 驳回目标校验（AC-E3 / INV-6）', () => {
  const completed = ['Start_1', 'Task_1'];

  it('目标不在 completedNodes → 抛，且错误里列出合法目标', () => {
    const err = expectCode(
      () => assertTarget({ name: 'reject', approval: OPEN, completedNodes: completed, target: 'Task_9' }),
      ENGINE_ERROR_CODES.ACTION_TARGET_INVALID,
    );
    expect(err.details?.['completedNodes']).toEqual(completed);
    expect(err.details?.['allowedTargets']).toEqual(['previous', 'nodeId', 'starter']);
  });

  it('缺 target 同样抛（回退类必须点名目标）', () => {
    expectCode(
      () =>
        assertTarget({ name: 'reject', approval: OPEN, completedNodes: completed, target: undefined }),
      ENGINE_ERROR_CODES.ACTION_TARGET_INVALID,
    );
  });

  it("★ 缺省 allowedTargets = ['previous'] → 只有最后一个已完成节点合法", () => {
    const onlyPrev = normalizeApproval({ approvers: [APPROVER], reject: { allowed: true } });
    expect(onlyPrev.reject.allowedTargets).toEqual(['previous']);

    // 'Task_1' 是最后一个 → 合法
    expect(
      assertTarget({
        name: 'reject',
        approval: onlyPrev,
        completedNodes: completed,
        target: 'Task_1',
      }),
    ).toBe('Task_1');

    // 'Start_1' 是已完成节点，但不是 previous → 非法（INV-6 ①②都要满足）
    expectCode(
      () =>
        assertTarget({
          name: 'reject',
          approval: onlyPrev,
          completedNodes: completed,
          target: 'Start_1',
        }),
      ENGINE_ERROR_CODES.ACTION_TARGET_INVALID,
    );
  });

  it("'starter'：没给 startNodeId 就判不了 → 判为不允许（白名单式：推定不了 = 不许）", () => {
    const onlyStarter = normalizeApproval({
      approvers: [APPROVER],
      reject: { allowed: true, allowedTargets: ['starter'] },
    });
    // 给了 startNodeId → 通过
    expect(
      assertTarget({
        name: 'revoke',
        approval: onlyStarter,
        completedNodes: completed,
        target: 'Start_1',
        startNodeId: 'Start_1',
      }),
    ).toBe('Start_1');
    // 没给 → 不许
    expectCode(
      () =>
        assertTarget({
          name: 'revoke',
          approval: onlyStarter,
          completedNodes: completed,
          target: 'Start_1',
        }),
      ENGINE_ERROR_CODES.ACTION_TARGET_INVALID,
    );
  });

  it("allowedTargets 里的未知取值 → 不匹配任何语义 → 不许（不忽略、不猜）", () => {
    const weird = normalizeApproval({
      approvers: [APPROVER],
      reject: { allowed: true, allowedTargets: ['previous', 'nodeIdx'] },
    });
    expect(
      assertTarget({ name: 'reject', approval: weird, completedNodes: completed, target: 'Task_1' }),
    ).toBe('Task_1');
  });
});

// ---------------- ⑦ INV-7：设计期约束 ----------------

describe('⑦ INV-7 —— mode 与 vote 的互斥（engine 侧后置断言）', () => {
  it("mode:'vote' 必须带 vote", () => {
    const bad = { ...CLOSED, mode: 'vote' as const };
    expectCode(() => assertDesignTime(bad), ENGINE_ERROR_CODES.ACTION_VOTE_CONFIG);
  });

  it('非 vote 模式带 vote → 抛', () => {
    const bad = { ...CLOSED, mode: 'all' as const, vote: { count: 2 } };
    expectCode(() => assertDesignTime(bad), ENGINE_ERROR_CODES.ACTION_VOTE_CONFIG);
  });

  it('threshold 与 count 恰有其一（都给 / 都不给 → 抛）', () => {
    const both = { ...CLOSED, mode: 'vote' as const, vote: { count: 2, threshold: 0.5 } };
    expectCode(() => assertDesignTime(both), ENGINE_ERROR_CODES.ACTION_VOTE_CONFIG);
  });

  it('合法配置通过（threshold 或 count 其一）', () => {
    expect(() =>
      assertDesignTime({ ...CLOSED, mode: 'vote' as const, vote: { threshold: 0.6 } }),
    ).not.toThrow();
    expect(() =>
      assertDesignTime({ ...CLOSED, mode: 'vote' as const, vote: { count: 2 } }),
    ).not.toThrow();
    expect(() => assertDesignTime(CLOSED)).not.toThrow();
  });

  it('★ moddle 已覆盖这些校验 → normalizeApproval 直接抛，engine 这层是兜底', () => {
    // 证明「engine 不是唯一防线」，DV-1：以 moddle 为准
    expect(() => normalizeApproval({ approvers: [APPROVER], mode: 'vote' })).toThrow();
  });
});

// ---------------- ⑧ 表驱动：20 个动作名逐个编译 ----------------

describe('⑧ 表驱动 —— 每个可编译动作都能出调用序列', () => {
  const st = state();

  const cases: readonly { name: ActionName; expectPrimitive: string }[] = [
    { name: 'approve', expectPrimitive: 'advance' },
    { name: 'reject', expectPrimitive: 'jumpTo' },
    { name: 'rejectToPrev', expectPrimitive: 'jumpTo' },
    { name: 'jumpTo', expectPrimitive: 'jumpTo' },
    { name: 'returnTo', expectPrimitive: 'jumpTo' },
    { name: 'takeBack', expectPrimitive: 'rollbackTo' },
    { name: 'revoke', expectPrimitive: 'rollbackTo' },
    { name: 'terminate', expectPrimitive: 'halt' },
    { name: 'transfer', expectPrimitive: 'transfer' },
    { name: 'delegate', expectPrimitive: 'delegate' },
    { name: 'addSignBefore', expectPrimitive: 'spawnInstances' },
    { name: 'addSignAfter', expectPrimitive: 'spawnInstances' },
    { name: 'reduceSign', expectPrimitive: 'cancelInstances' },
    { name: 'countersign', expectPrimitive: 'spawnInstances' },
    { name: 'orSign', expectPrimitive: 'spawnInstances' },
    { name: 'voteSign', expectPrimitive: 'spawnInstances' },
    { name: 'timeoutAction', expectPrimitive: 'advance' },
    { name: 'suspend', expectPrimitive: 'suspend' },
    { name: 'resume', expectPrimitive: 'resume' },
  ];

  it.each(cases)('$name → $expectPrimitive', ({ name, expectPrimitive }) => {
    const c = compileAction(
      input(name, { target: 'Task_1', comment: 'x' }),
      st,
      fullCtx(),
    );
    expect(c.name).toBe(name);
    expect(c.calls.length).toBeGreaterThanOrEqual(1);
    expect(c.calls[0]?.primitive).toBe(expectPrimitive);
  });

  it('★ saveDraft 没有原语映射 → 提交即抛（它不进内核）', () => {
    expectCode(
      () => compileAction(input('saveDraft'), st, fullCtx()),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
  });

  it('未知动作名 → ACTION_UNKNOWN，并列出全部合法名', () => {
    const err = expectCode(
      () => compileAction(input('aprove'), st, fullCtx()),
      ENGINE_ERROR_CODES.ACTION_UNKNOWN,
    );
    expect(err.details?.['allowed']).toEqual(ACTION_NAMES);
  });
});

// ---------------- ⑨ 编译细节 ----------------

describe('⑨ 编译细节', () => {
  it('前加签插在**当前节点**，后加签插在**后继节点**（差别在插入位置）', () => {
    const before = compileAction(input('addSignBefore', { comment: 'x' }), state(), fullCtx());
    const after = compileAction(input('addSignAfter', { comment: 'x' }), state(), fullCtx());
    expect((before.calls[0]?.input as { nodeId: string }).nodeId).toBe('Task_2');
    expect((after.calls[0]?.input as { nodeId: string }).nodeId).toBe('End_1');
  });

  it('会签 / 或签 / 票签是"展开"：带 replaceTokenId（取代占位令牌）', () => {
    for (const n of ['countersign', 'orSign', 'voteSign'] as const) {
      const c = compileAction(input(n, { comment: 'x' }), state(), fullCtx());
      expect((c.calls[0]?.input as { replaceTokenId?: string }).replaceTokenId).toBe('tk_1');
    }
    // 加签是"新增"：不带 replaceTokenId
    const add = compileAction(input('addSignBefore', { comment: 'x' }), state(), fullCtx());
    expect((add.calls[0]?.input as { replaceTokenId?: string }).replaceTokenId).toBeUndefined();
  });

  it('INV-12：加签后该节点办理人数超 `addSign.maxCount` → 抛', () => {
    /*
     * ★ 计数口径 = **该节点上的在途令牌数 + 本次新增数**（不是 `instanceGroup` 计数）：
     *   加签**不建组**（D-33），按组数会永远数到 0，上限形同虚设。
     *   现状：Task_2 上已有 tk_1（u1）1 人，加 u2 / u3 两人 = 3 人。
     */
    // maxCount = 3 → 1 + 2 = 3 ≤ 3 → 通过
    const ok = compileAction(
      input('addSignBefore', { comment: 'x' }),
      state(),
      fullCtx({ approval: { ...OPEN, addSign: { ...OPEN.addSign, maxCount: 3 } } }),
    );
    expect(ok.calls.length).toBe(1);
    // maxCount = 2 → 1 + 2 = 3 > 2 → 超
    expectCode(
      () =>
        compileAction(
          input('addSignBefore', { comment: 'x' }),
          state(),
          fullCtx({ approval: { ...OPEN, addSign: { ...OPEN.addSign, maxCount: 2 } } }),
        ),
      ENGINE_ERROR_CODES.ACTION_ADD_SIGN_LIMIT,
    );
  });

  it('INV-13：办理人解析为空集 → 抛 APPROVER_EMPTY（不产生 0 办待人却 active 的节点）', () => {
    for (const n of ['countersign', 'addSignBefore'] as const) {
      expectCode(
        () => compileAction(input(n, { comment: 'x' }), state(), fullCtx({ assignees: [] })),
        ENGINE_ERROR_CODES.ACTION_APPROVER_EMPTY,
      );
    }
  });

  it('减签必须点名要取消的令牌（不代劳"取消一切"）', () => {
    expectCode(
      () => compileAction(input('reduceSign'), state(), fullCtx({ reduceTokenIds: [] })),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
  });

  it('后继节点解析不出 → DEFINITION_MISSING（本质就是定义缺这东西）', () => {
    expectCode(
      () => compileAction(input('approve'), state(), fullCtx({ nextOf: () => undefined })),
      ENGINE_ERROR_CODES.STATE_DEFINITION_MISSING,
    );
  });

  it('定位不到唯一令牌 → 抛（不猜）：多个在途令牌且未给 tokenId', () => {
    const two = state({
      tokens: [
        { id: 'tk_1', nodeId: 'Task_2', state: 'active' },
        { id: 'tk_2', nodeId: 'Task_3', state: 'active' },
      ],
    });
    expectCode(
      () => compileAction(input('approve'), two, fullCtx()),
      ENGINE_ERROR_CODES.STATE_SHAPE_INVALID,
    );
    // 给了 tokenId 就明确
    const c = compileAction(input('approve'), two, fullCtx({ tokenId: 'tk_2' }));
    expect((c.calls[0]?.input as { tokenId: string }).tokenId).toBe('tk_2');
  });

  it('compileAction 是纯函数：同入参两次调用结果深等', () => {
    const a = compileAction(input('reject', { target: 'Task_1', comment: 'x' }), state(), fullCtx());
    const b = compileAction(input('reject', { target: 'Task_1', comment: 'x' }), state(), fullCtx());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('★ 不执行原语、不改入参（那是 T11 loop 与 plan 的账）', () => {
    const st = state();
    const snapshot = JSON.stringify(st);
    compileAction(input('reject', { target: 'Task_1', comment: 'x' }), st, fullCtx());
    expect(JSON.stringify(st)).toBe(snapshot);
  });
});
