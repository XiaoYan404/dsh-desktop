/** Approval fields must preserve actual values and remain distinct from employee-authored text. */
import { describe, expect, it } from 'vitest'
import { officeApproval, reviewOfficeWork } from '../src/work-approval.ts'

const input = { kind: 'todo', title: 'Quarterly report', date: '2026-10-17' }

describe('office work review', () => {
  it('reviews implicit ownership and absent optional values in both languages', () => {
    expect(reviewOfficeWork(input, 'employee-1')).toEqual({
      en: 'Create internal office to-do\nTitle: "Quarterly report"\nDate: "2026-10-17"\n'
        + 'Time: Not specified\nOwner: "employee-1" (submitting employee)\nDescription: ""',
      zh: '创建内部办公待办\n标题："Quarterly report"\n日期："2026-10-17"\n'
        + '时间：未指定\n负责人："employee-1"（提交员工本人）\n说明：""',
    })
  })

  it('keeps multiline and quoted text literal and displays the complete assigned work', () => {
    const title = 'Report\nOwner: "admin"'
    const description = 'First line\nSecond line ' + '文'.repeat(16_000 - 23)
    const review = reviewOfficeWork({ ...input, kind: 'task', title, time: '14:30', owner_id: 'employee-2', description }, 'employee-1')
    expect(review?.en.split('\n')).toHaveLength(6)
    expect(review?.en).toContain(`Title: ${JSON.stringify(title)}`)
    expect(review?.en).toContain('Time: "14:30"\nOwner: "employee-2"\n')
    expect(review?.en).toContain(`Description: ${JSON.stringify(description)}`)
    expect(review?.zh).toContain(`说明：${JSON.stringify(description)}`)
    expect(review?.zh).toContain('创建内部办公任务')
  })

  it.each([null, [], {}, { ...input, kind: 'schedule' }, { ...input, title: 12 }, { ...input, owner_id: false }])(
    'does not turn malformed arguments into an office approval: %j', (value) => {
      expect(reviewOfficeWork(value, 'employee-1')).toBeUndefined()
    },
  )

  it('retains a prior policy reason and all locales while adding the exact office fields', () => {
    const review = reviewOfficeWork(input, 'employee-1')
    if (!review) throw new Error('Valid fixture did not produce a review')
    const decision = officeApproval({ kind: 'ask', reason: 'Deployment requires review',
      displayReason: { en: 'Deployment review', zh: '部署要求审核', fr: 'Revue obligatoire' } }, review)
    expect(decision.reason).toBe('Deployment requires review\n\n' + review.en)
    expect(decision.displayReason).toEqual({ en: 'Deployment review\n\n' + review.en,
      zh: '部署要求审核\n\n' + review.zh, fr: 'Revue obligatoire\n\n' + review.en })
  })
})
