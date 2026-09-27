# @floken-io/engine

> ⚠️ **开发中，尚未发布到 npm。**

令牌制流程内核 + 中国式审批动作（会签 / 或签 / 加签 / 转办 / 驳回 / 撤回）。

## 设计边界

- 不碰 DOM、不连数据库、不做定时——持久化与调度经 SPI 注入，核心引擎零基础设施依赖
- 19 项审批动作中 **17 项由内核原生执行**；超时与暂存 2 项在内核外（由调度层驱动）

## 依赖

- [`@floken-io/feel`](https://www.npmjs.com/package/@floken-io/feel)（默认带上）——装上即可写 `amount > 5000` 这样的网关条件

## 相关包

| 包 | 用途 |
|---|---|
| [`@floken-io/feel`](https://www.npmjs.com/package/@floken-io/feel) | FEEL 表达式语言 |
| [`@floken-io/moddle`](https://www.npmjs.com/package/@floken-io/moddle) | BPMN 2.0 模型与 XML 转换 |
| [`@floken-io/dmn`](https://www.npmjs.com/package/@floken-io/dmn) | DMN 1.5 决策引擎 |
| `@floken-io/engine` | 流程内核与审批动作（本包） |
| `@floken-io/designer` | 流程画布与审批配置面板（开发中） |

## 许可证

[Apache-2.0](./LICENSE)
