---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-17-office-file-context

[English](2026-10-17-office-file-context.md) | 中文

## 概述

为原生提交准备上下文增加归属为 office-files 的快照，保留审核员工、角色、请求、文件版本元数据和描述区段。文件正文通过单独授权并记录日志的工具结果进入上下文。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-17-office-file-context
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-17-prepared-prompt-context"
    after: "374a27d42b0d7bea4c81cf052bd5a9e20564ac7c18f47a535cccc52e7ec97915"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-17-prepared-prompt-context"
    after: "a1ba6d250d10dc24969ed8e859cabf36dd256ceaa7cf3398d9d51e4da86af5a8"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-17-prepared-prompt-context"
    after: "35380d799fac6e9840efc90a1703a46deb0f3251b675e1ac9215b2831df45afd"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-17-prepared-prompt-context"
    after: "20f189eaa6f7952396d5ce4b11fe4a6a0b61d35ce9f3a25a889a19d2f361d4b4"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有来源种类、事件字段和办公领域 schema 保持不变。新增来源是包含快照文字及区段的描述归属，不是新的执行指令或权限。原读取器完整保留其载荷，未安装可选生产者的读取器不必解释捕获即可回放文字，新读取器继续接受原来源。原读取器与当前读取器完整消费同一份真实新建的 24 事件 v4 文件会话，解码事件相等。由原写入器生成的 v4 样本经过原／当前／原读取，字节保持一致。写入版本保持不变，这是明确的同版本兼容决定，不代表已由人工审核。直接 v3 解码仍按已有版本策略拒绝，相邻迁移继续使用原有独立入口。

<a id="verification"></a>
## 验证

员工 Host 测试 28 项通过，覆盖元数据快照、身份／角色替换、取消和旧服务能力缺省。原生文件浏览器 8 项通过，覆盖真实正文、审批、ACL 撤权、角色改变、卸载、准确 Agent 作用域和停止迟到读取。GUI／办公回归 644 文件、10704 项通过及 1 项原有跳过。六文件原生回归 66 通过、1 项证据导出失败；按已有 Zstandard 编码读取后该项定向复验通过。.artifacts/enterprise-office/round81-reader-compat.mjs 验证原写入器生成的 2 事件样本及真实提交的 24 事件日志均由原和当前读取器完整消费。未改写原生界面预期。

<a id="dev-note"></a>
## 开发备注

无。
