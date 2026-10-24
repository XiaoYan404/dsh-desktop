---
description: "选择保留精确顺序、带所有权围栏并在确认后发布的 MySQL 工作区后端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-mysql

[English](README.md) | 中文

## 使用本包

先加载现有 MySQL 和 Storage 服务，再显式配置本插件的 `storeKey`、`backendName`、`leaseTtlMs` 和 `heartbeatIntervalMs`，通过 StorageDomain 仅将 `workspace` 路由到该后端。管理员负责预置 store 和 schema；普通启动要求 schema v3 与 `schemaMode: verify`。心跳间隔不得超过租约 TTL 的三分之一。

## 持久化与生命周期

规范表保留原 ID、规范路径、时间、候选账本、显示顺序、归档顺序、置顶和删除后仍保留的首次工作区身份。显式 global 写入位区分从未写入的 `global:null` 与已物化 singleton；仅写记录的 bootstrap 不改变该位。原子创建和删除复用现有 Domain 桥；全部缓存和事件均在 SQL 确认后发布。

所有变更先锁 store 再锁 slot。单个 Registry 租约拒绝其他进程持有冲突的同步缓存；写入检查原 fence 与数据库到期时间，本地保守单调时钟期限在所有权过期后拒绝读取。IO、未知提交或 CAS 失败后，相关缓存冻结直到关闭并重开。首次冻结会报告警告并取消后续心跳。退役先排空 Registry 生产者、Domain 写入和 unit，再释放 SQL；消费方回调不会等待自身 dispose。

变更克隆或纯计划校验在 SQL 前失败时，返回 `StorageMutationValidationError`，`code` 为 `invalid-mutation`、`outcome` 为 `not-started`，原错误保留在 `cause`。Domain、Registry 与已持有 Entity 的缓存保留已确认值，显式排队的修正输入可以继续；所有权检查仍然适用。SQL、租约、CAS 及未知结果仍保留原错误对象并冻结缓存，单凭相同错误 code 不允许恢复。

## 模型体验

### 工作区上下文

本提供方不增加模型提示、工具或 token。模型上下文仍由原工作区消费方决定。JSON/SQLite 路由继续可用。

## 已知限制与后续工作

本后端仅服务 Workspace domain。已有 store 在[结构升级](../../../docs/upgrade-guide/v0.2.1-alpha.2/mysql-workspace-v3/guide.zh.md)时需要显式 global 来源决定和权威归档原序；旧布尔归档集合不能推导顺序。旧 pending mutation 须先由原提供方恢复。会话创建和工作区关联仍是两次原生操作。Registry 租约不构成整个 store 的维护或导出冻结。不能无损表示的 UTF-16 标识明确拒绝，不替换字符。
