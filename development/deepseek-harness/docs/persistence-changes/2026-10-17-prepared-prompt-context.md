---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-17-prepared-prompt-context

English | [中文](2026-10-17-prepared-prompt-context.zh.md)

## Summary

Adds optional Host-prepared context to native RPC user-source metadata and descriptive office attribution to independently logged context messages.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-17-prepared-prompt-context
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-05-working-directory-attribution"
    after: "0c45a02adaacd80e1d6dc65efd214cf591eaa95435ddeabfbe65ff4e917bff45"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "8633d7791507c80a2c19ca844c01ee36f8bd1448cc3c8e2f571af6230de3310e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "15301e2b35c7d8c68b1355e4fcf25d037c03afe0d0a3ca713fc86a2828b689c4"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "ea7987b744193f8dcb1a01d9c5c1ddc0bbdfa614b7ebcd0078586a342ae190b0"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records omit preparedContexts and retain their previous interpretation. The current backend and Session restore read an original baseline-created 47-event log unchanged. The original repository baseline and current JSONL backends both read the same actual 20-event office submission, preserve all metadata and derive its office message without the producer; bytes remain unchanged. Office attribution is dispensable metadata and grants no validation, replay or execution authority. Older Hosts preserve pending preparation metadata but do not materialize it: recorded context remains model-visible, while preparation of pending new submissions is a current-Host feature. No generic Agent delivery parameter, required message field, event discriminator or header version changes. Ordinary prompts omit the optional field entirely.

<a id="verification"></a>
## Verification

45 native command/authenticated Host checks passed; 9 real Tools/association browser cases passed, including actual model-request context, native skill instructions, attachment bytes, an association change after capture and Trajectory reload. GUI/office: 633 files, 10469 passed, one retained skip. Host/Client typechecks and artifact build passed. .artifacts/enterprise-office/prepared-context-compat.mjs exercised both JSONL readers and original baseline log restoration; enterprise-round56-context-compat-report.json records byte preservation. Full native API suite also exposed the already known Windows file-symlink EPERM; it is not reported as passing.

<a id="dev-note"></a>
## Dev Note

None.
