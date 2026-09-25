import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'neutral',
  dts: true,
  sourcemap: true,
  splitting: true,
  treeshake: true,
  clean: true,
  external: ['temporal-polyfill', 'floken-feel', 'floken-moddle'],
});
