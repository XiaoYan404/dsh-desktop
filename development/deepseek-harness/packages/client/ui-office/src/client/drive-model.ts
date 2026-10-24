/** Authorized drive projections and identity-fenced directory/file operations. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ClientRemote,
  RemoteResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  OfficeDriveDownload,
  OfficeDriveFolderInput,
  OfficeDriveId,
  OfficeDriveLocation,
  OfficeDrivePermissionsInput,
  OfficeDriveQuery,
  OfficeDriveRenameInput,
  OfficeDriveUploadInput,
  OfficeDriveView,
  OfficeMemberId,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'

interface DriveSnapshot {
  readonly view: OfficeDriveView | null
  readonly loading: boolean
  readonly busy: boolean
  readonly error: OfficeKey | null
  readonly search: string
  readonly canBack: boolean
  readonly canForward: boolean
}
type DriveRemote = Pick<
  ClientRemote['office'],
  | 'drive'
  | 'createDriveFolder'
  | 'renameDriveEntry'
  | 'saveDrivePermissions'
  | 'uploadDriveFile'
  | 'downloadDriveFile'
>
const root = (): OfficeDriveLocation => ({ space: 'private', folderId: null })
const initial = (): DriveSnapshot => ({
  view: null,
  loading: true,
  busy: false,
  error: null,
  search: '',
  canBack: false,
  canForward: false,
})
const same = (a: OfficeDriveLocation, b: OfficeDriveLocation) =>
  a.space === b.space && a.folderId === b.folderId

/** One plugin's drive state contains no browser-persisted private metadata or file bytes. */
export class OfficeDriveModel {
  /** Confirmed directory and navigation state exposed through slot hooks. */
  readonly state = createSnapshotStore<DriveSnapshot>(initial())
  private principal: OfficeMemberId | null = null
  private epoch = 0
  private generation = 0
  private disposed = false
  private query: OfficeDriveQuery = { ...root(), search: '' }
  private history: OfficeDriveLocation[] = [root()]
  private cursor = 0
  private move: {
    readonly location: OfficeDriveLocation
    readonly cursor?: number
  } | null = null

  constructor(
    private readonly remote: DriveRemote,
    private readonly notify: (key: OfficeKey, success: boolean) => void,
  ) {}

  /**
   * Fence old requests and navigation before publishing another employee's office view.
   * @param principal - Confirmed active employee, or null after authorization is lost.
   */
  bind(principal: OfficeMemberId | null): void {
    if (this.disposed || this.principal === principal) return
    this.principal = principal
    this.epoch++
    this.generation++
    this.query = { ...root(), search: '' }
    this.history = [root()]
    this.cursor = 0
    this.move = null
    this.state.set({ ...initial(), loading: principal !== null })
    if (principal) void this.load()
  }

  /** Refresh the latest requested location; stale reads never replace a newer navigation. */
  async load(): Promise<void> {
    if (this.disposed || !this.principal) return
    const epoch = this.epoch
    const generation = ++this.generation
    const query = this.query
    this.patch({ loading: true, error: null })
    try {
      const result = await this.remote.drive(query)
      if (this.stale(epoch) || generation !== this.generation) return
      const error = this.denial(result)
      if (error) {
        this.fail(error)
        return
      }
      if (!result.ok || !result.value.ok) return
      const view = result.value.value
      if (view.meId !== this.principal || !same(view.location, query)) {
        this.fail('forbidden')
        return
      }
      if (this.move && same(this.move.location, view.location)) {
        if (this.move.cursor !== undefined) this.cursor = this.move.cursor
        else if (!same(this.history[this.cursor] ?? root(), view.location)) {
          this.history = [
            ...this.history.slice(0, this.cursor + 1),
            view.location,
          ].slice(-100)
          this.cursor = this.history.length - 1
        }
        this.move = null
      }
      this.patch({
        view,
        loading: false,
        error: null,
        search: query.search,
        canBack: this.cursor > 0,
        canForward: this.cursor < this.history.length - 1,
      })
    } catch {
      if (!this.stale(epoch) && generation === this.generation)
        this.fail('unavailable')
    }
  }

  /**
   * Open a logical root or folder and reset that location's name search.
   * @param location - Opaque destination selected from an authorized projection.
   */
  async navigate(location: OfficeDriveLocation): Promise<void> {
    if (this.disposed || !this.principal) return
    this.query = { ...location, search: '' }
    this.move = { location }
    await this.load()
  }

  /**
   * Follow one confirmed history entry without manufacturing a new history item.
   * @param direction - Previous or next entry.
   */
  async step(direction: -1 | 1): Promise<void> {
    const cursor = this.cursor + direction
    const location = this.history[cursor]
    if (!location) return
    this.query = { ...location, search: '' }
    this.move = { location, cursor }
    await this.load()
  }

  /**
   * Search only the current logical folder's visible descendants.
   * @param search - Name fragment; empty restores the directory listing.
   */
  async search(search: string): Promise<void> {
    this.query = { ...this.query, search }
    await this.load()
  }

  /**
   * Create one directory, retaining the current view and form after failure.
   * @param input - Destination and name.
   * @returns Whether the Host confirmed the directory commit.
   */
  async createFolder(input: OfficeDriveFolderInput): Promise<boolean> {
    return (
      (await this.perform(() => this.remote.createDriveFolder(input), true)) !==
      null
    )
  }

  /**
   * Rename a reviewed entry through server-side ancestry and version checks.
   * @param input - Opaque entry, reviewed revision and new name.
   * @returns Whether the Host confirmed the rename.
   */
  async rename(input: OfficeDriveRenameInput): Promise<boolean> {
    return (
      (await this.perform(() => this.remote.renameDriveEntry(input), true)) !==
      null
    )
  }

  /**
   * Replace owner-managed shared conditions without optimistic permission changes.
   * @param input - Reviewed entry and replacement account conditions.
   * @returns Whether the Host confirmed the conditions.
   */
  async permissions(input: OfficeDrivePermissionsInput): Promise<boolean> {
    return (
      (await this.perform(
        () => this.remote.saveDrivePermissions(input),
        true,
      )) !== null
    )
  }

  /**
   * Keep an upload's exact retry identity until its commit is confirmed.
   * @param input - Bounded encoded file and original request id.
   * @returns Whether metadata and file bytes were confirmed durable.
   */
  async upload(input: OfficeDriveUploadInput): Promise<boolean> {
    return (
      (await this.perform(() => this.remote.uploadDriveFile(input), true)) !==
      null
    )
  }

  /**
   * Obtain authorized bytes; caller creates a browser download only after this confirms.
   * @param id - Opaque file identity from the current authorized directory.
   * @returns Content, or null after an actionable notification or identity replacement.
   */
  download(id: OfficeDriveId): Promise<OfficeDriveDownload | null> {
    return this.perform(() => this.remote.downloadDriveFile(id), false)
  }

  /** Clear private metadata and ignore every old response at plugin unload. */
  dispose(): void {
    this.disposed = true
    this.epoch++
    this.generation++
    this.history = []
    this.move = null
    this.state.set({ ...initial(), loading: false })
  }

  private async perform<T>(
    operation: () => Promise<RemoteResult<OfficeOutcome<T>>>,
    mutation: boolean,
  ): Promise<T | null> {
    if (this.disposed || !this.principal || this.state.getSnapshot().busy)
      return null
    const epoch = this.epoch
    this.patch({ busy: true })
    try {
      const result = await operation()
      if (this.stale(epoch)) return null
      const error = this.denial(result)
      if (error) {
        this.notify(error, false)
        if (error === 'unauthenticated') this.fail(error)
        if (
          error === 'forbidden' ||
          error === 'not_found' ||
          error === 'conflict'
        )
          await this.load()
        return null
      }
      if (!result.ok || !result.value.ok) return null
      if (mutation) {
        this.notify('saved', true)
        await this.load()
      }
      return this.stale(epoch) ? null : result.value.value
    } catch {
      if (!this.stale(epoch)) this.notify('unavailable', false)
      return null
    } finally {
      if (!this.stale(epoch)) this.patch({ busy: false })
    }
  }
  private patch(value: Partial<DriveSnapshot>): void {
    this.state.set({ ...this.state.getSnapshot(), ...value })
  }
  private stale(epoch: number): boolean {
    return this.disposed || epoch !== this.epoch
  }
  private denial<T>(result: RemoteResult<OfficeOutcome<T>>): OfficeKey | null {
    return !result.ok
      ? 'unavailable'
      : !result.value.ok
        ? result.value.code
        : null
  }
  private fail(error: OfficeKey): void {
    if (error === 'unauthenticated') this.bind(null)
    const denied =
      error === 'forbidden' ||
      error === 'not_found' ||
      error === 'unauthenticated'
    if (denied) {
      this.move = null
      this.history = [root()]
      this.cursor = 0
    }
    this.patch({
      loading: false,
      error,
      ...(denied ? { view: null, canBack: false, canForward: false } : {}),
    })
  }
}
