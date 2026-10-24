---
description: "Employee office plugins for tasks, calendar invitations and notifications, separate from Agent execution state."
kind: "package-group"
---

# packages/enterprise

English | [中文](README.zh.md)

## Summary

Enterprise plugins keep employee work separate from Agent sessions. The office package persists assignments, calendar invitations and employee inboxes through the existing storage domain system. Deployments supply the directory and authenticated employee identities.

## Packages

| Package | Purpose | Service |
| --- | --- | --- |
| [office](office/README.md) | Authorized work, invitations, profiles and notifications | `ctx.office` |
| [office-gateway](office-gateway/README.md) | Central password sign-in and office-only HTTP requests | `ctx.officeGateway` |
| [tool-office](tool-office/README.md) | Captured reminder execution through native approval | Employee office BFF |

## Related documentation

- [Storage subsystem](../../docs/subsystems/storage.md) — durable domains and backend selection.
- [Agent schedule](../../docs/subsystems/schedule.md) — session reminders, independent of employee calendars.

## Dev Note

None.
