/** A separately owned TCP gate makes only the product's new receipt connections unavailable. */
import { createConnection, createServer, type Socket } from 'node:net'
import type { CommitAckProxy } from './mysql-commit-proxy.ts'

/** Connection counts contain no authentication data, SQL or protocol bodies. */
export interface ReadbackGateStats {
  forwardedConnections: number
  rejectedConnections: number
  activeSockets: number
  blocked: boolean
}

/** Existing bridges survive blocking; the original COMMIT proxy owns the selected disconnect. */
export interface ReadbackGate {
  readonly port: number
  /** Reject subsequent client sockets without opening an upstream connection. */
  blockNewConnections(): void
  /** Allow subsequent sockets to reach the still-running owned COMMIT proxy. */
  restore(): void
  /** @returns Detached counts without packet inspection. */
  stats(): ReadbackGateStats
  /** Reject unexpected listener or transport failures. */
  assertHealthy(): void
  /** Fence accepts, destroy every owned bridge/refusal socket and await the listening server. */
  close(): Promise<void>
}

/**
 * Bind an ephemeral loopback gate in front of an independently owned COMMIT proxy.
 * The gate never reads or records bytes; blocking refuses new sockets before authentication.
 * @param proxy - The COMMIT proxy created by this case, whose only upstream is the reviewed database.
 * @returns The owned gate, which must close before the upstream proxy closes.
 */
export async function createReadbackGate(proxy: Pick<CommitAckProxy, 'port'>): Promise<ReadbackGate> {
  const sockets = new Map<Socket, Promise<void>>()
  const failures: unknown[] = []
  let allowed = true
  let forwarded = 0
  let rejected = 0
  let closing: Promise<void> | undefined
  const assertHealthy = (): void => {
    if (failures.length > 0) throw new AggregateError(failures, 'The owned receipt gate failed; no protocol bytes were recorded.')
  }
  const track = (socket: Socket, refusal: boolean): void => {
    sockets.set(socket, new Promise<void>((done) => {
      socket.once('close', () => { sockets.delete(socket); done() })
    }))
    socket.on('error', (error) => {
      const code: unknown = Reflect.get(error, 'code')
      // Planned refusal, COMMIT disconnect and teardown can reset their already owned transports.
      if ((refusal || !allowed || closing) && (code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED')) return
      failures.push(new Error('The owned receipt gate transport failed.', { cause: error }))
    })
  }
  const server = createServer((client) => {
    track(client, !allowed)
    if (!allowed || closing) { rejected++; client.destroy(); return }
    forwarded++
    const upstream = createConnection({ host: '127.0.0.1', port: proxy.port })
    track(upstream, false)
    client.once('close', () => { upstream.destroy() })
    upstream.once('close', () => { client.destroy() })
    client.pipe(upstream)
    upstream.pipe(client)
  })
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); done() })
  })
  server.on('error', (error) => { failures.push(error) })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>((done) => { server.close(() => { done() }) })
    throw new Error('The owned receipt gate did not bind an ephemeral loopback port.')
  }
  return {
    port: address.port,
    blockNewConnections() {
      assertHealthy()
      if (closing) throw new Error('The owned receipt gate is already closing.')
      allowed = false
    },
    restore() {
      assertHealthy()
      if (closing) throw new Error('The owned receipt gate is already closing.')
      allowed = true
    },
    stats: () => ({ forwardedConnections: forwarded, rejectedConnections: rejected, activeSockets: sockets.size, blocked: !allowed }),
    assertHealthy,
    close() {
      if (closing) return closing
      allowed = false
      closing = Promise.resolve().then(async () => {
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
