/** Bounded persistent knowledge indexing never treats a published body as permission to read its source. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { officeDriveRequestSchemas } from './drive.ts'
import { officeMemberId } from './spec.ts'
import { OfficeError } from './error.ts'
import type { OfficeConversationFileReference, OfficeMember } from './types.ts'
import type { OfficeKnowledgeCitation, OfficeKnowledgeCitationInput, OfficeKnowledgePolicy, OfficeKnowledgePublication,
  OfficeKnowledgePublishInput, OfficeKnowledgeSearch, OfficeKnowledgeSearchInput, OfficeKnowledgeUnit, OfficeKnowledgeWithdrawInput } from './knowledge-types.ts'

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[a-f\d]{64}$/u)
const source = z.object({ id: officeDriveRequestSchemas.id, versionId: officeDriveRequestSchemas.versionId,
  name: z.string().max(255), mediaType: z.string().max(255), byteLength: counter, sha256: digest }).strict()
const location = z.object({ kind: z.enum(['text', 'docx', 'pdf', 'xlsx', 'pptx']), part: counter.positive(),
  offset: counter, label: z.string().max(255) }).strict()
const chunk = z.object({ location, text: z.string().max(16384) }).strict()
const publication = z.object({ file: source, revision: counter.positive(), publisherId: officeMemberId,
  publishedAt: counter, withdrawn: z.boolean(), chunks: z.array(chunk).max(100000) }).strict()
const receipt = z.object({ actorId: officeMemberId, requestId: z.uuid(), fingerprint: digest,
  fileId: officeDriveRequestSchemas.id, revision: counter.positive() }).strict()
const state = z.object({ publications: z.array(publication).max(10000), receipts: z.array(receipt).max(100000) }).strict()
  .superRefine((value, ctx) => {
    const ids = value.publications.map(row => row.file.id)
    const requests = value.receipts.map(row => JSON.stringify([row.actorId, row.requestId]))
    if (new Set(ids).size !== ids.length || new Set(requests).size !== requests.length
      || value.publications.some(row => row.withdrawn && row.chunks.length))
      ctx.addIssue({ code: 'custom', message: 'Knowledge publication identities or withdrawal are inconsistent' })
  })

/** Additive independent domain; original Drive generations and Native logs remain unchanged. */
export const officeKnowledgeDomain = defineDomain({ name: 'enterprise_office_knowledge', version: 1,
  global: { schema: state, initial: { publications: [], receipts: [] } }, tables: {} })

/** Strict transport inputs admit no actor, arbitrary URI, parser selection or claimed content. */
export const officeKnowledgeSchemas = {
  fileId: officeDriveRequestSchemas.id,
  publish: z.object({ fileId: officeDriveRequestSchemas.id, versionId: officeDriveRequestSchemas.versionId,
    revision: counter, requestId: z.uuid() }).strict(),
  withdraw: z.object({ fileId: officeDriveRequestSchemas.id, revision: counter.positive(), requestId: z.uuid() }).strict(),
  citation: z.object({ fileId: officeDriveRequestSchemas.id, versionId: officeDriveRequestSchemas.versionId,
    sha256: digest, revision: counter.positive(), chunk: counter.max(99999) }).strict(),
  search: z.object({ query: z.string().trim().min(1).max(256), limit: z.number().int().min(1).max(100) }).strict(),
}

/**
 * Validate finite deployment bounds independently of the public configuration UI.
 * @param input - Complete optional knowledge deployment object.
 * @returns Validated policy; omitted configuration leaves all indexing disabled.
 */
export function resolveOfficeKnowledgePolicy(input: unknown): OfficeKnowledgePolicy | undefined {
  if (input === undefined) return undefined
  const bounded = (max: number) => z.number().int().min(1).max(max)
  const parsed = z.object({ maxDocuments: bounded(10000), maxIndexBytes: bounded(128 * 1024 * 1024),
    maxSourceBytes: bounded(64 * 1024 * 1024), maxDocumentCharacters: bounded(2 * 1024 * 1024),
    maxSections: bounded(2000), chunkCharacters: bounded(16384), maxChunksPerDocument: bounded(100000),
    maxResults: bounded(100), maxResponseBytes: bounded(16 * 1024 * 1024), timeoutMs: bounded(30000) }).strict().safeParse(input)
  if (!parsed.success) throw new OfficeError('invalid_input', 'Knowledge indexing requires complete finite limits')
  return parsed.data
}

/** The Office service supplies its existing serialized current-member, ACL/head/digest and parser operations. */
export interface OfficeKnowledgeSource {
  /** Recheck current session, employee/role, ancestor ACL and current immutable source; throws on any denial. */
  authorize(actor: OfficeMember, file: Pick<OfficeConversationFileReference, 'id' | 'versionId'>): OfficeConversationFileReference
  /** Fully verify bounded source bytes, then reuse the existing document parsers within the caller's queue. */
  extract(actor: OfficeMember, file: OfficeConversationFileReference, policy: OfficeKnowledgePolicy,
    signal: AbortSignal): Promise<readonly OfficeKnowledgeUnit[]>
}

function sameSource(a: OfficeConversationFileReference, b: OfficeConversationFileReference): boolean {
  return a.id === b.id && a.versionId === b.versionId && a.sha256 === b.sha256 && a.byteLength === b.byteLength
}
function summary(value: z.infer<typeof publication>): OfficeKnowledgePublication {
  return { ...value, chunks: value.chunks.length }
}
function fingerprint(actor: OfficeMember, method: string, value: object): string {
  return createHash('sha256').update(JSON.stringify([actor.id, method, value])).digest('hex')
}
function resultBytes(value: object): number {
  return Math.max(Buffer.byteLength(JSON.stringify({ ok: true, value })),
    Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(value) }])))
}

/** All operations run on the Office queue, and no request caches source read authority. */
export class OfficeKnowledgeRepository {
  constructor(private readonly domain: Domain<typeof officeKnowledgeDomain>, private readonly policy: OfficeKnowledgePolicy,
    private readonly source: OfficeKnowledgeSource) {}

  /**
   * Read the publication revision for a freshly authorized current file before reviewing a replacement.
   * @param actor - Current active employee.
   * @param file - Current source, resolved by Office rather than caller metadata.
   * @returns Metadata with current file facts, or null before its first publication.
   */
  publication(actor: OfficeMember, file: OfficeConversationFileReference): OfficeKnowledgePublication | null {
    const current = this.source.authorize(actor, file)
    const row = this.domain.global.get().publications.find(entry => entry.file.id === current.id)
    if (!row) return null
    const value = { ...summary(row), file: current }
    this.bounded(value)
    return value
  }

  /**
   * Reindex one exact source incrementally, replacing only its previous current publication after final authorization.
   * @param actor - Current active publisher; administrator or manager permission is required.
   * @param input - Reviewed current file version, publication revision and stable request UUID.
   * @param signal - Original request, Office lifetime and extraction deadline.
   * @returns Metadata only, after durable index commit.
   */
  async publish(actor: OfficeMember, input: OfficeKnowledgePublishInput, signal: AbortSignal): Promise<OfficeKnowledgePublication> {
    const parsed = officeKnowledgeSchemas.publish.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid knowledge publication')
    this.publisher(actor)
    signal.throwIfAborted()
    const value = parsed.data
    const file = this.source.authorize(actor, { id: value.fileId, versionId: value.versionId })
    const current = this.domain.global.get()
    const previous = current.publications.find(row => row.file.id === file.id)
    const retried = this.retry(actor, value.requestId, fingerprint(actor, 'publish', value))
    if (retried) {
      if (!previous || previous.revision !== retried.revision || previous.withdrawn || !sameSource(file, previous.file))
        throw new OfficeError('conflict', 'Publication retry is no longer current')
      return summary(previous)
    }
    if ((previous?.revision ?? 0) !== value.revision || value.revision === Number.MAX_SAFE_INTEGER)
      throw new OfficeError('conflict', 'Review the current knowledge publication revision')
    if (!previous && current.publications.length >= this.policy.maxDocuments)
      throw new OfficeError('context_too_large', 'Knowledge document capacity reached')
    const units = await this.source.extract(actor, file, this.policy, signal)
    signal.throwIfAborted()
    const chunks: z.infer<typeof chunk>[] = []
    let characters = 0
    for (const unit of units) {
      characters += unit.text.length
      if (characters > this.policy.maxDocumentCharacters || unit.location.part > this.policy.maxSections)
        throw new OfficeError('context_too_large', 'Knowledge document extraction exceeds its limits')
      for (let start = 0; start < unit.text.length;) {
        let end = Math.min(unit.text.length, start + this.policy.chunkCharacters)
        if (end < unit.text.length && /[\uD800-\uDBFF]/u.test(unit.text.charAt(end - 1))) end--
        if (end === start) throw new OfficeError('context_too_large', 'Knowledge chunk limit cannot hold a complete character')
        chunks.push({ location: { ...unit.location, offset: unit.location.offset + start }, text: unit.text.slice(start, end) })
        if (chunks.length > this.policy.maxChunksPerDocument) throw new OfficeError('context_too_large', 'Knowledge chunk capacity reached')
        start = end
      }
    }
    const final = this.source.authorize(actor, file)
    if (!sameSource(file, final)) throw new OfficeError('conflict', 'Knowledge source changed during extraction')
    const published = { file: final, revision: value.revision + 1, publisherId: actor.id,
      publishedAt: Date.now(), withdrawn: false, chunks }
    this.bounded(summary(published))
    const next = { publications: previous ? current.publications.map(row => row.file.id === file.id ? published : row)
      : [...current.publications, published], receipts: [...current.receipts, { actorId: actor.id,
      requestId: value.requestId, fingerprint: fingerprint(actor, 'publish', value), fileId: file.id, revision: published.revision }] }
    await this.commit(next, signal)
    signal.throwIfAborted()
    this.source.authorize(actor, final)
    return summary(published)
  }

  /**
   * Withdraw one reviewed publication and remove its indexed body while retaining retry metadata.
   * @param actor - Current publisher or administrator with current source access.
   * @param input - File, exact publication revision and stable request identity.
   * @param signal - Current operation cancellation.
   * @returns Committed metadata; a concurrent replacement is rejected.
   */
  async withdraw(actor: OfficeMember, input: OfficeKnowledgeWithdrawInput, signal: AbortSignal): Promise<OfficeKnowledgePublication> {
    const parsed = officeKnowledgeSchemas.withdraw.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid knowledge withdrawal')
    this.publisher(actor)
    const value = parsed.data
    const current = this.domain.global.get()
    const previous = current.publications.find(row => row.file.id === value.fileId)
    if (!previous) throw new OfficeError('not_found', 'Knowledge publication not found')
    this.source.authorize(actor, previous.file)
    if (actor.role !== 'admin' && previous.publisherId !== actor.id) throw new OfficeError('forbidden', 'Publication belongs to another publisher')
    const key = fingerprint(actor, 'withdraw', value)
    const retried = this.retry(actor, value.requestId, key)
    if (retried && previous.withdrawn && retried.revision === previous.revision) return summary(previous)
    if (retried || previous.revision !== value.revision || previous.revision === Number.MAX_SAFE_INTEGER)
      throw new OfficeError('conflict', 'Review the current knowledge publication revision')
    const removed = { ...previous, revision: previous.revision + 1, withdrawn: true, chunks: [] }
    this.bounded(summary(removed))
    await this.commit({ publications: current.publications.map(row => row === previous ? removed : row),
      receipts: [...current.receipts, { actorId: actor.id, requestId: value.requestId, fingerprint: key,
        fileId: value.fileId, revision: removed.revision }] }, signal)
    return summary(removed)
  }

  /**
   * Search current authorized source versions; inaccessible and superseded documents contribute no body, count or hasMore.
   * @param actor - Current authenticated employee, checked again by every source resolution.
   * @param input - Literal query terms and bounded desired result count.
   * @returns Complete-envelope-bounded citations with exact source positions.
   */
  search(actor: OfficeMember, input: OfficeKnowledgeSearchInput): OfficeKnowledgeSearch {
    const parsed = officeKnowledgeSchemas.search.safeParse(input)
    if (!parsed.success || parsed.data.limit > this.policy.maxResults) throw new OfficeError('invalid_input', 'Invalid knowledge query')
    const value = parsed.data
    const terms = value.query.normalize('NFKC').toLowerCase().split(/\s+/u)
    const entries: OfficeKnowledgeCitation[] = []
    let hasMore = false
    for (const row of this.domain.global.get().publications) {
      const file = this.visible(actor, row)
      if (!file) continue
      for (const [index, unit] of row.chunks.entries()) {
        const normalized = unit.text.normalize('NFKC').toLowerCase()
        if (!terms.every(term => normalized.includes(term))) continue
        if (entries.length === value.limit) { hasMore = true; break }
        const next = { file, revision: row.revision, chunk: index, ...unit }
        if (resultBytes({ query: value.query, entries: [...entries, next], hasMore: true })
          > this.policy.maxResponseBytes) {
          if (!entries.length) throw new OfficeError('context_too_large', 'A knowledge citation exceeds the complete response limit')
          hasMore = true
          break
        }
        entries.push(next)
      }
      if (hasMore) break
    }
    const result = { query: value.query, entries, hasMore }
    this.bounded(result)
    return result
  }

  /**
   * Reopen a citation with fresh source authority and exact publication identity.
   * @param actor - Current authenticated employee.
   * @param input - Previously disclosed source version/digest, publication revision and chunk position.
   * @returns Current exact body and position, or a denial after withdrawal, replacement or revocation.
   */
  citation(actor: OfficeMember, input: OfficeKnowledgeCitationInput): OfficeKnowledgeCitation {
    const parsed = officeKnowledgeSchemas.citation.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid knowledge citation')
    const value = parsed.data
    const row = this.domain.global.get().publications.find(entry => entry.file.id === value.fileId)
    const file = row ? this.visible(actor, row) : undefined
    const unit = row?.chunks[value.chunk]
    if (!row || !file || !unit) throw new OfficeError('not_found', 'Knowledge citation is unavailable')
    if (row.revision !== value.revision || file.versionId !== value.versionId || file.sha256 !== value.sha256)
      throw new OfficeError('conflict', 'Knowledge citation source changed')
    const result = { file, revision: row.revision, chunk: value.chunk, ...unit }
    this.bounded(result)
    return result
  }

  private publisher(actor: OfficeMember): void {
    if (!actor.active || actor.role !== 'admin' && actor.role !== 'manager') throw new OfficeError('forbidden', 'Knowledge publishing requires a current publisher')
  }
  private retry(actor: OfficeMember, requestId: string, hash: string) {
    const found = this.domain.global.get().receipts.find(row => row.actorId === actor.id && row.requestId === requestId)
    if (found && found.fingerprint !== hash) throw new OfficeError('conflict', 'Knowledge retry input changed')
    return found
  }
  private visible(actor: OfficeMember, row: z.infer<typeof publication>): OfficeConversationFileReference | undefined {
    if (row.withdrawn) return undefined
    try {
      const current = this.source.authorize(actor, row.file)
      return sameSource(current, row.file) ? current : undefined
    } catch (error) {
      if (error instanceof OfficeError && ['not_found', 'forbidden', 'conflict'].includes(error.code)) return undefined
      throw error
    }
  }
  private bounded(value: object): void {
    if (resultBytes(value) > this.policy.maxResponseBytes)
      throw new OfficeError('context_too_large', 'Complete knowledge response exceeds its byte limit')
  }
  private async commit(value: z.infer<typeof state>, signal: AbortSignal): Promise<void> {
    if (value.receipts.length > 100000 || Buffer.byteLength(JSON.stringify(value)) > this.policy.maxIndexBytes)
      throw new OfficeError('context_too_large', 'Knowledge index retention is full')
    const parsed = state.safeParse(value)
    if (!parsed.success) throw new OfficeError('conflict', 'Knowledge index is inconsistent')
    signal.throwIfAborted()
    await this.domain.global.set(parsed.data)
  }
}
