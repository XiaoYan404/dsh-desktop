/** Immutable, bounded public action metadata; no adapter behavior runs while reading its directory. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { OfficeError } from './error.ts'
import { officeMember } from './spec.ts'
import type { OfficeConnectorReadResult } from './connector-http.ts'
import type { OfficeConnectorActionDeclaration, OfficeConnectorActionView, OfficeConnectorReadData, OfficeIntegrationId } from './types.ts'

const role = officeMember.shape.role
/** Closed wire input: requests cannot select roles, credentials, URLs or arbitrary adapter arguments. */
export const officeConnectorReadInput = z.object({
  integrationId: z.uuid().transform(value => brandString<OfficeIntegrationId>(value)),
  actionId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  connectionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), adapterRevision: z.uuid(),
}).strict()

/**
 * Bound sanitized plain-text business fields before transport or durable execution evidence accepts them.
 * @param maxEntries - Deployment-owned response field count.
 * @returns A strict summary/field parser, excluding remote diagnostics and undeclared properties.
 */
export function connectorBusinessDataSchema(maxEntries: number): z.ZodType<OfficeConnectorReadData> {
  return z.object({ summary: z.string().max(4000),
    entries: z.array(z.object({ label: z.string().min(1).max(200), value: z.string().max(4000) }).strict())
      .max(maxEntries).readonly() }).strict()
}

/**
 * Validate external business data before it crosses the employee transport.
 * @param maxEntries - Deployment-owned result cardinality limit.
 * @returns A strict read-result parser; unexpected fields and diagnostic text are rejected.
 */
export function connectorReadResultSchema(maxEntries: number): z.ZodType<OfficeConnectorReadResult> {
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('read'), data: connectorBusinessDataSchema(maxEntries) }).strict(),
    z.object({ status: z.enum(['unauthorized', 'rate_limited', 'timed_out', 'unreachable', 'invalid_response', 'http_error']) }).strict(),
  ])
}
const field = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  label: z.string().trim().normalize('NFC').min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/),
  required: z.boolean(), maxLength: z.number().int().min(1).max(4000),
}).strict().readonly()
const declaration = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  label: z.string().trim().normalize('NFC').min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/),
  description: z.string().max(2000), kind: z.enum(['read', 'write']),
  allowedRoles: z.array(role).min(1).max(role.options.length)
    .refine(values => new Set(values).size === values.length).readonly(),
  fields: z.array(field).max(32).readonly().optional(),
}).strict().refine(value => (!value.fields || value.kind === 'write') &&
  new Set(value.fields?.map(entry => entry.name)).size === (value.fields?.length ?? 0))
  .transform(({ fields, ...action }): OfficeConnectorActionDeclaration => ({
    ...action, ...fields === undefined ? {} : { fields },
  })).readonly()

/**
 * Snapshot a provider's declarations before publishing its registration.
 * @param input - Optional legacy-compatible declarations; roles must be explicit when an action exists.
 * @param limits - Deployment-owned count and complete public-catalog JSON byte limits.
 * @returns Independent frozen metadata; malformed or oversized input never installs a provider.
 */
export function snapshotConnectorActions(
  input: readonly OfficeConnectorActionDeclaration[] | undefined, limits: { readonly count: number; readonly bytes: number },
): readonly OfficeConnectorActionDeclaration[] {
  const parsed = z.array(declaration).max(limits.count).readonly().safeParse(input ?? [])
  if (!parsed.success || new Set(parsed.data.map(action => action.id)).size !== parsed.data.length) {
    throw new OfficeError('invalid_input', 'Invalid connector action declarations')
  }
  // Reserve the largest coordinate/status representation, including keys, punctuation and all public actions.
  const complete = { integrationId: '00000000-0000-4000-8000-000000000000', connectionRevision: Number.MAX_SAFE_INTEGER,
    adapterRevision: '00000000-0000-4000-8000-000000000000', status: 'credential_unavailable',
    actions: parsed.data.map(publicConnectorAction), readSupported: false, writeSupported: false }
  if (Buffer.byteLength(JSON.stringify(complete), 'utf8') > limits.bytes) {
    throw new OfficeError('context_too_large', 'Connector action directory exceeds its configured byte limit')
  }
  return parsed.data
}

/**
 * Project only public declaration fields, keeping the admission policy on the server.
 * @param action - Validated registration snapshot.
 * @returns Employee-safe action metadata without role rules or private connection data.
 */
export function publicConnectorAction(action: OfficeConnectorActionDeclaration): OfficeConnectorActionView {
  return { id: action.id, label: action.label, description: action.description, kind: action.kind,
    ...action.fields === undefined ? {} : { fields: action.fields.map(field => ({ ...field })) } }
}

/**
 * Validate exactly the declared flat-text fields without rewriting what the employee reviewed.
 * @param action - Frozen registered write declaration; read declarations cannot authorize a write.
 * @param values - Closed wire-parsed business text; neither keys nor values select connection authority.
 * @returns The exact valid values; missing, unknown and oversized fields reject before an intent or effect is admitted.
 */
export function validateConnectorWriteValues(action: OfficeConnectorActionDeclaration,
  values: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (action.kind !== 'write') throw new OfficeError('forbidden', 'Action is not a declared business write')
  const fields = action.fields ?? []
  if (Object.keys(values).some(name => !fields.some(field => field.name === name)) || fields.some(field =>
    (field.required && (!Object.hasOwn(values, field.name) || !values[field.name]?.trim())) ||
    (Object.hasOwn(values, field.name) && (values[field.name]?.length ?? 0) > field.maxLength)))
    throw new OfficeError('invalid_input', 'Review the declared business action fields')
  return values
}
