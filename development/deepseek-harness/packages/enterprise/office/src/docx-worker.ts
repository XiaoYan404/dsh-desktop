/** Static isolate source keeps document content out of Host imports, code execution and attachment caches. */

/** Only standard DOCX main-document XML is decoded; relationships never cause external reads. */
export const officeDocxWorkerSource = String.raw`
import { parentPort, workerData as input } from 'node:worker_threads'
const { unzipSync } = await import(input.zipModuleUrl)
const { XMLParser, XMLValidator } = await import(input.xmlModuleUrl)
const wordNamespaces = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main'])
const selectedParts = new Set(['[Content_Types].xml', '_rels/.rels', 'word/document.xml'])
let visited = 0
let characters = 0
let paragraphCount = 0
let tableCount = 0
function limit() { throw new Error('context_too_large') }
function invalid() { throw new Error('invalid_input') }
function xml(bytes) {
  if (!bytes || bytes.length > input.policy.maxXmlBytes) {
    if (!bytes) invalid()
    limit()
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text) || XMLValidator.validate(text) !== true) invalid()
  return new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false,
    trimValues: false, processEntities: true, ignoreDeclaration: true }).parse(text)
}
function element(node, inherited = {}) {
  if (++visited > input.policy.maxNodes) limit()
  const tag = Object.keys(node).find(key => key !== ':@' && key !== '#text' && !key.startsWith('?'))
  if (!tag) return null
  const namespaces = { ...inherited }
  const attributes = node[':@'] || {}
  for (const [key, value] of Object.entries(attributes)) {
    if (key === '@_xmlns') namespaces[''] = value
    else if (key.startsWith('@_xmlns:')) Object.defineProperty(namespaces, key.slice(8), { value, enumerable: true })
  }
  const index = tag.indexOf(':')
  const prefix = index < 0 ? '' : tag.slice(0, index)
  return { local: index < 0 ? tag : tag.slice(index + 1), uri: namespaces[prefix],
    children: node[tag], namespaces, attributes }
}
function childElements(nodes, inherited) {
  const result = []
  for (const node of nodes || []) {
    const value = element(node, inherited)
    if (value) result.push(value)
  }
  return result
}
function word(value, local) { return wordNamespaces.has(value.uri) && value.local === local }
function append(text) {
  characters += text.length
  if (characters > input.policy.maxTextCharacters) limit()
  return text
}
function join(values, separator) {
  characters += Math.max(0, values.length - 1) * separator.length
  if (characters > input.policy.maxTextCharacters) limit()
  return values.join(separator)
}
function inline(nodes, inherited) {
  let result = ''
  for (const value of childElements(nodes, inherited)) {
    if (!wordNamespaces.has(value.uri)) continue
    if (['del', 'moveFrom', 'instrText', 'delText', 'drawing', 'pict', 'object'].includes(value.local)) continue
    if (value.local === 't') {
      for (const node of value.children) {
        if (++visited > input.policy.maxNodes) limit()
        if (typeof node['#text'] === 'string') result += append(node['#text'])
      }
    } else if (value.local === 'tab') result += append('\t')
    else if (value.local === 'br' || value.local === 'cr') result += append('\n')
    else result += inline(value.children, value.namespaces)
  }
  return result
}
function blocks(nodes, inherited) {
  const output = []
  for (const value of childElements(nodes, inherited)) {
    if (!wordNamespaces.has(value.uri)) continue
    if (word(value, 'p')) { paragraphCount++; output.push(inline(value.children, value.namespaces)) }
    else if (word(value, 'tbl')) {
      tableCount++
      const rows = []
      for (const row of childElements(value.children, value.namespaces)) {
        if (!word(row, 'tr')) continue
        const cells = []
        for (const cell of childElements(row.children, row.namespaces)) {
          if (!word(cell, 'tc')) continue
          const cellBlocks = blocks(cell.children, cell.namespaces)
          cells.push(join(cellBlocks, '\n'))
        }
        rows.push(join(cells, '\t'))
      }
      output.push(join(rows, '\n'))
    } else if (!['del', 'moveFrom', 'sectPr', 'altChunk', 'drawing', 'pict', 'object'].includes(value.local)) {
      output.push(...blocks(value.children, value.namespaces))
    }
  }
  return output
}
try {
  let entryCount = 0
  let inflatedBytes = 0
  const names = new Set()
  // A metadata-only pass rejects the complete archive before decompressing any selected part.
  unzipSync(input.data, { filter(entry) {
    entryCount++
    inflatedBytes += entry.originalSize
    if (entryCount > input.policy.maxArchiveEntries || inflatedBytes > input.policy.maxInflatedBytes) limit()
    if (names.has(entry.name) || /(^[\\/]|\\|(^|\/)\.\.(\/|$)|\0)/.test(entry.name)) invalid()
    names.add(entry.name)
    if (selectedParts.has(entry.name) && entry.originalSize > input.policy.maxXmlBytes) limit()
    return false
  } })
  const parts = unzipSync(input.data, { filter: entry => selectedParts.has(entry.name) })
  const types = childElements(xml(parts['[Content_Types].xml']))
  if (types.length !== 1 || types[0].local !== 'Types'
    || types[0].uri !== 'http://schemas.openxmlformats.org/package/2006/content-types') invalid()
  const overrides = childElements(types[0].children, types[0].namespaces)
  if (!overrides.some(value => value.local === 'Override' && value.uri === types[0].uri
    && value.attributes['@_PartName'] === '/word/document.xml'
    && value.attributes['@_ContentType'] === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')) invalid()
  const relationships = childElements(xml(parts['_rels/.rels']))
  if (relationships.length !== 1 || relationships[0].local !== 'Relationships'
    || relationships[0].uri !== 'http://schemas.openxmlformats.org/package/2006/relationships') invalid()
  const main = childElements(relationships[0].children, relationships[0].namespaces).filter(value => value.local === 'Relationship'
    && value.uri === relationships[0].uri &&
    ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
      'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument'].includes(value.attributes['@_Type']))
  if (main.length !== 1 || main[0].attributes['@_TargetMode'] === 'External'
    || !['word/document.xml', '/word/document.xml'].includes(main[0].attributes['@_Target'])) invalid()
  const root = childElements(xml(parts['word/document.xml']))
  if (root.length !== 1 || !word(root[0], 'document')) invalid()
  const bodies = childElements(root[0].children, root[0].namespaces).filter(value => word(value, 'body'))
  if (bodies.length !== 1) invalid()
  const output = blocks(bodies[0].children, bodies[0].namespaces)
  const text = join(output, '\n')
  if (text.length > input.policy.maxTextCharacters) limit()
  parentPort.postMessage({ ok: true, text, paragraphCount, tableCount })
} catch (error) {
  parentPort.postMessage({ ok: false, code: error instanceof Error && error.message === 'context_too_large'
    ? 'context_too_large' : 'invalid_input' })
}
`
