/** OIDC protocol verification uses a fixture signing key and mocked external provider I/O only. */
import { createHash } from 'node:crypto'
import { beforeAll, expect, it } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeEnterpriseSso } from '../src/enterprise-sso.ts'
import { collaborationFixture, admin, lin, password } from './collaboration-fixture.ts'
import { officeIdentityDomain, OfficeIdentityRepository } from '../src/identity.ts'

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
let publicJwk: Awaited<ReturnType<typeof exportJWK>>
beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  publicJwk = await exportJWK(pair.publicKey)
})
const provider = { id: 'company', issuer: 'https://idp.example.test', authorizationEndpoint: 'https://idp.example.test/authorize',
  tokenEndpoint: 'https://idp.example.test/token', jwksUri: 'https://idp.example.test/jwks', redirectUri: 'https://office.example.test/sso/callback',
  clientId: 'office-test-client', clientSecretRef: null, tokenAuth: 'none' as const, requiredAcr: ['urn:company:mfa'],
  mappings: [{ subject: 'immutable-idp-subject', memberId: lin }] }
const configuration = { providers: [provider], flowTtlMs: 120000, maxPending: 10, requestTimeoutMs: 10000,
  maxResponseBytes: 65536, maxTokenAgeSeconds: 120, clockToleranceSeconds: 0 }

it('verifies a bound RS256 OIDC code/PKCE flow and issues only original pre-enrolled employee sessions', async () => {
  const { ctx, office } = await collaborationFixture()
  await office.initializeIdentity(admin, password)
  await office.setIdentityPassword(admin, lin, password)
  const domain = ctx.storageDomain.get('enterprise_office_identity')
  if (!domain) throw new Error('Original identity domain is absent')
  officeIdentityDomain.global.schema.parse(domain.global.get())
  const identity = new OfficeIdentityRepository(domain as Domain<typeof officeIdentityDomain>, {
    member: id => office.view(id).me, members: () => office.view(admin).managedMembers ?? office.view(admin).members,
    assertOpen: () => { office.view(admin) }, enqueue: operation => operation(),
  })
  let nonce = ''
  let expectedChallenge = ''
  let tokenRequests = 0
  const request: typeof fetch = async (url, init) => {
    expect(init?.redirect).toBe('error')
    if (String(url) === provider.jwksUri) return Response.json({ keys: [{ ...publicJwk, kid: 'fixture-key', use: 'sig', alg: 'RS256' }] })
    tokenRequests++
    const body = new URLSearchParams(String(init?.body))
    expect(createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url')).toBe(expectedChallenge)
    const token = await new SignJWT({ nonce, acr: 'urn:company:mfa', role: 'admin', email: 'administrator@example.test' })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).setIssuer(provider.issuer).setAudience(provider.clientId)
      .setSubject('immutable-idp-subject').setIssuedAt().setExpirationTime('1m').sign(privateKey)
    return Response.json({ id_token: token })
  }
  const sso = new OfficeEnterpriseSso(configuration, resolve => identity.loginFederated(resolve), id => { office.view(id) },
    async () => { throw new Error('Public clients do not read a client secret') }, request)
  const first = sso.begin('company')
  const url = new URL(first.authorizationUrl)
  nonce = url.searchParams.get('nonce') ?? ''
  expectedChallenge = url.searchParams.get('code_challenge') ?? ''
  const input = { providerId: 'company', state: url.searchParams.get('state') ?? '', bindingKey: first.bindingKey, code: 'fixture-code' }
  await expect(sso.complete({ ...input, bindingKey: 'a'.repeat(43) })).rejects.toMatchObject({ code: 'unauthenticated' })
  const receipt = await sso.complete(input)
  expect(office.authenticate(receipt.token).id).toBe(lin)
  expect(office.authenticate(receipt.token).role).toBe('employee')
  expect(tokenRequests).toBe(1)
  await expect(sso.complete(input)).rejects.toMatchObject({ code: 'unauthenticated' })
  sso.dispose()
  expect(() => sso.begin('company')).toThrow()
})

it.each(['issuer', 'audience', 'nonce', 'subject', 'expiry', 'acr', 'authorized-party'] as const)('refuses a verified-provider response with invalid %s without accepting a caller role', async fault => {
  let nonce = ''
  let invoked = false
  const request: typeof fetch = async url => {
    if (String(url) === provider.jwksUri) return Response.json({ keys: [{ ...publicJwk, kid: 'fixture-key', use: 'sig', alg: 'RS256' }] })
    const token = await new SignJWT({ nonce: fault === 'nonce' ? 'different-nonce' : nonce, acr: fault === 'acr' ? 'urn:weaker' : 'urn:company:mfa',
      ...fault === 'authorized-party' ? { azp: 'other-client' } : {}, role: 'admin' })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).setIssuer(fault === 'issuer' ? 'https://other.example.test' : provider.issuer)
      .setAudience(fault === 'audience' ? 'other-client' : provider.clientId).setSubject(fault === 'subject' ? 'unmapped-subject' : 'immutable-idp-subject')
      .setIssuedAt().setExpirationTime(fault === 'expiry' ? '0s' : '1m').sign(privateKey)
    return Response.json({ id_token: token })
  }
  const sso = new OfficeEnterpriseSso(configuration, async resolve => {
    const memberId = resolve()
    invoked = true
    return { member: { id: memberId, name: 'Fixture employee', department: 'Office', jobTitle: 'Employee', role: 'employee', active: true, email: '', phone: '' },
      token: 'not-a-real-session', expiresAt: Date.now() + 1000 }
  }, () => {}, async () => '', request)
  const started = sso.begin('company')
  const url = new URL(started.authorizationUrl)
  nonce = url.searchParams.get('nonce') ?? ''
  await expect(sso.complete({ providerId: 'company', state: url.searchParams.get('state') ?? '', bindingKey: started.bindingKey, code: 'fixture-code' }))
    .rejects.toMatchObject({ code: 'unauthenticated' })
  expect(invoked).toBe(false)
  sso.dispose()
})

it('aborts or refuses oversized provider data, untrusted endpoints and expired process-local flow authority', async () => {
  expect(() => new OfficeEnterpriseSso({ ...configuration, providers: [{ ...provider, tokenEndpoint: 'http://idp.example.test/token' }] },
    async () => { throw new Error('Unreachable') }, () => {}, async () => '')).toThrow()
  const sso = new OfficeEnterpriseSso(configuration, async () => { throw new Error('Must not issue a session') }, () => {}, async () => '',
    async () => new Response('x'.repeat(configuration.maxResponseBytes + 1)))
  const started = sso.begin('company')
  await expect(sso.complete({ providerId: 'company', state: new URL(started.authorizationUrl).searchParams.get('state') ?? '',
    bindingKey: started.bindingKey, code: 'fixture-code' })).rejects.toMatchObject({ code: 'unauthenticated' })
  sso.dispose()
})
