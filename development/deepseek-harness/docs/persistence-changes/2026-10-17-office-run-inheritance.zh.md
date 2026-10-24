---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-17-office-run-inheritance

[English](2026-10-17-office-run-inheritance.md) | 中文

## 概述

新增必读事件 office/run-inherited，保存受委派 Agent 的员工、角色、父会话标识和限制标记，使父运行退出后仍可恢复。仅供 Host 使用的办公归属投影采用缓存状态版本 2，在应用记录前校验存储载荷。记录不进入模型上下文，也不授予执行权限。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-17-office-run-inheritance
baseline: false
changes:
  - root: "event:office/run-inherited"
    previous: null
    after: "846772335305d5c2e761aa9d38ea193ed854b2f411fcc596878f2e6ffc283d7a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

原有事件类型、原始日志前缀和 Session 写入版本保持不变。当前物理解码及存储事件逻辑校验可接受原写入器的两个事件日志，以及此前真实的 24 事件办公文件会话。原物理扫描器保留新的子运行记录，但其实际 validateStoredEvents 准入因不认识且未标记为可忽略的 office/run-inherited 而抛出 SessionFormatUnsupportedError。当前解码和准入完整消费真实的新 19 事件子会话日志。现有事件判别可阻止旧读取器静默丢失限制，因此明确采用同版本兼容决策。没有保存过归属的历史后代无法重建已缺失父运行的身份。当前办公身份认证及授权仍须独立通过。

<a id="verification"></a>
## 验证

工具包 39 项测试通过。真实父运行销毁及子运行冷恢复的两个场景均通过：权限未变可继续，角色变化不再发起模型请求。用例断言只有一条非模型展示、不可忽略的继承记录，原事件前缀准确保留，原压缩字节前缀不改。Host／CLI／桌面构建、Host noEmit 及定向类型 lint 通过。.artifacts/enterprise-office/round88-reader-compat.mjs 对原两个事件日志、此前 24 事件会话及四份真实 19 事件子会话日志，检查完整物理消费、实际逻辑准入或拒绝及源字节不变。本地对照报告记录原读取器的准确拒绝信息和各份 SHA-256。

<a id="dev-note"></a>
## 开发备注

无。
