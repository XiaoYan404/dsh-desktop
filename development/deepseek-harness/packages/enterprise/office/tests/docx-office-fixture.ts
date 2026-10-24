/** Real office authority rows extend an existing Loader without sharing external data or runtime mocks. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import OfficeService from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { OfficeMemberId } from '../src/types.ts'

/** Current authenticated employee in isolated DOCX authority fixtures. */
export const docxEmployee = 'docx-employee' as OfficeMemberId
/** Administrator owns only the fixture's temporary company and files. */
export const docxAdministrator = 'docx-administrator' as OfficeMemberId

/**
 * Mount actual domain storage and office service from an isolated cordis.yml.
 * @param ctx - Running native fixture with the real Loader.
 * @param root - Owned temporary directory within that fixture.
 * @param config - Optional deployment overrides for focused authorization and resource tests.
 * @returns Completion after current office authority has activated.
 */
export async function installDocxFixtureOffice(ctx: Context, root: string, config: Partial<Config> = {}): Promise<void> {
  await mkdir(root, { recursive: true })
  Object.assign(ctx.loader.builtins, { docxStorage: Storage, docxJson: StorageJson, docxDomain: StorageDomain, docxOffice: OfficeService })
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { name: 'cordis:docxStorage' },
    { name: 'cordis:docxJson', config: { root: join(root, 'data') } },
    { name: 'cordis:docxDomain', config: { backend: 'json' } },
    { name: 'cordis:docxOffice', config: { companyName: 'Word fixture company', timeZone: 'Asia/Shanghai', dshHome: root,
      members: [docxAdministrator, docxEmployee].map(id => ({ id, name: id, department: 'Office', jobTitle: 'Member',
        role: id === docxAdministrator ? 'admin' : 'employee' })), ...config } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  if (!ctx.get('office')) throw new Error('Submitted Word authority did not activate')
}
