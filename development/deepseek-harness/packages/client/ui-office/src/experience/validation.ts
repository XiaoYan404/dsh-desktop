/** Validate imported files and durable office configuration before publishing or activating them. */
import { z } from 'zod'
import type { OfficeAppearance, OfficeAssistant, OfficeAssistantId, OfficeExperienceDocument } from './types.ts'

const scene = z.enum(['sales', 'documents', 'presentations', 'knowledge', 'quotes', 'projects'])
const displayText = (max: number) => z.string().trim().max(max).refine(value => !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value))

/** Reject credential-bearing, local-only, or non-HTTPS phone links.
 * @param value - Deployment address, without credentials, query or fragment.
 * @returns A canonical HTTPS address or the empty unconfigured value.
 */
export function mobileAddress(value: string): string {
  if (!value.trim()) return ''
  const url = new URL(value)
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./u.test(host)
    || host === '0.0.0.0' || host === '[::]') throw new Error('invalid')
  return url.href
}

const appearanceSchema = z.object({
  companyName: displayText(100), monogram: displayText(8),
  brand: z.enum(['default', 'blue', 'green', 'violet']),
  scheme: z.enum(['inherit', 'light', 'dark']), density: z.enum(['comfortable', 'compact']),
  mobileUrl: z.string().max(2048).refine((value) => { try { mobileAddress(value); return true } catch { return false } }),
}).strict()
const assistantSchema = z.object({
  id: z.uuid().transform(value => value as OfficeAssistantId), name: displayText(100).min(1), scene,
  basePreset: z.string().trim().min(1).max(160).refine(value => !value.startsWith('office.assistant.')),
  instructions: displayText(8000),
}).strict()
const documentSchema = z.object({
  format: z.literal(1), revision: z.number().int().nonnegative(),
  accounts: z.array(z.object({ principal: z.string().min(1).max(200), appearance: appearanceSchema,
    assistants: z.array(assistantSchema).max(100) }).strict()).max(1000),
}).strict().superRefine((value, ctx) => {
  const principals = value.accounts.map(account => account.principal)
  const ids = value.accounts.flatMap(account => account.assistants.map(assistant => assistant.id))
  if (new Set(principals).size !== principals.length || new Set(ids).size !== ids.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate office configuration identity' })
})

/** @returns Default office-only appearance; the user's native theme remains inherited. */
export function officeAppearanceDefaults(): OfficeAppearance {
  return { companyName: '', monogram: '', brand: 'default', scheme: 'inherit', density: 'comfortable', mobileUrl: '' }
}

/** @param value - Untrusted appearance input. @returns Validated, canonical values. */
export function parseOfficeAppearance(value: unknown): OfficeAppearance {
  const parsed = appearanceSchema.parse(value)
  return { ...parsed, mobileUrl: mobileAddress(parsed.mobileUrl) }
}

/** @param value - Untrusted assistant fields. @returns Validated assistant. */
export function parseOfficeAssistant(value: unknown): OfficeAssistant { return assistantSchema.parse(value) }

/** @param value - Untrusted durable JSON. @returns Validated current document; no predecessor fallback. */
export function parseOfficeExperienceDocument(value: unknown): OfficeExperienceDocument { return documentSchema.parse(value) }

/** @param text - UTF-8 JSON export, limited before parsing. @returns An assistant without adopting its exported identity. */
export function importOfficeAssistant(text: string): OfficeAssistant {
  if (new TextEncoder().encode(text).length > 65536) throw new Error('invalid')
  return z.object({ format: z.literal('office-assistant.v1'), assistant: assistantSchema }).strict().parse(JSON.parse(text)).assistant
}

/** @param assistant - Validated saved assistant. @returns A portable configuration without credentials or Session history. */
export function exportOfficeAssistant(assistant: OfficeAssistant): string {
  return `${JSON.stringify({ format: 'office-assistant.v1', assistant: parseOfficeAssistant(assistant) }, null, 2)}\n`
}
