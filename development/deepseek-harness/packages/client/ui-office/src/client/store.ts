/** Remount-surviving interaction state; business records stay in OfficeModel. */
import { createSnapshotStore, defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { recordValue, withoutKey } from './values.ts'
import type { OfficeWorkFilter } from './work-list.ts'

interface OfficeViewState {
  draft: string
  query: string
  filter: OfficeWorkFilter
  status: string
  selected: string | null
}
type OfficeViewActions = {
  setDraft(this: void, state: OfficeViewState, value: string): void
  clearDraft(this: void, state: OfficeViewState, expected: string): void
  setQuery(this: void, state: OfficeViewState, value: string): void
  setFilter(this: void, state: OfficeViewState, value: OfficeWorkFilter): void
  setStatus(this: void, state: OfficeViewState, value: string): void
  setSelected(this: void, state: OfficeViewState, value: string | null): void
}

/**
 * Keep interaction state in the panel's registration lifetime.
 * @param ownReset - Optional owner registration for clearing live instances before an account change.
 * @returns A fresh store for filters, search and the unsent home prompt.
 */
export function createOfficeViewStore(ownReset?: (reset: () => void) => void): EngineStoreHandle<OfficeViewState, OfficeViewActions> {
  const handle = defineStore({
    init: (): OfficeViewState => ({ draft: '', query: '', filter: 'mine', status: 'all', selected: null }),
    actions: {
      setDraft(state, value: string) {
        state.draft = value
      },
      clearDraft(state, expected: string) {
        if (state.draft === expected) state.draft = ''
      },
      setQuery(state, value: string) {
        state.query = value
      },
      setFilter(state, value: 'mine' | 'dispatched' | 'all') {
        state.filter = value
      },
      setStatus(state, value: string) {
        state.status = value
      },
      setSelected(state, value: string | null) {
        state.selected = value
      },
    },
  })
  return {
    ...handle,
    create(scopeKey?: string) {
      const instance = handle.create(scopeKey)
      ownReset?.(() => { instance.store.set(handle.spec.init()) })
      return instance
    },
  }
}

/** Drafts shared across office panels belong to one mounted employee identity. */
export class OfficeChatDraftStore {
  /** Unsent text indexed by contact, independent of confirmed message history. */
  readonly state = createSnapshotStore<Readonly<Record<string, string>>>({})
  private principal: OfficeMemberId | null | undefined

  /**
   * Clear drafts before a different employee can observe them.
   * @param principal - Confirmed employee, or null after authorization is lost.
   */
  bind(principal: OfficeMemberId | null): void {
    if (principal !== this.principal) {
      this.principal = principal
      this.dispose()
    }
  }

  /**
   * Change only one contact's unsent text.
   * @param peer - Selected contact.
   * @param text - Current editable draft.
   */
  set(peer: OfficeMemberId, text: string): void {
    this.state.set({ ...this.state.getSnapshot(), [peer]: text })
  }

  /**
   * Clear a confirmed send without removing text typed while its request was in flight.
   * @param peer - Recipient captured when sending.
   * @param expected - Exact draft the Host confirmed.
   */
  clear(peer: OfficeMemberId, expected: string): void {
    const drafts = this.state.getSnapshot()
    if (recordValue(drafts, peer) !== expected) return
    this.state.set(withoutKey(drafts, peer))
  }

  /** Drop private drafts when this plugin or employee identity unloads. */
  dispose(): void {
    this.state.set({})
  }
}
