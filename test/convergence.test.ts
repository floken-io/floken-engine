/**
 * T10 · 汇聚判定（正向 + 反向三条提前终止）
 *
 * ★ 本文件的两条**穷举测试**是重点，不是锦上添花：
 *   ① 与模型层**对账**（适配层不得偷偷改语义）；
 *   ② **无死锁穷举**（任意表态序列最终必然结束）—— INV-10 的真正回归测试。
 *   只写「3 人里 1 人通过 → 不推进」这类样例，是证明不了「没有卡死路径」的。
 */

import { shouldTerminate as modelShouldTerminate } from '@floken-io/moddle';
import type { ApprovalMode, OnReject, VoteSpec } from '@floken-io/moddle';
import { describe, expect, it } from 'vitest';

import { ENGINE_ERROR_CODES } from '../src/core/errors';
import type { Token } from '../src/core/state';
import {
  evaluateConvergence,
  requiredOf,
  restTokenIds,
  shouldConverge,
  shouldTerminate,
} from '../src/actions/convergence';
import type { ConvergeCtx } from '../src/actions/convergence';
import { expectCode } from './helpers/expect';

// ---------------- 夹具 ----------------

/** 只填必填项；`pending` 由 `total − approved − rejected` 推出，避免手算出错 */
function ctx(
  mode: ApprovalMode,
  total: number,
  approved: number,
  rejected: number,
  extra: Partial<ConvergeCtx> = {},
): ConvergeCtx {
  return { mode, total, approved, rejected, pending: total - approved - rejected, onReject: 'abort', ...extra };
}

const VOTE_HALF: Partial<ConvergeCtx> = { threshold: 0.5 };

// ---------------- ① AC-E4 / AC-E5：正向判定 ----------------

describe('① 正向判定（`03` §5.2）', () => {
  it('AC-E5：会签 3 人中 1 人通过 → **不推进**', () => {
    const c = ctx('all', 3, 1, 0);
    expect(shouldConverge(c)).toBe(false);
    expect(evaluateConvergence(c).outcome).toBe('pending');
    expect(shouldTerminate(c)).toBe(false);
  });

  it('会签 3 人全通过 → 汇聚', () => {
    expect(shouldConverge(ctx('all', 3, 3, 0))).toBe(true);
  });

  it('AC-E4：或签 3 人中第 1 人通过 → 汇聚，且 cancelRest = true', () => {
    const r = evaluateConvergence(ctx('any', 3, 1, 0));
    expect(r.outcome).toBe('approved');
    expect(r.cancelRest).toBe(true); // 其余 2 人待办要取消
  });

  it('或签 0 人通过 → 继续等', () => {
    expect(evaluateConvergence(ctx('any', 3, 0, 0)).outcome).toBe('pending');
  });

  it('票签达票 → 汇聚', () => {
    // 3 人 × 0.5 → ceil(1.5) = 2 票
    expect(evaluateConvergence(ctx('vote', 3, 1, 0, VOTE_HALF)).outcome).toBe('pending');
    expect(evaluateConvergence(ctx('vote', 3, 2, 0, VOTE_HALF)).outcome).toBe('approved');
  });

  it('票签用 `count` 而非 `threshold`', () => {
    expect(requiredOf(ctx('vote', 5, 0, 0, { count: 2 }))).toBe(2);
    expect(evaluateConvergence(ctx('vote', 5, 2, 0, { count: 2 })).outcome).toBe('approved');
  });

  it('★ INV-11：会签的正向汇聚**只在 rejected === 0** 时成立', () => {
    // 2 通过 + 1 驳回 = 全员表态，但有人驳回 → 绝不能算「汇聚」
    expect(shouldConverge(ctx('all', 3, 2, 1))).toBe(false);
    // 且它必须走反向终止（规则一），不是卡住
    expect(shouldTerminate(ctx('all', 3, 2, 1))).toBe(true);
  });
});

// ---------------- ② AC-E16 / INV-10：反向三条 ----------------

describe('② 反向提前终止（`03` §5.3 三条规则）', () => {
  it('★ 规则一：会签 3 人中 1 人驳回 + `onReject:abort` → **立即整体驳回**', () => {
    const r = evaluateConvergence(ctx('all', 3, 0, 1, { onReject: 'abort' }));
    expect(r.outcome).toBe('rejected');
    expect(r.cancelRest).toBe(true); // 取消其余 2 个待办
    expect(r.reason).toContain('驳回');
  });

  it('规则一的反面：`onReject:wait` 不提前终止（记录驳回，继续等）', () => {
    const c = ctx('all', 3, 0, 1, { onReject: 'wait' });
    expect(shouldTerminate(c)).toBe(false);
    expect(evaluateConvergence(c).outcome).toBe('pending');
    // 但等到全员表态完，仍是驳回（2 驳回 1 通过 → rejected）
    expect(evaluateConvergence(ctx('all', 3, 1, 2, { onReject: 'wait' })).outcome).toBe('rejected');
  });

  it('★ 规则二：票签已驳回票数使剩余票不可能达标 → 立即整体驳回', () => {
    // 4 人 × 0.5 → 2 票；已 3 人驳回、0 通过 → 剩 1 人即使通过也只有 1 票
    const r = evaluateConvergence(ctx('vote', 4, 0, 3, VOTE_HALF));
    expect(r.outcome).toBe('rejected');
    expect(r.required).toBe(2);
  });

  it('规则二的反面：还有希望时不终止', () => {
    // 4 人 × 0.5 → 2 票；1 通过 1 驳回 → 剩 2 人，凑得齐
    expect(evaluateConvergence(ctx('vote', 4, 1, 1, VOTE_HALF)).outcome).toBe('pending');
  });

  it('规则三：全员表态完（pending === 0）→ 不再等，按已表态结果定', () => {
    /*
     * ★ 会签下 `onReject:'wait'` **仍是"全票决"**，不是多数决（**D-31**）：
     *   `wait` 只表示"先记下这票，等其余人表态完再定"，不改变会签的定义。
     *   若这里判成 approved，「会签 3 人 2 通过 1 驳回」就会通过 —— 与会签的定义直接冲突（INV-11）。
     */
    expect(evaluateConvergence(ctx('all', 3, 2, 1, { onReject: 'wait' })).outcome).toBe('rejected');
    // 1 通过 2 驳回 → rejected
    expect(evaluateConvergence(ctx('all', 3, 1, 2, { onReject: 'wait' })).outcome).toBe('rejected');
    // 对照：票签才是多数制（全员表态、通过票多于驳回 → approved）
    expect(evaluateConvergence(ctx('vote', 3, 2, 1, { onReject: 'wait', ...VOTE_HALF })).outcome).toBe('approved');
  });

  it('★ INV-10 死锁回归：`mode:all` + `rejected > 0` 绝不停留在等待态', () => {
    for (const onReject of ['abort', 'wait'] as const) {
      for (let total = 1; total <= 6; total += 1) {
        for (let approved = 0; approved <= total; approved += 1) {
          for (let rejected = 0; rejected <= total - approved; rejected += 1) {
            if (rejected === 0) continue;
            const r = evaluateConvergence(ctx('all', total, approved, rejected, { onReject }));
            // 只有「还有人没表态 且 onReject=wait」才允许 pending
            const pending = total - approved - rejected;
            const allowedPending = onReject === 'wait' && pending > 0;
            if (!allowedPending) {
              expect(
                r.outcome,
                `all/${onReject} total=${total} approved=${approved} rejected=${rejected} → ${r.outcome}`,
              ).not.toBe('pending');
            }
          }
        }
      }
    }
  });

  it('或签只要还有人没表态，就**不会**因驳回而整体驳回（只有全员驳回才结束）', () => {
    for (let approved = 0; approved <= 3; approved += 1) {
      for (let rejected = 0; rejected <= 3 - approved; rejected += 1) {
        const r = evaluateConvergence(ctx('any', 3, approved, rejected));
        const pending = 3 - approved - rejected;
        /*
         * 或签的本意：只要**没人通过**且还有人没表态，就必须继续等 ——
         * 不得因为"已有 N 票驳回"就整体驳回（那是会签规则一 / 票签规则二的事）。
         *
         * ⚠️ 只对「无人通过」的情形下断言：`approved >= 1 && pending === 0` 在真实执行路径上
         * **不可达** —— 或签在第一个人通过时就已经 `cancelRest` 收敛了，其余人不会再表态。
         * 对不可达状态写断言，等于把实现细节钉成契约。
         */
        if (approved === 0) {
          expect(r.outcome, `any 3/${approved}/${rejected}`).toBe(
            pending > 0 ? 'pending' : 'rejected', // 全员驳回 → 必须结束，不能永远等
          );
        }
      }
    }
  });
});

// ---------------- ③ 与模型层对账（D-19：适配层不得改语义） ----------------

describe('③ ★ 与 `@floken-io/moddle` 对账（单一事实源）', () => {
  const votes: (VoteSpec | undefined)[] = [undefined, { threshold: 0.5 }, { count: 2 }];

  /**
   * ★ **无例外格** —— 曾经这里有一格例外（`mode:'all' && rejected > 0`，D-21）：
   * 模型层把会签的「2 通过 1 驳回」误判为 approved，引擎侧加了一段短路兜住。
   * 2026-10-01 模型层已修正（`shouldTerminate` 规则序），短路随之删除，例外格一并取消。
   * 若将来模型层再退化，这条会红 —— 那正是我们想要的信号。
   */
  it('穷举全部 (mode × total × approved × rejected × onReject × vote)：**逐格全一致**', () => {
    let checked = 0;
    for (const mode of ['all', 'any', 'vote'] as const) {
      for (const vote of votes) {
        if (mode !== 'vote' && vote !== undefined) continue; // 非票签不看 vote（D-20）
        if (mode === 'vote' && vote === undefined) continue; // 票签必带（INV-7）
        for (const onReject of ['abort', 'wait'] as const) {
          for (let total = 1; total <= 6; total += 1) {
            for (let approved = 0; approved <= total; approved += 1) {
              for (let rejected = 0; rejected <= total - approved; rejected += 1) {
                const extra: Partial<ConvergeCtx> = { onReject };
                if (vote && 'count' in vote) extra.count = vote.count;
                if (vote && 'threshold' in vote) extra.threshold = vote.threshold;
                const c = ctx(mode, total, approved, rejected, extra);

                const mine = evaluateConvergence(c);
                const theirs = modelShouldTerminate(mode, total, approved, rejected, {
                  onReject,
                  ...(vote ? { vote } : {}),
                });

                expect(mine.outcome, JSON.stringify(c)).toBe(theirs.outcome);
                expect(mine.cancelRest, JSON.stringify(c)).toBe(theirs.cancelRest);
                expect(mine.reason, JSON.stringify(c)).toBe(theirs.reason);
                checked += 1;
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(300); // 别让循环悄悄变成 0 次
  });

  /**
   * ★ D-21 的**回归钉子**：模型层修好后，这一格必须与引擎（= 模型层）一致判 `rejected`。
   * 原来是「证明模型层判错」的存在性断言，现在是「证明它没退回多数决」的回归断言。
   */
  it('D-21（已修）：会签「2 通过 1 驳回」两侧同判 rejected，不再按多数决', () => {
    for (const onReject of ['abort', 'wait'] as const) {
      const theirs = modelShouldTerminate('all', 3, 2, 1, { onReject });
      expect(theirs.outcome, onReject).toBe('rejected');
      expect(evaluateConvergence(ctx('all', 3, 2, 1, { onReject })).outcome).toBe(theirs.outcome);
    }
    // 对照：票签才按多数定（3 人 2 通过 1 驳回 → approved）
    expect(evaluateConvergence(ctx('vote', 3, 2, 1, { ...VOTE_HALF })).outcome).toBe('approved');
  });

  it('`requiredOf` 与 `requiredVotes` 同口径', () => {
    expect(requiredOf(ctx('vote', 3, 0, 0, { threshold: 0.5 }))).toBe(2); // ceil(1.5)
    expect(requiredOf(ctx('vote', 4, 0, 0, { threshold: 0.5 }))).toBe(2); // ceil(2.0)
    expect(requiredOf(ctx('vote', 3, 0, 0, { threshold: 1 }))).toBe(3);
    expect(requiredOf(ctx('vote', 3, 0, 0, { count: 99 }))).toBe(3); // 不超过 total
    expect(requiredOf(ctx('all', 3, 0, 0))).toBe(3); // 非票签 = 全员
    expect(requiredOf(ctx('any', 3, 0, 0))).toBe(3);
  });
});

// ---------------- ④ INV-9：取消谁 ----------------

describe('④ INV-9：汇聚/终止后该取消哪些令牌', () => {
  const tk = (id: string, over: Partial<Token> = {}): Token => ({
    id,
    nodeId: 'Task_1',
    state: 'active',
    ...over,
  });

  it('AC-E4：或签第 1 人通过 → 其余 2 个在途令牌被点名取消', () => {
    const tokens: Token[] = [
      tk('tk_1', { instanceGroup: 'g1', state: 'completed' }), // 已表态者
      tk('tk_2', { instanceGroup: 'g1' }),
      tk('tk_3', { instanceGroup: 'g1' }),
    ];
    const r = evaluateConvergence(ctx('any', 3, 1, 0));
    expect(r.cancelRest).toBe(true);
    // `keep` = 本次表态者；已 done 的令牌本来就不在「在途」里
    expect(restTokenIds(tokens, 'g1', ['tk_1'])).toEqual(['tk_2', 'tk_3']);
  });

  it('不在途的（done / cancelled / waiting 之外）不被重复点名', () => {
    const tokens: Token[] = [
      tk('tk_1', { instanceGroup: 'g1', state: 'active' }),
      tk('tk_2', { instanceGroup: 'g1', state: 'completed' }),
      tk('tk_3', { instanceGroup: 'g1', state: 'cancelled' }),
    ];
    expect(restTokenIds(tokens, 'g1')).toEqual(['tk_1']);
  });

  it('其它组 / 无组的令牌**绝不**被动', () => {
    const tokens: Token[] = [
      tk('tk_1', { instanceGroup: 'g1', state: 'active' }),
      tk('tk_2', { instanceGroup: 'g2', state: 'active' }),
      tk('tk_3', { state: 'active' }), // 无组（单实例）
    ];
    expect(restTokenIds(tokens, 'g1')).toEqual(['tk_1']);
  });

  it('`waiting` 也算在途（串行会签里未激活的令牌同样要清）', () => {
    const tokens: Token[] = [tk('tk_1', { instanceGroup: 'g1', state: 'waiting' })];
    expect(restTokenIds(tokens, 'g1')).toEqual(['tk_1']);
  });
});

// ---------------- ⑤ 形状校验 ----------------

describe('⑤ `ConvergeCtx` 形状校验（模型层信任入参，引擎不能）', () => {
  const bad: [string, () => ConvergeCtx][] = [
    ['total = 0（INV-13：不得有 0 办理人的组）', () => ctx('all', 0, 0, 0)],
    ['total 非整数', () => ctx('all', 2.5, 0, 0)],
    ['approved 为负', () => ctx('all', 3, -1, 0)],
    ['rejected 非整数', () => ctx('all', 3, 0, 1.5)],
    ['approved + rejected 超出 total', () => ctx('all', 2, 2, 1)],
    ['mode 非法', () => ctx('nonsense' as ApprovalMode, 3, 0, 0)],
    ['onReject 非法', () => ctx('all', 3, 0, 0, { onReject: 'nope' as OnReject })],
  ];

  it.each(bad)('%s → 抛 STATE_SHAPE_INVALID', (_name, make) => {
    expectCode(() => evaluateConvergence(make()), ENGINE_ERROR_CODES.STATE_SHAPE_INVALID);
  });

  it('★ `pending` 与 total/approved/rejected 不自洽 → 抛（不自洽时任何判定都不可信）', () => {
    const c: ConvergeCtx = { mode: 'all', total: 3, approved: 1, rejected: 0, pending: 99, onReject: 'abort' };
    expectCode(() => evaluateConvergence(c), ENGINE_ERROR_CODES.STATE_SHAPE_INVALID);
  });

  it.each([
    ['两者都给', { count: 2, threshold: 0.5 }],
    ['两者都不给', {}],
  ])('mode:vote 的 vote 配置 %s → 抛 ACTION_VOTE_CONFIG（INV-7）', (_name, extra) => {
    expectCode(
      () => evaluateConvergence(ctx('vote', 3, 0, 0, extra)),
      ENGINE_ERROR_CODES.ACTION_VOTE_CONFIG,
    );
  });

  it.each([0, -1, 1.5])('vote.count = %p 非法 → 抛 ACTION_VOTE_CONFIG', (count) => {
    expectCode(
      () => evaluateConvergence(ctx('vote', 3, 0, 0, { count })),
      ENGINE_ERROR_CODES.ACTION_VOTE_CONFIG,
    );
  });

  it.each([0, -0.1, 1.5])('vote.threshold = %p 越界 → 抛 ACTION_VOTE_CONFIG', (threshold) => {
    expectCode(
      () => evaluateConvergence(ctx('vote', 3, 0, 0, { threshold })),
      ENGINE_ERROR_CODES.ACTION_VOTE_CONFIG,
    );
  });

  it('★ D-20：非票签模式带 `vote` 字段 → **忽略**而非报错（实测 `normalizeApproval` 判定其合法）', () => {
    const c = ctx('all', 3, 3, 0, { count: 99 });
    expect(shouldConverge(c)).toBe(true); // 不受 count:99 影响
    expect(requiredOf(c)).toBe(3);
  });
});

// ---------------- ⑥ 纯函数性 ----------------

describe('⑥ 纯函数性', () => {
  it('同入参两次调用结果相同，且不改动入参', () => {
    const c = ctx('vote', 4, 1, 1, { threshold: 0.5 });
    const snapshot = JSON.stringify(c);
    expect(evaluateConvergence(c)).toEqual(evaluateConvergence(c));
    expect(JSON.stringify(c)).toBe(snapshot);
  });
});
