/** Human review of the exact office tool fields, using the same schema as native execution. */
import { validateArgs } from '@deepseek-ai/dsh-tools'
import type { InferArgs, PreToolDecision } from '@deepseek-ai/dsh-tools'

/** Shared native input schema; review and execution must accept the same field types. */
export const workParameters = {
  kind: { type: 'string', enum: ['task', 'todo'], required: true, description: 'Internal work kind.' },
  title: { type: 'string', required: true, description: 'Concrete office task or to-do title.' },
  date: { type: 'string', required: true, description: 'Employee office date in YYYY-MM-DD form.' },
  time: { type: 'string', description: 'Optional office-local HH:mm time.' },
  description: { type: 'string', description: 'Optional work details.' },
  owner_id: { type: 'string', description: 'Optional known active company employee id; omission assigns to the submitting employee.' },
} as const

/** Both supported UI languages describe the same operation; the English value is also its audit reason. */
export interface OfficeWorkReview {
  /** English approval fields, also used in the audit reason. */
  readonly en: string
  /** Simplified Chinese presentation of the same fields. */
  readonly zh: string
}

/**
 * Quote employee-authored text so embedded newlines cannot impersonate another review field.
 * @param input - Registry-materialized immutable native arguments.
 * @param employeeId - Submitting employee frozen in the claimed capture, also used by execution's default owner.
 * @returns Complete review copy, or undefined when the native input shape is invalid.
 */
export function reviewOfficeWork(input: unknown, employeeId: string): OfficeWorkReview | undefined {
  if (validateArgs(workParameters, input).length) return undefined
  const args = input as InferArgs<typeof workParameters>
  const owner = args.owner_id ?? employeeId
  return {
    en: [args.kind === 'task' ? 'Create internal office task' : 'Create internal office to-do',
      `Title: ${JSON.stringify(args.title)}`, `Date: ${JSON.stringify(args.date)}`,
      `Time: ${args.time === undefined ? 'Not specified' : JSON.stringify(args.time)}`,
      `Owner: ${JSON.stringify(owner)}${owner === employeeId ? ' (submitting employee)' : ''}`,
      `Description: ${JSON.stringify(args.description ?? '')}`].join('\n'),
    zh: [args.kind === 'task' ? '创建内部办公任务' : '创建内部办公待办',
      `标题：${JSON.stringify(args.title)}`, `日期：${JSON.stringify(args.date)}`,
      `时间：${args.time === undefined ? '未指定' : JSON.stringify(args.time)}`,
      `负责人：${JSON.stringify(owner)}${owner === employeeId ? '（提交员工本人）' : ''}`,
      `说明：${JSON.stringify(args.description ?? '')}`].join('\n'),
  }
}

/**
 * Preserve a prior native approval request while adding the office action being reviewed.
 * @param previous - Existing policy's request, when another policy already requires approval.
 * @param review - Complete office fields in both supported UI languages.
 * @returns One native approval request with its original reason and all supplied locale entries retained.
 */
export function officeApproval(
  previous: Extract<PreToolDecision, { kind: 'ask' }> | undefined, review: OfficeWorkReview,
): Extract<PreToolDecision, { kind: 'ask' }> {
  const join = (prefix: string | undefined, detail: string) => prefix ? `${prefix}\n\n${detail}` : detail
  const displayReason: { en: string; [locale: string]: string } = {
    en: join(previous?.displayReason?.en ?? previous?.reason, review.en),
    zh: join(previous?.displayReason?.zh ?? previous?.reason, review.zh),
  }
  for (const [locale, text] of Object.entries(previous?.displayReason ?? {})) {
    if (locale !== 'en' && locale !== 'zh') displayReason[locale] = join(text, review.en)
  }
  return { kind: 'ask', reason: join(previous?.reason, review.en), displayReason }
}
