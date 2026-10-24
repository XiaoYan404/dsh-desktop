---
kind: upgrade-guide
description: "Legacy child histories with an exact retained parent catalog now retain their original employee restriction."
---

# Preserve parent catalogs when restoring legacy office children

English | [中文](guide.zh.md)

## Change

An older subagent child may have no `office/run-inherited` record. When its retained parent has one exact local catalog entry matching that child's id and creation time, employee Hosts derive the original office affiliation from records preceding that entry. Later parent role reviews cannot authorize the child. Reads apply this restriction without activating Agents or writing logs. Execution recovery records the existing inheritance event before continuing; current employee and role checks remain required.

Original Native children remain Native when an exact catalog proves their creation scope, or when the complete retained parent chain contains no office claim at any time. Missing parents or an attributed parent without a matching catalog cannot reconstruct ownership. Employee Hosts hide these unresolved children and return not-found on direct projection reads; the office runtime refuses continuation before model/tool work and asks for the original parent/catalog backup. A current login cannot claim the missing history. No Session format or original record is rewritten.

The Host rebuilds older ownership checkpoints at cache state version 3. A required child inheritance record and a first pending role have separate markers, so an unclaimed queued review cannot replace the original creation role. Explicitly claimed same-employee child reviews remain effective; contradictory employees remain restricted.

## Migration

1. Back up parent and child Session directories together, preserving every committed generation and parent catalog.
2. Upgrade the employee Host and its office tool plugin together. The existing Session query service supplies asynchronous parent reads.
3. Restore an attributed legacy child under its original employee and role. Check that a different employee or changed role cannot read private history or drive model/tool work. Verify an unassociated Native child still runs.
4. If a legacy child disappears or reports that its affiliation cannot be verified, restore missing parent/catalog data from its original backup rather than assigning the current login. Confirm the same original employee can read and continue the child after evidence is available. Keep original Session records when rolling back; they retain their existing format.
