import { officeEnterpriseSsoFinish } from '@deepseek-ai/dsh-enterprise-office'
/** Independent HTTP ingress for enterprise office data, with no generic Harness RPC surface. */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { listenHttp } from '@deepseek-ai/dsh-host-webserver'
import {
  executeOfficeRequest,
  OfficeError,
} from '@deepseek-ai/dsh-enterprise-office'
import type {
  OfficeErrorCode,
  OfficeMemberId,
  OfficeSessionId,
} from '@deepseek-ai/dsh-enterprise-office/types'
import { z } from 'zod'

declare module '@deepseek-ai/cordis' {
  interface Context {
    officeGateway: OfficeGateway
  }
}

/** Office-only listener and first-run credential reference; no password belongs in plugin config. */
export interface Config {
  /** Bind address; expose through a TLS reverse proxy for remote employees. */
  host: string
  /** HTTP port; zero asks the OS for an isolated ephemeral listener. */
  port: number
  /** Existing administrator used only for one-time sign-in initialization. */
  administratorId: string
  /** Secret reference needed only while initializing a previously unconfigured identity domain. */
  initialPasswordRef?: string
  /** Per-source-address login attempts per minute, including successful attempts. */
  loginRequestsPerMinute: number
  /** Maximum automatic Fetch-compatible port candidates; defaults to 16. Explicit ports bind once. */
  ephemeralPortAttempts?: number
}

const login = z
  .object({
    memberId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,128}$/)
      .transform(value => brandString<OfficeMemberId>(value)),
    password: z.string().min(1).max(1024),
  })
  .strict()
const password = z
  .object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(15).max(1024),
  })
  .strict()
const revoke = z
  .object({
    id: z.uuid().transform(value => brandString<OfficeSessionId>(value)),
  })
  .strict()
const empty = z.object({}).strict()
const memberInviteAccept = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  newPassword: z.string().min(15).max(1024) }).strict()
const MAX_BODY = 12 * 1024 * 1024
const status: Record<OfficeErrorCode, number> = {
  invalid_input: 400,
  customization_capacity: 409,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  duplicate_name: 409,
  closed: 503,
  rate_limited: 429,
  conversation_capacity: 409,
  context_too_large: 413,
  execution_unknown: 409,
}

/** Central authenticated office listener; a separate employee Host retains all native Agent tools. */
export class OfficeGateway extends Service {
  static inject = ['office']
  static Config: Schema<Config> = Schema.object({
    host: Schema.string().default('127.0.0.1'),
    port: Schema.number().min(0).max(65535).step(1).default(3082),
    ephemeralPortAttempts: Schema.number().min(1).max(64).step(1).default(16),
    administratorId: Schema.string().required(),
    initialPasswordRef: Schema.string(),
    loginRequestsPerMinute: Schema.number()
      .min(1)
      .max(1000)
      .step(1)
      .default(20),
  })
  private server: Server | undefined
  private closed = false
  private origin = ''
  private readonly ephemeralPortAttempts: number
  private readonly running = new Set<Promise<void>>()
  private readonly budgets = new Map<
    string,
    { since: number; count: number }
  >()

  /** @param ctx - Central storage/office composition, without native Agent exposure.
   * @param config - Listener and deployment-owned bootstrap reference.
   */
  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    super(ctx, 'officeGateway')
    this.ephemeralPortAttempts = config.ephemeralPortAttempts ?? 16
  }

  /** Actual listening origin, containing no authentication material. */
  get address(): string {
    return this.origin
  }

  protected async [Service.init](): Promise<void> {
    this.ctx.effect(
      () => async () => {
        this.closed = true
        const server = this.server
        if (server?.listening) {
          const stopping = new Promise<void>((resolve, reject) =>
            server.close((error) => {
              if (error) reject(error)
              else resolve()
            }),
          )
          server.closeAllConnections()
          await stopping
        }
        await Promise.allSettled([...this.running])
        this.budgets.clear()
      },
      'officeGateway.close',
    )
    const ref = this.config.initialPasswordRef
    const credentials = this.ctx.get('credentials')
    const initial =
      ref && credentials
        ? await credentials.resolve(credentialRef(ref))
        : undefined
    await this.ctx.office.initializeIdentity(
      brandString<OfficeMemberId>(this.config.administratorId),
      initial?.value ?? '',
    )
    if (this.closed)
      throw new OfficeError(
        'closed',
        'Office gateway closed during initialization',
      )
    const server = createServer(
      { requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 16_384 },
      (request, response) => {
        const pending = this.handle(request, response)
        this.running.add(pending)
        void pending.finally(() => this.running.delete(pending))
      },
    )
    server.maxRequestsPerSocket = 100
    server.keepAliveTimeout = 5000
    this.server = server
    await listenHttp(server, { host: this.config.host, port: this.config.port, maxAttempts: this.ephemeralPortAttempts })
    if (this.isClosed()) {
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        }),
      )
      throw new OfficeError(
        'closed',
        'Office gateway closed before listener activation',
      )
    }
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Office gateway did not bind a TCP address')
    this.origin = `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    try {
      if (this.closed)
        throw new OfficeError('closed', 'Office gateway is closing')
      // Browsers use their authenticated local Host. This ingress has no cookies or cross-origin browser API.
      if (request.headers.origin)
        throw new OfficeError('forbidden', 'Use the employee Host connection')
      const ip = request.socket.remoteAddress ?? 'unknown'
      this.admit(`requests:${ip}`, 300)
      if (request.method === 'GET' && request.url === '/health') {
        const memberInvites = this.ctx.office.memberInviteCapability()
        const enterpriseSso = this.ctx.office.enterpriseSsoProviders()
        this.send(response, 200, { protocol: 'office.v1', ...memberInvites ? { memberInvites } : {}, ...enterpriseSso.length ? { enterpriseSso } : {} })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/invitations/accept') {
        this.admit(`member-invite:${ip}`, this.config.loginRequestsPerMinute)
        const parsed = memberInviteAccept.safeParse(await this.body(request, 8192))
        if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid member invitation acceptance')
        const cancellation = new AbortController()
        const disconnected = () => { cancellation.abort() }
        response.once('close', disconnected)
        try {
          const value = await this.ctx.office.acceptMemberInvite(parsed.data, cancellation.signal)
          this.send(response, 200, { ok: true, value })
        } finally { response.off('close', disconnected) }
        return
      }
      if (request.method === 'POST' && request.url === '/v1/sso/begin') {
        this.admit(`enterprise-sso:${ip}`, this.config.loginRequestsPerMinute)
        const parsed = z.object({ providerId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u) }).strict().safeParse(await this.body(request, 1024))
        if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid enterprise sign-in provider')
        this.send(response, 200, { ok: true, value: this.ctx.office.beginEnterpriseSso(parsed.data.providerId) })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/sso/complete') {
        this.admit(`enterprise-sso:${ip}`, this.config.loginRequestsPerMinute)
        const parsed = officeEnterpriseSsoFinish.safeParse(await this.body(request, 8192))
        if (!parsed.success) throw new OfficeError('unauthenticated', 'Invalid enterprise sign-in callback')
        this.send(response, 200, { ok: true, value: await this.ctx.office.completeEnterpriseSso(parsed.data) })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/login') {
        this.admit(`login:${ip}`, this.config.loginRequestsPerMinute)
        const parsed = login.safeParse(await this.body(request, 8192))
        if (!parsed.success)
          throw new OfficeError(
            'unauthenticated',
            'Sign-in is unavailable or the credentials are invalid',
          )
        this.send(response, 200, {
          ok: true,
          value: await this.ctx.office.login(parsed.data),
        })
        return
      }
      const authorization = request.headers.authorization
      const token =
        typeof authorization === 'string' &&
        /^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)
          ? authorization.slice(7)
          : ''
      if (request.method === 'POST' && request.url === '/v1/logout') {
        if (!empty.safeParse(await this.body(request, 8192)).success)
          throw new OfficeError('invalid_input', 'Invalid sign-out request')
        await this.ctx.office.logout(token)
        this.send(response, 200, { ok: true, value: null })
        return
      }
      const member = this.ctx.office.authenticate(token)
      if (request.method === 'GET' && request.url === '/v1/session') {
        const current = this.ctx.office
          .identitySessions(token)
          .find(entry => entry.current)
        if (!current)
          throw new OfficeError('unauthenticated', 'Session is unavailable')
        this.send(response, 200, {
          ok: true,
          value: { member, expiresAt: current.expiresAt },
        })
        return
      }
      if (request.method === 'GET' && request.url === '/v1/account/sessions') {
        this.send(response, 200, {
          ok: true,
          value: this.ctx.office.identitySessions(token),
        })
        return
      }
      if (
        request.method === 'POST' &&
        request.url === '/v1/account/sessions/revoke'
      ) {
        const parsed = revoke.safeParse(await this.body(request, 8192))
        if (!parsed.success)
          throw new OfficeError('invalid_input', 'Invalid session handle')
        await this.ctx.office.withSession(token, async () =>
          this.ctx.office.revokeIdentitySession(token, parsed.data.id),
        )
        this.send(response, 200, { ok: true, value: null })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/account/password') {
        const parsed = password.safeParse(await this.body(request, 8192))
        if (!parsed.success)
          throw new OfficeError('invalid_input', 'Invalid password fields')
        await this.ctx.office.withSession(token, async () =>
          this.ctx.office.changeIdentityPassword(token, parsed.data),
        )
        this.send(response, 200, { ok: true, value: null })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/rpc') {
        const cancellation = new AbortController()
        const disconnected = () => { cancellation.abort() }
        response.once('close', disconnected)
        let result: unknown
        try {
          result = await executeOfficeRequest(this.ctx.office, token, await this.body(request, MAX_BODY), cancellation.signal)
        } finally {
          response.off('close', disconnected)
        }
        this.send(response, 200, { ok: true, value: result })
        return
      }
      throw new OfficeError('not_found', 'Office endpoint is unavailable')
    } catch (error) {
      if (error instanceof OfficeError) {
        if (error.code === 'rate_limited')
          response.setHeader('Retry-After', '60')
        this.send(response, status[error.code], {
          ok: false,
          code: error.code,
        })
      } else {
        // Request bodies, bearer tokens, passwords and raw storage errors never enter logs or responses.
        this.ctx.logger.warn('Office gateway operation failed')
        this.send(response, 503, { ok: false, code: 'unavailable' })
      }
    }
  }

  private admit(key: string, limit: number): void {
    const now = Date.now()
    if (this.budgets.size >= 4096)
      for (const [id, entry] of this.budgets)
        if (now - entry.since >= 60_000) this.budgets.delete(id)
    const previous = this.budgets.get(key)
    if (!previous && this.budgets.size >= 4096)
      throw new OfficeError('rate_limited', 'Request capacity is busy')
    const entry =
      previous && now - previous.since < 60_000
        ? previous
        : { since: now, count: 0 }
    if (entry.count >= limit)
      throw new OfficeError('rate_limited', 'Too many requests')
    entry.count++
    this.budgets.set(key, entry)
  }

  private async body(
    request: IncomingMessage,
    limit: number,
  ): Promise<unknown> {
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        request.headers['content-type'] ?? '',
      ) ||
      request.headers['content-encoding']
    )
      throw new OfficeError(
        'invalid_input',
        'Use an uncompressed UTF-8 JSON request',
      )
    const length = request.headers['content-length']
    if (length && (!/^\d+$/.test(length) || Number(length) > limit))
      throw new OfficeError('invalid_input', 'Request body exceeds its limit')
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of request) {
      if (!(chunk instanceof Uint8Array))
        throw new OfficeError('invalid_input', 'Invalid request bytes')
      const bytes = chunk
      size += bytes.byteLength
      if (size > limit)
        throw new OfficeError(
          'invalid_input',
          'Request body exceeds its limit',
        )
      chunks.push(bytes)
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      )
    } catch {
      throw new OfficeError('invalid_input', 'Invalid JSON request')
    }
  }

  private isClosed(): boolean {
    return this.closed
  }

  private send(response: ServerResponse, code: number, value: unknown): void {
    if (response.destroyed || response.writableEnded) return
    const bytes = Buffer.from(JSON.stringify(value))
    response.writeHead(code, { 'Content-Length': bytes.byteLength })
    response.end(bytes)
  }
}

/**
 * Activate the listener only after the selected bootstrap dependencies are ready.
 * @param ctx - Central plugin context.
 * @param config - Validated listener and first-run settings.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.inject(
    config.initialPasswordRef ? ['office', 'credentials'] : ['office'],
    async (child) => {
      await child.plugin(OfficeGateway, config)
    },
  )
}

/** Office-only plugin waits for the configured first-run credential provider before binding its listener. */
export default { Config: OfficeGateway.Config, apply }
