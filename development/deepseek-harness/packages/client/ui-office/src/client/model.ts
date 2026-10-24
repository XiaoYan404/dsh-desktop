/** React-free office projection. Only confirmed Host reads replace business data. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ClientRemote,
  RemoteResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  OfficeMemberId,
  OfficeView,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'

interface OfficeSnapshot {
  readonly view: OfficeView | null
  readonly loading: boolean
  readonly busy: boolean
  readonly error: OfficeKey | null
}
interface OfficeNotice {
  readonly seq: number
  readonly key: OfficeKey
  readonly success: boolean
}

/** One model belongs to one mounted office plugin, never to a module-level singleton. */
export class OfficeModel {
  /** Confirmed employee projection plus transport and mutation status. */
  readonly state = createSnapshotStore<OfficeSnapshot>({
    view: null,
    loading: true,
    busy: false,
    error: null,
  })
  /** Sequenced localized result notice, consumed by the shell toast. */
  readonly notice = createSnapshotStore<OfficeNotice | null>(null)
  private disposed = false
  private readSequence = 0
  private selectedDate: string | undefined
  private noticeSequence = 0
  private identityEpoch = 0

  constructor(
    private readonly remote: Pick<ClientRemote['office'], 'view'>,
    private readonly onIdentity: (id: OfficeMemberId | null) => void = () => {},
  ) {}

  /**
   * Replace the projection only when this read is still current.
   * @param date - Calendar day, or null to select the configured office today.
   * @returns Completion after a confirmed read or a published failure.
   */
  async load(date: string | null = this.selectedDate ?? null): Promise<void> {
    if (this.isDisposed()) return
    const sequence = ++this.readSequence
    this.selectedDate = date ?? undefined
    if (!this.state.getSnapshot().view)
      this.state.set({
        ...this.state.getSnapshot(),
        loading: true,
        error: null,
      })
    try {
      const result = await this.remote.view(this.selectedDate)
      if (this.isDisposed() || sequence !== this.readSequence) return
      if (!result.ok) {
        this.fail('unavailable')
        return
      }
      if (!result.value.ok) {
        this.fail(result.value.code)
        return
      }
      const next = result.value.value
      if (this.state.getSnapshot().view?.me.id !== next.me.id)
        this.onIdentity(next.me.id)
      this.state.set({
        ...this.state.getSnapshot(),
        view: next,
        loading: false,
        error: null,
      })
    } catch {
      if (!this.isDisposed() && sequence === this.readSequence)
        this.fail('unavailable')
    }
  }

  /**
   * Admit one write and reload confirmed state after success or a stale authorization answer.
   * @param operation - Typed Host mutation for the deployment-owned employee.
   * @returns Whether the Host confirmed this write.
   */
  async mutate<T>(
    operation: () => Promise<RemoteResult<OfficeOutcome<T>>>,
  ): Promise<boolean> {
    if (this.isDisposed() || this.state.getSnapshot().busy) return false
    const epoch = this.identityEpoch
    this.state.set({ ...this.state.getSnapshot(), busy: true })
    try {
      const result = await operation()
      if (this.isDisposed() || epoch !== this.identityEpoch) return false
      const key = !result.ok
        ? 'unavailable'
        : !result.value.ok
          ? result.value.code
          : null
      if (key) {
        this.report(key, false)
        if (key === 'unauthenticated') this.fail(key)
        if (key === 'conflict' || key === 'forbidden' || key === 'not_found')
          await this.load()
        return false
      }
      this.report('saved', true)
      await this.load()
      return true
    } catch {
      if (!this.isDisposed() && epoch === this.identityEpoch)
        this.report('unavailable', false)
      return false
    } finally {
      if (!this.isDisposed() && epoch === this.identityEpoch)
        this.state.set({ ...this.state.getSnapshot(), busy: false })
    }
  }

  /** Clear the current result notice. */
  dismiss(): void {
    this.notice.set(null)
  }

  /** Fence previous-account reads and writes before publishing a changed sign-in identity. */
  clear(): void {
    if (this.isDisposed()) return
    this.identityEpoch++
    this.readSequence++
    this.onIdentity(null)
    this.notice.set(null)
    this.selectedDate = undefined
    this.state.set({ view: null, loading: false, busy: false, error: null })
  }
  /**
   * Report a result from another office feature through the shared shell toast.
   * @param key - Localized operation result.
   * @param success - Whether the operation was confirmed successful.
   */
  notify(key: OfficeKey, success: boolean): void {
    if (!this.isDisposed()) this.report(key, success)
  }
  /** Fence in-flight responses when this plugin lifetime ends. */
  dispose(): void {
    this.disposed = true
    this.readSequence++
  }

  private isDisposed(): boolean {
    return this.disposed
  }

  private report(key: OfficeKey, success: boolean): void {
    this.notice.set({ seq: ++this.noticeSequence, key, success })
  }
  private fail(error: OfficeKey): void {
    if (error === 'forbidden' || error === 'unauthenticated') {
      this.readSequence++
      this.identityEpoch++
      this.onIdentity(null)
    }
    this.state.set({
      ...this.state.getSnapshot(),
      ...(error === 'forbidden' || error === 'unauthenticated'
        ? { view: null, busy: false }
        : {}),
      loading: false,
      error,
    })
  }
}
