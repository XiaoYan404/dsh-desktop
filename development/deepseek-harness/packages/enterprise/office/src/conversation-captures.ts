/** Private immutable prepared contexts, separate from both editable choices and native message delivery. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMember, officeMemberId } from './spec.ts'
import { officeConversationLinkSchemas as links } from './conversation-links.ts'
import type { OfficeCapturedIntegration, OfficeConnectorView, OfficeConversationCapture, OfficeConversationCaptureId,
  OfficeConversationCaptureInput, OfficeConversationLinksView, OfficeIntegration, OfficeMember } from './types.ts'

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const id = z.uuid().transform(value => brandString<OfficeConversationCaptureId>(value))
const integrationId = links.selection.shape.integrations.element
const label = z.string().min(1).max(200)
const promptIdentity = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/)
const input = z.object({ conversationId: links.conversationId, revision, requestId: promptIdentity }).strict()
const requirement = z.object({ tool: links.tool, integrationNames: z.array(label).max(100),
  integrations: z.array(integrationId).max(100), missing: z.array(label).max(100) }).strict()
const integration = z.object({ id: integrationId, name: label, system: label, version: label,
  capabilities: z.array(z.string().min(1).max(120)).min(1).max(30), connectionRevision: revision,
  status: z.enum(['unconfigured', 'disabled', 'adapter_unavailable', 'policy_blocked', 'credential_missing',
    'credential_unavailable', 'unverified']),
}).strict()
const payload = z.object({ format: z.literal(1), id, requestId: promptIdentity, memberId: officeMemberId,
  role: officeMember.shape.role, capturedAt: revision,
  selection: links.selection, requirements: z.array(requirement).max(100), integrations: z.array(integration).max(100) }).strict()
const capture = payload.extend({ digest }).strict().superRefine((value, ctx) => {
  const { digest: expected, ...body } = value
  const selectedTools = value.selection.tools.map(tool => `${tool.kind}:${tool.name}`)
  const requirements = value.requirements.map(row => `${row.tool.kind}:${row.tool.name}`)
  if (hash(body) !== expected || new Set(requirements).size !== requirements.length ||
    requirements.some(key => !selectedTools.includes(key)) ||
    JSON.stringify(value.integrations.map(row => row.id)) !== JSON.stringify(value.selection.integrations)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid prepared conversation context' })
  }
})
const entry = z.object({ input, fingerprint: digest, capture }).strict().superRefine((value, ctx) => {
  if (hash(value.input) !== value.fingerprint || value.capture.requestId !== value.input.requestId ||
    value.input.conversationId !== value.capture.selection.conversationId || value.input.revision !== value.capture.selection.revision) {
    ctx.addIssue({ code: 'custom', message: 'Prepared context does not match its request' })
  }
})
const state = z.object({ entries: z.array(entry).max(10000).readonly() }).strict().refine(value =>
  new Set(value.entries.map(row => row.capture.id)).size === value.entries.length &&
  new Set(value.entries.map(row => JSON.stringify([
    row.capture.memberId, row.input.conversationId, row.input.requestId,
  ]))).size === value.entries.length)

/** Explicit context preparation/read admission; neither operation sends a prompt or authorizes a tool. */
export const officeConversationCaptureSchemas = { input, id }
/** A new versioned unit preserves editable choices and released native Session generations. */
export const officeConversationCapturesDomain = defineDomain({
  name: 'enterprise_office_conversation_captures', version: 1,
  global: { schema: state, initial: { entries: [] } }, tables: {},
})

/** Retention capacity and finite context bytes resolved before opening storage. */
export interface OfficeConversationCapturePolicy {
  readonly maxEntries: number
  readonly maxBytes: number
  readonly maxCaptureBytes: number
}

/**
 * Validate finite prepared-context retention without expiring evidence implicitly.
 * @param options - Independent retained-record, total-byte and per-context bounds.
 * @returns Validated policy; lowering retention bounds does not discard existing records.
 */
export function resolveConversationCapturePolicy(options: OfficeConversationCapturePolicy): OfficeConversationCapturePolicy {
  return z.object({ maxEntries: z.number().int().min(1).max(10000),
    maxBytes: z.number().int().min(1024).max(256 * 1024 * 1024),
    maxCaptureBytes: z.number().int().min(1024).max(1024 * 1024),
  }).strict().refine(value => value.maxCaptureBytes <= value.maxBytes).parse(options)
}

/** Preparation commits only through the office's authenticated queue; captured readiness grants no execution authority. */
export class OfficeConversationCapturesRepository {
  /**
   * @param domain - Independent retained prepared contexts.
   * @param policy - Validated retention and payload bounds.
   * @param choices - Current employee-authorized editable choices, invoked inside the same queue.
   * @param catalog - Actual descriptive registrations; no external system is contacted.
   * @param connections - Current employee-safe readiness; administrator-only fields are never copied.
   */
  constructor(
    private readonly domain: Domain<typeof officeConversationCapturesDomain>,
    private readonly policy: OfficeConversationCapturePolicy,
    private readonly choices: (actor: OfficeMember, conversation: OfficeConversationCaptureInput['conversationId']) => OfficeConversationLinksView,
    private readonly catalog: () => readonly OfficeIntegration[],
    private readonly connections: (actor: OfficeMember) => Promise<OfficeConnectorView>,
  ) {}

  /**
   * Refuse orphaned employee evidence while retaining historical integrations independently of the current catalog.
   * @param members - Original directory, including retained inactive employees.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    if (this.domain.global.get().entries.some(row => !members.some(member => member.id === row.capture.memberId))) {
      throw new OfficeError('conflict', 'Prepared conversation contexts require their original employee directory')
    }
  }

  /**
   * Return only this employee's retained context; administrator role never bypasses ownership.
   * @param actor - Currently active employee, checked by the queue owner.
   * @param captureId - Opaque prepared context id, not a bearer credential.
   * @returns The historical context, without implying that native admission or dispatch occurred.
   */
  read(actor: OfficeMember, captureId: OfficeConversationCaptureId): OfficeConversationCapture {
    const parsed = id.safeParse(captureId)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid prepared context identity')
    const found = this.domain.global.get().entries.find(row => row.capture.memberId === actor.id && row.capture.id === parsed.data)
    if (!found) throw new OfficeError('not_found', 'Prepared conversation context not found')
    return found.capture
  }

  /**
   * Freeze one reviewed choice version and its descriptive readiness before any later native admission.
   * @param actor - Currently active employee, rechecked by the owning office queue.
   * @param request - Logical conversation, reviewed version and original native prompt retry id.
   * @returns The original committed context on exact retry, even if choices or deployment limits changed afterward.
   */
  async prepare(actor: OfficeMember, request: OfficeConversationCaptureInput): Promise<OfficeConversationCapture> {
    const parsed = input.safeParse(request)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid prepared conversation context request')
    const value = parsed.data
    const fingerprint = hash(value)
    const current = this.domain.global.get()
    const existing = current.entries.find(row => row.capture.memberId === actor.id &&
      row.input.conversationId === value.conversationId && row.input.requestId === value.requestId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new OfficeError('conflict', 'Prepared context retry changed')
      return existing.capture
    }
    const view = this.choices(actor, value.conversationId)
    if (view.selection.revision !== value.revision) throw new OfficeError('conflict', 'Review the current conversation associations')
    const catalog = this.catalog()
    const connections = await this.connections(actor)
    const integrations: OfficeCapturedIntegration[] = view.selection.integrations.map((selected) => {
      const record = catalog.find(row => row.id === selected)
      if (!record) throw new OfficeError('conflict', 'Selected integration is no longer registered')
      const connection = connections.entries.find(row => row.integrationId === selected)
      return { id: record.id, name: record.name, system: record.system, version: record.version, capabilities: record.capabilities,
        connectionRevision: connection?.revision ?? 0, status: connection?.status ?? 'unconfigured' }
    })
    const body = { format: 1 as const, id: brandString<OfficeConversationCaptureId>(randomUUID()),
      requestId: value.requestId, memberId: actor.id,
      role: actor.role, capturedAt: Date.now(), selection: view.selection, integrations,
      requirements: view.requirements.filter(row => view.selection.tools.some(tool =>
        tool.kind === row.tool.kind && tool.name === row.tool.name)) }
    const normalized = payload.parse(body)
    const saved = { ...normalized, digest: hash(normalized) }
    const next = { entries: [...current.entries, { input: value, fingerprint, capture: saved }] }
    if (Buffer.byteLength(JSON.stringify(saved)) > this.policy.maxCaptureBytes) {
      throw new OfficeError('context_too_large', 'Reduce the selected context or increase the configured capture bound')
    }
    if (next.entries.length > this.policy.maxEntries || Buffer.byteLength(JSON.stringify(next)) > this.policy.maxBytes) {
      throw new OfficeError('conversation_capacity', 'Prepared conversation context retention is full')
    }
    await this.domain.global.set(next)
    return saved
  }
}

function hash(value: object): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
