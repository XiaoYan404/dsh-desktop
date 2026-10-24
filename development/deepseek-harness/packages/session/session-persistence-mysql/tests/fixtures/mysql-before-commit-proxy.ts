/** Owned loopback fault: disconnect before forwarding one receipt transaction's COMMIT; never retain authentication. */
import { createConnection, createServer } from 'node:net'
import type { Socket } from 'node:net'

class Packets {
  private pending: Buffer = Buffer.alloc(0)
  feed(chunk: Buffer, inspect: (packet: Buffer) => boolean): Buffer | undefined {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    const out: Buffer[] = []
    while (this.pending.length >= 4) {
      const length = this.pending.readUIntLE(0, 3) + 4
      if (length > this.pending.length) break
      const packet = this.pending.subarray(0, length)
      this.pending = this.pending.subarray(length)
      if (inspect(packet)) out.push(packet)
    }
    return out.length ? Buffer.concat(out) : undefined
  }
}

/** Bind only an ephemeral loopback proxy to the previously reviewed 11406 instance.
 * @returns Owned fault controls and counters; close always drains exactly its own sockets.
 */
export async function createBeforeCommitDisconnectProxy() {
  let armed = false, dropped = 0, receiptExecutions = 0, closed = false
  const sockets = new Map<Socket, Promise<void>>()
  const failures: unknown[] = []
  const track = (socket: Socket, peer: Socket): void => {
    sockets.set(socket, new Promise((done) => { socket.once('close', done) }))
    socket.on('error', (error) => { if (!closed && !socket.destroyed) failures.push(error) })
    socket.once('close', () => { sockets.delete(socket); peer.destroy() })
  }
  const forward = (source: Socket, destination: Socket, packet: Buffer | undefined): void => {
    if (!packet || destination.destroyed) return
    if (!destination.write(packet)) {
      source.pause()
      destination.once('drain', () => { if (!source.destroyed) source.resume() })
    }
  }
  const server = createServer((client) => {
    const upstream = createConnection({ host: '127.0.0.1', port: 11406 })
    track(client, upstream); track(upstream, client)
    let flags: number | undefined, preparingReceipt = false, insertedReceipt = false
    const statements = new Set<number>(), inbound = new Packets(), outbound = new Packets()
    client.on('end', () => { upstream.end() })
    upstream.on('end', () => { client.end() })
    client.on('data', (chunk: Buffer) => {
      try {
        const packet = inbound.feed(chunk, (value) => {
          const body = value.subarray(4)
          if (flags === undefined) {
            if (value[3] !== 1 || body.length < 32) throw new Error('Unsupported owned handshake.')
            flags = body.readUInt32LE(0)
            if ((flags & (0x20 | 0x800)) !== 0) throw new Error('The owned fault requires uncompressed plain loopback.')
            return true
          }
          if (value[3] !== 0) return true
          if (body[0] === 0x16) preparingReceipt = body.subarray(1).toString('utf8').trim().toUpperCase().startsWith('INSERT INTO DSH_APPEND_BATCHES ')
          if (body[0] === 0x19 && body.length >= 5) statements.delete(body.readUInt32LE(1))
          if (body[0] === 0x17 && body.length >= 5 && statements.has(body.readUInt32LE(1))) { insertedReceipt = true; receiptExecutions++ }
          if (body[0] !== 0x03) return true
          const attributes = (flags & 0x08000000) !== 0
          if (attributes && (body[1] !== 0 || body[2] !== 1)) throw new Error('Unexpected query attributes.')
          const sql = body.subarray(attributes ? 3 : 1).toString('utf8').trim().toUpperCase()
          if (sql === 'BEGIN' || sql === 'START TRANSACTION' || sql === 'ROLLBACK') insertedReceipt = false
          if (sql === 'COMMIT' && insertedReceipt && armed) {
            armed = false; dropped++; client.destroy(); upstream.destroy()
            return false
          }
          return true
        })
        forward(client, upstream, packet)
      } catch (error) { failures.push(error); client.destroy(); upstream.destroy() }
    })
    upstream.on('data', (chunk: Buffer) => {
      try {
        const packet = outbound.feed(chunk, (value) => {
          const body = value.subarray(4)
          if (preparingReceipt && value[3] === 1) {
            preparingReceipt = false
            if (body[0] === 0 && body.length >= 5) statements.add(body.readUInt32LE(1))
          }
          return true
        })
        forward(upstream, client, packet)
      } catch (error) { failures.push(error); client.destroy(); upstream.destroy() }
    })
  })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Owned proxy has no loopback endpoint.')
  return {
    port: address.port,
    arm: (): void => { armed = true },
    stats: () => ({ dropped, receiptExecutions, sockets: sockets.size }),
    close: async (): Promise<void> => {
      if (closed) return
      closed = true
      const endings = [...sockets.values()]
      const listening = new Promise<void>((done, reject) => { server.close((error) => { if (error) reject(error); else done() }) })
      for (const socket of sockets.keys()) socket.destroy()
      await Promise.all(endings)
      await listening
      if (failures.length) throw new AggregateError(failures, 'Owned before-COMMIT proxy failed.')
    },
  }
}
