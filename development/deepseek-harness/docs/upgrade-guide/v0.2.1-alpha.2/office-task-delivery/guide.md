---
kind: upgrade-guide
description: "Task delivery review adds office history, notification and audit kinds that older readers reject."
---

# Upgrade office readers before submitting task deliveries

English | [中文](guide.zh.md)

## Change

[Work archive and recycle-bin operations](../office-work-lifecycle/guide.md) suspend active delivery actions. Restoring preserves history but requires a new submission because the item revision changed.

When work has [reviewed Drive attachments](../office-work-attachments/guide.md), both submission and confirmation require current access to those current versions. Attachment edits invalidate pending submission; return remains available to request corrected files or permissions.

An in-progress task's assignee can submit a delivery with an explanation. Its creator or an administrator confirms or returns the current unchanged submission, also with an explanation. Confirmation completes the task. Any intervening item revision invalidates a submission, requiring resubmission. After a task enters delivery review, ordinary `setStatus` cannot complete it; confirmation through `reviewTaskDelivery` is required. Tasks without delivery history retain their existing status controls. New delivery history, `delivery_submitted`, `delivery_accepted` and `delivery_returned` notifications and audits cause older office readers to reject the records. Current readers accept existing work. Office domain version 1 and Native Session formats remain unchanged.

## Migration

1. Stop employee Hosts and the central gateway sharing the office backend. Back up the backend, including `storage-json.root` for JSON deployments.
2. Upgrade employee Hosts and the gateway together before submitting deliveries. Keep existing storage configuration and directories.
3. Accept a task, submit a delivery as its assignee, then return or confirm it as its creator. Verify explanations, notifications and history. Tools completing a task that has delivery history must use the explicit reviewed confirmation operation; changing the ordinary status cannot bypass review.
4. Downgrade only by restoring the matching pre-upgrade office-store backup. Keep Native Session directories intact; later office changes are unavailable in that backup.
