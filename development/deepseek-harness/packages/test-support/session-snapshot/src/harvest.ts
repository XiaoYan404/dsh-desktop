/** Session artifact collection from raw JSONL directories or a live persistence observer. */

import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { SessionFormatUnsupportedError, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { assertPersistedSessionVersion, latestPersistedSessionPaths } from './session-files.ts'

/** One collected Session artifact and its immutable identifying metadata. */
export interface HarvestedLog {
  /** Recorded Session identity from its header. */
  id: string
  /** Creation time used to order children. */
  createdAt: number
  /** Parent identity when the Session is a subagent child. */
  parentSession?: string
  /** Original raw JSONL bytes as text, or a current-format artifact encoded from a service read. */
  content: string
}

/** Read-only operations needed from a separately owned persistence observer. */
export type SessionLogPersistence = Pick<SessionPersistence, 'list' | 'open'>

/** A raw JSONL sessions root or a live observer containing only this scenario's Sessions. */
export type SessionLogSource = string | SessionLogPersistence

/**
 * Collect complete Session artifacts, primary first, then children by creation time and identity.
 * Directory reads retain exact raw bytes and select the highest canonical physical generation.
 * Service reads require the provider's typed current logical header and events, then encode that
 * generation; they never flush writers, acquire write ownership, or fall back after a service failure.
 * Every opened read handle is closed, including when reading or encoding fails. Concurrent read
 * and close failures are retained in an AggregateError. The caller owns the observer's lifetime
 * and isolates its store; collection does not discover or select another backend or store.
 * @param source - Raw JSONL sessions root, or a live scenario-specific persistence observer.
 * @returns Complete artifacts ordered consistently with replay's child fixture order.
 */
export async function harvestSessionLogs(source: SessionLogSource): Promise<HarvestedLog[]> {
  const logs = typeof source === 'string'
    ? await harvestDirectory(source)
    : await harvestPersistence(source)
  return logs.sort((a, b) => Number(a.parentSession !== undefined) - Number(b.parentSession !== undefined)
    || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

async function harvestDirectory(root: string): Promise<HarvestedLog[]> {
  let files: string[]
  try {
    files = await readdir(root, { recursive: true })
  } catch (_error) {
    // Directory collection retains the existing empty result for an unavailable sessions root.
    return []
  }
  const logs: HarvestedLog[] = []
  for (const file of latestPersistedSessionPaths(files)) {
    const content = await readFile(join(root, file), 'utf8')
    assertPersistedSessionVersion(basename(file), content)
    /* v8 ignore next -- the generation validator above rejects header-less content. */
    const firstLine = content.split('\n').find(line => line.trim().length > 0) ?? '{}'
    const header = JSON.parse(firstLine) as { id?: unknown; createdAt?: unknown; parentSession?: unknown }
    logs.push({
      id: typeof header.id === 'string' ? header.id : '',
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
      ...typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {},
      content,
    })
  }
  return logs
}

async function harvestPersistence(persistence: SessionLogPersistence): Promise<HarvestedLog[]> {
  if (sessionFormatCatalog.currentVersion !== SESSION_FORMAT_VERSION) {
    throw new SessionFormatUnsupportedError('snapshot-harness: Session format catalog and current writer disagree')
  }
  const logs: HarvestedLog[] = []
  for (const snapshot of await persistence.list()) {
    const handle = await persistence.open(snapshot.header.id, 'read')
    const reading = await (async (): Promise<HarvestedLog> => {
      const header = handle.header
      const { events } = await handle.read()
      const lines = [JSON.stringify(sessionFormatCatalog.encodeCurrentHeader(
        { ...header, delegationDepth: header.delegationDepth ?? 0 }, handle.inheritedEventCount,
      ))]
      for (const event of events) {
        // Durable waiters inspect type-first physical records; SQL JSON object key order may differ.
        const { type, ...rest } = event
        const ordered = { type, ...rest } as SessionFormatEvent
        lines.push(JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(ordered)))
      }
      return {
        id: header.id,
        createdAt: header.createdAt,
        ...header.parentSession !== undefined ? { parentSession: header.parentSession } : {},
        content: `${lines.join('\n')}\n`,
      }
    })().then(
      value => ({ status: 'fulfilled', value } as const),
      (error: unknown) => ({ status: 'rejected', error } as const),
    )
    const [closing] = await Promise.allSettled([handle.close()])
    if (reading.status === 'rejected') {
      if (closing.status === 'rejected') {
        throw new AggregateError([reading.error, closing.reason], `snapshot-harness: session "${handle.id}" read and close failed`)
      }
      throw reading.error
    }
    if (closing.status === 'rejected') throw closing.reason
    logs.push(reading.value)
  }
  return logs
}
