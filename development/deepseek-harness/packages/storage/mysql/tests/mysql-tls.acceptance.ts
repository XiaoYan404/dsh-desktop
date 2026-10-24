/** Real provider TLS with owned CA/identity verification; every physical connection is the reviewed loopback server. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import MysqlRuntime, { MysqlError } from '../src/index.ts'
import type { MysqlResult } from '../src/types.ts'
import { canonical, ownedTlsNetwork, ownedTlsTarget, text, tlsServerIdentity, tlsServerUuid,
  wrongTlsIdentity } from './fixtures/mysql-tls-owned.ts'

const repo = resolve(import.meta.dirname, '../../../..')
const receiptIdentities = [
  ['1', 'r7-initial-20-tables', '4f897d35c8472182eaaab3117d313f382e078d7f4f8288a35bb9b24f708e9be9'],
  ['2', 'json-safe-integers', '94e5c1d36047cd6a0c43d3d00d0e44af38d2c896e352d39b8ee7a56e83ce6a07'],
]
type Case = 'valid' | 'wrong-ca' | 'wrong-identity'

function rows(result: MysqlResult) {
  if (result.kind !== 'rows') throw new Error('A read-only TLS statement unexpectedly returned write metadata.')
  return result.rows
}
function first(result: MysqlResult) {
  const row = rows(result)[0]
  if (!row) throw new Error('The read-only TLS statement returned no metadata.')
  return row
}
async function receiptSnapshot(mysql: MysqlRuntime) {
  return rows(await mysql.execute(
    'SELECT schema_version,migration_name,HEX(script_sha256) AS checksum,applied_at FROM dsh_schema_migrations ORDER BY schema_version', []))
}

async function exercise(mode: Case): Promise<void> {
  const runId = randomUUID().replaceAll('-', '')
  const failures: unknown[] = []
  let home: string | undefined
  let ctx: Context | undefined
  let network: ReturnType<typeof ownedTlsNetwork> | undefined
  let evidence: Record<string, unknown> | undefined
  try {
    const target = await ownedTlsTarget(repo)
    home = await mkdtemp(resolve(repo, '../.local-run/enterprise-mysql-tls-owned-'))
    let caFile = target.caFile
    if (mode === 'wrong-ca') {
      caFile = join(home, 'unrelated-public-ca.pem')
      await writeFile(caFile, target.unrelatedPem, { flag: 'wx' })
    }
    network = ownedTlsNetwork()
    ctx = new Context()
    await ctx.plugin(CredentialsLocal, { dshHome: home, watch: false })
    const ref = 'MYSQL_TLS_' + runId.toUpperCase()
    await target.seedCredential(ctx, ref)
    const host = mode === 'wrong-identity' ? wrongTlsIdentity : tlsServerIdentity
    const activation = await ctx.plugin(MysqlRuntime, target.config(host, caFile, ref)).then(
      () => ({ ok: true } as const), (error: unknown) => ({ error }),
    )
    evidence = { case: mode, hostIdentity: host, physicalHost: '127.0.0.1', port: 11406, expectedServerUuid: tlsServerUuid,
      schemaMode: 'verify', readOnlyStatements: true, ddl: false, dml: false,
      publicCertificates: target.publicEvidence,
      identityScope: 'DNS certificate identity mapped only in this test process; literal IP SAN verification is not claimed',
      forcedVerification: { rejectUnauthorized: true, verifyIdentity: true, minimumVersion: 'TLSv1.2' } }
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
      const before = await receiptSnapshot(mysql)
      expect(before.map(row => [String(row['schema_version']), text(row['migration_name']), text(row['checksum']).toLowerCase()]))
        .toEqual(receiptIdentities)
      const cipher = text(first(await mysql.execute("SHOW SESSION STATUS LIKE 'Ssl_cipher'", []))['Value'])
      const version = text(first(await mysql.execute("SHOW SESSION STATUS LIKE 'Ssl_version'", []))['Value'])
      expect(['TLSv1.2', 'TLSv1.3']).toContain(version)
      expect(cipher).toMatch(/^[A-Za-z0-9_-]+$/u)
      expect(await receiptSnapshot(mysql)).toEqual(before)
      evidence = { ...evidence, actualServerUuid: identity['uuid'], actualVersion: identity['version'],
        tlsVersion: version, tlsCipher: cipher, schemaReceiptsUnchanged: true, activation: 'accepted' }
    } else {
      if (!('error' in activation)) throw new Error('The actual MySQL provider accepted invalid TLS trust or identity.')
      const error = activation.error
      if (!(error instanceof MysqlError)) throw error
      target.assertSafeDiagnostic(error)
      expect(error).toMatchObject({ code: 'statement_failed', driverCode: 'HANDSHAKE_SSL_ERROR', outcome: 'not-started', retryable: false })
      expect(ctx.get('mysql')).toBeUndefined()
      evidence = { ...evidence, activation: 'rejected-before-service-publication',
        failure: { code: error.code, driverCode: error.driverCode, outcome: error.outcome, retryable: error.retryable } }
    }
    expect(network.stats()).toMatchObject({ lookupCalls: 1, rejectedLookups: 0, sockets: 1, connected: 1 })
  } catch (error) { failures.push(error) }
  const clean = async (work: () => Promise<unknown>): Promise<void> => {
    try { await work() } catch (error) { failures.push(error) }
  }
  if (ctx) await clean(() => ctx.fiber.dispose())
  if (network) await clean(() => network.close())
  const ownedHome = home
  if (ownedHome) await clean(async () => {
    if (dirname(ownedHome) !== resolve(repo, '../.local-run') || !basename(ownedHome).startsWith('enterprise-mysql-tls-owned-')) {
      throw new Error('Unexpected owned TLS home; recursive cleanup refused.')
    }
    await rm(ownedHome, { recursive: true, force: true })
  })
  if (failures.length > 1) throw new AggregateError(failures, 'The TLS case retained its scenario and cleanup failures.')
  if (failures.length === 1) throw failures[0]
  if (!evidence || !network) throw new Error('The TLS case completed without owned evidence.')
  expect(network.stats()).toMatchObject({ sockets: 1, connected: 1, closed: 1, dnsRestored: true })
  const artifact = resolve(repo, '../.local-run/enterprise-mysql-tls-' + mode + '-' + runId + '.json')
  await writeFile(artifact, JSON.stringify({ ...evidence, network: network.stats(), cleanupCompleted: true }, null, 2) + '\n', { flag: 'wx' })
  console.log('Owned MySQL TLS evidence: ' + basename(artifact))
}

it('accepts the owned MySQL TLS CA and explicit server certificate identity', () => exercise('valid'))
it('rejects an unrelated CA during the real owned MySQL TLS handshake', () => exercise('wrong-ca'))
it('rejects the wrong server identity during the real owned MySQL TLS handshake', () => exercise('wrong-identity'))
