import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
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
  external: ['temporal-polyfill', 'floken-feel', 'floken-moddle'],
});
