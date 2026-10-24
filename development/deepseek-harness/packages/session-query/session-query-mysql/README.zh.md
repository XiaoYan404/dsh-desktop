# @deepseek-ai/dsh-session-query-mysql

[English](README.md) | 中文

[session-query 子系统](../../../docs/subsystems/session-query.zh.md)的显式可选提供方。保留统一精确读取，并复用 `buildSessionEventSearchDocuments` 提取语义文档；不会自动导入本机历史。

## 配置

现有 MySQL 连接必须使用 `schemaMode: verify`，并显式指定已分配的 `storeKey`。必须配置 `pageSize`、`claimTtlMs`、`maxDocumentBytes`、`maxBuildBytes`、`maxDocuments`、`maxCandidates`、`maxCandidateBytes`、`defaultLimit`、`maxLimit`、`snippetChars`；原精确读取配置仍可使用。完整输入或输出超限会失败，不截断数据。

必需的 Host-only `sessionQueryMysqlAccess` 能力负责 flush 已接纳写入、确定实际运行时 live 集合，并返回已认证身份、权限 revision 和允许会话 ID。实现必须覆盖换号、退出及角色／归属撤权，调用原员工可见性策略，并拒绝无法观察的远程写者前缀。缺少能力时无法启用；远端传入的 ID 不授予查询权限。

当前原生持久化必须是使用相同 `storeKey` 的 `MysqlSessionPersistence`。提供方或 namespace 不匹配时，在查询取得 SQL 资源前以 `SESSION_QUERY_INVALID_CONFIG` 拒绝初始化；相同显示名称不能替代真实提供方身份。

每次查询还会在 SQL 事务外排空捕获的提供方，再按 store → 排序后的 slots → leases 锁顺序，使用正式 `ownsMysqlWriter` 证明核验有效数据库租约，包括未发布的创建者。任何外部或不可观察的有效写者都会返回 `ACCESS_UNAVAILABLE`；该保守模式不提供远端 owner flush RPC。`live` 仍只来自原运行时注册表。

## 发布和查询

`rebuildNext()` 按数据库时间领取一个当前任务，调用 Agent 05 的 `observeMysqlSessionCut` 读取完整切面，暂存全部语义文档，再按 store 优先的锁顺序发布。发布复核 lifecycle、格式、log revision、事件数、header、继承切点、状态 CAS 及 claim。staging 不可见；过期或变化的输入不能发布。原日志、代际和追加回执不变。发布 COMMIT 未知时，先按保留的 build 身份和发布时间读回确认。

分析器版本 1 要求 bigram ngram、关闭停用词并与 store 配置一致。包含支持字面 bigram 的查询用自然语言 `MATCH` 召回，再按大小写不敏感、空白灵活的字面语义核验。其他查询（包括单字及 emoji）只在已发布语义正文中扫描，并服从完整结果预算。[MySQL ngram 文档](https://dev.mysql.com/doc/refman/8.4/en/fulltext-search-ngram.html)说明服务端分词规则。

授权和会话／事件／surface／时间过滤先于排序和会话分组。排序依次按字面命中数降序、codepoint 长度升序、事件时间降序、会话 ID 的 UTF-8 字节升序、seq 降序；摘要是有界纯文本。签名游标绑定请求、身份／权限 revision、完整 cut、epoch、工作区 revision 和最后排序元组。输入变化返回 `SESSION_QUERY_STALE_CURSOR`，索引未追平返回 `MysqlSearchError.reason=INDEX_NOT_READY`；计算期间变化也会明确失败。

## Model Experience

不直接注册模型能力；调用方取得原有语义文本和 surface 分类。

#### KV Cache effect

无；本提供方不组装或发送模型请求。

## Known Limitations and Deferred Work

生产员工授权能力、可选 profile 及正式构建由 Agent 08 接入。隔离真实 Loader 数据库场景使用显式测试身份，不能替代生产员工授权验收。构建目前需要显式调用 `rebuildNext()`；生产调度器需另行定义生命周期、可观测失败和重试责任。查询针对主库已提交前缀，索引缺失时拒绝返回不完整结果。本包不变更 schema、不自动迁移历史，也不删除 retired build。
