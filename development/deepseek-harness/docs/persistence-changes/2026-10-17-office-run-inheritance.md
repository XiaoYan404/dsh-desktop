---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-17-office-run-inheritance

English | [中文](2026-10-17-office-run-inheritance.zh.md)

## Summary

Adds the required office/run-inherited event to retain a delegated Agent's employee, role, parent identity and restriction flags after its parent exits. The Host-only office ownership projection uses cache state version 2 and validates the stored payload before applying it. The record is not model-visible and grants no execution authority.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-17-office-run-inheritance
baseline: false
changes:
  - root: "event:office/run-inherited"
    previous: null
    after: "846772335305d5c2e761aa9d38ea193ed854b2f411fcc596878f2e6ffc283d7a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing event schemas, original log prefixes and the Session writer version remain unchanged. Current physical decoding and logical stored-event validation accept an original-writer two-event log and an actual earlier 24-event office file conversation. The original physical scanner retains the new child record, but its authoritative validateStoredEvents admission rejects it with SessionFormatUnsupportedError because office/run-inherited is unknown and not marked ignorable. Current decoding and admission fully consume the actual new 19-event child logs. This existing event discriminator safely prevents older readers from silently losing the restriction, supporting an explicit same-version decision. Descendants created before any attribution was recorded cannot reconstruct an absent parent's identity. Current office authentication and authorization remain independently required.

<a id="verification"></a>
## Verification

39 tool-package tests pass. Both actual parent-disposal and child cold-resume cases pass: unchanged authority continues, changed role makes no further model request. They assert one non-surface, non-ignorable inheritance record, exact original event prefixes and unchanged compressed-byte prefixes. Host/CLI/Desktop build, Host noEmit and focused typed lint pass. .artifacts/enterprise-office/round88-reader-compat.mjs verifies complete physical consumption, actual logical admission or refusal and unchanged source bytes for the original two-event log, earlier 24-event conversation and four actual 19-event child logs. The local comparison report records the original reader's exact refusal and each SHA-256.

<a id="dev-note"></a>
## Dev Note

None.
