---
description: "Select an explicit MySQL Session store, retain native history and fenced writer handles, and inspect recovery limits."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-mysql

English | [中文](README.zh.md)

## Summary

Persist complete native Session history in an explicitly chosen R7 MySQL namespace, then resume through the existing Agent lifecycle. Preserve original Session ids, headers, plugin records, surface changes and compact Assistant streams. Single-writer leases and durable batch receipts protect append ordering across Hosts. This optional provider leaves the default JSONL selection and historical files untouched. The [explicit-profile guide](../../../docs/user/guide/mysql-sessions.md) covers CLI and SDK entry points and their installation limits.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider only in an explicit composition that already supplies the [MySQL connection service](../../storage/mysql/README.md), its credential provider and a reviewed R7 schema. An administrator must provision the selected `dsh_stores.store_key`; a missing namespace fails activation instead of creating an ambient store.

```yaml
- name: '@deepseek-ai/dsh-session-persistence-mysql'
  config:
    storeKey: reviewed-private-store
```

| Choice | Behavior |
|---|---|
| `storeKey` | Required existing namespace; every query includes its internal store id |
| `leaseTtlMs` / `heartbeatIntervalMs` | Database-clock ownership; heartbeat interval must be less than half the TTL |
| `batchDelayMs` | Maximum intentional live-event batching delay; explicit flush drains immediately |
| `readPageSize` | Bounds each SQL seq-range page; the public read still returns its requested complete slice |

The [configuration catalog](../../../docs/config-catalog.md) owns all accepted fields and defaults. A base-backed profile identifies its JSONL row as `session-persistence-jsonl`; `sdk-minimal` uses `sessions` and does not supply managed credentials. These require separate explicit overlays. This package has no profile layer, launcher or automatic backend switch.

### Handles and recovery

`create` reserves a new lifecycle and lease but keeps the Session unpublished. Its creating instance can observe it; another Host cannot. Closing without append or flush leaves no published Session and allows the same id to be created again. A seed's exact inherited cut travels beside its immutable header, and the complete inherited prefix must be appended before a seeded Session can publish. Explicit flush can publish an empty unseeded Session.

`open(read)` fixes the original lifecycle and format, including when the external id is later reused. `open(write)` claims the database lease and validates the committed prefix before returning. Native `SessionAlreadyExistsError`, `SessionAlreadyOwnedError`, `SessionReadOnlyError`, `SessionHandleClosedError`, `SessionOwnershipLostError`, format refusals and corruption errors remain distinguishable. A lost or failed renewal permanently fences that handle; close it and reopen rather than silently acquiring a new owner.

Host consumers can inspect `mysqlStoreKey` and use `ownsMysqlWriter` to match an exact local writer, including an unpublished creator. Flush before entering a store-locking transaction, then verify the database lease and match the owner synchronously. This capability does not authorize employees or freeze other Hosts. Permanently rejected live routing reports once per handle.

Nonempty appends keep one frozen batch id, event text and SHA-256 until the outcome is resolved. Events, source edges, log revision, receipt and the search-job watermark commit together. An unknown COMMIT first checks the durable receipt; an absent or unavailable receipt preserves uncertainty and the same pending batch. It never authorizes repeating an external tool action. Empty append creates no receipt. `flush` drains admitted work, and `close` drains before conditionally releasing only its owner and fence.

Provider, connection and concurrent root unload fence new admissions and external appends, stop the exact Native producers bound to their write handles, and retain event routing and consumer SQL until accepted queues drain and leases release. Late assistant, step and turn closing events use the ordinary event route. The same retirement is joined by racing disposals; an ordinary handle close does not invoke the producer callback. No Session snapshot is written as a shutdown substitute.

Producer and storage failures remain rejections of the consumer scope and owned Agent disposal. Cordis retains its existing `logger.error` containment of failed fiber disposers, so root `dispose()` can resolve after logging a drain failure. Applications must observe that log; a resolved root disposal alone does not certify successful persistence.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service owns its handle registry and native event routes. Each write handle owns one mutation chain, a heartbeat and the uncertain batch preparation. Failed live writes pause automatic scheduling; an explicit flush retries the retained batch before collecting new events. A completed or failed rollback returns native Session error identity through a private transaction refusal only when rollback was acknowledged; connection uncertainty takes precedence.

Transactions lock slot, lease and log in that order. Ownership uses random owner/lifecycle bytes, an exact monotonic fence and database UTC. Original external id text is checked after a hash lookup. Committed event text remains in `event_json`; columns and source edges are derived from it. Reads capture one header and event-count prefix, page by seq, validate native records and return detached values. `stat/list` use metadata and omit physical file size. Lease renewal does not change the log revision.

The shared typed-append behavior permits an unknown required event to be stored, while later reads and write opens refuse to interpret it. Ignorable plugin records remain intact. Normal native prefixes pass the installed format catalog; SQL CHECKs are only the structural minimum. Historical JSONL migration stays with its current provider and the separate import work; this provider does not replace or rewrite old files.

Mutations lock store before slot, lease and log to share a consistent order with Workspace and projections. A conflicting receipt permanently freezes its handle; a missing receipt retains the original batch until explicit recovery. `observeMysqlSessionCut` provides an exact, bounded transaction-local lifecycle/format/revision/count and complete validated prefix for consumers. It does not provide a maintenance freeze across transactions.

### Source map

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis service, local pending visibility and native event routing |
| [`src/handle.ts`](src/handle.ts) | Mutation queue, fixed batch, heartbeat and close |
| [`src/repository.ts`](src/repository.ts) | R7 locks, leases, fixed-generation reads, receipts and atomic writes |
| [`src/records.ts`](src/records.ts) | Lossless preparations and installed Session validation |
| [`src/transaction.ts`](src/transaction.ts) | Session error identity after confirmed rollback |

The explicit [provider acceptance](tests/mysql.acceptance.ts) requires the public descriptor for the already provisioned isolated instance. It creates a unique store, uses actual Loader/Native Agent services and reads committed events through an independent observer. Only model inference and explicit acknowledgement faults are controlled. Its module map selects real source plugins, so this does not establish packaged CLI/SDK module resolution or wire-level COMMIT fault coverage. It never initializes schema or clears existing tables.

The separate [shutdown acceptance](tests/mysql-shutdown.acceptance.ts) uses the same explicitly identified database with a new store and `schemaMode: verify`. It compares the complete Native event sequence after concurrent root disposal in both mount orders and after independent provider or connection unload. A controlled producer holds cancellation open to verify that close waits; another case retains a failed scope, completes a sibling consumer and observes Cordis's actual error buffer. Schema receipts remain unchanged. Its [dedicated configuration](vitest.mysql-shutdown.config.ts) does not select the earlier acceptance suites.

The [wire-COMMIT acceptance](tests/mysql-wire-commit.acceptance.ts) uses a fresh store and a loopback TCP proxy. An independent read-only observer verifies two committed events and the original batch receipt while the proxy holds a genuine COMMIT OK. The proxy then drops that OK and connection. The original append resolves after receipt readback on a new connection; packet counters confirm no repeated event or receipt INSERT. This covers one lost acknowledgement with a reachable matching receipt. Schema receipts remain unchanged.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session persistence](../../../docs/subsystems/persistence.md) — the unchanged service and handle semantics.
- [MySQL connections](../../storage/mysql/README.md) — endpoint, credential, TLS and schema requirements.
- [Session format status](../../../docs/session-format-status.md) — current writer and released generations.
- [Recorded-session testing](../../test-support/session-snapshot/README.md) — raw-byte collection and an explicit persistence observer.

-----

<a id="model-experience"></a>
## Model Experience

### Restored history

#### What the model sees

The model receives restored `user` and `assistant` messages through the Native Agent. This provider adds no prompt, tool or model schema; the loop owns crash-repair records and the subsequent model request.

#### Token effect

Ordinary persistence adds zero model tokens. Resume retains the original history cost through the consuming Agent.

#### KV Cache effect

Persistence does not rewrite earlier request prefixes. Provider cache reuse still depends on the restored history and the current request envelope.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These integration gaps prevent treating this optional slice as a completed storage switch.

- Custom live producers must bind their own quiescence through the optional write-handle hook; only the current Native Agent consumer is integrated. A callback that never settles prevents graceful unload, and a hard process kill cannot drain memory.
- Real MySQL 8.4 cases cover lost COMMIT OK, temporarily unavailable readback, a disconnect before COMMIT reaches the server, and a conflicting receipt. Missing-receipt recovery reuses the identical FrozenBatch; a conflict freezes further writes while close releases the original lease. Server restart and failed heartbeat remain separate fault-coverage work. Durable receipts constrain log append only and do not provide exactly-once external tools.
- A separate real MySQL 8.4 acceptance force-terminates only its own built ACP producer while a second Native turn is open. Competing write handles are refused both while the producer lives and after its exit until the database-clock lease expires naturally. A fresh profile then resumes the same Session with a higher fence, preserves the complete committed prefix and receipts, appends the ordinary interrupted-step/turn closures and completes a new turn. The case never rewrites lease timestamps or restarts the database; it does not cover a failed heartbeat or a MySQL server restart. See the [owned-process crash acceptance](tests/mysql-process-crash.acceptance.ts).
- The shared snapshot harvester accepts a separately owned `SessionPersistence` observer through `RunOptions.sessionPersistence` or `Scenario.sessionPersistence`. A dedicated built-CLI MySQL corpus covers all seven durable wait operations and final parent/spawn-child artifacts, comparing complete events with an independent read-only provider and SQL. Existing JSONL corpus profiles do not automatically mount an observer or select this backend; that dedicated corpus does not certify the entire historical corpus. See the [harness owner](../../test-support/session-snapshot/README.md).
- The [explicit CLI/SDK overlays](../../../docs/user/guide/mysql-sessions.md) require approved matching plugin artifacts and an operator-supplied patch; npm installation, Python wheels and single-file executables remain unverified. Existing-store import, immutable database generation migration and MySQL search remain separate consumers. Optional [Workspace](../../workspace/workspace-mysql/README.md) and [projection](../session-projection-mysql/README.md) providers use the same schema. This provider writes the current generation and refuses a different current pointer.
- utf8mb4 cannot retain lone UTF-16 surrogates supported by JSONL path encoding. This provider rejects them without replacement; a reviewed reversible representation is needed for complete arbitrary-id compatibility. R7 also bounds event times to non-negative safe integers.
- Full-prefix validation on each append and full-prefix validation before a sliced read are conservative and can be costly for long logs. Database durability additionally depends on the deployment's InnoDB and replication settings.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
