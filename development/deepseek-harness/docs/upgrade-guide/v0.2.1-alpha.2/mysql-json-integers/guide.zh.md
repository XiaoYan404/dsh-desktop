---
kind: upgrade-guide
description: "MySQL 启动现在要求 schema v2，因此既有 R7 v1 数据库需要显式、经审阅的升级。"
---

# 升级 MySQL JSON 整数检查

[English](guide.md) | 中文

## 变更

可选 `dsh-mysql` 提供方现在要求 schema v2。MySQL 8.4 将真实毫秒时间戳归类为 `UNSIGNED INTEGER`；原 R7 v1 CHECK 只接受 `INTEGER`，会拒绝正常原生 Session 写入。追加的 v2 迁移仅扩展 `ck_log_header` 和 `ck_event_json` 中的四处 JSON 整数判断。既有字段存在性、安全整数边界及派生列相等检查继续强制执行。原生 JSONL、Session 事件文本、ID 和 header 均无需转换。

默认 `schemaMode: verify` 拒绝 v1，不作修改。`initialize` 仅对空数据库依次应用两份内置迁移。显式 `upgrade` 只接受完整、且原校验和匹配的 v1 数据库；未知、部分迁移或已是最新版本的目标均被拒绝。原迁移文件和 v1 回执保持不可变。

## 迁移

1. 备份所选数据库，停止写入该库的调用方。核对[连接前提](../../../../packages/storage/mysql/README.zh.md)及 [v2 SQL](../../../../packages/storage/mysql/assets/002-json-safe-integers.sql)，包括所需 `ALTER` 权限。保留原地址和凭据引用，不选择未经核对的数据库。
2. 通过既有 `dsh` profile 补丁，将现有 `@deepseek-ai/dsh-mysql` 行设为 `schemaMode: upgrade`，然后启动该显式组合。提供方在数据库建议锁内验证完整 v1 结构，执行两条 ALTER，并仅在完整验证后插入独立 v2 校验和回执。它不导入 Session 文件或改写事件文本。
3. 确认 `ctx.mysql.status().version === 2`、`migrationName === 'json-safe-integers'`，且校验和匹配内置 v2 文件。确认两条迁移回执均存在，原 v1 行未变。在下次正常启动前恢复 `schemaMode: verify`；`upgrade` 会明确拒绝已是最新版本的数据库。
4. 若激活报告部分 DDL 或未知校验和，保留数据库及回执，交由操作人员检查。DDL 可能在后续失败前已提交；重复 `initialize` 或 `upgrade` 均不会自动补齐未知或部分迁移状态。
