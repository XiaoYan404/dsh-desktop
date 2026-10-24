---
kind: upgrade-guide
description: "Work checklists add an office notification and audit kind that older readers reject."
---

# Upgrade office readers before adding work subtasks

English | [中文](guide.zh.md)

## Change

Tasks and to-dos may retain up to 100 checklist entries with server-created identities, titles and completion flags. Entries inherit the parent item's permissions and are not independently delegated work. Checklist changes commit `work_subtasks_updated` notification and audit records, making older office readers explicitly reject these records instead of dropping the new data. Current readers accept existing work without a checklist. Office domain version 1 and Native Session formats remain unchanged.

## Migration

1. Stop employee Hosts and the central gateway sharing the office backend. Back up the backend, including `storage-json.root` for JSON deployments.
2. Upgrade employee Hosts and the gateway together before editing work subtasks. Keep existing storage configuration and data directories.
3. Open a task or to-do and manage its checklist. Confirm adding, renaming, completing and removing entries preserves the parent identity, assignment, deadline, priority and status. Confirm the other participant receives an update notice and that edits survive restart.
4. Downgrade only by restoring the matching pre-upgrade office-store backup. Keep Native Session directories intact; later office changes are unavailable in that backup.
