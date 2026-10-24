/** Derive a searchable view of native catalog membership without replacing its authority. */
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { recordValue } from './values.ts'

/** Display-only row; native summaries and item aliases remain under their existing owners. */
export interface OfficeSessionRow {
  readonly session: SessionSummary
  readonly label: string
}

/**
 * Keep native subagent views out of employee Conversation history and ordinary return targets.
 * @param session - Native catalog entry, when present.
 * @returns Whether this entry can represent an employee's ordinary or item input.
 */
export function isOfficeConversation(session: SessionSummary | undefined): session is SessionSummary {
  return session !== undefined && session.origin !== 'subagent' && !session.parentId
}

/**
 * Search ordinary, unarchived Sessions by their native title, authorized item alias or Workspace path.
 * @param state - Framework-provided native catalog snapshot.
 * @param archived - Current native Workspace archive set.
 * @param query - Reader's literal case-insensitive filter.
 * @param titles - Current employee's authorized item labels, keyed by native Session id.
 * @returns Stable newest-first rows without mutating the native list.
 */
export function officeSessionRows(
  state: SessionListState, archived: readonly SessionId[], query: string, titles: Readonly<Record<string, string>>,
): readonly OfficeSessionRow[] {
  const hidden = new Set(archived)
  const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase()
  const needle = normalize(query.trim())
  return state.ids.flatMap((id) => {
    const session = recordValue(state.byId, id)
    if (!isOfficeConversation(session) || hidden.has(id)) return []
    const label = recordValue(titles, id) ?? session.displayTitle
    if (needle && ![label, session.displayTitle, session.cwd ?? ''].some(text => normalize(text).includes(needle))) return []
    return [{ session, label }]
  }).sort((left, right) => right.session.updatedAt - left.session.updatedAt || left.session.id.localeCompare(right.session.id))
}
