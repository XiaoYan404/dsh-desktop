/** Company-owned descriptive registrations; importing never runs or installs code. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import type {
  OfficeIntegration,
  OfficeIntegrationId,
  OfficeIntegrationImportInput,
  OfficeIntegrationView,
  OfficeMember,
} from './types.ts'

// The import envelope is bounded by the product's published 256 KiB contract.
const maxImportBytes = 256 * 1024
const observed = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const label = z
  .string()
  .trim()
  .normalize('NFC')
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/)
const capability = label.max(120)
const owner = z
  .string()
  .trim()
  .normalize('NFC')
  .max(100)
  .regex(/^[^\u0000-\u001f\u007f]*$/)
const manifest = z
  .object({
    name: label,
    system: label,
    version: label,
    provider: label,
    description: label,
    capabilities: z
      .array(capability)
      .min(1)
      .max(30)
      .refine(
        values =>
          new Set(values.map(value => value.toLowerCase())).size ===
          values.length,
      ),
    owner: owner.optional(),
  })
  .strict()
const entry = manifest
  .extend({
    id: z.uuid().transform(value => brandString<OfficeIntegrationId>(value)),
    owner,
    importedAt: observed,
    importedBy: officeMemberId,
    requestId: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
const audit = z
  .object({
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    actorId: officeMemberId,
    targetId: z.uuid(),
    time: observed,
  })
  .strict()
const state = z
  .object({
    revision: observed,
    entries: z.array(entry).max(1000).readonly(),
    audit: z.array(audit).max(1000).readonly(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.entries.map(record => record.id)).size !==
        value.entries.length ||
      new Set(value.entries.map(record => record.requestId)).size !==
        value.entries.length ||
      new Set(value.entries.map(record => record.name.toLowerCase())).size !==
        value.entries.length ||
      value.revision !== value.entries.length ||
      value.audit.length !== value.entries.length ||
      value.audit.some(
        (record, index) =>
          record.revision !== index + 1 ||
          record.targetId !== value.entries.at(index)?.id ||
          record.actorId !== value.entries.at(index)?.importedBy,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid company integration history',
      })
  })

/** A new domain keeps all previously saved work, chat, drive and identity schemas unchanged. */
export const officeIntegrationDomain = defineDomain({
  name: 'enterprise_office_integrations',
  version: 1,
  global: { schema: state, initial: { revision: 0, entries: [], audit: [] } },
  tables: {},
})

/** Strict network envelope; the server also measures the actual UTF-8 byte length. */
export const officeIntegrationImport = z
  .object({
    requestId: z.uuid(),
    json: z.string().min(1).max(maxImportBytes),
  })
  .strict()

/** All writes execute inside OfficeService's membership/session-aware mutation queue. */
export class OfficeIntegrationRepository {
  constructor(
    private readonly domain: Domain<typeof officeIntegrationDomain>,
    private readonly changed: () => Promise<void>,
  ) {}

  /**
   * Reject detached catalog history rather than accepting a replacement employee directory.
   * @param members - Complete retained company directory.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    const ids = new Set(members.map(member => member.id))
    if (
      this.domain.global
        .get()
        .entries.some(record => !ids.has(record.importedBy))
    ) {
      throw new OfficeError(
        'conflict',
        'Saved integration catalog requires its original employee directory',
      )
    }
  }

  /**
   * Read descriptive company registrations for an already authenticated active employee.
   * @returns Catalog revision, import limit and public records without retry fingerprints.
   */
  view(): OfficeIntegrationView {
    const current = this.domain.global.get()
    return {
      revision: current.revision,
      maxImportBytes,
      entries: current.entries.map(record => this.project(record)),
    }
  }

  /**
   * Register one reviewed JSON object atomically, without installing or connecting anything.
   * @param actor - Current administrator, rechecked by the owning mutation queue.
   * @param input - Exact JSON and UUID retained for uncertain-response retries.
   * @returns Committed registration; exact retries return the existing result.
   */
  async import(
    actor: OfficeMember,
    input: OfficeIntegrationImportInput,
  ): Promise<OfficeIntegration> {
    if (actor.role !== 'admin')
      throw new OfficeError(
        'forbidden',
        'Only administrators register company integrations',
      )
    const parsed = officeIntegrationImport.safeParse(input)
    if (
      !parsed.success ||
      Buffer.byteLength(parsed.data.json, 'utf8') > maxImportBytes
    ) {
      throw new OfficeError(
        'invalid_input',
        'Integration manifest exceeds its import envelope',
      )
    }
    let json: unknown
    try {
      json = JSON.parse(parsed.data.json)
    } catch {
      throw new OfficeError(
        'invalid_input',
        'Expected a JSON integration object',
      )
    }
    const result = manifest.safeParse(json)
    if (!result.success)
      throw new OfficeError(
        'invalid_input',
        'Invalid descriptive integration manifest',
      )
    const current = this.domain.global.get()
    const fingerprint = createHash('sha256')
      .update(parsed.data.json, 'utf8')
      .digest('hex')
    const previous = current.entries.find(
      record => record.requestId === parsed.data.requestId,
    )
    if (previous) {
      if (
        previous.importedBy !== actor.id ||
        previous.fingerprint !== fingerprint
      ) {
        throw new OfficeError('conflict', 'Integration import retry changed')
      }
      return this.project(previous)
    }
    if (
      current.entries.some(
        record =>
          record.name.toLowerCase() === result.data.name.toLowerCase(),
      )
    ) {
      throw new OfficeError(
        'duplicate_name',
        'Integration name is already registered',
      )
    }
    if (current.entries.length >= 1000)
      throw new OfficeError(
        'invalid_input',
        'Integration catalog has reached its retained-entry limit',
      )
    const record = {
      ...result.data,
      owner: result.data.owner ?? '',
      id: brandString<OfficeIntegrationId>(randomUUID()),
      importedAt: Date.now(),
      importedBy: actor.id,
      requestId: parsed.data.requestId,
      fingerprint,
    }
    const revision = current.revision + 1
    await this.domain.global.set({
      revision,
      entries: [...current.entries, record],
      audit: [
        ...current.audit,
        {
          revision,
          actorId: actor.id,
          targetId: record.id,
          time: record.importedAt,
        },
      ],
    })
    await this.changed()
    return this.project(record)
  }

  private project(record: z.infer<typeof entry>): OfficeIntegration {
    return {
      id: record.id,
      name: record.name,
      system: record.system,
      version: record.version,
      provider: record.provider,
      description: record.description,
      owner: record.owner,
      capabilities: record.capabilities,
      importedAt: record.importedAt,
      importedBy: record.importedBy,
    }
  }
}
