---
kind: upgrade-guide
description: "Work archive, recycle-bin deletion and restoration require compatible office readers."
---

# Upgrade office readers before archiving or deleting work

English | [中文](guide.zh.md)

## Change

Task and to-do creators or administrators can confirm archive, recycle-bin deletion and restoration with an explanation and reviewed revision. Inactive items leave daily work, calendar counts and active item operations. Authorized employees retain read-only records in Archive or Recycle bin; restoration preserves identities, assignment, deadlines, subtasks, attachments and business history. No Native Session or Drive file is deleted. Lifecycle changes invalidate pending delivery submissions and atomically retain action history, notifications and audit. New `work_archived`, `work_deleted` and `work_restored` records make older office readers reject unsupported data instead of silently showing inactive work as active.

## Migration

1. Stop employee Hosts and the central gateway sharing the office backend. Back up the backend, including `storage-json.root` for JSON deployments.
2. Upgrade Hosts and gateway together, keeping storage configuration and data directories.
3. Confirm a task archive and a to-do deletion. Check daily views, Archive and Recycle bin as both participants. Restore the records and confirm their content and audit history remain available.
4. Downgrade only by restoring the matching pre-upgrade office-store backup. Keep Native Session and Drive object directories intact.
