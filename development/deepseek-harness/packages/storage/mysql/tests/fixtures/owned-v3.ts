/** Successor of the reviewed owned-instance fixture; database-scoped credentials and exact target checks only. */
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createConnection } from 'mysql2/promise'
import type { Connection, RowDataPacket } from 'mysql2/promise'

const uuid = '81698848-cb10-11f1-900d-30560fa55c04'
const database = 'dsh_round144_834f9e84adbd40ca95b4a3e9efb8f0ce'

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length) throw new Error('A required owned target field is absent; contents omitted.')
  return value
}
function canonical(path: string): string {
  const value = realpathSync.native(path).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? value.toLowerCase() : value
}
function contained(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)
}
async function object(path: string): Promise<Record<string, unknown>> {
  let value: unknown
  try { value = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')) }
  catch (_error) { throw new Error('The owned target descriptor is unreadable; contents omitted.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid owned target descriptor.')
  return value as Record<string, unknown>
}

/** Reuse the single reviewed fixture instance without provisioning stores, modifying schema, or changing old evidence.
 * @param repo - Repository whose sibling .local-run contains the owned fixture.
 * @returns Owned database-level connection and credential inputs; callers must never log the returned object.
 */
export async function ownedV3Target(repo: string): Promise<{
  connection: Connection
  database: string
  user: string
  password: string
  canonicalDataDir: string
}> {
  const descriptor = process.env['DSH_MYSQL_TEST_INSTANCE']
  if (!descriptor) throw new Error('DSH_MYSQL_TEST_INSTANCE is required; no database was contacted.')
  const ready = await object(resolve(descriptor))
  const privatePath = text(ready['privateConnectionFile'])
  const instance = canonical(dirname(privatePath))
  if (!contained(canonical(resolve(repo, '../.local-run')), instance)
    || basename(instance) !== 'enterprise-round144-mysql-instance-053f0f89f6f448d093a6821ff5858fda') throw new Error('Unreviewed fixture directory.')
  const target = await object(privatePath)
  const dataDir = canonical(text(target['dataDir']))
  if (ready['host'] !== '127.0.0.1' || target['host'] !== ready['host'] || ready['port'] !== 11406
    || target['port'] !== 11406 || target['pid'] !== ready['pid'] || ready['version'] !== '8.4.11'
    || target['database'] !== database || !contained(instance, dataDir)) throw new Error('Unreviewed owned database target.')
  const user = text(target['user']), password = text(target['password'])
  if (user.toLowerCase() === 'root') throw new Error('The reviewed database-level account is required.')
  const connection = await createConnection({ host: '127.0.0.1', port: 11406, database, user, password,
    charset: 'utf8mb4', jsonStrings: true, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    timezone: 'Z', multipleStatements: false, connectTimeout: 5000 })
  try {
    const [identity] = await connection.execute<RowDataPacket[]>(
      'SELECT @@GLOBAL.server_uuid AS uuid,@@GLOBAL.datadir AS dataDir,VERSION() AS version,DATABASE() AS db')
    const actual = identity[0]
    if (!actual || actual['uuid'] !== uuid || actual['version'] !== '8.4.11' || actual['db'] !== database
      || canonical(text(actual['dataDir'])) !== dataDir) throw new Error('The connected server differs from the reviewed fixture.')
    await connection.query('SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin')
    await connection.query("SET time_zone='+00:00'")
    await connection.query("SET SESSION sql_mode='STRICT_TRANS_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'")
    return { connection, database, user, password, canonicalDataDir: dataDir }
  } catch (error) {
    try { await connection.end() } catch (closeError) { throw new AggregateError([error, closeError], 'Owned setup and cleanup failed.') }
    throw error
  }
}
