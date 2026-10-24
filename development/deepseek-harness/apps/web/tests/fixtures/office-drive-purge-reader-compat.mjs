/** Actual StorageDomain readers compare supported legacy data and permanent cleanup records. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const base = pathToFileURL(join(repo, 'packages/enterprise/office/lib/types/drive-uploads.js')).href
const load = name => import(import.meta.resolve(name, base))
const { Context } = await load('@deepseek-ai/cordis')
const { default: Storage } = await load('@deepseek-ai/dsh-storage')
const StorageJson = await load('@deepseek-ai/dsh-storage-json')
const StorageDomain = await load('@deepseek-ai/dsh-storage-domain')
const { default: Office } = await load('@deepseek-ai/dsh-enterprise-office')
const { executeOfficeRequest } = await import(new URL('request.js', base))
const { officeDriveDomain } = await import(new URL('drive.js', base))
const { officeDriveUploadDomain } = await import(base)
const frozenPath = new URL('./office-drive-before-purge.mjs', import.meta.url)
const digest = value => createHash('sha256').update(value).digest('hex')
const frozenSha256 = '1cca46f9bfc3f1ba896f65f2c2f65403b2a4c3d02776457437dc77fcacf2a28b'
const frozenBytes = await readFile(frozenPath)
assert.equal(digest(frozenBytes), frozenSha256, 'Do not rewrite the frozen reader')
const root = await mkdtemp(join(tmpdir(), 'dsh-office-purge-readers-'))
const live = new Context()
try {
  const relocated = frozenBytes.toString('utf8').replace(/from ["'](zod|@deepseek-ai\/dsh-brand|@deepseek-ai\/dsh-storage-domain)["']/g,
    (_match, name) => `from ${JSON.stringify(import.meta.resolve(name, base))}`)
  const oldPath = join(root, 'frozen-reader.mjs')
  await writeFile(oldPath, relocated)
  const previous = await import(pathToFileURL(oldPath).href)
  const dataRoot = join(root, 'live')
  await live.plugin(Storage)
  await live.plugin(StorageJson, { root: dataRoot })
  await live.plugin(StorageDomain, { backend: 'json' })
  await live.plugin(Office, { companyName: 'Purge reader fixture', timeZone: 'Asia/Shanghai', dshHome: root, members: [
    { id: 'admin', name: 'Administrator', department: 'Office', jobTitle: 'Administrator', role: 'admin' },
    { id: 'lin', name: 'Lin', department: 'Office', jobTitle: 'Employee', role: 'employee' },
    { id: 'chen', name: 'Chen', department: 'Office', jobTitle: 'Employee', role: 'employee' },
  ] })
  const password = 'Purge reader fixture passphrase!'
  await live.office.initializeIdentity('admin', password)
  for (const member of ['lin', 'chen']) await live.office.setIdentityPassword('admin', member, password)
  const lin = await live.office.login({ memberId: 'lin', password })
  const chen = await live.office.login({ memberId: 'chen', password })
  const request = (session, method, args) => executeOfficeRequest(live.office, session.token, { method, args })
  const original = Buffer.from('Earlier immutable version\n')
  const file = await live.office.uploadDriveFile('lin', { space: 'private', folderId: null, name: 'purge.txt', requestId: randomUUID(),
    mediaType: 'text/plain', byteLength: original.length, dataBase64: original.toString('base64') })
  const bytes = Buffer.from('Reviewed second version\0')
  const ticket = await request(lin, 'beginDriveUpload', [{ space: 'private', folderId: null, name: file.name, requestId: randomUUID(),
    mediaType: 'application/octet-stream', byteLength: bytes.length, sha256: digest(bytes), target: { id: file.id, revision: file.revision } }])
  await request(lin, 'appendDriveUpload', [{ uploadId: ticket.id, index: 0, sha256: digest(bytes), dataBase64: bytes.toString('base64') }])
  await request(lin, 'completeDriveUpload', [ticket.id])
  const history = await request(lin, 'driveHistory', [file.id])
  await request(lin, 'changeDriveLifecycle', [{ id: file.id, revision: history.entry.revision, action: 'trash' }])
  const cases = [['drive', 'enterprise_office_drive', officeDriveDomain, previous.officeDriveDomain],
    ['uploads', 'enterprise_office_uploads', officeDriveUploadDomain, previous.officeDriveUploadDomain]]
  for (const [kind, name] of cases) await copyFile(join(dataRoot, `${name}.json`), join(root, `before-${kind}.json`))
  assert.equal(await request(lin, 'drivePurgeStatus', [file.id]), null)
  const before = digest(await readFile(join(dataRoot, 'enterprise_office_drive.json')))
  const plan = await request(lin, 'drivePurgePlan', [file.id])
  assert.equal(plan.versions, 2)
  assert.equal(before, digest(await readFile(join(dataRoot, 'enterprise_office_drive.json'))), 'Review must be read-only')
  await assert.rejects(request(chen, 'drivePurgePlan', [file.id]), { code: 'not_found' })
  await assert.rejects(executeOfficeRequest(live.office, chen.token,
    { method: 'drivePurgePlan', args: [file.id], actorId: 'lin' }), { code: 'invalid_input' })
  const input = { id: file.id, revision: plan.entry.revision, digest: plan.digest, requestId: randomUUID() }
  const receipt = await request(lin, 'purgeDrive', [input])
  assert.equal(receipt.status, 'completed')
  assert.equal(receipt.byteLength, original.length + bytes.length)
  assert.deepEqual(await request(lin, 'purgeDrive', [input]), receipt)
  assert.deepEqual(await request(lin, 'retryDrivePurge', [file.id]), receipt)
  assert.deepEqual(await request(lin, 'drivePurgeStatus', [file.id]), receipt)
  await assert.rejects(request(chen, 'drivePurgeStatus', [file.id]), { code: 'not_found' })
  for (const version of history.versions)
    await assert.rejects(readFile(join(root, 'office/drive/v1/objects', `${version.versionId}.bin`)), { code: 'ENOENT' })
  for (const [kind, name] of cases) await copyFile(join(dataRoot, `${name}.json`), join(root, `after-${kind}.json`))
  await live.fiber.dispose()
  const results = []
  for (const [kind, name, current, oldSpec] of cases) {
    for (const stage of ['before', 'after']) {
      for (const [reader, spec] of [['previous', oldSpec], ['current', current]]) {
        const ctx = new Context()
        const folder = join(root, `${kind}-${stage}-${reader}`)
        await mkdir(folder)
        const target = join(folder, `${name}.json`)
        await copyFile(join(root, `${stage}-${kind}.json`), target)
        const before = digest(await readFile(target))
        let domain
        const result = { kind, stage, reader, ok: false }
        try {
          await ctx.plugin(Storage)
          await ctx.plugin(StorageJson, { root: folder })
          await ctx.plugin(StorageDomain, { backend: 'json' })
          domain = await ctx.storageDomain.open(spec)
          domain.global.get()
          result.ok = true
        } catch (error) { result.code = error?.code }
        finally { await domain?.close(); await ctx.fiber.dispose() }
        result.unchanged = before === digest(await readFile(target))
        results.push(result)
      }
    }
  }
  const ok = results.every(item => item.unchanged && (item.kind === 'drive' && item.stage === 'after' && item.reader === 'previous'
    ? !item.ok && item.code === 'invalid-record' : item.ok))
  const report = { ok, frozenSha256, authenticatedRequests: true, reviewReadOnly: true,
    ownerBoundary: true, claimedActorRejected: true, exactRetry: true, opaqueObjectsRemoved: true, results }
  await writeFile(join(repo, '.artifacts/enterprise-office/round124-purge-reader-comparison.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  assert.equal(ok, true)
} finally {
  await live.fiber.dispose()
  const absolute = resolve(root)
  if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-purge-readers-'))
    throw new Error('Unexpected purge reader fixture directory')
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
