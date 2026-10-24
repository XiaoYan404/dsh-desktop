---
kind: upgrade-guide
description: "Task decisions add office notification and audit kinds that older readers reject."
---

# Upgrade office readers before accepting or transferring tasks

English | [中文](guide.zh.md)

## Change

Accepting, rejecting or transferring a task stores its action history and new `task_accepted`, `task_rejected` or `task_transferred` notification and audit kinds in the `enterprise_office` domain. Older office readers reject these kinds. The current reader accepts existing office records; domain version 1 remains safe because old readers explicitly refuse the added discriminators. Native Session logs keep their existing format.

## Migration

1. Stop employee Hosts and the central gateway sharing the office backend. Back up that backend, including `storage-json.root` when using JSON.
2. Upgrade the employee Hosts and central gateway together before calling `decideTask` or using task decision buttons. Keep the existing storage configuration and data directory.
3. Open an existing task, accept or transfer it, and confirm its identity is retained, its action history names the operator and affected owners, and the recipient receives a notification.
4. Downgrade only by restoring the matching pre-upgrade office-store backup. Keep Native Session directories intact; changes after that backup are unavailable in the older office store.
