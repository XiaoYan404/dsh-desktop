/** Durable sign-in primitives for an office-only gateway, independent of native Agent GUI authority. */
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import type {
  OfficeIdentityOverview,
  OfficeLoginInput,
  OfficeLoginResult,
  OfficeMember,
  OfficeMemberId,
  OfficePasswordChangeInput,
  OfficeSessionId,
  OfficeSessionInfo,
} from './types.ts'

const SESSION_MS = 8 * 60 * 60 * 1000
const MAX_SESSIONS = 5
const SCHEME = 'scrypt-131072-8-1'
const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const secret = z.string().min(15).max(1024)
const loginInput = z
  .object({ memberId: officeMemberId, password: z.string().min(1).max(1024) })
  .strict()
const passwordChange = z
  .object({ currentPassword: z.string().min(1).max(1024), newPassword: secret })
  .strict()
const sessionId = z
  .uuid()
  .transform(value => brandString<OfficeSessionId>(value))
const credential = z
  .object({
    memberId: officeMemberId,
    revision,
    scheme: z.literal(SCHEME),
    salt: z.string().regex(/^[a-f0-9]{32}$/),
    digest: z.string().regex(/^[a-f0-9]{128}$/),
    createdAt: stamp,
    updatedAt: stamp,
  })
  .strict()
const session = z
  .object({
    id: sessionId,
    memberId: officeMemberId,
    credentialRevision: revision,
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: stamp,
    expiresAt: stamp,
  })
  .strict()
  .refine(value => value.expiresAt - value.createdAt === SESSION_MS)
const audit = z
  .object({
    revision,
    actorId: officeMemberId,
    targetId: officeMemberId,
    time: stamp,
    action: z.enum([
      'initialized',
      'credential_set',
      'password_changed',
      'signed_in',
      'signed_out',
      'session_revoked',
    ]),
  })
  .strict()
const state = z
  .object({
    initialized: z.boolean(),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    credentials: z.array(credential).readonly(),
    sessions: z.array(session).readonly(),
    audit: z.array(audit).max(1000).readonly(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const credentials = new Map(
      value.credentials.map(entry => [entry.memberId, entry]),
    )
    if (
      credentials.size !== value.credentials.length ||
      new Set(value.sessions.map(entry => entry.id)).size !==
        value.sessions.length ||
      new Set(value.sessions.map(entry => entry.tokenHash)).size !==
        value.sessions.length ||
      (value.initialized
        ? credentials.size === 0
        : credentials.size > 0 || value.sessions.length > 0) ||
      value.sessions.some(
        entry =>
          credentials.get(entry.memberId)?.revision !==
          entry.credentialRevision,
      ) ||
      value.audit.some(entry => entry.revision > value.revision)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid office identity references or initialization',
      })
    }
  })

/** Credentials and session hashes are authoritative and never enter an OfficeView projection. */
export const officeIdentityDomain = defineDomain({
  name: 'enterprise_office_identity',
  version: 1,
  global: {
    schema: state,
    initial: {
      initialized: false,
      revision: 0,
      credentials: [],
      sessions: [],
      audit: [],
    },
  },
  tables: {},
})
type IdentityState = z.infer<typeof state>
type Credential = z.infer<typeof credential>
type Session = z.infer<typeof session>

/** Trusted callbacks keep identity writes in the same queue as membership and business changes. */
export interface OfficeIdentityAccess {
  member(this: void, id: OfficeMemberId): OfficeMember
  members(this: void): readonly OfficeMember[]
  assertOpen(this: void): void
  assertSessionAccess?(this: void, member: OfficeMemberId): void
  enqueue<T>(this: void, operation: () => Promise<T>): Promise<T>
}

/** Backend-only identity operations; an HTTP adapter must bind business actors to authenticate() results. */
export class OfficeIdentityRepository {
  private hashing = 0
  private readonly waiting: Array<() => void> = []

  constructor(
    private readonly domain: Domain<typeof officeIdentityDomain>,
    private readonly access: OfficeIdentityAccess,
  ) {}

  /**
   * Ensure saved identities belong to the retained directory and retain a sign-in administrator.
   * @returns Normally, or fails closed without reseeding credentials or membership.
   */
  verifyDirectory(): void {
    const state = this.domain.global.get()
    if (!state.initialized) return
    const members = this.access.members()
    if (
      state.credentials.some(
        entry => !members.some(member => member.id === entry.memberId),
      ) ||
      !members.some(
        member =>
          member.active && member.role === 'admin' && this.enrolled(member.id),
      )
    ) {
      throw new OfficeError(
        'conflict',
        'Saved sign-in data requires its original directory and an enrolled active administrator',
      )
    }
  }

  /**
   * Check the additional last-administrator rule only after authentication has been initialized.
   * @param members - Proposed complete directory inside the office mutation queue.
   */
  checkAdministrators(members: readonly OfficeMember[]): void {
    if (
      this.domain.global.get().initialized &&
      !members.some(
        member =>
          member.active && member.role === 'admin' && this.enrolled(member.id),
      )
    ) {
      throw new OfficeError(
        'invalid_input',
        'Keep an active administrator with sign-in credentials',
      )
    }
  }

  /**
   * Bootstrap one existing administrator once; later startup values never reset its password.
   * @param administrator - Deployment-owned existing administrator id.
   * @param password - Initial password, supplied through the trusted server startup path.
   * @returns True only when first-run identity state was committed.
   */
  async initialize(
    administrator: OfficeMemberId,
    password: string,
  ): Promise<boolean> {
    this.access.assertOpen()
    if (this.domain.global.get().initialized) return false
    this.admin(administrator)
    const prepared = await this.prepare(password)
    return this.access.enqueue(async () => {
      const state = this.domain.global.get()
      if (state.initialized) return false
      this.admin(administrator)
      const now = Date.now()
      const entry: Credential = {
        memberId: administrator,
        revision: 1,
        scheme: SCHEME,
        ...prepared,
        createdAt: now,
        updatedAt: now,
      }
      await this.commit(
        state,
        { initialized: true, credentials: [entry], sessions: [] },
        administrator,
        administrator,
        'initialized',
      )
      return true
    })
  }

  /**
   * Enroll or reset an active employee through current administrator authority.
   * @param actor - Authenticated administrator supplied by the gateway.
   * @param target - Existing active employee.
   * @param password - Replacement password; old sessions are removed atomically with its hash.
   */
  async setPassword(
    actor: OfficeMemberId,
    target: OfficeMemberId,
    password: string,
  ): Promise<void> {
    this.access.assertOpen()
    this.admin(actor)
    this.access.member(target)
    const prepared = await this.prepare(password)
    await this.access.enqueue(async () => {
      this.admin(actor)
      this.access.member(target)
      const state = this.ready()
      const previous = state.credentials.find(
        entry => entry.memberId === target,
      )
      const now = Date.now()
      const entry: Credential = {
        memberId: target,
        revision: (previous?.revision ?? 0) + 1,
        scheme: SCHEME,
        ...prepared,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      }
      await this.commit(
        state,
        {
          credentials: [
            ...state.credentials.filter(item => item.memberId !== target),
            entry,
          ],
          sessions: state.sessions.filter(item => item.memberId !== target),
        },
        actor,
        target,
        'credential_set',
      )
    })
  }

  /**
   * Set a target's first password after limited invitation authorization, rechecked in the existing commit queue.
   * @param password - New password, hashed by the original bounded scrypt implementation.
   * @param authorize - Trusted Office-owned callback returning only the invitation's currently authorized target.
   * @param signal - Original request and Office lifetime cancellation; checked before the irreversible commit.
   * @returns Target identity after one original identity-domain commit; no normal session is created.
   */
  async enrollFirstPassword(password: string, authorize: () => OfficeMemberId, signal: AbortSignal): Promise<OfficeMemberId> {
    this.access.assertOpen()
    signal.throwIfAborted()
    this.ready()
    const target = authorize()
    if (this.enrolled(target)) throw this.denied()
    const prepared = await this.prepare(password)
    signal.throwIfAborted()
    return this.access.enqueue(async () => {
      signal.throwIfAborted()
      if (authorize() !== target || this.enrolled(target)) throw this.denied()
      this.active(target)
      const state = this.ready()
      const now = Date.now()
      const entry: Credential = { memberId: target, revision: 1, scheme: SCHEME, ...prepared, createdAt: now, updatedAt: now }
      await this.commit(state, { credentials: [...state.credentials, entry] }, target, target, 'credential_set')
      return target
    })
  }

  /**
   * Verify a password without trusting a caller-provided role or issuing a token before commit.
   * @param input - Employee id and exact password.
   * @returns A one-time plaintext token receipt for a trusted adapter; storage holds its hash only.
   */
  async login(input: OfficeLoginInput): Promise<OfficeLoginResult> {
    this.access.assertOpen()
    const parsed = loginInput.safeParse(input)
    if (!parsed.success) throw this.denied()
    const state = this.ready()
    const previous = state.credentials.find(
      entry => entry.memberId === parsed.data.memberId,
    )
    const digest = await this.derive(
      parsed.data.password,
      previous?.salt ?? '0'.repeat(32),
    )
    const matches = timingSafeEqual(
      digest,
      previous ? Buffer.from(previous.digest, 'hex') : Buffer.alloc(64),
    )
    if (!previous || !matches) throw this.denied()
    return this.access.enqueue(async () => {
      const current = this.ready()
      const saved = current.credentials.find(
        entry => entry.memberId === previous.memberId,
      )
      if (
        !saved ||
        saved.revision !== previous.revision ||
        saved.digest !== previous.digest
      )
        throw this.denied()
      const member = this.active(previous.memberId)
      this.access.assertSessionAccess?.(member.id)
      const token = randomBytes(32).toString('base64url')
      const now = Date.now()
      const session: Session = {
        id: brandString<OfficeSessionId>(randomUUID()),
        memberId: member.id,
        credentialRevision: saved.revision,
        tokenHash: this.hash(token),
        createdAt: now,
        expiresAt: now + SESSION_MS,
      }
      const retained = current.sessions.filter(
        entry => entry.expiresAt > now && entry.memberId !== member.id,
      )
      const own = current.sessions
        .filter(
          entry => entry.expiresAt > now && entry.memberId === member.id,
        )
        .slice(-(MAX_SESSIONS - 1))
      await this.commit(
        current,
        { sessions: [...retained, ...own, session] },
        member.id,
        member.id,
        'signed_in',
      )
      return { token, member, expiresAt: session.expiresAt }
    })
  }

  /**
   * Resolve only a durable, current session and re-read its member's active state and role.
   * @param token - Opaque bearer value from the authenticated request header.
   * @returns Current directory authority; expired, reset and disabled identities share one denial.
   */
  authenticate(token: string): OfficeMember {
    this.access.assertOpen()
    const member = this.active(this.resolve(token).memberId)
    this.access.assertSessionAccess?.(member.id)
    return member
  }

  /**
   * List only the authenticated employee's device sessions without returning bearer material.
   * @param token - Current bearer value.
   * @returns Unexpired own sessions and the current-session marker.
   */
  sessions(token: string): readonly OfficeSessionInfo[] {
    const me = this.authenticate(token)
    const current = this.resolve(token)
    return this.domain.global
      .get()
      .sessions.filter(
        entry => entry.memberId === me.id && entry.expiresAt > Date.now(),
      )
      .map(entry => ({
        id: entry.id,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        current: entry.id === current.id,
      }))
  }

  /**
   * Revoke the current token; a successful repeated logout has no further side effects.
   * @param token - Opaque bearer value, not an actor id.
   */
  logout(token: string): Promise<void> {
    return this.access.enqueue(async () => {
      const state = this.domain.global.get()
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return
      const hash = this.hash(token)
      const entry = state.sessions.find(item => item.tokenHash === hash)
      if (!entry) return
      await this.commit(
        state,
        { sessions: state.sessions.filter(item => item.id !== entry.id) },
        entry.memberId,
        entry.memberId,
        'signed_out',
      )
    })
  }

  /**
   * Let an authenticated employee revoke only a session from their own account.
   * @param token - Current bearer value.
   * @param id - Public own-session handle.
   */
  revoke(token: string, id: OfficeSessionId): Promise<void> {
    return this.access.enqueue(async () => {
      const me = this.active(this.resolve(token).memberId)
      const state = this.domain.global.get()
      const entry = state.sessions.find(
        item => item.id === id && item.memberId === me.id,
      )
      if (!entry) throw new OfficeError('not_found', 'Session is unavailable')
      await this.commit(
        state,
        { sessions: state.sessions.filter(item => item.id !== id) },
        me.id,
        me.id,
        'session_revoked',
      )
    })
  }

  /**
   * Replace an own password only after verifying the reviewed credential; revoke every old token.
   * @param token - Current bearer value.
   * @param input - Current password and replacement.
   */
  async changePassword(
    token: string,
    input: OfficePasswordChangeInput,
  ): Promise<void> {
    const parsed = passwordChange.safeParse(input)
    if (!parsed.success)
      throw new OfficeError('invalid_input', 'Password fields are invalid')
    const me = this.authenticate(token)
    const previous = this.ready().credentials.find(
      entry => entry.memberId === me.id,
    )
    if (!previous) throw this.denied()
    const actual = await this.derive(
      parsed.data.currentPassword,
      previous.salt,
    )
    if (!timingSafeEqual(actual, Buffer.from(previous.digest, 'hex')))
      throw this.denied()
    const prepared = await this.prepare(parsed.data.newPassword)
    await this.access.enqueue(async () => {
      this.active(this.resolve(token).memberId)
      const state = this.ready()
      const current = state.credentials.find(
        entry => entry.memberId === me.id,
      )
      if (!current || current.revision !== previous.revision)
        throw this.denied()
      const entry = {
        ...current,
        ...prepared,
        revision: current.revision + 1,
        updatedAt: Date.now(),
      }
      await this.commit(
        state,
        {
          credentials: state.credentials.map(item =>
            item.memberId === me.id ? entry : item,
          ),
          sessions: state.sessions.filter(item => item.memberId !== me.id),
        },
        me.id,
        me.id,
        'password_changed',
      )
    })
  }

  /**
   * Read enrollment metadata only through current administrator authority.
   * @param actor - Authenticated administrator.
   * @returns Credential presence, with no digest, salt or session secret.
   */
  overview(actor: OfficeMemberId): OfficeIdentityOverview {
    this.access.assertOpen()
    this.admin(actor)
    const state = this.domain.global.get()
    return {
      initialized: state.initialized,
      enrolledMemberIds: state.credentials.map(entry => entry.memberId),
    }
  }

  /**
   * Remove pre-offboarding tokens before an inactive member is made active again.
   * @param actor - Current administrator who requested reactivation inside the office queue.
   * @param member - Reactivated employee identity.
   */
  async beforeReactivation(actor: OfficeMemberId, member: OfficeMemberId): Promise<void> {
    this.admin(actor)
    const state = this.domain.global.get()
    if (state.sessions.some(entry => entry.memberId === member)) {
      await this.commit(
        state,
        {
          sessions: state.sessions.filter(entry => entry.memberId !== member),
        },
        actor,
        member,
        'session_revoked',
      )
    }
  }

  /**
   * Revoke retained token hashes during a queued administrator offboarding operation.
   * @param actor - Original initiating administrator, recorded in the existing identity audit.
   * @param member - Retained employee identity whose sessions must be removed.
   * @returns Number of sessions removed after the original identity commit succeeds.
   */
  async revokeForOffboarding(actor: OfficeMemberId, member: OfficeMemberId): Promise<number> {
    this.admin(actor)
    const state = this.domain.global.get()
    const removed = state.sessions.filter(entry => entry.memberId === member).length
    if (!removed) return 0
    await this.commit(state, { sessions: state.sessions.filter(entry => entry.memberId !== member) }, actor, member, 'session_revoked')
    return removed
  }

  /**
   * Issue an original identity session only after a trusted enterprise provider has resolved an existing account.
   * @param resolve - Server-owned completed SSO verifier; rechecks provider and member authority inside this queue.
   * @returns Original hashed-session receipt; no member, password or role is created implicitly.
   */
  loginFederated(resolve: () => OfficeMemberId): Promise<OfficeLoginResult> {
    return this.access.enqueue(async () => {
      const member = this.active(resolve())
      this.access.assertSessionAccess?.(member.id)
      const current = this.ready()
      const credential = current.credentials.find(entry => entry.memberId === member.id)
      if (!credential) throw this.denied()
      const token = randomBytes(32).toString('base64url')
      const now = Date.now()
      const session: Session = { id: brandString<OfficeSessionId>(randomUUID()), memberId: member.id,
        credentialRevision: credential.revision, tokenHash: this.hash(token), createdAt: now, expiresAt: now + SESSION_MS }
      const retained = current.sessions.filter(entry => entry.expiresAt > now && entry.memberId !== member.id)
      const own = current.sessions.filter(entry => entry.expiresAt > now && entry.memberId === member.id).slice(-(MAX_SESSIONS - 1))
      await this.commit(current, { sessions: [...retained, ...own, session] }, member.id, member.id, 'signed_in')
      return { token, member, expiresAt: session.expiresAt }
    })
  }

  private enrolled(member: OfficeMemberId): boolean {
    return this.domain.global
      .get()
      .credentials.some(entry => entry.memberId === member)
  }
  private ready(): IdentityState {
    const state = this.domain.global.get()
    if (!state.initialized) throw this.denied()
    return state
  }
  private admin(actor: OfficeMemberId): void {
    if (this.access.member(actor).role !== 'admin')
      throw new OfficeError(
        'forbidden',
        'Only an administrator may manage sign-in credentials',
      )
  }
  private active(member: OfficeMemberId): OfficeMember {
    try {
      return this.access.member(member)
    } catch (error) {
      if (error instanceof OfficeError && error.code === 'forbidden')
        throw this.denied()
      throw error
    }
  }
  private resolve(token: string): Session {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw this.denied()
    const hash = this.hash(token)
    const state = this.ready()
    const entry = state.sessions.find(
      item => item.tokenHash === hash && item.expiresAt > Date.now(),
    )
    if (
      !entry ||
      !state.credentials.some(
        item =>
          item.memberId === entry.memberId &&
          item.revision === entry.credentialRevision,
      )
    )
      throw this.denied()
    return entry
  }
  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }
  private denied(): OfficeError {
    return new OfficeError(
      'unauthenticated',
      'Sign-in is unavailable or the credentials are invalid',
    )
  }
  private async prepare(
    password: string,
  ): Promise<{ salt: string; digest: string }> {
    if (!secret.safeParse(password).success)
      throw new OfficeError(
        'invalid_input',
        'Use a password between 15 and 1024 characters',
      )
    const salt = randomBytes(16).toString('hex')
    return {
      salt,
      digest: (await this.derive(password, salt)).toString('hex'),
    }
  }
  private async derive(password: string, salt: string): Promise<Buffer> {
    this.access.assertOpen()
    if (this.hashing >= 2) {
      if (this.waiting.length >= 32)
        throw new OfficeError('rate_limited', 'Sign-in is busy; retry later')
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve)
      })
    } else this.hashing++
    try {
      this.access.assertOpen()
      return await new Promise<Buffer>((resolve, reject) => {
        scrypt(
          password,
          Buffer.from(salt, 'hex'),
          64,
          { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
          (error, key) => {
            if (error) reject(error)
            else resolve(key)
          },
        )
      })
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.hashing--
    }
  }
  private async commit(
    state: IdentityState,
    changes: Partial<
      Pick<IdentityState, 'initialized' | 'credentials' | 'sessions'>
    >,
    actor: OfficeMemberId,
    target: OfficeMemberId,
    action: IdentityState['audit'][number]['action'],
  ): Promise<void> {
    if (state.revision === Number.MAX_SAFE_INTEGER)
      throw new OfficeError('conflict', 'Identity revision limit reached')
    const revision = state.revision + 1
    const next = {
      ...state,
      ...changes,
      revision,
      audit: [
        ...state.audit,
        {
          revision,
          actorId: actor,
          targetId: target,
          time: Date.now(),
          action,
        },
      ].slice(-1000),
    }
    if (!officeIdentityDomain.global.schema.safeParse(next).success)
      throw new OfficeError('invalid_input', 'Invalid identity state')
    await this.domain.global.set(next)
  }
}
