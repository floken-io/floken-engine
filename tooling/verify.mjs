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
const NPM_CLI = localBin(
  join('node_modules', 'npm', 'bin', 'npm-cli.js'),
  join('node_modules', 'npm', 'bin', 'npm-cli.js'),
);

// ---------- 进程内退化实现 ----------

/** 进程内调用 TypeScript API 做类型检查；无错误返回 '' */
async function tscInProcess() {
  const ts = await import(pathToFileURL(join(root, 'node_modules', 'typescript', 'lib', 'typescript.js')).href);
  const cfg = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
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

// 1. check:types
try {
  try {
    if (!TSC) throw new Error('typescript 未安装（找不到 node_modules/typescript/bin/tsc）');
    run(TSC, ['-p', 'tsconfig.json', '--noEmit']);
  } catch (spawnErr) {
    if (!SPAWN_BLOCKED.test(String(spawnErr.message || spawnErr))) throw spawnErr;
    const out = await tscInProcess();
    if (out) throw new Error(out);
    console.log('\u00b7 check:types \u2014 子进程不可用，已用进程内 tsc 完成');
  }
  ok('check:types');
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
    if (!NPM_CLI) throw new Error('npm-cli.js 未找到');
    const out = run(NPM_CLI, ['pack', '--dry-run', '--json']).toString();
    paths = (JSON.parse(out)[0].files || []).map((f) => f.path);
  } catch (spawnErr) {
    if (!SPAWN_BLOCKED.test(String(spawnErr.message || spawnErr))) throw spawnErr;
    paths = staticPackPaths();
    degraded = true;
    console.log('\u00b7 check:pack \u2014 子进程不可用，已退化为按 files 白名单静态核对');
  }

  const leaked = paths.filter(
    (p) => /(^|\/)(src|test)\//.test(p) || (/\.ts$/.test(p) && !p.endsWith('.d.ts')),
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

// 4. check:deps —— dist 不得含 temporal 静态引用
const dist = join(root, 'dist');
if (existsSync(dist)) {
  const walkDir = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walkDir(join(d, e.name)) : [join(d, e.name)],
    );
  const js = walkDir(dist).filter((f) => f.endsWith('.js'));
  const hit = js.some((f) => /temporal-polyfill|from ['"]temporal/.test(readFileSync(f, 'utf8')));
  if (hit) bad('check:deps', 'dist 中检出 temporal 静态引用（NFR-F12 违例）');
  else ok('check:deps', '无 temporal 静态引用');
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
