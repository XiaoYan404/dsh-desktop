# Agent Note: Reserve internal Agent work before publishing its item

Status: implemented

English | [中文](2026-10-17-office-agent-work-reservations.zh.md)

## Problem

An authenticated Agent request can lose its response after creating an office task. Retrying with a fresh server item id would create duplicate work and assignee notifications. A prepared association snapshot alone cannot authorize a later write: employees, selections, required connections and adapter availability can change while storage is pending.

## Decision

The office service exposes one closed operation for creating an internal task/to-do under a captured reminder selection. Its authenticated employee comes from the serving adapter, never from request data. The shared queue checks active membership, capture ownership and role, reviewed selection, current declared dependencies and required connection versions. The operation does not send to an external company system.

Before publishing the ordinary work commit, an independent reservation domain saves the original employee, execution UUID, strict request fingerprint and server-issued item UUID. A retry first finds that same private reservation. If its item exists, the service returns it through current read authorization and performs no write. If the item is absent, fresh execution checks precede creating that exact reserved id. Changing a request under the same execution UUID conflicts.

The work item, assignee notification and existing business audit remain one work-domain commit. The reservation alone is evidence of an admitted request, not proof of execution. A business-write failure leaves a recoverable reservation; a response failure after commit leaves the original item discoverable. Readiness and synchronous deployment availability are checked again after reservation persistence, immediately before a dependent write, so unloading an adapter during that wait cannot admit work under stale availability.

Reservations have finite entry and byte bounds without implicit expiry. Exact existing retries survive lowered limits; new requests at capacity fail before a new business item. Original employee data and stored fingerprints are checked on recovery. Ordinary manual work creation shares the item-publication helper while keeping its existing API.

## Alternatives considered

**Save a receipt only after creating the task.** A crash or uncertain response between task and receipt publication would leave no reliable retry coordinate.

**Commit reservation and work as one backend-specific transaction.** The office composition supports independent storage domains and the JSON provider; requiring a multi-domain transaction would couple this operation to a new backend contract.

**Trust the captured role or initial readiness check.** Those are historical facts. A pending reservation can outlive an adapter or changed deployment requirement and therefore requires current admission checks.

**Recheck write permission before returning an already committed retry.** This would hide a successful operation after unlinking. Returning the authorized existing item is acknowledgement recovery, not another execution.

## Verification

Real Loader/JSON tests exercise concurrent retries, cold recovery, failures before reservation, before business publication and after durable publication, quota rejection, queued deactivation, role changes and shutdown drain. Adapter-disposal coverage fails before the second admission check and passes with it. Actual HTTP and independent authenticated employee Hosts verify private capture ownership, actor-forgery rejection, one item/notification and receipt recovery across Host replacement.

## Consequences

Two ordered durable writes replace a cross-domain transaction. An unfinished request consumes retention until explicitly managed; backup requires reservations, captures and office work together. Already committed retries reflect the item's current readable state. This guarantee belongs to the single serving office queue and its storage owner. Native model-tool exposure and external-system writes are separate consumers with their own approval and execution contracts.
