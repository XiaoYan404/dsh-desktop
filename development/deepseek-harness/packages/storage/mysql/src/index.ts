/** Opt-in MySQL transport and R7 initialization; existing storage and Session providers remain independent. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import { readFile } from 'node:fs/promises'
import { createConnection as createTcpConnection, isIP } from 'node:net'
import { Duplex } from 'node:stream'
import { createPool } from 'mysql2/promise'
import type { Pool, PoolConnection, PoolOptions, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { MysqlError, mysqlFailure } from './error.ts'
import { prepareMysqlSchema } from './schema.ts'
import { MysqlConsumerScope } from './consumer.ts'
import type { MysqlCommitOutcome, MysqlConsumer, MysqlExecutor, MysqlParameter, MysqlResult, MysqlSchemaStatus } from './types.ts'

export { MysqlError } from './error.ts'
export { MYSQL_SCHEMA_VERSION, MYSQL_MIGRATION_NAME } from './schema.ts'
export type { MysqlClient, MysqlConsumer, MysqlCommitOutcome, MysqlErrorCode, MysqlExecutor,
  MysqlParameter, MysqlResult, MysqlRow, MysqlSchemaStatus } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { mysql: MysqlRuntime }
}

/** Explicit endpoint and credential reference; no URL or literal password is accepted. */
export interface Config {
  /** Explicit hostname or IP address, without a URL, credentials or path. */
  host: string
  /** Explicit TCP port; no ambient 3306 fallback. */
  port: number
  /** Existing approved database; this plugin never creates a database or issues USE. */
  database: string
  /** Database account scoped by the deployment administrator. */
  user: string
  /** Host credential reference; the value is resolved once during activation and never logged. */
  passwordRef: string
  /** Verify the latest schema by default; initialize an empty database or explicitly upgrade the complete v1. */
  schemaMode: 'verify' | 'initialize' | 'upgrade'
  /** Maximum simultaneously accepted operations; excess work rejects instead of waiting in an unbounded queue. */
  connectionLimit: number
  /** Bound for driver connection acquisition; cancellation is rechecked after acquisition. */
  connectTimeoutMs: number
  /** Complete deadline after acquisition, including session setup, transaction callback and COMMIT. */
  operationTimeoutMs: number
  /** Activation-only schema verification, initialization or upgrade deadline after acquisition. */
  schemaTimeoutMs: number
  /** MySQL advisory-lock wait, additionally bounded by schemaTimeoutMs. */
  migrationLockTimeoutSeconds: number
  /** Prepared-statement cache bound per physical connection. */
  maxPreparedStatements: number
  /** Optional PEM CA enables certificate verification; a literal IP endpoint requires tlsServerName. */
  tlsCAFile?: string
  /** Expected DNS/CN certificate identity when dialing another host or an IP; requires tlsCAFile. */
  tlsServerName?: string
}

/** Validated deployment settings and bounded driver resources. */
export const Config: z<Partial<Config>, Config> = z.object({
  host: z.string().pattern(/^[A-Za-z0-9_.:-]+$/).required(), port: z.number().step(1).min(1).max(65535).required(),
  database: z.string().pattern(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).required(), user: z.string().min(1).required(),
  passwordRef: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).role('credential-ref').required(),
  schemaMode: z.union(['verify', 'initialize', 'upgrade']).default('verify'),
  connectionLimit: z.number().step(1).min(1).max(100).default(4),
  connectTimeoutMs: z.number().step(1).min(100).max(120000).default(5000),
  operationTimeoutMs: z.number().step(1).min(100).max(600000).default(15000),
  schemaTimeoutMs: z.number().step(1).min(100).max(600000).default(120000),
  migrationLockTimeoutSeconds: z.number().step(1).min(0).max(300).default(30),
  maxPreparedStatements: z.number().step(1).min(1).max(10000).default(128),
  tlsCAFile: z.string(),
  tlsServerName: z.string().min(1).max(253).pattern(/^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/),
})

const STRICT_MODE = 'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'

interface OwnedConnection {
  connection: PoolConnection
  signal: AbortSignal
  phase: 'ordinary' | 'working' | 'committing' | 'committed'
  active: boolean
  execute: MysqlExecutor['execute']
  consumer: MysqlConsumerScope | undefined
}

/** Convert values at the wire boundary without lossy BIGINT coercion or retaining caller-owned buffers. */
function parameters(values: readonly MysqlParameter[]): Array<null | string | number | boolean | Buffer | Date> {
  return values.map((value) => {
    if (typeof value === 'bigint') return value.toString()
    if (value instanceof Uint8Array) return Buffer.from(value)
    if (value instanceof Date) return new Date(value.getTime())
    if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
      throw new MysqlError('configuration', 'Unsafe numeric MySQL parameter. Pass large integers as bigint or decimal text before sending them.')
    }
    return value
  })
}

function result(value: RowDataPacket[] | ResultSetHeader): MysqlResult {
  if (Array.isArray(value)) return { kind: 'rows', rows: value }
  const insertId: unknown = value.insertId
  if ((typeof insertId !== 'number' && typeof insertId !== 'string') ||
    (typeof insertId === 'number' && !Number.isSafeInteger(insertId))) {
    throw new MysqlError('driver_incompatible', 'MySQL returned unsafe insert metadata. Stop dependent work and inspect the driver configuration.', 'unknown')
  }
  return { kind: 'write', affectedRows: value.affectedRows, insertId: String(insertId), warningStatus: value.warningStatus }
}

/** mysql2's graceful destroy queues socket EOF; active cancellation requires closing its actual transport. */
function transport(connection: PoolConnection): Duplex {
  const raw: unknown = Reflect.get(connection, 'connection')
  if (typeof raw !== 'object' || raw === null || !('stream' in raw) || !(raw.stream instanceof Duplex)) {
    throw new MysqlError('driver_incompatible', 'The installed mysql2 driver does not expose the supported connection transport. Use the package\'s pinned driver version.')
  }
  return raw.stream
}

async function discard(stream: Duplex): Promise<void> {
  if (stream.closed) return
  const closed = new Promise<void>((done) => { stream.once('close', done) })
  stream.destroy()
  await closed
}

/** Pooled prepared statements and explicit transactions with connection-owned cancellation and no automatic retries. */
export default class MysqlRuntime extends Service {
  static inject = ['credentials']
  static Config = Config
  private pool: Pool | undefined
  private readonly lifetime = new AbortController()
  private readonly ordinaryLifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly consumers = new Set<MysqlConsumerScope>()
  private closing: Promise<void> | undefined
  private schema: MysqlSchemaStatus | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'mysql')
    ctx.effect(() => () => this.closeOwner())
  }

  /** Register a producer/queue owner whose accepted SQL must finish before the pool closes.
   * The caller's ctx.effect owns release. Its drain must synchronously fence new business work,
   * settle producers and queues, and must not await this scope's disposal or connection unload.
   * @param drain - Current consumer's idempotent shutdown, using the returned scope for SQL.
   * @returns SQL retained through that drain, plus its memoized disposal; failures remain rejections.
   */
  registerConsumer(drain: () => Promise<void>): MysqlConsumer {
    this.checkLifetime()
    if (!this.pool) throw new MysqlError('closed', 'The MySQL connection owner is not active.', 'not-started')
    const scope: MysqlConsumerScope = new MysqlConsumerScope({
      execute: (sql, values, signal) => {
        const bound = parameters(values)
        return this.run(owned => owned.execute(sql, bound), signal, undefined, scope)
      },
      transaction: (work, signal) => this.transact(work, signal, scope),
    }, drain, () => { this.consumers.delete(scope) })
    this.consumers.add(scope)
    try { this.ctx.effect(() => () => scope.dispose(), 'mysql.consumer()') }
    catch (error) { this.consumers.delete(scope); throw error }
    return scope
  }

  private closeOwner(): Promise<void> {
    if (this.closing) return this.closing
    const settled = Promise.withResolvers<void>()
    this.closing = settled.promise
    this.ordinaryLifetime.abort()
    const drained = Promise.allSettled([...this.consumers].map(consumer => consumer.dispose()))
    void (async () => {
      const failures: unknown[] = []
      for (const result of await drained) {
        if (result.status === 'rejected') { const error: unknown = result.reason; failures.push(error) }
      }
      this.lifetime.abort()
      await Promise.allSettled([...this.pending])
      if (this.pool) {
        try { await this.pool.end() } catch (error) { failures.push(mysqlFailure(error)) }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'MySQL connection shutdown failed after draining consumers and closing the pool.')
    })().then(settled.resolve, settled.reject)
    return this.closing
  }

  protected async [Service.init](): Promise<void> {
    const tlsServerName = this.config.tlsServerName
    if (tlsServerName !== undefined && !this.config.tlsCAFile) {
      throw new MysqlError('configuration', 'MySQL tlsServerName requires a TLS CA file; configure tlsCAFile before enabling a certificate identity.', 'not-started')
    }
    if (tlsServerName !== undefined && isIP(tlsServerName) !== 0) {
      throw new MysqlError('configuration', 'MySQL tlsServerName must be a DNS/CN certificate identity. Direct IP SAN verification is not supported by this adapter.', 'not-started')
    }
    if (this.config.tlsCAFile && isIP(this.config.host) !== 0 && tlsServerName === undefined) {
      throw new MysqlError('configuration', 'MySQL TLS over a literal IP requires tlsServerName matching the server certificate DNS/CN identity; no localhost fallback is allowed.', 'not-started')
    }
    const secret = await this.ctx.credentials.resolve(credentialRef(this.config.passwordRef))
    this.checkLifetime()
    if (!secret) throw new MysqlError('credential_missing', 'The configured MySQL password reference is unavailable. Provision it in the Host credential provider before loading this plugin.', 'not-started')
    let ca: Buffer | undefined
    if (this.config.tlsCAFile) {
      try { ca = await readFile(this.config.tlsCAFile) }
      catch (_error) { throw new MysqlError('configuration', 'The configured MySQL TLS CA file is unreadable. Check its path and permissions; no insecure TLS fallback is enabled.') }
    }
    this.checkLifetime()
    const options: PoolOptions = {
      host: tlsServerName ?? this.config.host,
      port: this.config.port, database: this.config.database, user: this.config.user, password: secret.value,
      connectionLimit: this.config.connectionLimit,
      connectTimeout: this.config.connectTimeoutMs, maxPreparedStatements: this.config.maxPreparedStatements,
      waitForConnections: false, multipleStatements: false, namedPlaceholders: false,
      timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, jsonStrings: true,
      // The handshake collation is one byte; the required 0900_bin collation is applied after authentication.
      charset: 'utf8mb4',
      // Public mysql2 stream factories separate the physical dial endpoint from its verified TLS/SNI name.
      // Match the driver's ordinary TCP defaults; timeout, auth, and TLS still belong to mysql2.
      ...(tlsServerName === undefined ? {} : { stream: () => createTcpConnection({
        host: this.config.host, port: this.config.port, noDelay: true, keepAlive: true,
      }) }),
      ...(ca === undefined ? {} : { ssl: { ca, rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' as const } }),
    }
    this.pool = createPool(options)
    this.schema = await this.run(async owned => prepareMysqlSchema({
      execute: owned.execute,
      scriptStatement: async (sql) => { await owned.connection.query(sql) },
    }, this.config.schemaMode, this.config.database, this.config.migrationLockTimeoutSeconds), undefined, this.config.schemaTimeoutMs)
  }

  /**
   * Return the schema identity verified during this plugin activation.
   * @returns A detached public receipt without endpoint secrets or application data.
   */
  status(): MysqlSchemaStatus {
    if (!this.schema || this.closing) throw new MysqlError('closed', 'The MySQL provider is not active.', 'not-started')
    return { ...this.schema }
  }

  /**
   * Execute one positional prepared statement; this may be an autocommitted write.
   * @param sql - Static SQL with positional placeholders; callers bound the result size and decode row values.
   * @param values - Data values; BIGINT inputs use bigint or exact text and returned BIGINT/DECIMAL values remain strings.
   * @param signal - Operation cancellation; a cancelled connection is closed and never reused.
   * @returns Rows or acknowledged write metadata. Lost autocommit responses can have an unknown write outcome.
   */
  execute(sql: string, values: readonly MysqlParameter[], signal?: AbortSignal): Promise<MysqlResult> {
    const bound = parameters(values)
    return this.run(owned => owned.execute(sql, bound), signal)
  }

  /**
   * Run transactional statements once on one connection; no deadlock or COMMIT retry is implicit.
   * @param work - Callback using only its executor; no DDL, transaction control or session changes.
   * The executor expires at settlement.
   * @param signal - Cancellation closes the connection. Cancellation during COMMIT has an unknown outcome.
   * @returns Callback value after COMMIT acknowledgement; failures roll back before rejection when transport permits it.
   */
  transaction<T>(work: (executor: MysqlExecutor) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.transact(work, signal)
  }

  private transact<T>(work: (executor: MysqlExecutor) => Promise<T>, signal?: AbortSignal,
    consumer?: MysqlConsumerScope): Promise<T> {
    return this.run(async (owned) => {
      await owned.connection.beginTransaction()
      owned.phase = 'working'
      try {
        let callbackActive = true
        let value: T
        try {
          value = await work({ execute: (sql, values) => {
            if (!callbackActive) return Promise.reject(new MysqlError('closed', 'This MySQL transaction executor has expired.', 'not-started'))
            return owned.execute(sql, values)
          } })
        } finally { callbackActive = false }
        this.check(owned)
        owned.phase = 'committing'
        try { await owned.connection.commit() }
        catch (error) {
          const failure = mysqlFailure(error)
          throw new MysqlError('transaction_unknown',
            'MySQL did not confirm COMMIT. Query the consumer\'s durable receipt before retrying; do not repeat external tool actions.',
            'unknown', false, failure.driverCode)
        }
        owned.phase = 'committed'
        return value
      } catch (error) {
        if (owned.phase === 'working' && !owned.signal.aborted) {
          try { await owned.connection.rollback() }
          catch (rollbackError) {
            const failure = mysqlFailure(rollbackError)
            throw new MysqlError('connection_unavailable',
              'MySQL did not confirm ROLLBACK. The connection is discarded; inspect the consumer receipt before another write.',
              'unknown', false, failure.driverCode)
          }
        }
        throw error
      } finally { owned.active = false }
    }, signal, undefined, consumer)
  }

  private checkLifetime(): void {
    if (this.closing || this.lifetime.signal.aborted) {
      throw new MysqlError('closed', 'The MySQL provider was unloaded before connection setup completed.', 'not-started')
    }
  }

  private check(owned: OwnedConnection): void {
    if (!owned.active) throw new MysqlError('closed', 'This MySQL transaction executor has expired.', 'not-started')
    if (owned.signal.aborted) throw this.cancelled(owned)
  }

  private cancelled(owned: OwnedConnection): MysqlError {
    const code = this.lifetime.signal.aborted || (this.closing && !owned.consumer) ? 'closed'
      : owned.signal.reason instanceof DOMException && owned.signal.reason.name === 'TimeoutError' ? 'timeout' : 'cancelled'
    const outcome: MysqlCommitOutcome = owned.phase === 'working' ? 'not-committed' : 'unknown'
    return new MysqlError(code, 'MySQL work was cancelled, timed out or unloaded. The connection is discarded; confirm any unknown write outcome before retrying.', outcome)
  }

  private run<T>(work: (owned: OwnedConnection) => Promise<T>, signal?: AbortSignal,
    timeoutMs = this.config.operationTimeoutMs, consumer?: MysqlConsumerScope): Promise<T> {
    if (this.lifetime.signal.aborted || !this.pool || (this.closing && !consumer) || consumer?.isClosed) {
      return Promise.reject(new MysqlError('closed', 'The MySQL provider or consumer is not active.', 'not-started'))
    }
    if (signal?.aborted) return Promise.reject(new MysqlError('cancelled', 'MySQL work was cancelled before admission.', 'not-started'))
    if (this.pending.size >= this.config.connectionLimit) {
      if (consumer?.isDraining) return this.waitForDrainCapacity(work, consumer, signal, timeoutMs)
      return Promise.reject(new MysqlError('capacity', 'The MySQL connection limit is occupied. Retry after accepted work finishes.', 'not-started', true))
    }
    const pool = this.pool
    const operation = (async (): Promise<T> => {
      let connection: PoolConnection
      try { connection = await pool.getConnection() }
      catch (error) { throw mysqlFailure(error, 'not-started') }
      let stream: Duplex
      try { stream = transport(connection) }
      catch (error) { connection.destroy(); throw error }
      const deadline = AbortSignal.timeout(timeoutMs)
      const combined = AbortSignal.any([this.lifetime.signal, deadline,
        ...(consumer ? [] : [this.ordinaryLifetime.signal]), ...(signal === undefined ? [] : [signal])])
      const owned: OwnedConnection = { connection, signal: combined, phase: 'ordinary', active: true, consumer,
        execute: async (sql, values) => {
          this.check(owned)
          try { const [value] = await connection.execute<RowDataPacket[] | ResultSetHeader>(sql, parameters(values)); return result(value) }
          catch (error) {
            const failure = mysqlFailure(error, owned.phase === 'working' ? 'not-committed' : 'not-applicable')
            if (owned.phase === 'ordinary' && failure.code === 'connection_unavailable') {
              throw new MysqlError(failure.code, failure.message, 'unknown', false, failure.driverCode)
            }
            throw failure
          }
        },
      }
      const aborted = Promise.withResolvers<never>()
      const cancel = (): void => {
        owned.active = false
        void discard(stream).then(() => { aborted.reject(this.cancelled(owned)) }, () => { aborted.reject(this.cancelled(owned)) })
      }
      combined.addEventListener('abort', cancel, { once: true })
      let succeeded = false
      try {
        if (combined.aborted) { await discard(stream); throw this.cancelled(owned) }
        const result = await Promise.race([(async () => {
          await owned.execute('SET SESSION time_zone = ?', ['+00:00'])
          await owned.execute('SET SESSION sql_mode = ?', [STRICT_MODE])
          await connection.query('SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin')
          this.check(owned)
          return work(owned)
        })(), aborted.promise])
        succeeded = true
        return result
      } catch (error) {
        if (combined.aborted) throw this.cancelled(owned)
        throw mysqlFailure(error)
      } finally {
        owned.active = false
        combined.removeEventListener('abort', cancel)
        if (!succeeded || combined.aborted) await discard(stream)
        else connection.release()
      }
    })()
    this.pending.add(operation)
    void operation.then(() => { this.pending.delete(operation) }, () => { this.pending.delete(operation) })
    return operation
  }

  private async waitForDrainCapacity<T>(work: (owned: OwnedConnection) => Promise<T>, consumer: MysqlConsumerScope,
    signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
    const deadline = AbortSignal.timeout(timeoutMs)
    const combined = AbortSignal.any([this.lifetime.signal, deadline, ...(signal ? [signal] : [])])
    const cancelled = Promise.withResolvers<never>()
    const abort = (): void => {
      const code = this.lifetime.signal.aborted ? 'closed' : deadline.aborted ? 'timeout' : 'cancelled'
      cancelled.reject(new MysqlError(code, 'MySQL consumer drain could not enter the bounded connection pool.', 'not-started'))
    }
    combined.addEventListener('abort', abort, { once: true })
    try {
      if (combined.aborted) abort()
      while (this.pending.size >= this.config.connectionLimit) {
        await Promise.race([Promise.race([...this.pending].map(operation => operation.then(() => undefined, () => undefined))),
          cancelled.promise])
      }
      await Promise.race([Promise.resolve(), cancelled.promise])
      return await this.run(work, combined, timeoutMs, consumer)
    } finally { combined.removeEventListener('abort', abort) }
  }
}
export { mysqlConsumerTransaction } from './transaction.ts'
export { prepareMysqlSchema } from './schema.ts'
export type { MysqlMigrationConnection } from './schema.ts'
export type { MysqlWorkspaceAdoption } from './schema-workspace.ts'
