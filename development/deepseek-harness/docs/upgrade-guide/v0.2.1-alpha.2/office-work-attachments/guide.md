---
kind: upgrade-guide
description: "Reviewed work attachments require compatible office readers and current Drive permissions."
---

# Upgrade office readers before linking work attachments

English | [中文](guide.zh.md)

## Change

Tasks and to-dos retain up to 20 reviewed Drive file versions. Linking does not copy bytes or grant file access. Inaccessible or changed versions disclose no file name through the attachment view. Attachment edits invalidate pending task deliveries; submission and confirmation require access to each reviewed current file version. Return remains available to request corrections. Changes commit `work_attachments_updated` notifications and audit records so older office readers reject unsupported records. Existing work without attachments and Native Session formats retain their behavior.

## Migration

1. Stop employee Hosts and the central gateway sharing the office backend. Back up the backend, including `storage-json.root` for JSON deployments.
2. Upgrade Hosts and gateway together while keeping data directories and storage configuration.
3. Link a Drive file to an open task or to-do. Verify file permissions separately; share through Drive before asking another employee to submit or confirm delivery. After replacing a file version, explicitly reselect it and resubmit delivery.
4. Downgrade only by restoring the matching pre-upgrade office-store backup. Keep Native Session directories intact.
