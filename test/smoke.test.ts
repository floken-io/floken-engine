/**
 * 冒烟：三层各验一次。
 *
 *   ① 源码层 —— 入口链 `index → entries → core` 真的通（不是只 export 了常量）
 *   ② 产物层 —— 冷启动探针**真跑 `dist/`**（`vitest` 其余用例跑的都是 `src/`，
 *      所以它们回答不了「发布出去的包宿主能不能用」）
 *   ③ 公开面 —— 导出面裁决被遵守（内部工具没泄漏），见探针内的反向断言
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { PACKAGE, SPI_NAMES } from '../src/entries/index';

/** 相对本文件定位，不依赖 `process.cwd()` */
const PROBE = fileURLToPath(new URL('./fixtures/smoke.mjs', import.meta.url));
const ARTIFACT = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const ARTIFACT_CONFORMANCE = fileURLToPath(new URL('../dist/conformance.js', import.meta.url));

describe('@floken-io/engine smoke', () => {
  it('包标识', () => {
    expect(PACKAGE).toBe('@floken-io/engine');
  });

  it('入口链 index → entries → core 可达（源码层）', () => {
    // 若 entries/index.ts 漏了 re-export，这里立刻红
    expect(SPI_NAMES).toHaveLength(11);
  });

  it('冷启动探针：Node 直接 import dist 产物', () => {
    // ★ 产物缺失必须**红**，不许静默跳过 —— 否则「忘了 build」会被伪装成通过
    expect(existsSync(ARTIFACT), `${ARTIFACT} 不存在，请先执行 npm run build`).toBe(true);
    // 子路径产物同理：`./conformance` 少 build 一个 entry，宿主 import 就会失败
    expect(
      existsSync(ARTIFACT_CONFORMANCE),
      `${ARTIFACT_CONFORMANCE} 不存在 —— 检查 tsup.config.ts 的 entry 里有没有 'conformance'`,
    ).toBe(true);

    const out = execFileSync(process.execPath, [PROBE], {
      encoding: 'utf8',
      // Windows 下 stdin 接管道会 EBUSY：显式忽略 stdin
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('SMOKE OK');
  });
});
