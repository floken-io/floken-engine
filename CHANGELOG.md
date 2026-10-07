# Changelog

本包遵循 [Semantic Versioning](https://semver.org/)，格式参考 [Keep a Changelog](https://keepachangelog.com/)。
0.x 阶段跨包依赖写 `>=x.y.z <1.0.0`（不用 `^`）。

## 未发布

### 修复 · 超时动作的**参数**不再被静默丢弃

`ScheduleRequest.payload` 现在装的是**整个 `TimeoutAction` 原样副本**
（`{ type, interval?, max?, target?, to? }`）。此前只交 `kind` 一个字符串：

| 定义里写的 | 调度方原来收到 | 现在收到 |
|---|---|---|
| `{ type:'remind', interval:'PT12H', max:3 }` | `{kind:'remind'}` | `payload:{type:'remind',interval:'PT12H',max:3}` |
| `{ type:'autoReject', target:'previous' }` | `{kind:'autoReject'}` | `payload:{type:'autoReject',target:'previous'}` |
| `{ type:'escalate', to:[{type:'role',value:'r_admin'}] }` | `{kind:'escalate'}` | `payload:{type:'escalate',to:[…]}` |

后果是 `03` F-3 的 AC1（按 `interval` 催、到 `max` 停）/ AC3（驳回给谁）/ AC4（升级给谁）
**三条都兑现不了** —— 调度方根本拿不到这些参数。与 `workCalendar` 是同一类问题：
宿主写在定义里的数据，内核不解读、不改写、**也不该丢**。

### 破坏性变更 · `PendingTimeout.kinds` → `actions`

`PendingTimeout`（`runtime/timers.ts`，公开导出）原字段 `kinds: TimerKind[]`
换成 **`actions: readonly TimeoutAction[]`** —— 只留类型字符串正是上面那个 bug 的根因，
留着两处同源数据就是分叉的开始。`TimerKind` 类型本身仍导出（它等于 `ScheduleKind`）。

### 破坏性变更 · `extension` 是宿主的地盘：引擎不再筛选任何键

`extensionsOf()` / `ConditionCtx.nodeExtensions` / `targetExtensions` 原来会按
"模型一等字段键"排除一部分键。这条判据**整个删除**：

- v2 里一等字段在 `node.approval`，**不在** `node.extension` 里 —— 袋里出现 `approval`
  只有一种可能：**宿主自己的业务数据**；
- 再排除它就不是"不外泄内部语义"，而是**静默吃掉宿主的数据**，
  直接违背「引擎不解读、不改写、**不筛选**」这条承诺。

（演变：`floken:*` 前缀 → `NODE_RESERVED_KEYS` → 判据整个删除。前两版是 v1 判据的
等价替换，替换得再准，判据本身在 v2 已无对象。）

配套删除：`ModdleSlice` 不再取 `NODE_RESERVED_KEYS`（对 moddle 的需求只剩
`normalizeApproval` 一项）。

现在 `extension` 里**什么键都能写**，与一等字段同名也照给、零诊断。

### 修复 · 内联 `workCalendar` 不再被静默丢弃

`TimeoutSpec.workCalendar` 的类型由 `string` 放宽为 **`string | WorkCalendarSpec`**，
`timeoutSpecOf()` 对两种形态**都原样交出**。

此前只在它是字符串（日历 id）时透传，**内联对象被整个丢掉且不报错** ——
模型层允许写、归一化也留着，到调度方手里却没了，等于静默吞掉宿主的配置。

同时订正两条注释口径：

- 引擎**不内置任何节假日表**，`holidays` 一律由宿主给；
- `Scheduler` **不注入 = 不排程**（不存在 `createMemoryScheduler()`，旧注释写错了）。

### 破坏性变更 · 并入层不再"去命名空间前缀"（v1 遗留，Q48 后失效）

`extensionVars` 并入求值上下文时，v1 会把 `acme:priority` 截成 `priority`。v2 已删：

- `extension` 是**任意 JSON，没有命名空间概念**，前缀只是宿主自己的命名习惯；
- 留着它会**静默截断**普通键 —— 实测 `order:id` → `id`、`a:b:c` → `b:c`，
  机缘巧合还会命中另一个真实变量从而判错分支。

现在**键原样并入**，写什么键就是什么键。同时新增一道硬约束：

- **键里带冒号 → 抛 `OPTION_INVALID`**（不静默并入）。实测 FEEL 引用不到带冒号的键：
  `target.acme:priority` 语法错、`target["acme:priority"]` 求值为 `null`
  （`[...]` 在 FEEL 里是列表筛选，不是对象取键）。并进去了却读不出来 = 功能不存在且毫无提示。
- 由此可知：扩展键**不要带冒号**。写 `priority`，别写 `acme:priority`。

配套删除：「去前缀后两个命名空间撞名 → 抛错」这条判据一并删除
（键不再被改写，就不可能被改写出碰撞）。

⚠️ 迁移：把模型里 `extension` 的键与前缀一起去掉（`acme:priority` → `priority`），
并把 `extensionVars.casts` 的键同步改成无前缀形式。

## 0.0.3 — 2026-10-03

★ 本次含**两项破坏性变更**（Q49 跨包 peer 化 + Q48 联动 Model JSON v2），
`@floken-io/moddle` 的 peer 范围收紧到 `>=0.1.0 <0.2.0`。

### 破坏性变更 · 一：`@floken-io/moddle` / `@floken-io/feel` 改为 peer（Q49）

五个包之间**一律 peer，不再内置**。必需性按源码实际用法定：

| peer | 必需性 | 说明 |
|---|---|---|
| `@floken-io/moddle` | **必需** | `normalizeApproval()` 在建图时同步调用，缺了就建不了图 |
| `@floken-io/feel` | 可选 | 条件的默认 FEEL 实现，不装则网关条件必须自己提供 `conditionHandler` |

- 新增 `src/core/peer.ts`：**惰性 + 同步**三级解析 —— ① `registerPeer()` 宿主注入
  → ② `createRequire(import.meta.url)` → ③ 抛 `ENGINE_PEER_MISSING`。
  - ★ 同步能成立靠 **Node ≥22.12 的 `createRequire` 可加载纯 ESM**（实测 moddle 114 / feel 45 个导出键），
    故引擎的同步 API 一个都不用改成异步。
  - 取 `createRequire` 必须走 `process.getBuiltinModule('module')`，**不能**静态 import
    `node:module`（打包器会 externalize，浏览器连包都加载不了）。
  - ⚠️ 本机 `.npmrc` 有 `legacy-peer-deps=true` 时 npm **不会自动装** peer
    → `devDependencies` 里必须显式钉版本，且**宿主项目必须自己装**。
- 新增错误码族第 5 类 **`PEER_`**（`ENGINE_PEER_MISSING`）；抛出码 19 → **20** 个。
- 公开 `registerPeer` / `unregisterPeer` / `hasPeer` / `requirePeer` / `tryPeer`。
- ⚠️ **绝不内置兜底实现**：缺失就抛并给安装命令。自带「简化版算法」会让两个实现悄悄分叉。

### 破坏性变更 · 二：Model JSON v2 形状（Q48 的 S6 联动）

`@floken-io/moddle` 0.1.0 起是 JSON-only，形状重做，引擎读取点同步改：

- **`processes[]` 整层删除**：定义从 `def.processes[0]` 改为**顶层 `nodes` / `flows`**，
  `createProcessGraph` 直接用 `definition.id !== processId` 判 `definitionMissing`。
- **`approval` 提升为一等字段**：原读 `node.extension['floken:approval']`，现读 **`node.approval`**。
- **`call` 提升为一等字段**：`callActivity` 的子流程引用改读 **`node.call`**（`{ processId, version }`）；
  报错 hint 同步改指「在该节点的一等字段 `call` 上写 `{ processId, version }`」。
- **`script` 改结构**：`script` + `scriptFormat` 两个字段 → **`script: { body, language }`**。
- **`schemaVersion` 必须是 `2.0.0`**：引擎校验器对 major ≠ 2 直接报 error，**不提供 v1 → v2 迁移**。

### 变更 · ADR-009 改定（用户 2026-10-03 拍板：放开）

`nodeExtensions` / `targetExtensions` 的两条限制随 XML 一起松开：

- **排除判据**：原排除 `floken:*` **前缀**（前缀机制随 XML 消失）→ 改为排除**模型一等字段键**
  （`NODE_RESERVED_KEYS`，**从 `@floken-io/moddle` 取，引擎不另写一份**）。
- **值的范围**：原**只给标量** → 改为**结构化值也给**（`{ maxAmount: 5000, tags: ['vip'] }` 原样给出），
  **只排除函数**与 `undefined`。
- 收益：opt-in 后可直接写 `node.rule.maxAmount > 5000` 这类表达式。
- 三条硬边界不变：**默认不并入求值上下文** / **绝不写进 `InstanceState.variables`** /
  引擎只认 moddle 给的保留键清单。

### 验证

- 单测 **701/701** 全绿；冷启动探针 **103/103** 全绿（跑真 `dist/`）；`verify` 门禁全绿。
- 夹具与探针全部迁到 v2 形状（`test/helpers/definition.ts` / `test/fixtures/smoke.mjs`）。

## 0.0.2 — 2026-10-02

### 新增

- ★ **宿主自定义扩展属性（ADR-009）**：`@floken-io/designer` 上配的自定义属性（`node.extension['acme:priority']`）
  现在能被条件直接用，不必再注入 `conditionHandler` 手写回查。分两级：
  - **第一级（恒给，无需配置）**：`ConditionCtx` 增 `nodeExtensions`（当前节点）与
    `targetExtensions`（该分支的**目标节点**）两个只读字段。键**带前缀**原样给出，排除 `floken:*`、**只含标量**。
  - **第二级（opt-in）**：配置 `EngineConfig.extensionVars` 后并入求值上下文，
    挂成 `variables.node` / `variables.target`，条件可直接写 `target.priority = "high"`。
- ★ **类型还原可按声明做**：`extensionVars.casts`（如 `{ 'acme:slaHours': 'number' }`）。
  起因是 XML 往返后扩展属性的值**一律是字符串**（实测 `48 → "48"`），而 `"48" > 24` 会按字符串比较；
  引擎**不猜类型**（猜 = 静默错误），按声明转换，转不动就抛 `ENGINE_OPTION_INVALID`。

### 变更

- `ConditionUnresolved` 内部哨兵增 `toNodeId`（原先只带源节点，取不到目标节点的扩展属性）。
  该哨兵**不是**公开 API 的一部分（引擎吞掉并重试），宿主不会收到它。

### 兼容性

- **不声明 `extensionVars` 时行为与 0.0.1 逐字一致**：只读字段是纯增量，`variables` 一个键都不多。
- ⚠️ 已知代价（行为已钉死、文档如实写明）：**不 opt-in 却在表达式里写 `target.*`
  → 不报错、静默走另一条分支**（`target` 未定义时等值比较求值为 `false`，
  与 `amount > 5000` 缺变量求值为 `null` 而抛错的语义不同）。

### 验证

- 单测 **701**（+16，新增 `test/extension-vars.test.ts`）；冷启动探针 **103**（+5，跑真 `dist/`）；
  `verify` 六道门禁全绿。

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
