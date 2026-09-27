# @floken-io/engine

令牌制流程内核 + 中国式审批动作（会签 / 或签 / 加签 / 转办 / 驳回 / 撤回）。

> 当前为骨架占位，实现见 `流程引擎包文档/03-包需求-floken-engine.md`。

## 依赖

- `@floken-io/moddle`（运行时）
- **`@floken-io/feel`（普通 `dependencies`，默认带，Q30）**——装上即可写 `amount > 5000` 网关条件。

## 开发

```bash
pnpm install
pnpm build
pnpm verify
```

## 硬约束

- 不碰 DOM、不连数据库、不做定时（Scheduler SPI）。
- 19 项审批动作中 17 项内核原生执行；对外只说「19 项审批动作，17 项内核原生」。
