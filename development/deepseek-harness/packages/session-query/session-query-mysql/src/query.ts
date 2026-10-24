/** Authorized full-corpus literal verification and deterministic cursor pagination. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { SessionQueryError, SessionSearchCursor, compileSessionTextFilter, filterSessionResults,
  materializeSessionEventResultFilters, materializeSessionResultFilters } from '@deepseek-ai/dsh-session-query'
import type { SessionEventMetadataFilter, SessionEventSearchHit, SessionEventSearchPage, SessionEventSearchRequest,
  SessionSearchHit, SessionSearchPage, SessionSearchRequest } from '@deepseek-ai/dsh-session-query'
import type { SessionResultFilter } from '@deepseek-ai/dsh-session-query'
import { MysqlSearchError } from './error.ts'
import type { MysqlSearchRepository } from './repository.ts'
import type { MysqlSearchAccess, SearchAuthorization, SearchCandidate, SearchLimits, SearchView } from './types.ts'

interface Ranked {
  candidate: SearchCandidate
  matches: number
  length: number
  matchIndex: number
}
interface Cursor {
  version: 1
  binding: string
  after: readonly [number, number, number, string, number]
}
interface NormalizedRequest {
  query: string
  sessionId?: string
  sessionFilters: NonNullable<SessionSearchRequest['sessionFilters']>
  eventFilters: readonly SessionEventMetadataFilter[]
  limit: number
  cursor?: SessionSearchCursor
}

/** Provider-independent ranking over a complete, authorized MySQL candidate set. */
export class MysqlSearchQueries {
  private readonly secret = randomBytes(32)
  constructor(private readonly repository: Pick<MysqlSearchRepository, 'snapshot' | 'candidates'>,
    private readonly access: MysqlSearchAccess, private readonly limits: SearchLimits) {}

  /**
 * @param request - Literal cross-session query.
 * @param signal - Request lifetime.
 * @returns Grouped authorized page.
 */
  async sessions(request: SessionSearchRequest, signal: AbortSignal): Promise<SessionSearchPage<SessionSearchHit>> {
    const owned = { ...request, query: normalizeQuery(request.query),
      sessionFilters: materializeSessionResultFilters(request.sessionFilters ?? []),
      eventFilters: metadata(request.eventFilters ?? []), limit: this.limit(request.limit) }
    const result = await this.run(owned, signal)
    return { items: result.items.map(item => ({ ...item.candidate.record, bestMatch: this.hit(item) })),
      ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) }
  }

  /**
 * @param request - Literal within-session query.
 * @param signal - Request lifetime.
 * @returns Authorized event page.
 */
  async events(request: SessionEventSearchRequest, signal: AbortSignal): Promise<SessionEventSearchPage> {
    const owned = { query: normalizeQuery(request.query), sessionId: request.sessionId,
      sessionFilters: [{ kind: 'id' as const, values: [request.sessionId] }], eventFilters: metadata(request.filters ?? []),
      limit: this.limit(request.limit), ...(request.cursor === undefined ? {} : { cursor: request.cursor }) }
    const result = await this.run(owned, signal)
    const record = result.records.find(value => value.header.id === request.sessionId)
    if (!record) throw new SessionQueryError('Session not found.', 'SESSION_QUERY_SESSION_NOT_FOUND')
    return { session: record.header, items: result.items.map(item => this.hit(item)),
      ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) }
  }

  private limit(value: number | undefined): number {
    const limit = value ?? this.limits.defaultLimit
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.limits.maxLimit) {
      throw new SessionQueryError('Search page size is outside the configured range.', 'SESSION_QUERY_INVALID_LIMIT')
    }
    return limit
  }

  private async run(request: NormalizedRequest, signal: AbortSignal) {
    signal.throwIfAborted()
    await this.access.flush(signal)
    const before = await this.repository.snapshot(signal)
    const records = before.cuts.map(cut => ({ header: cut.header, live: this.access.isLive(cut.header.id), persisted: true }))
    const permission = await this.access.authorize(records, signal)
    assertAuthorization(permission)
    const authorized = new Set(permission.sessionIds)
    const selected = filterSessionResults(records.filter(record => authorized.has(record.header.id)), request.sessionFilters)
    const selectedIds = new Set(selected.map(record => record.header.id))
    const cuts = before.cuts.filter(cut => selectedIds.has(cut.header.id))
    const binding = fingerprint({ version: 1, store: before.storeId, epoch: before.epoch, registry: before.registryRevision,
      authority: { principal: permission.principal, revision: permission.revision,
        ids: [...authorized].filter(id => records.some(record => record.header.id === id)).sort(byteCompare) },
      cuts: cuts.map(cut => ({ ...cut, lifecycle: Buffer.from(cut.lifecycle).toString('hex') })),
      query: request.query, scope: request.sessionId === undefined ? 'sessions' : 'events', sessionId: request.sessionId,
      sessionFilters: canonicalFilters(request.sessionFilters), eventFilters: canonicalFilters(request.eventFilters),
      limit: request.limit })
    const cursor = request.cursor === undefined ? undefined : this.decode(request.cursor, binding)
    const expression = compileSessionTextFilter(request.query)
    const matcher = new RegExp(expression.source, 'giu')
    const ranked: Ranked[] = []
    let candidates = 0, bytes = 0
    for (const cut of cuts) {
      signal.throwIfAborted()
      const documents = await this.repository.candidates(cut, request.query, request.eventFilters, hasNgram(request.query), signal)
      for (const candidate of documents) {
        candidates++
        bytes += Buffer.byteLength(candidate.text)
        if (candidates > this.limits.maxCandidates || bytes > this.limits.maxCandidateBytes) throw new MysqlSearchError('CAPACITY')
        const matches = [...candidate.text.matchAll(matcher)]
        const first = matches[0]
        if (!first) continue
        const record = selected.find(value => value.header.id === candidate.sessionId)
        if (!record) throw new MysqlSearchError('INVALID_RECORD')
        ranked.push({ candidate: { ...candidate, record }, matches: matches.length, length: Array.from(candidate.text).length,
          matchIndex: Array.from(candidate.text.slice(0, first.index)).length })
      }
    }
    ranked.sort(compare)
    const unique = new Set<string>()
    const grouped = request.sessionId === undefined ? ranked.filter((item) => {
      if (unique.has(item.candidate.sessionId)) return false
      unique.add(item.candidate.sessionId)
      return true
    }) : ranked
    let offset = 0
    if (cursor !== undefined) {
      const index = grouped.findIndex(item => JSON.stringify(tuple(item)) === JSON.stringify(cursor.after))
      if (index < 0) throw stale()
      offset = index + 1
    }
    const page = grouped.slice(offset, offset + request.limit)
    const last = page.at(-1)
    const nextCursor = last !== undefined && offset + page.length < grouped.length
      ? this.encode({ version: 1, binding, after: tuple(last) }) : undefined
    await this.access.flush(signal)
    const after = await this.repository.snapshot(signal)
    const currentRecords = after.cuts.map(cut => ({ header: cut.header, live: this.access.isLive(cut.header.id), persisted: true }))
    const currentPermission = await this.access.authorize(currentRecords, signal)
    assertAuthorization(currentPermission)
    signal.throwIfAborted()
    if (viewIdentity(before) !== viewIdentity(after) || currentPermission.principal !== permission.principal
      || currentPermission.revision !== permission.revision
      || fingerprint([...currentPermission.sessionIds].sort(byteCompare)) !== fingerprint([...permission.sessionIds].sort(byteCompare))
      || fingerprint(records.map(record => record.live)) !== fingerprint(currentRecords.map(record => record.live))) {
      if (cursor !== undefined) throw stale()
      throw new SessionQueryError('Search inputs changed; repeat the search.', 'SESSION_QUERY_SOURCE_CONFLICT')
    }
    return { items: page, records: selected, nextCursor }
  }

  private hit(item: Ranked): SessionEventSearchHit {
    const { text: _text, record: _record, ...event } = item.candidate
    const characters = Array.from(item.candidate.text)
    const maximum = this.limits.snippetChars
    if (characters.length <= maximum) return { ...event, snippet: characters.join('') }
    if (maximum === 1) return { ...event, snippet: '…' }
    const start = Math.max(0, item.matchIndex - Math.floor(maximum / 3))
    const prefix = start > 0 ? '…' : ''
    const tail = characters.slice(start, start + maximum - prefix.length - 1).join('')
    return { ...event, snippet: prefix + tail + '…' }
  }

  private encode(cursor: Cursor): SessionSearchCursor {
    const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url')
    return SessionSearchCursor(payload + '.' + createHmac('sha256', this.secret).update(payload).digest('base64url'))
  }

  private decode(value: SessionSearchCursor, binding: string): Cursor {
    if (typeof value !== 'string' || value.length > 8192) throw invalidCursor()
    const parts = value.split('.')
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalidCursor()
    const signature = Buffer.from(parts[1], 'base64url')
    const expected = createHmac('sha256', this.secret).update(parts[0]).digest()
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw stale()
    let parsed: unknown
    try { parsed = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) }
    catch (_error) { throw invalidCursor() }
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1 || !('binding' in parsed)
      || !('after' in parsed) || !Array.isArray(parsed.after) || parsed.after.length !== 5
      || parsed.after.some((value, index) => index === 3 ? typeof value !== 'string' : !Number.isSafeInteger(value))) throw invalidCursor()
    if (parsed.binding !== binding) throw stale()
    return parsed as Cursor
  }
}

function tuple(item: Ranked): Cursor['after'] {
  return [item.matches, item.length, item.candidate.time, item.candidate.sessionId, item.candidate.seq]
}
function compare(left: Ranked, right: Ranked): number {
  return right.matches - left.matches || left.length - right.length || right.candidate.time - left.candidate.time
    || byteCompare(left.candidate.sessionId, right.candidate.sessionId) || right.candidate.seq - left.candidate.seq
}
function byteCompare(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)) }
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function viewIdentity(view: SearchView): string {
  return fingerprint({ ...view, cuts: view.cuts.map(cut => ({ ...cut, lifecycle: Buffer.from(cut.lifecycle).toString('hex') })) })
}
function canonicalFilters(filters: readonly (SessionResultFilter | SessionEventMetadataFilter)[]): string[] {
  return filters.map(filter => JSON.stringify('values' in filter
    ? { ...filter, values: [...filter.values].sort() } : filter)).sort()
}
function assertAuthorization(value: SearchAuthorization): void {
  if (!value.principal || !value.revision) throw new MysqlSearchError('ACCESS_UNAVAILABLE')
}
function metadata(filters: readonly SessionEventMetadataFilter[]): SessionEventMetadataFilter[] {
  const values = materializeSessionEventResultFilters(filters)
  for (const value of values) if (value.kind === 'text') throw new SessionQueryError('Search accepts metadata predicates only.', 'SESSION_QUERY_INVALID_FILTER')
  return values as SessionEventMetadataFilter[]
}
function normalizeQuery(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !value.isWellFormed()) {
    throw new SessionQueryError('Search requires nonempty well-formed Unicode text without NUL.', 'SESSION_QUERY_INVALID_QUERY')
  }
  return value.trim().replace(/\s+/gu, ' ')
}
/**
 * @param query - Normalized literal text.
 * @returns Whether recall can use a configured bigram without excluding literal hits.
 */
export function hasNgram(query: string): boolean { return /[A-Za-z0-9\p{Unified_Ideograph}]{2}/u.test(query) }
function stale(): SessionQueryError { return new SessionQueryError('Search cursor is stale; restart from page one.', 'SESSION_QUERY_STALE_CURSOR') }
function invalidCursor(): SessionQueryError { return new SessionQueryError('Search cursor is invalid.', 'SESSION_QUERY_INVALID_CURSOR') }
