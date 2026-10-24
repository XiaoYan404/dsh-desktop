/** Small value operations shared by office models and form drafts. */

/**
 * Read only an explicitly stored dictionary entry, including employee ids that name prototype properties.
 * @param record - Immutable account/contact lookup.
 * @param key - Directory-issued identity.
 * @returns Its own value, or undefined when no entry has been stored.
 */
export function recordValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

/**
 * Omit a dynamic record key without mutating an observable snapshot.
 * @param record - Current immutable lookup.
 * @param key - Key to remove.
 * @returns A new lookup containing the other entries.
 */
export function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => candidate !== key))
}

/**
 * Read text fields without converting a File into a misleading object string.
 * @param data - Submitted form values.
 * @param key - Text input name.
 * @returns Original text, or empty text for a missing or non-text value.
 */
export function formText(data: FormData, key: string): string {
  const value = data.get(key)
  return typeof value === 'string' ? value : ''
}

/**
 * Keep a supplementary Unicode character whole when a name supplies an avatar initial.
 * @param name - Confirmed employee display name.
 * @returns The first Unicode code point, or empty text for an empty name.
 */
export function avatarInitial(name: string): string {
  return name[Symbol.iterator]().next().value ?? ''
}
