/** Strictly owned corpus namespace and a separate SQL connection restricted to read-only transactions. */
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createConnection, type RowDataPacket } from 'mysql2/promise'

/** Exact administrator-reviewed instance; no discovery of other database services occurs. */
export const corpusServerUuid = '81698848-cb10-11f1-900d-30560fa55c04'
const database = 'dsh_round144_834f9e84adbd40ca95b4a3e9efb8f0ce'
const receiptIdentities = [
  ['1', 'r7-initial-20-tables', '4f897d35c8472182eaaab3117d313f382e078d7f4f8288a35bb9b24f708e9be9'],
  ['2', 'json-safe-integers', '94e5c1d36047cd6a0c43d3d00d0e44af38d2c896e352d39b8ee7a56e83ce6a07'],
]

/** Admit an object from this test's external descriptor/evidence boundary. */
export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
/** Admit a required descriptor or SQL text field without disclosing its value on failure. */
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length) throw new Error('A required owned corpus field is absent.')
  return value
}
/** Read one caller-owned JSON object; parser failures omit the potentially private source. */
export async function json(path: string): Promise<Record<string, unknown>> {
  const source = await readFile(path, 'utf8')
  let value: unknown
  try { value = JSON.parse(source.replace(/^\uFEFF/u, '')) }
  catch (_error) { throw new Error('Invalid owned corpus JSON; contents omitted.') }
  if (!object(value)) throw new Error('Expected an owned corpus object.')
  return value
}
/** Resolve Windows long/short aliases and harmless trailing separators consistently. */
export function canonical(path: string): string {
  const result = realpathSync.native(path).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? result.toLowerCase() : result
}
function contained(parent: string, child: string): boolean {
  const result = relative(parent, child)
  return !isAbsolute(result) && result !== '..' && !result.startsWith('..' + sep)
}

/**
 * Verify the single approved server, provision one new corpus-* store, and turn its observer read-only.
 * @param repo - repository root whose sibling .local-run owns the descriptor.
 * @returns isolated namespace, safe connection config, credential materializers, and owned SQL observer.
 */
export async function ownedCorpusInstance(repo: string) {
  const descriptor = process.env['DSH_MYSQL_TEST_INSTANCE']
  if (!descriptor) throw new Error('DSH_MYSQL_TEST_INSTANCE is required; no database was contacted.')
  const ready = await json(resolve(descriptor))
  const privatePath = text(ready['privateConnectionFile'])
  const instance = canonical(dirname(privatePath))
  if (!contained(canonical(resolve(repo, '../.local-run')), instance)
    || basename(instance) !== 'enterprise-round144-mysql-instance-053f0f89f6f448d093a6821ff5858fda') {
    throw new Error('The corpus fixture refuses a different instance directory.')
  }
  const target = await json(privatePath)
  const dataDir = canonical(text(target['dataDir']))
  if (ready['host'] !== '127.0.0.1' || target['host'] !== ready['host'] || ready['port'] !== 11406
    || target['port'] !== 11406 || target['pid'] !== ready['pid'] || ready['version'] !== '8.4.11'
    || target['database'] !== database || !contained(instance, dataDir)) throw new Error('Unreviewed corpus database target.')
  const user = text(target['user']), password = text(target['password'])
  if (user.toLowerCase() === 'root') throw new Error('The corpus fixture requires its database-scoped account.')
  const observer = await createConnection({ host: '127.0.0.1', port: 11406, database, user, password,
    charset: 'utf8mb4', jsonStrings: true, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    timezone: 'Z', multipleStatements: false, connectTimeout: 5000 })
  try {
    const [identity] = await observer.execute<RowDataPacket[]>(
      'SELECT @@GLOBAL.server_uuid AS uuid,@@GLOBAL.datadir AS dataDir,VERSION() AS version,DATABASE() AS db')
    const actual = identity[0]
    if (!actual || actual['uuid'] !== corpusServerUuid || actual['version'] !== '8.4.11' || actual['db'] !== database
      || canonical(text(actual['dataDir'])) !== dataDir) throw new Error('The actual corpus server differs from the reviewed instance.')
    const receipts = async () => {
      const [rows] = await observer.execute<RowDataPacket[]>(
        'SELECT schema_version,migration_name,HEX(script_sha256) AS checksum,applied_at FROM dsh_schema_migrations ORDER BY schema_version')
      return rows
    }
    const before = await receipts()
    const identities = before.map(row => [String(row['schema_version']), text(row['migration_name']), text(row['checksum']).toLowerCase()])
    if (JSON.stringify(identities) !== JSON.stringify(receiptIdentities)) throw new Error('The corpus requires the two unchanged reviewed schema receipts.')
    const storeKey = 'corpus-' + randomUUID().replaceAll('-', '')
    await observer.execute('INSERT INTO dsh_stores (store_key,display_name,search_config_json) VALUES (?,?,?)',
      [storeKey, 'Owned seven-wait Native corpus', JSON.stringify({ ngramTokenSize: 2, stopwords: false, extractorVersion: 1 })])
    const [stores] = await observer.execute<RowDataPacket[]>('SELECT store_id FROM dsh_stores WHERE store_key=?', [storeKey])
    const storeId = text(stores[0]?.['store_id'])
    await observer.query('SET SESSION TRANSACTION READ ONLY')
    const [readOnly] = await observer.query<RowDataPacket[]>('SELECT @@SESSION.transaction_read_only AS readOnly')
    if (Number(readOnly[0]?.['readOnly']) !== 1) throw new Error('The corpus SQL observer did not become read-only.')
    return { observer, storeKey, storeId, before, receipts,
      mysqlConfig: (ref: string) => ({ host: '127.0.0.1', port: 11406, database, user, passwordRef: ref, schemaMode: 'verify' as const }),
      seedCredential: async (ctx: Context, ref: string): Promise<void> => { await ctx.credentials.set(credentialRef(ref), password) },
      environment: (): NodeJS.ProcessEnv => ({ DSH_MYSQL_HOST: '127.0.0.1', DSH_MYSQL_PORT: '11406',
        DSH_MYSQL_DATABASE: database, DSH_MYSQL_USER: user, DSH_MYSQL_PASSWORD: password, DSH_MYSQL_STORE_KEY: storeKey }),
    }
  } catch (error) {
    try { await observer.end() }
    catch (closeError) { throw new AggregateError([error, closeError], 'Corpus observer setup and cleanup failed.') }
    throw error
  }
}
