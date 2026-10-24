/** Compare R7 CHECK expressions without discarding boolean grouping or literal case. */
import { MysqlError } from './error.ts'

type Node = string | readonly Node[]
const precedence: Readonly<Record<string, number>> = { or: 1, and: 2, '=': 3, '<>': 3, '<': 3, '>': 3, '<=': 3, '>=': 3,
  in: 3, is: 3, '+': 4, '-': 4 }

function invalid(): never {
  throw new MysqlError('schema_incomplete', 'A MySQL CHECK expression is unrecognized or differs from the bundled schema. Preserve the database for inspection.')
}

/** Canonical expression tree for the SQL subset present in the immutable R7 assets.
 * @param source - Bundled expression or Oracle MySQL 8.4 information_schema rendering.
 * @returns A grouping-preserving representation; unknown syntax refuses verification.
 */
export function canonicalMysqlCheck(source: string): string {
  const unescaped = source.replace(/_(utf8mb4|ascii)(?:\\'([^']*)\\'|'([^']*)')/g,
    (_match: string, charset: string, escaped?: string, plain?: string) => {
      const literal = escaped ?? plain
      if (literal === undefined || (charset === 'ascii' && /[^\u0000-\u007f]/u.test(literal))) invalid()
      return "'" + literal + "'"
    })
  const pattern = /\s+|`[^`]+`|'(?:''|[^'])*'|[A-Za-z_][A-Za-z_0-9]*|\d+|<>|<=|>=|[(),+=<>-]/gy
  const tokens: string[] = []
  let offset = 0
  while (offset < unescaped.length) {
    pattern.lastIndex = offset
    const match = pattern.exec(unescaped)
    if (!match) invalid()
    const token = match[0]
    offset = pattern.lastIndex
    if (!/^\s/u.test(token)) tokens.push(token.startsWith("'") ? token : token.replaceAll('`', '').toLowerCase())
  }
  let cursor = 0
  const take = (): string => { const token = tokens[cursor++]; return token ?? invalid() }
  const expect = (wanted: string): void => { if (take() !== wanted) invalid() }
  const primary = (): Node => {
    const token = take()
    if (token === '(') { const value = parse(0); expect(')'); return value }
    if (token === '-') return ['neg', primary()]
    if (token.startsWith("'") || /^\d+$/u.test(token)) return token
    if (!/^[a-z_][a-z_0-9]*$/u.test(token)) invalid()
    if (tokens[cursor] !== '(') return token
    cursor++
    if (token === 'cast') {
      const value = parse(0)
      expect('as')
      let type = take()
      if (type === 'char') { expect('charset'); expect('binary'); type = 'binary' }
      if (type !== 'unsigned' && type !== 'binary') invalid()
      expect(')')
      return ['cast', value, type]
    }
    const args: Node[] = []
    if (tokens[cursor] !== ')') {
      args.push(parse(0))
      while (tokens[cursor] === ',') { cursor++; args.push(parse(0)) }
    }
    expect(')')
    return [token === 'octet_length' ? 'length' : token, ...args]
  }
  const parse = (minimum: number): Node => {
    let left = primary()
    while (cursor < tokens.length) {
      const operator = tokens[cursor]
      const priority = operator === undefined ? undefined : precedence[operator]
      if (operator === undefined || priority === undefined || priority < minimum) break
      cursor++
      if (operator === 'in') {
        expect('(')
        const values: Node[] = [parse(0)]
        while (tokens[cursor] === ',') { cursor++; values.push(parse(0)) }
        expect(')')
        left = ['in', left, values]
      } else if (operator === 'is') {
        const negate = tokens[cursor] === 'not'
        if (negate) cursor++
        expect('null')
        left = [negate ? 'is-not-null' : 'is-null', left]
      } else { left = [operator, left, parse(priority + 1)] }
    }
    return left
  }
  const value = parse(0)
  if (cursor !== tokens.length) invalid()
  return JSON.stringify(value)
}

/** Extract exactly the balanced CHECK expressions, including nested function calls.
 * @param source - One bundled CREATE/ALTER body.
 * @returns Constraint names and their full source expressions.
 */
export function mysqlChecks(source: string): Array<{ name: string; expression: string }> {
  return [...source.matchAll(/CONSTRAINT (\w+) CHECK\s*\(/g)].map((match) => {
    const name = match[1]
    if (!name) invalid()
    const start = match.index + match[0].length
    let depth = 1
    let quoted = false
    for (let offset = start; offset < source.length; offset++) {
      const char = source[offset]
      if (char === "'") {
        if (quoted && source[offset + 1] === "'") { offset++; continue }
        quoted = !quoted
      }
      if (!quoted && char === '(') depth++
      if (!quoted && char === ')' && --depth === 0) return { name, expression: source.slice(start, offset) }
    }
    return invalid()
  })
}
