/** Reviewed business submissions preserve their exact retry identity across ambiguous transport outcomes. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeConnectorActionView, OfficeConnectorActionsView, OfficeConnectorExecutionReceipt,
  OfficeConnectorView, OfficeConnectorWriteInput, OfficeMember } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeKey } from './locales.ts'

interface SubmissionDraft {
  readonly system: string
  readonly action: OfficeConnectorActionView
  readonly input: OfficeConnectorWriteInput
}
interface SubmissionSnapshot {
  readonly draft: SubmissionDraft | null
  readonly phase: 'edit' | 'review' | 'submitting' | 'uncertain' | 'receipt'
  readonly attempted: boolean
  readonly stale: boolean
  readonly error: OfficeKey | null
  readonly receipt: OfficeConnectorExecutionReceipt | null
}
const empty: SubmissionSnapshot = { draft: null, phase: 'edit', attempted: false, stale: false, error: null, receipt: null }
type SubmissionRemote = Pick<ClientRemote['office'], 'writeConnectorAction'>

/** One explicit reviewed request; closing or account replacement never automatically submits or cancels a remote effect. */
export class OfficeSubmissionsModel {
  /** Plain JSON draft, review and durable receipt; credentials and arbitrary URLs never enter this owner. */
  readonly state = createSnapshotStore<SubmissionSnapshot>(empty)
  private identity: Pick<OfficeMember, 'id' | 'role'> | null = null
  private epoch = 0
  private disposed = false

  constructor(private readonly remote: SubmissionRemote, private readonly notify: (key: OfficeKey) => void) {}

  /**
   * Immediately discard another account or role's draft and fence any late submission acknowledgement.
   * @param member - Confirmed current active employee, or null while authority is unknown.
   */
  bind(member: Pick<OfficeMember, 'id' | 'role'> | null): void {
    if (this.disposed || (this.identity?.id === member?.id && this.identity?.role === member?.role)) return
    this.identity = member ? { id: member.id, role: member.role } : null
    this.epoch++
    this.state.set(empty)
  }

  /**
   * Start a fresh draft only from a current explicitly advertised write declaration.
   * @param directory - Current role-filtered directory with exact reviewed connection/provider versions.
   * @param system - Current company display name for human review.
   * @param actionId - Declared write identity; read or metadata-only implementations cannot open a submission.
   */
  begin(directory: OfficeConnectorActionsView, system: string, actionId: string): void {
    if (this.disposed || !this.identity || this.state.getSnapshot().phase === 'submitting') return
    const action = directory.actions.find(entry => entry.id === actionId && entry.kind === 'write')
    if (directory.status !== 'unverified' || !directory.writeSupported || !directory.adapterRevision || !action) return
    this.epoch++
    this.state.set({ ...empty, draft: { system, action: { ...action,
      ...action.fields === undefined ? {} : { fields: action.fields.map(field => ({ ...field })) } },
    input: { integrationId: directory.integrationId, actionId, connectionRevision: directory.connectionRevision,
      adapterRevision: directory.adapterRevision, requestId: randomUUID(), values: {} } } })
  }

  /**
   * Update only a declared field before the first send; a retry can never silently adopt edited business values.
   * @param name - Exact declaration name.
   * @param value - Employee text preserved without trimming or normalization.
   */
  field(name: string, value: string): void {
    const snapshot = this.state.getSnapshot()
    const draft = snapshot.draft
    if (this.disposed || !draft || snapshot.phase !== 'edit' || snapshot.attempted ||
      !draft.action.fields?.some(field => field.name === name)) return
    this.patch({ draft: { ...draft, input: { ...draft.input, values: { ...draft.input.values, [name]: value } } }, error: null })
  }

  /** Validate declared required text and length before presenting the immutable submission review. */
  review(): void {
    const snapshot = this.state.getSnapshot()
    const draft = snapshot.draft
    if (this.disposed || !draft || snapshot.phase !== 'edit' || snapshot.stale) return
    const invalid = draft.action.fields?.some((field) => {
      const value = Object.hasOwn(draft.input.values, field.name) ? draft.input.values[field.name] ?? '' : ''
      return (field.required && !value.trim()) || value.length > field.maxLength
    })
    if (invalid) { this.patch({ error: 'invalid_input' }); return }
    this.patch({ phase: 'review', error: null })
  }

  /** Return to editing before any request has been sent; attempted requests retain their exact reviewed payload. */
  edit(): void {
    const snapshot = this.state.getSnapshot()
    if (!this.disposed && snapshot.phase === 'review' && !snapshot.attempted) this.patch({ phase: 'edit', error: null })
  }

  /**
   * Invalidate stale configuration without rewriting a reviewed or possibly committed request.
   * @param view - Latest connection readiness, or null after authority/configuration reset.
   * @param directory - Latest loaded action directory, when one is available for this system.
   */
  synchronize(view: OfficeConnectorView | null, directory?: OfficeConnectorActionsView | null): void {
    const snapshot = this.state.getSnapshot()
    const input = snapshot.draft?.input
    if (this.disposed || !input || snapshot.receipt) return
    const connection = view?.entries.find(entry => entry.integrationId === input.integrationId)
    if (connection?.revision !== input.connectionRevision || connection.status !== 'unverified' ||
      (directory?.integrationId === input.integrationId &&
        (directory.adapterRevision !== input.adapterRevision || !directory.writeSupported)))
      this.patch({ stale: true })
  }

  /**
   * Send only after explicit review, or explicitly recover the same ambiguous request without a new retry UUID.
   * @returns When the accepted send settles; one pending click owns the request and late account results are discarded.
   */
  async submit(): Promise<void> {
    const snapshot = this.state.getSnapshot()
    const draft = snapshot.draft
    const identity = this.identity
    if (this.disposed || !identity || !draft || (snapshot.phase !== 'review' && snapshot.phase !== 'uncertain') ||
      (snapshot.stale && snapshot.phase !== 'uncertain')) return
    const epoch = this.epoch
    this.patch({ phase: 'submitting', attempted: true, error: null })
    try {
      const result = await this.remote.writeConnectorAction(draft.input)
      if (!this.current(epoch)) return
      if (!result.ok) { this.patch({ phase: 'uncertain', error: 'unavailable' }); return }
      if (!result.value.ok) {
        const code = result.value.code
        if (code === 'unauthenticated' || code === 'forbidden') {
          this.epoch++
          this.state.set(empty)
          this.notify(code)
          return
        }
        this.patch({ phase: code === 'execution_unknown' ? 'uncertain' : 'review', error: code,
          stale: code !== 'execution_unknown' })
        return
      }
      const receipt = result.value.value
      if (receipt.memberId !== identity.id || receipt.integrationId !== draft.input.integrationId ||
        receipt.actionId !== draft.input.actionId ||
        (receipt.requestId !== draft.input.requestId && receipt.status !== 'unknown') ||
        (receipt.requestId === draft.input.requestId && (receipt.connectionRevision !== draft.input.connectionRevision ||
          receipt.adapterRevision !== draft.input.adapterRevision))) {
        this.patch({ phase: 'uncertain', error: 'conflict' }); return
      }
      // An equivalent unresolved operation may return its original request id; never relabel it as this draft's new identity.
      this.patch({ phase: 'receipt', receipt, error: null })
    } catch {
      if (this.current(epoch)) this.patch({ phase: 'uncertain', error: 'unavailable' })
    }
  }

  /** Close a settled draft; a request already in flight must settle before this modal can be dismissed. */
  close(): void {
    if (this.state.getSnapshot().phase === 'submitting') return
    this.epoch++
    this.state.set(empty)
  }

  /** Discard private state and fence acknowledgements when the owning plugin unloads. */
  dispose(): void { this.epoch++; this.disposed = true; this.identity = null; this.state.set(empty) }

  private current(epoch: number): boolean { return !this.disposed && epoch === this.epoch }
  private patch(value: Partial<SubmissionSnapshot>): void { this.state.set({ ...this.state.getSnapshot(), ...value }) }
}
