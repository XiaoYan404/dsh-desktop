/** Private per-employee conversation choices, separate from native Session history and executable authority. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import type {
  OfficeConversationId, OfficeConversationLinks, OfficeConversationLinksInput, OfficeConversationLinksView,
  OfficeConversationLinkLimits, OfficeIntegration, OfficeIntegrationId, OfficeMember, OfficeToolReference,
} from './types.ts'

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const name = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(128)
const tool = z.object({ kind: z.enum(['skill', 'template']), name }).strict()
const integrationId = z.uuid().transform(value => brandString<OfficeIntegrationId>(value))
const conversationId = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/)
  .transform(value => brandString<OfficeConversationId>(value))
const coordinates = z.object({ conversationId, revision, requestId: z.uuid() })
const integrations = z.array(integrationId).max(100).refine(values => new Set(values).size === values.length)
const tools = z.array(tool).max(100).refine(values => new Set(values.map(toolKey)).size === values.length)
const input = z.discriminatedUnion('kind', [
  coordinates.extend({ kind: z.literal('integrations'), integrations }).strict(),
  coordinates.extend({ kind: z.literal('tools'), tools }).strict(),
])
const selection = z.object({ conversationId, revision, requestId: z.uuid().nullable(), updatedAt: revision.nullable(),
  integrations, tools }).strict()
/** Strict coordinates and lists shared by association storage, prepared captures and network admission. */
export const officeConversationLinkSchemas = { conversationId, input, selection, tool }
const entry = z.object({
  ownerId: officeMemberId, conversationId, revision: revision.refine(value => value > 0), requestId: z.uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), updatedAt: revision, integrations, tools,
}).strict().refine(value => value.integrations.length + value.tools.length <= 100)
const state = z.object({ entries: z.array(entry).max(10000).readonly() }).strict().superRefine((value, ctx) => {
  const keys = value.entries.map(row => JSON.stringify([row.ownerId, row.conversationId]))
  const retries = value.entries.map(row => JSON.stringify([row.ownerId, row.requestId]))
  if (new Set(keys).size !== keys.length || new Set(retries).size !== retries.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate conversation selection identity or retry' })
  }
})

/** Empty selections remain versioned so stale windows cannot resurrect removed associations. */
export const officeConversationLinksDomain = defineDomain({
  name: 'enterprise_office_conversation_links', version: 1,
  global: { schema: state, initial: { entries: [] } }, tables: {},
})

/** Limits and declarative registration-name requirements; these choices grant no execution permission. */
export interface OfficeConversationLinkPolicy extends OfficeConversationLinkLimits {
  readonly dependencies: ReadonlyMap<string, { readonly tool: OfficeToolReference; readonly names: readonly string[] }>
}

/**
 * Validate bounded deployment choices and explicit integration registration-name requirements.
 * @param options - Retained-context capacity, selection bound and tool-key to required registration names.
 * @returns Resolved policy; missing registrations remain explicit unmet requirements rather than invented connections.
 */
export function resolveConversationLinkPolicy(options: {
  maxContexts: number
  maxSelected: number
  dependencies: Readonly<Record<string, readonly string[]>>
}): OfficeConversationLinkPolicy {
  const label = z.string().trim().normalize('NFC').min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/)
  const parsed = z.object({
    maxContexts: z.number().int().min(1).max(10000), maxSelected: z.number().int().min(1).max(100),
    dependencies: z.record(z.string().regex(/^(skill|template):[a-z0-9]+(?:-[a-z0-9]+)*$/).max(137),
      z.array(label).max(100).refine(values => new Set(values.map(canonicalName)).size === values.length)),
  }).strict().parse(options)
  return { maxContexts: parsed.maxContexts, maxSelected: parsed.maxSelected,
    dependencies: new Map(Object.entries(parsed.dependencies).map(([key, names]) => {
      const colon = key.indexOf(':')
      const tool: OfficeToolReference = { kind: key.slice(0, colon) === 'skill' ? 'skill' : 'template', name: key.slice(colon + 1) }
      return [key, { tool, names }]
    })) }
}

/** Private selection writes run only inside the office's current-identity queue. */
export class OfficeConversationLinksRepository {
  /**
   * @param domain - Independent durable selection unit.
   * @param policy - Validated capacity and declared dependencies.
   * @param catalog - Current descriptive company registrations, without credentials.
   * @param changed - Empty notification published only after a confirmed commit.
   */
  constructor(
    private readonly domain: Domain<typeof officeConversationLinksDomain>,
    private readonly policy: OfficeConversationLinkPolicy,
    private readonly catalog: () => readonly OfficeIntegration[],
    private readonly changed: () => Promise<void>,
  ) {}

  /**
   * Refuse private records detached from their original directory or integration catalog.
   * @param members - Complete retained directory, including inactive employees.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    const actors = new Set(members.map(member => member.id))
    const registered = new Set(this.catalog().map(record => record.id))
    if (this.domain.global.get().entries.some(record => !actors.has(record.ownerId) ||
      record.integrations.some(id => !registered.has(id)))) {
      throw new OfficeError('conflict', 'Saved conversation choices require their original directory and integration catalog')
    }
  }

  /**
   * Read only the authenticated employee's choices and current dependency resolution.
   * @param actor - Current active employee, checked by the service owner.
   * @param id - Native logical conversation identity; it carries no authorization by itself.
   * @returns Versioned selection and explicit resolved/missing registration requirements, without secrets.
   */
  view(actor: OfficeMember, id: OfficeConversationId): OfficeConversationLinksView {
    const parsed = conversationId.safeParse(id)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid conversation identity')
    const record = this.domain.global.get().entries.find(row => row.ownerId === actor.id && row.conversationId === parsed.data)
    const catalog = this.catalog()
    return { meId: actor.id, selection: record ? this.project(record) : {
      conversationId: parsed.data, revision: 0, requestId: null, updatedAt: null, integrations: [], tools: [],
    }, limits: { maxContexts: this.policy.maxContexts, maxSelected: this.policy.maxSelected },
    requirements: [...this.policy.dependencies.values()].map(({ tool, names }) => {
      const resolved = names.map(required => ({ required,
        record: catalog.find(integration => canonicalName(integration.name) === canonicalName(required)) }))
      return { tool, integrationNames: names,
        integrations: resolved.flatMap(value => value.record ? [value.record.id] : []),
        missing: resolved.flatMap(value => value.record ? [] : [value.required]) }
    }) }
  }

  /**
   * Save one reviewed choice list; selecting tools also adds their currently registered dependencies.
   * @param actor - Current active employee, rechecked before this queued operation.
   * @param request - Reviewed conversation version and exact retry identity.
   * @returns Confirmed selection; an uncertain response can be retried without another version increment.
   */
  async save(actor: OfficeMember, request: OfficeConversationLinksInput): Promise<OfficeConversationLinks> {
    const parsed = input.safeParse(request)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid conversation choice request')
    const value = parsed.data
    const fingerprint = createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const current = this.domain.global.get()
    const retried = current.entries.find(row => row.ownerId === actor.id && row.requestId === value.requestId)
    if (retried) {
      if (retried.fingerprint !== fingerprint) throw new OfficeError('conflict', 'Conversation choice retry changed')
      return this.project(retried)
    }
    const previous = current.entries.find(row => row.ownerId === actor.id && row.conversationId === value.conversationId)
    if ((previous?.revision ?? 0) !== value.revision || value.revision === Number.MAX_SAFE_INTEGER) {
      throw new OfficeError('conflict', 'Conversation choices changed in another window')
    }
    if (!previous && current.entries.length >= this.policy.maxContexts) {
      throw new OfficeError('conversation_capacity', 'Conversation choices are full')
    }
    const selectedTools = value.kind === 'tools' ? value.tools : previous?.tools ?? []
    let selectedIntegrations = value.kind === 'integrations' ? [...value.integrations] : [...previous?.integrations ?? []]
    const catalog = this.catalog()
    if (value.kind === 'tools') {
      for (const selected of selectedTools) for (const required of this.policy.dependencies.get(toolKey(selected))?.names ?? []) {
        const record = catalog.find(integration => canonicalName(integration.name) === canonicalName(required))
        if (record && !selectedIntegrations.includes(record.id)) selectedIntegrations.push(record.id)
      }
    }
    selectedIntegrations = [...new Set(selectedIntegrations)]
    if (selectedIntegrations.some(id => !catalog.some(record => record.id === id))) {
      throw new OfficeError('not_found', 'Selected company integration is unavailable')
    }
    const size = selectedTools.length + selectedIntegrations.length
    const reducing = previous && size < previous.integrations.length + previous.tools.length &&
      selectedIntegrations.every(id => previous.integrations.includes(id)) &&
      selectedTools.every(tool => previous.tools.some(old => toolKey(old) === toolKey(tool)))
    if (size > this.policy.maxSelected && !reducing) {
      throw new OfficeError('invalid_input', 'Conversation selection exceeds its configured bound')
    }
    const next = { ownerId: actor.id, conversationId: value.conversationId, revision: value.revision + 1,
      requestId: value.requestId, fingerprint, updatedAt: Date.now(), integrations: selectedIntegrations, tools: selectedTools }
    await this.domain.global.set({
      entries: previous ? current.entries.map(row => row === previous ? next : row) : [...current.entries, next],
    })
    await this.changed()
    return this.project(next)
  }

  private project(record: z.infer<typeof entry>): OfficeConversationLinks {
    return { conversationId: record.conversationId, revision: record.revision, requestId: record.requestId,
      updatedAt: record.updatedAt, integrations: record.integrations, tools: record.tools }
  }
}

function canonicalName(value: string): string { return value.normalize('NFC').toLowerCase() }
function toolKey(value: OfficeToolReference): string { return `${value.kind}:${value.name}` }
