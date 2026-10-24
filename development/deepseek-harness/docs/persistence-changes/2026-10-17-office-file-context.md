---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-17-office-file-context

English | [中文](2026-10-17-office-file-context.zh.md)

## Summary

Adds attributed office-files snapshots to submitted native prompt contexts, retaining reviewed employee, role, request, file-version metadata and descriptive sections. File contents arrive separately through logged authorized tool results.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-17-office-file-context
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-17-prepared-prompt-context"
    after: "374a27d42b0d7bea4c81cf052bd5a9e20564ac7c18f47a535cccc52e7ec97915"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-17-prepared-prompt-context"
    after: "a1ba6d250d10dc24969ed8e859cabf36dd256ceaa7cf3398d9d51e4da86af5a8"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-17-prepared-prompt-context"
    after: "35380d799fac6e9840efc90a1703a46deb0f3251b675e1ac9215b2831df45afd"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-17-prepared-prompt-context"
    after: "20f189eaa6f7952396d5ce4b11fe4a6a0b61d35ce9f3a25a889a19d2f361d4b4"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing source kinds, event fields and office domain schemas remain unchanged. The added source is descriptive attribution with snapshot text and sections, not a new execution instruction or permission. Original readers retain its complete payload; readers without the optional producer need not interpret its capture to replay text. New readers accept the original source variants. The original and current scanners fully consumed the same actual new 24-event v4 file conversation with equal decoded events. A v4 fixture emitted by the original writer was read original/current/original without changing its bytes. The writer version remains unchanged; this is an explicit same-version compatibility decision, not a claim of human review. Direct v3 decoding still refuses through the existing version policy; adjacent migration remains its original separate path.

<a id="verification"></a>
## Verification

Employee Host tests: 28 passed, including metadata snapshot, identity/role replacement, cancellation and absent legacy capability. Native file browser tests: 8 passed for real text, approval, ACL revocation, changed role, unload, exact Agent scope and stopping a late read. GUI/office regression: 644 files, 10704 passed and 1 pre-existing skip. Six-file native regression: 66 passed and 1 evidence-export failure; reading the existing Zstandard encoding fixed that case and its targeted rerun passed. .artifacts/enterprise-office/round81-reader-compat.mjs verified full-byte consumption of the original-writer 2-event fixture and actual submitted 24-event log with both original and current readers. No original native goldens were rewritten.

<a id="dev-note"></a>
## Dev Note

None.
