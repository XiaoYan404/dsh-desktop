---
kind: upgrade-guide
description: "Editing tasks and to-dos adds an office notification and audit kind that older readers reject."
---

# Upgrade office readers before editing work content

English | [中文](guide.zh.md)

## Change

Editing a task or to-do stores `work_updated` notification and audit records in `enterprise_office`. Older office readers reject this kind. The current reader accepts existing records and retains domain version 1 because the older enum validators explicitly refuse the added discriminator. Existing task identities, decision histories and Native Session formats remain intact.

## Migration

1. Stop employee Hosts and the central gateway sharing the office backend. Back up the backend, including `storage-json.root` when using JSON.
2. Upgrade the employee Hosts and central gateway together before calling `updateWork` or editing task/to-do content. Retain the existing storage configuration and data directory.
3. Open an existing task, edit its title or deadline, and confirm its identity, assignee, status and prior decision history remain available. Confirm the other authorized participant receives an update notification.
4. Downgrade only by restoring the corresponding pre-upgrade office-store backup. Keep Native Session directories intact; later office changes are unavailable in that backup.
