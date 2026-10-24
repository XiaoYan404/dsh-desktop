/** Narrow adaptation of actual Desktop APIs and Connection commands; never loads another Fork. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** This subset is supplied only by this repository's protocol-v1 preload. */
export interface OfficeDesktopMaintenanceBridge {
  readonly protocolVersion: number
  readonly updates?: { open(): Promise<void> }
}

/** One lifecycle owns update failures and privacy-limited diagnostic output. */
export class OfficeMaintenanceModel {
  /** Standard registration-bound source; no component observes global objects. */
  readonly state = createSnapshotStore({ desktop: false, connected: false, busy: false, failed: false })
  private disposed = false

  /** @param bridge - Actual optional preload. @param reconnect - Existing Connection reconnect action. */
  constructor(private readonly bridge: OfficeDesktopMaintenanceBridge | undefined, private readonly reconnectAction: () => void) {
    this.state.set({ ...this.state.getSnapshot(), desktop: bridge?.protocolVersion === 1 && bridge.updates !== undefined })
  }

  /** @param connected - Existing Connection's observed carrier status. */
  connected(connected: boolean): void { if (!this.disposed) this.state.set({ ...this.state.getSnapshot(), connected }) }

  /** Open the real update window, whose native flow retains download and restart confirmation. */
  openUpdate(): void {
    const state = this.state.getSnapshot()
    if (this.disposed || !state.desktop || state.busy || !this.bridge?.updates) return
    this.state.set({ ...state, busy: true, failed: false })
    void this.bridge.updates.open().catch((_error: unknown) => {
      if (!this.disposed) this.state.set({ ...this.state.getSnapshot(), failed: true })
    }).finally(() => {
      if (!this.disposed) this.state.set({ ...this.state.getSnapshot(), busy: false })
    })
  }

  /** Reconnect through the native transport without deleting any Session or credential. */
  reconnect(): void { if (!this.disposed) this.reconnectAction() }

  /** @param assistants - Count only; no account data. @returns Privacy-limited support artifact. */
  diagnostics(assistants: number): string {
    const state = this.state.getSnapshot()
    return `${JSON.stringify({ format: 'office-diagnostics.v1', connection: state.connected ? 'connected' : 'disconnected',
      desktopUpdateBridge: state.desktop, phonePairing: false, savedAssistants: assistants }, null, 2)}\n`
  }

  /** Ignore late completion when the plugin unloads. */
  dispose(): void { this.disposed = true }
}
