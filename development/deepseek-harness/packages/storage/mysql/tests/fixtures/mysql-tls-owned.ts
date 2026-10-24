/** Owned public certificates, credential materialization, and strictly loopback test-only DNS resolution. */
import { X509Certificate } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import dns from 'node:dns'
import type { LookupAddress, LookupOptions } from 'node:dns'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Socket } from 'node:net'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { checkServerIdentity, rootCertificates } from 'node:tls'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Config } from '../../src/index.ts'

/** The only accepted server process identity, verified after the positive TLS handshake. */
export const tlsServerUuid = '81698848-cb10-11f1-900d-30560fa55c04'
/** The fixed public certificate identity, distinct from the physical loopback endpoint. */
export const tlsServerIdentity = 'MySQL_Server_8.4.11_Auto_Generated_Server_Certificate'
/** One intentionally incorrect identity; it resolves to the same physical owned endpoint. */
export const wrongTlsIdentity = 'mysql-tls-wrong.invalid'
const database = 'dsh_round144_834f9e84adbd40ca95b4a3e9efb8f0ce'
const caFingerprint = '77:60:04:0F:DE:9B:9F:99:5C:DA:BE:48:95:41:18:1D:DD:63:CD:AE:36:B7:5D:17:11:77:8F:37:47:65:3D:04'
const serverFingerprint = 'A0:16:81:18:53:EA:B0:4F:8A:2A:A9:04:A4:44:A9:C9:AA:F0:DD:D2:66:47:DF:74:67:2C:4D:EF:2E:0D:CF:3D'

/** Admit untrusted descriptor/diagnostics values without inventing defaults. */
export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
/** Admit one required public metadata field without reflecting its value in a failure. */
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length) throw new Error('An owned TLS field is absent.')
  return value
}
/** Canonicalize only existing owned paths, including Windows short/long aliases. */
export function canonical(path: string): string {
  const result = realpathSync.native(path).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? result.toLowerCase() : result
}
function contained(parent: string, child: string): boolean {
  const result = relative(parent, child)
  return !isAbsolute(result) && result !== '..' && !result.startsWith('..' + sep)
}
async function descriptor(path: string): Promise<Record<string, unknown>> {
  const source = await readFile(path, 'utf8')
  let value: unknown
  try { value = JSON.parse(source.replace(/^\uFEFF/u, '')) }
  catch (_error) { throw new Error('Invalid owned TLS descriptor; contents omitted.') }
  if (!object(value)) throw new Error('An owned TLS descriptor must be an object.')
  return value
}
function certificateSummary(certificate: X509Certificate) {
  return { subject: certificate.subject, issuer: certificate.issuer, subjectAltName: certificate.subjectAltName ?? null,
    validFrom: certificate.validFrom, validTo: certificate.validTo, ca: certificate.ca, fingerprint256: certificate.fingerprint256 }
}

/**
 * Inspect only the approved descriptor fields and public CA/server certificates; never open a private key.
 * @param repo - repository root whose sibling .local-run owns the reviewed instance.
 * @returns public evidence, exact endpoint config, and a private credential materializer.
 */
export async function ownedTlsTarget(repo: string) {
  const path = process.env['DSH_MYSQL_TEST_INSTANCE']
  if (!path) throw new Error('DSH_MYSQL_TEST_INSTANCE is required; no database was contacted.')
  const ready = await descriptor(resolve(path))
  const privatePath = text(ready['privateConnectionFile'])
  const directory = canonical(dirname(privatePath))
  if (!contained(canonical(resolve(repo, '../.local-run')), directory)
    || basename(directory) !== 'enterprise-round144-mysql-instance-053f0f89f6f448d093a6821ff5858fda') {
    throw new Error('The TLS fixture refuses a different instance directory.')
  }
  const target = await descriptor(privatePath)
  const dataDir = canonical(text(target['dataDir']))
  if (ready['host'] !== '127.0.0.1' || target['host'] !== ready['host'] || ready['port'] !== 11406
    || target['port'] !== 11406 || target['pid'] !== ready['pid'] || ready['version'] !== '8.4.11'
    || target['database'] !== database || !contained(directory, dataDir)) throw new Error('Unreviewed TLS instance metadata.')
  const user = text(target['user']), password = text(target['password'])
  if (user.toLowerCase() === 'root') throw new Error('The TLS fixture requires the provided database-scoped account.')
  const caFile = resolve(dataDir, 'ca.pem')
  const ca = new X509Certificate(await readFile(caFile))
  const server = new X509Certificate(await readFile(resolve(dataDir, 'server-cert.pem')))
  if (ca.fingerprint256 !== caFingerprint || server.fingerprint256 !== serverFingerprint
    || !ca.ca || server.ca || !ca.verify(ca.publicKey) || !server.verify(ca.publicKey)
    || checkServerIdentity(tlsServerIdentity, server.toLegacyObject()) !== undefined) {
    throw new Error('The owned public CA/server certificate differs from the reviewed TLS material.')
  }
  const unrelatedPem = rootCertificates[0]
  if (!unrelatedPem) throw new Error('The prepared Node runtime has no bundled public root for the negative CA case.')
  const unrelated = new X509Certificate(unrelatedPem)
  if (!unrelated.ca || unrelated.fingerprint256 === caFingerprint || server.verify(unrelated.publicKey)) {
    throw new Error('The negative TLS CA is not independent of the owned server certificate.')
  }
  return { caFile, unrelatedPem, dataDir,
    publicEvidence: { ca: certificateSummary(ca), server: certificateSummary(server), unrelatedCA: certificateSummary(unrelated),
      literalIpIdentityMatchesCertificate: checkServerIdentity('127.0.0.1', server.toLegacyObject()) === undefined },
    config: (host: string, tlsCAFile: string, passwordRef: string): Partial<Config> => ({
      host, port: 11406, database, user, passwordRef, tlsCAFile, schemaMode: 'verify', connectionLimit: 1,
      connectTimeoutMs: 5000, operationTimeoutMs: 10000, schemaTimeoutMs: 15000,
    }),
    seedCredential: async (ctx: Context, ref: string): Promise<void> => { await ctx.credentials.set(credentialRef(ref), password) },
    assertSafeDiagnostic: (error: Error): void => {
      if ((String(error) + JSON.stringify(error)).includes(password)) throw new Error('The TLS diagnostic exposed a private credential.')
    },
  }
}

type LookupCallback = (error: NodeJS.ErrnoException | null, addresses: string | LookupAddress[], family?: number) => void

/**
 * Own the test process's narrowly mapped DNS and observe actual socket endpoints without reading any payload.
 * @returns counters and idempotent cleanup that restores DNS and joins every owned socket close.
 */
export function ownedTlsNetwork() {
  const original = Object.getOwnPropertyDescriptor(dns, 'lookup')
  if (!original) throw new Error('The Node DNS lookup property is unavailable.')
  const acceptedNames = new Set([tlsServerIdentity, wrongTlsIdentity])
  const sockets: Array<{ socket: Socket; closed: Promise<void>; connected: boolean }> = []
  const failures: unknown[] = []
  let lookupCalls = 0
  let rejectedLookups = 0
  let closed = false
  let closing: Promise<void> | undefined
  const lookup = (hostname: string, options: LookupOptions | number | LookupCallback, callback?: LookupCallback): void => {
    const receive = typeof options === 'function' ? options : callback
    if (!receive) throw new Error('The owned TLS lookup requires its Node callback.')
    lookupCalls++
    if (!acceptedNames.has(hostname)) {
      rejectedLookups++
      const error = new Error('The TLS fixture refuses an unrelated DNS lookup.')
      failures.push(error)
      queueMicrotask(() => { receive(error, []) })
      return
    }
    const all = typeof options === 'object' && options.all === true
    queueMicrotask(() => { receive(null, all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4) })
  }
  const diagnostics = channel('net.client.socket')
  const observe = (message: unknown): void => {
    if (!object(message) || !(message['socket'] instanceof Socket)) {
      failures.push(new Error('Unexpected public Node socket diagnostic.'))
      return
    }
    const socket = message['socket']
    const completion = new Promise<void>((done) => { socket.once('close', () => { done() }) })
    const owned = { socket, closed: completion, connected: false }
    sockets.push(owned)
    socket.once('connect', () => {
      owned.connected = true
      if (socket.remoteAddress !== '127.0.0.1' || socket.remotePort !== 11406) {
        failures.push(new Error('A TLS socket reached an unreviewed endpoint.'))
        socket.destroy()
      }
    })
  }
  Object.defineProperty(dns, 'lookup', { ...original, value: lookup })
  diagnostics.subscribe(observe)
  return {
    stats: () => ({ lookupCalls, rejectedLookups, sockets: sockets.length,
      connected: sockets.filter(item => item.connected).length,
      closed: sockets.filter(item => item.socket.closed).length, dnsRestored: closed }),
    close: (): Promise<void> => {
      if (closing) return closing
      closing = (async () => {
        diagnostics.unsubscribe(observe)
        try { Object.defineProperty(dns, 'lookup', original); closed = true }
        catch (error) { failures.push(error) }
        const results = await Promise.allSettled(sockets.map(async (item) => {
          let timer: ReturnType<typeof setTimeout> | undefined
          const reachedClose = await Promise.race([
            item.closed.then(() => true),
            new Promise<false>((done) => { timer = setTimeout(() => { done(false) }, 5000) }),
          ]).finally(() => { if (timer) clearTimeout(timer) })
          if (!reachedClose) {
            failures.push(new Error('A TLS socket survived provider disposal; it was forcibly closed by its test owner.'))
            item.socket.destroy()
          }
          await item.closed
        }))
        for (const result of results) if (result.status === 'rejected') { const error: unknown = result.reason; failures.push(error) }
        if (failures.length) throw new AggregateError(failures, 'Owned TLS network or cleanup failed.')
      })()
      return closing
    },
  }
}
