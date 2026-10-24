/** Employee search retains only bounded authorized results and cancels superseded queries and navigation. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { OfficeDriveEntry, OfficeItem, OfficeMember, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeSection } from './navigation-model.ts'
import type { OfficeKey } from './locales.ts'
import { affiliation } from './organization.ts'

/** Search uses existing navigation destinations and never submits an Agent request. */
export interface OfficeSearchPage {
  readonly section: OfficeSection | 'ai' | 'settings'
  readonly title: string
}

/** Results preserve the exact destination identity; metadata is not an authorization grant. */
export type OfficeSearchResult = { readonly key: string; readonly title: string; readonly description: string } & (
  | { readonly kind: 'page'; readonly page: OfficeSearchPage }
  | { readonly kind: 'member'; readonly member: OfficeMember }
  | { readonly kind: 'item'; readonly item: OfficeItem }
  | { readonly kind: 'file'; readonly file: OfficeDriveEntry }
  | { readonly kind: 'skill'; readonly skill: SkillEntry; readonly sessionId: SessionId }
)

/** Each lookup finishes with a fresh employee view; partial file/skill failures remain visible. */
export interface OfficeSearchData {
  readonly view: OfficeView
  readonly files: readonly OfficeDriveEntry[]
  readonly skills: readonly SkillEntry[]
  readonly sessionId: SessionId | null
  readonly failures: readonly OfficeKey[]
}

interface SearchSnapshot {
  readonly open: boolean
  readonly query: string
  readonly loading: boolean
  readonly opening: boolean
  readonly results: readonly OfficeSearchResult[]
  readonly failures: readonly OfficeKey[]
  readonly limited: boolean
  readonly target: OfficeSearchResult | null
}
const initial = (): SearchSnapshot => ({ open: false, query: '', loading: false, opening: false,
  results: [], failures: [], limited: false, target: null })
const identityOf = (member: Pick<OfficeMember, 'id' | 'role'>) => `${member.id}:${member.role}`
const matches = (query: string, values: readonly string[]) => values.join('\n').toLocaleLowerCase().includes(query)
// Keep each category represented within a bounded result publication.
const categoryLimit = 20

/** One employee/role owns the popup, every query and its pending destination. */
export class OfficeSearchModel {
  /** JSON-only popup and navigation state supplied through framework hooks. */
  readonly state = createSnapshotStore<SearchSnapshot>(initial())
  private identity: string | null = null
  private pages: readonly OfficeSearchPage[] = []
  private pending: AbortController | undefined
  private disposed = false

  constructor(
    private readonly lookup: (query: string, signal: AbortSignal) => Promise<OfficeSearchData>,
    private readonly navigate: (result: OfficeSearchResult, signal: AbortSignal) => Promise<boolean>,
  ) {}

  /**
   * Discard private results before another employee or role is published.
   * @param member - Current authenticated employee, or null after loss of access.
   */
  bind(member: Pick<OfficeMember, 'id' | 'role'> | null): void {
    const identity = member ? identityOf(member) : null
    if (this.disposed || identity === this.identity) return
    this.identity = identity
    this.cancel()
    this.state.set(initial())
  }

  /**
   * Open a fresh popup with localized page destinations and no retained query.
   * @param pages - Current locale's supported page names.
   */
  open(pages: readonly OfficeSearchPage[]): void {
    if (this.disposed || !this.identity) return
    this.cancel()
    this.pages = pages
    this.state.set({ ...initial(), open: true, results: this.pageResults('') })
  }

  /** Cancel all pending work and close the popup without navigating. */
  close(): void { this.cancel(); this.state.set(initial()) }

  /**
   * Search current authorized business metadata; older responses cannot replace a newer query.
   * @param input - User query, bounded to 200 characters.
   * @returns After the current lookup settles or its replacement cancels it.
   */
  async query(input: string): Promise<void> {
    if (this.disposed || !this.identity || !this.state.getSnapshot().open) return
    this.cancel()
    const query = input.trim().toLocaleLowerCase()
    this.patch({ query: input, results: this.pageResults(query), failures: [], limited: false, opening: false, loading: false })
    if (!query) return
    if (input.length > 200) { this.patch({ results: [], failures: ['invalid_input'] }); return }
    const pending = new AbortController()
    this.pending = pending
    this.patch({ loading: true })
    try {
      const data = await this.lookup(input.trim(), pending.signal)
      if (!this.current(pending)) return
      if (identityOf(data.view.me) !== this.identity) throw new Error('Office search identity changed')
      const members: OfficeSearchResult[] = data.view.members.flatMap((member) => {
        const labels = affiliation(data.view.organization, member)
        const description = `${labels.department} · ${labels.jobTitle}`
        return matches(query, [member.name, member.id, description])
          ? [{ key: `member:${member.id}`, kind: 'member', title: member.name, description, member }] : []
      })
      const items: OfficeSearchResult[] = [...data.view.items, ...(data.view.inactiveWork ?? [])]
        .filter(item => matches(query, [item.title, item.description]))
        .map(item => ({ key: `item:${item.id}`, kind: 'item', title: item.title, description: item.date, item }))
      const files: OfficeSearchResult[] = data.files.filter(file => matches(query, [file.name]))
        .map(file => ({ key: `file:${file.id}`, kind: 'file', title: file.name, description: file.space, file }))
      const sessionId = data.sessionId
      const skills: OfficeSearchResult[] = sessionId === null ? [] : data.skills
        .filter(skill => matches(query, [skill.name, skill.description, skill.whenToUse ?? '']))
        .map(skill => ({ key: `skill:${skill.name}`, kind: 'skill', title: skill.name,
          description: skill.description, skill, sessionId }))
      const categories = [this.pageResults(query), members, items, files, skills]
      this.patch({ results: categories.flatMap(values => values.slice(0, categoryLimit)),
        limited: categories.some(values => values.length > categoryLimit), failures: data.failures })
    } catch {
      if (this.current(pending)) this.patch({ results: this.pageResults(query), failures: ['unavailable'] })
    } finally {
      if (this.current(pending)) { this.pending = undefined; this.patch({ loading: false }) }
    }
  }

  /**
   * Reauthorize one exact result before navigating; cancellation and account changes suppress late opens.
   * @param key - Result currently shown in this popup.
   * @returns Whether this selection opened its still-authorized destination.
   */
  async select(key: string): Promise<boolean> {
    const state = this.state.getSnapshot()
    const result = state.results.find(result => result.key === key)
    if (this.disposed || !this.identity || !state.open || state.loading || state.opening || !result) return false
    this.cancel()
    const pending = new AbortController()
    this.pending = pending
    this.patch({ opening: true, failures: [] })
    try {
      const opened = await this.navigate(result, pending.signal)
      if (!this.current(pending)) return false
      if (!opened) {
        this.patch({ results: state.results.filter(entry => entry.key !== key), failures: ['searchDestinationUnavailable'] })
        return false
      }
      this.state.set({ ...initial(), target: result.kind === 'page' ? null : result })
      return true
    } catch {
      if (this.current(pending)) this.patch({ failures: ['searchDestinationUnavailable'] })
      return false
    } finally {
      if (this.current(pending)) { this.pending = undefined; this.patch({ opening: false }) }
    }
  }

  /**
   * Release a destination only after its owning page has applied it.
   * @param key - Exact result applied by the page.
   */
  consume(key: string): void { if (this.state.getSnapshot().target?.key === key) this.patch({ target: null }) }

  /** Withdraw results and pending requests when the office plugin unloads. */
  dispose(): void { this.disposed = true; this.close() }

  private pageResults(query: string): OfficeSearchResult[] {
    return this.pages.filter(page => matches(query, [page.title])).map(page => ({
      key: `page:${page.section}`, kind: 'page', title: page.title, description: '', page,
    }))
  }
  private current(pending: AbortController): boolean {
    return !this.disposed && !pending.signal.aborted && this.pending === pending
  }
  private cancel(): void { this.pending?.abort(); this.pending = undefined }
  private patch(values: Partial<SearchSnapshot>): void { this.state.set({ ...this.state.getSnapshot(), ...values }) }
}
