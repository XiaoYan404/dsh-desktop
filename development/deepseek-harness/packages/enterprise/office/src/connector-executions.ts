/** Private durable write intents prevent an uncertain external effect from becoming an automatic retry. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { officeMember, officeMemberId } from './spec.ts'
import { officeConnectorReadInput, connectorBusinessDataSchema } from './connector-actions.ts'
import { officeConversationCaptureSchemas } from './conversation-captures.ts'
import { OfficeError } from './error.ts'
import type { OfficeConnectorExecutionId, OfficeConnectorExecutionReceipt, OfficeConnectorExecutionStage,
  OfficeConnectorWriteInput, OfficeIntegration, OfficeMember, OfficeConnectorExecutionLimits,
  OfficeConnectorExecutionQuery, OfficeConnectorExecutionPage, OfficeConnectorExecutionSummary } from './types.ts'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const id = z.uuid().transform(value => brandString<OfficeConnectorExecutionId>(value))
/** History has finite complete-response bounds independent of optional customer implementations. */
export const officeConnectorExecutionLimits: OfficeConnectorExecutionLimits = Object.freeze({
  protocol: 1, pageMaxEntries: 20, pageMaxBytes: 32768, detailMaxBytes: 4 * 1024 * 1024 + 4096, checks: 1,
})
/** Explicit older-page coordinates; no arbitrary sorting, employee identity or result inclusion is accepted. */
export const officeConnectorExecutionQuery = z.object({ integrationId: officeConnectorReadInput.shape.integrationId,
  before: id.optional(),
}).strict().transform(({ before, ...query }): OfficeConnectorExecutionQuery => ({
  ...query, ...before === undefined ? {} : { before },
}))
/** Private detail identity, validated independently of its ownership lookup. */
export const officeConnectorExecutionId = id
const stage = z.enum(['reserved', 'dispatched', 'succeeded', 'rejected', 'unknown', 'cancelled'])
const rejection = z.enum(['denied', 'not_accepted', 'unauthorized', 'rate_limited', 'invalid_input'])
/** Closed caller input; URLs, identities, roles and arbitrary executable adapter arguments are not admitted. */
export const officeConnectorWriteInput = officeConnectorReadInput.extend({ requestId: z.uuid(),
  captureId: officeConversationCaptureSchemas.id.optional(),
  values: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.string().max(4000))
    .refine(value => Object.keys(value).length <= 32).readonly(),
}).strict().transform(({ captureId, ...input }): OfficeConnectorWriteInput => ({
  ...input, ...captureId === undefined ? {} : { captureId },
}))

const businessData = connectorBusinessDataSchema(1000)
/** Trusted executor outcomes; unknown never authorizes sending the operation again. */
export const officeConnectorExecutionOutcome = z.discriminatedUnion('stage', [
  z.object({ stage: z.literal('succeeded'), result: businessData }).strict(),
  z.object({ stage: z.literal('rejected'), rejection }).strict(),
  z.object({ stage: z.literal('unknown') }).strict(),
  z.object({ stage: z.literal('cancelled') }).strict(),
])
const record = z.object({ id, memberId: officeMemberId, roleAtAdmission: officeMember.shape.role,
  input: officeConnectorWriteInput, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), stage,
  resultByteLimit: z.number().int().min(1024).max(4 * 1024 * 1024),
  revision: integer.min(1), admittedAt: integer, updatedAt: integer,
  history: z.array(z.object({ stage, at: integer }).strict()).min(1).max(4).readonly(),
  result: businessData.optional(), rejection: rejection.optional(),
}).strict().superRefine((value, ctx) => {
  const last = value.history.at(-1)
  if (value.fingerprint !== fingerprint(value.input) || value.history[0]?.stage !== 'reserved' ||
    value.history[0].at !== value.admittedAt || last?.stage !== value.stage || last.at !== value.updatedAt ||
    value.revision !== value.history.length || value.history.some((entry, index) => index > 0 &&
      (entry.at < (value.history[index - 1]?.at ?? 0) || !transition(value.history[index - 1]?.stage, entry.stage))) ||
    (value.stage === 'succeeded') !== (value.result !== undefined) ||
    (value.stage === 'rejected') !== (value.rejection !== undefined) ||
    (value.result !== undefined && Buffer.byteLength(JSON.stringify({ stage: 'succeeded', result: value.result }), 'utf8')
      > value.resultByteLimit)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid external execution evidence' })
  }
})
const state = z.object({ entries: z.array(record).max(10000).readonly() }).strict().refine(value =>
  new Set(value.entries.map(entry => entry.id)).size === value.entries.length &&
  new Set(value.entries.map(entry => JSON.stringify([entry.memberId, entry.input.requestId]))).size === value.entries.length)

/** Independent version 1 evidence; loading a dispatched intent never repeats its external effect. */
export const officeConnectorExecutionDomain = defineDomain({ name: 'enterprise_office_connector_executions', version: 1,
  global: { schema: state, initial: { entries: [] } }, tables: {},
})

/** Deployment bounds retain old receipts without silently pruning them or admitting oversized new requests. */
export interface OfficeConnectorExecutionPolicy {
  readonly maxEntries: number
  readonly maxBytes: number
  readonly maxInputBytes: number
  readonly maxResultBytes: number
}

/**
 * Validate finite write-evidence limits before opening the domain.
 * @param policy - Retained entries, complete domain bytes, complete request bytes and result bytes.
 * @returns Validated independent bounds; callers must size retention to include their admitted operations.
 */
export function resolveConnectorExecutionPolicy(policy: OfficeConnectorExecutionPolicy): OfficeConnectorExecutionPolicy {
  return z.object({ maxEntries: z.number().int().min(1).max(10000),
    maxBytes: z.number().int().min(1024).max(256 * 1024 * 1024),
    maxInputBytes: z.number().int().min(1024).max(1024 * 1024),
    maxResultBytes: z.number().int().min(1024).max(4 * 1024 * 1024),
  }).strict().parse(policy)
}

/** Mutations run in the office owner's queue; a reservation is evidence, never a grant to perform an external write. */
export class OfficeConnectorExecutionRepository {
  /**
   * @param domain - Independent durable private execution owner.
   * @param policy - Validated finite retention and input/result bounds.
   */
  constructor(
    private readonly domain: Domain<typeof officeConnectorExecutionDomain>, private readonly policy: OfficeConnectorExecutionPolicy,
  ) {}

  /**
   * Refuse silent reseeding over evidence belonging to another company directory or system catalog.
   * @param members - Retained employee directory, including inactive employees.
   * @param integrations - Retained company system registrations.
   */
  verifyDirectory(members: readonly OfficeMember[], integrations: readonly OfficeIntegration[]): void {
    if (this.domain.global.get().entries.some(entry => !members.some(member => member.id === entry.memberId) ||
      !integrations.some(integration => integration.id === entry.input.integrationId)))
      throw new OfficeError('conflict', 'External executions require their original company directory and system catalog')
  }

  /**
   * Read this active employee's receipts without request values or an administrator ownership bypass.
   * @param actor - Active employee selected by the office authority owner.
   * @returns Own immutable evidence; a dispatched operation is projected as unknown, never successful.
   */
  list(actor: OfficeMember): readonly OfficeConnectorExecutionReceipt[] {
    return this.domain.global.get().entries.filter(entry => entry.memberId === actor.id).map(entry => this.project(entry))
  }

  /**
   * Read one bounded page of newest-first own receipts without large results or raw request values.
   * @param actor - Current authenticated employee, with no administrator ownership bypass.
   * @param query - Selected system and optional own last-entry anchor; new admissions cannot duplicate older-page entries.
   * @returns Complete UTF-8 bounded page; a foreign, changed-system or unknown cursor rejects without disclosing history.
   */
  page(actor: OfficeMember, query: OfficeConnectorExecutionQuery): OfficeConnectorExecutionPage {
    const parsed = officeConnectorExecutionQuery.safeParse(query)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid execution history query')
    const own = this.domain.global.get().entries.filter(entry => entry.memberId === actor.id &&
      entry.input.integrationId === parsed.data.integrationId).toReversed()
    const anchor = parsed.data.before === undefined ? -1 : own.findIndex(entry => entry.id === parsed.data.before)
    if (parsed.data.before !== undefined && anchor === -1) throw new OfficeError('invalid_input', 'Execution history cursor is unavailable')
    const remaining = own.slice(anchor + 1)
    const entries: OfficeConnectorExecutionSummary[] = []
    for (const entry of remaining) {
      const { history: _history, result: _result, ...summary } = this.project(entry)
      const complete = { integrationId: parsed.data.integrationId, entries: [...entries, summary], next: summary.id }
      if (entries.length === officeConnectorExecutionLimits.pageMaxEntries ||
        Buffer.byteLength(JSON.stringify(complete), 'utf8') > officeConnectorExecutionLimits.pageMaxBytes) break
      entries.push(summary)
    }
    if (remaining.length && !entries.length) throw new OfficeError('context_too_large', 'Execution history entry exceeds its page bound')
    return { integrationId: parsed.data.integrationId, entries,
      next: entries.length < remaining.length ? entries.at(-1)?.id ?? null : null }
  }

  /**
   * Recover an exact employee retry without generating a second external execution identity.
   * @param actor - Current active employee, already authenticated by the queue owner.
   * @param input - Reviewed request; object-key order does not alter its handling identity.
   * @returns Own retained reservation or absence; changed arguments under the same retry UUID conflict.
   */
  find(actor: OfficeMember, input: OfficeConnectorWriteInput): z.infer<typeof record> | undefined {
    const current = this.domain.global.get().entries.find(entry => entry.memberId === actor.id && entry.input.requestId === input.requestId)
    if (current && current.fingerprint !== fingerprint(input)) throw new OfficeError('conflict', 'External write retry changed')
    return current
  }

  /**
   * Prevent a new retry UUID or refreshed connection from replaying an equivalent possibly committed business write.
   * @param actor - Authenticated employee; another employee's evidence is never disclosed.
   * @param input - Strict parsed new intent; equivalent means the same system, action and exact business values.
   * @returns Own unresolved receipt, independent of caller retry UUID and transient provider versions.
   */
  unresolved(actor: OfficeMember, input: OfficeConnectorWriteInput): OfficeConnectorExecutionReceipt | undefined {
    const values = JSON.stringify(orderedValues(input.values))
    const entry = this.domain.global.get().entries.find(row => row.memberId === actor.id &&
      (row.stage === 'dispatched' || row.stage === 'unknown') && row.input.integrationId === input.integrationId &&
      row.input.actionId === input.actionId && JSON.stringify(orderedValues(row.input.values)) === values)
    return entry && this.project(entry)
  }

  /**
   * Project one retained own receipt without exposing the raw request values.
   * @param actor - Authenticated employee.
   * @param executionId - Server-owned operation identity.
   * @returns Own current receipt; administrators cannot inspect another employee's private evidence.
   */
  receipt(actor: OfficeMember, executionId: OfficeConnectorExecutionId): OfficeConnectorExecutionReceipt {
    const receipt = this.project(this.owned(actor, executionId))
    if (Buffer.byteLength(JSON.stringify(receipt), 'utf8') > officeConnectorExecutionLimits.detailMaxBytes)
      throw new OfficeError('context_too_large', 'Execution detail exceeds its complete response bound')
    return receipt
  }

  /**
   * Inspect retained coordinates and the original result bound inside the trusted office queue.
   * @param actor - Current authenticated employee with no administrator ownership override.
   * @param executionId - Own server operation identity.
   * @returns Internal immutable evidence for the reconciliation owner; never expose this raw record through a wire endpoint.
   */
  inspect(actor: OfficeMember, executionId: OfficeConnectorExecutionId): z.infer<typeof record> {
    return this.owned(actor, executionId)
  }

  /**
   * Commit an intent before any separate executor may admit a network effect.
   * @param actor - Employee whose current action and connection authority the service has verified.
   * @param input - Exact reviewed request, excluding credentials and URLs.
   * @returns Original or newly durable reservation; a persistence failure never publishes an admitted identity.
   */
  async reserve(actor: OfficeMember, input: OfficeConnectorWriteInput): Promise<z.infer<typeof record>> {
    const parsed = officeConnectorWriteInput.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid external write request')
    const previous = this.find(actor, parsed.data)
    if (previous) return previous
    if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > this.policy.maxInputBytes)
      throw new OfficeError('context_too_large', 'External write input exceeds its configured byte limit')
    const now = Date.now()
    const saved = record.parse({ id: randomUUID(), memberId: actor.id, roleAtAdmission: actor.role, input: parsed.data,
      resultByteLimit: this.policy.maxResultBytes,
      fingerprint: fingerprint(parsed.data), stage: 'reserved', revision: 1, admittedAt: now, updatedAt: now,
      history: [{ stage: 'reserved', at: now }] })
    await this.commit([...this.domain.global.get().entries, saved])
    return saved
  }

  /**
   * Commit the possibly-sent boundary before the executor calls a customer system.
   * @param actor - Authenticated employee whose current authority has been rechecked after reservation persistence.
   * @param executionId - Own durable intent identity, never the caller's retry UUID.
   * @returns Newly committed dispatch evidence; a repeated or terminal dispatch conflicts and grants no retry.
   */
  async dispatch(actor: OfficeMember, executionId: OfficeConnectorExecutionId): Promise<OfficeConnectorExecutionReceipt> {
    const current = this.owned(actor, executionId)
    if (current.stage !== 'reserved') throw new OfficeError('conflict', 'External execution cannot be dispatched again')
    return this.change(current, { stage: 'dispatched' })
  }

  /**
   * Commit an authoritative result, explicit unknown outcome, or pre-dispatch cancellation.
   * @param actor - Current employee authorized by the separate executor or reconciliation owner.
   * @param executionId - Own retained execution identity.
   * @param outcome - Trusted structured evidence; unknown outcomes cannot transition back to dispatch.
   * @returns Durable receipt; failed persistence retains the conservative prior phase without reporting success.
   */
  async finish(actor: OfficeMember, executionId: OfficeConnectorExecutionId,
    outcome: z.infer<typeof officeConnectorExecutionOutcome>): Promise<OfficeConnectorExecutionReceipt> {
    const current = this.owned(actor, executionId)
    const parsed = officeConnectorExecutionOutcome.safeParse(outcome)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid external execution outcome')
    const existing = { stage: current.stage, ...current.result === undefined ? {} : { result: current.result },
      ...current.rejection === undefined ? {} : { rejection: current.rejection } }
    if (JSON.stringify(existing) === JSON.stringify(parsed.data)) return this.project(current)
    if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > current.resultByteLimit)
      throw new OfficeError('context_too_large', 'External execution result exceeds its configured byte limit')
    if (!transition(current.stage, parsed.data.stage)) throw new OfficeError('conflict', 'External execution outcome conflicts')
    return this.change(current, parsed.data)
  }

  private owned(actor: OfficeMember, executionId: OfficeConnectorExecutionId): z.infer<typeof record> {
    const parsed = id.safeParse(executionId)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid external execution identity')
    const entry = this.domain.global.get().entries.find(value => value.id === parsed.data && value.memberId === actor.id)
    if (!entry) throw new OfficeError('not_found', 'External execution is unavailable')
    return entry
  }

  private async change(current: z.infer<typeof record>, outcome: {
    readonly stage: OfficeConnectorExecutionStage
    readonly result?: z.infer<typeof businessData>
    readonly rejection?: z.infer<typeof rejection>
  }): Promise<OfficeConnectorExecutionReceipt> {
    const at = Math.max(Date.now(), current.updatedAt)
    const updated = record.parse({ ...current, ...outcome, updatedAt: at, revision: current.revision + 1,
      history: [...current.history, { stage: outcome.stage, at }] })
    await this.commit(this.domain.global.get().entries.map(entry => entry.id === current.id ? updated : entry))
    return this.project(updated)
  }

  private async commit(entries: readonly z.infer<typeof record>[]): Promise<void> {
    const next = { entries }
    const bytes = Buffer.byteLength(JSON.stringify({ entries: [] }), 'utf8') + Math.max(0, entries.length - 1)
      + entries.reduce((sum, entry) => sum + retainedBytes(entry), 0)
    if (entries.length > this.policy.maxEntries || bytes > this.policy.maxBytes)
      throw new OfficeError('conflict', 'External execution retention is full')
    await this.domain.global.set(next)
  }

  private project(entry: z.infer<typeof record>): OfficeConnectorExecutionReceipt {
    return { id: entry.id, requestId: entry.input.requestId, memberId: entry.memberId, roleAtAdmission: entry.roleAtAdmission,
      integrationId: entry.input.integrationId, actionId: entry.input.actionId, connectionRevision: entry.input.connectionRevision,
      adapterRevision: entry.input.adapterRevision, ...entry.input.captureId === undefined ? {} : { captureId: entry.input.captureId },
      stage: entry.stage, status: entry.stage === 'dispatched' ? 'unknown' : entry.stage,
      revision: entry.revision, admittedAt: entry.admittedAt, updatedAt: entry.updatedAt, history: entry.history,
      ...entry.result === undefined ? {} : { result: entry.result },
      ...entry.rejection === undefined ? {} : { rejection: entry.rejection } }
  }
}

function retainedBytes(entry: z.infer<typeof record>): number {
  if (entry.stage === 'succeeded' || entry.stage === 'rejected' || entry.stage === 'cancelled')
    return Buffer.byteLength(JSON.stringify(entry), 'utf8')
  // Reserve the largest coordinate/audit frame plus the negotiated result before any external effect is admitted.
  const at = Number.MAX_SAFE_INTEGER
  const envelope = { ...entry, stage: 'dispatched', revision: 4, updatedAt: at, result: null, rejection: 'not_accepted',
    history: [{ stage: 'reserved', at: entry.admittedAt }, { stage: 'dispatched', at },
      { stage: 'unknown', at }, { stage: 'succeeded', at }] }
  return Buffer.byteLength(JSON.stringify(envelope), 'utf8') + entry.resultByteLimit
}

function transition(previous: OfficeConnectorExecutionStage | undefined, next: OfficeConnectorExecutionStage): boolean {
  return previous === 'reserved' ? next === 'dispatched' || next === 'cancelled'
    : previous === 'dispatched' ? next === 'succeeded' || next === 'rejected' || next === 'unknown'
      : previous === 'unknown' && (next === 'succeeded' || next === 'rejected')
}
function fingerprint(input: OfficeConnectorWriteInput): string {
  return createHash('sha256').update(JSON.stringify({ integrationId: input.integrationId, actionId: input.actionId,
    connectionRevision: input.connectionRevision, adapterRevision: input.adapterRevision, requestId: input.requestId,
    ...input.captureId === undefined ? {} : { captureId: input.captureId },
    values: orderedValues(input.values),
  })).digest('hex')
}

function orderedValues(values: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(values).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
}
