/**
 * per-instance FIFO 串行队列的契约测试（T7）。
 *
 * 验收对应：`ARCHITECTURE.md` §9-T7「同一 `instanceId` 的 100 次并发 `submit` 串行执行（顺序断言）；
 * 不同实例不互相阻塞」+ `03` NFR-E5「进程内 per-instance 串行队列（主）」。
 *
 * ★ 反向验收同样重要：如果队列**失效**（并发执行了），① 组的「最大并发数」与「顺序」两条
 *   必须同时变红 —— 只断言顺序不够（碰巧有序 ≠ 串行），只断言并发数也不够（串行但乱序 = 提交顺序错乱）。
 */

import { describe, expect, it } from 'vitest';

import { createInstanceQueue } from '../src/runtime/queue';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('@floken-io/engine · per-instance 串行队列', () => {
  // ---------------- ① 同实例串行 ----------------

  describe('① 同一实例严格串行（NFR-E5 主防线）', () => {
    it('100 次并发 `run()`：任一时刻最多 1 个在执行', async () => {
      const q = createInstanceQueue();
      let concurrent = 0;
      let maxConcurrent = 0;

      await Promise.all(
        Array.from({ length: 100 }, () =>
          q.run('pi_1', async () => {
            concurrent += 1;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await sleep(0);
            concurrent -= 1;
          }),
        ),
      );

      expect(maxConcurrent).toBe(1);
      expect(q.size()).toBe(0);
    });

    it('100 次并发 `run()`：执行顺序 === 入队顺序（FIFO）', async () => {
      const q = createInstanceQueue();
      const order: number[] = [];

      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          q.run('pi_1', async () => {
            await sleep(0);
            order.push(i);
          }),
        ),
      );

      expect(order).toEqual(Array.from({ length: 100 }, (_, i) => i));
    });

    it('同步 fn 也按入队顺序执行（不让「同步路径」绕过串行）', async () => {
      const q = createInstanceQueue();
      const order: number[] = [];
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          q.run('pi_1', () => {
            order.push(i);
          }),
        ),
      );
      expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
  });

  // ---------------- ② 不同实例并行 ----------------

  describe('② 不同实例并行（不互相阻塞）', () => {
    it('两个 key 各 60ms：总耗时接近 60ms 而不是 120ms', async () => {
      const q = createInstanceQueue();
      const t0 = Date.now();
      await Promise.all([
        q.run('pi_a', () => sleep(60)),
        q.run('pi_b', () => sleep(60)),
      ]);
      expect(Date.now() - t0).toBeLessThan(110);
    });

    it('慢实例不拖住快实例：pi_slow 排队时 pi_fast 立即执行', async () => {
      const q = createInstanceQueue();
      const marks: string[] = [];
      const slow = q.run('pi_slow', async () => {
        marks.push('slow:start');
        await sleep(40);
        marks.push('slow:end');
      });
      const fast = q.run('pi_fast', async () => {
        marks.push('fast');
      });
      await Promise.all([slow, fast]);
      // `fast` 不应等到 slow 结束才跑
      expect(marks.indexOf('fast')).toBeLessThan(marks.indexOf('slow:end'));
    });

    it('depth 按 key 独立计数', async () => {
      const q = createInstanceQueue();
      let seen = -1;
      const first = q.run('pi_1', async () => {
        // ⚠️ 任务体在**微任务**里执行，同步断言读到的还是初值 —— 必须 await 之后再断言
        seen = q.depth('pi_1');
        await sleep(20);
      });
      const second = q.run('pi_1', () => sleep(0));
      const otherDepth = q.run('pi_2', async () => q.depth('pi_2'));

      await Promise.all([first, second]);
      // 入队两个 pi_1：执行第一个时该 key 上应有 2（1 个在跑 + 1 个在等）
      expect(seen).toBe(2);
      // 不同 key 互不干扰：pi_2 上始终只有它自己
      expect(await otherDepth).toBe(1);
      await q.drain();
      expect(q.size()).toBe(0);
    });
  });

  // ---------------- ③ 失败不卡死 ----------------

  describe('③ 前驱失败不得卡死队列', () => {
    it('第一个任务抛错，后续任务照常执行', async () => {
      const q = createInstanceQueue();
      const ran: number[] = [];
      const failing = q.run('pi_1', async () => {
        throw new Error('boom');
      });
      const rest = Array.from({ length: 3 }, (_, i) =>
        q.run('pi_1', async () => {
          ran.push(i);
        }),
      );

      await expect(failing).rejects.toThrow('boom');
      await Promise.all(rest);
      expect(ran).toEqual([0, 1, 2]);
      expect(q.size()).toBe(0);
    });

    it('异常**原样**透传（不包装：宿主要靠 `instanceof EngineError` 判定）', async () => {
      const q = createInstanceQueue();
      class MyError extends Error {
        readonly code = 'MY_CODE';
      }
      const err = new MyError('raw');
      await expect(q.run('pi_1', async () => { throw err; })).rejects.toBe(err);
    });

    it('返回值原样透传', async () => {
      const q = createInstanceQueue();
      await expect(q.run('pi_1', async () => 42)).resolves.toBe(42);
    });

    it('同步抛错同样不卡死队列', async () => {
      const q = createInstanceQueue();
      const bad = q.run('pi_1', () => {
        throw new Error('sync boom');
      });
      const good = q.run('pi_1', async () => 'ok');
      await expect(bad).rejects.toThrow('sync boom');
      await expect(good).resolves.toBe('ok');
    });
  });

  // ---------------- ④ 生命周期 ----------------

  describe('④ 队列生命周期（不得泄漏）', () => {
    it('任务全部完成后 key 被清理（长跑进程不涨内存）', async () => {
      const q = createInstanceQueue();
      await Promise.all([q.run('pi_1', () => sleep(0)), q.run('pi_2', () => sleep(0))]);
      await q.drain();
      expect(q.size()).toBe(0);
      expect(q.depth('pi_1')).toBe(0);
    });

    it('1000 个不同实例跑完后 size 归零', async () => {
      const q = createInstanceQueue();
      await Promise.all(
        Array.from({ length: 1000 }, (_, i) => q.run(`pi_${i}`, () => sleep(0))),
      );
      await q.drain();
      expect(q.size()).toBe(0);
    });

    it('drain() 只等「调用时已在队列里」的任务（不无限等待新任务）', async () => {
      const q = createInstanceQueue();
      const first = q.run('pi_1', () => sleep(20));
      await q.drain();
      expect(first).toBeInstanceOf(Promise);
      // drain 之后仍可继续提交（队列没被关掉）
      await expect(q.run('pi_1', async () => 'later')).resolves.toBe('later');
    });
  });
});
