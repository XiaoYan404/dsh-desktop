/** Static PPTX isolate source decodes bounded package XML without external resources, macros or visual rendering. */
export const officePptxWorkerSource = String.raw`
import { parentPort, workerData as input } from 'node:worker_threads'
const { unzipSync } = await import(input.zipModuleUrl)
const { XMLParser, XMLValidator } = await import(input.xmlModuleUrl)
const presentationNamespaces = new Set(['http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main'])
const drawingNamespaces = new Set(['http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main'])
const relationshipNamespaces = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships'])
const relationshipPrefix = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
const packageNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships'
const contentNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types'
const contentPrefix = 'application/vnd.openxmlformats-officedocument.presentationml.'
const noteBoilerplate = new Set(['sldImg', 'sldNum', 'dt', 'hdr', 'ftr'])
let visited = 0
let characters = 0
function invalid() { throw new Error('invalid_input') }
function limit() { throw new Error('context_too_large') }
function key(value) { return value.replace(/[A-Z]/g, letter => letter.toLowerCase()) }
function bool(value, fallback = false) {
  if (value === undefined) return fallback
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  invalid()
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
  const colon = tag.indexOf(':')
  return { local: colon < 0 ? tag : tag.slice(colon + 1), uri: scope.get(colon < 0 ? '' : tag.slice(0, colon)),
    attributes, scope, children: node[tag] }
}
function children(value) { return (value.children || []).map(node => element(node, value.scope)).filter(Boolean) }
function named(value, local, namespaces) { return value.local === local && namespaces.has(value.uri) }
function pick(value, local, namespaces) { return children(value).filter(child => named(child, local, namespaces)) }
function one(value, local, namespaces, optional = false) {
  const matches = pick(value, local, namespaces)
  if (matches.length > 1 || !optional && matches.length !== 1) invalid()
  return matches[0]
}
function xml(bytes) {
  if (!bytes) invalid()
  if (bytes.length > input.policy.maxXmlBytes) limit()
  const encoding = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)
    ? 'utf-16le' : (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c) ? 'utf-16be' : 'utf-8'
  const source = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source) || XMLValidator.validate(source) !== true) invalid()
  const parsed = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false,
    parseAttributeValue: false, trimValues: false, processEntities: true, ignoreDeclaration: true }).parse(source)
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
  if (typeof target !== 'string' || !target || /%2f|%5c|%00/i.test(target)) invalid()
  let decoded
  try { decoded = decodeURIComponent(target) } catch { invalid() }
  if (/[\\\u0000-\u001f\u007f?#]/.test(decoded) || /^[a-z][a-z\d+.-]*:/i.test(decoded)) invalid()
  const path = decoded.startsWith('/') ? [] : owner.split('/').slice(0, -1)
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!path.length) invalid(); path.pop() }
    else path.push(part)
  }
  if (!path.length) invalid()
  return key(path.join('/'))
}
function relationId(value) {
  const matches = Object.entries(value.attributes).filter(([name]) => {
    const match = /^@_([^:]+):id$/.exec(name)
    return match && relationshipNamespaces.has(value.scope.get(match[1]))
  })
  if (matches.length !== 1 || typeof matches[0][1] !== 'string') invalid()
  return matches[0][1]
}
function append(value) {
  characters += value.length
  if (characters > input.policy.maxTextCharacters) limit()
  return value
}
function join(values, separator) {
  characters += Math.max(0, values.length - 1) * separator.length
  if (characters > input.policy.maxTextCharacters) limit()
  return values.join(separator)
}
function textBody(value, counts) {
  const paragraphs = []
  for (const paragraph of pick(value, 'p', drawingNamespaces)) {
    counts.paragraphCount++
    let result = ''
    for (const run of children(paragraph)) {
      if (!drawingNamespaces.has(run.uri)) continue
      if (run.local === 'br') result += append('\n')
      else if (run.local === 'r' || run.local === 'fld') {
        for (const text of pick(run, 't', drawingNamespaces)) {
          for (const node of text.children || []) if (typeof node['#text'] === 'string') result += append(node['#text'])
        }
      }
    }
    paragraphs.push(result)
  }
  return join(paragraphs, '\n')
}
function shapeHidden(shape, group) {
  const nonvisual = one(shape, group ? 'nvGrpSpPr' : shape.local === 'graphicFrame' ? 'nvGraphicFramePr' : 'nvSpPr',
    presentationNamespaces, true)
  const properties = nonvisual && one(nonvisual, 'cNvPr', presentationNamespaces, true)
  return properties ? bool(properties.attributes['@_hidden']) : false
}
function boilerplate(shape) {
  const nonvisual = one(shape, 'nvSpPr', presentationNamespaces, true)
  const properties = nonvisual && one(nonvisual, 'nvPr', presentationNamespaces, true)
  const placeholder = properties && one(properties, 'ph', presentationNamespaces, true)
  return placeholder && noteBoilerplate.has(placeholder.attributes['@_type'])
}
function sectionText(root, section) {
  const data = one(root, 'cSld', presentationNamespaces)
  const tree = one(data, 'spTree', presentationNamespaces)
  const counts = { paragraphCount: 0, tableCount: 0, hiddenShapeCount: 0 }
  function treeText(parent, inheritedHidden) {
    const output = []
    for (const shape of children(parent)) {
      if (!presentationNamespaces.has(shape.uri)) continue
      if (shape.local === 'grpSp') output.push(...treeText(shape, inheritedHidden || shapeHidden(shape, true)))
      else if (shape.local === 'sp') {
        if (section === 'notes' && boilerplate(shape)) continue
        const body = one(shape, 'txBody', presentationNamespaces, true)
        if (!body) continue
        if (inheritedHidden || shapeHidden(shape, false)) counts.hiddenShapeCount++
        output.push(textBody(body, counts))
      } else if (shape.local === 'graphicFrame') {
        const graphic = one(shape, 'graphic', drawingNamespaces, true)
        const data = graphic && one(graphic, 'graphicData', drawingNamespaces, true)
        const table = data && one(data, 'tbl', drawingNamespaces, true)
        if (!table) continue
        if (inheritedHidden || shapeHidden(shape, false)) counts.hiddenShapeCount++
        counts.tableCount++
        const rows = []
        for (const row of pick(table, 'tr', drawingNamespaces)) {
          const cells = []
          for (const cell of pick(row, 'tc', drawingNamespaces)) cells.push(textBody(one(cell, 'txBody', drawingNamespaces), counts))
          rows.push(join(cells, '\t'))
        }
        output.push(join(rows, '\n'))
      }
    }
    return output
  }
  const text = join(treeText(tree, false), '\n')
  return { text, ...counts }
}
try {
  let entryCount = 0
  let expanded = 0
  const names = new Set()
  const sizes = new Map()
  unzipSync(input.data, { filter(entry) {
    if (++entryCount > input.policy.maxArchiveEntries) limit()
    if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) invalid()
    expanded += entry.originalSize
    if (!Number.isSafeInteger(expanded) || expanded > input.policy.maxInflatedBytes) limit()
    const path = key(entry.name)
    if (names.has(path) || /(^[\\/]|\\|(^|\/)\.{1,2}(\/|$)|[\u0000-\u001f\u007f])/.test(path)) invalid()
    if (/(^|\/)vbaproject\.bin$|(^|\/)activex\//i.test(path)) invalid()
    if (entry.compression !== 0 && entry.compression !== 8) invalid()
    names.add(path)
    sizes.set(path, entry.originalSize)
    if (/\.(xml|rels|vml)$/i.test(path) && entry.originalSize > input.policy.maxXmlBytes) limit()
    return false
  } })
  const parts = unzipSync(input.data, { filter: entry => /\.(xml|rels)$/i.test(entry.name) })
  const roots = new Map()
  for (const [path, bytes] of Object.entries(parts)) {
    if (bytes.length !== sizes.get(key(path))) invalid()
    roots.set(key(path), xml(bytes))
  }
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
      if (typeof id !== 'string' || !id || entries.has(id) || typeof originalType !== 'string' || typeof target !== 'string') invalid()
      const type = originalType.replace('http://purl.oclc.org/ooxml/officeDocument/relationships/', relationshipPrefix)
      if (/vba|macro|activex|oleobject/i.test(type)) invalid()
      if (mode !== undefined && mode !== 'Internal' && mode !== 'External') invalid()
      if (mode === 'External' && type !== relationshipPrefix + 'hyperlink') invalid()
      entries.set(id, { type, target: type === relationshipPrefix + 'hyperlink' ? null : resolvePart(owner, target) })
    }
    relationships.set(owner, entries)
  }
  const content = roots.get('[content_types].xml')
  if (!content || content.local !== 'Types' || content.uri !== contentNamespace) invalid()
  const types = new Map()
  for (const value of children(content)) {
    if (value.uri !== contentNamespace || !['Override', 'Default'].includes(value.local)) invalid()
    const type = value.attributes['@_ContentType']
    if (typeof type !== 'string' || /macro|vba|activex|oleobject/i.test(type)) invalid()
    if (value.local === 'Override') {
      const path = resolvePart('', value.attributes['@_PartName'])
      if (types.has(path)) invalid()
      types.set(path, type)
    }
  }
  const main = [...(relationships.get('') || new Map()).values()].filter(value => value.type === relationshipPrefix + 'officeDocument')
  if (main.length !== 1 || types.get(main[0].target) !== contentPrefix + 'presentation.main+xml') invalid()
  const presentation = roots.get(main[0].target)
  if (!presentation || !named(presentation, 'presentation', presentationNamespaces)) invalid()
  const list = one(presentation, 'sldIdLst', presentationNamespaces)
  const definitions = pick(list, 'sldId', presentationNamespaces)
  if (definitions.length > input.policy.maxSlides) limit()
  if (input.selection.slideNumber > definitions.length) invalid()
  const links = relationships.get(main[0].target) || new Map()
  const slides = []
  const slideIds = new Set()
  const slideParts = new Set()
  const noteParts = new Set()
  let selected
  for (const [index, definition] of definitions.entries()) {
    const id = definition.attributes['@_id']
    const link = links.get(relationId(definition))
    if (typeof id !== 'string' || !/^\d+$/.test(id) || slideIds.has(id)
      || !link || link.type !== relationshipPrefix + 'slide' || !link.target || slideParts.has(link.target)) invalid()
    slideIds.add(id)
    slideParts.add(link.target)
    if (types.get(link.target) !== contentPrefix + 'slide+xml') invalid()
    const root = roots.get(link.target)
    if (!root || !named(root, 'sld', presentationNamespaces)) invalid()
    const noteLinks = [...(relationships.get(link.target) || new Map()).values()]
      .filter(value => value.type === relationshipPrefix + 'notesSlide')
    if (noteLinks.length > 1) invalid()
    const notePath = noteLinks[0]?.target
    if (noteLinks.length && (!notePath || noteParts.has(notePath) || types.get(notePath) !== contentPrefix + 'notesSlide+xml')) invalid()
    const notes = notePath && roots.get(notePath)
    if (noteLinks.length && (!notes || !named(notes, 'notes', presentationNamespaces))) invalid()
    if (notePath) noteParts.add(notePath)
    slides.push({ number: index + 1, hidden: !bool(root.attributes['@_show'], true), hasNotes: !!notes })
    const body = sectionText(root, 'slide')
    const note = notes ? sectionText(notes, 'notes') : { text: '', paragraphCount: 0, tableCount: 0, hiddenShapeCount: 0 }
    if (index + 1 === input.selection.slideNumber) selected = input.selection.section === 'slide' ? body : note
  }
  if (!selected) invalid()
  parentPort.postMessage({ ok: true, slides, ...input.selection, ...selected })
} catch (error) {
  parentPort.postMessage({ ok: false, code: error instanceof Error && error.message === 'context_too_large'
    ? 'context_too_large' : 'invalid_input' })
}
`
