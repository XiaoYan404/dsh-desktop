/** R7 search claims and publication use store-first locking and never rewrite native events. */
import { randomBytes } from 'node:crypto'
import { MysqlError } from '@deepseek-ai/dsh-mysql'
import type { MysqlClient, MysqlExecutor, MysqlParameter, MysqlRow } from '@deepseek-ai/dsh-mysql'
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { observeMysqlSessionCut, mysqlSessionStoreId, mysqlSessionSlotId } from '@deepseek-ai/dsh-session-persistence-mysql'
import type { MysqlSessionWriterOwnership, MysqlSessionWriterIdentity } from '@deepseek-ai/dsh-session-persistence-mysql'
import { buildSessionEventSearchDocuments } from '@deepseek-ai/dsh-session-query'
import type { SessionEventMetadataFilter, SessionEventSearchDocument } from '@deepseek-ai/dsh-session-query'
import { MysqlSearchError } from './error.ts'
import { binary, count, cutFromLog, decimal, decodeCut, key, object, rows, string, transaction } from './records.ts'
import type { SearchCandidate, SearchClaim, SearchCut, SearchLimits, SearchView } from './types.ts'

const LOG_COLUMNS = 'l.store_id,l.slot_id,l.lifecycle_id,l.format_version,l.log_state,l.log_revision,l.event_count,l.inherited_event_count,l.header_json,x.external_session_id'
const CURRENT_LOGS = ' FROM dsh_session_slots x JOIN dsh_session_logs l ON l.store_id=x.store_id AND l.slot_id=x.slot_id AND l.lifecycle_id=x.current_lifecycle_id AND l.format_version=x.current_format_version'
const ANALYZER_COLUMNS = 'search_analyzer_version,search_config_json,@@GLOBAL.ngram_token_size AS ngram_size,@@GLOBAL.innodb_ft_enable_stopword AS stopwords'

function assertAnalyzer(row: MysqlRow): void {
  const config = object(JSON.parse(string(row['search_config_json'])))
  if (count(row['search_analyzer_version']) !== 1 || count(row['ngram_size']) !== 2 || count(row['stopwords']) !== 0
    || config['ngramTokenSize'] !== 2 || config['stopwords'] !== false || config['extractorVersion'] !== 1) {
    throw new MysqlSearchError('UNSUPPORTED_ANALYZER')
  }
}

/** SQL operations on one explicitly provisioned namespace; initialization only verifies. */
export class MysqlSearchRepository {
  private storeId: string | undefined
  constructor(private readonly sql: MysqlClient, private readonly storeKey: string, readonly limits: SearchLimits) {}

  /** Verify namespace and analyzer settings without DDL or automatic provisioning. */
  async initialize(): Promise<void> {
    const row = rows(await this.sql.execute(
      'SELECT store_id,' + ANALYZER_COLUMNS + ' FROM dsh_stores WHERE store_key=?',
      [this.storeKey]))[0]
    if (!row) throw new MysqlSearchError('INVALID_RECORD')
    assertAnalyzer(row)
    this.storeId = decimal(row['store_id'])
  }

  private get store(): string {
    if (this.storeId === undefined) throw new MysqlSearchError('INVALID_RECORD')
    return this.storeId
  }

  private async lockStore(tx: MysqlExecutor): Promise<MysqlRow> {
    const row = rows(await tx.execute(
      'SELECT search_epoch,registry_revision,' + ANALYZER_COLUMNS + ' FROM dsh_stores WHERE store_id=? FOR UPDATE', [this.store]))[0]
    if (!row) throw new MysqlSearchError('INVALID_RECORD')
    assertAnalyzer(row)
    return row
  }

  /**
   * Refuse every active lease whose accepted prefix cannot be flushed by this exact provider.
   * @param ownership - Synchronous local handle proof; the caller already flushed outside this transaction.
   * @param signal - Request cancellation; store, sorted slots, then leases are locked in that order.
   */
  async assertLocalWriters(ownership: MysqlSessionWriterOwnership, signal?: AbortSignal): Promise<void> {
    if (ownership.mysqlStoreKey !== this.storeKey) throw new MysqlSearchError('ACCESS_UNAVAILABLE')
    await transaction(this.sql, async (tx) => {
      await this.lockStore(tx)
      let after = '0'
      const activePage = (cursor: string) => tx.execute('SELECT slot_id FROM dsh_writer_leases WHERE store_id=?'
        + ' AND slot_id>CAST(? AS UNSIGNED) AND owner_token IS NOT NULL AND expires_at>UTC_TIMESTAMP(6) ORDER BY slot_id LIMIT ?',
      [this.store, cursor, this.limits.pageSize])
      // Lock the complete active slot set before taking any lease row lock. Expiry can only shrink this set under the store lock.
      for (;;) {
        const page = rows(await activePage(after))
        if (page.length === 0) break
        for (const item of page) {
          signal?.throwIfAborted()
          const slotId = mysqlSessionSlotId(item['slot_id'])
          if (BigInt(slotId) <= BigInt(after)) throw new MysqlSearchError('INVALID_RECORD')
          const locked = rows(await tx.execute('SELECT slot_id FROM dsh_session_slots WHERE store_id=? AND slot_id=? FOR UPDATE',
            [this.store, slotId]))[0]
          if (!locked) throw new MysqlSearchError('INVALID_RECORD')
          after = slotId
        }
      }
      after = '0'
      for (;;) {
        const page = rows(await activePage(after))
        if (page.length === 0) return
        for (const item of page) {
          signal?.throwIfAborted()
          const slotId = mysqlSessionSlotId(item['slot_id'])
          if (BigInt(slotId) <= BigInt(after)) throw new MysqlSearchError('INVALID_RECORD')
          const slot = rows(await tx.execute('SELECT external_session_id,current_lifecycle_id,current_format_version'
            + ' FROM dsh_session_slots WHERE store_id=? AND slot_id=?', [this.store, slotId]))[0]
          const lease = rows(await tx.execute('SELECT lifecycle_id,owner_token,fence_token,(expires_at>UTC_TIMESTAMP(6)) AS valid'
            + ' FROM dsh_writer_leases WHERE store_id=? AND slot_id=? FOR UPDATE', [this.store, slotId]))[0]
          after = slotId
          if (!slot || !lease) throw new MysqlSearchError('INVALID_RECORD')
          if (lease['owner_token'] === null || count(lease['valid']) === 0) continue
          const lifecycle = binary(lease['lifecycle_id'])
          const unpublished = slot['current_lifecycle_id'] === null && slot['current_format_version'] === null
          if (!unpublished && (slot['current_lifecycle_id'] === null || slot['current_format_version'] === null
            || !binary(slot['current_lifecycle_id']).equals(lifecycle))) throw new MysqlSearchError('ACCESS_UNAVAILABLE')
          const writer: MysqlSessionWriterIdentity = { id: SessionId(string(slot['external_session_id'])),
            storeId: mysqlSessionStoreId(this.store), slotId, lifecycle,
            version: unpublished ? SESSION_FORMAT_VERSION : count(slot['current_format_version']),
            owner: binary(lease['owner_token']), fence: decimal(lease['fence_token']) }
          if (!ownership.ownsMysqlWriter(writer)) throw new MysqlSearchError('ACCESS_UNAVAILABLE')
        }
      }
    }, signal)
  }

  /**
   * Capture metadata before policy evaluation; no document body is read here.
   * @param signal - Request cancellation.
   * @returns Current epoch, workspace revision and complete native cuts.
   */
  snapshot(signal?: AbortSignal): Promise<SearchView> {
    return transaction(this.sql, async (tx) => {
      const store = await this.lockStore(tx)
      const logs = rows(await tx.execute('SELECT ' + LOG_COLUMNS + CURRENT_LOGS
        + " WHERE x.store_id=? AND l.log_state='active' ORDER BY x.slot_id", [this.store]))
      return { storeId: this.store, epoch: decimal(store['search_epoch']),
        registryRevision: decimal(store['registry_revision']), cuts: logs.map(decodeCut) }
    }, signal)
  }

  /**
   * Claim one queued current generation with a database-clock expiry.
   * @param signal - Worker cancellation.
   * @returns Its exclusive staging identity, or undefined for an empty queue.
   */
  claim(signal?: AbortSignal): Promise<SearchClaim | undefined> {
    return transaction(this.sql, async (tx) => {
      await this.lockStore(tx)
      const ready = rows(await tx.execute(
        "SELECT j.slot_id FROM dsh_search_jobs j JOIN dsh_session_slots x ON x.store_id=j.store_id AND x.slot_id=j.slot_id AND x.current_lifecycle_id=j.lifecycle_id AND x.current_format_version=j.format_version WHERE j.store_id=? AND ((j.job_state IN ('pending','retry') AND j.available_at<=UTC_TIMESTAMP(6)) OR (j.job_state='running' AND j.claim_expires_at<=UTC_TIMESTAMP(6))) ORDER BY j.slot_id LIMIT 1 FOR UPDATE SKIP LOCKED",
        [this.store]))[0]
      if (!ready) return undefined
      const slot = decimal(ready['slot_id'])
      await tx.execute('SELECT slot_id FROM dsh_session_slots WHERE store_id=? AND slot_id=? FOR UPDATE', [this.store, slot])
      const row = rows(await tx.execute('SELECT ' + LOG_COLUMNS + CURRENT_LOGS
        + " WHERE x.store_id=? AND x.slot_id=? AND l.log_state='active' FOR UPDATE", [this.store, slot]))[0]
      if (!row) throw new MysqlSearchError('CUT_CHANGED')
      const cut = decodeCut(row)
      await tx.execute('INSERT INTO dsh_search_state (store_id,slot_id,lifecycle_id,format_version) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE state_revision=state_revision', key(cut))
      const state = rows(await tx.execute('SELECT state_revision FROM dsh_search_state WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? FOR UPDATE', key(cut)))[0]
      if (!state) throw new MysqlSearchError('INVALID_RECORD')
      const token = randomBytes(16), buildId = randomBytes(16)
      await tx.execute("UPDATE dsh_search_jobs SET job_state='running',claim_token=?,claim_expires_at=TIMESTAMPADD(MICROSECOND,?,UTC_TIMESTAMP(6)),attempts=attempts+1,last_error_json=NULL WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=?",
        [token, this.limits.claimTtlMs * 1000, ...key(cut)])
      await tx.execute("INSERT INTO dsh_search_builds (store_id,slot_id,lifecycle_id,format_version,build_id,source_log_revision,source_event_count,extractor_version,analyzer_version,build_state) VALUES (?,?,?,?,?,?,?,1,1,'staging')",
        [...key(cut), buildId, cut.revision, cut.eventCount])
      return { cut, token, buildId, expectedStateRevision: decimal(state['state_revision']) }
    }, signal)
  }

  private async renew(claim: SearchClaim, signal?: AbortSignal): Promise<void> {
    const result = await this.sql.execute(
      "UPDATE dsh_search_jobs SET claim_expires_at=TIMESTAMPADD(MICROSECOND,?,UTC_TIMESTAMP(6)) WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND job_state='running' AND claim_token=? AND claim_expires_at>UTC_TIMESTAMP(6)",
      [this.limits.claimTtlMs * 1000, ...key(claim.cut), claim.token], signal)
    if (result.kind !== 'write' || result.affectedRows !== 1) throw new MysqlSearchError('CLAIM_LOST')
  }

  /**
   * Read and validate the entire immutable input before inserting bounded staging documents.
   * @param claim - Claim returned by this namespace.
   * @param signal - Worker cancellation; unpublished rows remain retained on failure.
   * @returns Number of complete semantic documents staged.
   */
  async stage(claim: SearchClaim, signal?: AbortSignal): Promise<number> {
    await this.renew(claim, signal)
    const prefix = await transaction(this.sql, tx => observeMysqlSessionCut(tx, claim.cut.header.id,
      { storeKey: this.storeKey, maxEvents: this.limits.maxBuildBytes, maxInputBytes: this.limits.maxBuildBytes,
        readPageSize: Math.min(this.limits.pageSize, this.limits.maxBuildBytes) }), signal)
    if (!sameCut(cutFromLog(prefix.log), claim.cut)) throw new MysqlSearchError('CUT_CHANGED')
    const documents = buildSessionEventSearchDocuments(claim.cut.header.id, prefix.events)
    if (documents.length > this.limits.maxDocuments) throw new MysqlSearchError('CAPACITY')
    let bodyBytes = 0
    for (const document of documents) {
      if (!document.text.isWellFormed()) throw new MysqlSearchError('UNREPRESENTABLE')
      const size = Buffer.byteLength(document.text)
      bodyBytes += size
      if (size > this.limits.maxDocumentBytes || bodyBytes > this.limits.maxBuildBytes) throw new MysqlSearchError('CAPACITY')
    }
    for (let offset = 0; offset < documents.length; offset += this.limits.pageSize) {
      await this.renew(claim, signal)
      const batch = documents.slice(offset, offset + this.limits.pageSize)
      await this.sql.execute('INSERT INTO dsh_search_documents (store_id,slot_id,lifecycle_id,format_version,build_id,event_seq,surface_class,body,codepoint_length) VALUES '
        + batch.map(() => '(?,?,?,?,?,?,?,?,?)').join(','), batch.flatMap(document =>
        [...key(claim.cut), claim.buildId, document.seq, document.surface, document.text, Array.from(document.text).length]), signal)
    }
    return documents.length
  }

  /**
   * Publish only a complete build whose claim, current cut and state CAS still match.
   * @param claim - Same immutable staging identity.
   * @param documentCount - Full semantic output count, checked against stored rows.
   * @param signal - Worker cancellation; uncertain COMMIT is reconciled before returning.
   */
  async publish(claim: SearchClaim, documentCount: number, signal?: AbortSignal): Promise<void> {
    try {
      await transaction(this.sql, async (tx) => {
        await this.lockStore(tx)
        const current = rows(await tx.execute('SELECT ' + LOG_COLUMNS + CURRENT_LOGS
          + " WHERE x.store_id=? AND x.slot_id=? AND l.log_state='active' FOR UPDATE", [this.store, claim.cut.slotId]))[0]
        if (!current || !sameCut(decodeCut(current), claim.cut)) throw new MysqlSearchError('CUT_CHANGED')
        const state = rows(await tx.execute('SELECT active_build_id,state_revision,indexed_log_revision,indexed_event_count FROM dsh_search_state WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? FOR UPDATE', key(claim.cut)))[0]
        const job = rows(await tx.execute("SELECT claim_token,(claim_expires_at>UTC_TIMESTAMP(6)) AS valid,target_log_revision,target_event_count FROM dsh_search_jobs WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND job_state='running' FOR UPDATE", key(claim.cut)))[0]
        if (!job || Number(job['valid']) !== 1 || !binary(job['claim_token']).equals(Buffer.from(claim.token))) throw new MysqlSearchError('CLAIM_LOST')
        if (!state || decimal(state['state_revision']) !== claim.expectedStateRevision) throw new MysqlSearchError('CAS_CONFLICT')
        const stored = rows(await tx.execute('SELECT COUNT(*) AS total FROM dsh_search_documents WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND build_id=?', [...key(claim.cut), claim.buildId]))[0]
        if (!stored || count(stored['total']) !== documentCount) throw new MysqlSearchError('INVALID_RECORD')
        if (state['indexed_log_revision'] === claim.cut.revision && count(state['indexed_event_count']) === claim.cut.eventCount && state['active_build_id'] !== null) {
          await tx.execute("UPDATE dsh_search_builds SET build_state='retired',document_count=?,published_at=UTC_TIMESTAMP(6) WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND build_id=? AND build_state='staging'", [documentCount, ...key(claim.cut), claim.buildId])
        } else {
          if (state['active_build_id'] !== null) await tx.execute("UPDATE dsh_search_builds SET build_state='retired' WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND build_id=?", [...key(claim.cut), binary(state['active_build_id'])])
          const updated = await tx.execute("UPDATE dsh_search_builds SET build_state='published',document_count=?,published_at=UTC_TIMESTAMP(6) WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND build_id=? AND build_state='staging'",
            [documentCount, ...key(claim.cut), claim.buildId])
          if (updated.kind !== 'write' || updated.affectedRows !== 1) throw new MysqlSearchError('CAS_CONFLICT')
          await tx.execute('UPDATE dsh_search_state SET active_build_id=?,indexed_log_revision=?,indexed_event_count=?,state_revision=state_revision+1 WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND state_revision=?',
            [claim.buildId, claim.cut.revision, claim.cut.eventCount, ...key(claim.cut), claim.expectedStateRevision])
          await tx.execute('UPDATE dsh_stores SET search_epoch=search_epoch+1 WHERE store_id=?', [this.store])
        }
        const complete = BigInt(decimal(job['target_log_revision'])) <= BigInt(claim.cut.revision)
          && count(job['target_event_count']) <= claim.cut.eventCount
        await tx.execute('UPDATE dsh_search_jobs SET job_state=?,claim_token=NULL,claim_expires_at=NULL WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND claim_token=?',
          [complete ? 'done' : 'pending', ...key(claim.cut), claim.token])
      }, signal)
    } catch (error) {
      if (!(error instanceof MysqlError) || error.outcome !== 'unknown') throw error
      const build = rows(await this.sql.execute('SELECT build_state,published_at FROM dsh_search_builds WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND build_id=?', [...key(claim.cut), claim.buildId]))[0]
      if (build && build['published_at'] !== null && (build['build_state'] === 'published' || build['build_state'] === 'retired')) return
      throw new MysqlSearchError('PUBLICATION_UNKNOWN', { cause: error })
    }
  }

  /**
   * Require a current published index before reading authorized semantic candidates.
   * @param cut - Authorized, session-filtered current cut.
   * @param query - Normalized literal query.
   * @param filters - Metadata predicates, applied in SQL before ranking.
   * @param fulltext - True only when the configured ngram analyzer can recall a literal token.
   * @param signal - Request cancellation.
   * @returns Every matching candidate or an explicit capacity/index failure.
   */
  async candidates(cut: SearchCut, query: string, filters: readonly SessionEventMetadataFilter[], fulltext: boolean,
    signal?: AbortSignal): Promise<SearchCandidate[]> {
    const state = rows(await this.sql.execute('SELECT s.active_build_id,s.indexed_log_revision,s.indexed_event_count,b.build_state,b.extractor_version,b.analyzer_version FROM dsh_search_state s JOIN dsh_search_builds b ON b.store_id=s.store_id AND b.slot_id=s.slot_id AND b.lifecycle_id=s.lifecycle_id AND b.format_version=s.format_version AND b.build_id=s.active_build_id WHERE s.store_id=? AND s.slot_id=? AND s.lifecycle_id=? AND s.format_version=?', key(cut), signal))[0]
    if (!state || state['build_state'] !== 'published' || state['indexed_log_revision'] !== cut.revision
      || count(state['indexed_event_count']) !== cut.eventCount || count(state['extractor_version']) !== 1
      || count(state['analyzer_version']) !== 1) throw new MysqlSearchError('INDEX_NOT_READY')
    const where: string[] = [], parameters: MysqlParameter[] = []
    for (const filter of filters) {
      if (filter.kind === 'type' || filter.kind === 'surface') {
        const column = filter.kind === 'type' ? 'e.event_type' : 'd.surface_class'
        where.push(filter.values.length === 0 ? 'FALSE' : `${column} IN (${filter.values.map(() => '?').join(',')})`)
        parameters.push(...filter.values)
      } else {
        const column = filter.kind === 'seq' ? 'd.event_seq' : 'e.event_time_ms'
        if (filter.from !== undefined) { where.push(`${column}>=?`); parameters.push(filter.from) }
        if (filter.to !== undefined) { where.push(`${column}<=?`); parameters.push(filter.to) }
      }
    }
    if (fulltext) { where.push('MATCH(d.body) AGAINST (? IN NATURAL LANGUAGE MODE)'); parameters.push(query) }
    const documents: SearchCandidate[] = []
    let lastSeq = -1, bytes = 0
    for (;;) {
      const page = rows(await this.sql.execute('SELECT d.event_seq,d.surface_class,d.body,e.event_type,e.event_time_ms FROM dsh_search_documents d JOIN dsh_session_events e ON e.store_id=d.store_id AND e.slot_id=d.slot_id AND e.lifecycle_id=d.lifecycle_id AND e.format_version=d.format_version AND e.seq=d.event_seq WHERE d.store_id=? AND d.slot_id=? AND d.lifecycle_id=? AND d.format_version=? AND d.build_id=? AND d.event_seq>?'
        + (where.length === 0 ? '' : ' AND ' + where.join(' AND ')) + ' ORDER BY d.event_seq LIMIT ?',
      [...key(cut), binary(state['active_build_id']), lastSeq, ...parameters, this.limits.pageSize], signal))
      if (page.length === 0) break
      for (const row of page) {
        const body = string(row['body']), seq = count(row['event_seq']), surface = row['surface_class']
        bytes += Buffer.byteLength(body)
        if (seq <= lastSeq || seq >= cut.eventCount || !['current', 'shadowed', 'log-only'].includes(string(surface))) {
          throw new MysqlSearchError('INVALID_RECORD')
        }
        if (bytes > this.limits.maxCandidateBytes || documents.length >= this.limits.maxCandidates) throw new MysqlSearchError('CAPACITY')
        const document: SessionEventSearchDocument = { sessionId: cut.header.id, seq: SessionSeq(seq),
          type: string(row['event_type']) as SessionEventSearchDocument['type'], time: count(row['event_time_ms']), surface: surface as SessionEventSearchDocument['surface'], text: body }
        documents.push({ ...document, record: { header: cut.header, live: false, persisted: true } })
        lastSeq = seq
      }
    }
    return documents
  }
}

/**
 * @param left - First complete cut.
 * @param right - Second complete cut.
 * @returns Whether both name the same immutable input.
 */
export function sameCut(left: SearchCut, right: SearchCut): boolean {
  return left.storeId === right.storeId && left.slotId === right.slotId && Buffer.from(left.lifecycle).equals(Buffer.from(right.lifecycle))
    && left.format === right.format && left.revision === right.revision && left.eventCount === right.eventCount
    && left.inheritedEventCount === right.inheritedEventCount && JSON.stringify(left.header) === JSON.stringify(right.header)
}
