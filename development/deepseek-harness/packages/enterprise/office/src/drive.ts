/** Enterprise metadata authorization never delegates to native workspace filesystem access. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import {
  OFFICE_DRIVE_MAX_FILE_BYTES,
  OFFICE_DRIVE_OWNER_BYTES,
} from './drive-blobs.ts'
import type { OfficeDriveBlob, OfficeDriveBlobStore } from './drive-blobs.ts'
import type {
  OfficeDriveAccess,
  OfficeDriveEntry,
  OfficeDriveFolderInput,
  OfficeDriveId,
  OfficeDriveLocation,
  OfficeDriveHistory,
  OfficeDriveLifecycleInput,
  OfficeDrivePermissionsInput,
  OfficeDriveQuery,
  OfficeDriveRenameInput,
  OfficeDriveSpace,
  OfficeDriveView,
  OfficeDriveTrash,
  OfficeDriveTrashEntry,
  OfficeDrivePurgeInput,
  OfficeDrivePurgePlan,
  OfficeDrivePurgeReceipt,
  OfficeDrivePurgeRequestId,
  OfficeMemberId,
  OfficeMember,
} from './types.ts'
import type { OfficeDriveDownload, OfficeDriveUploadDeclaration, OfficeDriveUploadInput, OfficeDriveVersionId } from './types.ts'

const id = z.uuid().transform(value => brandString<OfficeDriveId>(value))
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.number().int().nonnegative()
const access = z.enum(['deny', 'view', 'edit'])
const defaultAccess = z.enum(['inherit', 'deny', 'view', 'edit'])
const space = z.enum(['private', 'shared'])
const name = z
  .string()
  .trim()
  .normalize('NFC')
  .min(1)
  .max(255)
  .refine(
    value =>
      value !== '.' &&
      value !== '..' &&
      !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(value) &&
      !/[. ]$/.test(value) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value),
    'Invalid Windows-compatible name',
  )
const grant = z.object({ memberId: officeMemberId, access }).strict()
const location = z.object({ space, folderId: id.nullable() })
const query = location.extend({ search: z.string().trim().max(200) }).strict()
const folderInput = location.extend({ name }).strict()
const renameInput = z.object({ id, revision, name }).strict()
const permissionsInput = z
  .object({ id, revision, defaultAccess, grants: z.array(grant).max(500) })
  .strict()
const versionId = z.uuid().transform(value => brandString<OfficeDriveVersionId>(value))
const lifecycleInput = z.object({ id, revision, action: z.enum(['trash', 'restore']), name: name.optional() }).strict()
  .refine(value => value.action === 'restore' || value.name === undefined, 'Only restoration may change the name')
const purgeInput = z.object({ id, revision, digest: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.uuid().transform(value => brandString<OfficeDrivePurgeRequestId>(value)) }).strict()
const purge = z.object({ rootId: id, actorId: officeMemberId, requestId: purgeInput.shape.requestId,
  digest: purgeInput.shape.digest, reviewedRevision: revision, nodeRevision: revision,
  requestedAt: timestamp, completedAt: timestamp.nullable() }).strict()
const uploadInput = folderInput
  .extend({
    requestId: z.uuid(),
    mediaType: z
      .string()
      .max(200)
      .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i),
    byteLength: z.number().int().nonnegative().max(OFFICE_DRIVE_MAX_FILE_BYTES),
    dataBase64: z.string().max(Math.ceil(OFFICE_DRIVE_MAX_FILE_BYTES / 3) * 4),
  })
  .strict()

/** Shared boundary validators keep gateway admission aligned with actual drive operations. */
export const officeDriveRequestSchemas = {
  id,
  query,
  folderInput,
  renameInput,
  permissionsInput,
  uploadInput,
  versionId,
  lifecycleInput,
  purgeInput,
}

const version = z
  .object({
    id: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().nonnegative(),
    mediaType: z.string().min(1).max(200),
    createdAt: timestamp,
    actorId: officeMemberId,
    requestId: z.uuid().optional(),
    requestFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
const node = z
  .object({
    id,
    parentId: id.nullable(),
    space,
    ownerId: officeMemberId,
    kind: z.enum(['folder', 'file']),
    name,
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
    defaultAccess,
    grants: z.array(grant).readonly(),
    versions: z.array(version).readonly(),
    deletedAt: timestamp.nullable(),
    purge: purge.optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (
      (entry.kind === 'folder') !== (entry.versions.length === 0) ||
      new Set(entry.grants.map(item => item.memberId)).size !==
        entry.grants.length ||
      entry.grants.some(item => item.memberId === entry.ownerId) ||
      (entry.space === 'private' &&
        (entry.defaultAccess !== 'inherit' || entry.grants.length > 0))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid drive entry content or conditions',
      })
    }
  })
const audit = z
  .object({
    revision,
    actorId: officeMemberId,
    targetId: id,
    time: timestamp,
    action: z.enum([
      'folder_created',
      'renamed',
      'permissions_changed',
      'file_uploaded',
      'file_updated',
      'trashed',
      'restored',
      'purge_requested',
      'purged',
    ]),
  })
  .strict()
const state = z
  .object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    nodes: z.array(node).readonly(),
    audit: z.array(audit).readonly(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const nodes = new Map(value.nodes.map(entry => [entry.id, entry]))
    const siblings = new Set<string>()
    if (nodes.size !== value.nodes.length || value.nodes.length > 20_000)
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate or excessive drive identities',
      })
    for (const entry of value.nodes) {
      const chain = new Set<OfficeDriveId>([entry.id])
      let parent = entry.parentId
      while (parent) {
        const ancestor = nodes.get(parent)
        if (
          !ancestor ||
          ancestor.kind !== 'folder' ||
          ancestor.space !== entry.space ||
          (entry.space === 'private' && ancestor.ownerId !== entry.ownerId) ||
          chain.has(parent) ||
          chain.size >= 128
        ) {
          ctx.addIssue({ code: 'custom', message: 'Invalid drive ancestry' })
          break
        }
        chain.add(parent)
        parent = ancestor.parentId
      }
      if (entry.deletedAt === null) {
        const key = JSON.stringify([
          entry.space,
          entry.space === 'private' ? entry.ownerId : '',
          entry.parentId,
          entry.name.toLowerCase(),
        ])
        if (siblings.has(key))
          ctx.addIssue({ code: 'custom', message: 'Duplicate sibling name' })
        siblings.add(key)
      }
    }
    if (
      value.audit.some(
        entry =>
          entry.revision > value.revision || !nodes.has(entry.targetId),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid drive audit reference',
      })
    validatePurgeGroups(value, (message) => { ctx.addIssue({ code: 'custom', message }) })
  })

/** Authoritative directory and ACL data; immutable file objects have opaque version ids. */
export const officeDriveDomain = defineDomain({
  name: 'enterprise_office_drive',
  version: 1,
  global: { schema: state, initial: { revision: 0, nodes: [], audit: [] } },
  tables: {},
})
type DriveNode = z.infer<typeof node>
type DriveState = z.infer<typeof state>

// A stable, explicit field order binds the reviewed bytes and conditions across serialization/restart.
function purgeDigest(rootId: OfficeDriveId, entries: readonly DriveNode[]): string {
  return createHash('sha256').update(JSON.stringify({ rootId, nodes: [...entries]
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(entry => ({ id: entry.id, parentId: entry.parentId,
      space: entry.space, ownerId: entry.ownerId, kind: entry.kind, name: entry.name,
      revision: entry.purge?.nodeRevision ?? entry.revision, createdAt: entry.createdAt,
      defaultAccess: entry.defaultAccess, grants: [...entry.grants]
        .sort((a, b) => a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0)
        .map(item => ({ memberId: item.memberId, access: item.access })),
      versions: entry.versions.map(item => ({ id: item.id, sha256: item.sha256, byteLength: item.byteLength,
        mediaType: item.mediaType, createdAt: item.createdAt, actorId: item.actorId,
        requestId: item.requestId, requestFingerprint: item.requestFingerprint })) })) })).digest('hex')
}

function purgeCounts(entries: readonly DriveNode[]) {
  return { files: entries.filter(entry => entry.kind === 'file').length,
    folders: entries.filter(entry => entry.kind === 'folder').length,
    versions: entries.reduce((sum, entry) => sum + entry.versions.length, 0),
    byteLength: entries.reduce((sum, entry) => sum + entry.versions.reduce((bytes, item) => bytes + item.byteLength, 0), 0) }
}

function validatePurgeGroups(value: { readonly nodes: readonly DriveNode[] }, issue: (message: string) => void): void {
  const nodes = new Map(value.nodes.map(entry => [entry.id, entry]))
  const groups = new Map<OfficeDriveId, DriveNode[]>()
  for (const entry of value.nodes) {
    if (!entry.purge) continue
    const record = entry.purge
    if (entry.deletedAt === null || entry.ownerId !== record.actorId
      || entry.revision !== record.nodeRevision + (record.completedAt === null ? 1 : 2)
      || (record.completedAt !== null && record.completedAt < record.requestedAt)) issue('Invalid drive cleanup record')
    const group = groups.get(record.rootId) ?? []
    group.push(entry)
    groups.set(record.rootId, group)
  }
  const requests = new Set<string>()
  for (const [rootId, entries] of groups) {
    const root = nodes.get(rootId)
    const record = root?.purge
    if (!record || record.rootId !== rootId || record.nodeRevision !== record.reviewedRevision
      || requests.has(record.requestId) || purgeDigest(rootId, entries) !== record.digest) {
      issue('Invalid drive cleanup scope')
      continue
    }
    requests.add(record.requestId)
    for (const entry of entries) {
      const item = entry.purge
      if (!item) { issue('Missing drive cleanup receipt'); continue }
      if (item.actorId !== record.actorId || item.requestId !== record.requestId || item.digest !== record.digest
        || item.reviewedRevision !== record.reviewedRevision || item.requestedAt !== record.requestedAt
        || item.completedAt !== record.completedAt) issue('Inconsistent drive cleanup receipt')
      let current: DriveNode | undefined = entry
      const visited = new Set<OfficeDriveId>()
      while (current && current.id !== rootId && !visited.has(current.id)) {
        visited.add(current.id)
        current = current.parentId === null ? undefined : nodes.get(current.parentId)
      }
      if (current?.id !== rootId) issue('Invalid drive cleanup ancestry')
    }
  }
}

/** Serialized by OfficeService together with membership changes; no independent writer is admitted. */
export class OfficeDriveRepository {
  private readonly indexes = new WeakMap<
    DriveState,
    ReadonlyMap<OfficeDriveId, DriveNode>
  >()
  private readonly childIndexes = new WeakMap<DriveState, ReadonlyMap<OfficeDriveId, readonly DriveNode[]>>()
  constructor(
    private readonly domain: Domain<typeof officeDriveDomain>,
    private readonly changed: () => Promise<void>,
    private readonly blobs: OfficeDriveBlobStore,
    private readonly limits: { maxFileBytes: number, ownerQuotaBytes: number } = { maxFileBytes: OFFICE_DRIVE_MAX_FILE_BYTES, ownerQuotaBytes: OFFICE_DRIVE_OWNER_BYTES },
    private readonly reservedBytes: (actorId: OfficeMember['id'], exceptRequest?: string) => number = () => 0,
    private readonly cleanupFailed: (error: unknown) => void = () => {},
  ) {}

  /**
   * List a folder or search only visible descendants, with no owner/admin bypass of a hidden parent.
   * @param actor - Active employee resolved inside the office authority boundary.
   * @param input - Root/folder and optional nonempty search text.
   * @returns Safe metadata and breadcrumbs.
   */
  view(actor: OfficeMember, input: OfficeDriveQuery): OfficeDriveView {
    const parsed = query.safeParse(input)
    if (!parsed.success)
      throw new OfficeError(
        'invalid_input',
        'Invalid drive location or search',
      )
    const location = parsed.data
    const state = this.domain.global.get()
    const parent = this.folder(state, actor, location)
    const search = location.search.toLowerCase()
    const entries = state.nodes
      .filter(
        entry =>
          entry.space === location.space &&
          entry.deletedAt === null &&
          (search
            ? entry.name.toLowerCase().includes(search) &&
              (parent === null ||
                this.chain(state, entry).some(
                  item => item.id === parent.id && item.id !== entry.id,
                ))
            : entry.parentId === location.folderId) &&
          this.access(state, actor, entry) !== 'deny',
      )
      .map(entry => this.project(state, actor, entry))
      .sort(
        (a, b) =>
          Number(b.kind === 'folder') - Number(a.kind === 'folder') ||
          a.name.localeCompare(b.name),
      )
    return {
      revision: state.revision,
      meId: actor.id,
      location: { space: location.space, folderId: location.folderId },
      path: parent
        ? this.chain(state, parent).map(entry =>
          this.project(state, actor, entry),
        )
        : [],
      entries,
      canCreate:
        (parent
          ? this.access(state, actor, parent)
          : this.rootAccess(actor, location.space)) === 'edit',
      maxFileBytes: Math.min(OFFICE_DRIVE_MAX_FILE_BYTES, this.limits.maxFileBytes),
      lifecycle: 1,
      cleanup: 1,
      quota: { usedBytes: this.usedBytes(state, actor.id), reservedBytes: this.reservedBytes(actor.id),
        limitBytes: this.limits.ownerQuotaBytes },
    }
  }

  /**
   * Create a real directory record after checking its current parent permissions.
   * @param actor - Active employee checked in the shared mutation queue.
   * @param input - Canonical Windows-compatible name and destination.
   * @returns Durable, authorized folder metadata.
   */
  async createFolder(
    actor: OfficeMember,
    input: OfficeDriveFolderInput,
  ): Promise<OfficeDriveEntry> {
    const parsed = folderInput.safeParse(input)
    if (!parsed.success)
      throw new OfficeError('invalid_input', 'Invalid folder name or location')
    const state = this.domain.global.get()
    const parent = this.folder(state, actor, parsed.data)
    this.requireEdit(
      parent
        ? this.access(state, actor, parent)
        : this.rootAccess(actor, parsed.data.space),
    )
    this.requireName(state, actor, parsed.data, parsed.data.name)
    if (
      state.nodes.length >= 20_000 ||
      (parent && this.chain(state, parent).length >= 127)
    )
      throw new OfficeError('invalid_input', 'Drive directory limit reached')
    const now = Date.now()
    const entry: DriveNode = {
      id: brandString<OfficeDriveId>(randomUUID()),
      parentId: parsed.data.folderId,
      space: parsed.data.space,
      ownerId: actor.id,
      kind: 'folder',
      name: parsed.data.name,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      defaultAccess: 'inherit',
      grants: [],
      versions: [],
      deletedAt: null,
    }
    await this.commit(
      state,
      [...state.nodes, entry],
      actor,
      entry,
      'folder_created',
    )
    return this.project(this.domain.global.get(), actor, entry)
  }

  /**
   * Store verified file bytes before publishing directory metadata; exact retries do not duplicate files.
   * @param actor - Active employee checked in the shared authority queue.
   * @param input - Bounded encoded bytes, original length and a stable retry identity.
   * @returns Committed file metadata; a rejected metadata commit may leave an unreachable object.
   */
  async upload(actor: OfficeMember, input: OfficeDriveUploadInput): Promise<OfficeDriveEntry> {
    const parsed = uploadInput.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid file upload or size')
    const value = parsed.data
    const data = Buffer.from(value.dataBase64, 'base64')
    if (data.byteLength !== value.byteLength || data.toString('base64') !== value.dataBase64) {
      throw new OfficeError('invalid_input', 'Encoded file content or length is invalid')
    }
    const declaration: OfficeDriveUploadDeclaration = {
      space: value.space, folderId: value.folderId, name: value.name, requestId: value.requestId,
      byteLength: value.byteLength, mediaType: value.mediaType, sha256: createHash('sha256').update(data).digest('hex'),
    }
    const existing = this.prepareUpload(actor, declaration)
    if (existing !== null) return existing
    return this.publishUpload(actor, declaration, await this.blobs.write(data))
  }

  /**
   * Recheck the destination, name and quota before staging or publishing bytes.
   * @param actor - Active employee held by the office mutation queue.
   * @param value - Validated immutable upload declaration.
   * @returns An identical committed retry, or null when new publication is admitted.
   */
  prepareUpload(actor: OfficeMember, value: OfficeDriveUploadDeclaration): OfficeDriveEntry | null {
    const state = this.domain.global.get()
    const target = value.target ? this.read(state, actor, value.target.id) : null
    const parent = this.folder(state, actor, value)
    if (target) {
      if (target.kind !== 'file' || target.space !== value.space || target.parentId !== value.folderId || target.name !== value.name)
        throw new OfficeError('conflict', 'The reviewed file location changed')
      this.requireEdit(this.access(state, actor, target))
    } else this.requireEdit(parent ? this.access(state, actor, parent) : this.rootAccess(actor, value.space))
    const fingerprint = this.uploadFingerprint(actor, value)
    const existing = state.nodes.find(entry => entry.versions.some(version => version.requestId === value.requestId))
    if (existing !== undefined) {
      const content = existing.versions.find(version => version.requestId === value.requestId)
      const matches = content?.requestFingerprint !== undefined ? content.requestFingerprint === fingerprint
        : value.target === undefined && existing.space === value.space && existing.parentId === value.folderId
          && existing.name === value.name
          && content?.sha256 === value.sha256 && content.byteLength === value.byteLength && content.mediaType === value.mediaType
      if (content?.actorId !== actor.id || existing.deletedAt !== null || !matches || target && target.id !== existing.id) {
        throw new OfficeError('conflict', 'Upload retry payload changed')
      }
      return this.project(state, actor, this.read(state, actor, existing.id))
    }
    if (target && value.target) this.requireRevision(target, value.target.revision)
    else this.requireName(state, actor, value, value.name)
    const ownerId = target?.ownerId ?? actor.id
    const used = this.usedBytes(state, ownerId)
    if (value.byteLength > this.limits.maxFileBytes
      || used + this.reservedBytes(ownerId, value.requestId) + value.byteLength > this.limits.ownerQuotaBytes
      || target === null && (state.nodes.length >= 20_000 || parent !== null && this.chain(state, parent).length >= 127)) {
      throw new OfficeError('invalid_input', 'Drive quota, file size or directory limit reached')
    }
    return null
  }

  /**
   * Publish bytes already made immutable by the authorized upload owner.
   * @param actor - Current employee inside the shared mutation queue.
   * @param value - Previously validated declaration, rechecked for current access and quota.
   * @param blob - Durably verified object matching that declaration.
   * @returns A committed entry, with stable request identity across uncertain metadata acknowledgements.
   */
  async publishUpload(actor: OfficeMember, value: OfficeDriveUploadDeclaration, blob: OfficeDriveBlob): Promise<OfficeDriveEntry> {
    if (blob.byteLength !== value.byteLength || blob.sha256 !== value.sha256) {
      throw new OfficeError('conflict', 'Immutable upload does not match its declaration')
    }
    const existing = this.prepareUpload(actor, value)
    if (existing !== null) return existing
    const state = this.domain.global.get()
    const now = Date.now()
    const content = { ...blob, mediaType: value.mediaType, actorId: actor.id, createdAt: now,
      requestId: value.requestId, requestFingerprint: this.uploadFingerprint(actor, value) }
    if (value.target) {
      const previous = this.read(state, actor, value.target.id)
      const updated = { ...previous, revision: previous.revision + 1, updatedAt: now, versions: [...previous.versions, content] }
      await this.commit(state, state.nodes.map(entry => entry.id === previous.id ? updated : entry), actor, updated, 'file_updated')
      return this.project(this.domain.global.get(), actor, updated)
    }
    const entry: DriveNode = {
      id: brandString<OfficeDriveId>(randomUUID()), parentId: value.folderId, space: value.space, ownerId: actor.id,
      kind: 'file', name: value.name, revision: 1, createdAt: now, updatedAt: now, defaultAccess: 'inherit', grants: [], deletedAt: null,
      versions: [content],
    }
    await this.commit(state, [...state.nodes, entry], actor, entry, 'file_uploaded')
    return this.project(this.domain.global.get(), actor, entry)
  }

  /**
   * Select one authorized immutable version without exposing its filesystem coordinate.
   * @param actor - Current employee held by the authority queue.
   * @param target - Logical file identity.
   * @param versionId - Reviewed immutable version; omission selects the latest version.
   * @returns Safe entry metadata and internal version metadata for a bounded byte provider.
   */
  fileVersion(
    actor: OfficeMember, target: OfficeDriveId, versionId?: OfficeDriveVersionId,
  ): { entry: OfficeDriveEntry; blob: OfficeDriveBlob & { readonly mediaType: string } } {
    if (!id.safeParse(target).success) throw new OfficeError('invalid_input', 'Invalid drive identity')
    const state = this.domain.global.get()
    const entry = this.read(state, actor, target)
    const blob = versionId === undefined ? entry.versions.at(-1) : entry.versions.find(version => version.id === versionId)
    if (entry.kind !== 'file' || blob === undefined) throw new OfficeError('not_found', 'File version is unavailable')
    return { entry: this.project(state, actor, entry), blob }
  }

  /**
   * Check internal references before collecting staged objects, including retained deleted versions.
   * @param objectId - Server-owned immutable object identity.
   * @returns The retaining logical file identity, or null for an unpublished object.
   */
  referencedFile(objectId: string): OfficeDriveId | null {
    return this.domain.global.get().nodes.find(entry => entry.versions.some(version => version.id === objectId))?.id ?? null
  }

  /**
   * Exclude a durably published request from pending-byte reservations even if its receipt update failed.
   * @param requestId - Stable upload retry identity.
   * @returns Whether the directory already retains the corresponding version.
   */
  retainsRequest(requestId: string): boolean {
    return this.domain.global.get().nodes.some(entry => entry.versions.some(version => version.requestId === requestId))
  }

  /**
   * Charge pending replacement bytes to the stable file owner, independently of the editing employee.
   * @param actorId - Uploading employee used for a newly created file.
   * @param value - Retained upload declaration, optionally bound to an existing file.
   * @returns The quota owner; a missing retained target rejects the detached reservation.
   */
  uploadQuotaOwner(actorId: OfficeMemberId, value: OfficeDriveUploadDeclaration): OfficeMemberId {
    if (!value.target) return actorId
    const entry = this.index(this.domain.global.get()).get(value.target.id)
    if (!entry || entry.kind !== 'file') throw new OfficeError('conflict', 'Upload reservation lost its file')
    return entry.ownerId
  }

  /**
   * Read history without changing the current head or granting access to hidden ancestors.
   * @param actor - Current active reader.
   * @param target - Logical file whose versions remain immutable.
   * @returns Authorized metadata ordered newest first, without request fingerprints.
   */
  history(actor: OfficeMember, target: OfficeDriveId): OfficeDriveHistory {
    if (!id.safeParse(target).success) throw new OfficeError('invalid_input', 'Invalid drive identity')
    const state = this.domain.global.get()
    const entry = this.read(state, actor, target)
    if (entry.kind !== 'file') throw new OfficeError('invalid_input', 'Only files have content versions')
    return { entry: this.project(state, actor, entry), versions: entry.versions.map((version, index) => ({
      versionId: brandString<OfficeDriveVersionId>(version.id), sha256: version.sha256, byteLength: version.byteLength,
      mediaType: version.mediaType, createdAt: version.createdAt, actorId: version.actorId,
      current: index === entry.versions.length - 1,
    })).reverse() }
  }

  /**
   * List only this owner's deleted roots whose retained parent is still visible.
   * @param actor - Current active employee; administrative roles do not bypass private ownership.
   * @returns Recoverable metadata without revealing descendants of hidden or deleted ancestors.
   */
  trash(actor: OfficeMember): OfficeDriveTrash {
    const state = this.domain.global.get()
    return { revision: state.revision, meId: actor.id, entries: state.nodes
      .filter(entry => entry.deletedAt !== null && entry.ownerId === actor.id
        && (entry.purge === undefined || entry.purge.completedAt === null)
        && this.access(state, actor, { ...entry, deletedAt: null }) !== 'deny')
      .map(entry => this.trashEntry(state, actor, entry)).sort((a, b) => b.deletedAt - a.deletedAt) }
  }

  /**
   * Soft-delete or restore one reviewed owner record while keeping every immutable version.
   * @param actor - Current employee inside the serialized office queue.
   * @param input - Exact revision, action and optional conflict-resolving restore name.
   * @returns Committed metadata; failures leave names, quota, children and bytes unchanged.
   */
  async lifecycle(actor: OfficeMember, input: OfficeDriveLifecycleInput): Promise<OfficeDriveEntry | OfficeDriveTrashEntry> {
    const parsed = lifecycleInput.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid drive lifecycle action')
    const value = parsed.data
    const state = this.domain.global.get()
    const entry = this.index(state).get(value.id)
    if (!entry) throw new OfficeError('not_found', 'Drive entry is unavailable')
    if (entry.purge) throw new OfficeError('conflict', 'Approved cleanup cannot be restored')
    const projected = value.action === 'restore' ? this.trashEntry(state, actor, entry) : this.project(state, actor, entry)
    if (!projected.canTrash) throw new OfficeError('forbidden', 'Only an owner with an editable parent may change the lifecycle')
    this.requireRevision(entry, value.revision)
    const restoredName = value.name ?? entry.name
    if (value.action === 'restore') this.requireName(state, actor,
      { space: entry.space, folderId: entry.parentId }, restoredName, entry.id)
    const now = Date.now()
    const next = { ...entry, revision: entry.revision + 1, updatedAt: now,
      deletedAt: value.action === 'trash' ? now : null, name: restoredName }
    await this.commit(state, state.nodes.map(item => item.id === entry.id ? next : item), actor, next,
      value.action === 'trash' ? 'trashed' : 'restored')
    return value.action === 'trash' ? this.trashEntry(this.domain.global.get(), actor, next)
      : this.project(this.domain.global.get(), actor, next)
  }

  private trashEntry(state: DriveState, actor: OfficeMember, entry: DriveNode): OfficeDriveTrashEntry {
    if (entry.deletedAt === null || entry.ownerId !== actor.id) throw new OfficeError('not_found', 'Deleted entry is unavailable')
    const projected = this.project(state, actor, { ...entry, deletedAt: null, purge: undefined })
    let canPurge = false
    if (!entry.purge && projected.canTrash) {
      try { this.purgeScope(state, actor, entry); canPurge = true }
      catch (error) { if (!(error instanceof OfficeError)) throw error }
    }
    return { ...projected, canUpdate: false, canRename: false, canManageAccess: false,
      canTrash: projected.canTrash === true && entry.purge === undefined, canPurge,
      deletedAt: entry.deletedAt, ...(entry.purge ? { purge: this.purgeReceipt(state, entry) } : {}) }
  }

  /**
   * Review the exact owner-only subtree before irreversible cleanup; no bytes are touched.
   * @param actor - Current active owner with an editable, visible parent.
   * @param target - Deleted root identity.
   * @returns Current metadata, scope digest and totals bound to the confirmation.
   */
  purgePlan(actor: OfficeMember, target: OfficeDriveId): OfficeDrivePurgePlan {
    const state = this.domain.global.get()
    const root = this.purgeOwner(state, actor, target)
    const entry = this.trashEntry(state, actor, root)
    if (!entry.canPurge) throw new OfficeError('forbidden', 'This deleted subtree cannot be permanently cleared')
    const scope = this.purgeScope(state, actor, root)
    return { entry, digest: purgeDigest(root.id, scope), ...purgeCounts(scope) }
  }

  /**
   * Durably approve the reviewed scope before attempting deletion; exact retries remain idempotent.
   * @param actor - Active authenticated owner; roles do not bypass ownership.
   * @param input - Original reviewed revision, digest and stable request identity.
   * @returns Durable pending or completed receipt; pending bytes continue to consume quota.
   */
  async purge(actor: OfficeMember, input: OfficeDrivePurgeInput): Promise<OfficeDrivePurgeReceipt> {
    const parsed = purgeInput.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid drive cleanup confirmation')
    const value = parsed.data
    const state = this.domain.global.get()
    const root = this.purgeOwner(state, actor, value.id)
    if (root.purge) {
      if (root.purge.rootId !== root.id || root.purge.requestId !== value.requestId
        || root.purge.digest !== value.digest || root.purge.reviewedRevision !== value.revision)
        throw new OfficeError('conflict', 'Cleanup confirmation does not match the approved request')
      return this.retryPurge(actor, root.id)
    }
    const plan = this.purgePlan(actor, root.id)
    this.requireRevision(root, value.revision)
    if (plan.digest !== value.digest || state.nodes.some(entry => entry.purge?.requestId === value.requestId))
      throw new OfficeError('conflict', 'Cleanup scope changed or the request identity is already used')
    const scope = this.purgeScope(state, actor, root)
    if (scope.some(entry => entry.revision > Number.MAX_SAFE_INTEGER - 2))
      throw new OfficeError('conflict', 'Drive revision limit reached')
    const ids = new Set(scope.map(entry => entry.id))
    const now = Date.now()
    const nodes = state.nodes.map(entry => ids.has(entry.id) ? { ...entry, revision: entry.revision + 1,
      updatedAt: now, deletedAt: entry.deletedAt ?? now, purge: { rootId: root.id, actorId: actor.id,
        requestId: value.requestId, digest: value.digest, reviewedRevision: value.revision,
        nodeRevision: entry.revision, requestedAt: now, completedAt: null } } : entry)
    await this.commit(state, nodes, actor, root, 'purge_requested')
    return this.retryPurge(actor, root.id)
  }

  /**
   * Read a prior owner's cleanup receipt without opening bytes or admitting another deletion.
   * @param actor - Current active owner.
   * @param target - Original deleted root identity.
   * @returns Existing approval status, or null for a currently visible recoverable root.
   */
  purgeStatus(actor: OfficeMember, target: OfficeDriveId): OfficeDrivePurgeReceipt | null {
    const state = this.domain.global.get()
    const root = this.purgeOwner(state, actor, target)
    if (root.purge) {
      if (root.purge.rootId !== root.id) throw new OfficeError('not_found', 'Cleanup root is unavailable')
      return this.purgeReceipt(state, root)
    }
    this.trashEntry(state, actor, root)
    return null
  }

  /**
   * Continue only an already durable approval; a completed receipt performs no additional writes.
   * @param actor - Active owner of the original approval.
   * @param target - Original cleanup root identity.
   * @returns Latest durable outcome, retaining quota until the completion commit succeeds.
   */
  async retryPurge(actor: OfficeMember, target: OfficeDriveId): Promise<OfficeDrivePurgeReceipt> {
    const root = this.purgeOwner(this.domain.global.get(), actor, target)
    if (!root.purge || root.purge.rootId !== root.id) throw new OfficeError('not_found', 'Cleanup approval is unavailable')
    try { await this.finishPurge(root.id) }
    catch (error) { this.cleanupFailed(error) }
    const current = this.domain.global.get()
    const updated = this.index(current).get(root.id)
    if (!updated) throw new OfficeError('conflict', 'Cleanup receipt is unavailable')
    return this.purgeReceipt(current, updated)
  }

  /**
   * Recover pending approved cleanups during startup or scheduled serialized maintenance.
   * @returns After each durable approval has been attempted independently; errors remain pending and are reported.
   */
  async sweepPurges(): Promise<void> {
    for (const root of this.domain.global.get().nodes.filter(entry => entry.purge?.rootId === entry.id
      && entry.purge.completedAt === null)) {
      try { await this.finishPurge(root.id) }
      catch (error) { this.cleanupFailed(error) }
    }
  }

  private usedBytes(state: DriveState, ownerId: OfficeMemberId): number {
    return state.nodes.filter(entry => entry.ownerId === ownerId && entry.purge?.completedAt == null)
      .reduce((sum, entry) => sum + entry.versions.reduce((bytes, item) => bytes + item.byteLength, 0), 0)
  }

  private purgeOwner(state: DriveState, actor: OfficeMember, target: OfficeDriveId): DriveNode {
    if (!id.safeParse(target).success) throw new OfficeError('invalid_input', 'Invalid drive identity')
    const root = this.index(state).get(target)
    if (!root || root.ownerId !== actor.id || root.deletedAt === null)
      throw new OfficeError('not_found', 'Deleted entry is unavailable')
    return root
  }

  private purgeScope(state: DriveState, actor: OfficeMember, root: DriveNode): readonly DriveNode[] {
    let children = this.childIndexes.get(state)
    if (!children) {
      const next = new Map<OfficeDriveId, DriveNode[]>()
      for (const entry of state.nodes) {
        if (entry.parentId === null) continue
        const siblings = next.get(entry.parentId) ?? []
        siblings.push(entry)
        next.set(entry.parentId, siblings)
      }
      children = next
      this.childIndexes.set(state, children)
    }
    const scope: DriveNode[] = []
    const pending = [root]
    while (pending.length) {
      const entry = pending.pop()
      if (!entry || entry.purge?.completedAt != null) continue
      if (entry.ownerId !== actor.id || entry.purge !== undefined)
        throw new OfficeError('forbidden', 'Cleanup includes another owner or an existing pending approval')
      scope.push(entry)
      pending.push(...children.get(entry.id) ?? [])
    }
    return scope
  }

  private purgeReceipt(state: DriveState, root: DriveNode): OfficeDrivePurgeReceipt {
    const record = root.purge
    if (!record) throw new OfficeError('conflict', 'Cleanup approval is unavailable')
    return { id: root.id, requestId: record.requestId, status: record.completedAt === null ? 'pending' : 'completed',
      requestedAt: record.requestedAt, completedAt: record.completedAt,
      ...purgeCounts(state.nodes.filter(entry => entry.purge?.rootId === root.id)) }
  }

  private async finishPurge(target: OfficeDriveId): Promise<void> {
    const state = this.domain.global.get()
    const root = this.index(state).get(target)
    if (!root?.purge || root.purge.completedAt !== null) return
    const scope = state.nodes.filter(entry => entry.purge?.rootId === target)
    if (purgeDigest(target, scope) !== root.purge.digest)
      throw new OfficeError('conflict', 'Saved cleanup scope no longer matches its approval')
    const protectedObjects = new Set(state.nodes.filter(entry => entry.purge?.rootId !== target
      && entry.purge?.completedAt == null).flatMap(entry => entry.versions.map(item => item.id)))
    for (const objectId of new Set(scope.flatMap(entry => entry.versions.map(item => item.id)))) {
      if (!protectedObjects.has(objectId)) await this.blobs.remove(objectId)
    }
    const now = Math.max(Date.now(), root.purge.requestedAt)
    const nodes = state.nodes.map(entry => entry.purge?.rootId === target
      ? { ...entry, revision: entry.revision + 1, updatedAt: now, purge: { ...entry.purge, completedAt: now } } : entry)
    await this.commit(state, nodes, { id: root.purge.actorId }, root, 'purged')
  }

  private uploadFingerprint(actor: OfficeMember, value: OfficeDriveUploadDeclaration): string {
    return createHash('sha256').update(JSON.stringify({ actorId: actor.id, space: value.space, folderId: value.folderId,
      name: value.name, mediaType: value.mediaType, byteLength: value.byteLength, sha256: value.sha256, target: value.target })).digest('hex')
  }


  /**
   * Read bytes only after resolving current membership and every ancestor's access.
   * @param actor - Active employee held in the shared authority queue during this read.
   * @param target - Opaque file identity, never a native path or caller-supplied object reference.
   * @returns Verified content and digest of the current immutable version.
   */
  async download(
    actor: OfficeMember,
    target: OfficeDriveId,
  ): Promise<OfficeDriveDownload> {
    if (!id.safeParse(target).success)
      throw new OfficeError('invalid_input', 'Invalid drive identity')
    const entry = this.read(this.domain.global.get(), actor, target)
    const content = entry.versions.at(-1)
    if (entry.kind !== 'file' || !content)
      throw new OfficeError('invalid_input', 'Only a file can be downloaded')
    const data = await this.blobs.read(content)
    return {
      id: entry.id,
      name: entry.name,
      mediaType: content.mediaType,
      byteLength: content.byteLength,
      sha256: content.sha256,
      dataBase64: data.toString('base64'),
    }
  }

  /**
   * Rename an editable entry only when its parent also permits changing directory names.
   * @param actor - Active employee checked in the shared mutation queue.
   * @param input - Opaque target, reviewed version and new name.
   * @returns Durable metadata, or an unchanged directory after denial/conflict.
   */
  async rename(
    actor: OfficeMember,
    input: OfficeDriveRenameInput,
  ): Promise<OfficeDriveEntry> {
    const parsed = renameInput.safeParse(input)
    if (!parsed.success)
      throw new OfficeError('invalid_input', 'Invalid drive rename')
    const state = this.domain.global.get()
    const entry = this.read(state, actor, parsed.data.id)
    this.requireRevision(entry, parsed.data.revision)
    this.requireEdit(this.access(state, actor, entry))
    this.requireEdit(
      entry.parentId
        ? this.access(state, actor, this.read(state, actor, entry.parentId))
        : this.rootAccess(actor, entry.space),
    )
    this.requireName(
      state,
      actor,
      { space: entry.space, folderId: entry.parentId },
      parsed.data.name,
      entry.id,
    )
    if (entry.name === parsed.data.name)
      return this.project(state, actor, entry)
    const next = {
      ...entry,
      name: parsed.data.name,
      revision: entry.revision + 1,
      updatedAt: Date.now(),
    }
    await this.commit(
      state,
      state.nodes.map(item => (item.id === entry.id ? next : item)),
      actor,
      next,
      'renamed',
    )
    return this.project(this.domain.global.get(), actor, next)
  }

  /**
   * Set shared conditions through entry ownership, never a self-edited department or job label.
   * @param actor - Active authenticated employee.
   * @param input - Reviewed target and complete replacement conditions.
   * @param members - Authoritative retained employee directory.
   * @returns Durable metadata with owner-only conditions.
   */
  async permissions(
    actor: OfficeMember,
    input: OfficeDrivePermissionsInput,
    members: readonly OfficeMember[],
  ): Promise<OfficeDriveEntry> {
    const parsed = permissionsInput.safeParse(input)
    if (!parsed.success)
      throw new OfficeError('invalid_input', 'Invalid drive conditions')
    const state = this.domain.global.get()
    const entry = this.read(state, actor, parsed.data.id)
    if (entry.space !== 'shared' || entry.ownerId !== actor.id)
      throw new OfficeError(
        'forbidden',
        'Only a shared entry owner may change its conditions',
      )
    this.requireRevision(entry, parsed.data.revision)
    if (
      new Set(parsed.data.grants.map(item => item.memberId)).size !==
        parsed.data.grants.length ||
      parsed.data.grants.some(
        item =>
          item.memberId === actor.id ||
          !members.some(
            member => member.id === item.memberId && member.active,
          ),
      )
    )
      throw new OfficeError(
        'invalid_input',
        'Conditions require distinct active coworkers',
      )
    const next = {
      ...entry,
      defaultAccess: parsed.data.defaultAccess,
      grants: parsed.data.grants,
      revision: entry.revision + 1,
      updatedAt: Date.now(),
    }
    await this.commit(
      state,
      state.nodes.map(item => (item.id === entry.id ? next : item)),
      actor,
      next,
      'permissions_changed',
    )
    return this.project(this.domain.global.get(), actor, next)
  }

  private rootAccess(
    actor: OfficeMember,
    space: OfficeDriveSpace,
  ): OfficeDriveAccess {
    return space === 'private' || actor.role === 'admin' ? 'edit' : 'view'
  }
  private index(state: DriveState): ReadonlyMap<OfficeDriveId, DriveNode> {
    let index = this.indexes.get(state)
    if (!index) {
      index = new Map(state.nodes.map(entry => [entry.id, entry]))
      this.indexes.set(state, index)
    }
    return index
  }
  private chain(state: DriveState, entry: DriveNode): DriveNode[] {
    const result: DriveNode[] = []
    const visited = new Set<OfficeDriveId>()
    let current = entry
    while (true) {
      if (visited.has(current.id) || result.length >= 128)
        throw new OfficeError('not_found', 'Drive ancestry is unavailable')
      visited.add(current.id)
      result.unshift(current)
      if (!current.parentId) break
      const parent = this.index(state).get(current.parentId)
      if (!parent)
        throw new OfficeError('not_found', 'Drive ancestry is unavailable')
      current = parent
    }
    return result
  }
  private access(
    state: DriveState,
    actor: OfficeMember,
    entry: DriveNode,
  ): OfficeDriveAccess {
    if (entry.space === 'private' && entry.ownerId !== actor.id) return 'deny'
    let effective = this.rootAccess(actor, entry.space)
    for (const ancestor of this.chain(state, entry)) {
      if (effective === 'deny' || ancestor.deletedAt !== null) return 'deny'
      effective =
        ancestor.ownerId === actor.id
          ? 'edit'
          : (ancestor.grants.find(item => item.memberId === actor.id)
            ?.access ??
            (ancestor.defaultAccess === 'inherit'
              ? effective
              : ancestor.defaultAccess))
    }
    return effective
  }
  private read(
    state: DriveState,
    actor: OfficeMember,
    target: OfficeDriveId,
  ): DriveNode {
    const entry = this.index(state).get(target)
    if (!entry || this.access(state, actor, entry) === 'deny')
      throw new OfficeError('not_found', 'Drive entry is unavailable')
    return entry
  }
  private folder(
    state: DriveState,
    actor: OfficeMember,
    location: OfficeDriveLocation,
  ): DriveNode | null {
    if (location.folderId === null) return null
    const entry = this.read(state, actor, location.folderId)
    if (entry.kind !== 'folder' || entry.space !== location.space)
      throw new OfficeError('not_found', 'Drive folder is unavailable')
    return entry
  }
  private project(
    state: DriveState,
    actor: OfficeMember,
    entry: DriveNode,
  ): OfficeDriveEntry {
    const permission = this.access(state, actor, entry)
    if (permission === 'deny')
      throw new OfficeError('not_found', 'Drive entry is unavailable')
    const canManageAccess =
      entry.space === 'shared' && entry.ownerId === actor.id
    const parent = entry.parentId
      ? this.read(state, actor, entry.parentId)
      : null
    const content = entry.versions.at(-1)
    return {
      id: entry.id,
      parentId: entry.parentId,
      space: entry.space,
      ownerId: entry.ownerId,
      kind: entry.kind,
      name: entry.name,
      revision: entry.revision,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      byteLength: content?.byteLength ?? 0,
      mediaType: content?.mediaType ?? '',
      access: permission,
      canRename:
        permission === 'edit' &&
        (parent
          ? this.access(state, actor, parent)
          : this.rootAccess(actor, entry.space)) === 'edit',
      canManageAccess,
      canUpdate: entry.kind === 'file' && permission === 'edit',
      canTrash: entry.ownerId === actor.id && permission === 'edit' &&
        (parent ? this.access(state, actor, parent) : this.rootAccess(actor, entry.space)) === 'edit',
      ...(canManageAccess
        ? { defaultAccess: entry.defaultAccess, grants: entry.grants }
        : {}),
    }
  }
  private requireEdit(permission: OfficeDriveAccess): void {
    if (permission !== 'edit')
      throw new OfficeError('forbidden', 'This folder is read-only')
  }
  private requireRevision(entry: DriveNode, expected: number): void {
    if (entry.revision !== expected || expected === Number.MAX_SAFE_INTEGER)
      throw new OfficeError(
        'conflict',
        'Drive entry changed; read it before editing',
      )
  }
  private requireName(
    state: DriveState,
    actor: OfficeMember,
    location: OfficeDriveLocation,
    name: string,
    except?: OfficeDriveId,
  ): void {
    if (
      state.nodes.some(
        entry =>
          entry.id !== except &&
          entry.deletedAt === null &&
          entry.space === location.space &&
          entry.parentId === location.folderId &&
          (location.space === 'shared' || entry.ownerId === actor.id) &&
          entry.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new OfficeError('conflict', 'A sibling already has this name')
  }
  private async commit(
    state: DriveState,
    nodes: readonly DriveNode[],
    actor: Pick<OfficeMember, 'id'>,
    target: DriveNode,
    action: DriveState['audit'][number]['action'],
  ): Promise<void> {
    if (state.revision === Number.MAX_SAFE_INTEGER)
      throw new OfficeError('conflict', 'Drive revision limit reached')
    const revision = state.revision + 1
    const next = {
      revision,
      nodes,
      audit: [
        ...state.audit,
        {
          revision,
          actorId: actor.id,
          targetId: target.id,
          time: Date.now(),
          action,
        },
      ],
    }
    // Validate new ancestry and identities before the durable boundary, as well as on reopen.
    if (!officeDriveDomain.global.schema.safeParse(next).success)
      throw new OfficeError('invalid_input', 'Invalid drive state')
    await this.domain.global.set(next)
    await this.changed()
  }
}
