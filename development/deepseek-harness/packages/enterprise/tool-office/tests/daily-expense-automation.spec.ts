/** New daily-report and expense skills execute their shipped scripts, native tools and exact source data. */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { automationEvents, automationRecord, automationWorkflow, createAutomationFixture, runAutomationTurn } from './fixtures/automation-context.ts'
import type { AutomationModelScript } from './fixtures/automation-context.ts'

const notes = '2026-10-19: Completed the acceptance checklist. Deployment is planned for tomorrow, not completed. Blocker: waiting for budget confirmation. No hours were recorded.'
const daily = '# Daily report — 2026-10-19\n\nCompleted: acceptance checklist.\nPlan: deployment tomorrow.\nBlocker: budget confirmation. Hours: unknown.\nSources: supplied work-notes.txt only.\n'
const ledgerData = { entries: [
  { id: 'taxi', currency: 'CNY', amount: '0.10', date: '2026-10-19', receipt: 'INV-A', source: 'Receipt A' },
  { id: 'meal', currency: 'CNY', amount: '0.20', date: '2026-10-19', receipt: 'INV-A', source: 'Receipt A repeated' },
  { id: 'hotel', currency: 'CNY', amount: '150.00', date: '', receipt: 'INV-C', source: 'Receipt C' },
  { id: 'subscription', currency: 'USD', amount: '10.00', date: '2026-10-19', receipt: 'INV-D', source: 'Receipt D' },
  { id: 'invalid', currency: 'CNY', amount: '1.001', date: '2026-10-19', receipt: 'INV-E', source: 'Unresolved decimal evidence' },
  { id: 'unknown', currency: 'JPY', amount: '100', date: '2026-10-19', receipt: 'INV-F', source: 'Receipt F' },
], claimedTotals: [{ currency: 'CNY', amount: '150.00' }, { currency: 'USD', amount: '10.00' }] }
const ledger = JSON.stringify(ledgerData)
const policyData = { currencyScale: { CNY: 2, USD: 2 }, perItemLimits: { CNY: '100.00' },
  requiredFields: ['date', 'receipt', 'source'] }
const policy = JSON.stringify(policyData)
const checks = {
  totals: [{ currency: 'CNY', amount: '150.30' }, { currency: 'USD', amount: '10.00' }],
  findings: [
    { entry: 2, code: 'duplicate_receipt', receipt: 'INV-A' },
    { entry: 3, code: 'missing_field', field: 'date' },
    { entry: 3, code: 'over_item_limit', currency: 'CNY', amount: '150.00', limit: '100.00' },
    { entry: 5, code: 'invalid_amount_or_scale', currency: 'CNY' },
    { entry: 6, code: 'unknown_currency' },
    { code: 'claimed_total_mismatch', currency: 'CNY', claimed: '150.00', computed: '150.30' },
  ],
  uncheckedRules: ['No per-item amount limit was supplied for USD.'],
  scope: 'Evidence checks only; no reimbursement approval or payment.',
}
const expenseReview = 'Check only: CNY 150.30 and USD 10.00 remain separate. Duplicate receipt A, a missing date, an exceeded CNY limit and excluded invalid or unknown rows require review. USD limits are unknown. No reimbursement was approved.'
const expenseReport = `# Reimbursement evidence check\n\n${JSON.stringify(checks, null, 2)}\n\n${expenseReview}\n`

it('resolves all three new bundled skills to their own instructions while retaining the existing minutes skill', async () => {
  const { ctx } = await createAutomationFixture([])
  const expected = [
    ['office-daily-report', '# Daily work report'],
    ['office-expense-check', '# Reimbursement evidence check'],
    ['office-task-reminder', '# Native task reminders'],
  ] as const
  for (const [name, heading] of expected) {
    const skill = await ctx.skills.get(name)
    expect(skill?.name).toBe(name)
    expect(skill?.content.startsWith(heading)).toBe(true)
    expect(skill?.provider).toBe('dsh-office-automation')
  }
  expect((await ctx.skills.get('office-minutes'))?.content.startsWith('# Meeting minutes')).toBe(true)
})

it('reads actual work notes, executes extraction and review, and persists the daily-report file and delivery', async () => {
  const script: AutomationModelScript = []
  const { ctx, cwd, agent, adapter } = await createAutomationFixture(script)
  await writeFile(join(cwd, 'work-notes.txt'), notes)
  script.push(toolCallResponse('daily-source', 'read', { file_path: 'work-notes.txt' }),
    await automationWorkflow(ctx, 'office-daily-report', { date: '2026-10-19', material: notes }, ['Extract', 'Review']),
    textResponse(daily), textResponse(daily),
    toolCallResponse('daily-write', 'write', { file_path: 'daily-report.md', content: daily }),
    toolCallResponse('daily-verify', 'read', { file_path: 'daily-report.md' }),
    toolCallResponse('daily-deliver', 'present', { files: [{ path: 'daily-report.md' }] }),
    textResponse('Daily report delivered. Deployment remains planned; hours and budget remain unresolved.'))
  await runAutomationTurn(ctx, agent, '/office-daily-report Run the workflow for 2026-10-19 from work-notes.txt and deliver daily-report.md.')
  expect(await readFile(join(cwd, 'daily-report.md'), 'utf8')).toBe(daily)
  expect(await readFile(join(cwd, 'work-notes.txt'), 'utf8')).toBe(notes)
  expect(JSON.stringify(adapter.requests[1]?.messages)).toContain(notes)
  expect(JSON.stringify(adapter.requests[2]?.messages)).toContain(notes)
  expect(automationRecord(await automationEvents(ctx, agent))).toMatchInlineSnapshot(`
    [
      "start:office-daily-report",
      "member:Extract:Extract daily work facts",
      "member-end:completed",
      "member:Review:Review daily report",
      "member-end:completed",
      "end:completed",
      "delivered:daily-report.md",
    ]
  `)
})

it.each([
  [{ date: '2026-10-19', material: '' }, 'Actual work notes or authorized office results are required'],
  [{ material: notes }, 'An explicit daily-report date in YYYY-MM-DD form is required.'],
  [{ date: '2026-02-31', material: notes }, 'The daily-report date is not a calendar date.'],
] as const)('records a failed daily workflow for missing or invalid source requirements (%j)', async (args, reason) => {
  const script: AutomationModelScript = []
  const { ctx, cwd, agent } = await createAutomationFixture(script)
  script.push(await automationWorkflow(ctx, 'office-daily-report', args, ['Extract', 'Review']),
    textResponse('The daily report could not run because required dated source material was missing or invalid.'))
  await runAutomationTurn(ctx, agent, '/office-daily-report Run the daily-report workflow with the supplied requirements.')
  const events = await automationEvents(ctx, agent)
  expect(automationRecord(events)).toEqual(['start:office-daily-report', 'end:error'])
  expect(JSON.stringify(events)).toContain(reason)
  expect(await readdir(cwd)).toEqual([])
})

it('checks exact decimal totals, duplicates, policy limits and missing evidence from real files before delivering a report', async () => {
  const script: AutomationModelScript = []
  const { ctx, cwd, agent } = await createAutomationFixture(script)
  await writeFile(join(cwd, 'ledger.json'), ledger)
  await writeFile(join(cwd, 'rules.json'), policy)
  script.push(toolCallResponse('expense-ledger', 'read', { file_path: 'ledger.json' }),
    toolCallResponse('expense-policy', 'read', { file_path: 'rules.json' }),
    await automationWorkflow(ctx, 'office-expense-check', { material: ledger, policy }, ['Check', 'Review']),
    (options) => {
      expect(options.messages.some(message => message.content.some(block => block.type === 'text'
        && block.text.includes(JSON.stringify({ ledger: ledgerData, policy: policyData, checks }))))).toBe(true)
      return textResponse(expenseReview)
    },
    toolCallResponse('expense-write', 'write', { file_path: 'expense-check.md', content: expenseReport }),
    toolCallResponse('expense-verify', 'read', { file_path: 'expense-check.md' }),
    toolCallResponse('expense-deliver', 'present', { files: [{ path: 'expense-check.md' }] }),
    textResponse('Evidence check delivered. Missing or invalid evidence and unknown USD rules still require review; no approval or payment was submitted.'))
  await runAutomationTurn(ctx, agent, '/office-expense-check Run the workflow using ledger.json and rules.json; deliver expense-check.md without submitting reimbursement.')
  const events = await automationEvents(ctx, agent)
  expect(await readFile(join(cwd, 'expense-check.md'), 'utf8')).toBe(expenseReport)
  expect(await readFile(join(cwd, 'ledger.json'), 'utf8')).toBe(ledger)
  expect(await readFile(join(cwd, 'rules.json'), 'utf8')).toBe(policy)
  const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'automation-workflow')
  expect(JSON.stringify(result)).toContain('150.30')
  expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual([
    'read', 'read', 'workflow', 'write', 'read', 'present',
  ])
  expect(automationRecord(events)).toMatchInlineSnapshot(`
    [
      "start:office-expense-check",
      "member:Review:Review reimbursement evidence",
      "member-end:completed",
      "end:completed",
      "delivered:expense-check.md",
    ]
  `)
})

it.each([
  [{ material: '', policy }, 'Actual reimbursement entries are required before checking.'],
  [{ material: ledger, policy: '' }, 'Explicit company reimbursement rules are required before checking.'],
  [{ material: ledger, policy: '{}' }, 'The company rules must declare currencyScale, perItemLimits and requiredFields.'],
] as const)('retains missing expense evidence or rules as native failures without delivering invented conclusions (%j)', async (args, reason) => {
  const script: AutomationModelScript = []
  const { ctx, cwd, agent } = await createAutomationFixture(script)
  script.push(await automationWorkflow(ctx, 'office-expense-check', args, ['Check', 'Review']),
    textResponse('The check could not run because actual entries or explicit company rules were unavailable. No approval conclusion was produced.'))
  await runAutomationTurn(ctx, agent, '/office-expense-check Run the reimbursement checking workflow with the available inputs.')
  const events = await automationEvents(ctx, agent)
  expect(automationRecord(events)).toEqual(['start:office-expense-check', 'end:error'])
  expect(JSON.stringify(events)).toContain(reason)
  expect(await readdir(cwd)).toEqual([])
})

it('cancels the actual reimbursement reviewer and preserves that attempt without a report or surviving child', async () => {
  const script: AutomationModelScript = []
  const { ctx, cwd, agent } = await createAutomationFixture(script)
  script.push(await automationWorkflow(ctx, 'office-expense-check', { material: ledger, policy }, ['Check', 'Review']), 'hang')
  const started = new Promise<void>((resolve) => { ctx.on('workflow/agent-start', () => { resolve() }) })
  const idle = runAutomationTurn(ctx, agent, '/office-expense-check Run the reimbursement checking workflow with the supplied ledger and rules.')
  await started
  agent.cancel({ kind: 'user' })
  await idle
  expect(automationRecord(await automationEvents(ctx, agent))).toMatchInlineSnapshot(`
    [
      "start:office-expense-check",
      "member:Review:Review reimbursement evidence",
      "member-end:cancelled",
      "end:cancelled",
    ]
  `)
  expect(await readdir(cwd)).toEqual([])
  expect(ctx.agents.list()).toHaveLength(1)
})
