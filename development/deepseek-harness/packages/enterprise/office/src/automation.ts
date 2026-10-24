/** Durable trigger admission and reviewed recovery over the existing connector execution owner; no scheduler or write transport. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { officeMemberId, officeMember } from './spec.ts'
import { officeConnectorReadInput } from './connector-actions.ts'
import { OfficeError } from './error.ts'
import type { OfficeMember, OfficeMemberId, OfficeConnectorActionsView, OfficeIntegrationId,
  OfficeConnectorWriteInput, OfficeConnectorExecutionReceipt, OfficeConnectorExecutionId, OfficeConnectorExecutionCheck,
  OfficeConversationCaptureId } from './types.ts'

/** Opaque rule identity created by this Office domain. */
export type OfficeAutomationRuleId = Branded<'OfficeAutomationRuleId'>
/** Opaque run identity; external execution ids remain owned by the connector ledger. */
export type OfficeAutomationRunId = Branded<'OfficeAutomationRunId'>
const ruleId = z.uuid().transform(value => brandString<OfficeAutomationRuleId>(value))
const runId = z.uuid().transform(value => brandString<OfficeAutomationRunId>(value))
const executionId = z.uuid().transform(value => brandString<OfficeConnectorExecutionId>(value))
const counter = z.number().int().nonnegative()
const name = z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/)
const action = officeConnectorReadInput.extend({ values: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.string().max(4000))
  .refine(value => Object.keys(value).length <= 32) }).strict()
const trigger = z.object({ kind: z.enum(['form', 'event', 'webhook', 'schedule']), source: name }).strict()
const definition = z.object({ title: name, enabled: z.boolean(), trigger, action, compensation: action.nullable() }).strict()
/** Closed form input; owners, request ids, credentials and trigger-provided business values cannot be supplied. */
export const officeAutomationSaveInput = definition.extend({ id: ruleId.nullable(), revision: counter }).strict()
const rule = definition.extend({ id: ruleId, revision: counter.min(1), ownerId: officeMemberId,
  ownerRole: officeMember.shape.role, createdAt: counter }).strict()
const stage = z.enum(['pending_approval', 'running', 'succeeded', 'rejected', 'unknown', 'cancelled'])
const phase = z.object({ requestId: z.uuid(), stage, executionId: executionId.nullable(),
  rejection: z.enum(['denied', 'not_accepted', 'unauthorized', 'rate_limited', 'invalid_input']).nullable() }).strict()
const run = z.object({ id: runId, revision: counter.min(1), rule: rule, occurrence: name, admittedAt: counter,
  parentId: runId.nullable(), primary: phase, compensation: phase.nullable() }).strict().superRefine((value, ctx) => {
  const phases = [value.primary, ...value.compensation ? [value.compensation] : []]
  if (phases.some(entry => (entry.stage === 'succeeded' || entry.stage === 'rejected') && !entry.executionId ||
    (entry.stage === 'rejected') !== (entry.rejection !== null)) ||
    (value.compensation !== null && (!value.rule.compensation || value.primary.stage !== 'succeeded')))
    ctx.addIssue({ code: 'custom', message: 'Invalid automation execution evidence' })
})
const state = z.object({ rules: z.array(rule).max(10000), runs: z.array(run).max(10000) }).strict().superRefine((value, ctx) => {
  if (new Set(value.rules.map(entry => entry.id)).size !== value.rules.length ||
    new Set(value.runs.map(entry => entry.id)).size !== value.runs.length ||
    new Set(value.runs.filter(entry => entry.parentId === null).map(entry => JSON.stringify([entry.rule.id, entry.occurrence]))).size !==
      value.runs.filter(entry => entry.parentId === null).length ||
    value.runs.some(entry => !value.rules.some(rule => rule.id === entry.rule.id && rule.ownerId === entry.rule.ownerId) ||
      entry.parentId !== null && !value.runs.some(parent => parent.id === entry.parentId && parent.rule.id === entry.rule.id)))
    ctx.addIssue({ code: 'custom', message: 'Invalid automation ownership or repeated occurrence' })
  const requests = new Map<string, string>()
  for (const entry of value.runs) {
    for (const [part, phase] of [['primary', entry.primary], ['compensation', entry.compensation]] as const) {
      if (!phase) continue
      const original = requests.get(phase.requestId)
      const reusable = part === 'primary' && phase.stage === 'succeeded' && phase.executionId !== null
      const signature = JSON.stringify([entry.rule.id, entry.rule.ownerId, entry.rule.action, phase])
      if (original !== undefined && (!reusable || original !== signature))
        ctx.addIssue({ code: 'custom', message: 'Automation requests cannot be rebound or replayed' })
      requests.set(phase.requestId, signature)
    }
  }
})
/** New isolated v1 domain; no old Office, Session or execution record is rewritten. */
export const officeAutomationDomain = defineDomain({ name: 'enterprise_office_automations', version: 1,
  global: { schema: state, initial: { rules: [], runs: [] } }, tables: {} })

/** Fixed configured connector fields; event payloads are never interpolated into the business operation. */
export type OfficeAutomationAction = z.infer<typeof action>
/** Private own rule, including reviewed connection and provider revisions. */
export type OfficeAutomationRule = z.infer<typeof rule>
/** Private run with original request identities and ledger references, without remote result bodies. */
export type OfficeAutomationRun = z.infer<typeof run>
/** Employee-private review coordinates and literal business fields presented for human approval. */
export interface OfficeAutomationReview {
  runId: OfficeAutomationRunId
  revision: number
  part: 'primary' | 'compensation'
  action: OfficeAutomationAction
  requestId: string
}
/** Deployment bounds stop admission instead of pruning deduplication or recovery evidence. */
export interface OfficeAutomationLimits {
  /** Maximum retained rules across all owners; reaching the limit rejects additions without pruning existing rules. */
  readonly maxRules: number
  /** Maximum retained runs across all owners, including retry children and the original recovery evidence. */
  readonly maxRuns: number
  /** Maximum UTF-8 bytes of the complete retained automation JSON; oversized updates are rejected before commit. */
  readonly maxBytes: number
}
/** Existing Office authority, action directory and execution services; none grants approval from a trigger. */
export interface OfficeAutomationHost {
  /** Resolve current active membership and the current authenticated request, with no administrator ownership override. */
  member(id: OfficeMemberId): OfficeMember
  /** Read the existing current declaration directory under the fixed owner. */
  actions(id: OfficeMemberId, integrationId: OfficeIntegrationId): Promise<OfficeConnectorActionsView>
  /** Submit exactly reviewed fields through Office's durable ledger and current permission checks. */
  write(id: OfficeMemberId, input: OfficeConnectorWriteInput): Promise<OfficeConnectorExecutionReceipt>
  /** Find an original request receipt without dispatching anything. */
  executions(id: OfficeMemberId): Promise<readonly OfficeConnectorExecutionReceipt[]>
  /** Check only an original execution id using Office's current connection, role and provider checks. */
  check(id: OfficeMemberId, executionId: OfficeConnectorExecutionId): Promise<OfficeConnectorExecutionCheck>
  /** Post-commit sanitized metadata; observer exceptions must not alter the committed operation outcome. */
  audit(event: { readonly ruleId: OfficeAutomationRuleId
    readonly runId: OfficeAutomationRunId | null
    readonly ownerId: OfficeMemberId
    readonly revision: number
    readonly phase: 'rule' | 'primary' | 'compensation'
    readonly executionId: OfficeConnectorExecutionId | null
    readonly integrationId: OfficeIntegrationId
    readonly actionId: string
    readonly stage: string }): void
}
/** Post-commit audit metadata excludes business values, credentials, response bodies and network locations. */
export type OfficeAutomationAudit = Parameters<OfficeAutomationHost['audit']>[0]

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * @mode parallel
     * @param event - Committed own automation phase and execution coordinates, without business content.
     */
    'office/automation-audit'(event: OfficeAutomationAudit): Promise<void>
  }
}
const fresh = (): z.infer<typeof phase> => ({ requestId: randomUUID(), stage: 'pending_approval', executionId: null, rejection: null })

/** Serial mutations retain original requests across failures and drain before the owning domain closes. */
export class OfficeAutomationRepository {
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private readonly limits: OfficeAutomationLimits
  constructor(private readonly domain: Domain<typeof officeAutomationDomain>, private readonly host: OfficeAutomationHost,
    limits: OfficeAutomationLimits) {
    this.limits = z.object({ maxRules: counter.min(1).max(10000), maxRuns: counter.min(1).max(10000),
      maxBytes: counter.min(1024).max(256 * 1024 * 1024) }).strict().parse(limits)
    this.capacity(domain.global.get())
  }

  /**
   * Refuse retained automation evidence attached to a different company directory.
   * @param members - Original retained membership, including inactive owners.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    const ids = new Set(members.map(value => value.id))
    if (this.domain.global.get().rules.some(value => !ids.has(value.ownerId)))
      throw new OfficeError('conflict', 'Automations require their original employee directory')
  }

  /**
   * List only the current employee's private rules and runs; a running persisted phase is conservatively unknown.
   * @param actorId - Server-authenticated employee, rechecked for active membership.
   * @returns Independent private snapshots with no credentials or remote result bodies.
   */
  list(actorId: OfficeMemberId): {
    readonly rules: readonly OfficeAutomationRule[]
    readonly runs: readonly OfficeAutomationRun[]
  } {
    this.assertActor(actorId)
    const value = structuredClone(this.domain.global.get())
    return { rules: value.rules.filter(entry => entry.ownerId === actorId), runs: value.runs.filter(entry => entry.rule.ownerId === actorId)
      .map(entry => ({ ...entry, primary: this.projectPhase(entry.primary),
        compensation: entry.compensation && this.projectPhase(entry.compensation) })) }
  }

  /**
   * Create, edit, enable or disable an own rule under CAS; stale runs cannot acquire a new action implicitly.
   * @param actorId - Current owner; event and schedule payloads cannot create or edit rules.
   * @param input - Exact reviewed fields and current rule revision, including the enabled flag.
   * @returns Durable rule; saving never invokes a business write.
   */
  save(actorId: OfficeMemberId, input: z.infer<typeof officeAutomationSaveInput>): Promise<OfficeAutomationRule> {
    return this.enqueue(async () => {
      const parsed = officeAutomationSaveInput.parse(input)
      const actor = this.assertActor(actorId)
      const previous = parsed.id ? this.ownedRule(actorId, parsed.id) : undefined
      if (parsed.revision !== (previous?.revision ?? 0)) throw new OfficeError('conflict', 'Automation rule changed')
      // Disable remains available even when a provider or credential has been removed.
      if (parsed.enabled) {
        await this.checkAction(actorId, parsed.action)
        if (parsed.compensation) await this.checkAction(actorId, parsed.compensation)
      }
      this.assertActor(actorId, actor.role)
      const { id: _id, revision: _revision, ...fields } = parsed
      const next = rule.parse({ ...fields, id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1,
        ownerId: actorId, ownerRole: actor.role, createdAt: previous?.createdAt ?? Date.now() })
      const current = this.domain.global.get()
      await this.commit({ ...current,
        rules: previous ? current.rules.map(entry => entry.id === next.id ? next : entry) : [...current.rules, next] })
      this.audit(next, null, next.enabled ? 'enabled' : 'disabled')
      return structuredClone(next)
    })
  }

  /**
   * Admit one authenticated form or trusted Host event; duplicate occurrences retain the original run across edits.
   * @param actorId - Fixed owner resolved by the request or private trigger configuration, never a Webhook field.
   * @param input - Declared trigger kind/source and a stable source occurrence, without business values.
   * @returns Newly committed or original runs awaiting human review; no external effect starts.
   */
  trigger(actorId: OfficeMemberId, input: { readonly kind: z.infer<typeof trigger>['kind']
    readonly source: string
    readonly occurrence: string }): Promise<readonly OfficeAutomationRun[]> {
    return this.enqueue(async () => {
      const value = trigger.extend({ occurrence: name }).strict().parse(input)
      const actor = this.assertActor(actorId)
      const current = this.domain.global.get()
      const matched = current.rules.filter(entry => entry.ownerId === actorId && entry.enabled &&
        entry.trigger.kind === value.kind && entry.trigger.source === value.source)
      const selected: OfficeAutomationRun[] = []
      for (const configured of matched) {
        this.assertActor(actorId, configured.ownerRole)
        const existing = current.runs.find(entry => entry.rule.id === configured.id &&
          entry.occurrence === value.occurrence && !entry.parentId)
        selected.push(existing ?? run.parse({ id: randomUUID(), revision: 1, rule: configured,
          occurrence: value.occurrence, admittedAt: Date.now(), parentId: null, primary: fresh(), compensation: null }))
      }
      this.assertActor(actorId, actor.role)
      const added = selected.filter(entry => !current.runs.some(saved => saved.id === entry.id))
      if (added.length) {
        await this.commit({ ...current, runs: [...current.runs, ...added] })
        for (const entry of added) this.audit(entry.rule, entry, 'pending_approval')
      }
      return structuredClone(selected)
    })
  }

  /**
   * Read the exact immutable primary or compensation operation for native approval and explicit UI confirmation.
   * @param actorId - Current owning employee.
   * @param id - Own run identity.
   * @param part - Primary effect or separately requested compensation.
   * @returns Run revision and exact business fields; approval must bind all returned values.
   */
  review(actorId: OfficeMemberId, id: OfficeAutomationRunId, part: 'primary' | 'compensation'): OfficeAutomationReview {
    this.assertActor(actorId)
    const saved = this.ownedRun(actorId, id)
    const selected = this.selected(saved, part)
    this.executable(actorId, saved)
    if (selected.phase.stage !== 'pending_approval') throw new OfficeError('conflict', 'Automation requires recovery or is already settled')
    return structuredClone({ runId: id, revision: saved.revision, part, action: selected.action, requestId: selected.phase.requestId })
  }

  /**
   * Execute only after native human approval or the exact explicit UI review; triggers must never call this method.
   * @param actorId - Current employee from the authenticated approval request.
   * @param id - Own run; another employee has no override.
   * @param revision - Exact review revision, preventing a stale or repeated approval from dispatching twice.
   * @param part - Primary effect or separately reviewed compensation.
   * @param captureId - Native submission's current association capture when execution comes from an Agent.
   * @returns Durable run referring to the existing execution ledger; any uncertain call remains unknown.
   */
  executeReviewed(actorId: OfficeMemberId, id: OfficeAutomationRunId, revision: number, part: 'primary' | 'compensation',
    captureId?: OfficeConversationCaptureId): Promise<OfficeAutomationRun> {
    return this.enqueue(async () => {
      const saved = this.ownedRun(actorId, id)
      if (saved.revision !== revision) throw new OfficeError('conflict', 'Automation review changed')
      this.review(actorId, id, part)
      const selected = this.selected(saved, part)
      await this.checkAction(actorId, selected.action)
      this.executable(actorId, saved)
      const running = await this.change(saved, part, { ...selected.phase, stage: 'running' })
      // A crash here is unknown even if no connector reservation was made; recovery never retries the write.
      let receipt: OfficeConnectorExecutionReceipt
      try {
        this.executable(actorId, running)
        receipt = await this.host.write(actorId, { ...selected.action, requestId: selected.phase.requestId,
          ...captureId ? { captureId } : {} })
      } catch (error) {
        void error
        return this.change(running, part, { ...selected.phase, stage: 'unknown' })
      }
      this.assertActor(actorId, saved.rule.ownerRole)
      return this.change(running, part, this.fromReceipt(selected.phase, receipt))
    })
  }

  /**
   * Recover an unknown phase by its original request and ledger execution id; absence never authorizes resubmission.
   * @param actorId - Current owning employee; the connector service rechecks original connection and role.
   * @param id - Own run identity, retained through restarts and rule edits.
   * @param part - Primary or compensation phase being checked.
   * @returns Updated evidence; unavailable or missing original receipts remain unknown without a POST.
   */
  recover(actorId: OfficeMemberId, id: OfficeAutomationRunId, part: 'primary' | 'compensation'): Promise<OfficeAutomationRun> {
    return this.enqueue(async () => {
      const saved = this.ownedRun(actorId, id)
      this.assertActor(actorId, saved.rule.ownerRole)
      const selected = this.selected(saved, part)
      if (selected.phase.stage !== 'unknown' && selected.phase.stage !== 'running') return structuredClone(saved)
      const receipts = await this.host.executions(actorId)
      this.assertActor(actorId, saved.rule.ownerRole)
      const original = receipts.find(entry => selected.phase.executionId ? entry.id === selected.phase.executionId
        : entry.requestId === selected.phase.requestId)
      if (!original) return this.change(saved, part, { ...selected.phase, stage: 'unknown' })
      if (!this.matches(selected.action, original) || selected.phase.executionId && selected.phase.executionId !== original.id)
        throw new OfficeError('conflict', 'Automation original execution coordinates changed')
      const checked = original.status === 'unknown' ? (await this.host.check(actorId, original.id)).receipt : original
      this.assertActor(actorId, saved.rule.ownerRole)
      return this.change(saved, part, this.fromReceipt(selected.phase, checked))
    })
  }

  /**
   * Cancel pending review, request compensation after confirmed success, or explicitly retry definitive nonacceptance.
   * @param actorId - Current owner, with no role or ownership bypass.
   * @param id - Own run.
   * @param revision - Exact displayed run revision.
   * @param command - Explicit management choice; unknown effects accept only recovery.
   * @returns Durable run; retry creates a child with a fresh review while preserving all original request identities.
   */
  manage(actorId: OfficeMemberId, id: OfficeAutomationRunId, revision: number,
    command: 'cancel' | 'compensate' | 'retry'): Promise<OfficeAutomationRun> {
    return this.enqueue(async () => {
      const saved = this.ownedRun(actorId, id)
      this.assertActor(actorId, saved.rule.ownerRole)
      if (saved.revision !== revision) throw new OfficeError('conflict', 'Automation run changed')
      if (command === 'cancel') {
        const part = saved.compensation ? 'compensation' : 'primary'
        const selected = this.selected(saved, part)
        if (selected.phase.stage !== 'pending_approval') throw new OfficeError('conflict', 'Dispatched operations cannot be cancelled locally')
        return this.change(saved, part, { ...selected.phase, stage: 'cancelled' })
      }
      this.executable(actorId, saved)
      if (command === 'compensate') {
        if (saved.primary.stage !== 'succeeded' || !saved.rule.compensation || saved.compensation)
          throw new OfficeError('conflict', 'Compensation requires confirmed success and its own declared operation')
        const updated = run.parse({ ...saved, revision: saved.revision + 1, compensation: fresh() })
        await this.put(updated)
        return structuredClone(updated)
      }
      const retryPart = saved.compensation ? 'compensation' : 'primary'
      const selected = this.selected(saved, retryPart)
      if (!['rejected', 'cancelled'].includes(selected.phase.stage))
        throw new OfficeError('conflict', 'Unknown or successful effects cannot be retried')
      const current = this.domain.global.get()
      const existing = current.runs.find(entry => entry.parentId === saved.id)
      if (existing) return structuredClone(existing)
      const updated = run.parse({ ...saved, id: randomUUID(), revision: 1, parentId: saved.id,
        admittedAt: Date.now(), [retryPart]: fresh() })
      await this.commit({ ...current, runs: [...current.runs, updated] })
      this.audit(updated.rule, updated, 'pending_approval')
      return structuredClone(updated)
    })
  }

  /** Stop admission and await all accepted operations before the owner closes storage. */
  async close(): Promise<void> { this.closed = true; await this.tail }

  private assertActor(id: OfficeMemberId, role?: OfficeMember['role']): OfficeMember {
    if (this.closed) throw new OfficeError('conflict', 'Automation owner is stopping')
    const actor = this.host.member(id)
    if (!actor.active || role !== undefined && actor.role !== role) throw new OfficeError('forbidden', 'Automation owner permission changed')
    return actor
  }
  private ownedRule(actorId: OfficeMemberId, id: OfficeAutomationRuleId): OfficeAutomationRule {
    this.assertActor(actorId)
    const value = this.domain.global.get().rules.find(entry => entry.id === id && entry.ownerId === actorId)
    if (!value) throw new OfficeError('not_found', 'Automation rule is unavailable')
    return value
  }
  private ownedRun(actorId: OfficeMemberId, id: OfficeAutomationRunId): OfficeAutomationRun {
    this.assertActor(actorId)
    const value = this.domain.global.get().runs.find(entry => entry.id === id && entry.rule.ownerId === actorId)
    if (!value) throw new OfficeError('not_found', 'Automation run is unavailable')
    return value
  }
  private executable(actorId: OfficeMemberId, saved: OfficeAutomationRun): void {
    this.assertActor(actorId, saved.rule.ownerRole)
    const current = this.ownedRule(actorId, saved.rule.id)
    if (!current.enabled || current.revision !== saved.rule.revision) throw new OfficeError('conflict', 'Automation rule is disabled or changed')
  }
  private selected(saved: OfficeAutomationRun, part: 'primary' | 'compensation') {
    const phase = saved[part]
    const action = part === 'primary' ? saved.rule.action : saved.rule.compensation
    if (!phase || !action) throw new OfficeError('conflict', 'Compensation has not been requested')
    return { phase, action }
  }
  private async checkAction(actorId: OfficeMemberId, configured: OfficeAutomationAction): Promise<void> {
    const directory = await this.host.actions(actorId, configured.integrationId)
    this.assertActor(actorId)
    const declaration = directory.actions.find(action => action.id === configured.actionId && action.kind === 'write')
    if (!directory.writeSupported || directory.connectionRevision !== configured.connectionRevision ||
      directory.adapterRevision !== configured.adapterRevision || !declaration)
      throw new OfficeError('conflict', 'Automation connector declaration changed or is unavailable')
    const fields = declaration.fields ?? []
    if (Object.keys(configured.values).some(key => !fields.some(field => field.name === key)) || fields.some(field =>
      field.required && !configured.values[field.name]?.trim() || (configured.values[field.name]?.length ?? 0) > field.maxLength))
      throw new OfficeError('invalid_input', 'Automation requires exactly the declared business fields')
  }
  private matches(action: OfficeAutomationAction, receipt: OfficeConnectorExecutionReceipt): boolean {
    return receipt.integrationId === action.integrationId && receipt.actionId === action.actionId &&
      receipt.connectionRevision === action.connectionRevision && receipt.adapterRevision === action.adapterRevision
  }
  private fromReceipt(previous: z.infer<typeof phase>, receipt: OfficeConnectorExecutionReceipt): z.infer<typeof phase> {
    return { ...previous, executionId: receipt.id, stage: receipt.status === 'succeeded' ? 'succeeded' :
      receipt.status === 'rejected' ? 'rejected' : 'unknown', rejection: receipt.status === 'rejected' ? receipt.rejection ?? 'not_accepted' : null }
  }
  private projectPhase(value: z.infer<typeof phase>): z.infer<typeof phase> {
    return value.stage === 'running' ? { ...value, stage: 'unknown' } : value
  }
  private async change(saved: OfficeAutomationRun, part: 'primary' | 'compensation', value: z.infer<typeof phase>): Promise<OfficeAutomationRun> {
    const updated = run.parse({ ...saved, revision: saved.revision + 1, [part]: value })
    await this.put(updated)
    return structuredClone(updated)
  }
  private async put(updated: OfficeAutomationRun): Promise<void> {
    const current = this.domain.global.get()
    await this.commit({ ...current, runs: current.runs.map(entry => entry.id === updated.id ? updated : entry) })
    this.audit(updated.rule, updated, updated.compensation?.stage ?? updated.primary.stage)
  }
  private capacity(value: z.infer<typeof state>): void {
    if (value.rules.length > this.limits.maxRules || value.runs.length > this.limits.maxRuns ||
      Buffer.byteLength(JSON.stringify(value), 'utf8') > this.limits.maxBytes)
      throw new OfficeError('context_too_large', 'Automation retention is full; existing evidence cannot be pruned')
  }
  private async commit(value: z.infer<typeof state>): Promise<void> {
    const parsed = state.parse(value)
    this.capacity(parsed)
    await this.domain.global.set(parsed)
  }
  private audit(rule: OfficeAutomationRule, saved: OfficeAutomationRun | null, stage: string): void {
    const selected = saved?.compensation ?? saved?.primary
    const action = saved?.compensation ? rule.compensation ?? rule.action : rule.action
    try { this.host.audit({ ruleId: rule.id, runId: saved?.id ?? null, ownerId: rule.ownerId,
      revision: saved?.revision ?? rule.revision, phase: !saved ? 'rule' : saved.compensation ? 'compensation' : 'primary',
      executionId: selected?.executionId ?? null, integrationId: action.integrationId, actionId: action.actionId, stage }) }
    catch (error) {
      void error
      process.emitWarning('Automation audit observer failed; committed run state is retained. Do not repeat the operation.',
        { code: 'OFFICE_AUTOMATION_AUDIT_REPORTING' })
    }
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new OfficeError('conflict', 'Automation owner is stopping'))
    const result = this.tail.then(operation)
    this.tail = result.catch((error: unknown) => { void error /* The original caller receives the failure. */ })
    return result
  }
}
