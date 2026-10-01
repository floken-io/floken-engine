# Changelog

本包遵循 [Semantic Versioning](https://semver.org/)，格式参考 [Keep a Changelog](https://keepachangelog.com/)。
0.x 阶段跨包依赖写 `>=x.y.z <1.0.0`（不用 `^`）。

## 0.0.1 — 2026-10-01

首发。令牌制流程内核 + 中国式审批动作，覆盖 `03` 的阶段 **E1~E9**（685 单测 / `verify` 六道门禁全绿 /
冷启动探针 98 项跑真 `dist/`）。

### 新增

- **内核**：10 个业务无知原语 + 令牌推进 + run-to-wait（跑到稳定点才停）；状态分 Header（宿主建列）+ Body
  （不透明 JSON）两层，`JSON.stringify` 出得来（AC-E8）。
- **19 项审批动作**：其中 **17 项内核原生执行**；超时与暂存 2 项在内核外（经 `Scheduler` SPI 驱动）。
  设计期未开启的动作提交即抛错（AC-E2）；`enabledActionNames()` 是「按钮该不该灰」的唯一判据。
- **会签 / 或签 / 票签**：计票口径为「已表态 + 仍在途」，含 `03` §5.3 的**反向提前终止三条**；
  组结算后解散、承接令牌另造。
- **节点**：22 类 L3 执行语义，含子流程 / 调用活动（版本绑定，**绝不回退到别的版本**）、
  `intermediateCatchEvent` / `receiveTask` 的等待语义、边界事件（中断 / 非中断）、
  `Transaction` 的 `cancel`、`EventBasedGateway` 竞速。
- **两条集成路径**：`submit()`（门 1，save 后触发 hooks）与 `plan()`（门 2 纯函数，宿主自己包事务）——
  两条路径的状态演化**完全一致**，由测试钉死，不靠纪律。
- **一致性**：快照 + `rev` CAS（`expectedRev === 0` = INSERT 信号）+ 进程内 per-instance 串行队列。
- **投递**：`deliverMessage`（点对点）/ `deliverSignal`（广播）；未命中抛错并列出合法取值。
- **令牌轨迹**：`exportTrace()` 返回 `TraceResult`（含 `truncated`），是 `auditTrail` 的只读投影，不新增存储。
- **11 项 SPI**；`createMemoryStore()` 不传即用；`runStoreConformance` / `runProjectionConformance` /
  `runDefinitionConformance` 三套契约测试供宿主验证自研实现。

### 刻意不做（不是欠账，是设计取向）

- **内核不定时**：`ScheduleRequest` 只交 `fromAt` + 原始 `TimeoutSpec`，**不交 `dueAt`**——
  工作日历是业务数据，且时态库不得进 `dist`。不注入 `Scheduler` 就是真的不排程。
- **原语级审计已否决**（差异表 D-87）：run-to-wait 的令牌推进不走 `advance` 原语，
  按原语记账会造出一份「没有令牌移动的轨迹」，且一次提交炸几十条会扭曲 `maxAuditEntries`。
  故审计恒定**一次动作一条**。
- 已知但未实现的节点类型一律**显式抛错**并指名归属需求编号，不降级成自动直通
  （`sendTask` / `intermediateThrowEvent` / `implicitThrowEvent` / `complexGateway` /
  `AdHocSubProcess` / 补偿处理器；捕获事件目前只认 `message` / `signal`）。
