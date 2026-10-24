/** Passive ownership of actual TCP sockets; neither DNS nor any certificate checker is replaced. */
import { channel } from 'node:diagnostics_channel'
import dns from 'node:dns'
import { Socket } from 'node:net'
import { object } from './mysql-tls-owned.ts'

/**
 * Observe only public socket endpoint/lifetime metadata while the real provider dials the owned server.
 * @returns counters and idempotent cleanup, joining every socket and retaining errors.
 */
export function ownedIpTlsNetwork() {
  const lookup = dns.lookup
  const diagnostics = channel('net.client.socket')
  const sockets: Array<{ socket: Socket; closed: Promise<void>; connected: boolean }> = []
  const failures: unknown[] = []
  let closing: Promise<void> | undefined
  const observe = (message: unknown): void => {
    if (!object(message) || !(message['socket'] instanceof Socket)) {
      failures.push(new Error('Unexpected public IP/TLS socket diagnostic.'))
      return
    }
    const socket = message['socket']
    const owned = { socket, connected: false, closed: new Promise<void>((done) => { socket.once('close', () => { done() }) }) }
    sockets.push(owned)
    socket.once('connect', () => {
      owned.connected = true
      if (socket.remoteAddress !== '127.0.0.1' || socket.remotePort !== 11406) {
        failures.push(new Error('The IP/TLS test refused an unreviewed physical endpoint.'))
        socket.destroy()
      }
    })
  }
  diagnostics.subscribe(observe)
  return {
    stats: () => ({ sockets: sockets.length, connected: sockets.filter(item => item.connected).length,
      closed: sockets.filter(item => item.socket.closed).length, globalDnsLookupUntouched: dns.lookup === lookup }),
    close: (): Promise<void> => {
      if (closing) return closing
      closing = (async () => {
        diagnostics.unsubscribe(observe)
        const results = await Promise.allSettled(sockets.map(async (item) => {
          let timer: ReturnType<typeof setTimeout> | undefined
          const reachedClose = await Promise.race([
            item.closed.then(() => true),
            new Promise<false>((done) => { timer = setTimeout(() => { done(false) }, 5000) }),
          ]).finally(() => { if (timer) clearTimeout(timer) })
          if (!reachedClose) {
            failures.push(new Error('The IP/TLS socket survived provider disposal and required its owner to destroy it.'))
            item.socket.destroy()
          }
          await item.closed
        }))
        for (const result of results) if (result.status === 'rejected') { const error: unknown = result.reason; failures.push(error) }
        if (dns.lookup !== lookup) failures.push(new Error('The IP/TLS test unexpectedly replaced DNS lookup.'))
        if (failures.length) throw new AggregateError(failures, 'Owned IP/TLS transport or cleanup failed.')
      })()
      return closing
    },
  }
}
