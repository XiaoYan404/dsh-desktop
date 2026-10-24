/** Shared native-open status for delivery cards, the changed-files card, and closing-message file mentions. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { changedFileUrl } from '../changes.ts'
import { presentedDownloadUrl, presentedFileUrl, PRESENT_HOST_ROUTE, isPresentedHost, type PresentedAction, type PresentedHost } from '../presented.ts'

/** Success feedback remains fully visible for five seconds before fading. */
export const PRESENTED_SUCCESS_HOLD_MS = 5000
/** Fade interval shared by the card animation and status expiry. */
export const PRESENTED_SUCCESS_FADE_MS = 200

/** Failure feedback for the shared native opening control. */
export type PresentedOpenFailure = 'openError' | 'revealError' | null

/** State published on the owning file card. */
export type PresentedOpenPhase = 'opening' | 'opened' | 'revealing' | 'revealed' | 'error' | 'revealError' | 'nativeUnavailable'
  | 'downloading' | 'downloaded' | 'downloadError' | 'downloadTooLarge'

/** Hand a complete successful response to the browser's download manager. */
function saveDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.append(link)
    try { link.click() } finally { link.remove() }
  } finally {
    setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
  }
}

/** One browser plugin's file-open requests, cancelled when that plugin is disposed. */
export class PresentedOpenController {
  /** File action URLs key the state across Sessions, turns, and both clickable surfaces. */
  readonly state = createSnapshotStore<Record<string, PresentedOpenPhase | undefined>>({})
  /** Native destination metadata, or a retryable read failure. */
  readonly host = createSnapshotStore<PresentedHost | 'error' | null>(null)
  private readonly expiry = new Map<string, ReturnType<typeof setTimeout>>()
  private loading: Promise<void> | undefined
  private metadata = new AbortController()
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<void | PresentedOpenFailure>>()

  /** @param save - browser handoff; replaceable by byte-inspecting tests. */
  constructor(private readonly save: (blob: Blob, name: string) => void = saveDownload) {}

  /**
   * Download the current source bytes after the Host validates the durable declaration.
   * @param sessionId - viewed Session.
   * @param seq - durable delivery event sequence.
   * @param index - original file index.
   * @param name - displayed basename for the browser's save dialog.
   * @returns after a browser handoff or retryable card error; cancellation never hands off bytes.
   */
  async download(sessionId: SessionId, seq: number, index: number, name: string): Promise<void> {
    const url = presentedFileUrl(sessionId, seq, index)
    const phase = this.state.getSnapshot()[url]
    if (this.lifetime.signal.aborted || phase === 'opening' || phase === 'revealing' || phase === 'downloading') return
    this.clearExpiry(url)
    this.state.update((state) => { state[url] = 'downloading' })
    const task = this.requestDownload(presentedDownloadUrl(sessionId, seq, index), url, name,
      AbortSignal.any([this.lifetime.signal, this.metadata.signal]))
    this.pending.add(task)
    try { await task } finally { this.pending.delete(task) }
  }

  private async requestDownload(target: string, url: string, name: string, signal: AbortSignal): Promise<void> {
    let phase: PresentedOpenPhase = 'downloadError'
    try {
      const response = await fetch(target, { signal })
      if (response.ok) {
        const blob = await response.blob()
        if (!signal.aborted) {
          this.save(blob, name)
          phase = 'downloaded'
        }
      } else if (response.status === 413) phase = 'downloadTooLarge'
    } catch {
      phase = 'downloadError'
    }
    if (!signal.aborted) {
      if (phase === 'downloaded') this.expireSuccess(url)
      this.state.update((state) => { state[url] = phase })
    }
  }

  /**
   * Open a declared file once while a request for the same coordinates is pending.
   * Failures remain visible on the card and a later gesture retries them.
   * @param sessionId - viewed Session, including a fork's own identity.
   * @param seq - durable delivery event sequence.
   * @param index - original file index within that event.
   * @param action - default application open or file-manager reveal.
   * @param application - registered handler identifier for an explicit application choice.
   * @returns null after a successful handoff, or the failure to announce after publishing card status.
   */
  open(
    sessionId: SessionId, seq: number, index: number, action: PresentedAction = 'open', application?: string,
  ): Promise<PresentedOpenFailure> {
    return this.openUrl(presentedFileUrl(sessionId, seq, index), action, application)
  }

  /**
   * Open one recorded changed file in the Host's default application.
   * @param sessionId - viewed Session.
   * @param seq - durable workspace/changes event sequence.
   * @param index - original file index within that event.
   * @param action - application open or file-manager reveal.
   * @param application - registered handler identifier for an explicit application choice.
   * @returns null after a successful handoff, or the failure to announce after publishing card status.
   */
  openChanged(
    sessionId: SessionId, seq: number, index: number, action: PresentedAction = 'open', application?: string,
  ): Promise<PresentedOpenFailure> {
    return this.openUrl(changedFileUrl(sessionId, seq, index), action, application)
  }

  private async openUrl(url: string, action: PresentedAction, application?: string): Promise<PresentedOpenFailure> {
    const phase = this.state.getSnapshot()[url]
    if (this.lifetime.signal.aborted || phase === 'opening' || phase === 'revealing' || phase === 'downloading') return null
    this.clearExpiry(url)
    this.state.update((state) => { state[url] = action === 'open' ? 'opening' : 'revealing' })
    const task = this.request(url, action, application)
    this.pending.add(task)
    try {
      return await task
    } finally {
      this.pending.delete(task)
    }
  }

  /**
   * Read the serving desktop metadata, coalescing concurrent reads; a later call retries failure.
   * @returns after metadata or a retryable error is published.
   */
  async loadHost(): Promise<void> {
    if (this.lifetime.signal.aborted) return
    if (this.loading !== undefined) return this.loading
    this.host.set(null)
    const task = this.readHost(AbortSignal.any([this.lifetime.signal, this.metadata.signal]))
    this.loading = task
    this.pending.add(task)
    try { await task }
    finally {
      if (this.loading === task) this.loading = undefined
      this.pending.delete(task)
    }
  }

  /** Invalidate desktop metadata on connection replacement; mounted cards request the new Host. */
  resetHost(): void {
    const wasLoading = this.loading !== undefined
    this.metadata.abort()
    this.metadata = new AbortController()
    this.loading = undefined
    const downloads = Object.entries(this.state.getSnapshot()).filter(([, phase]) =>
      phase === 'downloading' || phase === 'downloaded' || phase === 'downloadError' || phase === 'downloadTooLarge')
    if (downloads.length > 0) {
      for (const [url] of downloads) this.clearExpiry(url)
      this.state.update((state) => { for (const [url] of downloads) Reflect.deleteProperty(state, url) })
    }
    this.host.set(null)
    if (wasLoading) void this.loadHost()
  }

  private async readHost(signal: AbortSignal): Promise<void> {
    let host: PresentedHost | 'error' = 'error'
    try {
      const response = await fetch(PRESENT_HOST_ROUTE, { signal })
      if (response.ok) {
        const value: unknown = await response.json()
        if (isPresentedHost(value)) host = value
      }
    } catch {
      host = 'error'
    }
    if (!signal.aborted) this.host.set(host)
  }

  /** Cancel outstanding requests and wait until no request can publish state. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    for (const url of this.expiry.keys()) this.clearExpiry(url)
    await Promise.all(this.pending)
  }

  private clearExpiry(url: string): void {
    clearTimeout(this.expiry.get(url))
    this.expiry.delete(url)
  }

  private expireSuccess(url: string): void {
    this.expiry.set(url, setTimeout(() => {
      this.expiry.delete(url)
      this.state.update((state) => { Reflect.deleteProperty(state, url) })
    }, PRESENTED_SUCCESS_HOLD_MS + PRESENTED_SUCCESS_FADE_MS))
  }

  private async request(url: string, action: PresentedAction, application?: string): Promise<PresentedOpenFailure> {
    const failure = action === 'open' ? 'error' : 'revealError'
    let phase: PresentedOpenPhase = action === 'open' ? 'opened' : 'revealed'
    try {
      const target = action === 'reveal' ? `${url}&action=reveal`
        : application === undefined ? url : `${url}&application=${encodeURIComponent(application)}`
      const response = await fetch(target, { method: 'POST', signal: this.lifetime.signal })
      if (!response.ok) phase = response.status === 422 ? 'nativeUnavailable' : failure
    } catch {
      // Transport failures share the retryable card state with Host open failures.
      phase = failure
    }
    if (!this.lifetime.signal.aborted) {
      if (phase === 'opened' || phase === 'revealed') {
        this.expireSuccess(url)
      }
      this.state.update((state) => { state[url] = phase })
    }
    return phase === 'opened' || phase === 'revealed' ? null : action === 'reveal' ? 'revealError' : 'openError'
  }
}
