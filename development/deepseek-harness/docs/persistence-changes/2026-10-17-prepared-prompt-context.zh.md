---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-17-prepared-prompt-context

[English](2026-10-17-prepared-prompt-context.md) | 中文

## 概述

为原生 RPC 用户来源元数据增加可选的 Host 准备上下文，并为独立记录的上下文消息增加描述性的办公来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-17-prepared-prompt-context
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-05-working-directory-attribution"
    after: "0c45a02adaacd80e1d6dc65efd214cf591eaa95435ddeabfbe65ff4e917bff45"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "8633d7791507c80a2c19ca844c01ee36f8bd1448cc3c8e2f571af6230de3310e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "15301e2b35c7d8c68b1355e4fcf25d037c03afe0d0a3ca713fc86a2828b689c4"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "ea7987b744193f8dcb1a01d9c5c1ddc0bbdfa614b7ebcd0078586a342ae190b0"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录省略 preparedContexts，保持原来的解释方式。当前后端及 Session 恢复能原样读取由原提交创建的 47 事件日志。原提交基线和当前 JSONL 后端均能读取同一份实际的 20 事件办公提交，保留全部元数据，并在没有提供方的情况下推导办公消息；文件字节不变。办公来源是可忽略的描述元数据，不增加校验、回放或执行权限。旧 Host 保留待处理准备元数据，但不会将其物化：已记录上下文仍对模型可见，而新提交的待处理准备属于当前 Host 功能。通用 Agent 投递参数、必需消息字段、事件判别及 header 版本均未改变。普通提示词完全省略该可选字段。

<a id="verification"></a>
## 验证

45 项原生命令／认证 Host 检查通过；9 项真实工具／关联浏览器用例通过，覆盖实际模型请求上下文、原生技能指令、附件字节、捕获后修改关联及轨迹刷新。GUI／办公为 633 文件、10469 项通过、1 项保留跳过。Host／Client 类型及产物构建通过。.artifacts/enterprise-office/prepared-context-compat.mjs 验证两版 JSONL 读取方及原提交日志恢复，enterprise-round56-context-compat-report.json 记录字节保持结果。完整原生 API 套件另暴露已知的 Windows 文件符号链接 EPERM，没有将其记为通过。

<a id="dev-note"></a>
## 开发备注

无。
