/** Mutations lock store, slot, lease, then log; no operation rewrites a committed event. */
import { randomBytes } from 'node:crypto'
import { MysqlError } from '@deepseek-ai/dsh-mysql'
import type { MysqlClient, MysqlExecutor, MysqlRow } from '@deepseek-ai/dsh-mysql'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  assertContiguous, assertVersion, SessionAlreadyExistsError, SessionAlreadyOwnedError,
  SessionOwnershipLostError, SessionPersistenceNotFoundError,
  SessionPersistenceCorruptionError,
} from '@deepseek-ai/dsh-session-persistence'
import type { Config } from './index.ts'
import type { AppendReceipt, CreatedWriter, FrozenBatch, LogIdentity, SlotId, StoredLog, StoreId, WriterIdentity } from './types.ts'
import { assertRepresentable, binaryId, corrupt, count, decodeEvent, decodeLog, rows, slotId, storeId, text, validatePrefix } from './records.ts'
import { sessionTransaction } from './transaction.ts'

const LOG_FIELDS = 'store_id,slot_id,lifecycle_id,format_version,log_state,header_json,inherited_event_count,event_count,log_revision'

/** Provider-owned access to one explicitly provisioned namespace. */
export class MysqlSessionRepository {
  private store: StoreId | undefined
  constructor(readonly mysql: MysqlClient, private readonly config: Config) {}

  /** Resolve the existing namespace before admitting Session operations. */
  async initialize(): Promise<void> {
    const found = rows(await this.mysql.execute('SELECT store_id,store_key FROM dsh_stores WHERE store_key=?', [this.config.storeKey]))
    if (found.length !== 1 || found[0]?.['store_key'] !== this.config.storeKey) {
      throw new MysqlError('configuration', 'The configured R7 Session store is not provisioned. Review the namespace and create it explicitly before loading this provider.', 'not-started')
    }
    this.store = storeId(found[0]['store_id'])
  }

  private get storeId(): StoreId {
    if (!this.store) throw new MysqlError('closed', 'The MySQL Session namespace is not active.', 'not-started')
    return this.store
  }

  private async lockStore(tx: MysqlExecutor): Promise<void> {
    const row = rows(await tx.execute('SELECT store_id FROM dsh_stores WHERE store_id=? FOR UPDATE', [this.storeId]))[0]
    if (!row || row['store_id'] !== this.storeId) throw corrupt('The Session store disappeared.')
  }

  private async ensureSlot(tx: MysqlExecutor, id: SessionId): Promise<MysqlRow> {
    assertRepresentable(id)
    if (!id.length) throw new TypeError('A MySQL Session id must not be empty.')
    await tx.execute('INSERT INTO dsh_session_slots (store_id,external_session_id) VALUES (?,?) ON DUPLICATE KEY UPDATE slot_id=slot_id',
      [this.storeId, id])
    const row = rows(await tx.execute(
      'SELECT slot_id,external_session_id,current_lifecycle_id,current_format_version FROM dsh_session_slots WHERE store_id=? AND external_id_hash=UNHEX(SHA2(?,256)) FOR UPDATE',
      [this.storeId, id]))[0]
    if (!row || row['external_session_id'] !== id) throw corrupt('A Session id hash does not match its original text; no identities were merged.')
    return row
  }

  private async current(tx: MysqlExecutor, id: SessionId, lock: boolean): Promise<LogIdentity | undefined> {
    assertRepresentable(id)
    const row = rows(await tx.execute(
      'SELECT slot_id,external_session_id,current_lifecycle_id,current_format_version FROM dsh_session_slots WHERE store_id=? AND external_id_hash=UNHEX(SHA2(?,256))' + (lock ? ' FOR UPDATE' : ''),
      [this.storeId, id]))[0]
    if (!row) return undefined
    if (row['external_session_id'] !== id) throw corrupt('A Session id hash collision was detected; no identities were merged.')
    if (row['current_lifecycle_id'] === null && row['current_format_version'] === null) return undefined
    const version = count(row['current_format_version'])
    assertVersion({ id, version })
    return { id, storeId: this.storeId, slotId: slotId(row['slot_id']), lifecycle: binaryId(row['current_lifecycle_id']), version }
  }

  private key(log: LogIdentity) { return [log.storeId, log.slotId, log.lifecycle, log.version] as const }

  private async log(tx: MysqlExecutor, identity: LogIdentity, lock = false): Promise<StoredLog | undefined> {
    const row = rows(await tx.execute('SELECT ' + LOG_FIELDS + ' FROM dsh_session_logs WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=?' + (lock ? ' FOR UPDATE' : ''), this.key(identity)))[0]
    return row ? decodeLog(row, identity.id) : undefined
  }

  private async lease(tx: MysqlExecutor, slot: SlotId): Promise<MysqlRow> {
    await tx.execute('INSERT INTO dsh_writer_leases (store_id,slot_id) VALUES (?,?) ON DUPLICATE KEY UPDATE slot_id=slot_id',
      [this.storeId, slot])
    const row = rows(await tx.execute(
      'SELECT owner_token,fence_token,lifecycle_id,(expires_at>UTC_TIMESTAMP(6)) AS valid FROM dsh_writer_leases WHERE store_id=? AND slot_id=? FOR UPDATE',
      [this.storeId, slot]))[0]
    if (!row) throw corrupt('A Session lease row is absent after reservation.')
    return row
  }

  private async acquire(tx: MysqlExecutor, identity: LogIdentity, occupied: 'create' | 'open'): Promise<WriterIdentity> {
    const lease = await this.lease(tx, identity.slotId)
    if (lease['owner_token'] !== null && Number(lease['valid']) === 1) {
      throw occupied === 'create' ? new SessionAlreadyExistsError(identity.id) : new SessionAlreadyOwnedError(identity.id)
    }
    const owner = randomBytes(16)
    await tx.execute('UPDATE dsh_writer_leases SET fence_token=fence_token+1,owner_token=?,lifecycle_id=?,expires_at=TIMESTAMPADD(MICROSECOND,?,UTC_TIMESTAMP(6)) WHERE store_id=? AND slot_id=?',
      [owner, identity.lifecycle, this.config.leaseTtlMs * 1000, identity.storeId, identity.slotId])
    const result = rows(await tx.execute('SELECT fence_token FROM dsh_writer_leases WHERE store_id=? AND slot_id=?',
      [identity.storeId, identity.slotId]))[0]
    if (!result) throw corrupt('An acquired Session fence is absent.')
    return { ...identity, owner, fence: text(result, 'fence_token') }
  }

  /** Reserve an unpublished creator without exposing an empty or incomplete seed to another Host.
   * @param header - Detached native header.
   * @returns Its new lifecycle and owned lease; no log pointer is published.
   */
  create(header: SessionHeader): Promise<CreatedWriter> {
    return sessionTransaction(this.mysql, async (tx) => {
      await this.lockStore(tx)
      const parent = header.parentSession === undefined ? null : slotId((await this.ensureSlot(tx, header.parentSession))['slot_id'])
      const slot = await this.ensureSlot(tx, header.id)
      if (slot['current_lifecycle_id'] !== null || slot['current_format_version'] !== null) throw new SessionAlreadyExistsError(header.id)
      const writer = await this.acquire(tx, { id: header.id, storeId: this.storeId, slotId: slotId(slot['slot_id']),
        lifecycle: randomBytes(16), version: SESSION_FORMAT_VERSION }, 'create')
      return { writer, parentSlot: parent }
    })
  }

  /** Read current metadata, optionally acquiring its write lease and validating the complete prefix.
   * @param id - External Session id, never normalized or replaced by an internal key.
   * @param write - Whether to reserve the single writer.
   * @returns Fixed-generation metadata and optional writer identity.
   */
  open(id: SessionId, write: boolean): Promise<{ log: StoredLog; writer?: WriterIdentity }> {
    return sessionTransaction(this.mysql, async (tx) => {
      if (write) await this.lockStore(tx)
      const identity = await this.current(tx, id, write)
      if (!identity) throw new SessionPersistenceNotFoundError(id)
      const writer = write ? await this.acquire(tx, identity, 'open') : undefined
      const log = await this.log(tx, identity, write)
      if (!log) throw new SessionPersistenceNotFoundError(id)
      validatePrefix(log, await this.events(tx, log), true)
      if (writer) await this.extend(tx, writer)
      return { log, ...(writer ? { writer } : {}) }
    })
  }

  /** Fetch current metadata without reading the body or taking write ownership.
   * @param id - External identity.
   * @returns Current metadata, or undefined when no log is published.
   */
  stat(id: SessionId): Promise<StoredLog | undefined> {
    return sessionTransaction(this.mysql, async (tx) => {
      const identity = await this.current(tx, id, false)
      return identity ? this.log(tx, identity) : undefined
    })
  }

  /** Enumerate published headers in this namespace; staging and unresolved slots remain invisible.
   * @returns Current fixed-generation metadata without invented physical file sizes.
   */
  async list(): Promise<StoredLog[]> {
    const found = rows(await this.mysql.execute(
      'SELECT l.store_id,l.slot_id,l.lifecycle_id,l.format_version,l.log_state,l.header_json,l.inherited_event_count,l.event_count,l.log_revision,s.external_session_id FROM dsh_session_slots s JOIN dsh_session_logs l ON l.store_id=s.store_id AND l.slot_id=s.slot_id AND l.lifecycle_id=s.current_lifecycle_id AND l.format_version=s.current_format_version WHERE s.store_id=?', [this.storeId]))
    return found.map(row => decodeLog(row, text(row, 'external_session_id') as SessionId))
  }

  private async events(tx: MysqlExecutor, log: StoredLog): Promise<SessionEvent[]> {
    const events: SessionEvent[] = []
    while (events.length < log.eventCount) {
      const page = rows(await tx.execute(
        'SELECT seq,event_json FROM dsh_session_events WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND seq>=? AND seq<? ORDER BY seq LIMIT ?',
        [...this.key(log), events.length, log.eventCount, this.config.readPageSize]))
      if (page.length === 0) throw corrupt('A committed Session prefix contains a sequence gap.')
      for (const row of page) {
        const event = decodeEvent(text(row, 'event_json'))
        if (count(row['seq']) !== events.length || event.seq !== events.length) throw corrupt('A committed Session prefix is not contiguous.')
        events.push(event)
      }
    }
    return events
  }

  /** Read the handle's original generation, even after the external slot points elsewhere.
   * @param identity - Captured generation.
   * @returns Owned logical events and their atomic header/watermark snapshot.
   */
  read(identity: LogIdentity): Promise<{ log: StoredLog; events: SessionEvent[] }> {
    return sessionTransaction(this.mysql, async (tx) => {
      const log = await this.log(tx, identity)
      if (!log) throw new SessionPersistenceNotFoundError(identity.id)
      const events = await this.events(tx, log)
      validatePrefix(log, events, true)
      return { log, events }
    })
  }

  private async locked(tx: MysqlExecutor, writer: WriterIdentity): Promise<{ slot: MysqlRow; lease: MysqlRow }> {
    await this.lockStore(tx)
    const slot = rows(await tx.execute('SELECT current_lifecycle_id,current_format_version FROM dsh_session_slots WHERE store_id=? AND slot_id=? FOR UPDATE',
      [writer.storeId, writer.slotId]))[0]
    if (!slot) throw new SessionOwnershipLostError(writer.id)
    return { slot, lease: await this.lease(tx, writer.slotId) }
  }

  private assertOwned(writer: WriterIdentity, state: { slot: MysqlRow; lease: MysqlRow }, unpublished: boolean): void {
    const current = state.slot['current_lifecycle_id']
    const pointerMatches = current === null ? unpublished : binaryId(current).equals(writer.lifecycle)
      && count(state.slot['current_format_version']) === writer.version
    const owner = state.lease['owner_token']
    const lifecycle = state.lease['lifecycle_id']
    if (!pointerMatches || !(owner instanceof Uint8Array) || !Buffer.from(owner).equals(writer.owner)
      || !(lifecycle instanceof Uint8Array) || !Buffer.from(lifecycle).equals(writer.lifecycle)
      || state.lease['fence_token'] !== writer.fence || Number(state.lease['valid']) !== 1) {
      throw new SessionOwnershipLostError(writer.id)
    }
  }

  private async extend(tx: MysqlExecutor, writer: WriterIdentity): Promise<void> {
    await tx.execute('UPDATE dsh_writer_leases SET expires_at=TIMESTAMPADD(MICROSECOND,?,UTC_TIMESTAMP(6)) WHERE store_id=? AND slot_id=? AND owner_token=? AND fence_token=? AND lifecycle_id=?',
      [this.config.leaseTtlMs * 1000, writer.storeId, writer.slotId, writer.owner, writer.fence, writer.lifecycle])
  }

  /** Renew the same owner and fence; renewal never reacquires an expired lease.
   * @param writer - Original owner identity.
   * @param unpublished - Whether this is still a pending creator.
   */
  renew(writer: WriterIdentity, unpublished: boolean): Promise<void> {
    return sessionTransaction(this.mysql, async (tx) => {
      const state = await this.locked(tx, writer)
      await this.log(tx, writer, true)
      this.assertOwned(writer, state, unpublished)
      await this.extend(tx, writer)
    })
  }

  /** Release only this owner's lease, preserving its monotonic fence and any successor.
   * @param writer - Original owner identity.
   */
  release(writer: WriterIdentity): Promise<void> {
    return sessionTransaction(this.mysql, async (tx) => {
      await this.locked(tx, writer)
      await this.log(tx, writer, true)
      await tx.execute('UPDATE dsh_writer_leases SET owner_token=NULL,lifecycle_id=NULL,expires_at=NULL,owner_label=NULL WHERE store_id=? AND slot_id=? AND owner_token=? AND fence_token=? AND lifecycle_id=?',
        [writer.storeId, writer.slotId, writer.owner, writer.fence, writer.lifecycle])
    })
  }

  private async insertLog(tx: MysqlExecutor, writer: WriterIdentity, header: SessionHeader, parentSlot: SlotId | null): Promise<void> {
    await tx.execute('INSERT INTO dsh_session_logs (store_id,slot_id,lifecycle_id,format_version,log_state,header_json,session_created_at_ms,initial_cwd,parent_slot_id,is_seeded,inherited_event_count,origin,delegation_depth,agent_preset) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [...this.key(writer), 'staging', JSON.stringify(header), header.createdAt, header.cwd ?? null, parentSlot,
        header.isSeeded ? 1 : 0, 0, header.origin ?? null, header.delegationDepth ?? null, header.agentPreset ?? null])
  }

  private async publish(tx: MysqlExecutor, writer: WriterIdentity): Promise<void> {
    await tx.execute('UPDATE dsh_session_slots SET current_lifecycle_id=?,current_format_version=? WHERE store_id=? AND slot_id=?',
      [writer.lifecycle, writer.version, writer.storeId, writer.slotId])
    await tx.execute('UPDATE dsh_stores SET search_epoch=search_epoch+1 WHERE store_id=?', [writer.storeId])
  }

  private async searchJob(tx: MysqlExecutor, writer: WriterIdentity, receipt: AppendReceipt): Promise<void> {
    await tx.execute("INSERT INTO dsh_search_jobs (store_id,slot_id,lifecycle_id,format_version,target_log_revision,target_event_count,job_state) VALUES (?,?,?,?,?,?,'pending') ON DUPLICATE KEY UPDATE target_log_revision=GREATEST(target_log_revision,?),target_event_count=GREATEST(target_event_count,?),job_state=IF(job_state='running','running','pending'),claim_token=IF(job_state='running',claim_token,NULL),claim_expires_at=IF(job_state='running',claim_expires_at,NULL)",
      [...this.key(writer), receipt.revision, receipt.eventCount, receipt.revision, receipt.eventCount])
  }

  private async receipt(tx: MysqlExecutor, writer: WriterIdentity, batch: FrozenBatch, lock: boolean): Promise<AppendReceipt | undefined> {
    const row = rows(await tx.execute('SELECT first_seq,batch_event_count,LOWER(HEX(payload_sha256)) AS digest,committed_revision FROM dsh_append_batches WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND batch_id=?' + (lock ? ' FOR UPDATE' : ''),
      [...this.key(writer), batch.batchId]))[0]
    if (!row) return undefined
    if (row['digest'] !== batch.sha256.toString('hex') || count(row['first_seq']) !== batch.firstSeq
      || count(row['batch_event_count']) !== batch.events.length) throw corrupt('A durable Session batch receipt conflicts with its frozen payload.')
    return { eventCount: batch.firstSeq + batch.events.length, revision: text(row, 'committed_revision') }
  }

  /** Append one fixed batch; uncertainty is checked by durable receipt before any later attempt.
   * @param writer - Unchanged owner/fence/generation.
   * @param header - Original metadata for first publication.
   * @param inherited - Exact seed cut.
   * @param parentSlot - Reserved lineage slot for first publication.
   * @param batch - Frozen id, original texts and digest, retained across failures.
   * @returns Its acknowledged durable prefix and revision.
   */
  async append(writer: WriterIdentity, header: SessionHeader, inherited: SessionLogOffset, parentSlot: SlotId | null,
    batch: FrozenBatch): Promise<AppendReceipt> {
    try {
      return await sessionTransaction(this.mysql, async (tx) => {
        await this.lockStore(tx)
        const previous = await this.receipt(tx, writer, batch, false)
        if (previous) return previous
        const state = await this.locked(tx, writer)
        const existing = await this.log(tx, writer, true)
        const waited = await this.receipt(tx, writer, batch, true)
        if (waited) return waited
        this.assertOwned(writer, state, existing === undefined)
        const prefix = existing ? await this.events(tx, existing) : []
        assertContiguous(writer.id, batch.events, prefix.length)
        const complete = prefix.concat(batch.events)
        validatePrefix({ header, inheritedEventCount: inherited }, complete, false)
        if (!existing) await this.insertLog(tx, writer, header, parentSlot)
        for (const [index, event] of batch.events.entries()) {
          const op = event.surfaceOp
          const data: unknown = event.data
          const turn: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'turn') : undefined
          const step: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'step') : undefined
          await tx.execute('INSERT INTO dsh_session_events (store_id,slot_id,lifecycle_id,format_version,seq,event_type,event_time_ms,turn_no,step_no,ignorable,surface_op,replace_start_seq,replace_end_seq,event_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [...this.key(writer), event.seq, event.type, event.time,
              typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 ? turn : null,
              typeof step === 'number' && Number.isSafeInteger(step) && step >= 0 ? step : null,
              event.ignorable === true ? 1 : 0, op === undefined ? 'none' : op === 'append' ? 'append' : 'replace',
              typeof op === 'object' ? op.startSeq : null, typeof op === 'object' ? op.endSeq : null, batch.eventTexts[index] ?? null])
        }
        for (const event of batch.events) {
          for (const source of event.sourceEventSeqs ?? []) {
            await tx.execute('INSERT INTO dsh_event_sources (store_id,slot_id,lifecycle_id,format_version,target_seq,source_seq) VALUES (?,?,?,?,?,?)',
              [...this.key(writer), event.seq, source])
          }
        }
        await tx.execute("UPDATE dsh_session_logs SET event_count=?,inherited_event_count=?,log_revision=log_revision+1,log_state='active' WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=?",
          [complete.length, inherited, ...this.key(writer)])
        if (!existing) await this.publish(tx, writer)
        const saved = await this.log(tx, writer)
        if (!saved) throw corrupt('A newly appended Session log is absent.')
        const receipt = { eventCount: saved.eventCount, revision: saved.revision }
        await tx.execute('INSERT INTO dsh_append_batches (store_id,slot_id,lifecycle_id,format_version,batch_id,first_seq,batch_event_count,payload_sha256,committed_revision,writer_fence) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [...this.key(writer), batch.batchId, batch.firstSeq, batch.events.length, batch.sha256, receipt.revision, writer.fence])
        await this.searchJob(tx, writer, receipt)
        await this.extend(tx, writer)
        return receipt
      })
    } catch (error) {
      if (error instanceof MysqlError && error.outcome === 'unknown') {
        try {
          const confirmed = await this.receipt(this.mysql, writer, batch, false)
          if (confirmed) return confirmed
        } catch (inspectionError) {
          if (inspectionError instanceof SessionPersistenceCorruptionError) throw inspectionError
          // An unavailable receipt cannot establish failure or authorize a fresh batch.
        }
      }
      throw error
    }
  }

  /** Publish a legitimately empty unseeded session at an explicit durability barrier.
   * @param writer - Pending creator's fixed lease.
   * @param header - Original native header.
   * @param parentSlot - Reserved lineage slot.
   */
  materializeEmpty(writer: WriterIdentity, header: SessionHeader, parentSlot: SlotId | null): Promise<void> {
    return sessionTransaction(this.mysql, async (tx) => {
      const state = await this.locked(tx, writer)
      const existing = await this.log(tx, writer, true)
      this.assertOwned(writer, state, existing === undefined)
      if (existing) return
      if (header.isSeeded) throw new TypeError('A seeded MySQL Session must append its full seed and inherited marker before flush.')
      await this.insertLog(tx, writer, header, parentSlot)
      await tx.execute("UPDATE dsh_session_logs SET log_state='active' WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=?", this.key(writer))
      await this.publish(tx, writer)
      await this.searchJob(tx, writer, { eventCount: 0, revision: '1' })
      await this.extend(tx, writer)
    })
  }
}
