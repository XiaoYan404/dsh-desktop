/** Browser-local navigation links reference native Sessions without owning their history or drafts. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const storageKey = 'dsh.sessions.links.v1'

interface Link {
  readonly sessionId: SessionId
  readonly initialized: boolean
}

/** Validate persisted interaction state before it can address a native Session. */
export class LinkedSessionIndex {
  private value: unknown = {}
  private hydrationFailed = false

  constructor() {
    try {
      if (typeof localStorage === 'undefined') return
      const saved = localStorage.getItem(storageKey)
      if (saved !== null) this.value = JSON.parse(saved) as unknown
    } catch { this.hydrationFailed = true }
  }

  /**
   * Resolve an opaque caller-owned navigation key.
   * @param key - Namespaced key, including the caller's account identity.
   * @returns Previously recorded native identity, when present.
   */
  get(key: string): Link | undefined {
    this.validateKey(key)
    const records = this.records()
    return Object.hasOwn(records, key) ? records[key] : undefined
  }

  /**
   * Remember an actual Session after its creation or confirmed input initialization.
   * @param key - Caller-owned account-qualified key.
   * @param value - Native identity and one-time initialization state.
   */
  set(key: string, value: Link): void {
    this.validateKey(key)
    const records = this.records()
    if (!Object.hasOwn(records, key) && Object.keys(records).length >= 2000) throw new Error('Too many linked conversations')
    this.value = { ...records, [key]: value }
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(storageKey, JSON.stringify(this.value))
    } catch (error) {
      console.error('Linked conversation navigation could not be saved:', error)
    }
  }

  private validateKey(key: string): void {
    if (!key || key.length > 1024) throw new Error('Invalid linked conversation key')
  }

  private records(): Readonly<Record<string, Link>> {
    if (this.hydrationFailed) throw new Error('Saved conversation links could not be loaded')
    const value = this.value
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved conversation links')
    for (const entry of Object.values(value as Readonly<Record<string, unknown>>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid saved conversation link')
      const link = entry as Readonly<Record<string, unknown>>
      if (!Object.hasOwn(link, 'sessionId') || typeof link.sessionId !== 'string' || !link.sessionId ||
        !Object.hasOwn(link, 'initialized') || typeof link.initialized !== 'boolean') throw new Error('Invalid saved conversation link')
    }
    return value as Readonly<Record<string, Link>>
  }
}
