---
kind: upgrade-guide
description: "MySQL schema 核验现在要求 workspace-order-and-lease v3 后继。"
---

# 升级 MySQL 工作区结构

[English](guide.md) | 中文

## 变更

可选 MySQL 提供方要求 schema v3，追加归档序号、显式 Workspace global 写入状态和带 fence 的 Registry 租约。v1/v2 数据库不能通过普通 `schemaMode: verify`。原 001/002 迁移字节、回执、日志和文件提供方均保留。

投影激活还要求使用同一 `storeKey` 的 MySQL Session 持久化提供方，JSONL 或其他命名空间会被拒绝。直接调用 Workspace 工厂时，Context 须同时提供 effect 与 logger，以报告后台缓存失败。

Workspace 变更的纯验证错误现在由 `StorageMutationValidationError`（`code: invalid-mutation`）包装，不再直接返回原错误；原错误保留在 `cause`。只有这一 IO 前拒绝允许修正输入后继续使用已确认缓存；其他后端失败仍保留原错误身份与冻结行为。

## 迁移

1. 备份已核验数据库和原 Workspace 文档。暂停共享该 schema 的所有应用和数据库场景，并排空已接受写入；不同 store namespace 不能隔离 DDL。
2. 为每个既有 store 向 `packages/storage/mysql/src/schema.ts` 的 `prepareMysqlSchema` 提供 `MysqlWorkspaceAdoption` 来源决定：保留原 `global:null`，或显式采用已有规范化 singleton 为已写入。提供权威 `archivedSessionIds` 原顺序；若仅剩无序布尔集合，则拒绝迁移。
3. 通过该审阅升级路径执行打包的 `003-workspace-order-and-lease.sql`。先追加可空列，再按来源校验回填，最后施加约束。部分 DDL、回填或核验失败均不写成功回执；保留现场检查，不自动重放 SQL。
4. 确认 schema 版本 3、脚本校验和、20 张 InnoDB 表和 25 个限制删除外键，以及 v1/v2 回执不变。应用恢复为 `schemaMode: verify`。显式选择新工作区和投影提供方；原 JSONL/JSON/SQLite 默认路由保留。
5. 将 `session-persistence-mysql` 和 `session-projection-mysql` 配置为同一 `storeKey`。向 `createWorkspaceMysqlBackend` 传入包含 logger 的插件 Context。自定义 Host 查询屏障须在事务外先 flush，再在 store 锁内核验有效数据库租约并调用 `ownsMysqlWriter`；本地归属匹配不等于远端 Host 排空或员工授权。
6. 从与提供方相同的 `@deepseek-ai/dsh-storage` 公共出口导入 `StorageMutationValidationError`，通过 `cause` 检查原验证错误，仅在修正输入后显式重试。其他后端失败须关闭／重开并核验；仅匹配 name/code/outcome 不代表安全拒绝。

部署前由发行整合验证 built CLI/SDK 和安装器组合。Workspace 租约不是整个 store 的迁移或导出冻结。
