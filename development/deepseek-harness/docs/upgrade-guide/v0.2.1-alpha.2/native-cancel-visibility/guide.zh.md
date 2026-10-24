---
kind: upgrade-guide
description: Host 插件必须等待 Session Controller 的异步取消结果。
---

# Host 插件等待 Session 取消

[English](guide.md) | 中文

## 变更

`ctx.sessionController.cancel(request)` 返回 `Promise<SessionCancelValue>`，以便 Host 在停止 Agent 前检查当前 Session 可见性。隐藏 Session 返回 `session/not-found`；未挂载的 Session 仍不可用，不会为此恢复。TypeScript 和 Python Remote 客户端继续等待原有取消响应。

## 迁移

1. 查找直接调用 `ctx.sessionController.cancel(request)` 的 Host 代码，在读取 `accepted` 或报告成功前等待返回的 Promise。
2. 通过调用方现有错误处理路径处理拒绝，在确认取消前保留待发送输入。
3. 编译 Host 插件并验证有权取消返回 `{ accepted: true }`，具有办公归属的 Session 在其他员工操作或退出登录后拒绝取消。
