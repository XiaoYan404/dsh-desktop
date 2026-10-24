---
kind: upgrade-guide
description: "日程编辑新增旧版办公读取器会拒绝的通知及审计类型。"
---

# 编辑日程前升级办公读取器

[English](guide.md) | 中文

## 变更

日程编辑会在 `enterprise_office` 域写入 `schedule_updated` 通知及审计类型。旧办公读取器会拒绝包含这些记录的数据域。当前读取器接受既有办公记录；域版本保持不变，因为旧版严格 schema 会安全拒绝新增判别值。原生 Session 日志及其读取规则保持既有格式。

## 迁移

1. 停止共享办公存储的员工 Host 及中央办公网关。备份 `storage-domain.backend` 选定的后端；使用 JSON 时包含配置的 `storage-json.root` 目录。
2. 调用 `updateSchedule` 或编辑日程前，同时升级员工 Host 与中央网关。保留既有后端配置及数据目录。
3. 打开既有日程，确认标识、参与人和状态仍可读取。修改内容，确认参与人收到日程变更通知。
4. 如需返回旧办公读取器，恢复对应的升级前办公存储备份。备份不包含之后的办公变更；保留原生 Session 目录。
