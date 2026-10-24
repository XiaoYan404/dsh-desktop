/** Real Loader fixture: bundle enablement owns the adapter registration and its disposal. */
export const name = 'office-lifecycle-fixture'
export const inject = ['office']
const version = '0.0.1'

/** Attach a customer HTTP reader to the bundle's actual Cordis lifetime. */
export function apply(ctx) {
  ctx.effect(() => ctx.office.registerConnector({
    id: 'office-lifecycle',
    actions: [{ id: 'read-company', label: `Read company data v${version}`, description: '', kind: 'read',
      allowedRoles: ['admin', 'employee'] }],
    async probe(request) {
      const response = await fetch(new URL('health', request.baseUrl), { headers: request.headers, signal: request.signal })
      await response.body?.cancel()
      return { status: response.ok ? 'connected' : 'http_error' }
    },
    async read(request) {
      const response = await fetch(new URL('health', request.baseUrl), { headers: request.headers, signal: request.signal })
      if (!response.ok) { await response.body?.cancel(); return { status: 'http_error' } }
      return { status: 'read', data: await response.json() }
    },
  }), 'office-lifecycle-fixture.adapter')
}
