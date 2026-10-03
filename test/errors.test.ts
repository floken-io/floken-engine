/**
 * `AGENTS.md` §5.7 落地清单的四项验证：
 *   ① 错误形状一致性（遍历**全部**子类断言字段齐备）
 *   ② 码表去重
 *   ③ 抛出码与诊断码**双命名空间不重叠**
 *   ④ 「哪条走抛、哪条走诊断」清单（以码表 + 形状断言表达）
 *
 * ★ 子类列表**自动发现**而非手列：新增错误子类时若漏配形状，本测试必须变红。
 */
import { describe, it, expect } from 'vitest';
import * as errors from '../src/core/errors';
import {
  EngineError,
  ENGINE_ERROR_CODES,
  ENGINE_DIAGNOSTIC_CODES,
  actionUnknown,
  actionNotAllowed,
  actionTargetInvalid,
  persistConflict,
  optionUnknown,
  optionInvalid,
} from '../src/core/errors';

type ErrorCtor = new (message: string, init: { code: string }) => EngineError;

/** 自动发现：所有继承自 `EngineError` 的导出类（含未来新增的） */
const SUBCLASSES: ReadonlyArray<readonly [string, ErrorCtor]> = Object.entries(errors)
  .filter(([, v]) => {
    const fn = v as { prototype?: object } | undefined;
    return (
      typeof v === 'function' &&
      v !== EngineError &&
      !!fn?.prototype &&
      fn.prototype instanceof EngineError
    );
  })
  .map(([k, v]) => [k, v as unknown as ErrorCtor] as const);

const throwCodes = Object.values(ENGINE_ERROR_CODES);
const diagCodes = Object.values(ENGINE_DIAGNOSTIC_CODES);

describe('@floken-io/engine 错误契约', () => {
  describe('① 形状一致性（遍历全部子类）', () => {
    it('至少发现 4 个子类 —— 自动发现机制本身必须有效', () => {
      // 若这个断言失败，说明下面的遍历可能是"空转通过"
      expect(SUBCLASSES.length).toBeGreaterThanOrEqual(4);
      expect(SUBCLASSES.map(([k]) => k)).toEqual(
        expect.arrayContaining([
          'EngineActionError',
          'EngineStateError',
          'EnginePersistError',
          'EngineOptionError',
        ]),
      );
    });

    it.each(SUBCLASSES)('%s 的字段齐备且 name 正确', (_exportName, Klass) => {
      const err = new Klass('sample message', { code: ENGINE_ERROR_CODES.STATE_NOT_FOUND });

      // 五包统一印记 + 包标识
      expect(err.floken).toBe(true);
      expect(err.pkg).toBe('engine');
      // name = 子类自己的类名（AGENTS.md §5.2）
      expect(err.name).toBe(Klass.name);
      // message 是 string 且不含易变数据（这里只断言类型与透传）
      expect(err.message).toBe('sample message');
      // code 非空、是 string
      expect(typeof err.code).toBe('string');
      expect(err.code.length).toBeGreaterThan(0);
      // 继承链完整
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(EngineError);
    });

    it('可选字段未赋值时**不产生键**（JSON.stringify 干净）', () => {
      const err = new EngineError('m', { code: ENGINE_ERROR_CODES.STATE_NOT_FOUND });
      const keys = Object.keys(err);
      for (const k of ['node', 'instanceId', 'hint', 'details']) {
        expect(keys).not.toContain(k);
      }
      expect(JSON.parse(JSON.stringify(err))).not.toHaveProperty('instanceId');
    });

    it('可选字段赋值后才出现（且可 JSON 往返）', () => {
      const err = new EngineError('m', {
        code: ENGINE_ERROR_CODES.STATE_NOT_FOUND,
        instanceId: 'pi_1',
        node: { id: 'UserTask_3' },
        hint: 'h',
        details: { a: 1 },
      });
      expect(err.instanceId).toBe('pi_1');
      expect(err.node?.id).toBe('UserTask_3');
      expect(JSON.parse(JSON.stringify(err))).toMatchObject({
        instanceId: 'pi_1',
        details: { a: 1 },
      });
    });
  });

  describe('② 码表去重 + 命名规则', () => {
    it('抛出码无重复值', () => {
      expect(new Set(throwCodes).size).toBe(throwCodes.length);
    });

    it('诊断码无重复值', () => {
      expect(new Set(diagCodes).size).toBe(diagCodes.length);
    });

    it('抛出码全部形如 ENGINE_<类别>_<对象>，类别限于五族', () => {
      // ★ Q49 新增 PEER_（peer 包缺失）；与其余四族不得混用。
      const re = /^ENGINE_(ACTION|STATE|PERSIST|OPTION|PEER)_[A-Z0-9]+(?:_[A-Z0-9]+)*$/;
      for (const c of throwCodes) expect(c, c).toMatch(re);
    });

    it('诊断码形如 ENGINE_<类别>_<对象> 且非空', () => {
      const re = /^ENGINE_[A-Z0-9]+(?:_[A-Z0-9]+)+$/;
      for (const c of diagCodes) expect(c, c).toMatch(re);
    });
  });

  describe('③ 双命名空间不重叠', () => {
    it('抛出码与诊断码无交集', () => {
      const overlap = throwCodes.filter((c) => (diagCodes as string[]).includes(c));
      expect(overlap).toEqual([]);
    });

    it('诊断码**不得使用**抛出码的五个类别前缀', () => {
      const forbidden = /^ENGINE_(ACTION|STATE|PERSIST|OPTION|PEER)_/;
      for (const c of diagCodes) expect(c, c).not.toMatch(forbidden);
    });
  });

  describe('④ 工厂产出的 message 与 details 分工', () => {
    /**
     * ★ 「易变数据」判据（`AGENTS.md` §5.6 的落地口径，本测试是它的唯一可执行定义）：
     *
     *   message  **可以**写「出错的那一个名字」—— 它是错误的核心描述，稳定、人读，
     *             参考实现 `floken-feel/src/core/errors.ts` 的 6 处工厂均如此。
     *   message  **不得**写「合法取值集合」—— 集合会随版本增删（19 项动作、配置项、
     *             `completedNodes` 全是这样），写进 message 会让宿主的字符串断言随版本碎掉。
     *
     * 换句话说：**标量进 message，集合留在 details**。
     */
    it.each([
      [
        'actionUnknown',
        () => actionUnknown('aprove', ['approve', 'reject']),
        'aprove',
        'reject',
      ],
      [
        'actionNotAllowed',
        () => actionNotAllowed('approve', ['reject']),
        'approve',
        'reject',
      ],
      [
        'optionUnknown',
        () => optionUnknown('maxAudit', ['maxAuditEntries']),
        'maxAudit',
        'maxAuditEntries',
      ],
      [
        'actionTargetInvalid',
        () => actionTargetInvalid('reject', 'Task_9', ['Task_1', 'Task_2'], ['Task_1']),
        'Task_9',
        'Task_2',
      ],
    ] satisfies ReadonlyArray<readonly [string, () => EngineError, string, string]>)(
      '%s：message 写对象名、不写合法取值集合',
      (_name, make, scalar, fromSet) => {
        const err = make();
        expect(err.message).toContain(scalar);
        expect(err.message).not.toContain(fromSet);
      },
    );

    it('actionUnknown 列出全部合法取值', () => {
      const err = actionUnknown('aprove', ['approve', 'reject']);
      expect(err.code).toBe(ENGINE_ERROR_CODES.ACTION_UNKNOWN);
      expect(err.details).toMatchObject({ action: 'aprove', allowed: ['approve', 'reject'] });
      expect(err.hint).toBeTruthy();
    });

    it('actionTargetInvalid 同时给出 completedNodes 与 allowedTargets', () => {
      const err = actionTargetInvalid('reject', 'Task_9', ['Task_1', 'Task_2'], ['Task_1']);
      expect(err.code).toBe(ENGINE_ERROR_CODES.ACTION_TARGET_INVALID);
      expect(err.node).toEqual({ id: 'Task_9' });
      expect(err.details).toMatchObject({
        completedNodes: ['Task_1', 'Task_2'],
        allowedTargets: ['Task_1'],
      });
    });

    it('persistConflict 不传 actualRev 时不产生该键（避免 undefined 污染）', () => {
      const err = persistConflict('pi_1', 5);
      expect(err.details).toMatchObject({ instanceId: 'pi_1', expectedRev: 5 });
      expect(Object.keys(err.details ?? {})).not.toContain('actualRev');
      expect(err.instanceId).toBe('pi_1');

      const withActual = persistConflict('pi_1', 5, 7);
      expect(withActual.details).toMatchObject({ expectedRev: 5, actualRev: 7 });
    });

    it('optionInvalid 不传 value 时不产生该键', () => {
      const err = optionInvalid('maxAuditEntries', 'must be a positive integer');
      expect(err.code).toBe(ENGINE_ERROR_CODES.OPTION_INVALID);
      expect(Object.keys(err.details ?? {})).not.toContain('value');
      expect(err.details).toMatchObject({ option: 'maxAuditEntries' });
    });
  });
});
