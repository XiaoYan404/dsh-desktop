/** Local profile package observations never stand in for a central office server's deployment. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeMember } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeIntegrationPlugins } from '../types.ts'
import type { OfficeKey } from './locales.ts'

interface PluginSnapshot {
  readonly view: OfficeIntegrationPlugins | null
  readonly loading: boolean
  readonly error: OfficeKey | null
}
const empty: PluginSnapshot = { view: null, loading: false, error: null }

/** Explicit metadata reads share identity and role fences with the office page; package writes stay in Native. */
export class OfficeIntegrationPluginsModel {
  /** Safe declarations, observed package selection and actual Loader row counts. */
  readonly state = createSnapshotStore<PluginSnapshot>(empty)
  private member: Pick<OfficeMember, 'id' | 'role'> | null = null
  private epoch = 0
  private disposed = false

  constructor(private readonly remote: Pick<ClientRemote['office'], 'integrationPlugins'>,
    private readonly notify: (key: OfficeKey) => void) {}

  /**
   * Clear package observations before another employee or role can use them.
   * @param member - Current authenticated office member, or null when authorization is unknown.
   */
  bind(member: Pick<OfficeMember, 'id' | 'role'> | null): void {
    if (this.disposed || (this.member?.id === member?.id && this.member?.role === member?.role)) return
    this.member = member ? { id: member.id, role: member.role } : null
    this.epoch++
    this.state.set(empty)
  }

  /**
   * Read real profile metadata without installation, enablement or customer network activity.
   * @returns After an accepted metadata read settles; account replacement and unload discard late responses.
   */
  async load(): Promise<void> {
    if (this.disposed || !this.member || this.state.getSnapshot().loading) return
    const epoch = this.epoch
    this.state.set({ ...empty, loading: true })
    try {
      const result = await this.remote.integrationPlugins()
      if (!this.current(epoch)) return
      const error = !result.ok ? 'unavailable' : !result.value.ok ? result.value.code : null
      if (error) { this.fail(error); return }
      if (!result.ok || !result.value.ok) return
      const view = result.value.value
      if (view.meId !== this.member.id) { this.fail('conflict'); return }
      this.state.set({ view, loading: false, error: null })
    } catch {
      if (this.current(epoch)) this.fail('unavailable')
    }
  }

  /** Release retained package observations and fence pending metadata responses. */
  dispose(): void { this.bind(null); this.disposed = true }

  private current(epoch: number): boolean { return !this.disposed && this.member !== null && epoch === this.epoch }
  private fail(error: OfficeKey): void {
    if (error === 'unauthenticated' || error === 'forbidden') {
      this.bind(null)
      this.notify(error)
    } else this.state.set({ ...empty, error })
  }
}
