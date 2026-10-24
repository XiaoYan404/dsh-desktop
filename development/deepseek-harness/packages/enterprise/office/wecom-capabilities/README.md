# WeCom commissioning reference

English | [中文](README.zh.md)

## Summary

The current connector supports mapped-self profile reads and reviewed text-message submission with existing private authentication, token rotation, execution ledger and provider outbox. Configuration inventory never establishes a customer connection. A locally retained message receipt establishes neither remote delivery nor reading, native-task creation, card acknowledgment or completed business action.

## Table of Contents

- [Capability evidence](#capability-evidence)
- [Primary protocol dependency](#primary-protocol-dependency)
- [Customer dependencies](#customer-dependencies)

## Capability evidence

| Capability | Adapter code | Protocol evidence | Real customer request |
| --- | --- | --- | --- |
| DingTalk self todos/calendar and reviewed creation/message | Existing implementation retained | Existing official-protocol/local HTTP/page evidence retained | Credentials and app scopes required |
| WeCom mapped-self profile/text message | Existing implementation retained | Existing protocol/local HTTP/page evidence retained | Credentials and app scopes required |
| WeCom native task | Not advertised | Current primary task API specification required | Not commissioned |
| WeCom interactive card/completion callback | Not advertised | Primary request/callback/signature specification required | Not commissioned |
| OA v1 | Existing implementation retained | Product-owned v1 protocol and retained local evidence | Customer bridge required |
| OA v2 | Separate optional adapter | Product-owned [v2 protocol](../oa-bridge-v2/README.md) and local HTTP/storage/material evidence | Customer bridge required |

The pure [readiness helper](../src/wecom-capabilities.ts) reads nonsecret inventory booleans. Missing app identity, credential reference, employee mapping or approved origin yields `pending_configuration`; complete inventory yields `configured_unverified`. Customer connection stays false. Task/card/callback fields retain their explicit primary-protocol dependencies regardless of those booleans. The helper performs no probe and receives no secret values.

## Primary protocol dependency

Existing implementation references the official [token](https://developer.work.weixin.qq.com/document/path/91039), [member](https://developer.work.weixin.qq.com/document/path/90196), [application message](https://developer.work.weixin.qq.com/document/path/90236) and [error](https://developer.work.weixin.qq.com/document/path/90313) pages. The card investigation also referenced official paths 94872, 94876 and 94888, but did not obtain their current document bodies. The retained [retrieval handoff](../../../../.artifacts/enterprise-office/wecom-card-readonly/handoff.json) records the SPA-only response and HTTP 403 from the official document-reading endpoint; retrieval stopped. No mirrored schema is treated as authority and that failed endpoint is not retried. A current official-domain search produced no usable WeCom card/task body, so this work fixes no unverified vendor schema or signature parser.

The current [DingTalk capability overview](https://open.dingtalk.com/document/orgapp/dingtalk-todo-task-overview) lists native task operations. It is an overview, not a fresh field-by-field validation of existing requests. Existing green suites are not rerun merely to refresh evidence, and a message is never relabeled as a task. No new real customer message is sent by readiness checks.

## Customer dependencies

Provide the actual tenant/application identity and credential references, authorized app scopes and network/TLS policy, and verified distinct employee mappings. Native tasks/cards additionally need current official request/response fields, limits, capability eligibility and authoritative outcome lookup. Completion callbacks need the customer's actual endpoint configuration, signature/encryption protocol, key rotation, replay window, event identity/order, current employee/business authorization and audited transition rules. No button acknowledgment can itself approve a business operation. Unknown original writes stay fenced until authoritative original-result recovery is available.
