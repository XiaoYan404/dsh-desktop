---
kind: upgrade-guide
description: "Meeting membership changes add office audit and notification kinds that older readers reject."
---

# Upgrade office readers before changing meeting members

English | [中文](guide.zh.md)

## Change

Organizers and administrators can add or remove invitees on an open meeting using its reviewed revision. The organizer remains a participant. Retained replies survive membership edits; date or time changes reset invitee replies. Added members receive invitations; removed members lose ordinary meeting access and receive a notice containing the previous title. The required `schedule_members_updated` audit kind and `schedule_removed` notification kind make older office readers reject these records. Current readers accept existing data. Office domain version 1 and Native Session formats remain unchanged.

## Migration

1. Stop employee Hosts and the central gateway sharing the office backend. Back up the backend, including `storage-json.root` when using JSON.
2. Upgrade employee Hosts and the gateway together before changing meeting membership. Keep the storage configuration and data directory.
3. Edit an existing meeting, add and remove a member, and verify invitations, removed-member notices and access. Existing `updateSchedule` calls omitting `inviteeIds` preserve membership. Explicitly passing an empty array leaves only the organizer.
4. Downgrade only by restoring the matching pre-upgrade office-store backup. Keep Native Session directories intact; later office changes are unavailable in that backup.
