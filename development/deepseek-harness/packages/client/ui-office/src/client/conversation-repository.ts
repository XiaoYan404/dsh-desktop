/** Same-origin IndexedDB transactions serialize navigation updates across windows and processes. */
import {
  legacyOfficeNavigation, OFFICE_NAVIGATION_DATABASE, OFFICE_NAVIGATION_SIGNAL_KEY, parseOfficeNavigationRecord,
} from './conversation-data.ts'
import type { OfficeNavigationData, OfficeNavigationRecord } from './conversation-data.ts'

const storeName = 'navigation'
const recordKey = 'current'

function navigationError(message: string, cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(message, { cause })
}

/** A committed index and the independent outcome of notifying other windows. */
export interface OfficeNavigationCommit {
  readonly record: OfficeNavigationRecord
  readonly notified: boolean
}

function abortTransaction(transaction: IDBTransaction): void {
  try { transaction.abort() }
  catch (error) {
    if (typeof error !== 'object' || error === null || !('name' in error) || error.name !== 'InvalidStateError') throw error
  }
}

/** Database handles and transactions remain private and close with their office plugin. */
export class OfficeNavigationRepository {
  private database: IDBDatabase | undefined
  private opening: Promise<IDBDatabase> | undefined
  private disposed = false
  private invalidated = false
  private readonly transactions = new Set<IDBTransaction>()

  constructor(private readonly changed: () => void = () => {}) {}

  /**
   * Read a complete generation after any earlier write in this object store.
   * @param signal - Employee/plugin lifetime.
   * @returns Committed navigation.
   */
  read(signal: AbortSignal): Promise<OfficeNavigationCommit> {
    return this.access(undefined, signal)
  }

  /**
   * Read and conditionally replace one generation in an exclusive read/write transaction.
   * @param edit - Synchronous typed edit; returning the same object performs no write.
   * @param signal - Employee/plugin lifetime.
   * @returns Acknowledgement only after transaction completion.
   */
  update(edit: (data: OfficeNavigationData) => OfficeNavigationData, signal: AbortSignal): Promise<OfficeNavigationCommit> {
    return this.access(edit, signal)
  }

  /** Abort owned work, close connections, and close any connection delivered after unload. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const transaction of this.transactions) abortTransaction(transaction)
    this.database?.close()
    this.database = undefined
  }

  private async access(edit: ((data: OfficeNavigationData) => OfficeNavigationData) | undefined,
    signal: AbortSignal): Promise<OfficeNavigationCommit> {
    signal.throwIfAborted()
    const database = await this.open()
    signal.throwIfAborted()
    if (this.disposed) throw new DOMException('Office navigation was disposed', 'AbortError')
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, edit ? 'readwrite' : 'readonly', { durability: 'strict' })
      this.transactions.add(transaction)
      let failure: unknown
      let result: OfficeNavigationRecord | undefined
      let wrote = false
      const abort = () => { failure = signal.reason; abortTransaction(transaction) }
      const cleanup = () => {
        signal.removeEventListener('abort', abort)
        this.transactions.delete(transaction)
      }
      signal.addEventListener('abort', abort, { once: true })
      transaction.onabort = () => {
        cleanup()
        reject(navigationError('Office navigation transaction was aborted', failure ?? transaction.error))
      }
      transaction.oncomplete = () => {
        cleanup()
        if (!result) { reject(new Error('Office navigation transaction returned no record')); return }
        let notified = true
        if (wrote) {
          try { localStorage.setItem(OFFICE_NAVIGATION_SIGNAL_KEY, String(result.revision)) }
          catch { notified = false }
        }
        resolve({ record: result, notified })
      }
      const store = transaction.objectStore(storeName)
      const request = store.get(recordKey)
      request.onsuccess = () => {
        try {
          signal.throwIfAborted()
          const raw: unknown = request.result
          const current = parseOfficeNavigationRecord(raw)
          const data = edit?.(current.data) ?? current.data
          result = current
          if (data === current.data) return
          if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error('Office navigation revision is exhausted')
          result = { formatVersion: 1, revision: current.revision + 1, data }
          store.put(result, recordKey)
          wrote = true
        } catch (error) {
          failure = error
          abortTransaction(transaction)
        }
      }
      request.onerror = () => { failure = request.error }
    })
  }

  private open(): Promise<IDBDatabase> {
    if (this.disposed) return Promise.reject(new DOMException('Office navigation was disposed', 'AbortError'))
    if (this.invalidated) return Promise.reject(new Error('Office navigation database changed; reload the application'))
    if (this.database) return Promise.resolve(this.database)
    if (this.opening) return this.opening
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(OFFICE_NAVIGATION_DATABASE, 1)
      let failure: unknown
      let rejected = false
      request.onblocked = () => {
        rejected = true
        reject(new Error('Office navigation database is blocked by another connection'))
      }
      request.onupgradeneeded = () => {
        try {
          if (this.disposed) throw new DOMException('Office navigation was disposed', 'AbortError')
          const store = request.result.createObjectStore(storeName)
          store.add({ formatVersion: 1, revision: 0, data: legacyOfficeNavigation() } satisfies OfficeNavigationRecord, recordKey)
        } catch (error) {
          failure = error
          if (request.transaction) abortTransaction(request.transaction)
        }
      }
      request.onerror = () => { reject(navigationError('Office navigation database could not open', failure ?? request.error)) }
      request.onsuccess = () => {
        const database = request.result
        if (this.disposed || rejected) {
          database.close()
          reject(new DOMException('Office navigation open was cancelled', 'AbortError'))
          return
        }
        if (!database.objectStoreNames.contains(storeName)) {
          database.close()
          reject(new Error('Office navigation database has no initialized store'))
          return
        }
        database.onversionchange = () => {
          database.close()
          this.invalidated = true
          if (this.database === database) { this.database = undefined; this.opening = undefined }
          this.changed()
        }
        this.database = database
        resolve(database)
      }
    })
    this.opening = opening
    void opening.catch(() => { if (this.opening === opening) this.opening = undefined })
    return opening
  }
}
