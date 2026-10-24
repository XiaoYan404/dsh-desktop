---
description: "显式选择 MySQL Session 存储，保留原生历史和带 fence 的写句柄，并查看恢复限制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-mysql

[English](README.md) | 中文

## 概述

将完整原生 Session 历史持久化到显式选择的 R7 MySQL 命名空间，再通过现有 Agent 生命周期恢复。保留原始 Session ID、header、插件记录、surface 变化及紧凑 Assistant 流。单写者租约和持久化批次回执保护跨 Host 的追加顺序。此可选提供方保留默认 JSONL 选择及历史文件。[显式 Profile 指南](../../../docs/user/guide/mysql-sessions.zh.md) 说明 CLI 和 SDK 入口及其安装限制。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

仅在已提供 [MySQL 连接服务](../../storage/mysql/README.zh.md)、凭据提供方和经过核对的 R7 schema 的显式组合中挂载此提供方。管理员必须预先创建所选 `dsh_stores.store_key`；命名空间缺失会阻止激活，不会创建隐式存储。

```yaml
- name: '@deepseek-ai/dsh-session-persistence-mysql'
  config:
    storeKey: reviewed-private-store
```

| 选择 | 行为 |
|---|---|
| `storeKey` | 必填既有命名空间；每条查询都包含其内部 store ID |
| `leaseTtlMs` / `heartbeatIntervalMs` | 使用数据库时钟判定所有权；心跳间隔必须小于 TTL 的一半 |
| `batchDelayMs` | 实时事件批处理的最大主动等待时间；显式 flush 立即排空 |
| `readPageSize` | 限制每次 SQL seq 范围分页；公开读取仍返回请求的完整切片 |

[配置目录](../../../docs/config-catalog.zh.md) 负责全部可用字段和默认值。基于 base 的 profile 将 JSONL 行标识为 `session-persistence-jsonl`；`sdk-minimal` 使用 `sessions`，且不提供托管凭据。它们需要分别设置显式补丁。此包没有配置层、启动器或自动后端切换。

### 句柄与恢复

`create` 预留新生命周期和租约，但保持 Session 未发布。创建实例可以观察它，其他 Host 不可见。未追加或 flush 时关闭，不会留下已发布 Session，同一 ID 可以再次创建。种子的精确继承长度与不可变 header 并存，seeded Session 必须先追加完整继承前缀才能发布。显式 flush 可以发布空的 unseeded Session。

`open(read)` 固定原生命周期和格式，即使外部 ID 后来被重用也不改变。`open(write)` 取得数据库租约，并在返回前验证已提交前缀。原生 `SessionAlreadyExistsError`、`SessionAlreadyOwnedError`、`SessionReadOnlyError`、`SessionHandleClosedError`、`SessionOwnershipLostError`、格式拒绝与损坏错误仍可区分。租约丢失或续期失败会永久禁止该句柄写入；必须关闭后重新打开，不会静默取得新 owner。

Host 消费方可读取 `mysqlStoreKey`，并通过 `ownsMysqlWriter` 精确匹配本实例写入者，包括尚未发布的创建者。须在取得 store 锁的事务外先 flush，再在事务内核验数据库租约并同步匹配 owner。该能力不授予员工权限，也不冻结其他 Host。每个句柄对永久拒绝的实时事件路由只报告一次。

非空追加保留同一个冻结批次 ID、事件文本和 SHA-256，直至结果得到确认。事件、来源边、日志 revision、回执与搜索任务水位一起提交。COMMIT 结果未知时先查持久化回执；回执缺失或不可用会保留未知状态及同一待定批次。它不会授权重复执行外部工具。空 append 不创建回执。`flush` 排空已接受操作，`close` 排空后仅按本 owner 和 fence 条件释放。

提供方卸载、连接卸载及并发根卸载会禁止新接纳和外部追加，停止与各写句柄绑定的确切原生生产者，并保留事件路由及调用方 SQL，直到已接受队列排空、租约释放。助手、步骤及轮次的最后关闭事件仍走普通事件路由。并发释放等待同一次退役；普通句柄 close 不调用生产者回调。关闭时不会用写入 Session 快照替代事件路由。

生产者及存储失败仍会使调用方作用域和所拥有的 Agent 释放拒绝。Cordis 保留以 `logger.error` 收容 fiber disposer 失败的现有行为，因此根 `dispose()` 可能在记录排空失败后成功返回。应用必须观察该日志；根释放成功本身不代表持久化成功。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

服务持有句柄注册表和原生事件路由。每个写句柄持有一条修改链、心跳和待定批次准备值。实时写入失败后暂停自动调度；显式 flush 会先重试原批次，再收集新事件。只有回滚已确认时，私有事务拒绝对象才会还原原生 Session 错误身份；连接结果未知时始终优先保留未知结果。

事务依次锁定槽位、租约和日志。所有权使用随机 owner/生命周期字节、精确单调 fence 及数据库 UTC。哈希查找后核对原始外部 ID 文本。已提交事件文本保留在 `event_json` 中；列和来源边从中派生。读取固定 header 和事件数量前缀，按 seq 分页，验证原生记录并返回独占值。`stat/list` 使用元数据，不返回虚构物理文件大小。租约续期不改变日志 revision。

共享的 typed append 行为允许存储未知必需事件，但后续读取和写入打开会拒绝解释它。可忽略插件记录保持完整。正常原生前缀通过已安装格式目录；SQL CHECK 只是结构下限。历史 JSONL 迁移仍由其现有提供方及独立导入工作负责；此提供方不替换或改写旧文件。

变更先锁 store，再锁 slot、lease 和 log，与工作区、投影保持共同锁序。冲突回执永久冻结该句柄；缺失回执保留原批次直到显式恢复。`observeMysqlSessionCut` 向消费方提供单事务内精确且有界的生命周期、格式、revision、数量及完整验证前缀；它不提供跨事务维护冻结。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis 服务、本地 pending 可见性及原生事件路由 |
| [`src/handle.ts`](src/handle.ts) | 修改队列、固定批次、心跳和关闭 |
| [`src/repository.ts`](src/repository.ts) | R7 锁、租约、固定代际读取、回执及原子写入 |
| [`src/records.ts`](src/records.ts) | 无损准备值及已安装 Session 验证 |
| [`src/transaction.ts`](src/transaction.ts) | 回滚确认后的 Session 错误身份 |

显式[提供方验收](tests/mysql.acceptance.ts) 要求已预置隔离实例的公开描述文件。它创建唯一 store，使用真实 Loader/原生 Agent 服务，并由独立观察连接读取已提交事件。只有模型推理及显式确认故障受控。模块映射选择真实源码插件，因此不代表发行 CLI/SDK 模块解析或协议连接层 COMMIT 故障已覆盖。它不初始化 schema 或清空既有表。

独立[关闭验收](tests/mysql-shutdown.acceptance.ts) 对同一显式核验的数据库使用新 store 及 `schemaMode: verify`。它在两种挂载顺序的并发根释放，以及单独提供方或连接卸载后，对比完整原生事件序列。受控生产者延迟结束取消，以验证关闭确实等待；另一个场景保留失败作用域的拒绝、完成兄弟调用方，并观察 Cordis 的真实错误缓冲。Schema 回执保持不变。[专用配置](vitest.mysql-shutdown.config.ts) 不选择先前验收套件。

[协议连接层 COMMIT 验收](tests/mysql-wire-commit.acceptance.ts) 使用新 store 和回环 TCP 代理。代理扣留真实 COMMIT OK 时，独立只读观察连接先核实两条事件和原批次回执已经提交；代理随后丢弃该 OK 并断开这一连接。原追加在新连接读回回执后成功，协议包计数确认没有重复事件或回执 INSERT。此场景覆盖一次确认丢失且匹配回执仍可达的情况。Schema 回执保持不变。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [会话持久化](../../../docs/subsystems/persistence.zh.md)——保持不变的服务和句柄语义。
- [MySQL 连接](../../storage/mysql/README.zh.md)——地址、凭据、TLS 和 schema 要求。
- [Session 格式状态](../../../docs/session-format-status.zh.md)——当前写入器及已发布代际。
- [记录会话测试](../../test-support/session-snapshot/README.zh.md)——原始字节收集及显式持久化观察者。

-----

<a id="model-experience"></a>
## 模型体验

### 恢复的历史

#### 模型看到的内容

模型经由原生 Agent 接收恢复后的 `user` 和 `assistant` 消息。此提供方不增加提示词、工具或模型 schema；崩溃修复记录及后续模型请求由循环负责。

#### Token 影响

普通持久化不增加模型 token。恢复通过调用 Agent 保留原历史成本。

#### KV Cache 影响

持久化不改写较早的请求前缀。提供方缓存复用仍取决于恢复的历史及当前请求封装。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下集成缺口意味着此可选切片不等于已完成存储切换。

- 自定义实时生产者必须通过可选写句柄接口绑定自己的停稳过程；当前只集成原生 Agent 调用方。不结束的回调会阻止正常卸载，强制终止进程也无法排空内存。
- 真实 MySQL 8.4 场景覆盖 COMMIT OK 丢失、回查暂不可达、COMMIT 发到服务端之前断连，以及冲突回执。缺失回执恢复复用完全相同的 FrozenBatch；冲突冻结后继写入，close 仍释放原租约。服务端重启和心跳失败仍是独立故障覆盖工作。持久化回执只约束日志追加，不为外部工具提供 exactly-once 保证。
- 独立的真实 MySQL 8.4 验收在第二个原生轮次开放时，仅强制终止它自己创建的 built ACP 生产者。生产者存活期间，以及退出后数据库时钟租约自然过期之前，竞争写句柄都被拒绝。全新 profile 随后用更高 fence 恢复同一 Session，保留完整已提交前缀与回执，追加原有中断 step／turn 闭合事件并完成新轮次。场景不改写租约时刻，也不重启数据库；它不覆盖心跳失败或 MySQL 服务端重启。参见[自有进程异常退出验收](tests/mysql-process-crash.acceptance.ts)。
- 共享快照收集器通过 `RunOptions.sessionPersistence` 或 `Scenario.sessionPersistence` 接受独立拥有的 `SessionPersistence` 观察者。独立的 built CLI MySQL corpus 覆盖全部七个持久化等待操作及父／真实 spawn 子会话的最终产物，并与独立只读提供方和 SQL 核对完整事件。既有 JSONL corpus profile 不会自动挂载观察者或选择此后端，该独立场景也不代表整套历史 corpus 已获验证；参见[收集器说明](../../test-support/session-snapshot/README.zh.md)。
- [显式 CLI/SDK 补丁](../../../docs/user/guide/mysql-sessions.zh.md) 要求经批准的匹配插件产物和运维提供的补丁；npm 安装、Python wheel 及单文件可执行程序仍未验证。既有存储导入、不可变数据库代际迁移和 MySQL 搜索仍由独立消费方负责。可选[工作区](../../workspace/workspace-mysql/README.zh.md)和[投影](../session-projection-mysql/README.zh.md)提供方复用同一 schema。此提供方写入当前代际，并拒绝不同的当前指针。
- utf8mb4 无法保留 JSONL 路径编码支持的孤立 UTF-16 代理项。此提供方拒绝它们，不作替换；完整任意 ID 兼容需要经过审阅的可逆表示。R7 还将事件时间限制为非负安全整数。
- 每次追加及返回读取切片前的完整前缀验证较为保守，长日志成本可能较高。数据库持久性还取决于部署的 InnoDB 及复制设置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
