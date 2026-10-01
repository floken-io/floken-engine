import { defineConfig } from 'tsup';

export default defineConfig({
  // ★ entry 的 key 决定产物名（index → dist/index.js），值必须指向 `src/entries/`：
  //   公开面只住在 `src/entries/`（`06-仓库脚手架与发布约定` §3），`src/` 下不得有第二个 index.ts
  //   —— 否则「公开面在哪」就靠纪律维持。engine 曾因此让 6 个 core 文件被 treeshake，
  //   `dist/index.js` 只剩 72 B 而三门禁全绿。
  entry: {
    index: 'src/entries/index.ts',
    // ★ 子路径导出：`./conformance`（契约测试套件）。key 决定产物名 → dist/conformance.js
    //   新增子路径须**三处同步**：本处 + src/entries/<name>.ts + package.json 的 exports（AGENTS.md §4.1）
    conformance: 'src/entries/conformance.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'neutral',
  dts: true,
  // ★ 不开 sourcemap：`.map` 的 `sourcesContent` 会把原始 TS 源码整段嵌进去，
  // 发布策略是「npm 只发产物，源码只在 GitHub」，故彻底不生成（调试走 src / vitest）。
  sourcemap: false,
  splitting: true,
  treeshake: true,
  clean: true,
  external: ['temporal-polyfill', '@floken-io/feel', '@floken-io/moddle'],
});
