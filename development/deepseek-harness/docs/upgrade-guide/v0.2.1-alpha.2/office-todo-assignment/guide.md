---
kind: upgrade-guide
description: "Reassigning to-dos adds an office notification and audit kind that older readers reject."
---

# Upgrade office readers before reassigning to-dos

English | [中文](guide.zh.md)

## Change

The transfer operation in `decideTask` also reassigns an open to-do. It stores assignment history and `todo_reassigned` notification and audit records in `enterprise_office`. Older office readers reject this kind. The current reader accepts existing data and retains domain version 1 because older enum validators explicitly refuse the added discriminator. Native Session formats remain intact.

## Migration

1. Stop employee Hosts and the central gateway sharing the office backend. Back up that backend, including `storage-json.root` when using JSON.
2. Upgrade employee Hosts and the central gateway together before transferring a to-do. Retain the existing storage configuration and data directory.
3. Transfer an existing to-do to another active member with a reason. Confirm its identity and deadline remain, its status becomes pending, its assignment history is retained and the recipient receives a notification.
4. Downgrade only by restoring the matching pre-upgrade office-store backup. Keep Native Session directories intact; later office changes are unavailable in that backup.
