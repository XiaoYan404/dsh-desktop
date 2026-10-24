/** Host-only office client. The browser receives results while the credential provider owns tokens. */
import { z } from 'zod'
import { Buffer } from 'node:buffer'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { OfficeError } from '@deepseek-ai/dsh-enterprise-office'
import type {
  OfficeLoginInput,
  OfficeMemberId,
  OfficePasswordChangeInput,
  OfficeSessionId,
  OfficeSessionInfo,
  OfficeMemberInviteCapability,
  OfficeMemberInviteAcceptInput,
  OfficeMemberInviteAcceptReceipt,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConnection } from './types.ts'

const key = credentialKey('client-ui-office', 'office-session')
const savedSession = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict()
const record = z
  .object({
    version: z.literal(1),
    gateway: z.string(),
    session: savedSession.nullable(),
  })
  .strict()
const member = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,128}$/)
      .transform(value => brandString<OfficeMemberId>(value)),
    name: z.string().min(1).max(100),
    department: z.string().max(200),
    jobTitle: z.string().max(200),
    email: z.string().max(320),
    phone: z.string().max(80),
    role: z.enum(['employee', 'manager', 'admin']),
    active: z.literal(true),
  })
  .strict()
const receipt = savedSession.extend({ member }).strict()
const session = z
  .object({ member, expiresAt: z.number().int().positive() })
  .strict()
const envelope = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum([
        'invalid_input',
        'forbidden',
        'not_found',
        'conflict',
        'duplicate_name',
        'closed',
        'unauthenticated',
        'rate_limited',
        'conversation_capacity',
        'context_too_large',
        'unavailable',
      ]),
    })
    .strict(),
])
const MAX_RESPONSE = 16 * 1024 * 1024
const inviteCapability = z.object({ protocol: z.literal(1), maxTtlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()
const health = z.looseObject({ protocol: z.literal('office.v1'), memberInvites: inviteCapability.optional() })
const inviteAccepted = z.object({ memberId: member.shape.id }).strict()

/** Authenticated HTTP client with a credential-backed session, independent of native Agent ownership. */
export class OfficeGatewayClient {
  private readonly gateway: string

  /**
   * @param credentials - Native Host secret provider; no bearer value enters plugin config or browser storage.
   * @param address - Deployment-owned HTTPS origin/base path, or loopback HTTP for local use.
   * @param lifetime - Plugin lifetime cancellation.
   */
  constructor(
    private readonly credentials: CredentialProvider,
    address: string,
    private readonly lifetime: AbortSignal,
  ) {
    const url = new URL(address)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol === 'http:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    ) {
      throw new Error(
        'Configure an HTTPS office gateway; loopback HTTP is supported for local deployment',
      )
    }
    url.pathname = url.pathname.replace(/\/?$/, '/')
    this.gateway = url.href
  }

  /**
   * Resolve current server authority without returning any bearer material.
   * @returns Sanitized authenticated or disconnected connection state.
   */
  async connection(): Promise<OfficeConnection> {
    const current = await this.current()
    if (!current) return this.disconnected()
    try {
      const checked = session.parse(
        await this.call('v1/session', undefined, current.token),
      )
      await this.assertCurrentSession(current.token)
      return {
        mode: 'gateway',
        gateway: this.gateway,
        connected: true,
        member: checked.member,
        expiresAt: checked.expiresAt,
      }
    } catch (error) {
      if (error instanceof OfficeError && error.code === 'unauthenticated') {
        await this.clear(current.token)
        return this.disconnected()
      }
      throw error
    }
  }

  /**
   * Sign in and durably retain the session before reporting success.
   * @param input - Exact employee id and password; neither is cached in UI state after success.
   * @returns Sanitized authenticated connection state.
   */
  async signIn(input: OfficeLoginInput): Promise<OfficeConnection> {
    const authenticated = receipt.parse(await this.call('v1/login', input))
    try {
      await this.credentials.modifyRecord(key, () => {
        // The provider may wait for its writer lock after this plugin has already unloaded.
        this.lifetime.throwIfAborted()
        return Promise.resolve({
          kind: 'grant',
          payload: {
            version: 1,
            gateway: this.gateway,
            session: {
              token: authenticated.token,
              expiresAt: authenticated.expiresAt,
            },
          },
        })
      })
    } catch (error) {
      // Compensate a failed local secret write; an uncertain remote result is never presented as signed in.
      try {
        await this.call('v1/logout', {}, authenticated.token)
      } catch {
        /* The caller still receives the original storage failure. */
      }
      throw error
    }
    return {
      mode: 'gateway',
      gateway: this.gateway,
      connected: true,
      member: authenticated.member,
      expiresAt: authenticated.expiresAt,
    }
  }

  /**
   * Discover optional first-password enrollment through the fixed credential-free health endpoint.
   * @returns Safe capability or null for older, unavailable or unsupported gateways; normal sign-in remains independent.
   */
  async memberInviteCapability(): Promise<OfficeMemberInviteCapability | null> {
    this.lifetime.throwIfAborted()
    try {
      const response = await fetch(new URL('health', this.gateway), { redirect: 'error',
        headers: { Accept: 'application/json' }, signal: AbortSignal.any([this.lifetime, AbortSignal.timeout(15_000)]) })
      if (!response.ok || !/^application\/json(?:;|$)/iu.test(response.headers.get('content-type') ?? '')
        || Number(response.headers.get('content-length') ?? 0) > 4096) {
        await response.body?.cancel()
        return null
      }
      const reader = response.body?.getReader()
      if (!reader) return null
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > 4096) { await reader.cancel(); return null }
          chunks.push(part.value)
        }
      } finally { reader.releaseLock() }
      const parsed = health.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))))
      return parsed.success ? parsed.data.memberInvites ?? null : null
    } catch (error) {
      if (this.lifetime.aborted) throw error
      // Capability discovery is optional; failure exposes no invitation entry and does not touch existing credentials.
      return null
    }
  }

  /**
   * Set the limited invitation target's first password without creating or replacing a Host login.
   * @param input - Exact code and recipient-selected first password; the server derives the member.
   * @returns Only the committed login identity; callers still use normal sign-in.
   */
  async acceptMemberInvite(input: OfficeMemberInviteAcceptInput): Promise<OfficeMemberInviteAcceptReceipt> {
    return inviteAccepted.parse(await this.call('v1/invitations/accept', input))
  }

  /** Revoke the durable server session before removing its exact local credential. */
  async signOut(): Promise<void> {
    const current = await this.current()
    if (!current) return
    await this.call('v1/logout', {}, current.token)
    await this.clear(current.token)
  }

  /**
   * Execute one allowlisted office operation with no caller-selected actor id.
   * @param method - Version 1 office operation name checked by the server.
   * @param args - Its complete positional argument tuple; optional values use explicit null.
   * @param signal - Optional caller cancellation, combined with the controller lifetime and transport deadline.
   * @returns The typed contract result after server authorization and an unchanged durable local login.
   */
  async operation<T>(method: string, args: readonly unknown[], signal?: AbortSignal): Promise<T> {
    return this.authenticated('v1/rpc', { method, args }, signal)
  }

  /**
   * Read only this signed-in employee's sanitized device sessions.
   * @returns Own device-session handles without bearer values.
   */
  sessions(): Promise<readonly OfficeSessionInfo[]> {
    return this.authenticated('v1/account/sessions')
  }

  /**
   * Revoke one own device session through current server authentication.
   * @param id - Public session handle; another employee's handle is rejected by the server.
   */
  async revoke(id: OfficeSessionId): Promise<void> {
    await this.authenticated('v1/account/sessions/revoke', { id })
  }

  /**
   * Verify the current password, replace it and remove the now-invalid local session.
   * @param input - Current password and replacement.
   */
  async changePassword(input: OfficePasswordChangeInput): Promise<void> {
    const current = await this.requireSession()
    await this.call('v1/account/password', input, current.token)
    await this.clear(current.token)
  }

  private disconnected(): OfficeConnection {
    return {
      mode: 'gateway',
      gateway: this.gateway,
      connected: false,
      member: null,
      expiresAt: null,
    }
  }
  private async current(): Promise<z.infer<typeof savedSession> | null> {
    this.lifetime.throwIfAborted()
    const stored = await this.credentials.readRecord(key)
    if (!stored) return null
    const parsed =
      stored.kind === 'grant' ? record.safeParse(stored.payload) : null
    if (!parsed?.success)
      throw new Error('Stored office connection is invalid')
    return parsed.data.gateway === this.gateway ? parsed.data.session : null
  }
  private async requireSession(): Promise<z.infer<typeof savedSession>> {
    const current = await this.current()
    if (!current)
      throw new OfficeError('unauthenticated', 'Sign in to the office gateway')
    return current
  }
  private async assertCurrentSession(token: string): Promise<void> {
    if ((await this.current())?.token !== token)
      throw new OfficeError('unauthenticated', 'Office account changed before the response arrived')
    this.lifetime.throwIfAborted()
  }
  private async clear(token: string): Promise<void> {
    await this.credentials.modifyRecord(key, (current) => {
      const parsed =
        current?.kind === 'grant' ? record.safeParse(current.payload) : null
      if (
        !parsed?.success ||
        parsed.data.gateway !== this.gateway ||
        parsed.data.session?.token !== token
      )
        return Promise.resolve(undefined)
      return Promise.resolve({
        kind: 'grant',
        payload: { ...parsed.data, session: null },
      })
    })
  }
  private async authenticated<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const current = await this.requireSession()
    try {
      const result = await this.call<T>(path, body, current.token, signal)
      signal?.throwIfAborted()
      await this.assertCurrentSession(current.token)
      return result
    } catch (error) {
      if (error instanceof OfficeError && error.code === 'unauthenticated')
        await this.clear(current.token)
      throw error
    }
  }
  private async call<T>(
    path: string,
    body?: unknown,
    token?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    this.lifetime.throwIfAborted()
    const response = await fetch(new URL(path, this.gateway), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.any([this.lifetime, AbortSignal.timeout(15_000), ...signal ? [signal] : []]),
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (
      !/^application\/json(?:;|$)/i.test(
        response.headers.get('content-type') ?? '',
      ) ||
      Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE
    ) {
      await response.body?.cancel()
      throw new Error('Office gateway returned an invalid response')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Office gateway returned an empty response')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > MAX_RESPONSE) {
          await reader.cancel()
          throw new Error('Office gateway response exceeds its limit')
        }
        chunks.push(part.value)
      }
    } finally {
      reader.releaseLock()
    }
    const parsed = envelope.safeParse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      ),
    )
    if (!parsed.success)
      throw new Error('Office gateway returned an invalid envelope')
    if (!parsed.data.ok) {
      if (parsed.data.code === 'unavailable')
        throw new Error('Office gateway is unavailable')
      throw new OfficeError(
        parsed.data.code,
        'Office gateway denied the request',
      )
    }
    if (!response.ok)
      throw new Error('Office gateway returned an unexpected status')
    this.lifetime.throwIfAborted()
    return parsed.data.value as T
  }
}
