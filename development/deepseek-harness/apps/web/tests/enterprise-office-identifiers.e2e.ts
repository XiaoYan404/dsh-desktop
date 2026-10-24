/** Directory-issued ids may name prototype properties; chat and account conditions still use real own data. */
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import type {} from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

it('chats, restores contact drafts and sets shared conditions for prototype-named employee ids', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: join(REPO_ROOT, 'enterprise-workbench.patch.yml') })
  onTestFinished(() => scaffold.close())
  const owner = 'owner' as OfficeMemberId
  const local = 'local' as OfficeMemberId
  const ids = ['constructor', '__proto__', 'toString'].map(value => value as OfficeMemberId)
  for (const id of ids) await scaffold.ctx.office.saveMember(owner, { id, name: `Employee ${id}`, department: 'Office', jobTitle: 'Employee', role: 'employee', active: true, email: '', phone: '' }, null)
  const parent = await scaffold.ctx.office.createDriveFolder(owner, { space: 'shared', folderId: null, name: 'Editable shared parent' })
  await scaffold.ctx.office.saveDrivePermissions(owner, { id: parent.id, revision: 1, defaultAccess: 'edit', grants: [] })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-identifiers'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const nav = page.getByRole('navigation', { name: 'Workbench', exact: true })
  await nav.getByRole('button', { name: 'Contacts', exact: true }).click()
  const prompt = 'Message; Enter to send, Shift+Enter for a new line'
  for (const id of ids) {
    await page.locator(`[data-office-member="${id}"]`).getByRole('button', { name: 'Message', exact: true }).click()
    const chat = page.getByRole('dialog', { name: 'Employee chat', exact: true })
    const editor = chat.getByRole('textbox', { name: prompt, exact: true })
    expect(await editor.inputValue()).toBe('')
    await editor.fill(`Message for ${id}`)
    await editor.press('Enter')
    await expect.poll(() => scaffold.ctx.office.chat(id, local).messages.map(entry => entry.text)).toEqual([`Message for ${id}`])
    await expect.poll(() => editor.inputValue()).toBe('')
    await editor.fill(`Saved draft for ${id}`)
    await expect.poll(() => scaffold.ctx.office.chatDrafts(local).drafts.find(entry => entry.peerId === id)?.text).toBe(`Saved draft for ${id}`)
    await chat.getByRole('button', { name: 'Close', exact: true }).click()
  }
  const warnings = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  await nav.getByRole('button', { name: 'Contacts', exact: true }).click()
  acknowledgeReloadConnectionLoss(console, warnings)
  for (const id of ids) {
    await page.locator(`[data-office-member="${id}"]`).getByRole('button', { name: 'Message', exact: true }).click()
    const chat = page.getByRole('dialog', { name: 'Employee chat', exact: true })
    await expect.poll(() => chat.getByRole('textbox', { name: prompt, exact: true }).inputValue()).toBe(`Saved draft for ${id}`)
    await chat.getByRole('button', { name: 'Close', exact: true }).click()
  }
  await nav.getByRole('button', { name: 'Drive', exact: true }).click()
  const drive = page.getByRole('region', { name: 'Drive', exact: true })
  await drive.getByRole('navigation', { name: 'Folder navigation', exact: true }).getByRole('button', { name: 'Shared drive', exact: true }).click()
  await drive.locator(`[data-drive-entry="${parent.id}"]`).dblclick()
  await drive.getByRole('button', { name: 'New folder', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'New folder', exact: true })
  await dialog.getByLabel('Name', { exact: true }).fill('Account condition verification')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const child = scaffold.ctx.office.drive(local, { space: 'shared', folderId: parent.id, search: '' }).entries.find(entry => entry.name === 'Account condition verification')!
  await drive.locator(`[data-drive-entry="${child.id}"]`).click()
  await drive.getByRole('button', { name: 'Access permissions', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Access permissions', exact: true })
  for (const id of ids) expect(await dialog.getByRole('combobox', { name: `Access for Employee ${id}`, exact: true }).inputValue()).toBe('inherit')
  await dialog.getByRole('combobox', { name: 'Access for Employee constructor', exact: true }).selectOption('deny')
  await dialog.getByRole('combobox', { name: 'Access for Employee __proto__', exact: true }).selectOption('view')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const saved = scaffold.ctx.office.drive(local, { space: 'shared', folderId: parent.id, search: '' }).entries.find(entry => entry.id === child.id)!
  expect(saved.grants).toEqual([{ memberId: ids[0], access: 'deny' }, { memberId: ids[1], access: 'view' }])
  expect(scaffold.ctx.office.drive(ids[0]!, { space: 'shared', folderId: parent.id, search: '' }).entries).toEqual([])
  expect(scaffold.ctx.office.drive(ids[1]!, { space: 'shared', folderId: parent.id, search: '' }).entries[0]?.access).toBe('view')
  expect(scaffold.ctx.office.drive(ids[2]!, { space: 'shared', folderId: parent.id, search: '' }).entries[0]?.access).toBe('edit')
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})
