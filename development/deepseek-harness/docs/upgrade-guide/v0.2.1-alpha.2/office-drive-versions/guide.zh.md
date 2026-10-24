---
kind: upgrade-guide
description: "保存审核式替换或不可撤销清理回执前，先升级办公读取器。"
---

# 替换或清理网盘版本前先升级办公读取器

[English](guide.md) | 中文

## 变更

分块上传可通过 `OfficeDriveUploadDeclaration.target` 指定既有文件的准确标识及审核过的修订号，提交新版本。替换保留逻辑文件、所有权、权限及先前不可变对象。读取历史元数据和下载仍要求当前文件及祖先访问权限。待提交替换字节计入文件所有者额度，其他有权编辑者上传的版本也按此计费。软删除保留目录树及全部版本；只有仍有父目录编辑权的所有者能恢复审核过的记录，并可使用无冲突的新名称。

可选 `target` 字段保存在 `enterprise_office_uploads` 回执中。旧版严格上传读取器会拒绝这些回执，不会把替换误当作新文件。仅版本和软删除字段仍可读取。永久清理为 `enterprise_office_drive` 增加 `purge` 授权／完成记录及 `purge_requested`／`purged` 审计动作；旧版严格网盘读取器会拒绝且不改写单元。授权先于对象删除，授权后不能恢复。清理失败保留待完成回执和额度占用；重启或明确重试会继续既有授权。Native 会话数据及已交付的 Native 文件不变。

## 迁移

1. 停止共用后端的员工 Host 和中央网关。备份全部办公存储单元，包括 `enterprise_office_uploads`、`enterprise_office_drive`，以及 `DSH_HOME/office/drive/v1/objects` 对象目录。
2. 同时升级 Host 和网关，保留存储配置、数据目录及员工通讯录。既有上传不带 `target`，继续受支持。
3. 使用审核过的修订号替换一份测试文件。通过 `driveHistory` 和 `driveVersionInfo` 检查两个版本，确认旧字节完整。经 `changeDriveLifecycle` 删除并恢复文件。对可丢弃的删除文件，审核 `drivePurgePlan`，按准确修订号／摘要确认，再查看 `drivePurgeStatus`；仅完成后释放额度。
4. 回退时仅恢复匹配的升级前办公存储及网盘对象备份。只恢复元数据不能重建已永久删除的字节。保留 Native 会话、工作区及已交付文件目录，不要删除这些目录来处理办公回执不受支持的问题。
