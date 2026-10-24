/** Plain-loopback MySQL fault fixture; packet bodies and authentication data are never recorded. */
import { createHash } from 'node:crypto'
import { createConnection, createServer, type Socket } from 'node:net'

type StatementTag = 'receipt-read' | 'event-insert' | 'receipt-insert' | 'other'

/** Public counters identify the injected fault without storing SQL or parameter values. */
export interface CommitProxyStats {
  connections: number
  commitCommands: number
  targetedCommitCommands: number
  heldCommitOks: number
  droppedCommitOks: number
  receiptReadbacks: number
  eventInserts: number
  receiptInserts: number
  eventInsertsAfterDrop: number
  receiptInsertsAfterDrop: number
  queryAttributes: boolean
}

/** The real upstream's response, retained only as metadata while its packet is discarded. */
export interface HeldCommitOk {
  connection: number
  sequence: number
  packetBytes: number
  packetSha256: string
  serverStatus: number
}

/** One explicitly armed append COMMIT, followed by transparent receipt readback connections. */
export interface CommitAckProxy {
  readonly port: number
  /** Arm only a transaction that actually executes the append-receipt INSERT. */
  arm(): void
  /** @returns Metadata after a real upstream COMMIT OK is withheld, or rejects after fixture failure/close. */
  held(): Promise<HeldCommitOk>
  /** Disarm and close only the faulted connection; repeated calls join its socket closure. */
  drop(): Promise<void>
  /** @returns Detached command counters without protocol bodies. */
  stats(): CommitProxyStats
  /** Reject unexpected proxy failures collected by socket listeners. */
  assertHealthy(): void
  /** Fence accepts, settle a held response, and await every owned socket and the listening server. */
  close(): Promise<void>
}

interface Pair {
  readonly ordinal: number
  readonly client: Socket
  readonly upstream: Socket
  flags: number | undefined
  preparing: StatementTag | undefined
  readonly prepared: Map<number, StatementTag>
  insertedReceipt: boolean
  committing: boolean
  targeted: boolean
  held: boolean
  intentionalClose: boolean
}

class Packets {
  private pending: Buffer = Buffer.alloc(0)
  feed(chunk: Buffer, inspect: (packet: Buffer) => boolean): Buffer | undefined {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    const forwarded: Buffer[] = []
    while (this.pending.length >= 4) {
      const bytes = this.pending.readUIntLE(0, 3) + 4
      if (this.pending.length < bytes) break
      const packet = this.pending.subarray(0, bytes)
      this.pending = this.pending.subarray(bytes)
      if (inspect(packet)) forwarded.push(packet)
    }
    return forwarded.length === 0 ? undefined : Buffer.concat(forwarded)
  }
}

function tag(sql: string): StatementTag {
  const normalized = sql.trim().toUpperCase()
  if (normalized.startsWith('INSERT INTO DSH_SESSION_EVENTS ')) return 'event-insert'
  if (normalized.startsWith('INSERT INTO DSH_APPEND_BATCHES ')) return 'receipt-insert'
  if (normalized.startsWith('SELECT FIRST_SEQ,BATCH_EVENT_COUNT,') && normalized.includes(' FROM DSH_APPEND_BATCHES ')) return 'receipt-read'
  return 'other'
}

/**
 * Bind a new ephemeral loopback endpoint forwarding only to the reviewed round144 upstream.
 * A full upstream OK for one armed append COMMIT is omitted, then the caller drops that connection.
 * Authentication, prepared values, and all other packets are forwarded without logging their bodies.
 * @returns The owned proxy, which must be closed even when setup or the append fails.
 */
export async function createCommitAckProxy(): Promise<CommitAckProxy> {
  const counts: CommitProxyStats = { connections: 0, commitCommands: 0, targetedCommitCommands: 0,
    heldCommitOks: 0, droppedCommitOks: 0, receiptReadbacks: 0, eventInserts: 0, receiptInserts: 0,
    eventInsertsAfterDrop: 0, receiptInsertsAfterDrop: 0, queryAttributes: false }
  const failures: unknown[] = []
  const sockets = new Map<Socket, Promise<void>>()
  const held = Promise.withResolvers<{ ok: HeldCommitOk } | { error: unknown }>()
  let armed = false
  let fault: Pair | undefined
  let dropping: Promise<void> | undefined
  let closing: Promise<void> | undefined
  const fail = (error: unknown): void => { failures.push(error); held.resolve({ error }) }
  const track = (socket: Socket, pair: Pair): void => {
    const closed = new Promise<void>((done) => { socket.once('close', done) })
    sockets.set(socket, closed)
    socket.on('error', (error) => {
      // The selected disconnect and owned teardown deliberately terminate their transports.
      if (!pair.intentionalClose && !closing) fail(new Error('The owned MySQL proxy transport failed.', { cause: error }))
    })
    socket.once('close', () => {
      sockets.delete(socket)
      if (!pair.client.destroyed) pair.client.destroy()
      if (!pair.upstream.destroyed) pair.upstream.destroy()
    })
  }
  const forward = (source: Socket, destination: Socket, packet: Buffer | undefined): void => {
    if (packet === undefined || destination.destroyed) return
    if (!destination.write(packet)) {
      source.pause()
      destination.once('drain', () => { if (!source.destroyed) source.resume() })
    }
  }
  const server = createServer((client) => {
    const upstream = createConnection({ host: '127.0.0.1', port: 11406 })
    const pair: Pair = { ordinal: ++counts.connections, client, upstream, flags: undefined,
      preparing: undefined, prepared: new Map(), insertedReceipt: false, committing: false,
      targeted: false, held: false, intentionalClose: false }
    track(client, pair)
    track(upstream, pair)
    const inbound = new Packets(), outbound = new Packets()
    client.on('end', () => { upstream.end() })
    upstream.on('end', () => { client.end() })
    client.on('data', (chunk: Buffer) => {
      try {
        forward(client, upstream, inbound.feed(chunk, (packet) => {
          const sequence = packet[3]
          const payload = packet.subarray(4)
          if (pair.flags === undefined) {
            if (sequence !== 1 || payload.length < 32) throw new Error('Unsupported MySQL client handshake framing.')
            pair.flags = payload.readUInt32LE(0)
            if ((pair.flags & (0x20 | 0x800)) !== 0) throw new Error('The wire fault fixture requires plain, uncompressed loopback transport.')
            counts.queryAttributes ||= (pair.flags & 0x08000000) !== 0
            return true
          }
          if (sequence !== 0) return true
          if (payload[0] === 0x16) pair.preparing = tag(payload.subarray(1).toString('utf8'))
          if (payload[0] === 0x19 && payload.length >= 5) pair.prepared.delete(payload.readUInt32LE(1))
          if (payload[0] === 0x17 && payload.length >= 5) {
            const kind = pair.prepared.get(payload.readUInt32LE(1))
            if (kind === 'event-insert') {
              counts.eventInserts++
              if (counts.droppedCommitOks > 0) counts.eventInsertsAfterDrop++
            }
            if (kind === 'receipt-insert') {
              counts.receiptInserts++
              pair.insertedReceipt = true
              if (counts.droppedCommitOks > 0) counts.receiptInsertsAfterDrop++
            }
            if (kind === 'receipt-read' && counts.droppedCommitOks > 0 && pair !== fault) counts.receiptReadbacks++
          }
          if (payload[0] !== 0x03) return true
          const attributes = (pair.flags & 0x08000000) !== 0
          if (attributes && (payload[1] !== 0 || payload[2] !== 1)) throw new Error('The wire fixture accepts only the driver\'s empty query-attribute prefix.')
          const sql = payload.subarray(attributes ? 3 : 1).toString('utf8').trim().toUpperCase()
          if (sql === 'START TRANSACTION' || sql === 'BEGIN' || sql === 'ROLLBACK') pair.insertedReceipt = false
          if (sql === 'COMMIT') {
            counts.commitCommands++
            pair.committing = true
            if (armed && pair.insertedReceipt) {
              armed = false
              fault = pair
              pair.targeted = true
              counts.targetedCommitCommands++
            }
          }
          return true
        }))
      } catch (error) { fail(error); client.destroy(); upstream.destroy() }
    })
    upstream.on('data', (chunk: Buffer) => {
      try {
        forward(upstream, client, outbound.feed(chunk, (packet) => {
          const sequence = packet[3]
          const payload = packet.subarray(4)
          if (pair.preparing !== undefined && sequence === 1) {
            if (payload[0] === 0 && payload.length >= 12) pair.prepared.set(payload.readUInt32LE(1), pair.preparing)
            pair.preparing = undefined
          }
          if (!pair.committing || sequence !== 1) return true
          pair.committing = false
          if (!pair.targeted) return true
          if (payload.length < 7 || payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 0
            || (payload.readUInt16LE(3) & 1) !== 0) throw new Error('The targeted COMMIT did not return a complete, committed upstream OK.')
          pair.held = true
          client.pause()
          upstream.pause()
          counts.heldCommitOks++
          held.resolve({ ok: { connection: pair.ordinal, sequence, packetBytes: packet.length,
            packetSha256: createHash('sha256').update(packet).digest('hex'), serverStatus: payload.readUInt16LE(3) } })
          return false
        }))
      } catch (error) { fail(error); client.destroy(); upstream.destroy() }
    })
  })
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); done() })
  })
  server.on('error', fail)
  const address = server.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>((done) => { server.close(() => { done() }) })
    throw new Error('The owned wire proxy did not bind an ephemeral TCP endpoint.')
  }
  const drop = (): Promise<void> => {
    armed = false
    held.resolve({ error: new Error('The owned wire fault was closed before a held COMMIT OK was observed.') })
    if (!fault) return Promise.resolve()
    if (dropping) return dropping
    const pair = fault
    pair.intentionalClose = true
    if (pair.held) counts.droppedCommitOks++
    const settled = [pair.client, pair.upstream].map(socket => sockets.get(socket)).filter(value => value !== undefined)
    pair.client.destroy()
    pair.upstream.destroy()
    dropping = Promise.all(settled).then(() => undefined)
    return dropping
  }
  const assertHealthy = (): void => {
    if (failures.length > 0) throw new AggregateError(failures, 'The owned wire proxy failed; packet bodies were not recorded.')
  }
  return {
    port: address.port,
    arm() {
      assertHealthy()
      if (armed || fault || closing) throw new Error('The wire proxy permits one new append-COMMIT fault only.')
      armed = true
    },
    async held() {
      const result = await held.promise
      if ('error' in result) throw result.error
      return result.ok
    },
    drop,
    stats: () => ({ ...counts }),
    assertHealthy,
    close() {
      if (closing) return closing
      closing = Promise.resolve().then(async () => {
        await drop()
        const stopped = new Promise<void>((done, reject) => {
          server.close((error) => { if (error) reject(error); else done() })
        })
        const pending = [...sockets.values()]
        for (const socket of sockets.keys()) socket.destroy()
        for (const result of await Promise.allSettled([...pending, stopped])) {
          if (result.status === 'rejected') { const error: unknown = result.reason; failures.push(error) }
        }
        assertHealthy()
      })
      return closing
    },
  }
}
