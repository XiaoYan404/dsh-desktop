/** One atomic, revision-fenced profile document; never writes native Session generations. */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { OfficeExperienceDocument } from './types.ts'
import { parseOfficeExperienceDocument } from './validation.ts'

/** Durable local configuration shared by the profile's windows. */
export class OfficeExperienceRepository {
  /** @param filename - Profile-owned absolute destination supplied by the Host. */
  constructor(private readonly filename: string) {}

  /** @returns A validated committed document; only ENOENT means an empty new configuration. */
  async read(): Promise<OfficeExperienceDocument> {
    let text: string
    try { text = await readFile(this.filename, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { format: 1, revision: 0, accounts: [] }
    }
    if (Buffer.byteLength(text, 'utf8') > 8 * 1024 * 1024) throw new Error('invalid')
    return parseOfficeExperienceDocument(JSON.parse(text))
  }

  /**
   * Commit one configuration only after revision and current authority are rechecked.
   * @param revision - Caller-observed file revision.
   * @param change - Pure edit over the current valid document.
   * @param authorize - Revalidate the captured account immediately before persistence.
   * @returns The complete committed successor document.
   */
  async update(revision: number, change: (current: OfficeExperienceDocument) => OfficeExperienceDocument,
    authorize: () => Promise<void>): Promise<OfficeExperienceDocument> {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    return withFileLock(this.filename, async () => {
      const current = await this.read()
      if (revision !== current.revision) throw new Error('conflict')
      const next = parseOfficeExperienceDocument({ ...change(current), revision: current.revision + 1 })
      const text = `${JSON.stringify(next, null, 2)}\n`
      if (Buffer.byteLength(text, 'utf8') > 8 * 1024 * 1024) throw new Error('invalid')
      await authorize()
      await writeFileAtomic(this.filename, text, { mode: 0o600 })
      return next
    })
  }
}
