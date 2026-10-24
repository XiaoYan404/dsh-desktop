/** Two independent employee Hosts complete a real limited first-password invitation without automatic sign-in. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-enterprise-office'
import type {} from '@deepseek-ai/dsh-client-ui-office'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { chromium } from 'playwright'
import type { Browser, Locator, Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

const title = 'issues an onboarding invitation across two independent Hosts, sets only the recipient first password and rejects the used code'
const admin = 'invite-browser-admin' as OfficeMemberId
const target = 'invite-browser-target' as OfficeMemberId
const spare = 'invite-browser-revoke' as OfficeMemberId
const key = credentialKey('client-ui-office', 'office-session')
const identity = z.looseObject({
  credentials: z.array(z.looseObject({ memberId: z.string(), revision: z.number().int(), digest: z.string() })),
  sessions: z.array(z.looseObject({ memberId: z.string() })),
  audit: z.array(z.looseObject({ action: z.string(), actorId: z.string(), targetId: z.string() })),
})

function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }

async function central(root: string, password: string) {
  // Native packages share the module map used by the real Loader and employee Host composition.
  const cli = createRequire(join(REPO_ROOT, 'apps/cli/package.json'))
  const web = createRequire(join(REPO_ROOT, 'packages/bundle/web-app/package.json'))
  const gateway = createRequire(join(REPO_ROOT, 'packages/enterprise/office-gateway/package.json'))
  const cordis = cli('@deepseek-ai/cordis') as typeof import('@deepseek-ai/cordis')
  const loader = cli('@deepseek-ai/cordis-plugin-loader') as typeof import('@deepseek-ai/cordis-plugin-loader')
  const include = cli('@deepseek-ai/cordis-plugin-include') as typeof import('@deepseek-ai/cordis-plugin-include')
  const storage = gateway('@deepseek-ai/dsh-storage') as typeof import('@deepseek-ai/dsh-storage')
  const json = gateway('@deepseek-ai/dsh-storage-json') as typeof import('@deepseek-ai/dsh-storage-json')
  const domain = gateway('@deepseek-ai/dsh-storage-domain') as typeof import('@deepseek-ai/dsh-storage-domain')
  const office = web('@deepseek-ai/dsh-enterprise-office') as typeof import('@deepseek-ai/dsh-enterprise-office')
  const ingress = gateway('@deepseek-ai/dsh-enterprise-office-gateway') as typeof import('@deepseek-ai/dsh-enterprise-office-gateway')
  const ctx = new cordis.Context()
  try {
    await mkdir(join(root, 'data'))
    const path = join(root, 'central.cordis.json')
    await writeFile(path, JSON.stringify([
      { name: 'cordis:inviteStorage' }, { name: 'cordis:inviteJson', config: { root: join(root, 'data') } },
      { name: 'cordis:inviteDomain', config: { backend: 'json' } },
      { name: 'cordis:inviteOffice', config: { companyName: 'First-password invitation browser company', timeZone: 'Asia/Shanghai',
        dshHome: root, memberInvites: { maxTtlMs: 3600000, maxEntries: 100, maxBytes: 65536 },
        members: [
          { id: admin, name: 'Invitation administrator', department: 'Office', jobTitle: 'Administrator', role: 'admin' },
          { id: target, name: 'Invitation recipient', department: 'Office', jobTitle: 'Employee', role: 'employee' },
          { id: spare, name: 'Revocable recipient', department: 'Office', jobTitle: 'Employee', role: 'employee' },
        ] } },
    ]))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(loader.default)
    Object.assign(ctx.loader.builtins, { include: include.default, inviteStorage: storage.default,
      inviteJson: json, inviteDomain: domain, inviteOffice: office.default, inviteGateway: ingress.default })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    if (!ctx.get('office')) throw new Error('The real invitation authority did not activate')
    await ctx.office.initializeIdentity(admin, password)
    await ctx.loader.create({ name: 'cordis:inviteGateway', config: {
      host: '127.0.0.1', port: 0, administratorId: admin, loginRequestsPerMinute: 100,
    } })
    await ctx.loader.await()
    if (!ctx.get('officeGateway')) throw new Error('The real invitation gateway did not activate')
    return { ctx, address: ctx.officeGateway.address }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

function identityState(ctx: Context) {
  const stored = ctx.storageDomain.get('enterprise_office_identity')
  if (!stored) throw new Error('The real invitation identity domain is absent')
  return identity.parse(stored.global.get())
}

async function fillPrivate(locator: Locator, value: string): Promise<void> {
  try { await locator.fill(value) }
  catch { throw new Error('Private invitation form input failed') }
}

async function enterPrivate(page: Page, url: string): Promise<void> {
  try { await page.goto(url, { waitUntil: 'load' }) }
  catch { throw new Error('Private invitation page navigation failed') }
}

async function signIn(page: Page, memberId: OfficeMemberId, password: string) {
  const form = page.getByRole('region', { name: 'Sign in to your company', exact: true })
  await form.waitFor({ timeout: 30000 })
  await form.getByLabel('Employee ID', { exact: true }).fill(memberId)
  await fillPrivate(form.getByLabel('Password', { exact: true }), password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Profile', exact: true }).waitFor()
}

async function openManagement(page: Page, memberId: OfficeMemberId) {
  await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Team', exact: true }).click()
  await page.locator(`[data-office-member="${memberId}"]`).getByRole('button', { name: 'Set sign-in password', exact: true }).click()
  const password = page.getByRole('dialog', { name: 'Set sign-in password', exact: true })
  await password.getByRole('button', { name: 'Onboarding invitations', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Onboarding invitations', exact: true })
  await dialog.waitFor()
  return dialog
}

async function openActivation(page: Page) {
  await page.getByRole('region', { name: 'Sign in to your company', exact: true })
    .getByRole('button', { name: 'Accept onboarding invitation', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Accept onboarding invitation', exact: true })
  await dialog.waitFor()
  return dialog
}

it(title, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-member-invites-browser-'))
  const hosts: WebScaffold[] = []
  const owned: { authority?: Context; browser?: Browser } = {}
  onTestFinished(async () => {
    const failures: unknown[] = []
    try { await owned.browser?.close() } catch (error) { failures.push(error) }
    for (const host of hosts.reverse()) {
      try { await host.close() } catch (error) { failures.push(error) }
    }
    try { await owned.authority?.fiber.dispose() } catch (error) { failures.push(error) }
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-member-invites-browser-'))
      throw new Error('Unexpected invitation browser fixture root')
    try { await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Invitation browser resources did not fully close')
  })
  const adminPassword = `Invitation-admin-${randomUUID()}!`
  const firstPassword = `Invitation-recipient-${randomUUID()}!`
  const replacementPassword = `Must-not-reset-${randomUUID()}!`
  const server = await central(root, adminPassword)
  const authority = server.ctx
  owned.authority = authority
  const health = await fetch(new URL('/health', server.address), { redirect: 'error' })
  expect(await health.json()).toEqual({ protocol: 'office.v1', memberInvites: { protocol: 1, maxTtlMs: 3600000 } })
  expect(identityState(authority).credentials.map(row => row.memberId)).toEqual([admin])
  const overlay = join(root, 'employee.patch.json')
  await writeFile(overlay, JSON.stringify([
    { id: 'enterprise-office', disabled: true },
    { id: 'ui-office', disabled: false, config: { principalId: '', gatewayUrl: server.address } },
    { id: 'ui-settings-models', config: { credentialOnboarding: false } },
  ]))
  const adminHost = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  hosts.push(adminHost)
  const recipientHost = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  hosts.push(recipientHost)
  expect(adminHost.harnessHome === recipientHost.harnessHome).toBe(false)
  expect(adminHost.baseUrl === recipientHost.baseUrl).toBe(false)
  expect(adminHost.ctx.get('office')).toBeUndefined()
  expect(recipientHost.ctx.get('office')).toBeUndefined()
  let modelRequests = 0
  for (const host of hosts) host.ctx.on('llm/stream', (_request, next) => { modelRequests++; return next() }, { prepend: true })
  const browser = await chromium.launch()
  owned.browser = browser
  const adminPage = await newEnglishPage(browser, 900)
  const recipientPage = await newEnglishPage(browser, 900)
  const adminConsole = watchConsole(adminPage)
  const recipientConsole = watchConsole(recipientPage)
  const responses: { role: string; method: string; status: number }[] = []
  for (const [role, page] of [['admin', adminPage], ['recipient', recipientPage]] as const) page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    const method = path.slice(path.lastIndexOf('/') + 1)
    if (['memberInviteCapability', 'memberInvite', 'issueMemberInvite', 'revokeMemberInvite', 'acceptMemberInvite', 'signIn'].includes(method))
      responses.push({ role, method, status: response.status() })
  })
  await enterPrivate(adminPage, adminHost.authenticatedUrl)
  await enterPrivate(recipientPage, recipientHost.authenticatedUrl)
  const startupArtifacts = join(REPO_ROOT, '.artifacts/enterprise-office/member-invites/browser-plan')
  await mkdir(startupArtifacts, { recursive: true })
  const startup: {
    role: string
    language: string
    loginBeforeNavigation: boolean
    loginAfterNavigation: boolean
    invitationVisible: boolean
  }[] = []
  for (const [role, page] of [['admin', adminPage], ['recipient', recipientPage]] as const) {
    const navigation = page.getByRole('navigation', { name: 'Workbench', exact: true })
    await navigation.waitFor()
    const region = page.getByRole('region', { name: 'Sign in to your company', exact: true })
    const before = await region.isVisible()
    await page.screenshot({ path: join(startupArtifacts, `${role}-before-workbench.png`), animations: 'disabled' })
    await navigation.getByRole('button', { name: 'Workbench', exact: true }).click()
    await region.waitFor()
    startup.push({ role, language: await page.evaluate(() => document.documentElement.lang),
      loginBeforeNavigation: before, loginAfterNavigation: await region.isVisible(),
      invitationVisible: await region.getByRole('button', { name: 'Accept onboarding invitation', exact: true }).isVisible() })
    await writeFile(join(startupArtifacts, 'startup.json'), JSON.stringify({ startup, responses }, null, 2) + '\n')
  }
  const login = recipientPage.getByRole('region', { name: 'Sign in to your company', exact: true })
  await login.getByRole('button', { name: 'Accept onboarding invitation', exact: true }).waitFor()
  expect(await recipientHost.ctx.credentials.describeRecord(key)).toMatchObject({ configured: false })
  await signIn(adminPage, admin, adminPassword)
  const adminCredentialHash = hash(JSON.stringify(await adminHost.ctx.credentials.readRecord(key)))
  let management = await openManagement(adminPage, target)
  await management.getByRole('button', { name: 'Create invitation', exact: true }).click()
  const codeInput = management.getByLabel('Invitation code', { exact: true })
  await codeInput.waitFor()
  const code = await codeInput.inputValue()
  expect(/^[A-Za-z0-9_-]{43}$/u.test(code)).toBe(true)
  const issued = await authority.office.memberInvite(admin, target)
  expect(issued).toMatchObject({ credentialPresent: false, canAccept: true })
  const invitation = issued.invitation
  if (!invitation) throw new Error('Actual UI issuance did not retain its invitation metadata')
  const ledger = await readFile(join(root, 'data/enterprise_office_member_invites.json'), 'utf8')
  expect(ledger.includes(code)).toBe(false)
  expect(ledger.includes(hash(code))).toBe(true)
  await management.getByRole('button', { name: 'Close', exact: true }).filter({ hasText: /^Close$/u }).click()
  await management.waitFor({ state: 'hidden' })
  management = await openManagement(adminPage, target)
  await management.getByText('Waiting for member activation', { exact: true }).waitFor()
  expect(await management.getByLabel('Invitation code', { exact: true }).count()).toBe(0)
  await management.getByRole('button', { name: 'Close', exact: true }).filter({ hasText: /^Close$/u }).click()
  await management.waitFor({ state: 'hidden' })
  let activation = await openActivation(recipientPage)
  await fillPrivate(activation.getByLabel('Invitation code', { exact: true }), code)
  await fillPrivate(activation.getByLabel('New password', { exact: true }), firstPassword)
  await fillPrivate(activation.getByLabel('Confirm new password', { exact: true }), firstPassword)
  await activation.getByRole('button', { name: 'Set first password', exact: true }).click()
  await activation.waitFor({ state: 'hidden' })
  await expect.poll(() => login.getByLabel('Employee ID', { exact: true }).inputValue()).toBe(target)
  expect(await login.isVisible()).toBe(true)
  expect((await login.getByLabel('Password', { exact: true }).inputValue()).length === 0).toBe(true)
  expect(await recipientHost.ctx.credentials.describeRecord(key)).toMatchObject({ configured: false })
  const accepted = identityState(authority)
  expect(accepted.credentials.filter(row => row.memberId === target)).toHaveLength(1)
  expect(accepted.sessions.filter(row => row.memberId === target)).toHaveLength(0)
  expect(accepted.audit.at(-1)).toMatchObject({ action: 'credential_set', actorId: target, targetId: target })
  const committedHash = hash(JSON.stringify(accepted.credentials.find(row => row.memberId === target)))
  await signIn(recipientPage, target, firstPassword)
  expect(await recipientHost.ctx.credentials.describeRecord(key)).toMatchObject({ configured: true, kind: 'grant' })
  expect(await recipientHost.ctx.officeController.connection()).toMatchObject({ ok: true,
    value: { connected: true, member: { id: target } } })
  expect(await recipientHost.ctx.officeController.memberInvite(target)).toEqual({ ok: false, code: 'forbidden' })
  await recipientPage.getByRole('button', { name: 'Account and security', exact: true }).click()
  await recipientPage.getByRole('dialog', { name: 'Account and security', exact: true })
    .getByRole('button', { name: 'Sign out', exact: true }).click()
  await login.waitFor()
  activation = await openActivation(recipientPage)
  await fillPrivate(activation.getByLabel('Invitation code', { exact: true }), code)
  await fillPrivate(activation.getByLabel('New password', { exact: true }), replacementPassword)
  await fillPrivate(activation.getByLabel('Confirm new password', { exact: true }), replacementPassword)
  await activation.getByRole('button', { name: 'Set first password', exact: true }).click()
  await activation.getByRole('alert').filter({ hasText: 'This invitation code is unavailable.' }).waitFor()
  expect(hash(JSON.stringify(identityState(authority).credentials.find(row => row.memberId === target))) === committedHash).toBe(true)
  expect(identityState(authority).sessions.filter(row => row.memberId === target)).toHaveLength(0)
  await activation.getByRole('button', { name: 'Back to sign-in', exact: true }).click()
  await activation.waitFor({ state: 'hidden' })
  await signIn(recipientPage, target, firstPassword)
  management = await openManagement(adminPage, target)
  await management.getByText('This account has a password. Invitation codes are no longer usable.', { exact: true }).waitFor()
  expect(await management.getByRole('button', { name: 'Create invitation', exact: true }).count()).toBe(0)
  await management.getByRole('button', { name: 'Close', exact: true }).filter({ hasText: /^Close$/u }).click()
  await management.waitFor({ state: 'hidden' })
  management = await openManagement(adminPage, spare)
  await management.getByRole('button', { name: 'Create invitation', exact: true }).click()
  await management.getByLabel('Invitation code', { exact: true }).waitFor()
  await management.getByRole('button', { name: 'Revoke invitation', exact: true }).click()
  await management.getByText('Revoked', { exact: true }).waitFor()
  await management.getByLabel('Invitation code', { exact: true }).waitFor({ state: 'detached' })
  expect(await management.getByLabel('Invitation code', { exact: true }).count()).toBe(0)
  const revoked = await authority.office.memberInvite(admin, spare)
  expect(revoked).toMatchObject({ credentialPresent: false, revoked: true, canAccept: false })
  await management.getByRole('button', { name: 'Close', exact: true }).filter({ hasText: /^Close$/u }).click()
  await management.waitFor({ state: 'hidden' })
  expect(hash(JSON.stringify(await adminHost.ctx.credentials.readRecord(key))) === adminCredentialHash).toBe(true)
  expect(await adminHost.ctx.officeController.connection()).toMatchObject({ ok: true, value: { member: { id: admin } } })
  for (const page of [adminPage, recipientPage]) await page.getByRole('button', { name: 'Native workspace', exact: true }).waitFor()
  expect(modelRequests).toBe(0)
  for (const console of [adminConsole, recipientConsole]) {
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  }
  const artifacts = join(REPO_ROOT, '.artifacts/enterprise-office/member-invites/browser-plan')
  await mkdir(artifacts, { recursive: true })
  await recipientPage.screenshot({ path: join(artifacts, 'recipient-signed-in.png'), fullPage: true, animations: 'disabled' })
  await writeFile(join(artifacts, 'evidence.json'), JSON.stringify({ title,
    members: { administrator: admin, recipient: target, revokedRecipient: spare }, invitationId: invitation.id,
    codeSha256: hash(code), rawCodePersisted: false, codeUnavailableAfterDialogClosed: true,
    acceptedBeforeNormalLogin: { credentials: 1, sessions: 0, hostCredentialConfigured: false },
    actor: target, firstPasswordResetDenied: true, originalLoginWorks: true, adminHostCredentialUnchanged: true,
    revokedInvitationId: revoked.invitation?.id ?? null, revokedMemberCredentialPresent: revoked.credentialPresent,
    independentHosts: true, modelRequests, responses,
    console: { administrator: adminConsole, recipient: recipientConsole },
  }, null, 2) + '\n')
})
