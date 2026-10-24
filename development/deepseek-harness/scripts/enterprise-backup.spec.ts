/** Restore real Office identity/invitations/ACLs and an appendable Native log through the Loader. */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as Json from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import Office from '@deepseek-ai/dsh-enterprise-office'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { meta, oneTurnLog } from '../packages/session/session-persistence/tests/contract.ts'
import { createMemberInviteFixture, issueFixtureMemberInvite, inviteAdmin, inviteTarget, invitePeer,
  invitePassword, invitePolicy } from '../packages/enterprise/office/tests/member-invite-fixture.ts'
import { backupDiagnostics, createBackup, restoreBackup, runBackup, verifyBackup } from './enterprise-backup.ts'

async function ownedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-backup-'))
  onTestFinished(async () => {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-backup-')) throw new Error('Unexpected backup fixture')
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  return root
}

async function restoredOffice(home: string): Promise<Context> {
  const path = join(home, 'restore-loader.yml')
  await writeFile(path, JSON.stringify([
    { name: 'cordis:storage' }, { name: 'cordis:json', config: { root: join(home, 'data') } },
    { name: 'cordis:domain', config: { backend: 'json' } },
    { name: 'cordis:office', config: { companyName: 'Invitations fixture', timeZone: 'Asia/Shanghai', dshHome: home,
      members: [inviteAdmin, inviteTarget, invitePeer].map(id => ({ id, name: id, department: 'Office', jobTitle: 'Member',
        role: id === inviteAdmin ? 'admin' : 'employee' })), memberInvites: invitePolicy } },
    { name: 'cordis:jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
  ]))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, storage: Storage, json: Json, domain: Domain, office: Office, jsonl: Jsonl })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  if (!ctx.get('office') || !ctx.get('sessionPersistence')) throw new Error('Restored Loader services missing')
  return ctx
}

it('restores identity and invitation consistency, exact Drive bytes and ACLs, then continues the original Native session', async () => {
  const target = await ownedRoot()
  const { ctx, root: home } = await createMemberInviteFixture()
  const issued = await issueFixtureMemberInvite(ctx)
  const bytes = Buffer.from('真实备份与恢复附件\0原始字节')
  const file = await ctx.office.uploadDriveFile(inviteAdmin, { space: 'private', folderId: null, name: '恢复材料.bin',
    requestId: randomUUID(), mediaType: 'application/octet-stream', byteLength: bytes.length, dataBase64: bytes.toString('base64') })
  await ctx.plugin(Jsonl, { root: join(home, 'sessions'), compression: 'none' })
  const header = meta('restored-native')
  const handle = await ctx.sessionPersistence.create(header)
  const log = oneTurnLog()
  await handle.append(log)
  await handle.close()
  await mkdir(join(home, 'attachments/v1'), { recursive: true })
  await writeFile(join(home, 'attachments/v1/immutable.bin'), bytes)
  await writeFile(join(home, '.credentials.yaml'), 'private-fixture-only: retained\n', { mode: 0o600 })
  await ctx.fiber.dispose()
  const oldIdentity = await readFile(join(home, 'data/enterprise_office_identity.json'))
  const backup = join(target, 'backup')
  const summary = await createBackup({ roots: [{ id: 'home', path: home }], output: backup, provider: 'local', quiescent: true })
  expect(summary.files).toBeGreaterThan(5)
  expect(await verifyBackup(backup)).toEqual(summary)
  const restored = join(target, 'restored')
  await restoreBackup(backup, restored)
  const restoredHome = join(restored, 'home')
  expect(await readFile(join(restoredHome, 'attachments/v1/immutable.bin'))).toEqual(bytes)
  expect(await readFile(join(restoredHome, '.credentials.yaml'), 'utf8')).toBe('private-fixture-only: retained\n')
  const next = await restoredOffice(restoredHome)
  expect((await next.office.login({ memberId: inviteAdmin, password: invitePassword })).member.id).toBe(inviteAdmin)
  expect(await next.office.acceptMemberInvite({ code: issued.code, newPassword: 'Restored employee chooses a first password!' }))
    .toEqual({ memberId: inviteTarget })
  await expect(next.office.acceptMemberInvite({ code: issued.code, newPassword: 'Restored employee chooses a first password!' }))
    .rejects.toMatchObject({ code: 'unauthenticated' })
  const downloaded = await next.office.downloadDriveFile(inviteAdmin, file.id)
  expect(Buffer.from(downloaded.dataBase64, 'base64')).toEqual(bytes)
  await expect(next.office.downloadDriveFile(invitePeer, file.id)).rejects.toMatchObject({ code: 'not_found' })
  const continued = await next.sessionPersistence.open(header.id, { access: 'write' })
  expect((await continued.read()).events).toEqual(log)
  const seq = log.length
  await continued.append([
    { type: 'turn/start', seq: SessionSeq(seq), time: 9, data: { turn: 2 } },
    { type: 'turn/end', seq: SessionSeq(seq + 1), time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
  ])
  expect((await continued.read()).events.slice(0, seq)).toEqual(log)
  expect((await continued.read()).events).toHaveLength(seq + 2)
  await continued.close()
  expect(await readFile(join(home, 'data/enterprise_office_identity.json'))).toEqual(oldIdentity)
  expect(await verifyBackup(backup)).toEqual(summary)
}, 30_000)

it('refuses existing destinations, live-writer acknowledgement omissions and MySQL without its frozen provider export', async () => {
  const root = await ownedRoot()
  const home = join(root, 'home')
  await mkdir(home)
  const options = { roots: [{ id: 'home', path: home }], output: join(root, 'backup'), provider: 'local' as const, quiescent: true }
  await expect(createBackup({ ...options, quiescent: false })).rejects.toMatchObject({ code: 'writers-must-be-stopped' })
  await expect(createBackup({ ...options, provider: 'mysql-frozen-export' })).rejects.toMatchObject({ code: 'missing-provider-export' })
  await expect(createBackup({ ...options, output: join(home, 'nested') })).rejects.toMatchObject({ code: 'overlapping-destination' })
  await createBackup(options)
  await expect(createBackup(options)).rejects.toMatchObject({ code: 'destination-exists' })
  await expect(restoreBackup(options.output, home)).rejects.toMatchObject({ code: 'destination-exists' })
})

it('detects changed payload bytes and refuses future or traversing manifests before creating a restore target', async () => {
  const root = await ownedRoot()
  const home = join(root, 'home')
  await mkdir(home)
  await writeFile(join(home, 'data.bin'), 'retained data')
  const backup = join(root, 'backup')
  await createBackup({ roots: [{ id: 'home', path: home }], output: backup, provider: 'local', quiescent: true })
  await appendFile(join(backup, 'roots/home/data.bin'), 'corruption')
  await expect(restoreBackup(backup, join(root, 'restore'))).rejects.toMatchObject({ code: 'payload-mismatch' })
  const original = await readFile(join(backup, 'manifest.json'), 'utf8')
  for (const contents of [original.replace('"version": 1', '"version": 2'), original.replace('"path": "data.bin"', '"path": "../escape"')]) {
    await writeFile(join(backup, 'manifest.json'), contents)
    await writeFile(join(backup, 'COMPLETE'), createHash('sha256').update(contents).digest('hex') + '\n')
    await expect(restoreBackup(backup, join(root, 'restore'))).rejects.toThrow()
  }
  expect(await readFile(join(home, 'data.bin'), 'utf8')).toBe('retained data')
})

it('reports only capacity and counts and keeps secrets and paths out of operational failures', async () => {
  const root = await ownedRoot()
  await writeFile(join(root, 'confidential.log'), 'token=private\nbody=secret')
  const report = await backupDiagnostics(root)
  expect(report.files).toBe(1)
  expect(report.availableBytes).toBeGreaterThan(0)
  expect(JSON.stringify(report)).not.toMatch(/token|private|secret|confidential/u)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    expect(await runBackup(['verify', '--backup', join(root, 'secret-password')])).toBe(1)
    expect(stderr).toHaveBeenCalledWith('{"ok":false,"code":"io-or-invalid-input"}\n')
  } finally { stderr.mockRestore() }
})

it('includes explicit external workspace directories and individual deployment configuration files without including adjacent data', async () => {
  const root = await ownedRoot()
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  await mkdir(join(workspace, 'empty'))
  await writeFile(join(workspace, 'delivery.bin'), Buffer.from([0, 255, 8]))
  await writeFile(join(root, 'deployment.yml'), 'private-configuration: fixture\n')
  await writeFile(join(root, 'unselected.bin'), 'must not be included')
  const backup = join(root, 'backup')
  const summary = await createBackup({ roots: [{ id: 'home', path: home }, { id: 'workspace', path: workspace },
    { id: 'config', path: join(root, 'deployment.yml') }], output: backup, provider: 'local', quiescent: true })
  expect(summary).toMatchObject({ roots: 3, files: 2 })
  await restoreBackup(backup, join(root, 'restore'))
  expect(await readFile(join(root, 'restore/config/deployment.yml'), 'utf8')).toBe('private-configuration: fixture\n')
  expect(await readFile(join(root, 'restore/workspace/delivery.bin'))).toEqual(Buffer.from([0, 255, 8]))
})
