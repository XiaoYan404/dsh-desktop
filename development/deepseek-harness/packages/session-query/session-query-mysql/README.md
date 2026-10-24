# @deepseek-ai/dsh-session-query-mysql

English | [中文](README.zh.md)

Opt-in provider for the [session-query subsystem](../../../docs/subsystems/session-query.md). It preserves the shared exact reads and extracts search documents with `buildSessionEventSearchDocuments`; it does not import local history.

## Configuration

The existing MySQL connection must use `schemaMode: verify` and an explicitly provisioned `storeKey`. `pageSize`, `claimTtlMs`, `maxDocumentBytes`, `maxBuildBytes`, `maxDocuments`, `maxCandidates`, `maxCandidateBytes`, `defaultLimit`, `maxLimit` and `snippetChars` are required deployment limits. Inherited exact-reader settings remain available. Oversized complete input or output fails without truncation.

The required Host-only `sessionQueryMysqlAccess` capability flushes accepted writes, resolves the actual runtime live set and provides authenticated principal, permission revision and allowed session ids. It must cover account changes, logout and role/ownership revocation. Its implementation must call the existing employee visibility policy and reject an unobservable remote writer prefix. Missing capability prevents activation; ids supplied by a remote caller cannot authorize a query.

The active native persistence must be `MysqlSessionPersistence` with the same `storeKey`. A different provider or namespace fails initialization with `SESSION_QUERY_INVALID_CONFIG` before search acquires SQL resources; the provider identity cannot be replaced by a matching display name.

Each search also drains that captured provider outside SQL transactions, then checks active database leases under store → sorted slots → leases locks using its formal `ownsMysqlWriter` proof. Unpublished creators are included. Any foreign or unobservable active writer returns `ACCESS_UNAVAILABLE`; this conservative mode supplies no remote-owner flush RPC. `live` still comes only from the original runtime registry.

## Publication and search

`rebuildNext()` claims one current job using database-clock expiry, reads Agent 05's `observeMysqlSessionCut`, stages the complete semantic documents and publishes under store-first locks. Publication compares lifecycle, format, log revision, event count, header, inherited cut, state CAS and claim. Staging is invisible; expired or changed input cannot publish. Native logs, generations and append receipts remain untouched. Unknown publication COMMIT is resolved by its retained build identity and publication timestamp before success is reported.

Analyzer version 1 requires bigram ngram parsing, disabled stopwords and matching store settings. Queries containing a supported literal bigram use natural-language `MATCH` followed by literal, case-insensitive, whitespace-flexible verification. Other queries, including single characters and emoji, scan only published semantic text under complete-result budgets. The [MySQL ngram reference](https://dev.mysql.com/doc/refman/8.4/en/fulltext-search-ngram.html) defines server tokenization.

Authorization and session/event/surface/time filters precede ranking and session grouping. Ordering uses literal match count descending, codepoint length ascending, event time descending, session-id UTF-8 bytes ascending and seq descending. Snippets are bounded plain text. Signed cursors bind the request, principal/revision, complete cuts, epoch, workspace revision and final ranking tuple. Changed inputs yield `SESSION_QUERY_STALE_CURSOR`; an unready index yields `MysqlSearchError.reason=INDEX_NOT_READY`. A result changed during evaluation fails visibly.

## Model Experience

No direct model-facing registration. Consumers receive the same shared semantic text and surface classes.

#### KV Cache effect

None; this provider does not assemble or send model requests.

## Known Limitations and Deferred Work

The production employee authority capability and opt-in profile/built-package integration require Agent 08. The isolated real-Loader database scenario uses an explicit test authority and does not establish production employee authorization. Builds currently require an explicit `rebuildNext()` caller; a production scheduler needs its own lifecycle and observable retry ownership. Search works against the primary's committed prefix and refuses missing indexes rather than silently completing partial results. No schema mutation, automatic history migration or retired-build deletion occurs here.
