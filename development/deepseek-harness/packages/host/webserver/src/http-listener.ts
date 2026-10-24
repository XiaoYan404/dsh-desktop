/** Common HTTP(S) TCP allocation without routes, identity or service ownership. */
import type { Server } from 'node:http'

// Fetch HTTP(S) bad ports: https://fetch.spec.whatwg.org/#bad-port (2026-10-16).
const BROWSER_BLOCKED_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])

/** Explicit bind settings; callers validate configuration and own eventual listener teardown. */
export interface HttpListenOptions {
  readonly host: string
  /** Zero requests automatic allocation; explicit ports retain their configured value. */
  readonly port: number
  /** Positive whole-number bound on automatic candidates, including rejected blocked ports. */
  readonly maxAttempts: number
}

/**
 * Bind HTTP(S) without exposing an automatic port that Fetch clients cannot access.
 * @param server - Unbound owned HTTP or HTTPS server; this helper registers no routes or long-lived listeners.
 * @param options - Validated host, port and finite candidate bound.
 * @returns Actual TCP port. Blocked automatic candidates close before retry; bind/close errors reject immediately.
 */
export async function listenHttp(server: Server, options: HttpListenOptions): Promise<number> {
  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const failed = (error: Error) => { server.off('listening', ready); reject(error) }
      const ready = () => {
        server.off('error', failed)
        const address = server.address()
        if (!address || typeof address === 'string') { reject(new Error('HTTP listener did not bind a TCP address')); return }
        resolve(address.port)
      }
      server.once('error', failed)
      server.listen(options.port, options.host, ready)
    })
    if (options.port !== 0 || !BROWSER_BLOCKED_PORTS.has(port)) return port
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
  }
  throw new Error(`webserver: no browser-accessible ephemeral port after ${options.maxAttempts} attempts`)
}
