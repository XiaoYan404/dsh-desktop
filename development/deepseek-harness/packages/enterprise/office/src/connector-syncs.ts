/** Private immutable read snapshots retain actual network outcomes without granting cached access. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMember, officeMemberId } from './spec.ts'
import { connectorBusinessDataSchema, officeConnectorReadInput } from './connector-actions.ts'
import type { OfficeConnectorReadData, OfficeConnectorReadReceipt, OfficeConnectorSyncDetail,
  OfficeConnectorSyncId, OfficeConnectorSyncInput, OfficeConnectorSyncLimits, OfficeConnectorSyncPage,
  OfficeConnectorSyncQuery, OfficeConnectorSyncSummary, OfficeIntegrationId, OfficeMember } from './types.ts'

const syncId = z.uuid().transform(value => brandString<OfficeConnectorSyncId>(value))
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const input = officeConnectorReadInput.extend({ requestId: z.uuid() }).strict()
const query = z.object({ integrationId: officeConnectorReadInput.shape.integrationId, before: syncId.optional() }).strict()
const failure = z.enum(['unauthorized', 'rate_limited', 'timed_out', 'unreachable', 'invalid_response', 'http_error'])
const outcome = z.discriminatedUnion('status', [
  z.object({ status: z.literal('read'), data: connectorBusinessDataSchema(1000) }).strict(),
  z.object({ status: failure }).strict(),
])
const record = z.object({ id: syncId, memberId: officeMemberId, role: officeMember.shape.role,
  input, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), checkedAt: counter, synchronizedAt: counter, outcome }).strict()
const fingerprint = (memberId: OfficeMember['id'], value: OfficeConnectorSyncInput) => createHash('sha256')
  .update(JSON.stringify({ memberId, integrationId: value.integrationId, actionId: value.actionId,
    connectionRevision: value.connectionRevision, adapterRevision: value.adapterRevision, requestId: value.requestId })).digest('hex')
const state = z.object({ entries: z.array(record).max(10000).readonly() }).strict().superRefine((value, ctx) => {
  if (new Set(value.entries.map(entry => entry.id)).size !== value.entries.length
    || new Set(value.entries.map(entry => JSON.stringify([entry.memberId, entry.input.requestId]))).size !== value.entries.length
    || value.entries.some((entry, index) => entry.fingerprint !== fingerprint(entry.memberId, entry.input)
      || entry.synchronizedAt < (value.entries[index - 1]?.synchronizedAt ?? 0)
      || Buffer.byteLength(JSON.stringify(entry.outcome), 'utf8') > 4 * 1024 * 1024))
    ctx.addIssue({ code: 'custom', message: 'Invalid connector synchronization evidence' })
})

/** Independent version 1 ledger; earlier office stores and Session generations retain their format. */
export const officeConnectorSyncDomain = defineDomain({ name: 'enterprise_office_connector_syncs', version: 1,
  global: { schema: state, initial: { entries: [] } }, tables: {} })
/** Exact RPC admission never accepts an employee, endpoint, credentials or provider arguments. */
export const officeConnectorSyncSchemas = { input, query, id: syncId }
type Stored = z.infer<typeof record>

/** Shared office serialization owns all writes and membership checks. */
export class OfficeConnectorSyncRepository {
  constructor(private readonly domain: Domain<typeof officeConnectorSyncDomain>,
    private readonly limits: { readonly maxEntries: number; readonly maxBytes: number }) {}

  /**
   * Advertise finite synchronization and metadata-page bounds.
   * @returns Protocol metadata without any employee's usage or data.
   */
  capabilities(): OfficeConnectorSyncLimits { return { protocol: 1, pageMaxEntries: 20, ...this.limits } }

  /**
   * Refuse retained evidence detached from its original company directory.
   * @param members - Original active and inactive employees.
   * @param integrations - Retained company registrations.
   * @param connections - Original saved connection revisions; an older or missing unit cannot be recreated over this history.
   */
  verifyDirectory(members: readonly OfficeMember[], integrations: readonly { readonly id: OfficeIntegrationId }[],
    connections: readonly { readonly integrationId: OfficeIntegrationId; readonly revision: number }[]): void {
    const owners = new Set(members.map(member => member.id))
    const systems = new Set(integrations.map(entry => entry.id))
    const versions = new Map(connections.map(entry => [entry.integrationId, entry.revision]))
    if (this.domain.global.get().entries.some(entry => !owners.has(entry.memberId) || !systems.has(entry.input.integrationId)
      || (versions.get(entry.input.integrationId) ?? 0) < entry.input.connectionRevision))
      throw new OfficeError('conflict', 'Saved synchronization records require their original company directory')
  }

  /**
   * Validate a reviewed read and recover only an identical employee-scoped receipt.
   * @param actor - Current active employee inside the write queue.
   * @param value - Stable request and exact action/provider coordinates.
   * @returns Parsed request and optional prior record; no customer query is started here.
   */
  prepare(actor: OfficeMember, value: OfficeConnectorSyncInput): { input: OfficeConnectorSyncInput; existing: Stored | null } {
    const parsed = input.safeParse(value)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid synchronization request')
    const existing = this.domain.global.get().entries.find(entry =>
      entry.memberId === actor.id && entry.input.requestId === value.requestId)
    if (existing && existing.fingerprint !== fingerprint(actor.id, parsed.data))
      throw new OfficeError('conflict', 'Synchronization retry payload changed')
    if (!existing && this.domain.global.get().entries.length >= this.limits.maxEntries)
      throw new OfficeError('conflict', 'Synchronization record capacity reached')
    return { input: parsed.data, existing: existing ?? null }
  }

  /**
   * Publish one sanitized read outcome atomically; failed storage acknowledges no synchronization.
   * @param actor - Current employee from the serialized authority.
   * @param value - Validated original reviewed request.
   * @param receipt - Actual bounded read result, including network failures without business fields.
   * @returns Durable original record; exact retries do not repeat the customer read.
   */
  async save(actor: OfficeMember, value: OfficeConnectorSyncInput, receipt: OfficeConnectorReadReceipt): Promise<Stored> {
    const prepared = this.prepare(actor, value)
    if (prepared.existing) return prepared.existing
    if (receipt.integrationId !== value.integrationId || receipt.actionId !== value.actionId
      || receipt.connectionRevision !== value.connectionRevision || receipt.adapterRevision !== value.adapterRevision)
      throw new OfficeError('conflict', 'Synchronization outcome does not match its reviewed source')
    const current = this.domain.global.get()
    const saved = record.parse({ id: randomUUID(), memberId: actor.id, role: actor.role, input: prepared.input,
      fingerprint: fingerprint(actor.id, prepared.input), checkedAt: receipt.checkedAt,
      synchronizedAt: Math.max(Date.now(), current.entries.at(-1)?.synchronizedAt ?? 0),
      outcome: receipt.status === 'read' ? { status: receipt.status, data: receipt.data } : { status: receipt.status } })
    const next = { entries: [...current.entries, saved] }
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > this.limits.maxBytes)
      throw new OfficeError('invalid_input', 'Synchronization byte capacity reached')
    await this.domain.global.set(next)
    return saved
  }

  /**
   * Read only this employee's small immutable metadata without customer network calls.
   * @param actor - Authenticated active employee.
   * @param value - Company registration and optional owner-scoped older anchor.
   * @returns At most twenty metadata records and a stable older-page anchor.
   */
  page(actor: OfficeMember, value: OfficeConnectorSyncQuery): OfficeConnectorSyncPage {
    const parsed = query.safeParse(value)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid synchronization page')
    const records = this.domain.global.get().entries.filter(entry => entry.memberId === actor.id
      && entry.input.integrationId === value.integrationId).toReversed()
    const offset = value.before ? records.findIndex(entry => entry.id === value.before) : -1
    if (value.before && offset < 0) throw new OfficeError('not_found', 'Synchronization anchor is unavailable')
    const page = records.slice(offset + 1, offset + 22)
    const entries = page.slice(0, 20).map(entry => this.summary(entry))
    return { meId: actor.id, integrationId: value.integrationId, entries,
      next: page.length > 20 ? entries.at(-1)?.id ?? null : null }
  }

  /**
   * Resolve an owner record independently of whether its retained content is still authorized.
   * @param actor - Current active owner; administrators have no bypass.
   * @param id - Server record identity, never a bearer credential.
   * @returns Private record for the service's current-source check.
   */
  get(actor: OfficeMember, id: OfficeConnectorSyncId): Stored {
    if (!syncId.safeParse(id).success) throw new OfficeError('invalid_input', 'Invalid synchronization identity')
    const entry = this.domain.global.get().entries.find(entry => entry.id === id && entry.memberId === actor.id)
    if (!entry) throw new OfficeError('not_found', 'Synchronization record is unavailable')
    return entry
  }

  /**
   * Return retained content only after the service proves current source access.
   * @param actor - Current authenticated employee.
   * @param entry - Owner record selected by get or an exact request retry.
   * @param authorized - Current role, registered read action and saved-connection checks.
   * @returns Historical outcome metadata and separately gated plain-text data.
   */
  detail(actor: OfficeMember, entry: Stored, authorized: boolean): OfficeConnectorSyncDetail {
    if (entry.memberId !== actor.id) throw new OfficeError('not_found', 'Synchronization record is unavailable')
    const available = authorized && entry.role === actor.role
    const data: OfficeConnectorReadData | null = available && entry.outcome.status === 'read' ? entry.outcome.data : null
    return { meId: actor.id, summary: this.summary(entry), available, data }
  }

  private summary(entry: Stored): OfficeConnectorSyncSummary {
    const { requestId: _requestId, ...coordinates } = entry.input
    return { id: entry.id, ...coordinates, checkedAt: entry.checkedAt,
      synchronizedAt: entry.synchronizedAt, status: entry.outcome.status }
  }
}
