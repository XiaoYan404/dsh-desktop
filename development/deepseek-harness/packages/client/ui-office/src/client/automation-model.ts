/** Own automation state and exact reviews are invalidated across account, role and dialog changes; mutations never retry automatically. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeAutomationRule, OfficeAutomationRun, OfficeAutomationRunId } from
  '@deepseek-ai/dsh-enterprise-office'
import type { OfficeAutomationCommandInput, OfficeAutomationResponse } from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeMember, OfficeIntegrationId, OfficeConnectorActionsView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../types.ts'

type Review = Extract<OfficeAutomationResponse, { kind: 'review' }>['review']
/** Exact editable fields; company identity and credentials remain outside this form. */
export type OfficeAutomationDraft = Extract<OfficeAutomationCommandInput, { kind: 'save' }>['input']
/** Controller-owned private snapshot; labels and visible errors are localized by the presentation. */
export interface OfficeAutomationSnapshot {
  readonly opened: boolean
  /** A current successful list read is required for changes; failed reads retain the last visible records. */
  readonly loaded: boolean
  readonly rules: readonly OfficeAutomationRule[]
  readonly runs: readonly OfficeAutomationRun[]
  readonly busy: boolean
  /** Unconfirmed mutations require a successful list read before another change; original-result recovery stays available. */
  readonly needsRefresh: boolean
  /** A lost new-rule creation receipt locks this draft even after refresh, until the editor is explicitly discarded. */
  readonly saveUncertain: boolean
  readonly error: 'unavailable' | 'denied' | null
  readonly review: Review | null
  readonly editor: OfficeAutomationDraft | null
  readonly directory: OfficeConnectorActionsView | null
}
/** Structural Remote port avoids advertising support from generated metadata alone. */
export interface OfficeAutomationRemote {
  /** Existing authenticated Office controller; input cannot select an employee. */
  automation(command: OfficeAutomationCommandInput): Promise<RemoteResult<OfficeOutcome<OfficeAutomationResponse>>>
  /** Read current declared actions for one configured company system; metadata alone does not authorize execution. */
  connectorActions(id: OfficeIntegrationId): Promise<RemoteResult<OfficeOutcome<OfficeConnectorActionsView>>>
}
const empty: OfficeAutomationSnapshot = { opened: false, loaded: false, rules: [], runs: [], busy: false,
  needsRefresh: false, saveUncertain: false, error: null,
  review: null, editor: null, directory: null }

/** Client owner has no scheduler, business credentials, or authority to infer success after a lost acknowledgment. */
export class OfficeAutomationModel {
  readonly state = createSnapshotStore<OfficeAutomationSnapshot>(empty)
  private identity: string | null = null
  private epoch = 0
  constructor(private readonly remote: OfficeAutomationRemote) {}
  /**
   * Clear all private content when account or role changes.
   * @param member - Current authenticated membership, or absence while authentication is unavailable.
   */
  bind(member: Pick<OfficeMember, 'id' | 'role'> | null): void {
    const key = member ? `${member.id}:${member.role}` : null
    if (key === this.identity) return
    this.identity = key; this.close()
  }
  /** Release private data and invalidate every late response. */
  close(): void { this.epoch++; this.state.set(empty) }
  /** Open and explicitly load current own rules/runs; a read never starts execution. */
  async open(): Promise<void> {
    if (!this.identity) return
    this.close()
    this.state.set({ ...empty, opened: true })
    await this.send({ kind: 'list' })
  }
  /** Refresh own state without repeating any prior mutation. */
  async refresh(): Promise<void> { await this.send({ kind: 'list' }) }
  /**
   * Send one explicit rule management choice; successful saves refresh state by a read only.
   * @param input - Exact closed rule definition from the existing employee configuration form.
   */
  async save(input: Extract<OfficeAutomationCommandInput, { kind: 'save' }>['input']): Promise<void> {
    const current = this.state.getSnapshot()
    if (current.busy || current.needsRefresh || current.saveUncertain && input.id === null) return
    if (current.editor) this.state.set({ ...current, editor: input })
    if (await this.send({ kind: 'save', input })) await this.refresh()
  }
  /**
   * Toggle only the displayed rule's enabled flag with its exact revision.
   * @param rule - Own currently displayed rule; no fields are rewritten or normalized.
   */
  async toggle(rule: OfficeAutomationRule): Promise<void> {
    const { ownerId: _owner, ownerRole: _role, createdAt: _created, ...input } = rule
    await this.save({ ...input, enabled: !rule.enabled })
  }
  /**
   * Admit one explicit form occurrence for this employee; it creates review records without performing a business write.
   * @param rule - Displayed own enabled form rule.
   */
  async triggerForm(rule: OfficeAutomationRule): Promise<void> {
    if (rule.trigger.kind !== 'form' || !rule.enabled) return
    if (await this.send({ kind: 'form', source: rule.trigger.source, occurrence: randomUUID() })) await this.refresh()
  }
  /**
   * Prepare an exact rule form from the current system's declared write operations.
   * @param integrationId - Visible company registration selected by the employee.
   * @param draft - Own existing editable fields, or absence for a new disabled rule.
   */
  async edit(integrationId: OfficeIntegrationId, draft?: OfficeAutomationDraft): Promise<void> {
    const before = this.state.getSnapshot()
    if (!this.identity || !before.opened || !before.loaded || before.busy || before.needsRefresh || before.saveUncertain) return
    const epoch = ++this.epoch
    this.state.set({ ...before, busy: true, error: null, review: null,
      editor: draft ?? null, directory: draft ? before.directory : null })
    try {
      const result = await this.remote.connectorActions(integrationId)
      if (epoch !== this.epoch) return
      if (!result.ok || !result.value.ok) {
        this.state.set({ ...this.state.getSnapshot(), busy: false, error: result.ok ? 'denied' : 'unavailable' }); return
      }
      const directory = result.value.value
      const sameSystem = draft?.action.integrationId === integrationId
      const selected = sameSystem
        ? directory.actions.find(value => value.kind === 'write' && value.id === draft.action.actionId)
        : directory.actions.find(value => value.kind === 'write')
      if (directory.integrationId !== integrationId || !directory.adapterRevision || !directory.writeSupported ||
        !directory.actions.some(value => value.kind === 'write')) {
        this.state.set({ ...this.state.getSnapshot(), busy: false, error: 'denied' }); return
      }
      const action = { integrationId, connectionRevision: directory.connectionRevision, adapterRevision: directory.adapterRevision,
        actionId: sameSystem ? draft.action.actionId : selected?.id ?? '',
        values: sameSystem ? draft.action.values : Object.fromEntries((selected?.fields ?? []).map(field => [field.name, ''])) }
      const editor: OfficeAutomationDraft = draft ? { ...draft, action } : { id: null, revision: 0, title: '', enabled: false,
        trigger: { kind: 'form', source: '' }, action, compensation: null }
      this.state.set({ ...this.state.getSnapshot(), busy: false, editor, directory })
    } catch (error) {
      void error
      if (epoch === this.epoch) this.state.set({ ...this.state.getSnapshot(), busy: false, error: 'unavailable' })
    }
  }
  /** Discard unsaved configuration only while no request is pending; no server mutation or source registration is performed. */
  closeEditor(): void {
    if (this.state.getSnapshot().busy) return
    this.epoch++
    this.state.set({ ...this.state.getSnapshot(), busy: false, editor: null, directory: null, saveUncertain: false })
  }
  /**
   * Obtain the server's exact immutable review; opening it does not grant permission to execute.
   * @param id - Own displayed run.
   * @param part - Explicit primary or compensation review.
   */
  async review(id: OfficeAutomationRunId, part: 'primary' | 'compensation'): Promise<void> {
    await this.send({ kind: 'review', id, part })
  }
  /** Close an idle review without unlocking an in-flight confirmation; original run and request identities remain retained. */
  closeReview(): void {
    if (this.state.getSnapshot().busy) return
    this.epoch++; this.state.set({ ...this.state.getSnapshot(), review: null })
  }
  /**
   * Confirm only the exact currently displayed review, never a stale callback's coordinates.
   * @param review - Current complete reviewed fields and phase.
   */
  async confirm(review: Review): Promise<void> {
    if (this.state.getSnapshot().review !== review) return
    if (await this.send({ kind: 'execute', id: review.runId, revision: review.revision, part: review.part })) await this.refresh()
  }
  /**
   * Issue one explicit cancellation, compensation request or definitive-nonacceptance retry request.
   * @param run - Own currently displayed run and revision.
   * @param command - Human-selected action; unknown outcomes can only be recovered.
   */
  async manage(run: OfficeAutomationRun, command: 'cancel' | 'compensate' | 'retry'): Promise<void> {
    if (await this.send({ kind: 'manage', id: run.id, revision: run.revision, command })) await this.refresh()
  }
  /**
   * Read only an original execution's current evidence.
   * @param id - Own retained run.
   * @param part - Primary or compensation phase whose outcome is unknown.
   */
  async recover(id: OfficeAutomationRunId, part: 'primary' | 'compensation'): Promise<void> {
    if (await this.send({ kind: 'recover', id, part })) await this.refresh()
  }
  private async send(command: OfficeAutomationCommandInput): Promise<boolean> {
    const snapshot = this.state.getSnapshot()
    const mutation = command.kind === 'save' || command.kind === 'form' || command.kind === 'execute' || command.kind === 'manage'
    if (!this.identity || !snapshot.opened || snapshot.busy || mutation && (!snapshot.loaded || snapshot.needsRefresh)) return false
    const epoch = this.epoch
    this.state.set({ ...snapshot, busy: true, error: null })
    try {
      const response = await this.remote.automation(command)
      if (epoch !== this.epoch) return false
      if (!response.ok || !response.value.ok) {
        this.state.set({ ...this.state.getSnapshot(), busy: false, error: response.ok ? 'denied' : 'unavailable',
          ...command.kind === 'list' ? { loaded: false } : {},
          ...!response.ok && mutation ? { needsRefresh: true,
            saveUncertain: snapshot.saveUncertain || command.kind === 'save' && command.input.id === null } : {} })
        return false
      }
      const result = response.value.value
      const current = this.state.getSnapshot()
      this.state.set(result.kind === 'list'
        ? { ...current, busy: false, loaded: true, rules: result.rules, runs: result.runs, review: null, needsRefresh: false }
        : result.kind === 'review' ? { ...current, busy: false, review: result.review }
          : { ...current, busy: false, review: null,
            ...result.kind === 'rule' ? { editor: null, directory: null, saveUncertain: false } : {} })
      return true
    } catch (error) {
      void error
      if (epoch === this.epoch) this.state.set({ ...this.state.getSnapshot(), busy: false, error: 'unavailable',
        ...command.kind === 'list' ? { loaded: false } : {},
        ...mutation ? { needsRefresh: true,
          saveUncertain: snapshot.saveUncertain || command.kind === 'save' && command.input.id === null } : {} })
      return false
    }
  }
}
