/** Administrator audit browsing and reviewed downloads discard every pending result when authority or filters change. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeAuditCursor, OfficeAuditExport, OfficeAuditQuery, OfficeAuditRecord, OfficeAuditSource,
  OfficeMember, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'
import { readOfficeAuditFields } from './audit-filter-fields.ts'
import type { OfficeAuditFilters } from './audit-filter-fields.ts'
export type { OfficeAuditFilters } from './audit-filter-fields.ts'

interface AuditSnapshot {
  readonly open: boolean
  readonly filters: OfficeAuditFilters
  readonly applied: OfficeAuditQuery | null
  readonly entries: readonly OfficeAuditRecord[]
  readonly next: OfficeAuditCursor | null
  readonly total: number
  readonly loading: boolean
  readonly exporting: boolean
  readonly stale: boolean
  readonly error: OfficeKey | null
  readonly validation: OfficeKey | null
}
type AuditRemote = Pick<ClientRemote['office'], 'auditPage' | 'auditExport'>
const sources: readonly OfficeAuditSource[] = ['business', 'identity', 'organization', 'drive', 'integration', 'connection', 'request_denial']
const initial = (): AuditSnapshot => ({ open: false,
  filters: { source: '', actorId: '', targetId: '', action: '', since: '', until: '' },
  applied: null, entries: [], next: null, total: 0, loading: false, exporting: false, stale: false,
  error: null, validation: null })

/** One layout-owned audit browser shares no records or downloads between employees or authorization roles. */
export class OfficeAuditModel {
  /** Query state and allowlisted metadata consumed through a framework-bound hook. */
  readonly state = createSnapshotStore<AuditSnapshot>(initial())
  private identity: OfficeMemberId | null = null
  private generation = 0
  private disposed = false

  constructor(private readonly remote: AuditRemote,
    private readonly notify: (key: OfficeKey, success: boolean) => void,
    private readonly download: (content: string) => void) {}

  /**
   * Immediately clear private results when an administrator changes account, loses authority or signs out.
   * @param member - Current active directory authority, or null when it is unavailable.
   */
  bind(member: Pick<OfficeMember, 'id' | 'role' | 'active'> | null): void {
    const identity = member?.active && member.role === 'admin' ? member.id : null
    if (this.disposed || this.identity === identity) return
    this.identity = identity
    this.close()
  }

  /** Open a fresh administrator search and read its first bounded page. */
  async open(): Promise<void> {
    if (this.disposed || !this.identity) return
    this.close()
    this.patch({ open: true })
    await this.search()
  }

  /** Close the audit browser and prevent pending reads or exports from publishing or downloading. */
  close(): void { this.generation++; this.state.set(initial()) }

  /**
   * Replace one draft filter and discard results from the previous query before new input is shown.
   * @param key - Form-owned filter name.
   * @param value - Exact local form text; datetime fields use the browser's local time zone.
   */
  field(key: keyof OfficeAuditFilters, value: string): void {
    const snapshot = this.state.getSnapshot()
    if (this.disposed || !this.identity || !snapshot.open || snapshot.filters[key] === value) return
    this.generation++
    this.patch({ filters: { ...snapshot.filters, [key]: value }, applied: null, entries: [], next: null,
      total: 0, loading: false, exporting: false, stale: false, error: null, validation: null })
  }

  /** Apply reviewed filters; a new search supersedes every earlier page and download. */
  async search(): Promise<void> {
    const snapshot = this.state.getSnapshot()
    if (this.disposed || !this.identity || !snapshot.open) return
    const query = filtersQuery(snapshot.filters)
    if (!query) { this.patch({ validation: 'auditInvalidFilters' }); return }
    const generation = ++this.generation
    this.patch({ applied: query, entries: [], next: null, total: 0, loading: false,
      exporting: false, stale: false, error: null, validation: null })
    await this.page(query, generation, false)
  }

  /** Read one explicit older page while retaining already displayed rows after a query failure. */
  async more(): Promise<void> {
    const snapshot = this.state.getSnapshot()
    if (this.disposed || !this.identity || !snapshot.open || !snapshot.applied || !snapshot.next ||
      snapshot.loading || snapshot.exporting || snapshot.stale) return
    await this.page({ ...snapshot.applied, before: snapshot.next }, this.generation, true)
  }

  /**
   * Reauthorize bounded export batches and download exactly the currently displayed metadata rows.
   * @returns After browser download dispatch; changed records or partial failures produce no file.
   */
  async export(): Promise<void> {
    const snapshot = this.state.getSnapshot()
    if (this.disposed || !this.identity || !snapshot.open || !snapshot.applied || !snapshot.entries.length ||
      snapshot.loading || snapshot.exporting || snapshot.stale) return
    const generation = this.generation
    this.patch({ exporting: true })
    let before: OfficeAuditCursor | null = null
    let offset = 0
    const content: string[] = []
    try {
      while (offset < snapshot.entries.length) {
        const limit = Math.min(100, snapshot.entries.length - offset)
        const result = await this.remote.auditExport({ ...snapshot.applied, limit, before })
        if (!this.current(generation)) return
        const error = denial(result)
        if (error) { this.exportFailure(error); return }
        if (!result.ok || !result.value.ok) return
        const batch = result.value.value
        const expected = snapshot.entries.slice(offset, offset + limit)
        if (!matchesExport(batch, expected)) { this.exportFailure('auditChanged'); return }
        content.push(batch.content)
        offset += batch.count
        before = batch.next
        if (offset < snapshot.entries.length && !before) { this.exportFailure('auditChanged'); return }
      }
      if (!this.current(generation)) return
      this.download(content.join(''))
      this.patch({ exporting: false })
      this.notify('auditDownloadStarted', true)
    } catch {
      if (this.current(generation)) this.exportFailure('unavailable')
    }
  }

  /** Permanently release metadata and block delayed callbacks on plugin unload. */
  dispose(): void { this.close(); this.identity = null; this.disposed = true }

  private async page(query: OfficeAuditQuery, generation: number, older: boolean): Promise<void> {
    this.patch({ loading: true, error: null })
    try {
      const result = await this.remote.auditPage(query)
      if (!this.current(generation)) return
      const error = denial(result)
      if (error) { this.pageFailure(error); return }
      if (!result.ok || !result.value.ok) return
      const page = result.value.value
      const entries = older ? [...this.state.getSnapshot().entries, ...page.entries] : page.entries
      const last = page.entries.at(-1)
      if (new Set(entries.map(entry => `${entry.source}:${entry.revision}`)).size !== entries.length ||
        (page.next && (!last || !samePosition(page.next, position(last))))) {
        this.pageFailure('conflict'); return
      }
      this.patch({ entries, next: page.next, total: page.total, loading: false, error: null })
    } catch {
      if (this.current(generation)) this.pageFailure('unavailable')
    }
  }
  private current(generation: number): boolean {
    return !this.disposed && this.identity !== null && this.state.getSnapshot().open && generation === this.generation
  }
  private pageFailure(error: OfficeKey): void {
    if (this.authorityFailure(error)) return
    this.patch({ loading: false, error })
  }
  private exportFailure(error: OfficeKey): void {
    if (this.authorityFailure(error)) return
    this.patch({ exporting: false, stale: error === 'auditChanged' })
    this.notify(error, false)
  }
  private authorityFailure(error: OfficeKey): boolean {
    if (error !== 'unauthenticated' && error !== 'forbidden') return false
    this.bind(null)
    this.notify(error, false)
    return true
  }
  private patch(value: Partial<AuditSnapshot>): void { this.state.set({ ...this.state.getSnapshot(), ...value }) }
}

function filtersQuery(filters: OfficeAuditFilters): OfficeAuditQuery | null {
  const parsed = readOfficeAuditFields(filters, sources)
  if(!parsed) return null
  const { source, actorId, targetId, action, since, until } = parsed
  return { limit: 20, before: null,
    ...source ? { source } : {}, ...actorId ? { actorId } : {},
    ...targetId ? { targetId } : {}, ...action ? { action } : {},
    ...since !== null ? { since } : {}, ...until !== null ? { until } : {} }
}
function position(record: OfficeAuditRecord): OfficeAuditCursor {
  return { time: record.time, source: record.source, revision: record.revision }
}
function samePosition(left: OfficeAuditCursor, right: OfficeAuditCursor): boolean {
  return left.source === right.source && left.revision === right.revision && left.time === right.time
}
function matchesExport(batch: OfficeAuditExport, expected: readonly OfficeAuditRecord[]): boolean {
  if (batch.count !== expected.length || !batch.content.endsWith('\n')) return false
  const lines = batch.content.slice(0, -1).split('\n')
  if (lines.length !== expected.length) return false
  try {
    return lines.every((line, index) => {
      const value: unknown = JSON.parse(line)
      const record = expected[index]
      return record !== undefined && value !== null && typeof value === 'object' &&
        Object.keys(value).length === (record.denialCode === undefined ? 6 : 7) &&
        'source' in value && value.source === record.source && 'revision' in value && value.revision === record.revision &&
        'actorId' in value && value.actorId === record.actorId && 'action' in value && value.action === record.action &&
        'targetId' in value && value.targetId === record.targetId && 'time' in value && value.time === record.time &&
        (record.denialCode === undefined || (record.source === 'request_denial' &&
          'denialCode' in value && value.denialCode === record.denialCode))
    })
  } catch {
    return false
  }
}
function denial<T>(result: RemoteResult<OfficeOutcome<T>>): OfficeKey | null {
  return !result.ok ? 'unavailable' : !result.value.ok ? result.value.code : null
}
