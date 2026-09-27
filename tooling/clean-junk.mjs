/**
 * 清理构建残留（`tsup` 等工具在工作目录里留下的临时文件）。
 *
 * 为什么需要：tsup 构建 `tsup.config.ts` 时，会先把 TS 配置编译成
 * `tsup.config.bundled_<hash>.mjs` 写在同一目录，构建完再删。
 * 一旦构建被中断（Ctrl-C、Windows 下删文件 EBUSY/EPERM），这个文件就留下了 ——
 * 每次失败留一个，慢慢堆成几十个。它们已被 .gitignore 忽略（不进仓库），但本地很脏。
 *
 * 用法：`node tooling/clean-junk.mjs`（挂到 `prebuild` / `postbuild`，见 package.json）。
 * 只删**明确匹配残留模式**的文件，绝不递归、绝不碰别的。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 残留模式：^…$ 全名匹配，只认根目录，不递归 */
const PATTERNS = [
  /^tsup\.config\.bundled_[^/\\]*\.mjs$/,
  /^tsup\.config\.[^/\\]*\.bundled_[^/\\]*\.mjs$/,
];

function isJunk(name) {
  return PATTERNS.some((re) => re.test(name));
}

const entries = fs.readdirSync(ROOT, { withFileTypes: true });
let deleted = 0;
for (const e of entries) {
  if (!e.isFile() || !isJunk(e.name)) continue;
  try {
    fs.unlinkSync(path.join(ROOT, e.name));
    deleted += 1;
  } catch (err) {
    // 删不掉（多半是占用中）不算失败，提示即可 —— 下次构建前还会再清
    console.warn('  ! 删不掉：' + e.name + '（' + err.code + '）');
  }
}

if (deleted > 0) console.log('clean-junk: 删除构建残留 ' + deleted + ' 个');
else console.log('clean-junk: 无残留');
