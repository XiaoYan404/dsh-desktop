/** File associations and immutable submitted evidence use their own domain; released association schemas stay intact. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMember, officeMemberId } from './spec.ts'
import { officeDriveRequestSchemas as drive } from './drive.ts'
import { officeConversationLinkSchemas as links } from './conversation-links.ts'
import type {
  OfficeConversationCaptureInput, OfficeConversationFileReference, OfficeConversationFiles, OfficeConversationFilesCapture,
  OfficeConversationFilesCaptureId, OfficeConversationFilesInput, OfficeConversationFileLimits, OfficeDriveVersionId, OfficeMember,
} from './types.ts'

/** Submitted-file protocol bounds are identical at admission, discovery and content reads. */
export const officeConversationFileLimits: OfficeConversationFileLimits = {
  protocol: 1, maxSelectedFiles: 20, maxTextBytes: 1024 * 1024, maxCharacters: 16384,
}
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[a-f\d]{64}$/u)
const versionId = z.uuid().transform(value => brandString<OfficeDriveVersionId>(value))
const coordinates = z.object({ id: drive.id, versionId }).strict()
const reference = coordinates.extend({ name: z.string().min(1).max(255), mediaType: z.string().min(1).max(200),
  byteLength: counter, sha256: digest }).strict()
const promptIdentity = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/u)
const captureId = z.uuid().transform(value => brandString<OfficeConversationFilesCaptureId>(value))
const selection = z.object({ conversationId: links.conversationId, revision: counter, requestId: z.uuid().nullable(),
  updatedAt: counter.nullable(), files: z.array(reference).max(officeConversationFileLimits.maxSelectedFiles)
    .refine(rows => new Set(rows.map(row => row.id)).size === rows.length).readonly() }).strict()
const input = z.object({ conversationId: links.conversationId, revision: counter, requestId: z.uuid(),
  files: z.array(coordinates).max(officeConversationFileLimits.maxSelectedFiles)
    .refine(rows => new Set(rows.map(row => row.id)).size === rows.length) }).strict()
const prepare = z.object({ conversationId: links.conversationId, revision: counter, requestId: promptIdentity }).strict()
const body = z.object({ format: z.literal(1), id: captureId, requestId: promptIdentity, memberId: officeMemberId,
  role: officeMember.shape.role, capturedAt: counter, selection }).strict()
const capture = body.extend({ digest }).strict().refine(({ digest: expected, ...value }) => hash(value) === expected)
const entry = z.object({ ownerId: officeMemberId, fingerprint: digest, selection }).strict().refine((value) => {
  const row = value.selection
  return row.revision > 0 && row.requestId !== null && row.updatedAt !== null && hash({
    conversationId: row.conversationId, revision: row.revision - 1, requestId: row.requestId,
    files: row.files.map(file => ({ id: file.id, versionId: file.versionId })),
  }) === value.fingerprint
})
const captured = z.object({ fingerprint: digest, capture }).strict().refine(value => hash({
  conversationId: value.capture.selection.conversationId, revision: value.capture.selection.revision,
  requestId: value.capture.requestId,
}) === value.fingerprint)
const state = z.object({ entries: z.array(entry).max(10000), captures: z.array(captured).max(10000) }).strict()
  .superRefine((value, ctx) => {
    const entries = value.entries.map(row => JSON.stringify([row.ownerId, row.selection.conversationId]))
    const retries = value.entries.map(row => JSON.stringify([row.ownerId, row.selection.requestId]))
    const captures = value.captures.map(row => JSON.stringify([row.capture.memberId,
      row.capture.selection.conversationId, row.capture.requestId]))
    if (new Set(entries).size !== entries.length || new Set(retries).size !== retries.length ||
      new Set(captures).size !== captures.length || new Set(value.captures.map(row => row.capture.id)).size !== captures.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate file association or submitted context identity' })
  })

/** Strict admission shared by the authority, gateway and employee Host. */
export const officeConversationFileSchemas = {
  input, prepare, captureId,
  read: z.object({ captureId, fileId: drive.id, offset: counter.max(officeConversationFileLimits.maxTextBytes),
    maxCharacters: z.number().int().min(1).max(officeConversationFileLimits.maxCharacters) }).strict(),
  readPdf: z.object({ captureId, fileId: drive.id, pageNumber: z.number().int().min(1).max(2000),
    offset: counter.max(2 * 1024 * 1024),
    maxCharacters: z.number().int().min(1).max(officeConversationFileLimits.maxCharacters) }).strict(),
  readDocx: z.object({ captureId, fileId: drive.id, offset: counter.max(2 * 1024 * 1024),
    maxCharacters: z.number().int().min(1).max(officeConversationFileLimits.maxCharacters) }).strict(),
  readXlsx: z.object({ captureId, fileId: drive.id, sheetNumber: z.number().int().min(1).max(256),
    offset: counter.max(1000000), maxCells: z.number().int().min(1).max(256) }).strict(),
}

/** Independent versioned storage preserves all existing office domain files and native Session formats. */
export const officeConversationFilesDomain = defineDomain({
  name: 'enterprise_office_conversation_files', version: 1,
  global: { schema: state, initial: { entries: [], captures: [] } }, tables: {},
})

/** The office queue supplies current membership and resolves every reference against current ancestor permissions. */
export class OfficeConversationFilesRepository {
  constructor(
    private readonly domain: Domain<typeof officeConversationFilesDomain>,
    private readonly resolve: (actor: OfficeMember, file: z.infer<typeof coordinates>) => OfficeConversationFileReference,
    private readonly changed: () => Promise<void>,
  ) {}

  /**
   * Retain the original employee directory for historical private evidence.
   * @param members - Configured and retained employees, including inactive accounts.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    const ids = new Set(members.map(member => member.id))
    const value = this.domain.global.get()
    if (value.entries.some(row => !ids.has(row.ownerId)) || value.captures.some(row => !ids.has(row.capture.memberId)))
      throw new OfficeError('conflict', 'Conversation files require their original employee directory')
  }

  /**
   * Read this employee's reviewed metadata without granting any file access.
   * @param actor - Current active employee supplied by the queue.
   * @param conversationId - Logical native conversation; carries no authorization by itself.
   * @returns Private versioned selection, including an empty unsaved selection.
   */
  view(actor: OfficeMember, conversationId: OfficeConversationFiles['conversationId']): OfficeConversationFiles {
    const parsed = links.conversationId.safeParse(conversationId)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid file conversation identity')
    return this.domain.global.get().entries.find(row =>
      row.ownerId === actor.id && row.selection.conversationId === parsed.data)?.selection ??
      { conversationId: parsed.data, revision: 0, requestId: null, updatedAt: null, files: [] }
  }

  /**
   * Save reviewed immutable coordinates after resolving trusted metadata and current permission.
   * @param actor - Current active employee, rechecked by the owning authority queue.
   * @param request - Optimistic selection and stable retry UUID.
   * @returns Committed selection; exact current retries preserve its original revision and metadata.
   */
  async save(actor: OfficeMember, request: OfficeConversationFilesInput): Promise<OfficeConversationFiles> {
    const parsed = input.safeParse(request)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid conversation file selection')
    const value = parsed.data
    const fingerprint = hash(value)
    const current = this.domain.global.get()
    const retry = current.entries.find(row => row.ownerId === actor.id && row.selection.requestId === value.requestId)
    if (retry) {
      if (retry.fingerprint !== fingerprint) throw new OfficeError('conflict', 'Conversation file retry changed')
      return retry.selection
    }
    const previous = this.view(actor, value.conversationId)
    if (previous.revision !== value.revision || value.revision === Number.MAX_SAFE_INTEGER)
      throw new OfficeError('conflict', 'Review the current conversation file selection')
    const next: OfficeConversationFiles = { conversationId: value.conversationId, revision: value.revision + 1,
      requestId: value.requestId, updatedAt: Date.now(), files: value.files.map(file => this.resolve(actor, file)) }
    const record = { ownerId: actor.id, fingerprint, selection: next }
    const entries = previous.revision > 0 ? current.entries.map(row =>
      row.ownerId === actor.id && row.selection.conversationId === value.conversationId ? record : row) : [...current.entries, record]
    await this.commit({ ...current, entries })
    await this.changed()
    return next
  }

  /**
   * Capture the exact reviewed version before native inbox admission, with fresh file authorization.
   * @param actor - Current active employee.
   * @param request - Reviewed selection version and native request identity.
   * @returns Original immutable evidence on exact retry; neither admission nor dispatch is implied.
   */
  async prepare(actor: OfficeMember, request: OfficeConversationCaptureInput): Promise<OfficeConversationFilesCapture> {
    const parsed = prepare.safeParse(request)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid file context preparation')
    const value = parsed.data
    const fingerprint = hash(value)
    const current = this.domain.global.get()
    const retry = current.captures.find(row => row.capture.memberId === actor.id &&
      row.capture.selection.conversationId === value.conversationId && row.capture.requestId === value.requestId)
    if (retry) {
      if (retry.fingerprint !== fingerprint) throw new OfficeError('conflict', 'Prepared file context retry changed')
      if (retry.capture.role !== actor.role) throw new OfficeError('forbidden', 'Review file context after an authority change')
      for (const file of retry.capture.selection.files) this.resolve(actor, file)
      return retry.capture
    }
    const selected = this.view(actor, value.conversationId)
    if (selected.revision !== value.revision) throw new OfficeError('conflict', 'Review the current conversation files')
    for (const file of selected.files) this.resolve(actor, file)
    const normalized = body.parse({ format: 1, id: randomUUID(), requestId: value.requestId, memberId: actor.id,
      role: actor.role, capturedAt: Date.now(), selection: selected })
    const saved = { ...normalized, digest: hash(normalized) }
    await this.commit({ ...current, captures: [...current.captures, { fingerprint, capture: saved }] })
    return saved
  }

  /**
   * Locate submitted private evidence without letting administrator role bypass ownership.
   * @param actor - Current active employee.
   * @param id - Server-issued evidence identity, never a bearer credential.
   * @returns Retained evidence only for its original employee and current authority role.
   */
  read(actor: OfficeMember, id: OfficeConversationFilesCaptureId): OfficeConversationFilesCapture {
    const parsed = captureId.safeParse(id)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid file context identity')
    const found = this.domain.global.get().captures.find(row =>
      row.capture.memberId === actor.id && row.capture.id === parsed.data)?.capture
    if (!found) throw new OfficeError('not_found', 'Prepared file context not found')
    if (found.role !== actor.role) throw new OfficeError('forbidden', 'Review file context after an authority change')
    return found
  }

  private async commit(value: z.infer<typeof state>): Promise<void> {
    if (value.entries.length > 10000 || value.captures.length > 10000 || Buffer.byteLength(JSON.stringify(value)) > 64 * 1024 * 1024)
      throw new OfficeError('conversation_capacity', 'Conversation file retention is full')
    await this.domain.global.set(value)
  }
}

function hash(value: object): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
