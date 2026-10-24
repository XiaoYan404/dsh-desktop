/** First-password invitations retain issuance and revocation hashes independently of existing identity records. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMember, officeMemberId } from './spec.ts'
import type { OfficeMember, OfficeMemberId, OfficeMemberInvite, OfficeMemberInviteConfig,
  OfficeMemberInviteIssueInput, OfficeMemberInviteIssueReceipt, OfficeMemberInviteRevokeInput,
  OfficeMemberInviteView, OfficeMemberInviteId } from './types.ts'

const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const id = z.uuid().transform(value => brandString<OfficeMemberInviteId>(value))
const code = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
const policy = z.object({ maxTtlMs: positive, maxEntries: positive.max(10000), maxBytes: positive.max(268435456) }).strict()

/** Optional complete deployment limits; omission of the containing option keeps the domain closed. */
export const officeMemberInviteConfig: Schema<OfficeMemberInviteConfig> = Schema.object({
  maxTtlMs: Schema.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxEntries: Schema.natural().min(1).max(10000).required(),
  maxBytes: Schema.natural().min(1).max(268435456).required(),
})

const issue = z.object({ requestId: z.uuid(), memberId: officeMemberId,
  expectedRole: officeMember.shape.role, expiresAt: stamp }).strict()
const revoke = z.object({ id, revision: positive }).strict()
const accept = z.object({ code, newPassword: z.string().min(15).max(1024) }).strict()
/** Strict wire and queued admission; an acceptance cannot choose its member or authorization role. */
export const officeMemberInviteSchemas = { issue, revoke, accept, memberId: officeMemberId }

const entry = z.object({ id, revision: positive, requestId: z.uuid(), fingerprint: digest, memberId: officeMemberId,
  role: officeMember.shape.role, issuedBy: officeMemberId, issuedAt: stamp, expiresAt: stamp, tokenHash: digest,
  revokedAt: stamp.nullable(), revokedBy: officeMemberId.nullable() }).strict().superRefine((value, ctx) => {
  if (value.expiresAt <= value.issuedAt || (value.revokedAt === null) !== (value.revokedBy === null)
    || value.fingerprint !== fingerprint({ memberId: value.memberId, expectedRole: value.role, expiresAt: value.expiresAt }))
    ctx.addIssue({ code: 'custom', message: 'Invalid invitation lifetime, revocation or issuance identity' })
})
const state = z.object({ revision: stamp, entries: z.array(entry).max(10000).readonly() }).strict().superRefine((value, ctx) => {
  const unique = (values: readonly string[]) => new Set(values).size === values.length
  if (!unique(value.entries.map(row => row.id)) || !unique(value.entries.map(row => row.tokenHash))
    || !unique(value.entries.map(row => JSON.stringify([row.issuedBy, row.requestId])))
    || !unique(value.entries.filter(row => row.revokedAt === null).map(row => row.memberId))
    || value.entries.some(row => row.revision > value.revision))
    ctx.addIssue({ code: 'custom', message: 'Duplicate or invalid invitation records' })
})

/** New independent issuance/revocation ledger; existing identity, Office and Native formats remain unchanged. */
export const officeMemberInvitesDomain = defineDomain({
  name: 'enterprise_office_member_invites', version: 1,
  global: { schema: state, initial: { revision: 0, entries: [] } }, tables: {},
})

/**
 * Validate explicit deployment limits before opening the invitation domain.
 * @param input - Complete configured lifetime, retained-entry and JSON-byte limits.
 * @returns Finite validated policy; no defaults or implicit feature enablement.
 */
export function resolveOfficeMemberInviteConfig(input: OfficeMemberInviteConfig): OfficeMemberInviteConfig {
  const parsed = policy.safeParse(input)
  if (!parsed.success) throw new OfficeError('invalid_input', 'Member invitations require complete positive limits')
  return parsed.data
}

/** Current directory and credential presence are supplied by the one Office authority owner. */
export interface OfficeMemberInviteAccess {
  members(this: void): readonly OfficeMember[]
  enrolled(this: void, memberId: OfficeMemberId): boolean
}

/** The Office queue owns mutation ordering; accepting a code writes only the original identity domain. */
export class OfficeMemberInvitesRepository {
  constructor(private readonly domain: Domain<typeof officeMemberInvitesDomain>,
    private readonly limits: OfficeMemberInviteConfig, private readonly access: OfficeMemberInviteAccess) {}

  /** Restore only with the original retained directory, including inactive historical actors. */
  verifyDirectory(): void {
    const members = new Set(this.access.members().map(member => member.id))
    if (this.domain.global.get().entries.some(row => !members.has(row.memberId) || !members.has(row.issuedBy)
      || row.revokedBy !== null && !members.has(row.revokedBy)))
      throw new OfficeError('conflict', 'Member invitations require their original employee directory')
  }

  /**
   * Inspect one member's latest invitation without returning its secret or hash.
   * @param actorId - Current active administrator, rechecked by the caller's serialized authority.
   * @param memberId - Existing retained member whose invitation is being managed.
   * @returns Independent current facts; credential presence does not claim one invitation was accepted.
   */
  view(actorId: OfficeMemberId, memberId: OfficeMemberId): OfficeMemberInviteView {
    this.admin(actorId)
    const member = this.member(memberId)
    const row = this.domain.global.get().entries.findLast(value => value.memberId === memberId)
    const now = Date.now()
    const issuer = row && this.access.members().find(value => value.id === row.issuedBy)
    const credentialPresent = this.access.enrolled(memberId)
    const expired = !!row && now >= row.expiresAt
    const revoked = !!row && row.revokedAt !== null
    const requiresReview = !member.active || !!row && (now < row.issuedAt || row.role !== member.role
      || !issuer?.active || issuer.role !== 'admin')
    return { protocol: 1, memberId, invitation: row ? metadata(row) : null, credentialPresent, expired, revoked,
      requiresReview, canAccept: !!row && !credentialPresent && !expired && !revoked && !requiresReview }
  }

  /**
   * Commit a new hashed code and revoke the prior current invitation in the same ledger write.
   * @param actorId - Current active administrator.
   * @param input - Reviewed existing member/role, future expiry and stable issuance UUID.
   * @returns The raw code only on the first committed response; exact retries return metadata alone.
   */
  async issue(actorId: OfficeMemberId, input: OfficeMemberInviteIssueInput): Promise<OfficeMemberInviteIssueReceipt> {
    this.admin(actorId)
    const parsed = issue.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid member invitation issuance')
    const value = parsed.data
    const current = this.domain.global.get()
    const hash = fingerprint(value)
    const retry = current.entries.find(row => row.issuedBy === actorId && row.requestId === value.requestId)
    if (retry) {
      if (retry.fingerprint !== hash) throw new OfficeError('conflict', 'Invitation retry changed its reviewed fields')
      return { invitation: metadata(retry) }
    }
    const member = this.member(value.memberId)
    if (!member.active || member.role !== value.expectedRole)
      throw new OfficeError('conflict', 'Review the current active member and role before inviting')
    if (this.access.enrolled(member.id)) throw new OfficeError('conflict', 'This member already has sign-in credentials')
    const now = Date.now()
    if (value.expiresAt <= now || value.expiresAt - now > this.limits.maxTtlMs)
      throw new OfficeError('invalid_input', 'Invitation expiry is outside its configured lifetime')
    const raw = randomBytes(32).toString('base64url')
    const row: z.infer<typeof entry> = { id: brandString<OfficeMemberInviteId>(randomUUID()), revision: 1,
      requestId: value.requestId, fingerprint: hash, memberId: member.id, role: member.role, issuedBy: actorId,
      issuedAt: now, expiresAt: value.expiresAt, tokenHash: tokenHash(raw), revokedAt: null, revokedBy: null }
    const entries = current.entries.map(previous => previous.memberId === member.id && previous.revokedAt === null
      ? { ...previous, revision: nextRevision(previous.revision), revokedAt: now, revokedBy: actorId } : previous)
    await this.commit(current, [...entries, row])
    return { invitation: metadata(row), code: raw }
  }

  /**
   * Revoke a reviewed code without removing or changing a password already set through any path.
   * @param actorId - Current active administrator.
   * @param input - Exact invitation identity and observed revision.
   * @returns Retained revocation metadata; an exact already-revoked retry remains readable.
   */
  async revoke(actorId: OfficeMemberId, input: OfficeMemberInviteRevokeInput): Promise<OfficeMemberInvite> {
    this.admin(actorId)
    const parsed = revoke.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid member invitation revocation')
    const current = this.domain.global.get()
    const row = current.entries.find(value => value.id === parsed.data.id)
    if (!row) throw new OfficeError('not_found', 'Member invitation not found')
    if (row.revokedAt !== null) return metadata(row)
    if (row.revision !== parsed.data.revision) throw new OfficeError('conflict', 'Member invitation changed after review')
    if (this.access.enrolled(row.memberId)) throw new OfficeError('conflict', 'The member already has credentials; revoking a code cannot remove them')
    const updated = { ...row, revision: nextRevision(row.revision), revokedAt: Date.now(), revokedBy: actorId }
    await this.commit(current, current.entries.map(value => value.id === row.id ? updated : value))
    return metadata(updated)
  }

  /**
   * Authenticate only first-password enrollment, without granting a normal Office session or a caller-selected identity.
   * @param raw - Exact limited code; all unavailable, expired, revoked and enrolled cases share one denial.
   * @returns The current active target id; the identity owner must recheck inside its final commit queue.
   */
  authorize(raw: string): OfficeMemberId {
    if (!code.safeParse(raw).success) throw this.denied()
    const hash = tokenHash(raw)
    const row = this.domain.global.get().entries.find(value => value.tokenHash === hash)
    const now = Date.now()
    const member = row && this.access.members().find(value => value.id === row.memberId)
    const issuer = row && this.access.members().find(value => value.id === row.issuedBy)
    if (!row || row.revokedAt !== null || now < row.issuedAt || now >= row.expiresAt
      || !member?.active || member.role !== row.role || !issuer?.active || issuer.role !== 'admin'
      || this.access.enrolled(member.id)) throw this.denied()
    return member.id
  }

  /**
   * Irreversibly revoke every outstanding code before offboarding or a reviewed role change.
   * @param actorId - Current administrator; invoked inside the original office queue.
   * @param memberId - Retained target identity, including one that already has a credential.
   * @returns Number of newly revoked codes; no credential or invitation body is changed.
   */
  async revokeForMember(actorId: OfficeMemberId, memberId: OfficeMemberId): Promise<number> {
    this.admin(actorId)
    this.member(memberId)
    const current = this.domain.global.get()
    const entries = current.entries.filter(row => row.memberId === memberId && row.revokedAt === null)
    if (!entries.length) return 0
    const now = Date.now()
    await this.commit(current, current.entries.map(row => entries.includes(row)
      ? { ...row, revision: nextRevision(row.revision), revokedAt: now, revokedBy: actorId } : row))
    return entries.length
  }

  /**
   * Read a bounded administrator page without codes, token hashes or false acceptance claims.
   * @param actorId - Current administrator.
   * @param before - Exclusive issuance/id coordinate, or null for the newest page.
   * @param limit - Explicit bounded batch size.
   * @returns Current metadata and stable continuation; expiry/enrollment remain independent facts.
   */
  page(actorId: OfficeMemberId, before: { readonly issuedAt: number; readonly id: string } | null, limit: number) : {
        entries: OfficeMemberInvite[];
        next: {
            issuedAt: number;
            id: OfficeMemberInviteId;
        } | null;
    } {
    this.admin(actorId)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || before !== null
      && (!Number.isSafeInteger(before.issuedAt) || before.issuedAt < 0 || !z.uuid().safeParse(before.id).success))
      throw new OfficeError('invalid_input', 'Invalid member invitation page')
    const ordered = [...this.domain.global.get().entries].sort((left, right) => right.issuedAt - left.issuedAt
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    const remaining = before === null ? ordered : ordered.filter(row => row.issuedAt < before.issuedAt
      || row.issuedAt === before.issuedAt && row.id > before.id)
    const entries = remaining.slice(0, limit).map(metadata)
    const last = entries.at(-1)
    return { entries, next: remaining.length > entries.length && last ? { issuedAt: last.issuedAt, id: last.id } : null }
  }

  private member(id: OfficeMemberId): OfficeMember {
    const member = this.access.members().find(value => value.id === id)
    if (!member) throw new OfficeError('not_found', 'Member not found')
    return member
  }
  private admin(id: OfficeMemberId): void {
    const member = this.access.members().find(value => value.id === id)
    if (!member?.active || member.role !== 'admin') throw new OfficeError('forbidden', 'Only an administrator may manage invitations')
  }
  private denied(): OfficeError { return new OfficeError('unauthenticated', 'The invitation is unavailable; request a current code from an administrator') }
  private async commit(current: z.infer<typeof state>, entries: z.infer<typeof state>['entries']): Promise<void> {
    const next = { revision: nextRevision(current.revision), entries }
    if (entries.length > this.limits.maxEntries || Buffer.byteLength(JSON.stringify(next)) > this.limits.maxBytes)
      throw new OfficeError('conversation_capacity', 'Member invitation retention is full; review its configured capacity')
    await this.domain.global.set(next)
  }
}

function metadata(row: z.infer<typeof entry>): OfficeMemberInvite {
  return { id: row.id, revision: row.revision, memberId: row.memberId, role: row.role, issuedBy: row.issuedBy,
    issuedAt: row.issuedAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt, revokedBy: row.revokedBy }
}
function fingerprint(value: Pick<OfficeMemberInviteIssueInput, 'memberId' | 'expectedRole' | 'expiresAt'>): string {
  return createHash('sha256').update(JSON.stringify({ memberId: value.memberId, expectedRole: value.expectedRole,
    expiresAt: value.expiresAt })).digest('hex')
}
function tokenHash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function nextRevision(value: number): number {
  if (value === Number.MAX_SAFE_INTEGER) throw new OfficeError('conflict', 'Member invitation revision is exhausted')
  return value + 1
}
