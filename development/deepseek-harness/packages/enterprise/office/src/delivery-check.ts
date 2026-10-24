/** Real binary delivery checks share the same bounded PDF and Office parsers as authorized file reads. */
import { z } from 'zod'
import { officeConversationFileSchemas } from './conversation-files.ts'
import { OfficeError } from './error.ts'
import { extractOfficeKnowledge } from './knowledge-document.ts'
import type { OfficeKnowledgeParsers } from './knowledge-document.ts'
import type { OfficeConversationFileReference } from './types.ts'
import type { OfficeDeliveryCheck, OfficeDeliveryCheckInput, OfficeDeliveryPolicy, OfficeDeliveryTemplate } from './delivery-types.ts'

/** Fixed recipes point to the unchanged bundled authoring skills and the shared LibreOffice conversion workflow. */
export const officeDeliveryTemplates: Readonly<Record<OfficeDeliveryTemplate, { readonly mediaType: string; readonly source: string }>> = {
  document: { mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    source: 'bundled:office-docx / packages/skill/skill-office/assets/office-docx/SKILL.md' },
  spreadsheet: { mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    source: 'bundled:office-xlsx / packages/skill/skill-office/assets/office-xlsx/SKILL.md' },
  presentation: { mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    source: 'bundled:office-pptx / packages/skill/skill-office/assets/office-pptx/SKILL.md' },
  pdf: { mediaType: 'application/pdf', source: 'bundled:office-docx / LibreOffice Kit PDF export' },
}

/** Strict fixed-format check, never an arbitrary parser, source path or uploaded success report. */
export const officeDeliveryCheckInput = officeConversationFileSchemas.readDocx.pick({ captureId: true, fileId: true }).extend({
  template: z.enum(['document', 'spreadsheet', 'presentation', 'pdf']),
  expectedText: z.array(z.string().min(1).max(4096)).min(1).max(100),
}).strict()

/**
 * Resolve complete explicit delivery bounds without enabling a deployment implicitly.
 * @param input - Optional deployment policy.
 * @returns Validated policy or undefined while delivery checking is disabled.
 */
export function resolveOfficeDeliveryPolicy(input: unknown): OfficeDeliveryPolicy | undefined {
  if (input === undefined) return undefined
  const positive = (max: number) => z.number().int().min(1).max(max)
  const parsed = z.object({ maxSourceBytes: positive(64 * 1024 * 1024), maxDocumentCharacters: positive(2 * 1024 * 1024),
    maxSections: positive(2000), timeoutMs: positive(30000), maxResultBytes: positive(16 * 1024 * 1024),
    maxExpectedTexts: positive(100), maxExpectedTextCharacters: positive(4096) }).strict().safeParse(input)
  if (!parsed.success) throw new OfficeError('invalid_input', 'Office delivery checks require complete finite limits')
  return parsed.data
}

/**
 * Verify real format/content using the original reader workers; no formula execution, macros or visual-layout claim is added.
 * @param file - Current human-submitted immutable source.
 * @param bytes - Actual length/digest-verified binary bytes.
 * @param input - Fixed recipe and independently requested content assertions.
 * @param policy - Explicit source, parser and complete-output bounds.
 * @param parsers - Original Office deployment's parser policies.
 * @param signal - Original request and service lifetime.
 * @returns Complete bounded structural/content evidence; any missing text rejects the check.
 */
export async function checkOfficeDelivery(file: OfficeConversationFileReference, bytes: Uint8Array, input: OfficeDeliveryCheckInput,
  policy: OfficeDeliveryPolicy, parsers: OfficeKnowledgeParsers, signal: AbortSignal): Promise<OfficeDeliveryCheck> {
  const parsed = officeDeliveryCheckInput.safeParse(input)
  if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid Office delivery check')
  const value = parsed.data
  if (value.expectedText.length > policy.maxExpectedTexts
    || value.expectedText.some(text => text.length > policy.maxExpectedTextCharacters))
    throw new OfficeError('context_too_large', 'Office delivery assertions exceed their limits')
  const template = officeDeliveryTemplates[value.template]
  if (file.mediaType !== template.mediaType) throw new OfficeError('invalid_input', 'Delivery format does not match the reviewed recipe')
  const units = await extractOfficeKnowledge(file, bytes, policy, parsers, signal)
  signal.throwIfAborted()
  const combined = units.map(unit => unit.text).join('\n')
  if (value.expectedText.some(text => !combined.includes(text))) throw new OfficeError('conflict', 'Delivery lacks required document text')
  const result: OfficeDeliveryCheck = { file, template: value.template, templateSource: template.source,
    verifiedSections: new Set(units.map(unit => unit.location.part)).size,
    textCharacters: units.reduce((sum, unit) => sum + unit.text.length, 0),
    assertions: value.expectedText.map(text => ({ text, found: true })), verification: 'structure_and_text', visualLayout: 'not_checked' }
  if (Math.max(Buffer.byteLength(JSON.stringify({ ok: true, value: result })),
    Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(result) }]))) > policy.maxResultBytes)
    throw new OfficeError('context_too_large', 'Complete Office delivery check result exceeds its byte limit')
  return result
}
