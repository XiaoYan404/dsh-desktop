---
description: "从完整、已验证的会话切面写入有界 MySQL 投影检查点。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-projection-mysql

[English](README.md) | 中文

## 使用本包

加载 MySQL、原生 Session 持久化和 SessionProjectionRegistry，再加载本可选提供方，并在 SessionProjectionCache 显式设置 `checkpointBackend: provider`。默认缓存继续使用既有 Domain。明确配置 `storeKey`、`maxEvents`、`maxInputBytes`、`maxCheckpointBytes`、`maxUnits`、`readPageSize` 和 `maxPendingOperations`；store 必须已存在，schema 激活使用 `verify`。

注入的持久化提供方必须为同一 `storeKey` 提供 MySQL 写入者归属能力；其他提供方或命名空间会在打开投影 SQL 前拒绝激活。已接纳的写入 flush 所绑定的提供方实例。本地 flush 不排空其他 Host 的写入者，投影只折叠所观测的已提交前缀。无效 Session 标识在进入 SQL 队列前拒绝，不冻结其他观测。

## 检查点

提供方在同一事务观测当前生命周期 UUID、格式、精确日志 revision、完整事件数量和经验证前缀，采用先 store 后 slot 的锁序。header 和事件先核对长度再读取内容。检查点先验证头部数量，再读取有界 key 分页和服务器限长 JSON 值。单元状态版本、schema 和重放仍由原生投影定义负责。

整值替换核对原生命周期和精确检查点 CAS，删除省略的 key，并只在 COMMIT 确认后发布。空 rows 也保留完整输入水位。未知结果冻结后续 SQL 直到重开；新提供方读取实际已提交缓存或重建。缓存写入不修改事件和追加回执。

## 模型体验

### 投影状态

本提供方通过现有投影定义折叠已提交事件，不增加提示或工具，也不持久化尚未提交的修复事件。

## 已知限制与后续工作

单独的 SessionHeader 无法证明 MySQL 生命周期 UUID，因此同步列表和 hydrate 返回未缓存状态并重放原生历史。SQL 检查点用于异步提供方的完整验证观测和重建。超过 191 个 Unicode 码点的 key、超过 UINT32 的状态版本、孤立 UTF-16 surrogate 均明确拒绝，不截断或转换；缓存所有者将写入拒绝作为 fail-soft 处理。未知缓存写入没有不可变写回执，不自动重发。本提供方不提供维护或导出冻结。built 和安装器验收由发行整合负责。
