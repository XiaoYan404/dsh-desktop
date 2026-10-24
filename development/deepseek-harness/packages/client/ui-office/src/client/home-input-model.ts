/** Runtime file handles stay private; hooks publish only metadata and preparation status. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'

interface HomeFile {
  readonly id: string
  readonly name: string
  readonly byteLength: number
}
interface HomeInputState {
  readonly files: readonly HomeFile[]
  readonly preparing: boolean
  readonly failed: boolean
}

/** One mounted office account owns its unsent browser-file selection. */
export class OfficeHomeInputModel {
  /** JSON metadata only; File objects never enter a hook snapshot or saved state. */
  readonly state = createSnapshotStore<HomeInputState>({ files: [], preparing: false, failed: false })
  private readonly files = new Map<string, File>()
  private principal: OfficeMemberId | null | undefined
  private pending: AbortController | undefined
  private disposed = false

  constructor(private readonly prepare: (
    prompt: string, files: readonly File[], submit: boolean, signal: AbortSignal,
  ) => Promise<boolean>) {}

  /**
   * Fence pending preparation before another account can observe its selection.
   * @param principal - Confirmed active employee, or null on sign-out.
   */
  bind(principal: OfficeMemberId | null): void {
    if (principal === this.principal) return
    this.principal = principal
    this.cancel()
    this.files.clear()
    this.state.set({ files: [], preparing: false, failed: false })
  }

  /**
   * Retain immutable browser handles without reading or uploading their bytes.
   * @param files - Selection from this account's file picker.
   */
  add(files: readonly File[]): void {
    if (this.isDisposed() || !this.principal || this.pending) return
    const added = files.map((file) => {
      const id = randomUUID()
      this.files.set(id, file)
      return { id, name: file.name, byteLength: file.size }
    })
    this.state.set({ ...this.state.getSnapshot(), files: [...this.state.getSnapshot().files, ...added], failed: false })
  }

  /**
   * Remove one selected handle before preparation starts.
   * @param id - This window's opaque selection identity.
   */
  remove(id: string): void {
    if (this.pending || this.isDisposed()) return
    this.files.delete(id)
    this.state.set({ ...this.state.getSnapshot(), files: this.state.getSnapshot().files.filter(file => file.id !== id), failed: false })
  }

  /**
   * Prepare one fresh native input; a failure retains the exact original selection for retry.
   * @param prompt - Captured home text.
   * @param submit - Explicit Send rather than Expand.
   * @returns True only after the native owner confirms adoption and opens the target.
   */
  async start(prompt: string, submit: boolean): Promise<boolean> {
    if (this.isDisposed() || !this.principal || this.pending || (submit && !prompt.trim() && this.files.size === 0)) return false
    const controller = new AbortController()
    this.pending = controller
    this.state.set({ ...this.state.getSnapshot(), preparing: true, failed: false })
    try {
      const result = await this.prepare(prompt, [...this.files.values()], submit, controller.signal)
      if (this.isDisposed() || this.pending !== controller || controller.signal.aborted) return false
      if (result) this.files.clear()
      this.state.set({ files: result ? [] : this.state.getSnapshot().files, preparing: false, failed: !result })
      return result
    } catch {
      if (!this.isDisposed() && this.pending === controller && !controller.signal.aborted) {
        this.state.set({ ...this.state.getSnapshot(), preparing: false, failed: true })
      }
      return false
    } finally {
      if (this.pending === controller) this.pending = undefined
    }
  }

  /** Stop preparation while keeping this account's unsent choices for a later attempt. */
  cancel(): void {
    const pending = this.pending
    this.pending = undefined
    pending?.abort(new DOMException('Office input preparation was cancelled', 'AbortError'))
    this.state.set({ ...this.state.getSnapshot(), preparing: false, failed: false })
  }

  /** Release private file handles and prevent late responses from publishing after unload. */
  dispose(): void {
    this.disposed = true
    this.cancel()
    this.files.clear()
    this.state.set({ files: [], preparing: false, failed: false })
  }

  private isDisposed(): boolean { return this.disposed }
}
