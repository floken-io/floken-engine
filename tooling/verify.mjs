#!/usr/bin/env node
// floken 统一发布门禁（六道通用 check 的最小可用实现）。
// 完整规格见 流程引擎包文档/06-仓库脚手架与发布约定.md §6。
// 任一道失败 -> exit 1。fail 信息须可照着修。
//
// 说明：所有子命令都优先通过 `node <script>` 直接执行（不经过 cmd.exe / npx），
// 以避免 Windows 下 spawnSync 的偶发 EBUSY；子进程仍不可用时，
// check:types / check:tests / check:pack 会退化为**进程内**实现并在输出中标注。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const fails = [];
const ok = (n, extra = '') => console.log(`\x1b[32m\u2713\x1b[0m ${n}${extra ? ' \u2014 ' + extra : ''}`);
const bad = (n, msg) => { console.error(`\x1b[31m\u2717 ${n}\x1b[0m \u2014 ${msg}`); fails.push(n); };

const NODE = process.execPath;
/** 子进程不可用时的典型错误（Windows/受限沙箱偶发） */
const SPAWN_BLOCKED = /EBUSY|EAGAIN|EMFILE|EPERM|ENOENT.*spawn|spawnSync/i;

function localBin(rel, fallbackRel) {
  const p = join(root, rel);
  if (existsSync(p)) return p;
  if (fallbackRel) {
    const f = join(dirname(NODE), fallbackRel);
    if (existsSync(f)) return f;
  }
  return null;
}

function sleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 忽略：不支持时退化为立即重试 */
  }
}

/** 通过 node 直接执行脚本（不经 cmd.exe）；EBUSY/EAGAIN 属 Windows 偶发，带退避重试 */
function run(script, args, attempts = 5) {
  const delays = [0, 500, 1500, 3000, 6000];
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return execFileSync(NODE, [script, ...args], { stdio: 'pipe', cwd: root });
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e);
      if (!/EBUSY|EAGAIN|EMFILE/i.test(msg)) throw e;
      if (i < attempts - 1) sleep(delays[i] ?? 1000);
    }
  }
  throw lastErr;
}

const TSC = localBin(join('node_modules', 'typescript', 'bin', 'tsc'));
const VITEST = localBin(join('node_modules', 'vitest', 'vitest.mjs'));
/**
 * 找 npm 的可执行入口。
 *
 * 位置因环境而异，写死一处必在别处翻车：
 *   - 本机 Windows（官方安装包）：<node 目录>/node_modules/npm
 *   - CI（actions/setup-node，Linux）：<node 目录>/../lib/node_modules/npm
 *   - 都没有：退回 PATH 上的 `npm` 命令（返回值用 'npm' 标记，调用处区分执行方式）
 *
 * ⚠️ 实测（2026-10-01）：GitHub Actions 上**只有**第一处时拿不到 npm →
 *   门禁报「npm-cli.js 未找到」而失败。**本地 Windows 一直是绿的**，所以这条
 *   是靠 CI 的红灯才暴露的（与 `floken-dmn` 1dd5532 修的是同一个坑）。
 */
function findNpmCli() {
  const near = [
    join('node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(NODE), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(NODE), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(NODE), '..', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const p of near) {
    if (existsSync(p)) return p;
    const abs = join(root, p);
    if (existsSync(abs)) return abs;
  }
  // PATH 上的 npm：Windows 是 npm.cmd，Linux 是 npm
  for (const cmd of ['npm', 'npm.cmd']) {
    try {
      execFileSync(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      return cmd;
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}
const NPM_CLI = findNpmCli();

// ---------- 进程内退化实现 ----------

/**
 * ★ 类型检查跑**两个 project**（见 `ARCHITECTURE.md` 的 **D-13**）：
 *   ① `tsconfig.json` —— 只含 `src`，按 **NodeNext** 解析（与**产物**的解析规则一致，强制 `.js` 扩展名）；
 *   ② `tsconfig.test.json` —— 含 `src` + `test`，按 **Bundler** 解析（与 **vitest / Vite** 的解析规则一致）。
 *   只跑 ① 时 `test/**` 从未被类型检查过（实测代价：连续三轮靠手工补跑才抓出真实类型错误）。
 */
const TYPECHECK_PROJECTS = ['tsconfig.json', 'tsconfig.test.json'];

/** 进程内调用 TypeScript API 做类型检查；无错误返回 '' */
async function tscInProcess(project = 'tsconfig.json') {
  const ts = await import(pathToFileURL(join(root, 'node_modules', 'typescript', 'lib', 'typescript.js')).href);
  const cfg = ts.readConfigFile(join(root, project), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const diags = ts.getPreEmitDiagnostics(program);
  if (!diags.length) return '';
  const host = { getCurrentDirectory: () => root, getCanonicalFileName: (f) => f, getNewLine: () => '\n' };
  return ts.formatDiagnostics(diags, host);
}

/** 进程内跑 vitest（关掉 reporter，直接从 state 读结果）；不可用时返回 null */
async function vitestInProcess() {
  const req = createRequire(join(root, 'package.json'));
  const { startVitest } = await import(pathToFileURL(req.resolve('vitest/node')).href);
  const vitest = await startVitest('test', [], { run: true, watch: false, reporters: [] });
  const files = vitest?.state?.getFiles?.() ?? [];
  await vitest?.close?.();

  const acc = { failed: 0, passed: 0 };
  const walk = (tasks) => {
    for (const t of tasks ?? []) {
      if (t.type === 'test') {
        if (t.result?.state === 'fail') acc.failed += 1;
        else if (t.result?.state === 'pass') acc.passed += 1;
      }
      if (t.tasks) walk(t.tasks);
    }
  };
  walk(files);
  return { ...acc, total: acc.failed + acc.passed };
}

/** 退化的打包清单：按 package.json 的 files 白名单 + npm 自动包含项静态推算 */
function staticPackPaths() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const listed = (pkg.files ?? []).filter((f) => !f.startsWith('!'));
  const auto = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'];
  return [...listed, ...auto.filter((f) => existsSync(join(root, f)))];
}

// 1. check:types（两个 project：源码按 NodeNext、测试按 Bundler，见 D-13）
try {
  if (!TSC) throw new Error('typescript 未安装（找不到 node_modules/typescript/bin/tsc）');
  for (const project of TYPECHECK_PROJECTS) {
    if (!existsSync(join(root, project))) throw new Error(`缺少 ${project}（D-13：测试必须参与类型检查）`);
    try {
      run(TSC, ['-p', project, '--noEmit']);
    } catch (spawnErr) {
      if (!SPAWN_BLOCKED.test(String(spawnErr.message || spawnErr))) throw spawnErr;
      const out = await tscInProcess(project);
      if (out) throw new Error(out);
      console.log(`\u00b7 check:types(${project}) \u2014 子进程不可用，已用进程内 tsc 完成`);
    }
  }
  ok('check:types', `${TYPECHECK_PROJECTS.length} 个 project（src + test）`);
} catch (e) {
  bad('check:types', 'tsc 报类型错误（见上方）');
  console.error((e.stdout?.toString?.() || '') + (e.stderr?.toString?.() || '') + (e.message || ''));
}

// 2. check:tests
try {
  let note = '';
  try {
    if (!VITEST) throw new Error('vitest 未安装（找不到 node_modules/vitest/vitest.mjs）');
    run(VITEST, ['run']);
  } catch (spawnErr) {
    if (!SPAWN_BLOCKED.test(String(spawnErr.message || spawnErr))) throw spawnErr;
    const res = await vitestInProcess();
    if (!res) throw spawnErr;
    if (res.failed > 0) throw new Error(`vitest 有 ${res.failed} 个失败用例`);
    note = `子进程不可用，已用进程内 vitest 完成（${res.passed}/${res.total} 通过）`;
  }
  ok('check:tests', note);
} catch (e) {
  bad('check:tests', 'vitest 未全绿');
  console.error((e.stdout?.toString?.() || '') + (e.stderr?.toString?.() || '') + (e.message || ''));
}

// 3. check:pack
try {
  let paths = [];
  let degraded = false;
  try {
    if (!NPM_CLI) throw new Error('npm 可执行文件未找到（项目内 / node 旁 / PATH 都没有）');
    // NPM_CLI 为 'npm' / 'npm.cmd' 时说明走的是 PATH 上的命令，不能交给 node 执行
    const out = (
      NPM_CLI === 'npm' || NPM_CLI === 'npm.cmd'
        ? execFileSync(NPM_CLI, ['pack', '--dry-run', '--json'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: root })
        : run(NPM_CLI, ['pack', '--dry-run', '--json'])
    ).toString();
    paths = (JSON.parse(out)[0].files || []).map((f) => f.path);
  } catch (spawnErr) {
    if (!SPAWN_BLOCKED.test(String(spawnErr.message || spawnErr))) throw spawnErr;
    paths = staticPackPaths();
    degraded = true;
    console.log('\u00b7 check:pack \u2014 子进程不可用，已退化为按 files 白名单静态核对');
  }

  const leaked = paths.filter(
    (p) =>
      /(^|\/)(src|test)\//.test(p) ||
      (/\.ts$/.test(p) && !p.endsWith('.d.ts')) ||
      /\.map$/.test(p), // ★ sourcemap 的 sourcesContent 会夹带原始 TS 源码，禁止进包
  );
  if (leaked.length) bad('check:pack', '泄漏源码/测试: ' + leaked.join(', '));
  else ok('check:pack', `${paths.length} 个文件${degraded ? '（退化口径）' : ''}`);

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const badProto = ['workspace:', 'file:', 'link:'].filter((p) => JSON.stringify(pkg).includes(p));
  if (badProto.length) bad('check:pack', '出现禁止协议: ' + badProto.join(', '));
  else ok('check:pack', '无 workspace:/file:/link:');
} catch (e) {
  bad('check:pack', 'npm pack 失败');
  console.error((e.stdout?.toString?.() || '') + (e.stderr?.toString?.() || '') + (e.message || ''));
}

// 4. check:deps —— dist 的 import 说明符体检（Q33 + 「产物引用必须已声明」）
const dist = join(root, 'dist');
if (existsSync(dist)) {
  const walkDir = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walkDir(join(d, e.name)) : [join(d, e.name)],
    );
  const js = walkDir(dist).filter((f) => f.endsWith('.js'));
  const src = js.map((f) => readFileSync(f, 'utf8')).join('\n');

  // ① Q33：产物不得引用时态（`temporal-polyfill` 本体 / `@floken-io/feel/temporal` 子路径）。
  //    口径是「**说明符**里有没有」，不是「文件里有没有 temporal 字样」——
  //    后者会把 `TEMPORAL_FUNCTIONS` 这类无关标识符一起误报。
  const specifiers = new Set(
    [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
  );
  const temporalHits = [...specifiers].filter((s) => /^temporal|^@floken-io\/feel\/temporal/.test(s));
  if (temporalHits.length) {
    bad('check:deps', `dist 引用了时态: ${temporalHits.join(', ')}（Q33 违例）`);
  } else {
    ok('check:deps', `无时态引用（扫到 ${specifiers.size} 个说明符）`);
  }

  // ② 产物引用的**外部包**必须在 package.json 的依赖里声明 ——
  //    否则「装了 engine 却跑不起来」要等到用户那里才炸（漏声明是最常见的发布事故）。
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
  const pkgNameOf = (s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);
  const external = [...specifiers].filter((s) => !s.startsWith('.') && !s.startsWith('node:'));
  const undeclared = [...new Set(external.map(pkgNameOf))].filter((n) => !declared.has(n));
  if (undeclared.length) {
    bad('check:deps', `产物引用了未声明的包: ${undeclared.join(', ')}（加到 dependencies）`);
  } else {
    ok('check:deps', `外部引用全部已声明（${[...new Set(external.map(pkgNameOf))].join(', ') || '无'}）`);
  }
} else {
  console.log('\u00b7 check:deps \u2014 跳过（dist 尚未构建）');
}

// 5/6. size / exports — 占位（需 tsup 产物 + publint/attw，详见 06 §6）
console.log('\u00b7 check:size / check:exports \u2014 完整口径见 06-仓库脚手架与发布约定 §6');

if (fails.length) {
  console.error(`\nverify FAILED: ${fails.length} 项未通过`);
  process.exit(1);
}
console.log('\nverify PASSED');
