/** Static workbook isolate preflights complete archives and preserves raw saved values before ExcelJS decoding. */

/** XLSX relationships never trigger external reads, macro execution or formula recalculation. */
export const officeXlsxWorkerSource = String.raw`
import { parentPort, workerData as input } from 'node:worker_threads'
const { unzipSync, zipSync } = await import(input.zipModuleUrl)
const { XMLParser, XMLValidator } = await import(input.xmlModuleUrl)
const namespaces = new Set(['http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main'])
const relationshipNamespaces = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships'])
const packageNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships'
const contentNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types'
const relationshipPrefix = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
let visited = 0
let storedCells = 0
let characters = 0
function invalid() { throw new Error('invalid_input') }
function limit() { throw new Error('context_too_large') }
function key(path) { return path.replace(/[A-Z]/g, character => character.toLowerCase()) }
function bool(value) {
  if (value === undefined || value === '0' || value === 'false') return false
  if (value === '1' || value === 'true') return true
  invalid()
}
function boundedText(value) {
  if (value !== null) characters += value.length
  if (characters > input.policy.maxTextCharacters) limit()
  return value
}
function element(node, inherited = new Map()) {
  const tag = Object.keys(node).find(name => name !== ':@' && name !== '#text' && !name.startsWith('?'))
  if (!tag) return null
  const scope = new Map(inherited)
  const attributes = node[':@'] || {}
  for (const [name, value] of Object.entries(attributes)) {
    if (name === '@_xmlns') scope.set('', value)
    else if (name.startsWith('@_xmlns:')) scope.set(name.slice(8), value)
  }
  const index = tag.indexOf(':')
  return { local: index < 0 ? tag : tag.slice(index + 1), uri: scope.get(index < 0 ? '' : tag.slice(0, index)),
    children: node[tag], attributes, scope }
}
function children(value) {
  return (value.children || []).map(node => element(node, value.scope)).filter(Boolean)
}
function named(value, name) { return namespaces.has(value.uri) && value.local === name }
function selected(value, name) { return children(value).filter(child => named(child, name)) }
function text(value) {
  let result = ''
  for (const node of value.children || []) {
    if (typeof node['#text'] === 'string') result += node['#text']
    else invalid()
  }
  return result
}
function richText(value) {
  return children(value).filter(child => named(child, 't') || named(child, 'r')).map(child =>
    named(child, 't') ? text(child) : selected(child, 't').map(text).join('')).join('')
}
function xml(bytes) {
  const encoding = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)
    ? 'utf-16le' : (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c) ? 'utf-16be' : 'utf-8'
  const source = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source) || XMLValidator.validate(source) !== true) invalid()
  const parsed = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false,
    trimValues: false, processEntities: true, ignoreDeclaration: true }).parse(source)
  const pending = [...parsed]
  while (pending.length) {
    const node = pending.pop()
    if (++visited > input.policy.maxNodes) limit()
    for (const [name, value] of Object.entries(node)) {
      if (name !== ':@' && Array.isArray(value)) for (const child of value) pending.push(child)
    }
  }
  const roots = parsed.map(node => element(node)).filter(Boolean)
  if (roots.length !== 1) invalid()
  return roots[0]
}
function resolvePart(owner, target) {
  if (typeof target !== 'string' || !target || /[\\\0?#]/.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target)) invalid()
  const parts = target.startsWith('/') ? [] : owner.split('/').slice(0, -1)
  for (const part of target.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!parts.length) invalid(); parts.pop() }
    else parts.push(part)
  }
  return key(parts.join('/'))
}
function relationId(value) {
  const values = Object.entries(value.attributes).filter(([name]) => {
    const match = /^@_([^:]+):id$/.exec(name)
    return match && relationshipNamespaces.has(value.scope.get(match[1]))
  })
  if (values.length !== 1) invalid()
  return values[0][1]
}
function coordinate(address) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address || '')
  if (!match) invalid()
  let column = 0
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64
  const row = Number(match[2])
  if (column > 16384 || row > 1048576) invalid()
  return { address, row, column }
}
try {
  let entryCount = 0
  let inflatedBytes = 0
  const paths = new Set()
  unzipSync(input.data, { filter(entry) {
    if (++entryCount > input.policy.maxArchiveEntries) limit()
    inflatedBytes += entry.originalSize
    if (inflatedBytes > input.policy.maxInflatedBytes) limit()
    const path = key(entry.name)
    if (paths.has(path) || /(^[\\/]|\\|(^|\/)\.{1,2}(\/|$)|\0)/.test(path)) invalid()
    if (/vba|macrosheet|activex/i.test(path)) invalid()
    paths.add(path)
    if (/\.(xml|rels|vml)$/i.test(path) && entry.originalSize > input.policy.maxXmlBytes) limit()
    return false
  } })
  const parts = unzipSync(input.data, { filter: entry => /\.(xml|rels|vml)$/i.test(entry.name) })
  const roots = new Map(Object.entries(parts).map(([path, bytes]) => [key(path), xml(bytes)]))
  const relationships = new Map()
  for (const [path, root] of roots) {
    if (!path.endsWith('.rels')) continue
    if (root.local !== 'Relationships' || root.uri !== packageNamespace) invalid()
    const match = /^(.*\/)?_rels\/([^/]+)\.rels$/.exec(path)
    const owner = path === '_rels/.rels' ? '' : match ? (match[1] || '') + match[2] : null
    if (owner === null) invalid()
    const entries = new Map()
    for (const relation of children(root)) {
      if (relation.local !== 'Relationship' || relation.uri !== packageNamespace) invalid()
      const { '@_Id': id, '@_Type': originalType, '@_Target': target, '@_TargetMode': mode } = relation.attributes
      if (typeof id !== 'string' || entries.has(id) || typeof originalType !== 'string' || typeof target !== 'string') invalid()
      const type = originalType.replace('http://purl.oclc.org/ooxml/officeDocument/relationships/', relationshipPrefix)
      if (/vba|macro|activex|oleobject|externalLink|connections|queryTable/i.test(type)) invalid()
      if (mode !== undefined && mode !== 'Internal' && mode !== 'External') invalid()
      if (mode === 'External' && type !== relationshipPrefix + 'hyperlink') invalid()
      entries.set(id, { type, target: mode === 'External' || type === relationshipPrefix + 'hyperlink' ? null : resolvePart(owner, target) })
    }
    relationships.set(owner, entries)
  }
  const types = roots.get('[content_types].xml')
  if (!types || types.local !== 'Types' || types.uri !== contentNamespace) invalid()
  const contentTypes = new Map()
  for (const value of children(types)) {
    if (value.uri !== contentNamespace || !['Override', 'Default'].includes(value.local)) invalid()
    const type = value.attributes['@_ContentType']
    if (typeof type !== 'string' || /macro|vba|activex|oleobject|externalLink|connections|queryTable/i.test(type)) invalid()
    if (value.local === 'Override') {
      const path = resolvePart('', value.attributes['@_PartName'])
      if (contentTypes.has(path)) invalid()
      contentTypes.set(path, type)
    }
  }
  const mainRelations = [...(relationships.get('') || new Map()).values()].filter(value => value.type === relationshipPrefix + 'officeDocument')
  if (mainRelations.length !== 1) invalid()
  const workbookPath = mainRelations[0].target
  if (contentTypes.get(workbookPath) !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml') invalid()
  const root = roots.get(workbookPath)
  if (!root || !named(root, 'workbook')) invalid()
  const sheetContainers = selected(root, 'sheets')
  if (sheetContainers.length !== 1) invalid()
  const sheetDefinitions = selected(sheetContainers[0], 'sheet')
  if (sheetDefinitions.length === 0) invalid()
  if (sheetDefinitions.length > input.policy.maxWorksheets) limit()
  const properties = selected(root, 'workbookPr')
  if (properties.length > 1) invalid()
  const dateSystem = bool(properties[0]?.attributes['@_date1904']) ? '1904' : '1900'
  const workbookRelations = relationships.get(workbookPath) || new Map()
  const sharedRelations = [...workbookRelations.values()].filter(value => value.type === relationshipPrefix + 'sharedStrings')
  if (sharedRelations.length > 1) invalid()
  let sharedStrings = []
  if (sharedRelations.length) {
    const strings = roots.get(sharedRelations[0].target)
    if (!strings || !named(strings, 'sst')) invalid()
    sharedStrings = selected(strings, 'si').map(richText)
  }
  const seenNames = new Set()
  const seenIds = new Set()
  const seenParts = new Set()
  const sheets = sheetDefinitions.map((definition, order) => {
    const name = definition.attributes['@_name']
    const id = definition.attributes['@_sheetId']
    const state = definition.attributes['@_state'] || 'visible'
    if (typeof name !== 'string' || !name || name.length > 31 || seenNames.has(name.toLowerCase())
      || !/^[1-9]\d*$/.test(id || '') || Number(id) > 4294967295 || seenIds.has(id)
      || !['visible', 'hidden', 'veryHidden'].includes(state)) invalid()
    seenNames.add(name.toLowerCase()); seenIds.add(id); boundedText(name)
    const relation = workbookRelations.get(relationId(definition))
    if (!relation || relation.type !== relationshipPrefix + 'worksheet' || seenParts.has(relation.target)) invalid()
    seenParts.add(relation.target)
    const worksheet = roots.get(relation.target)
    if (!worksheet || !named(worksheet, 'worksheet')) invalid()
    const data = selected(worksheet, 'sheetData')
    if (data.length !== 1) invalid()
    const ranges = selected(worksheet, 'cols').flatMap(value => selected(value, 'col')).map(value => ({
      min: Number(value.attributes['@_min']), max: Number(value.attributes['@_max']), hidden: bool(value.attributes['@_hidden']) })).sort((a, b) => a.min - b.min)
    const hiddenColumns = new Set()
    let previousColumn = 0
    for (const range of ranges) {
      if (!Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min <= previousColumn
        || range.max < range.min || range.max > 16384) invalid()
      previousColumn = range.max
      if (range.hidden) for (let column = range.min; column <= range.max; column++) hiddenColumns.add(column)
    }
    const seenRows = new Set()
    const seenCells = new Set()
    const cells = []
    for (const row of selected(data[0], 'row')) {
      const number = Number(row.attributes['@_r'])
      if (!Number.isInteger(number) || number < 1 || number > 1048576 || seenRows.has(number)) invalid()
      seenRows.add(number)
      const hiddenRow = bool(row.attributes['@_hidden'])
      for (const source of selected(row, 'c')) {
        if (++storedCells > input.policy.maxCells) limit()
        const position = coordinate(source.attributes['@_r'])
        if (position.row !== number || seenCells.has(position.address)) invalid()
        seenCells.add(position.address)
        const values = selected(source, 'v')
        const formulae = selected(source, 'f')
        const inline = selected(source, 'is')
        if (values.length > 1 || formulae.length > 1 || inline.length > 1) invalid()
        const rawValue = values.length ? text(values[0]) : null
        const rawType = source.attributes['@_t'] || 'n'
        if (!['n', 's', 'str', 'inlineStr', 'b', 'e', 'd'].includes(rawType)) invalid()
        let formula = null
        if (formulae.length) {
          const value = formulae[0]
          const type = value.attributes['@_t'] || 'normal'
          if (!['normal', 'shared', 'array', 'dataTable'].includes(type)) invalid()
          formula = { text: boundedText(text(value)), type, sharedIndex: boundedText(value.attributes['@_si'] ?? null),
            range: boundedText(value.attributes['@_ref'] ?? null) }
        }
        const missing = rawValue === null || rawValue === '' && rawType !== 'str'
        let kind = 'blank'
        let value = null
        if (rawType === 'inlineStr') {
          if (formula || values.length || inline.length !== 1) invalid()
          kind = 'string'; value = richText(inline[0])
        } else if (!missing) {
          if (inline.length) invalid()
          if (rawType === 's') {
            if (formula || !/^\d+$/.test(rawValue)) invalid()
            const index = Number(rawValue)
            if (!Number.isSafeInteger(index) || index >= sharedStrings.length) invalid()
            kind = 'string'; value = sharedStrings[index]
          } else if (rawType === 'n') {
            if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(rawValue.trim())) invalid()
            kind = 'number'; value = rawValue
          } else if (rawType === 'b') {
            if (rawValue !== '0' && rawValue !== '1') invalid()
            kind = 'boolean'; value = rawValue === '1' ? 'true' : 'false'
          } else { kind = rawType === 'str' ? 'string' : rawType === 'd' ? 'iso_date' : 'error'; value = rawValue }
        }
        cells.push({ ...position, hiddenRow, hiddenColumn: hiddenColumns.has(position.column), kind,
          value: boundedText(value), rawValue: boundedText(rawValue), formula,
          cacheState: formula ? missing ? 'missing' : 'present_may_be_stale' : 'not_formula' })
      }
    }
    cells.sort((a, b) => a.row - b.row || a.column - b.column)
    return { number: order + 1, name, state, cells }
  })
  if (!Number.isInteger(input.input.sheetNumber) || input.input.sheetNumber < 1 || input.input.sheetNumber > sheets.length
    || !Number.isInteger(input.input.offset) || input.input.offset < 0
    || !Number.isInteger(input.input.maxCells) || input.input.maxCells < 1 || input.input.maxCells > 256) invalid()
  const selectedSheet = sheets[input.input.sheetNumber - 1]
  if (input.input.offset > selectedSheet.cells.length) invalid()
  const ExcelJS = (await import(input.excelModuleUrl)).default
  const workbook = new ExcelJS.Workbook()
  const omitted = new Set()
  for (const relations of relationships.values()) {
    for (const relation of relations.values()) if (relation.type === relationshipPrefix + 'drawing' && relation.target) {
      omitted.add(relation.target)
      const split = relation.target.lastIndexOf('/')
      omitted.add(relation.target.slice(0, split + 1) + '_rels/' + relation.target.slice(split + 1) + '.rels')
    }
  }
  for (const [path, value] of roots) {
    if (value.uri === 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
      || /^xl\/drawings\/(?:[^/]+\.xml|_rels\/[^/]+\.xml\.rels)$/i.test(path)) omitted.add(path)
  }
  // ExcelJS also discovers DrawingML outside worksheet drawing nodes; the bounded parser copy omits it and binary media.
  const parserBytes = zipSync(Object.fromEntries(Object.entries(parts).filter(([path]) => !omitted.has(key(path)))), { level: 0 })
  await workbook.xlsx.load(parserBytes, { ignoreNodes: ['drawing', 'picture', 'mergeCells', 'cols', 'tableParts',
    'conditionalFormatting', 'extLst', 'dataValidations', 'headerFooter', 'sheetProtection'] })
  if (workbook.worksheets.length !== sheets.length || !!workbook.properties.date1904 !== (dateSystem === '1904')) invalid()
  for (const sheet of sheets) {
    const parsed = workbook.worksheets[sheet.number - 1]
    if (parsed.name !== sheet.name || parsed.state !== sheet.state) invalid()
    for (const value of sheet.cells) {
      const parsedCell = parsed.getCell(value.address)
      value.numberFormat = boundedText(parsedCell.numFmt || 'General')
      if (value.kind === 'number' && parsedCell.effectiveType === ExcelJS.ValueType.Date) value.kind = 'date_serial'
    }
  }
  parentPort.postMessage({ ok: true, sheetNumber: input.input.sheetNumber, dateSystem, offset: input.input.offset,
    sheets: sheets.map(sheet => ({ number: sheet.number, name: sheet.name, state: sheet.state, storedCells: sheet.cells.length })),
    totalCells: selectedSheet.cells.length,
    cells: selectedSheet.cells.slice(input.input.offset, input.input.offset + input.input.maxCells) })
} catch (error) {
  parentPort.postMessage({ ok: false, code: error instanceof Error && error.message === 'context_too_large'
    ? 'context_too_large' : 'invalid_input' })
}
`
