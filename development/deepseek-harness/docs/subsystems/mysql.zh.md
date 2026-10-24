# MySQL

[English](mysql.md) | 中文

MySQL 子系统通过 [`dsh-mysql`](../../packages/storage/mysql/README.zh.md) 提供可选 Host 连接服务 `ctx.mysql`。它使用显式指定的数据库和 Host 凭据引用。它不注册 `ctx.storage` 后端或 Session 持久化提供方；这些调用方保留各自的存储选择。包 README 负责部署前提、配置、初始化和运维恢复说明。

源码：[`MysqlRuntime`](../../packages/storage/mysql/src/index.ts) · [操作类型](../../packages/storage/mysql/src/types.ts) · [失败](../../packages/storage/mysql/src/error.ts) · [R7 迁移](../../packages/storage/mysql/assets/001-r7.sql)。

## 语句结果

`execute(sql, parameters, signal?)` 接受一条使用位置参数的可信 SQL 语句。`MysqlParameter` 支持 null、文本、有限安全数字、布尔值、bigint、字节数组及日期。bigint 以精确十进制文本传输；字节数组和日期会在异步操作使用前复制。SQL 标识符和语法由可信适配器提供，不属于参数。调用方负责限制结果大小，并在领域使用前解码行值。

`MysqlResult` 区分 `rows` 与 `write`。解码前行列为 unknown，BIGINT 与 DECIMAL 值保持为字符串，JSON 保持为序列化文本，日期在 UTC 下保持为 SQL 字符串。写入结果包含受影响行数、字符串插入 ID 及警告数。自动提交成功会在服务器响应后返回；丢失该响应可能使写入结果未知。

## 事务与生命周期

`transaction(work, signal?)` 为 BEGIN、回调语句及 COMMIT 保留一个连接。其 `MysqlExecutor` 会在回调结束或操作取消时失效。回调必须使用该执行器，且不得执行 DDL、事务控制及会话修改。返回成功发生在 COMMIT 确认之后；回调失败且传输仍可用时，会尝试 ROLLBACK 后再拒绝。提供方不会重试回调。

配置的连接数限制约束普通接纳；超量操作以 `capacity` 拒绝。获取连接有单独的截止时间。获取后，操作截止时间覆盖会话设置、回调时间和 COMMIT。取消及超时会使执行器失效并关闭其传输连接。回调负责约束取消后的外部操作。

`registerConsumer(drain)` 返回 `MysqlConsumer`：具有 `MysqlClient` 的 `execute`、`transaction` 操作，以及幂等 `dispose`。注册由调用方的 `ctx.effect` 管理。排空同步禁止新业务，并通过该 SQL 能力等待其确切生产者及已接受队列完成，不得等待自己的释放或连接卸载。作用域释放在待处理操作结束后保留排空与 SQL 失败，随后拒绝更多作用域 SQL。

连接卸载立即拒绝普通 SQL 和新注册、取消普通操作，并在所有调用方排空后才取消传输及关闭连接池。只有已注册且正在排空的作用域可以在操作截止时间内等待连接池容量，普通接纳规则不变，同时保留已接受队列的排空能力。[MySQL Session 持久化](../../packages/session/session-persistence-mysql/README.zh.md)是当前生产环境调用方。Cordis 既有 fiber 错误收容使用 `logger.error` 记录失败的所有者 disposer；即使根释放在记录日志后成功返回，作用域仍保持拒绝。

## Schema 身份

`status()` 返回激活时已验证且与内部状态分离的 `MysqlSchemaStatus`：schema 版本、迁移名称、可执行 SQL SHA-256、表数和外键数。它不含目标地址秘密或业务行。此数据库代际独立于已发布 Session 事件格式。

初始化在数据库范围的建议锁内先执行不可变 R7 v1 资源，再执行 v2 整数 CHECK 迁移，每个校验和仅在结构验证后记录。默认验证只接受包含两条原始回执的最新二十表 schema。显式升级接受完整 v1 前代，并保留其回执和事件文本；未知或部分迁移结构会拒绝激活。[包参考](../../packages/storage/mysql/README.zh.md) 负责迁移选择和恢复说明，其[限制](../../packages/storage/mysql/README.zh.md#known-limitations-and-deferred-work) 定义在线 schema 细节的检查范围。

## 失败归属

`MysqlError` 暴露稳定的 `MysqlErrorCode`、`MysqlCommitOutcome`、可重试提示及可选的脱敏驱动代码。它不保留驱动原始原因、SQL 或参数值。部署及凭据失败会阻止服务激活。schema 不匹配或部分 DDL 会阻止激活，并保留既有数据供检查。

`not-started` 表示操作开始前的接纳或设置失败。`not-committed` 表示 COMMIT 之前的事务内操作。`unknown` 要求重试写入前先查询调用方回执或回读确认，包括丢失 COMMIT 确认的情况；它绝不允许重复外部操作。`not-applicable` 不作事务结果声明。可重试提示不能替代调用方的幂等性判断。

连接提供方负责关闭传输连接和脱敏失败。领域适配器负责验证、语句排序、授权、持久化回执和恢复决策。调用方不得将连接错误转换为持久化成功。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmysql--mysqlruntime"></a>

### `ctx.mysql` — `MysqlRuntime`

Pooled prepared statements and explicit transactions with connection-owned cancellation and no automatic retries.

```ts cordis-catalog
/** Register a producer/queue owner whose accepted SQL must finish before the pool closes.
 * The caller's ctx.effect owns release. Its drain must synchronously fence new business work,
 * settle producers and queues, and must not await this scope's disposal or connection unload.
 * @param drain - Current consumer's idempotent shutdown, using the returned scope for SQL.
 * @returns SQL retained through that drain, plus its memoized disposal; failures remain rejections.
 */
registerConsumer(drain: () => Promise<void>): MysqlConsumer

/**
 * Return the schema identity verified during this plugin activation.
 * @returns A detached public receipt without endpoint secrets or application data.
 */
status(): MysqlSchemaStatus

/**
 * Execute one positional prepared statement; this may be an autocommitted write.
 * @param sql - Static SQL with positional placeholders; callers bound the result size and decode row values.
 * @param values - Data values; BIGINT inputs use bigint or exact text and returned BIGINT/DECIMAL values remain strings.
 * @param signal - Operation cancellation; a cancelled connection is closed and never reused.
 * @returns Rows or acknowledged write metadata. Lost autocommit responses can have an unknown write outcome.
 */
execute(sql: string, values: readonly MysqlParameter[], signal?: AbortSignal): Promise<MysqlResult>

/**
 * Run transactional statements once on one connection; no deadlock or COMMIT retry is implicit.
 * @param work - Callback using only its executor; no DDL, transaction control or session changes.
 * The executor expires at settlement.
 * @param signal - Cancellation closes the connection. Cancellation during COMMIT has an unknown outcome.
 * @returns Callback value after COMMIT acknowledgement; failures roll back before rejection when transport permits it.
 */
transaction<T>(work: (executor: MysqlExecutor) => Promise<T>, signal?: AbortSignal): Promise<T>
```

Source: [`packages/storage/mysql/src/index.ts`](../../packages/storage/mysql/src/index.ts)
<!-- END GENERATED cordis-surface -->
