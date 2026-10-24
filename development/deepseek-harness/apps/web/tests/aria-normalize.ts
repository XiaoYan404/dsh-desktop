/** Portable filesystem identities in Playwright's JSON-quoted and plain ARIA text. */
export type AriaReplacement = readonly [value: string, token: string]

const quotedText = /"(?:[^"\\]|\\.)*"/g
const pathSeparator = /[\\/]$/
const pathBoundary = /[\s"'`;:<>()\[\]{}]/

function replacePath(text: string, root: string, token: string): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(root)
  const variants = new Set([root, root.replaceAll('\\', '/')])
  if (windows && /^[A-Za-z]:/.test(root)) {
    for (const value of [...variants]) variants.add(value[0]!.toLowerCase() + value.slice(1))
  }
  for (const value of variants) {
    let cursor = 0
    while (cursor < text.length) {
      const start = text.indexOf(value, cursor)
      if (start < 0) break
      const end = start + value.length
      const next = text[end]
      if (next !== undefined && next !== '\\' && next !== '/' && !pathSeparator.test(value) && !pathBoundary.test(next)) {
        cursor = end
        continue
      }
      let tailEnd = end
      if (next === '\\' || next === '/' || pathSeparator.test(value)) {
        const before = text[start - 1]
        const quote = before === '"' || before === "'" ? before : undefined
        while (tailEnd < text.length && (quote === undefined ? !/[\s"'`;<>]/.test(text[tailEnd]!) : text[tailEnd] !== quote)) tailEnd++
      }
      let tail = text.slice(end, tailEnd)
      if (windows) tail = tail.replaceAll('\\', '/')
      const replacement = token + (tail && pathSeparator.test(value) ? '/' : '') + tail
      text = text.slice(0, start) + replacement + text.slice(tailEnd)
      cursor = start + replacement.length
    }
  }
  return text
}

/**
 * Replace known roots before comparing a browser snapshot, keeping other text intact.
 * @param snapshot - Playwright ARIA text, whose quoted values escape Windows separators.
 * @param workspaceCwd - Absolute workspace directory, in either platform's spelling.
 * @param replacements - Scenario-owned text or path identities, applied before the workspace.
 * @returns Portable ARIA with the original quoting and unrelated backslashes preserved.
 */
export function normalizeAriaPaths(snapshot: string, workspaceCwd: string, replacements: readonly AriaReplacement[] = []): string {
  const base = workspaceCwd.replaceAll('\\', '/').replace(/\/$/, '').split('/').pop()!
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const basenamePattern = base ? new RegExp(`(?<![{\\p{L}\\p{N}_.-])${escapedBase}(?![}\\p{L}\\p{N}_.-])`, 'gu') : null
  const targets: readonly AriaReplacement[] = [...replacements, [workspaceCwd, '{{cwd}}']]
  const plain = (value: string): string => {
    for (const [source, token] of targets) {
      if (!source) continue
      value = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(source) ? replacePath(value, source, token) : value.split(source).join(token)
    }
    return basenamePattern === null ? value : value.replace(basenamePattern, '{{workspace}}')
  }
  let cursor = 0
  const chunks: string[] = []
  for (const match of snapshot.matchAll(quotedText)) {
    chunks.push(plain(snapshot.slice(cursor, match.index)))
    const literal = match[0]
    try {
      const decoded = JSON.parse(literal) as string
      const normalized = plain(decoded)
      chunks.push(normalized === decoded ? literal : JSON.stringify(normalized))
    } catch { chunks.push(plain(literal)) }
    cursor = match.index + literal.length
  }
  chunks.push(plain(snapshot.slice(cursor)))
  return chunks.join('')
}
