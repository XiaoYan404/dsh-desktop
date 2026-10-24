/** Account-fenced connection configuration and point-in-time checks; no credential values enter this model. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeConnectorInput, OfficeConnectorProbe, OfficeConnectorView, OfficeIntegrationId,
  OfficeConnectorActionsView, OfficeConnectorReadInput, OfficeConnectorReadReceipt, OfficeMember } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'

interface ConnectorSnapshot {
  readonly view: OfficeConnectorView | null
  readonly loading: boolean
  readonly busy: 'saving' | 'probing' | null
  readonly target: OfficeIntegrationId | null
  readonly error: OfficeKey | null
  readonly checks: Readonly<Record<string, OfficeConnectorProbe>>
  readonly catalogue: {
    readonly integrationId: OfficeIntegrationId
    readonly loading: boolean
    readonly view: OfficeConnectorActionsView | null
    readonly error: OfficeKey | null
    readonly result?: {
      readonly actionId: string
      readonly loading: boolean
      readonly receipt: OfficeConnectorReadReceipt | null
      readonly error: OfficeKey | null
    }
  } | null
}
type ConnectorRemote = Pick<ClientRemote['office'],
  'connections' | 'saveConnection' | 'probeConnection' | 'connectorActions' | 'readConnectorAction'>
/** Confirmed save or a current-account failure; null marks an unadmitted or superseded callback. */
export type ConnectorSaveOutcome = { readonly ok: true } | { readonly ok: false; readonly error: OfficeKey | null }

/** One owner releases administrator-only configuration on identity, role or plugin changes. */
export class OfficeConnectorsModel {
  /** Confirmed metadata, pending operation and version-matched check results; never secrets or remote response bodies. */
  readonly state = createSnapshotStore<ConnectorSnapshot>({
    view: null, loading: false, busy: null, target: null, error: null, checks: {}, catalogue: null,
  })
  private identity: string | null = null
  private role: OfficeMember['role'] | null = null
  private epoch = 0
  private read = 0
  private catalogueRead = 0
  private actionRead = 0
  private disposed = false

  constructor(private readonly remote: ConnectorRemote, private readonly notify: (key: OfficeKey, success: boolean) => void) {}

  /**
   * Clear private configuration before loading for a different account or authorization role.
   * @param member - Confirmed current employee, or null while signed out or authorization is unknown.
   */
  bind(member: Pick<OfficeMember, 'id' | 'role'> | null): void {
    const identity = member ? `${member.id}:${member.role}` : null
    if (this.disposed || this.identity === identity) return
    this.identity = identity
    this.role = member?.role ?? null
    this.epoch++
    this.read++
    this.catalogueRead++
    this.actionRead++
    this.state.set({ view: null, loading: false, busy: null, target: null, error: null, checks: {}, catalogue: null })
    if (member) void this.load()
  }

  /**
   * Refresh readiness without claiming connectivity or adopting a late/older view.
   * @param force - Supersede an outstanding read after a confirmed write or explicit reload.
   * @returns Fresh accepted view, or null after a denial, superseded read or unavailable response.
   */
  async load(force = false): Promise<OfficeConnectorView | null> {
    if (this.disposed || !this.identity || (!force && this.state.getSnapshot().loading)) return null
    if (force) { this.catalogueRead++; this.actionRead++; this.patch({ catalogue: null }) }
    const epoch = this.epoch
    const read = ++this.read
    this.patch({ loading: true })
    try {
      const result = await this.remote.connections()
      if (!this.current(epoch) || read !== this.read) return null
      const error = this.denial(result)
      if (error) { this.fail(error, false); return null }
      if (!result.ok || !result.value.ok) return null
      const view = result.value.value
      const previous = this.state.getSnapshot()
      if (previous.view && view.revision < previous.view.revision) { this.patch({ loading: false }); return null }
      const checks = Object.fromEntries(Object.entries(previous.checks).filter(([id, check]) =>
        view.entries.some(entry => entry.integrationId === id && entry.revision === check.revision && entry.status === 'unverified')))
      const directory = previous.catalogue?.view
      const connection = directory && view.entries.find(entry => entry.integrationId === directory.integrationId)
      const stale = directory && ((connection?.revision ?? 0) !== directory.connectionRevision ||
        (connection?.status ?? 'unconfigured') !== directory.status)
      if (stale) { this.catalogueRead++; this.actionRead++ }
      this.patch({ view, checks, loading: false, error: null, ...(stale ? { catalogue: null } : {}) })
      return view
    } catch {
      if (this.current(epoch) && read === this.read) this.fail('unavailable', false)
      return null
    }
  }

  /**
   * Read one directory on employee request without probing a system or executing an action.
   * @param id - Company system currently being inspected.
   * @returns Completion after the latest same-account request settles or is fenced by refresh or unload.
   */
  async loadActions(id: OfficeIntegrationId): Promise<void> {
    if (this.disposed || !this.identity || this.state.getSnapshot().busy ||
      this.state.getSnapshot().view?.actionCatalog?.protocol !== 1) return
    const epoch = this.epoch
    const read = ++this.catalogueRead
    this.actionRead++
    this.patch({ catalogue: { integrationId: id, loading: true, view: null, error: null } })
    try {
      const result = await this.remote.connectorActions(id)
      if (!this.current(epoch) || read !== this.catalogueRead) return
      const error = this.denial(result)
      if (error) {
        if (error === 'unauthenticated' || error === 'forbidden') this.fail(error, false)
        else this.patch({ catalogue: { integrationId: id, loading: false, view: null, error } })
        return
      }
      if (!result.ok || !result.value.ok) return
      const view = result.value.value
      this.patch({ catalogue: { integrationId: id, loading: false,
        view: view.integrationId === id ? view : null, error: view.integrationId === id ? null : 'conflict' } })
    } catch {
      if (this.current(epoch) && read === this.catalogueRead) {
        this.patch({ catalogue: { integrationId: id, loading: false, view: null, error: 'unavailable' } })
      }
    }
  }

  /**
   * Query a currently reviewed read action once; no automatic retries or business writes occur.
   * @param actionId - Role-admitted read declaration in the currently displayed system directory.
   * @returns Completion after the current account's query settles or a refresh, competing query or unload fences it.
   */
  async readAction(actionId: string): Promise<void> {
    const snapshot = this.state.getSnapshot()
    const catalogue = snapshot.catalogue
    const directory = catalogue?.view
    if (this.disposed || !this.identity || snapshot.busy || !catalogue || catalogue.loading ||
      !directory?.readSupported || directory.status !== 'unverified' || !directory.adapterRevision ||
      !directory.actions.some(action => action.id === actionId && action.kind === 'read')) return
    const input: OfficeConnectorReadInput = { integrationId: directory.integrationId, actionId,
      connectionRevision: directory.connectionRevision, adapterRevision: directory.adapterRevision }
    const epoch = this.epoch
    const catalogueRead = this.catalogueRead
    const request = ++this.actionRead
    const current = () => this.current(epoch) && catalogueRead === this.catalogueRead && request === this.actionRead
    this.patch({ catalogue: { ...catalogue, result: { actionId, loading: true, receipt: null, error: null } } })
    try {
      const result = await this.remote.readConnectorAction(input)
      if (!current()) return
      const error = this.denial(result)
      if (error === 'unauthenticated') { this.fail(error, false); return }
      if (error) {
        this.patch({ catalogue: { ...catalogue, result: { actionId, loading: false, receipt: null, error } } })
        return
      }
      if (!result.ok || !result.value.ok) return
      const receipt = result.value.value
      const matches = receipt.integrationId === input.integrationId && receipt.actionId === input.actionId &&
        receipt.connectionRevision === input.connectionRevision && receipt.adapterRevision === input.adapterRevision
      this.patch({ catalogue: { ...catalogue, result: { actionId, loading: false,
        receipt: matches ? receipt : null, error: matches ? null : 'conflict' } } })
    } catch {
      if (current()) this.patch({ catalogue: { ...catalogue, result: { actionId, loading: false, receipt: null, error: 'unavailable' } } })
    }
  }

  /**
   * Save an exact caller-owned retry request; the form retains it until success or explicit replacement.
   * @param input - Reviewed configuration version and retained UUID; contains only credential aliases.
   * @returns Whether this account received a confirmed commit; a failed refresh cannot undo that commit.
   */
  async save(input: OfficeConnectorInput): Promise<ConnectorSaveOutcome> {
    if (!this.canStart()) return { ok: false, error: null }
    const epoch = this.epoch
    this.read++
    this.catalogueRead++
    this.actionRead++
    this.patch({ busy: 'saving', target: input.integrationId, error: null, loading: false, catalogue: null })
    try {
      const result = await this.remote.saveConnection(input)
      if (!this.current(epoch)) return { ok: false, error: null }
      const error = this.denial(result)
      if (error) {
        if (error === 'conflict') await this.load(true)
        if (this.current(epoch)) this.fail(error)
        return { ok: false, error: this.current(epoch) ? error : null }
      }
      if (!result.ok || !result.value.ok) return { ok: false, error: null }
      this.patch({ view: null, checks: {}, error: null })
      this.notify('connectorSaved', true)
      await this.load(true)
      return this.current(epoch) ? { ok: true } : { ok: false, error: null }
    } catch {
      if (this.current(epoch)) this.fail('unavailable')
      return { ok: false, error: this.current(epoch) ? 'unavailable' : null }
    } finally {
      if (this.current(epoch)) this.patch({ busy: null, target: null })
    }
  }

  /**
   * Check one reviewed version once; ordinary employees cannot initiate outbound requests.
   * @param id - Registered integration identity.
   * @param revision - Current reviewed connection version.
   * @returns Completion after a version-matched result or visible localized error.
   */
  async probe(id: OfficeIntegrationId, revision: number): Promise<void> {
    if (!this.canStart()) return
    const epoch = this.epoch
    this.patch({ busy: 'probing', target: id, error: null })
    try {
      const result = await this.remote.probeConnection(id, revision)
      if (!this.current(epoch)) return
      const error = this.denial(result)
      if (error) {
        if (error === 'conflict') await this.load(true)
        if (this.current(epoch)) this.fail(error)
        return
      }
      if (!result.ok || !result.value.ok) return
      const check = result.value.value
      const current = this.state.getSnapshot()
      if (check.integrationId !== id || check.revision !== revision ||
        !current.view?.entries.some(entry => entry.integrationId === id && entry.revision === revision)) return
      this.patch({ checks: { ...current.checks, [id]: check } })
    } catch {
      if (this.current(epoch)) this.fail('unavailable')
    } finally {
      if (this.current(epoch)) this.patch({ busy: null, target: null })
    }
  }

  /** Release configuration and fence every late callback when this plugin unloads. */
  dispose(): void {
    this.bind(null)
    this.disposed = true
    this.epoch++
    this.read++
  }

  private canStart(): boolean {
    if (this.disposed || !this.identity || this.state.getSnapshot().busy) return false
    if (this.role !== 'admin') { this.fail('forbidden'); return false }
    return true
  }
  private current(epoch: number): boolean { return !this.disposed && epoch === this.epoch }
  private patch(value: Partial<ConnectorSnapshot>): void { this.state.set({ ...this.state.getSnapshot(), ...value }) }
  private fail(error: OfficeKey, notify = true): void {
    const denied = error === 'unauthenticated' || error === 'forbidden'
    if (denied) this.catalogueRead++
    this.patch({ loading: false, error, ...(denied ? { view: null, checks: {}, catalogue: null } : {}) })
    if (error === 'unauthenticated') this.bind(null)
    if (notify || error === 'unauthenticated') this.notify(error, false)
  }
  private denial<T>(result: RemoteResult<OfficeOutcome<T>>): OfficeKey | null {
    return !result.ok ? 'unavailable' : !result.value.ok ? result.value.code : null
  }
}
