/** Display choices for the office work-priority protocol. */
import type { OfficeWorkPriority } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeKey } from './locales.ts'

/** Stable selector order; it does not define work-list sorting. */
export const officeWorkPriorities: readonly OfficeWorkPriority[] = ['low', 'normal', 'high', 'urgent']
/** Locale-owned labels for every priority accepted by the office protocol. */
export const priorityKeys: Record<OfficeWorkPriority, OfficeKey> = {
  low: 'priorityLow', normal: 'priorityNormal', high: 'priorityHigh', urgent: 'priorityUrgent',
}
