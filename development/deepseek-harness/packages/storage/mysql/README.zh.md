---
description: "配置显式 MySQL 8.4 连接，初始化完整 R7 schema，并处理预处理语句和事务失败。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mysql

[English](README.md) | 中文

## 概述

通过 Host 管理的凭据连接指定 MySQL 8.4 数据库，执行位置参数预处理语句，并保留 BIGINT 与 DECIMAL 精度。在经过核对的空库中初始化完整 R7 schema，显式升级已识别的前代，或在为调用方提供服务前验证最新 schema。连接强制使用 UTC 和严格 SQL 模式；取消会关闭对应连接。此按需启用的传输服务保留现有 JSON 与 SQLite 选择，不导入 Native 历史数据。

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

将此服务挂载到显式 Cordis 组合中，由调用方使用 `ctx.mysql`。此包没有应用启动器或配置层。

### 部署前提

管理员提供主机、端口、既有数据库、限定数据库权限的账号及密码凭据引用。Oracle MySQL 8.4 必须配置 `ngram_token_size=2` 和 `innodb_ft_enable_stopword=OFF`；数据库必须使用 `utf8mb4` 和 `utf8mb4_0900_bin`。初始化需要创建和修改 R7 表及索引的权限；日常验证与数据访问需要对应的表权限。插件不会创建数据库或修改服务器全局设置。

在此配置行之前加载 Host 凭据提供方，并通过该提供方设置所引用的秘密。`passwordRef` 是凭据名称，不是明文密码，也不会自动读取同名环境变量。通过现有 `dsh` 组合及补丁机制挂载此行。

```yaml
- name: '@deepseek-ai/dsh-mysql'
  config:
    host: 127.0.0.1
    port: 11406
    database: dsh_private
    user: dsh_runtime
    passwordRef: DSH_MYSQL_PASSWORD
    schemaMode: verify
```

| 选择 | 行为 |
|---|---|
| `schemaMode: verify` | 默认值；要求完整最新 schema 和三条匹配回执；不写入 schema 或回执 |
| `schemaMode: initialize` | 仅在指定数据库中没有表或视图时依次创建全部二十张 R7 表并应用后继迁移；既有最新 schema 会被验证 |
| `schemaMode: upgrade` | 接受完整且已识别的前代；已有 store 在 v3 DDL 前须经审阅迁移 API 提供 Workspace global 和归档来源决定 |
| `tlsCAFile` | PEM CA 文件启用 TLS，并验证证书和身份；字面 IP 地址还必须提供 `tlsServerName` |
| `tlsServerName` | 通过其他地址或 IP 拨号时所预期的 DNS/CN 证书身份；必须配合 `tlsCAFile`，不改变物理 `host`/`port` |
| 资源设置 | 验证连接数、获取连接、操作、schema 锁及预处理语句限制；已接受的操作不会自动重试 |

[配置目录](../../../docs/config-catalog.zh.md) 是完整字段参考。使用 `initialize` 或 `upgrade` 前先核对目标地址，正常启动使用 `verify`。`status()` 返回最新已验证的代际、校验和及表/外键数量，不返回凭据或业务行。已是最新版本的数据库会拒绝 `upgrade`；[升级指南](../../../docs/upgrade-guide/v0.2.1-alpha.2/mysql-json-integers/guide.zh.md) 提供 v1 操作步骤。

### TLS 服务器身份

`host` 和 `port` 保留为物理数据库地址，`tlsCAFile` 指向管理员提供的 PEM CA。地址为字面 IP 时，还必须将 `tlsServerName` 设置为服务器证书所预期的 DNS 名称或 CN，例如：

```yaml
tlsCAFile: /deployment/certificates/mysql-ca.pem
tlsServerName: mysql.internal.example
```

公开的 mysql2 stream factory 拨号到原 `host`/`port`，mysql2 则验证 CA 链和显式证书身份，并将该身份用于 TLS SNI；不会修改 DNS 或系统 hosts。DNS 地址未显式提供名称时，继续由原驱动路径验证 `host`。IP 加 TLS 却没有名称、名称没有配套 CA、或名称本身为 IP，都会在解析凭据或建立连接前拒绝。既有未加密 IP 配置保留原有行为。

既有 IP 加 CA 的部署必须在升级前补充预期 DNS/CN 身份，不会隐式使用 `localhost`。直接验证 IP SAN 仍未支持；不要将 IP 字面量填入 `tlsServerName`，也不要把这些 DNS/CN 测试视为 IP SAN 验收。

### 失败与恢复

`MysqlError` 包含稳定的 `code`、提交 `outcome`、`retryable` 提示及可选驱动代码。诊断信息省略驱动原始消息、SQL、参数和密码。凭据缺失、服务器不可用或部署不兼容会拒绝服务激活；修正配置或服务后重新加载插件。

自动提交或 COMMIT 结果未知时，必须先通过调用方持有的持久化回执或回读确认，再执行下一次写入。提供方不会重试事务或外部工具操作。初始化或升级失败可能留下已提交的 DDL：`schema_incomplete` 会阻止激活，保留数据库及早期回执供检查，不会静默补全或重置。部分应用的 v2 不会被误认成完整 v1 并自动重试。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

每个被接受的操作独占一个池连接。认证后的会话设置应用 UTC、严格 SQL 模式及所需排序规则。位置参数通过 mysql2 预处理语句传输；BIGINT 与 DECIMAL 行值保持为字符串，日期保持为 SQL 字符串，不安全的整数输入会在执行前被拒绝。调用方负责解码行值、限制结果大小并使用可信静态 SQL。`mysqlConsumerTransaction` 仅在已确认回滚后保留消费方的类型化拒绝；未知结果优先。

[v3 工作区后继](assets/003-workspace-order-and-lease.sql) 追加归档序号、显式 global 写入位和带 fence 的 Registry 所有权。已有 store 必须给出来源决定；无序归档布尔集合不能推导原序。可空列回填先于最终约束和结构核验；部分失败不写成功迁移回执。参见[工作区升级说明](../../../docs/upgrade-guide/v0.2.1-alpha.2/mysql-workspace-v3/guide.zh.md)。

schema 激活持有数据库范围的建议锁。不可变的 [v1 R7 SQL](assets/001-r7.sql) 包含全部二十张表和二十五个外键，涵盖当前会话指针、写入者租约、追加回执、投影、搜索及导入记录。追加的 [v2 SQL](assets/002-json-safe-integers.sql) 仅改变 `ck_log_header` 和 `ck_event_json` 中的四处 JSON 数字类型判断，接受 `INTEGER` 与 `UNSIGNED INTEGER`，同时保留安全边界及派生列相等检查。MySQL 使用后一类型表示真实毫秒时间戳。每个 SHA-256 覆盖一份可执行资源；初始化在应用 v2 前记录 v1。每代回执仅在完整结构验证后插入。资源均不创建或选择数据库，已应用的前代永不改写。

`transaction()` 将执行器限制在回调内，并等待 COMMIT 确认。回调不得执行 DDL、事务控制或会话修改。取消、超时或卸载会关闭所拥有的传输连接并使执行器失效。实现使用固定 mysql2 版本的传输对象，因为其平缓 `destroy()` 无法及时终止正在执行的语句；升级驱动时必须保留受控取消检查。

持有异步生产者的调用方在激活期间注册 `ctx.mysql.registerConsumer(drain)`，并使用返回的 SQL 能力。注册及释放由调用方的 `ctx.effect` 管理。排空必须立即禁止新业务、停止其确切生产者并等待已接受队列完成，不得等待自己的 SQL 作用域或连接卸载。连接关闭时拒绝普通 SQL 和新注册、取消普通操作，并在所有已注册调用方完成后才取消剩余传输并关闭连接池。排空中的调用方可以在操作截止时间内等待连接池容量；普通接纳仍拒绝超量操作。重复释放等待同一次结束，并在清理后保留生产者与 SQL 失败。

当前调用方是 [MySQL Session 持久化](../../session/session-persistence-mysql/README.zh.md)，它在原生生产者拆除期间保留实时路由。Cordis 使用 `logger.error` 记录 fiber disposer 失败；作用域释放保留拒绝，根 fiber 释放则可能在记录错误后成功返回。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis 服务、凭据、连接池归属、参数绑定语句及事务 |
| [`src/schema.ts`](src/schema.ts) | 迁移校验和、部署预检及 schema 验证 |
| [`src/schema-checks.ts`](src/schema-checks.ts) | 保留运算分组的 Oracle CHECK 表达形式比较 |
| [`src/error.ts`](src/error.ts) | 脱敏错误代码和已知提交状态 |
| [`src/consumer.ts`](src/consumer.ts) | 调用方 SQL 生命周期、幂等排空及失败保留 |
| [`src/types.ts`](src/types.ts) | 调用方结果、执行器及 schema 状态类型 |

显式[隔离实例验收测试](tests/mysql-isolated.acceptance.ts) 使用 `credentials-local` 启动真实 Loader；独立 [Vitest 配置](vitest.mysql.config.ts) 要求 round144 公开描述文件，缺失时直接失败。它不会发现本机 MySQL 服务，也不会因缺少数据库而静默跳过。普通包测试使用受控的不可用回环地址，不需要数据库。

单独筛选的[迁移验收](tests/mysql-upgrade.acceptance.ts) 先验证所属 v1 且不写入，再要求审查精确 v2 校验和后才执行升级。它保留原回执及事件文本哈希，验证真实时间戳，并拒绝小数/字符串 JSON 数字及派生不一致，最后仅回滚自身判断测试行。它不会重置数据库或重跑初始化。

独立的 [IP/TLS 验收](tests/mysql-tls-ip.acceptance.ts)及[配置](vitest.mysql-tls-ip.config.ts)通过公开 stream factory 拨号到专属 IP，同时验证真实 CA 链和显式 DNS/CN 身份。错误身份在 TLS 握手时被拒绝；缺失或不兼容的 TLS 设置在解析凭据或建立传输前被拒绝。这些只读场景保留 DNS、证书、服务器配置及 schema 回执。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [MySQL 子系统](../../../docs/subsystems/mysql.zh.md)——调用方语义与失败归属。
- [存储子系统](../../../docs/subsystems/storage.zh.md)——独立的领域存储后端 API。
- [会话持久化](../../../docs/subsystems/persistence.zh.md)——事件日志提供方与已发布 Session 格式。
- [凭据](../../../docs/subsystems/credentials.zh.md)——Host 凭据引用与提供方。

-----

<a id="model-experience"></a>
## 模型体验

### 数据库传输

#### 模型看到的内容

无。`ctx.mysql` 不注册提示词、工具、模型 schema 或会话事件；调用方负责已存数据对模型的可见用途。

#### Token 影响

实时请求 token 为零。

#### KV Cache 影响

无。传输服务不会修改模型请求前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

调用方与部署负责人必须考虑以下限制。

- 此服务提供连接和 schema 初始化；不实现 Session 提供方、领域后端、租约续期、追加幂等性、搜索投影或 Native 导入。创建对应 R7 表不会启用这些行为。
- schema 检查验证表清单、列类型/可空性/排序规则/生成表达式/默认值/extra、外键、精确显式索引及 InnoDB 自动支持索引、保留运算分组的 CHECK 表达式及 ngram 解析器。注释和当前 AUTO_INCREMENT 计数不属于身份字段；迁移校验和标识每份内置 SQL 资源，而不是在线 schema 转储。
- TLS 信任与证书身份仍需要在目标环境验证。所属 TLS 场景覆盖一个经过核对的 MySQL 8.4 实例，包括通过字面 IP 拨号并验证显式 DNS/CN 身份；直接 IP SAN 验证、证书轮换和客户端证书仍不在覆盖范围内。
- 丢失 COMMIT 确认后的恢复由调用方适配器负责，仍需在其目标环境完成验证。回调必须自行约束取消后的外部操作。
- 这是可信 Host SQL API，结果大小由调用方限制。它不提供租户授权、SQL 防火墙、进程网络隔离、备份策略或自动 schema 升级。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
