/** Immutable private save receipts provide exact retries without claiming external delivery. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { brandString } from '@deepseek-ai/dsh-brand'
import { officeMemberId } from './spec.ts'
import { OfficeError } from './error.ts'
import type { OfficeCustomizationId, OfficeCustomizationInput, OfficeCustomizationLimits,
  OfficeCustomizationPage, OfficeCustomizationRecord, OfficeCustomizationSaveReceipt, OfficeMember } from './types.ts'

const id = z.uuid().transform(value => brandString<OfficeCustomizationId>(value))
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.number().int().nonnegative().max(8640000000000000)
const label = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/)
const fields = z.object({ target: label, contact: label,
  requirements: z.string().min(1).max(8000).refine(value => value.trim().length > 0 && !value.includes('\0')) })
const input = fields.extend({ id: id.nullable(), revision: counter, requestId: z.uuid() }).strict()
  .refine(value => value.id === null ? value.revision === 0 : value.revision > 0)
const record = fields.extend({ id, ownerId: officeMemberId, revision: counter.positive(), companyName: z.string().min(1).max(1000),
  createdAt: timestamp, updatedAt: timestamp, delivery: z.literal('not_sent') }).strict()
const fingerprint = (ownerId: OfficeMember['id'], value: OfficeCustomizationInput) => createHash('sha256')
  .update(JSON.stringify({ ownerId, id: value.id, revision: value.revision, requestId: value.requestId,
    target: value.target, contact: value.contact, requirements: value.requirements })).digest('hex')
const saved = z.object({ ownerId: officeMemberId, sequence: counter.positive(), input,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), record }).strict()
const state = z.object({ receipts: z.array(saved).max(10000).readonly() }).strict().superRefine((value, ctx) => {
  const latest = new Map<string, z.infer<typeof record>>()
  const sequences = new Map<string, number>()
  const requests = new Set<string>()
  let previousTime = 0
  for (const row of value.receipts) {
    const previous = latest.get(row.record.id)
    const key = JSON.stringify([row.ownerId, row.input.requestId])
    if (requests.has(key) || row.sequence !== (sequences.get(row.ownerId) ?? 0) + 1
      || row.fingerprint !== fingerprint(row.ownerId, row.input) || row.record.ownerId !== row.ownerId
      || row.record.revision !== (previous?.revision ?? 0) + 1 || row.input.revision !== (previous?.revision ?? 0)
      || row.input.id !== (previous?.id ?? null) || (previous && previous.ownerId !== row.ownerId)
      || row.record.target !== row.input.target || row.record.contact !== row.input.contact
      || row.record.requirements !== row.input.requirements || row.record.updatedAt < row.record.createdAt
      || row.record.updatedAt < previousTime || (previous && row.record.createdAt !== previous.createdAt)) {
      ctx.addIssue({ code: 'custom', message: 'Customization save history is inconsistent' })
      return
    }
    requests.add(key); latest.set(row.record.id, row.record); sequences.set(row.ownerId, row.sequence)
    previousTime = row.record.updatedAt
  }
})

/** Separate private office unit; no Native Session or integration catalog schema is changed. */
export const officeCustomizationDomain = defineDomain({ name: 'enterprise_office_customizations', version: 1,
  global: { schema: state, initial: { receipts: [] } }, tables: {} })
/** Strict transport admission accepts no employee, recipient, URL or delivery status. */
export const officeCustomizationSchemas = { input, id, before: counter.positive().nullable() }

/** Shared office serialization owns save ordering and current membership checks. */
export class OfficeCustomizationRepository {
  constructor(private readonly domain: Domain<typeof officeCustomizationDomain>,
    private readonly limits: { readonly maxOperations: number; readonly maxBytes: number }) {}

  /**
   * Advertise the private-save protocol and configured persistence bounds.
   * @returns Finite persistence and metadata-page bounds; no external submission is advertised.
   */
  capabilities(): OfficeCustomizationLimits { return { protocol: 1, pageSize: 20, ...this.limits } }

  /**
   * Reject recovered drafts detached from their original employee directory.
   * @param members - Retained active and inactive company members.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    const owners = new Set(members.map(member => member.id))
    if (this.domain.global.get().receipts.some(row => !owners.has(row.ownerId)))
      throw new OfficeError('conflict', 'Saved customization requests require their original employee directory')
  }

  /**
   * Save a reviewed version atomically, retaining exact original receipts after later edits.
   * @param actor - Current active employee from the office queue.
   * @param companyName - Company name from the authoritative office, never the request body.
   * @param value - Strict fields, reviewed revision and exact retry UUID.
   * @returns Durable original receipt and the currently saved revision for explicit conflict review.
   */
  async save(actor: OfficeMember, companyName: string, value: OfficeCustomizationInput): Promise<OfficeCustomizationSaveReceipt> {
    const parsed = input.safeParse(value)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid customization draft')
    const current = this.domain.global.get()
    const own = current.receipts.filter(row => row.ownerId === actor.id)
    const existing = own.find(row => row.input.requestId === parsed.data.requestId)
    const digest = fingerprint(actor.id, parsed.data)
    if (existing) {
      if (existing.fingerprint !== digest) throw new OfficeError('conflict', 'Customization retry payload changed')
      return { meId: actor.id, record: existing.record,
        currentRevision: own.findLast(row => row.record.id === existing.record.id)?.record.revision ?? existing.record.revision }
    }
    const previous = parsed.data.id ? this.get(actor, parsed.data.id) : null
    if ((previous?.revision ?? 0) !== parsed.data.revision || parsed.data.revision === Number.MAX_SAFE_INTEGER)
      throw new OfficeError('conflict', 'Customization request changed in another window')
    if (current.receipts.length >= this.limits.maxOperations)
      throw new OfficeError('customization_capacity', 'Customization save capacity reached')
    const at = Math.max(Date.now(), current.receipts.at(-1)?.record.updatedAt ?? 0)
    const result = record.parse({ id: previous?.id ?? randomUUID(), ownerId: actor.id, companyName,
      revision: parsed.data.revision + 1, target: parsed.data.target, contact: parsed.data.contact, requirements: parsed.data.requirements,
      createdAt: previous?.createdAt ?? at, updatedAt: at, delivery: 'not_sent' })
    const next = { receipts: [...current.receipts, { ownerId: actor.id, sequence: (own.at(-1)?.sequence ?? 0) + 1,
      input: parsed.data, fingerprint: digest, record: result }] }
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > this.limits.maxBytes)
      throw new OfficeError('customization_capacity', 'Customization byte capacity reached')
    await this.domain.global.set(next)
    return { meId: actor.id, record: result, currentRevision: result.revision }
  }

  /**
   * Read only current own metadata, using stable employee-local save positions for older pages.
   * @param actor - Current authenticated employee.
   * @param before - Exclusive older save position, or null for newest records.
   * @returns At most twenty latest request summaries without contact or requirement bodies.
   */
  page(actor: OfficeMember, before: number | null): OfficeCustomizationPage {
    if (!officeCustomizationSchemas.before.safeParse(before).success) throw new OfficeError('invalid_input', 'Invalid customization page')
    const latest = new Map<OfficeCustomizationId, z.infer<typeof saved>>()
    for (const row of this.domain.global.get().receipts) if (row.ownerId === actor.id) latest.set(row.record.id, row)
    const rows = [...latest.values()].filter(row => before === null || row.sequence < before)
      .sort((left, right) => right.sequence - left.sequence).slice(0, 21)
    const anchor = rows[19]
    return { meId: actor.id, entries: rows.slice(0, 20).map(({ record: value }) => ({ id: value.id,
      revision: value.revision, target: value.target, updatedAt: value.updatedAt })),
    next: rows.length > 20 && anchor ? anchor.sequence : null }
  }

  /**
   * Read the latest saved private version; administrator role does not bypass its owner.
   * @param actor - Current authenticated employee.
   * @param value - Server-issued request identity.
   * @returns The current own draft, or a denial without another employee's fields.
   */
  get(actor: OfficeMember, value: OfficeCustomizationId): OfficeCustomizationRecord {
    if (!id.safeParse(value).success) throw new OfficeError('invalid_input', 'Invalid customization identity')
    const found = this.domain.global.get().receipts.findLast(row => row.record.id === value && row.ownerId === actor.id)
    if (!found) throw new OfficeError('not_found', 'Customization request is unavailable')
    return found.record
  }
}
