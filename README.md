# @floken-io/engine

[![npm](https://img.shields.io/npm/v/@floken-io/engine)](https://www.npmjs.com/package/@floken-io/engine)
[![license](https://img.shields.io/npm/l/@floken-io/engine)](./LICENSE)

令牌制流程内核 + 中国式审批动作（会签 / 或签 / 票签 / 加签 / 转办 / 驳回 / 撤回）。

零 DOM、零数据库、零定时——持久化与调度全部经 SPI 注入，**核心引擎零基础设施依赖**。

## 安装

```bash
npm i @floken-io/engine @floken-io/moddle
```

**`@floken-io/moddle` 是必需 peer**（审批配置由它归一化）；缺失时引擎抛
`ENGINE_PEER_MISSING` 并在 `hint` 里给出安装命令——不内置兜底实现。

`@floken-io/feel` 是**可选** peer，装了即可在网关上写 `amount > 5000` 这样的条件，无需额外接线。

浏览器 / 打包器环境里 `node:module` 取不到，用 `registerPeer()` 显式注入：

```ts
import { registerPeer } from '@floken-io/engine';
import * as moddle from '@floken-io/moddle';

registerPeer('@floken-io/moddle', moddle);   // 任何 engine 调用之前执行一次
```

## 快速开始

一个三段报销流程，从发起到办结：

```ts
import { createEngine, createMemoryStore } from '@floken-io/engine';

// 流程定义：通常由 @floken-io/designer 产出，这里直接手写（Model JSON v2 形状）
const def = {
  schemaVersion: '2.0.0',
  id: 'Process_1',
  nodes: [
    { id: 'Start_1', type: 'startEvent' },
    { id: 'Task_1', type: 'userTask',
      approval: { approvers: [{ type: 'user', value: 'u_manager' }] } },
    { id: 'Task_2', type: 'userTask',
      approval: { approvers: [{ type: 'user', value: 'u_finance' }] } },
    { id: 'End_1', type: 'endEvent' },
  ],
  flows: [
    { id: 'f1', from: 'Start_1', to: 'Task_1' },
    { id: 'f2', from: 'Task_1', to: 'Task_2' },
    { id: 'f3', from: 'Task_2', to: 'End_1' },
  ],
};

const engine = createEngine({
  // 定义源是「图纸」：只读、按版本取。改版不影响在途实例
  definitionSource: {
    async getDefinition(processId, version) {
      return processId === 'Process_1' && version === 1 ? def : null;
    },
  },
  store: createMemoryStore(),        // 不传也是它
  clock: () => new Date().toISOString(), // 不传用 Date.now()，但显式传可让测试完全可复现
});

const id = await engine.start('Process_1', {
  definitionVersion: 1,
  starter: 'u_applicant',
  variables: { amount: 8600 },
});

await engine.submit(id, { action: 'approve', actor: 'u_manager', comment: '同意' });
await engine.submit(id, { action: 'approve', actor: 'u_finance' });

const trace = await engine.exportTrace(id);
console.log(trace.entries.map((e) => `${e.seq} ${e.actor} ${e.action} ${e.from} → ${e.to}`));
// [
//   '1 u_applicant start Start_1 → Task_1',
//   '2 u_manager approve Task_1 → Task_2',
//   '3 u_finance approve Task_2 → End_1'
// ]
```

## API 面

| 方法 | 用途 |
|---|---|
| `start(processId, opts)` | 发起实例，返回 `instanceId` |
| `submit(instanceId, action)` | 提交一次审批动作，返回待办差分 `TaskDelta` |
| `deliverMessage(instanceId, input)` | **点对点**投递消息，唤醒在等它的令牌 |
| `deliverSignal(instanceIds, input)` | **广播**信号，唤醒候选里所有在等的实例 |
| `exportTrace(instanceId)` | 导出令牌轨迹（`auditTrail` 的只读投影，不新增存储） |
| `plan(state, action, options?)` | ★ 纯函数入口：给宿主自己包事务用（不碰存储） |

`submit()` 只是 `plan()` + 落库的便利封装——**两条路径的状态演化完全一致**，由测试钉死。

## 19 项审批动作

`approve` / `reject` / `rejectTo` / `rollback` / `rollbackTo` / `transfer` / `delegate` /
`delegateBack` / `addSignBefore` / `addSignAfter` / `addSignParallel` / `reduceSign` /
`takeBack` / `revoke` / `urge` / `suspend` / `resume` / `terminate` / `skip`。

其中 **17 项由内核原生执行**；**超时**与**暂存** 2 项在内核外（由调度层经 `Scheduler` SPI 驱动）。
当前配置下哪些动作可用，用 `enabledActionNames(config)` 问——按钮该不该灰，只有这一处判据。

## 11 项 SPI

| 组 | 接口 | 默认 |
|---|---|---|
| 存储三线 | `StateStore`（真相）/ `TaskProjection`（视图）/ `DefinitionSource`（图纸） | 内存 store；后两项**必须**注入 |
| 业务接入 | `ApproverSource` / `ServiceHandler` / `AuthResolver` / `FormProvider` | 无（不注入 = 相关节点走不通并显式报错） |
| 求值 | `conditionHandler` / `decisionHandler` | **条件有**默认 FEEL 实现；决策无默认 |
| 出口 | `EventSink` / `Scheduler` | 无（不注入 `Scheduler` = **不排程**，不假装做了） |

## 一致性

- **快照 + `rev` CAS**：`save(next, expectedRev)`，`expectedRev === 0` 是 INSERT 信号，否则 CAS UPDATE；不匹配抛 `ENGINE_PERSIST_CONFLICT`，不静默覆盖。
- **并发三道防线**：进程内 per-instance 串行队列（主力）+ rev CAS（跨进程兜底）；不开读从库、不加悲观锁。
- **引擎内不做事务**：要么走 `submit()`（门 1：save 后触发 hooks，至少一次 + 宿主幂等），要么用 `plan()`（门 2：纯函数，宿主自己包事务）。

## 能力边界（诚实清单）

已知但**未实现**的节点类型一律**显式抛错**并指名归属需求编号——引擎刻意不把它们降级成"自动直通"，
因为那会让「这件事从来没发生过」变成一个没有报错的静默事实：

`sendTask` · `intermediateThrowEvent` · `implicitThrowEvent` · `complexGateway` · `AdHocSubProcess` ·
补偿处理器（`compensate`）；捕获事件目前只认 `message` / `signal`（等 `timer` / `error` 仍抛）。

`endEvent` 的 `eventDefinition`（terminate / message）尚未区分。

同样**没有**的：复杂查询与报表、作业执行器与重试框架、多租户、批量操作 API、历史归档、可视化运维台、
时间旅行重放、分布式锁（只有 CAS 重试）。这些归宿主——`03-包需求` §9.6 写明这是设计取向，不是欠账。

## 相关包

| 包 | 用途 |
|---|---|
| [`@floken-io/feel`](https://www.npmjs.com/package/@floken-io/feel) | FEEL 表达式语言 |
| [`@floken-io/moddle`](https://www.npmjs.com/package/@floken-io/moddle) | Model JSON 数据模型与校验（**必需 peer**） |
| [`@floken-io/dmn`](https://www.npmjs.com/package/@floken-io/dmn) | DMN 1.5 决策引擎 |
| `@floken-io/engine` | 流程内核与审批动作（本包） |
| `@floken-io/designer` | 流程画布与审批配置面板（开发中） |

## 许可证

[Apache-2.0](./LICENSE)
