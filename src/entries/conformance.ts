/**
 * @floken-io/engine/conformance · 公开子路径入口（`package.json` 的 `./conformance`）
 *
 * 本档只做 re-export，不放实现 —— 实现住在 `conformance/`（套件正文）与 `core/`（契约）。
 * `tsup` 的 `entry` key = `conformance` → 产物 `dist/conformance.js`。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这个子路径是给谁用的
 * ═══════════════════════════════════════════════════════════════
 * **给自研 SPI 实现的宿主**。官方适配包（`@floken-io/store`）自带测试，不需要它；
 * 但「我们把待办表放在自己的 Oracle 里 / 状态走公司内部的配置中心」这类项目，
 * 需要一个不依赖引擎内部结构的验收工具 —— 那就是这里。
 *
 * ★ 两条承诺：
 *   ① **零测试框架依赖** —— 套件只返回报告，用 vitest / jest / `node:test` / 裸脚本调都行；
 *   ② **只碰公开契约** —— 断言依据全部来自 `ARCHITECTURE.md` §7.2 / §6.4，
 *      不依赖引擎未公开的内部结构，所以引擎内部重构不会让它误报。
 */
export { runStoreConformance } from '../conformance/store.js';
export type { StoreConformanceOptions } from '../conformance/store.js';

export { runProjectionConformance } from '../conformance/projection.js';
export type {
  ProjectionConformanceOptions,
  ProjectionReadback,
} from '../conformance/projection.js';

/**
 * ★ 三套里唯一需要宿主**额外交输入**的：`DefinitionSource` 是只读线，套件没法自己造定义
 * （定义是业务资产），所以由宿主声明「库里这一格长这样」再逐格取回比对。
 * 详见 `conformance/definition.ts` 文件头。
 */
export { runDefinitionConformance } from '../conformance/definition.js';
export type {
  DefinitionFixture,
  DefinitionConformanceOptions,
} from '../conformance/definition.js';

export { formatConformanceReport } from '../conformance/report.js';
export type { ConformanceCase, ConformanceReport } from '../conformance/report.js';
