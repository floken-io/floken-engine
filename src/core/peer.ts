/**
 * **peer 依赖的惰性加载器**（Q49：五个包之间一律 peer，不再内置）。
 *
 * ★ 背景：`@floken-io/engine` 不再把 `@floken-io/moddle` / `@floken-io/feel` 写进
 *   `dependencies`，改由宿主决定装哪些、装什么版本。代价是「缺失」这件事从**包管理器**
 *   转移到了**运行期**（pnpm 严格模式、`--legacy-peer-deps`、手动裁剪依赖都会命中），
 *   所以必须有本档把原生报错翻译成可执行的修复建议。
 *
 * ★ **为什么是同步的**（这是本档存在的全部理由）：
 *   `normalizeApproval()` 在建图时同步调用、`evaluate()` 在条件求值时同步调用，
 *   都在 `createEngine()` → `submit()` 的同步链上。若改用 `await import()`，
 *   整个引擎 API 会被污染成异步工厂，现有同步 API 与全部单测都要动。
 *   Node ≥22.12（本包的 engines 底线）的 `createRequire()` **能同步加载纯 ESM**
 *   —— 实测 `@floken-io/moddle` 114 个导出键、`@floken-io/feel` 45 个均正常，
 *   所以同步 API 可以原样保住。
 *
 * ★ **三级解析顺序**：
 *   ① `registerPeer()` 宿主显式注入 —— 浏览器 / 打包器 / pnpm 严格模式的**唯一出路**
 *      （这些环境里 `node:module` 取不到，或 peer 不在可解析路径上）；
 *   ② `createRequire(import.meta.url)` —— Node 侧（ESM/CJS 都吃，`import.meta.url`
 *      以本模块为起点向上找 `node_modules`，无需知道包根位置）；
 *   ③ 都拿不到 → `requirePeer()` 抛 `ENGINE_PEER_MISSING`；`tryPeer()` 返回 `undefined`。
 *
 * ⚠️ 两条硬纪律：
 *   - **绝不内置兜底实现**。缺失就必须让宿主装 —— 自带一份「简化版算法」看似贴心，
 *     实则会让两个实现悄悄分叉，最后谁也说不清该信哪个（DV-1 的教训）。
 *   - **绝不静默降级**。拿不到就抛，或由调用方显式决定降级路径；不许返回「假模块」。
 *
 * ⚠️ `MODULE_NOT_FOUND` 之外的错误（例如 peer 包自身初始化抛错）**原样透出**，
 *    不能被当成「缺失」吞掉 —— 否则宿主永远查不到真正的堆栈。
 */

import { peerMissing } from './errors.js';

/** ① 宿主注入的模块表 */
const injected = new Map<string, unknown>();
/** ② 解析成功的缓存（Node 的 require 自带缓存，这里主要省掉重复的类型/注册表查找） */
const resolved = new Map<string, unknown>();
/** ② 确认为「缺失」的集合 —— 避免每次调用都走一次必然失败的 require（有磁盘 I/O） */
const absent = new Set<string>();

/**
 * 探测并获得 Node 的 `createRequire`。
 *
 * ★ 刻意**不**用 `import { createRequire } from 'node:module'`：静态 import 会让打包器
 *   （vite / webpack）把 `node:module` externalize 甚至直接报错，浏览器端连包都加载不了。
 *   走 `process.getBuiltinModule('module')` 是同步的、且在没有 `process` 的环境里
 *   自然返回 undefined，浏览器分支才成立。
 */
let cachedRequire: ((id: string) => unknown) | undefined;
let requireProbed = false;

function nodeRequire(): ((id: string) => unknown) | undefined {
  if (requireProbed) return cachedRequire;
  requireProbed = true;
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const mod = proc?.getBuiltinModule?.('module') as
    | { createRequire?: (url: string) => (id: string) => unknown }
    | undefined;
  if (typeof mod?.createRequire !== 'function') return undefined;
  try {
    cachedRequire = mod.createRequire(import.meta.url);
  } catch {
    return undefined; // 拿不到就当环境不支持，交给注入分支
  }
  return cachedRequire;
}

/** 判断一个错误是否表示「模块不存在」（其余错误一律不认领） */
function isNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND';
}

function resolvePeer(name: string): unknown {
  if (injected.has(name)) return injected.get(name);
  if (resolved.has(name)) return resolved.get(name);
  if (absent.has(name)) return undefined;

  const req = nodeRequire();
  if (req) {
    try {
      const mod = req(name);
      resolved.set(name, mod);
      return mod;
    } catch (err) {
      if (!isNotFound(err)) throw err; // ★ 非「缺失」的错误原样透出
      absent.add(name);
      return undefined;
    }
  }
  absent.add(name);
  return undefined;
}

export interface PeerOptions {
  /** 这个 peer 被用来做什么 —— 进 `details.neededFor`，让宿主判断「我该不该装」 */
  neededFor?: string;
  /** `package.json` 里声明的范围 —— 进 `details.range`（**只展示，不做运行期校验**） */
  range?: string;
  /**
   * 是否 optional peer。只影响报错文案（`details.optional`）：
   * optional 缺失说明「你的用法暂时用不到它，一旦用到就得装」。
   */
  optional?: boolean;
}

/**
 * 宿主显式注入一个 peer 模块（浏览器 / 打包器 / pnpm 严格模式的唯一出路）。
 *
 * ```ts
 * import * as moddle from '@floken-io/moddle';
 * registerPeer('@floken-io/moddle', moddle);   // 在任何 engine 调用之前执行一次
 * ```
 *
 * ★ 注入优先于 `node_modules` 解析，因此也可用于**测试替身**与**多版本共存**。
 */
export function registerPeer(name: string, mod: unknown): void {
  if (mod === undefined || mod === null) {
    injected.delete(name);
    resolved.delete(name);
    return;
  }
  injected.set(name, mod);
  resolved.set(name, mod);
  absent.delete(name);
}

/** 撤回注入（测试用：让后续调用回到 `node_modules` 解析 / 缺失态） */
export function unregisterPeer(name: string): void {
  injected.delete(name);
  resolved.delete(name);
  absent.delete(name);
}

/** 该 peer 当前是否可用（会真实探测一次并缓存结果） */
export function hasPeer(name: string): boolean {
  return resolvePeer(name) !== undefined;
}

/**
 * 取一个**必需** peer：拿不到就抛 `ENGINE_PEER_MISSING`。
 *
 * ★ 惰性：只在**第一次真正用到**时才解析，因此「装了 engine 但只 import 不用」
 *   不会被缺失的 peer 打断（import engine 本身仍然零副作用）。
 */
export function requirePeer<T>(name: string, opts: PeerOptions = {}): T {
  const mod = resolvePeer(name);
  if (mod === undefined) throw peerMissing(name, opts);
  return mod as T;
}

/**
 * 取一个**可选** peer：拿不到返回 `undefined`，由调用方决定降级还是抛错。
 *
 * ⚠️ 与 `requirePeer` 的区别只在**调用点语义**，不在 npm 的 optional 标记 ——
 *    两者都可用于 optional peer（用不到就别抛，用到了就必须抛）。
 */
export function tryPeer<T>(name: string, _opts: PeerOptions = {}): T | undefined {
  return resolvePeer(name) as T | undefined;
}
