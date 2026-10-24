/** Real IP dialing with an explicit TLS identity, plus configuration refusal before transport or credentials. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import MysqlRuntime, { MysqlError, type Config } from '../src/index.ts'
import type { MysqlResult } from '../src/types.ts'
import { canonical, ownedTlsTarget, text, tlsServerIdentity, tlsServerUuid, wrongTlsIdentity } from './fixtures/mysql-tls-owned.ts'
import { ownedIpTlsNetwork } from './fixtures/mysql-tls-ip-owned.ts'

const repo = resolve(import.meta.dirname, '../../../..')
type Case = 'valid' | 'wrong-name' | 'missing-name' | 'missing-ca' | 'ip-name'
const receiptIdentities = [
  ['1', 'r7-initial-20-tables', '4f897d35c8472182eaaab3117d313f382e078d7f4f8288a35bb9b24f708e9be9'],
  ['2', 'json-safe-integers', '94e5c1d36047cd6a0c43d3d00d0e44af38d2c896e352d39b8ee7a56e83ce6a07'],
]

function rows(result: MysqlResult) {
  if (result.kind !== 'rows') throw new Error('An IP/TLS read unexpectedly returned write metadata.')
  return result.rows
}
function first(result: MysqlResult) {
  const row = rows(result)[0]
  if (!row) throw new Error('An IP/TLS read returned no server metadata.')
  return row
}
async function receipts(mysql: MysqlRuntime) {
  return rows(await mysql.execute(
    'SELECT schema_version,migration_name,HEX(script_sha256) AS checksum,applied_at FROM dsh_schema_migrations ORDER BY schema_version', []))
}

async function exercise(mode: Case): Promise<void> {
  const runId = randomUUID().replaceAll('-', '')
  const failures: unknown[] = []
  let home: string | undefined
  let ctx: Context | undefined
  let network: ReturnType<typeof ownedIpTlsNetwork> | undefined
  let evidence: Record<string, unknown> | undefined
  let restoreCredentialObservation: (() => void) | undefined
  const connectedCase = mode === 'valid' || mode === 'wrong-name'
  try {
    const target = await ownedTlsTarget(repo)
    home = await mkdtemp(resolve(repo, '../.local-run/enterprise-mysql-ip-tls-owned-'))
    network = ownedIpTlsNetwork()
    ctx = new Context()
    await ctx.plugin(CredentialsLocal, { dshHome: home, watch: false })
    const ref = 'MYSQL_IP_TLS_' + runId.toUpperCase()
    await target.seedCredential(ctx, ref)
    const resolution = vi.spyOn(ctx.credentials, 'resolve')
    restoreCredentialObservation = () => { resolution.mockRestore() }
    const config: Partial<Config> = { ...target.config('127.0.0.1', target.caFile, ref) }
    if (mode !== 'missing-name') config.tlsServerName = mode === 'wrong-name' ? wrongTlsIdentity : tlsServerIdentity
    if (mode === 'missing-ca') delete config.tlsCAFile
    if (mode === 'ip-name') config.tlsServerName = '127.0.0.1'
    const activation = await ctx.plugin(MysqlRuntime, config).then(
      () => ({ ok: true } as const), (error: unknown) => ({ error }),
    )
    evidence = { case: mode, physicalHost: '127.0.0.1', physicalPort: 11406,
      explicitCertificateIdentity: config.tlsServerName ?? null, expectedServerUuid: tlsServerUuid,
      schemaMode: 'verify', publicCertificates: target.publicEvidence,
      globalDnsLookupReplacement: false, certificateCheckerReplacement: false, ddl: false, dml: false,
      mechanism: 'public mysql2 stream factory; public node:net.createConnection; original driver CA/SNI/identity verification',
      directIpSanVerification: 'unsupported-and-explicitly-refused' }
    if (mode === 'valid') {
      if ('error' in activation) throw activation.error
      const mysql = ctx.mysql
      expect(mysql.status()).toMatchObject({ version: 2, migrationName: 'json-safe-integers', tableCount: 20, foreignKeyCount: 25 })
      const identity = first(await mysql.execute(
        'SELECT @@GLOBAL.server_uuid AS uuid,@@GLOBAL.datadir AS dataDir,VERSION() AS version,DATABASE() AS db', []))
      expect(identity['uuid']).toBe(tlsServerUuid)
      expect(identity['version']).toBe('8.4.11')
      expect(identity['db']).toBe('dsh_round144_834f9e84adbd40ca95b4a3e9efb8f0ce')
      expect(canonical(text(identity['dataDir']))).toBe(target.dataDir)
      const before = await receipts(mysql)
      expect(before.map(row => [String(row['schema_version']), text(row['migration_name']), text(row['checksum']).toLowerCase()]))
        .toEqual(receiptIdentities)
      const cipher = text(first(await mysql.execute("SHOW SESSION STATUS LIKE 'Ssl_cipher'", []))['Value'])
      const version = text(first(await mysql.execute("SHOW SESSION STATUS LIKE 'Ssl_version'", []))['Value'])
      expect(['TLSv1.2', 'TLSv1.3']).toContain(version)
      expect(cipher).toMatch(/^[A-Za-z0-9_-]+$/u)
      expect(await receipts(mysql)).toEqual(before)
      evidence = { ...evidence, activation: 'accepted', actualServerUuid: identity['uuid'], tlsVersion: version,
        tlsCipher: cipher, schemaReceiptsUnchanged: true }
    } else {
      if (!('error' in activation)) throw new Error('Invalid IP/TLS configuration or identity activated the service.')
      const error = activation.error
      if (!(error instanceof MysqlError)) throw error
      target.assertSafeDiagnostic(error)
      if (mode === 'wrong-name') {
        expect(error).toMatchObject({ code: 'statement_failed', driverCode: 'HANDSHAKE_SSL_ERROR', outcome: 'not-started' })
      } else {
        expect(error).toMatchObject({ code: 'configuration', outcome: 'not-started', retryable: false })
        expect(error.driverCode).toBeUndefined()
        expect(resolution).not.toHaveBeenCalled()
      }
      expect(ctx.get('mysql')).toBeUndefined()
      evidence = { ...evidence, activation: connectedCase ? 'rejected-during-TLS-handshake' : 'rejected-before-credential-and-transport',
        failure: { code: error.code, driverCode: error.driverCode ?? null, outcome: error.outcome, retryable: error.retryable } }
    }
    expect(resolution.mock.calls.length).toBe(connectedCase ? 1 : 0)
    expect(network.stats()).toMatchObject({ sockets: connectedCase ? 1 : 0, connected: connectedCase ? 1 : 0,
      globalDnsLookupUntouched: true })
    evidence = { ...evidence, credentialResolutions: resolution.mock.calls.length }
  } catch (error) { failures.push(error) }
  const clean = async (work: () => Promise<unknown>): Promise<void> => {
    try { await work() } catch (error) { failures.push(error) }
  }
  if (ctx) await clean(() => ctx.fiber.dispose())
  if (network) await clean(() => network.close())
  try { restoreCredentialObservation?.() } catch (error) { failures.push(error) }
  const ownedHome = home
  if (ownedHome) await clean(async () => {
    if (dirname(ownedHome) !== resolve(repo, '../.local-run') || !basename(ownedHome).startsWith('enterprise-mysql-ip-tls-owned-')) {
      throw new Error('Unexpected owned IP/TLS home; recursive cleanup refused.')
    }
    await rm(ownedHome, { recursive: true, force: true })
  })
  if (failures.length > 1) throw new AggregateError(failures, 'IP/TLS scenario and cleanup failures were retained.')
  if (failures.length === 1) throw failures[0]
  if (!evidence || !network) throw new Error('The IP/TLS case completed without owned evidence.')
  expect(network.stats()).toMatchObject({ sockets: connectedCase ? 1 : 0, closed: connectedCase ? 1 : 0,
    globalDnsLookupUntouched: true })
  const artifact = resolve(repo, '../.local-run/enterprise-mysql-ip-tls-' + mode + '-' + runId + '.json')
  await writeFile(artifact, JSON.stringify({ ...evidence, network: network.stats(), cleanupCompleted: true }, null, 2) + '\n', { flag: 'wx' })
  console.log('Owned MySQL IP/TLS evidence: ' + basename(artifact))
}

it('verifies an explicit certificate identity while dialing the owned MySQL IP without DNS replacement', () => exercise('valid'))
it('rejects a wrong explicit identity on the real owned MySQL IP TLS connection', () => exercise('wrong-name'))
it('rejects IP TLS without an explicit name before credentials or transport', () => exercise('missing-name'))
it('rejects an explicit TLS name without a CA before credentials or transport', () => exercise('missing-ca'))
it('rejects an IP used as the explicit TLS name before credentials or transport', () => exercise('ip-name'))
