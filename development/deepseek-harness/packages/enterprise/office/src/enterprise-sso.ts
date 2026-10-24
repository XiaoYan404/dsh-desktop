/** Explicit OIDC authorization-code/PKCE sign-in for pre-enrolled, server-mapped employee accounts. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { z } from 'zod'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import type { OfficeLoginResult, OfficeMemberId } from './types.ts'

const https = z.url().refine((value) => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search
}, 'Enterprise identity endpoints require explicit HTTPS URLs without query or credentials')
const provider = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u), issuer: https,
  authorizationEndpoint: https, tokenEndpoint: https, jwksUri: https, redirectUri: https,
  clientId: z.string().min(1).max(200), clientSecretRef: z.string().min(1).max(200).nullable(),
  tokenAuth: z.enum(['none', 'client_secret_post']), requiredAcr: z.array(z.string().min(1).max(200)).max(20),
  mappings: z.array(z.object({ subject: z.string().min(1).max(255), memberId: officeMemberId }).strict()).max(20000),
}).strict().refine(value => (value.tokenAuth === 'none') === (value.clientSecretRef === null)
  && new Set(value.mappings.map(entry => entry.subject)).size === value.mappings.length
  && new Set(value.mappings.map(entry => entry.memberId)).size === value.mappings.length)
/** Explicit endpoints and mappings make supported OIDC behavior independent of profile email or role labels. */
export const officeEnterpriseSsoConfig = z.object({
  providers: z.array(provider).min(1).max(20),
  flowTtlMs: z.number().int().min(1000).max(900000), maxPending: z.number().int().min(1).max(10000),
  requestTimeoutMs: z.number().int().min(100).max(120000), maxResponseBytes: z.number().int().min(1024).max(1048576),
  maxTokenAgeSeconds: z.number().int().min(1).max(3600), clockToleranceSeconds: z.number().int().min(0).max(60),
}).strict().refine(value => new Set(value.providers.map(entry => entry.id)).size === value.providers.length)
/** Validated deployment-owned enterprise SSO configuration. */
export type OfficeEnterpriseSsoConfig = z.infer<typeof officeEnterpriseSsoConfig>
/** Only bounded original authorization callback fields are accepted. */
export const officeEnterpriseSsoFinish = z.object({
  providerId: provider.shape.id, state: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  bindingKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), code: z.string().min(1).max(4096),
}).strict()
interface PendingFlow {
  readonly providerId: string
  readonly bindingHash: Buffer
  readonly nonce: string
  readonly verifier: string
  readonly createdAt: number
  readonly expiresAt: number
}
const jwks = z.object({
  keys: z.array(z.object({
    kty: z.literal('RSA'), n: z.string().min(1), e: z.string().min(1),
    kid: z.string().min(1).max(200), use: z.literal('sig').optional(), alg: z.literal('RS256').optional(),
  }).loose()).min(1).max(100),
}).strict()

/** The Host owns binding keys in private memory or an HttpOnly same-site cookie; they never enter shared Client state. */
export class OfficeEnterpriseSso {
  private readonly flows = new Map<string, PendingFlow>()
  private readonly lifetime = new AbortController()
  private readonly config: OfficeEnterpriseSsoConfig
  constructor(input: OfficeEnterpriseSsoConfig,
    private readonly login: (resolve: () => OfficeMemberId) => Promise<OfficeLoginResult>,
    private readonly assertMember: (id: OfficeMemberId) => void,
    private readonly secret: (reference: string) => Promise<string>,
    private readonly request: typeof fetch = fetch) {
    this.config = officeEnterpriseSsoConfig.parse(input)
  }
  /**
   * Discover configured provider ids and verified issuer locations without exposing mappings or secret references.
   * @returns Public sign-in choices; this capability creates no member or session.
   */
  providers(): readonly { readonly id: string; readonly issuer: string }[] {
    this.open()
    return this.config.providers.map(value => ({ id: value.id, issuer: value.issuer }))
  }
  /**
   * Start one bounded PKCE flow, binding it to the initiating local Host or HttpOnly cookie holder.
   * @param providerId - Exact configured provider id; arbitrary discovery URLs are not accepted.
   * @returns Authorization URL and private Host binding key; neither belongs in audit, snapshots or localStorage.
   */
  begin(providerId: string) : {
        providerId: string;
        authorizationUrl: string;
        bindingKey: string;
        expiresAt: number;
    } {
    this.open()
    const configured = this.config.providers.find(entry => entry.id === providerId)
    if(!configured) throw this.denied()
    const now = Date.now()
    for(const [key, value] of this.flows) if(now >= value.expiresAt) this.flows.delete(key)
    if(this.flows.size >= this.config.maxPending) throw new OfficeError('conflict',
      'Enterprise sign-in is busy; retry after pending sign-ins expire')
    const state = randomBytes(32).toString('base64url')
    const bindingKey = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const nonce = randomBytes(32).toString('base64url')
    this.flows.set(hash(state).toString('hex'), {
      providerId, bindingHash: hash(bindingKey), nonce, verifier,
      createdAt: now, expiresAt: now + this.config.flowTtlMs,
    })
    const url = new URL(configured.authorizationEndpoint)
    for(const [key, value] of Object.entries({
      client_id: configured.clientId, redirect_uri: configured.redirectUri,
      response_type: 'code', scope: 'openid', state, nonce, code_challenge: hash(verifier).toString('base64url'),
      code_challenge_method: 'S256',
    }))
      url.searchParams.set(key, value)
    return { providerId, authorizationUrl: url.href, bindingKey, expiresAt: now + this.config.flowTtlMs }
  }
  /**
   * Consume a bound flow once, verify issuer/audience/RS256/nonce/time and required ACR, then use original identity sessions.
   * @param input - Callback code/state and the initiating Host's retained binding key.
   * @returns Standard login receipt only for a current configured subject mapping and pre-enrolled active employee.
   */
  async complete(input: z.input<typeof officeEnterpriseSsoFinish>): Promise<OfficeLoginResult> {
    this.open()
    const parsed = officeEnterpriseSsoFinish.safeParse(input)
    if(!parsed.success) throw this.denied()
    const value = parsed.data
    const key = hash(value.state).toString('hex')
    const pending = this.flows.get(key)
    if(!pending || pending.providerId !== value.providerId || !timingSafeEqual(pending.bindingHash,
      hash(value.bindingKey))) throw this.denied()
    this.flows.delete(key)
    const configured = this.config.providers.find(entry => entry.id === pending.providerId)
    if(!configured || Date.now() < pending.createdAt || Date.now() >= pending.expiresAt) throw this.denied()
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code', code: value.code, redirect_uri: configured.redirectUri,
        client_id: configured.clientId, code_verifier: pending.verifier,
      })
      if(configured.clientSecretRef !== null) body.set('client_secret', await this.secret(configured.clientSecretRef))
      const token = z.object({ id_token: z.string().min(1).max(this.config.maxResponseBytes) }).loose().parse(
        await this.json(configured.tokenEndpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        }))
      const keys = jwks.parse(await this.json(configured.jwksUri, { method: 'GET' }))
      const verificationKeys = {
        keys: keys.keys.map(key => ({
          kty: key.kty, n: key.n, e: key.e, kid: key.kid, alg: 'RS256', use:
            'sig',
        })),
      }
      const result = await jwtVerify(token.id_token, createLocalJWKSet(verificationKeys), {
        issuer: configured.issuer,
        audience: configured.clientId, algorithms: ['RS256'], requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'nonce'],
        maxTokenAge: this.config.maxTokenAgeSeconds, clockTolerance: this.config.clockToleranceSeconds,
      })
      const claims = result.payload
      if(claims.nonce !== pending.nonce || typeof claims.sub !== 'string' || claims.azp !== undefined &&
        claims.azp !== configured.clientId
        || Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== configured.clientId
        || configured.requiredAcr.length && (typeof claims.acr !== 'string' ||
          !configured.requiredAcr.includes(claims.acr))) throw this.denied()
      const subject = claims.sub
      return await this.login(() => {
        this.open()
        if(Date.now() < pending.createdAt || Date.now() >= pending.expiresAt) throw this.denied()
        const memberId = configured.mappings.find(entry => entry.subject === subject)?.memberId
        if(!memberId) throw this.denied()
        this.assertMember(memberId)
        return memberId
      })
    } catch(error) {
      throw new OfficeError('unauthenticated', 'Enterprise sign-in could not be verified; restart sign-in or contact an administrator',
        { cause: error })
    }
  }
  /** Abort in-flight requests and discard every process-local secret when its owner unloads. */
  dispose(): void { this.lifetime.abort(); this.flows.clear() }
  private open(): void { if(this.lifetime.signal.aborted) throw new OfficeError('closed', 'Enterprise sign-in is closed') }
  private denied(): OfficeError {
    return new OfficeError('unauthenticated',
      'Enterprise sign-in is unavailable or its verification failed')
  }
  private async json(url: string, init: RequestInit): Promise<unknown> {
    this.open()
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    const response = await this.request(url, { ...init, redirect: 'error', signal })
    if(!response.ok || !response.body) throw this.denied()
    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let bytes = 0
    try {
      while(true) {
        const result = await reader.read()
        if(result.done) break
        bytes += result.value.byteLength
        if(bytes > this.config.maxResponseBytes) throw this.denied()
        parts.push(result.value)
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'))
  }
}
function hash(value: string): Buffer { return createHash('sha256').update(value).digest() }
