---
description: "员工任务、日程邀请与通知插件，与 Agent 执行状态分开保存。"
kind: "package-group"
---

# packages/enterprise

[English](README.md) | 中文

## Summary

企业插件将员工办公事项与 Agent 会话分开。office 包通过现有存储领域持久化任务派发、日程邀请和员工收件箱。部署方提供组织成员和经过认证的员工身份。

## Packages

| 包 | 用途 | 服务 |
| --- | --- | --- |
| [office](office/README.zh.md) | 带授权检查的事项、邀请、资料与通知 | `ctx.office` |
| [office-gateway](office-gateway/README.zh.md) | 集中密码登录及仅限办公业务的 HTTP 请求 | `ctx.officeGateway` |
| [tool-office](tool-office/README.zh.md) | 通过原生审批执行捕获的提醒 | 员工办公 BFF |

## Related documentation

- [存储子系统](../../docs/subsystems/storage.zh.md) — 持久化领域与后端选择。
- [Agent 定时任务](../../docs/subsystems/schedule.zh.md) — 会话提醒，与员工日历相互独立。

## Dev Note

无。
