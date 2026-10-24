---
kind: upgrade-guide
description: "Work priority edits add an office notification and audit kind that older readers reject."
---

# Upgrade office readers before changing work priority

English | [中文](guide.zh.md)

## Change

Tasks and to-dos may retain an optional priority. Existing items without a value remain normal. A priority change stores `work_prioritized` notification and audit records in `enterprise_office`; older readers explicitly reject this discriminator. Current readers accept existing records. Domain version 1 and Native Session formats remain unchanged.

## Migration

1. Stop employee Hosts and the central gateway sharing the office backend. Back up the backend, including `storage-json.root` when using JSON.
2. Upgrade employee Hosts and the central gateway together before selecting a work priority. Keep the existing storage configuration and data directory.
3. Open an existing task or to-do, change its priority, and confirm its identity, deadline, assignment, status and action history remain. Check the other participant's notification. Existing `updateWork` calls omitting priority preserve it; explicitly choosing normal clears a stored non-normal value.
4. Downgrade only by restoring the matching pre-upgrade office-store backup. Keep Native Session directories intact; later office changes are unavailable in that backup.
