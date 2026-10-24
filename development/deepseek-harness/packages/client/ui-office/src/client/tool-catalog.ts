/** Presentation categories and explicit task templates; installation facts come only from native discovery. */
import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeKey } from './locales.ts'

/** Stable filter choices shared by native skill metadata and task templates. */
export type OfficeToolCategory = 'all' | 'documents' | 'meetings' | 'processes' | 'systems' | 'other'

interface OfficeTaskTemplate {
  readonly id: string
  readonly category: OfficeToolCategory
  readonly title: OfficeKey
  readonly description: OfficeKey
  readonly prompt: OfficeKey
}

/** Localized request starters; their presence makes no installation or connectivity claim. */
export const officeTaskTemplates: readonly OfficeTaskTemplate[] = [
  { id: 'document', category: 'documents', title: 'toolsDocument', description: 'toolsDocumentHint', prompt: 'toolsDocumentPrompt' },
  { id: 'spreadsheet', category: 'documents', title: 'toolsSpreadsheet', description: 'toolsSpreadsheetHint', prompt: 'toolsSpreadsheetPrompt' },
  { id: 'presentation', category: 'documents', title: 'toolsPresentation', description: 'toolsPresentationHint', prompt: 'toolsPresentationPrompt' },
  { id: 'pdf', category: 'documents', title: 'toolsPdf', description: 'toolsPdfHint', prompt: 'toolsPdfPrompt' },
  { id: 'minutes', category: 'meetings', title: 'toolsMinutes', description: 'toolsMinutesHint', prompt: 'toolsMinutesPrompt' },
  { id: 'approval', category: 'processes', title: 'toolsApproval', description: 'toolsApprovalHint', prompt: 'toolsApprovalPrompt' },
  { id: 'reminder', category: 'processes', title: 'toolsReminder', description: 'toolsReminderHint', prompt: 'toolsReminderPrompt' },
]

/**
 * Classify the bundled Office names while keeping custom skills in the general category.
 * @param skill - Confirmed native skill metadata.
 * @returns A stable category independent of translated descriptions.
 */
export function nativeSkillCategory(skill: SkillEntry): OfficeToolCategory {
  return ['office-docx', 'office-xlsx', 'office-pptx'].includes(skill.name) ? 'documents' : 'other'
}

/**
 * Match user-supplied names and descriptions without depending on their Unicode normalization form.
 * @param query - User search.
 * @param values - Displayed metadata.
 * @returns A case-insensitive, Unicode-normalized text match.
 */
export function matchesOfficeTool(query: string, values: readonly string[]): boolean {
  const normalized = (value: string) => value.normalize('NFC').toLocaleLowerCase()
  return normalized(values.join('\n')).includes(normalized(query.trim()))
}
