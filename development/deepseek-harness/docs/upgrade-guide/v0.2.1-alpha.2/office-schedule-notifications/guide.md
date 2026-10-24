---
kind: upgrade-guide
description: "Meeting edits add notification and audit kinds that older office readers reject."
---

# Upgrade office readers before editing meetings

English | [中文](guide.zh.md)

## Change

Meeting edits store `schedule_updated` notification and audit kinds in the `enterprise_office` domain. Older office readers reject a domain containing these records. The current reader accepts existing office records; the domain keeps its version because older strict schemas safely refuse the added discriminators. Native Session logs and their reader rules retain their existing format.

## Migration

1. Stop employee Hosts and the central office gateway that share the office store. Back up the backend selected by `storage-domain.backend`, including the configured `storage-json.root` directory when using JSON.
2. Upgrade the employee Hosts and central gateway together before calling `updateSchedule` or editing a meeting. Keep the existing backend configuration and data directory.
3. Open an existing meeting and confirm its identity, participants and status remain available. Edit its content and confirm participants receive a meeting-change notification.
4. To return to an older office reader, restore the corresponding pre-upgrade office-store backup. New office changes are unavailable in that backup; keep Native Session directories intact.
