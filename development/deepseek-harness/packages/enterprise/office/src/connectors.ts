/** Versioned company connections reference Host-owned credentials and deployment-approved network origins. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import { httpJsonConnector } from './connector-http.ts'
import type { OfficeConnectorAdapter, OfficeConnectorReadResult, OfficeConnectorWriteResult } from './connector-http.ts'
import { connectorBusinessDataSchema, connectorReadResultSchema, officeConnectorReadInput,
  publicConnectorAction, snapshotConnectorActions, validateConnectorWriteValues } from './connector-actions.ts'
import type { OfficeConnectorExecutionId, OfficeConnectorWriteInput } from './types.ts'
import { officeConnectorExecutionLimits } from './connector-executions.ts'
import type { OfficeConnectorActionDeclaration, OfficeConnectorActionsView, OfficeConnectorReadInput,
  OfficeConnectorReadReceipt } from './types.ts'
import type { OfficeConnectorConfiguration, OfficeConnectorEntry, OfficeConnectorInput, OfficeConnectorProbe,
  OfficeConnectorStatus, OfficeConnectorView, OfficeIntegration, OfficeIntegrationId, OfficeMember } from './types.ts'

const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const integrationId = z.uuid().transform(value => brandString<OfficeIntegrationId>(value))
const baseUrl = z.string().min(1).max(2000).refine((value) => {
  if (!URL.canParse(value) || value.includes('\\')) return false
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
}).transform((value) => {
  const url = new URL(value)
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.href
})
const authentication = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('bearer'), credential: identifier }).strict(),
  z.object({ kind: z.literal('header'), credential: identifier,
    header: z.string().toLowerCase().regex(/^(authorization|x-[a-z0-9-]{1,60})$/) }).strict(),
])
const configuration = z.object({
  adapterId: identifier, baseUrl,
  probePath: z.string().min(1).max(1000).regex(/^[^\\?#\u0000-\u0020\u007f]+$/)
    .refine(value => !value.startsWith('/') && !URL.canParse(value)),
  authentication, enabled: z.boolean(),
}).strict().refine((value) => {
  const url = new URL(value.probePath, value.baseUrl)
  return url.origin === new URL(value.baseUrl).origin && url.pathname.startsWith(new URL(value.baseUrl).pathname)
})

/** Strict network write: credentials are selected by approved alias and cannot be supplied inline. */
export const officeConnectorInput = configuration.safeExtend({ integrationId, revision: version, requestId: z.uuid() }).strict()
/** Reviewed probe target; arbitrary URLs and adapter arguments are not accepted over the wire. */
export const officeConnectorProbeInput = z.object({ integrationId, revision: version.min(1) }).strict()
const record = configuration.safeExtend({
  integrationId, revision: version.min(1), requestId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: version, updatedBy: officeMemberId,
}).strict()
const audit = z.object({ revision: version.min(1), integrationId, actorId: officeMemberId, time: version }).strict()
const state = z.object({ revision: version, entries: z.array(record).max(1000).readonly(),
  audit: z.array(audit).max(1000).readonly() }).strict().superRefine((value, ctx) => {
  if (new Set(value.entries.map(entry => entry.integrationId)).size !== value.entries.length ||
    new Set(value.entries.map(entry => entry.requestId)).size !== value.entries.length ||
    value.entries.reduce((sum, entry) => sum + entry.revision, 0) !== value.revision ||
    value.audit.length !== Math.min(value.revision, 1000) ||
    value.audit.some((entry, index) => entry.revision !== value.revision - value.audit.length + index + 1)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid saved company connection history' })
  }
})

/** Connections use a new domain; importing a manifest never changes or creates a connection. */
export const officeConnectorDomain = defineDomain({
  name: 'enterprise_office_connectors', version: 1,
  global: { schema: state, initial: { revision: 0, entries: [], audit: [] } }, tables: {},
})

/** Resolved deployment policy, never exposed to a browser or stored beside a connection. */
export interface OfficeConnectorPolicy {
  readonly allowedOrigins: readonly string[]
  readonly credentials: ReadonlyMap<string, CredentialRef>
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  /** Maximum declarations in one provider registration. */
  readonly actionMaxCount: number
  /** Complete public directory JSON bound, including reserved response coordinates. */
  readonly actionMaxBytes: number
  /** Complete employee read-receipt UTF-8 JSON bound. */
  readonly readMaxBytes: number
  /** Maximum sanitized fields in one read result. */
  readonly readMaxEntries: number
}

/**
 * Validate deployment choices before activating any connector.
 * @param input - Explicit approved origins, reference aliases and finite probe bounds.
 * @returns Canonical policy; invalid or duplicate origins reject at load.
 */
export function resolveOfficeConnectorPolicy(input: {
  allowedOrigins: readonly string[]
  credentials: Readonly<Record<string, string>>
  timeoutMs: number
  maxResponseBytes: number
  actionMaxCount?: number
  actionMaxBytes?: number
  readMaxBytes?: number
  readMaxEntries?: number
}): OfficeConnectorPolicy {
  const origin = z.string().refine(value => URL.canParse(value) &&
    ['http:', 'https:'].includes(new URL(value).protocol) && new URL(value).origin === value)
  const parsed = z.object({
    allowedOrigins: z.array(origin).max(100).refine(values => new Set(values).size === values.length),
    credentials: z.record(identifier, z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)),
    timeoutMs: z.number().int().min(100).max(120000), maxResponseBytes: z.number().int().min(1).max(4 * 1024 * 1024),
    actionMaxCount: z.number().int().min(1).max(1000).default(100),
    actionMaxBytes: z.number().int().min(1024).max(4 * 1024 * 1024).default(262144),
    readMaxBytes: z.number().int().min(1024).max(4 * 1024 * 1024).default(65536),
    readMaxEntries: z.number().int().min(1).max(1000).default(100),
  }).strict().parse(input)
  return { ...parsed, credentials: new Map(Object.entries(parsed.credentials).map(([alias, ref]) => [alias, credentialRef(ref)])) }
}

/** Private configuration owner. All operations run in the office's identity-aware queue. */
export class OfficeConnectorRepository {
  private readonly adapters = new Map<string, {
    adapter: OfficeConnectorAdapter
    lifetime: AbortController
    actions: readonly OfficeConnectorActionDeclaration[]
    actionRevision: string
    read: OfficeConnectorAdapter['read']
    write: OfficeConnectorAdapter['write']
    reconcile: OfficeConnectorAdapter['reconcile']
    reconcileActions: ReadonlySet<string> | undefined
  }>()

  constructor(
    private readonly domain: Domain<typeof officeConnectorDomain>,
    private readonly policy: OfficeConnectorPolicy,
    private readonly credentials: () => CredentialProvider | undefined,
    private readonly integrations: () => readonly OfficeIntegration[],
    private readonly changed: () => Promise<void>,
    private readonly signal: AbortSignal,
  ) {
    this.register(httpJsonConnector)
  }

  /**
   * Contribute a trusted Host adapter; callers attach the disposer to their plugin effect.
   * @param adapter - Unique id and abort-aware implementation; it must not retain private headers.
   * @returns Disposer that removes the adapter and aborts its current check.
   */
  register(adapter: OfficeConnectorAdapter): () => void {
    if (this.adapters.has(adapter.id)) throw new OfficeError('conflict', 'Connection adapter is already registered')
    if (!identifier.safeParse(adapter.id).success) throw new OfficeError('invalid_input', 'Invalid connection adapter id')
    const actions = snapshotConnectorActions(adapter.actions,
      { count: this.policy.actionMaxCount, bytes: this.policy.actionMaxBytes })
    const reconcileActions = adapter.reconcileActions === undefined ? undefined : new Set(adapter.reconcileActions)
    if (reconcileActions && (reconcileActions.size !== adapter.reconcileActions?.length
      || (reconcileActions.size > 0 && !adapter.reconcile)
      || [...reconcileActions].some(id => !actions.some(action => action.id === id && action.kind === 'write'))))
      throw new OfficeError('invalid_input', 'Invalid outcome-check action declarations')
    const contribution = { adapter, lifetime: new AbortController(), actions, actionRevision: randomUUID(),
      read: adapter.read?.bind(adapter), write: adapter.write?.bind(adapter),
      reconcile: adapter.reconcile?.bind(adapter), reconcileActions }
    this.adapters.set(adapter.id, contribution)
    return () => {
      if (this.adapters.get(adapter.id) !== contribution) return
      this.adapters.delete(adapter.id)
      contribution.lifetime.abort()
    }
  }

  /**
   * Reject configurations detached from their original catalog or directory.
   * @param members - Complete retained office directory.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    const ids = new Set(this.integrations().map(entry => entry.id))
    const actors = new Set(members.map(member => member.id))
    const current = this.domain.global.get()
    if (current.entries.some(entry => !ids.has(entry.integrationId) || !actors.has(entry.updatedBy)) ||
      current.audit.some(entry => !ids.has(entry.integrationId) || !actors.has(entry.actorId))) {
      throw new OfficeError('conflict', 'Saved connections require their original integration catalog and employee directory')
    }
  }

  /**
   * Read current configuration readiness, without resolving or returning any credential value.
   * @param actor - Current active employee.
   * @returns Versions and non-network readiness; editable fields and policy choices are administrator-only.
   */
  async view(actor: OfficeMember): Promise<OfficeConnectorView> {
    const current = this.domain.global.get()
    return { revision: current.revision, adapters: [...this.adapters.keys()],
      executionHistory: officeConnectorExecutionLimits,
      actionCatalog: { protocol: 1, maxCount: this.policy.actionMaxCount, maxBytes: this.policy.actionMaxBytes },
      entries: await Promise.all(current.entries.map(async entry => this.project(entry, actor, await this.status(entry)))),
      ...(actor.role === 'admin' ? { allowedOrigins: this.policy.allowedOrigins,
        credentialAliases: [...this.policy.credentials.keys()] } : {}) }
  }

  /**
   * Read one role-filtered declaration directory without executing an adapter or resolving secret values.
   * @param actor - Active employee selected by the office's authenticated queue.
   * @param id - Company registration identity, never a caller-selected URL.
   * @returns Current connection/registration coordinates and bounded public metadata.
   */
  async actions(actor: OfficeMember, id: OfficeIntegrationId): Promise<OfficeConnectorActionsView> {
    if (!integrationId.safeParse(id).success) throw new OfficeError('invalid_input', 'Invalid company integration id')
    if (!this.integrations().some(integration => integration.id === id)) throw new OfficeError('not_found', 'System is unavailable')
    const entry = this.domain.global.get().entries.find(connection => connection.integrationId === id)
    if (!entry) return { integrationId: id, connectionRevision: 0, adapterRevision: null, status: 'unconfigured',
      actions: [], readSupported: false, writeSupported: false }
    const contribution = this.adapters.get(entry.adapterId)
    const status = await this.status(entry)
    if (this.signal.aborted) throw new OfficeError('closed', 'Office is closing')
    if (contribution !== this.adapters.get(entry.adapterId)) {
      throw new OfficeError('conflict', 'Connection adapter changed while reading its action directory')
    }
    return { integrationId: id, connectionRevision: entry.revision,
      adapterRevision: status === 'unverified' && contribution ? contribution.actionRevision : null, status,
      actions: status === 'unverified' && contribution
        ? contribution.actions.filter(action => action.allowedRoles.includes(actor.role)).map(publicConnectorAction) : [],
      readSupported: status === 'unverified' && Boolean(contribution?.read),
      writeSupported: status === 'unverified' && Boolean(contribution?.write) }
  }

  /**
   * Validate a write before reservation, retaining the exact reviewed provider for the later dispatch boundary.
   * @param actor - Current authenticated employee with no administrator role override.
   * @param input - Strict parsed business input, connection and provider coordinates.
   * @param assertAuthorized - Originating session and optional private conversation authority.
   * @returns One-shot dispatch closure; the service must durably mark dispatch through beforeDispatch before the adapter is invoked.
   */
  async prepareWrite(actor: OfficeMember, input: OfficeConnectorWriteInput, assertAuthorized: () => void): Promise<(
    executionId: OfficeConnectorExecutionId, maxResultBytes: number, beforeDispatch: () => Promise<void>,
  ) => Promise<OfficeConnectorWriteResult>> {
    const directory = await this.actions(actor, input.integrationId)
    if (directory.status !== 'unverified') throw new OfficeError('forbidden', 'Company connection is unavailable')
    if (directory.connectionRevision !== input.connectionRevision || directory.adapterRevision !== input.adapterRevision)
      throw new OfficeError('conflict', 'Reviewed company connection or adapter changed')
    const entry = this.domain.global.get().entries.find(row => row.integrationId === input.integrationId)
    const contribution = entry && this.adapters.get(entry.adapterId)
    const writer = contribution?.write
    const action = contribution?.actions.find(row => row.id === input.actionId && row.allowedRoles.includes(actor.role))
    if (!entry || !contribution || !writer || !action || action.kind !== 'write')
      throw new OfficeError('forbidden', 'Company write action is unavailable')
    const values = validateConnectorWriteValues(action, input.values)
    const assertReady = () => {
      this.assertOpen()
      assertAuthorized()
      if (this.adapters.get(entry.adapterId) !== contribution || contribution.actionRevision !== input.adapterRevision ||
        this.domain.global.get().entries.find(row => row.integrationId === input.integrationId) !== entry)
        throw new OfficeError('conflict', 'Reviewed company connection or adapter changed')
    }
    assertReady()
    let invoked = false
    return async (executionId, maxResultBytes, beforeDispatch) => {
      if (invoked) throw new OfficeError('conflict', 'Prepared write cannot be invoked again')
      invoked = true
      assertReady()
      const authorized = await this.resolveHeaders(entry)
      assertReady()
      if (!authorized.ok) throw new OfficeError('forbidden', 'Company credentials are unavailable')
      await beforeDispatch()
      assertReady()
      const signal = AbortSignal.any([this.signal, contribution.lifetime.signal, AbortSignal.timeout(this.policy.timeoutMs)])
      const isAborted = () => signal.aborted
      if (isAborted()) throw new OfficeError('closed', 'Company operation is closing')
      let raw: OfficeConnectorWriteResult
      try {
        raw = await writer({ actionId: action.id, member: { id: actor.id, role: actor.role },
          baseUrl: entry.baseUrl, headers: authorized.headers, signal, maxResponseBytes: this.policy.maxResponseBytes,
          maxEntries: this.policy.readMaxEntries, executionId, values, maxResultBytes })
      } catch (error) {
        if (isAborted()) return { status: 'unknown' }
        throw error
      }
      if (isAborted() || this.adapters.get(entry.adapterId) !== contribution) return { status: 'unknown' }
      return this.businessResult(raw, maxResultBytes)
    }
  }

  /**
   * Read the authoritative outcome of an already dispatched operation without invoking its write implementation.
   * @param actor - Current authenticated employee admitted to the original action's current role declaration.
   * @param input - Retained original business coordinates; changed saved connections cannot query another location.
   * @param executionId - Original server idempotency key; business values are never supplied to the checker.
   * @param maxResultBytes - Result bound negotiated by the original reservation, independent of changed defaults.
   * @param assertAuthorized - Recheck the originating session before network admission and private result disclosure.
   * @returns An explicit unavailable/changed state or a strict checked outcome; uncertainty never means nonacceptance.
   */
  async reconcileAction(actor: OfficeMember, input: OfficeConnectorReadInput, executionId: OfficeConnectorExecutionId,
    maxResultBytes: number, assertAuthorized: () => void): Promise<
    { readonly status: 'unavailable' | 'connection_changed' } |
    { readonly status: 'checked'; readonly result: OfficeConnectorWriteResult }
  > {
    const directory = await this.actions(actor, input.integrationId)
    if (directory.connectionRevision !== input.connectionRevision) return { status: 'connection_changed' }
    if (directory.status !== 'unverified') return { status: 'unavailable' }
    const action = directory.actions.find(row => row.id === input.actionId && row.kind === 'write')
    if (!action) throw new OfficeError('forbidden', 'Company action is no longer available for this employee')
    const entry = this.domain.global.get().entries.find(row => row.integrationId === input.integrationId)
    const contribution = entry && this.adapters.get(entry.adapterId)
    const reconcile = contribution?.reconcile
    if (!entry || !contribution || !reconcile || (contribution.reconcileActions && !contribution.reconcileActions.has(input.actionId)))
      return { status: 'unavailable' }
    const assertReady = () => {
      this.assertOpen()
      assertAuthorized()
      if (this.adapters.get(entry.adapterId) !== contribution || contribution.actionRevision !== directory.adapterRevision ||
        this.domain.global.get().entries.find(row => row.integrationId === input.integrationId) !== entry)
        throw new OfficeError('conflict', 'Company outcome checker changed')
    }
    assertReady()
    const authorized = await this.resolveHeaders(entry)
    assertReady()
    if (!authorized.ok) return { status: 'unavailable' }
    const signal = AbortSignal.any([this.signal, contribution.lifetime.signal, AbortSignal.timeout(this.policy.timeoutMs)])
    let raw: OfficeConnectorWriteResult
    try {
      raw = await reconcile({ executionId, actionId: input.actionId, member: { id: actor.id, role: actor.role },
        baseUrl: entry.baseUrl, headers: authorized.headers, signal, maxResponseBytes: this.policy.maxResponseBytes,
        maxEntries: this.policy.readMaxEntries, maxResultBytes })
    } catch (error) {
      if (!signal.aborted) throw error
      return { status: 'checked', result: { status: 'unknown' } }
    }
    if (signal.aborted || this.adapters.get(entry.adapterId) !== contribution)
      return { status: 'checked', result: { status: 'unknown' } }
    assertReady()
    return { status: 'checked', result: this.businessResult(raw, maxResultBytes) }
  }

  private businessResult(raw: unknown, maxResultBytes: number): OfficeConnectorWriteResult {
    const result = z.discriminatedUnion('status', [
      z.object({ status: z.literal('succeeded'), result: connectorBusinessDataSchema(this.policy.readMaxEntries) }).strict(),
      z.object({ status: z.literal('rejected'), rejection: z.enum([
        'denied', 'not_accepted', 'unauthorized', 'rate_limited', 'invalid_input',
      ]) }).strict(),
      z.object({ status: z.literal('unknown') }).strict(),
    ]).safeParse(raw)
    if (!result.success) throw new OfficeError('execution_unknown', 'Company operation returned an invalid or oversized receipt')
    const { status, ...evidence } = result.data
    if (Buffer.byteLength(JSON.stringify({ stage: status, ...evidence }), 'utf8') > maxResultBytes)
      throw new OfficeError('execution_unknown', 'Company operation returned an invalid or oversized receipt')
    return result.data
  }

  /**
   * Execute one explicitly declared read against current employee and deployment policy.
   * @param actor - Active server-authenticated employee; administrators have no role override.
   * @param input - Exact reviewed action, saved connection and provider registration versions.
   * @param assertAuthorized - Recheck the originating durable session before network admission and result disclosure.
   * @returns A bounded sanitized receipt; writes, stale versions and undeclared actions never reach the adapter.
   */
  async readAction(
    actor: OfficeMember, input: OfficeConnectorReadInput, assertAuthorized: () => void,
  ): Promise<OfficeConnectorReadReceipt> {
    const parsed = officeConnectorReadInput.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid connector read request')
    const value = parsed.data
    const directory = await this.actions(actor, value.integrationId)
    if (directory.status !== 'unverified') throw new OfficeError('forbidden', 'Company connection is unavailable')
    if (directory.connectionRevision !== value.connectionRevision || directory.adapterRevision !== value.adapterRevision)
      throw new OfficeError('conflict', 'Reviewed company connection or adapter changed')
    const action = directory.actions.find(row => row.id === value.actionId)
    if (!action || action.kind !== 'read') throw new OfficeError('forbidden', 'Company read action is unavailable')
    const entry = this.domain.global.get().entries.find(row => row.integrationId === value.integrationId)
    const contribution = entry && this.adapters.get(entry.adapterId)
    if (!entry || !contribution?.read) throw new OfficeError('forbidden', 'Company read implementation is unavailable')
    if (contribution.actionRevision !== value.adapterRevision) throw new OfficeError('conflict', 'Company adapter changed')
    const authorized = await this.resolveHeaders(entry)
    this.assertOpen()
    if (this.adapters.get(entry.adapterId) !== contribution) throw new OfficeError('conflict', 'Company adapter changed')
    if (!authorized.ok) throw new OfficeError('forbidden', 'Company credentials are unavailable')
    assertAuthorized()
    const signal = AbortSignal.any([this.signal, contribution.lifetime.signal, AbortSignal.timeout(this.policy.timeoutMs)])
    let raw: OfficeConnectorReadResult
    try {
      raw = await contribution.read({ actionId: action.id, member: { id: actor.id, role: actor.role },
        baseUrl: entry.baseUrl, headers: authorized.headers, signal, maxResponseBytes: this.policy.maxResponseBytes,
        maxEntries: this.policy.readMaxEntries })
    } catch (error) {
      this.assertOpen()
      assertAuthorized()
      if (this.adapters.get(entry.adapterId) !== contribution) throw new OfficeError('conflict', 'Company adapter changed')
      if (!signal.aborted) throw error
      return { ...value, checkedAt: Date.now(), status: 'timed_out' }
    }
    this.assertOpen()
    assertAuthorized()
    if (this.adapters.get(entry.adapterId) !== contribution) throw new OfficeError('conflict', 'Company adapter changed')
    const coordinates = { ...value, checkedAt: Date.now() }
    if (signal.aborted) return { ...coordinates, status: 'timed_out' }
    const result = connectorReadResultSchema(this.policy.readMaxEntries).safeParse(raw)
    if (!result.success) return { ...coordinates, status: 'invalid_response' }
    const receipt = { ...coordinates, ...result.data }
    if (Buffer.byteLength(JSON.stringify(receipt), 'utf8') > this.policy.readMaxBytes)
      return { ...coordinates, status: 'invalid_response' }
    return receipt
  }

  /**
   * Recheck synchronous deployment availability immediately before a dependent internal business write.
   * @param integrationId - Required company registration.
   * @param expectedRevision - Connection version reviewed in the prepared context.
   */
  assertCurrentDependency(integrationId: OfficeIntegrationId, expectedRevision: number): void {
    const entry = this.domain.global.get().entries.find(row => row.integrationId === integrationId)
    if (!entry || !entry.enabled || this.policyBlocked(entry) || !this.adapters.has(entry.adapterId) ||
      (entry.authentication.kind !== 'none' && !this.credentials())) {
      throw new OfficeError('forbidden', 'Required company connection is unavailable')
    }
    if (entry.revision !== expectedRevision) throw new OfficeError('conflict', 'Required company connection version changed')
  }

  /**
   * Atomically save a reviewed connection without testing or installing code.
   * @param actor - Active administrator, authenticated inside the office queue.
   * @param input - Reviewed version and exact retry payload.
   * @returns Committed configuration metadata; failed validation and storage do not publish success.
   */
  async save(actor: OfficeMember, input: OfficeConnectorInput): Promise<OfficeConnectorEntry> {
    this.admin(actor)
    const parsed = officeConnectorInput.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid connection configuration')
    const value = parsed.data
    if (!this.integrations().some(entry => entry.id === value.integrationId))
      throw new OfficeError('not_found', 'Company integration is unavailable')
    const current = this.domain.global.get()
    const fingerprint = createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const retry = current.entries.find(entry => entry.requestId === value.requestId)
    if (retry) {
      if (retry.integrationId !== value.integrationId || retry.updatedBy !== actor.id || retry.fingerprint !== fingerprint)
        throw new OfficeError('conflict', 'Connection retry changed')
      return this.project(retry, actor, await this.status(retry))
    }
    const previous = current.entries.find(entry => entry.integrationId === value.integrationId)
    if (value.revision !== (previous?.revision ?? 0)) throw new OfficeError('conflict', 'Connection version changed')
    if (value.revision === Number.MAX_SAFE_INTEGER || current.revision === Number.MAX_SAFE_INTEGER)
      throw new OfficeError('conflict', 'Connection revision capacity reached')
    // Disabling remains available after deployment policy or an adapter is removed.
    if (value.enabled && (this.policyBlocked(value) || !this.adapters.has(value.adapterId)))
      throw new OfficeError('invalid_input', 'Connection requires an approved origin, credential alias and installed adapter')
    const saved = { ...value, revision: value.revision + 1, fingerprint, updatedAt: Date.now(), updatedBy: actor.id }
    const revision = current.revision + 1
    await this.domain.global.set({ revision,
      entries: [...current.entries.filter(entry => entry.integrationId !== value.integrationId), saved],
      audit: [...current.audit, { revision, integrationId: saved.integrationId, actorId: actor.id, time: saved.updatedAt }].slice(-1000) })
    await this.changed()
    return this.project(saved, actor, await this.status(saved))
  }

  /**
   * Check a saved version with fresh private credentials and a finite network/body deadline.
   * @param actor - Current administrator; ordinary employees cannot cause outbound requests.
   * @param input - Integration identity and reviewed connection version.
   * @returns Sanitized point-in-time result; no business data is changed and redirects are never followed.
   */
  async probe(actor: OfficeMember, input: z.infer<typeof officeConnectorProbeInput>): Promise<OfficeConnectorProbe> {
    this.admin(actor)
    const parsed = officeConnectorProbeInput.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid connection probe target')
    const entry = this.domain.global.get().entries.find(value => value.integrationId === parsed.data.integrationId)
    if (!entry) throw new OfficeError('not_found', 'Company connection is unavailable')
    if (entry.revision !== parsed.data.revision) throw new OfficeError('conflict', 'Connection version changed')
    const result = (status: OfficeConnectorProbe['status'], httpStatus?: number): OfficeConnectorProbe => ({
      integrationId: entry.integrationId, revision: entry.revision, checkedAt: Date.now(), status,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    })
    const status = await this.status(entry)
    if (status !== 'unverified') return result(status)
    const contribution = this.adapters.get(entry.adapterId)
    if (!contribution) return result('adapter_unavailable')
    const authorized = await this.resolveHeaders(entry)
    if (!authorized.ok) return result(authorized.status)
    this.assertOpen()
    if (this.adapters.get(entry.adapterId) !== contribution) return result('adapter_unavailable')
    const signal = AbortSignal.any([this.signal, contribution.lifetime.signal, AbortSignal.timeout(this.policy.timeoutMs)])
    const checked = await contribution.adapter.probe({ url: new URL(entry.probePath, entry.baseUrl).href,
      headers: authorized.headers, signal, maxResponseBytes: this.policy.maxResponseBytes })
    this.assertOpen()
    if (this.adapters.get(entry.adapterId) !== contribution) return result('adapter_unavailable')
    return result(checked.status, checked.httpStatus)
  }

  private async resolveHeaders(entry: OfficeConnectorConfiguration): Promise<
    | { readonly ok: true; readonly headers: Readonly<Record<string, string>> }
    | { readonly ok: false; readonly status: 'credential_missing' | 'credential_unavailable' }
  > {
    if (entry.authentication.kind === 'none') return { ok: true, headers: {} }
    const ref = this.policy.credentials.get(entry.authentication.credential)
    const provider = this.credentials()
    if (!ref || !provider) return { ok: false, status: 'credential_missing' }
    let resolved
    try { resolved = await provider.resolve(ref) }
    catch (error) {
      // Provider diagnostics remain private and no network request has been admitted.
      void error
      return { ok: false, status: 'credential_unavailable' }
    }
    if (!resolved) return { ok: false, status: 'credential_missing' }
    if (/[\r\n\u0000]/.test(resolved.value)) return { ok: false, status: 'credential_unavailable' }
    return { ok: true, headers: entry.authentication.kind === 'bearer'
      ? { authorization: `Bearer ${resolved.value}` } : { [entry.authentication.header]: resolved.value } }
  }

  private assertOpen(): void {
    if (this.signal.aborted) throw new OfficeError('closed', 'Office service is closed')
  }

  private admin(actor: OfficeMember): void {
    if (actor.role !== 'admin') throw new OfficeError('forbidden', 'Only administrators configure or check company connections')
  }

  private policyBlocked(value: OfficeConnectorConfiguration): boolean {
    return !this.policy.allowedOrigins.includes(new URL(value.baseUrl).origin) ||
      (value.authentication.kind !== 'none' && !this.policy.credentials.has(value.authentication.credential))
  }

  private async status(value: OfficeConnectorConfiguration): Promise<OfficeConnectorStatus> {
    if (!value.enabled) return 'disabled'
    if (this.policyBlocked(value)) return 'policy_blocked'
    if (!this.adapters.has(value.adapterId)) return 'adapter_unavailable'
    if (value.authentication.kind === 'none') return 'unverified'
    const provider = this.credentials()
    const ref = this.policy.credentials.get(value.authentication.credential)
    if (!provider || !ref) return 'credential_missing'
    try { return (await provider.describe(ref)).configured ? 'unverified' : 'credential_missing' }
    catch (error) {
      // Availability is visible as a distinct status; no secret-bearing provider error crosses the office wire.
      void error
      return 'credential_unavailable'
    }
  }

  private project(value: z.infer<typeof record>, actor: OfficeMember, status: OfficeConnectorStatus): OfficeConnectorEntry {
    return { integrationId: value.integrationId, revision: value.revision, adapterId: value.adapterId, status,
      updatedAt: value.updatedAt, ...(actor.role === 'admin' ? { configuration: { adapterId: value.adapterId, baseUrl: value.baseUrl,
        probePath: value.probePath, authentication: value.authentication, enabled: value.enabled } } : {}) }
  }
}
