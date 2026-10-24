---
kind: upgrade-guide
description: "Upgrade office readers before storing reviewed replacements or irreversible cleanup receipts."
---

# Upgrade office readers before replacing or clearing Drive versions

English | [中文](guide.zh.md)

## Change

Resumable uploads can replace an existing file by including `OfficeDriveUploadDeclaration.target` with its exact id and reviewed revision. The replacement keeps the logical file, ownership, permissions and earlier immutable objects. Historical metadata and downloads require current file and ancestor access. Pending replacement bytes consume the file owner's quota, including replacements uploaded by another authorized editor. Soft deletion retains the directory tree and all versions; only the owner with current parent edit access can restore a reviewed record, optionally using a conflict-free name.

The optional `target` is retained in `enterprise_office_uploads` receipts. Older strict upload readers reject such receipts rather than treating a replacement as a new file. Version and soft-deletion fields alone remain readable. Permanent cleanup adds `purge` approval/completion records and `purge_requested`/`purged` audit actions to `enterprise_office_drive`; older strict Drive readers reject them without rewriting the unit. Approval precedes object removal and cannot be restored. Failed cleanup retains a pending receipt and its quota charge; restart or explicit retry completes the existing approval. Native Session data and already delivered Native files are unchanged.

## Migration

1. Stop employee Hosts and the central gateway sharing the backend. Back up all office storage units, including `enterprise_office_uploads` and `enterprise_office_drive`, together with `DSH_HOME/office/drive/v1/objects`.
2. Upgrade Hosts and gateway together, preserving storage configuration, data directories and the employee directory. Existing uploads omit `target` and remain supported.
3. Replace one test file using its reviewed revision. Check both versions through `driveHistory` and `driveVersionInfo`; confirm the old bytes remain intact. Delete and restore the file through `changeDriveLifecycle`. For a disposable deleted file, review `drivePurgePlan`, confirm its exact revision/digest and inspect `drivePurgeStatus`; only completion releases quota.
4. Roll back only with matching pre-upgrade office-store and Drive-object backups. A metadata-only restore cannot recreate permanently removed bytes. Retain Native Session, workspace and delivered-file directories; do not remove them to resolve an unsupported office receipt.
