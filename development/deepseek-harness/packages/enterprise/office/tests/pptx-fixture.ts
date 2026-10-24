/** Actual compressed OOXML packages; no parser, archive or worker is mocked. */
import { strToU8, zipSync } from 'fflate'

const presentationNamespace = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const drawingNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const relationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const packageNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships'
const contentNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types'
const contentPrefix = 'application/vnd.openxmlformats-officedocument.presentationml.'
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

export interface PptxFixtureOptions {
  readonly hiddenSlide?: boolean
  readonly hiddenShape?: boolean
  readonly strictNamespaces?: boolean
  readonly externalHyperlink?: string
}

/** Package-relative entries are mutable only so individual hostile inputs can be expressed explicitly. */
export type PptxFixtureParts = Record<string, Uint8Array>

/**
 * Create a genuine minimal presentation whose first logical slide is slide2.xml.
 * @param options - Explicit additions for namespace, visibility and inert-link coverage.
 * @returns All OPC parts, including actual package, slide and notes relationships.
 */
export function pptxFixtureParts(options: PptxFixtureOptions = {}): PptxFixtureParts {
  const namespaces = `xmlns:p="${presentationNamespace}" xmlns:a="${drawingNamespace}" xmlns:r="${relationshipNamespace}"`
  const relationships = (body: string) => declaration + `<Relationships xmlns="${packageNamespace}">${body}</Relationships>`
  const relation = (id: string, type: string, target: string, mode = '') =>
    `<Relationship Id="${id}" Type="${relationshipNamespace}/${type}" Target="${target}"${mode}/>`
  const run = (text: string) => `<a:r><a:t>${text}</a:t></a:r>`
  const shape = (id: number, text: string, placeholder = '') => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/>`
    + `<p:cNvSpPr/><p:nvPr>${placeholder ? `<p:ph type="${placeholder}"/>` : ''}</p:nvPr></p:nvSpPr><p:spPr/>`
    + `<p:txBody><a:bodyPr/><a:lstStyle/><a:p>${run(text)}</a:p></p:txBody></p:sp>`
  const slide = (body: string, attributes = '') => declaration + `<p:sld ${namespaces}${attributes}><p:cSld><p:spTree>`
    + `${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  const cell = (text: string) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${run(text)}</a:p></a:txBody><a:tcPr/></a:tc>`
  const table = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/>'
    + '</p:nvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">'
    + `<a:tbl><a:tr h="1">${cell('A1')}${cell('B1')}</a:tr><a:tr h="1">${cell('A2')}${cell('B2')}</a:tr></a:tbl>`
    + '</a:graphicData></a:graphic></p:graphicFrame>'
  const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="3" name="Group"${options.hiddenShape ? ' hidden="true"' : ''}/>`
    + '<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
    + shape(4, '组合中文</a:t></a:r><a:br/><a:r><a:t>换行') + '</p:grpSp>'
  const title = options.externalHyperlink
    ? shape(2, '第二页🙂').replace('<a:r>', '<a:r><a:rPr><a:hlinkClick r:id="rIdLink"/></a:rPr>')
    : shape(2, '第二页🙂')
  const notes = declaration + `<p:notes ${namespaces}><p:cSld><p:spTree>${shape(1, '演讲者备注', 'body')}`
    + shape(2, '追加说明') + ['sldImg', 'sldNum', 'dt', 'hdr', 'ftr'].map((type, index) =>
    shape(index + 3, `BOILERPLATE_${type}`, type)).join('') + '</p:spTree></p:cSld></p:notes>'
  const content = declaration + `<Types xmlns="${contentNamespace}">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + `<Override PartName="/ppt/presentation.xml" ContentType="${contentPrefix}presentation.main+xml"/>`
    + `<Override PartName="/ppt/slides/slide1.xml" ContentType="${contentPrefix}slide+xml"/>`
    + `<Override PartName="/ppt/slides/slide2.xml" ContentType="${contentPrefix}slide+xml"/>`
    + `<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="${contentPrefix}notesSlide+xml"/></Types>`
  const values: Record<string, string> = {
    '[Content_Types].xml': content,
    '_rels/.rels': relationships(relation('rId1', 'officeDocument', 'ppt/presentation.xml')),
    'ppt/presentation.xml': declaration + `<p:presentation ${namespaces}><p:sldIdLst>`
      + '<p:sldId id="257" r:id="rIdSecond"/><p:sldId id="256" r:id="rIdFirst"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': relationships(relation('rIdFirst', 'slide', 'slides/slide1.xml')
      + relation('rIdSecond', 'slide', 'slides/slide2.xml')),
    'ppt/slides/slide1.xml': slide(shape(2, '第一页（文件名先出现）')),
    'ppt/slides/slide2.xml': slide(title + group + table, options.hiddenSlide ? ' show="0"' : ''),
    'ppt/slides/_rels/slide2.xml.rels': relationships(relation('rIdNotes', 'notesSlide', '../notesSlides/notesSlide1.xml')
      + (options.externalHyperlink ? relation('rIdLink', 'hyperlink', options.externalHyperlink, ' TargetMode="External"') : '')),
    'ppt/notesSlides/notesSlide1.xml': notes,
  }
  return Object.fromEntries(Object.entries(values).map(([name, source]) => [name, strToU8(options.strictNamespaces
    ? source.replaceAll(presentationNamespace, 'http://purl.oclc.org/ooxml/presentationml/main')
      .replaceAll(drawingNamespace, 'http://purl.oclc.org/ooxml/drawingml/main')
      .replaceAll(relationshipNamespace, 'http://purl.oclc.org/ooxml/officeDocument/relationships')
      .replaceAll('xmlns:p=', 'xmlns:pres=').replaceAll('<p:', '<pres:').replaceAll('</p:', '</pres:')
      .replaceAll('xmlns:a=', 'xmlns:draw=').replaceAll('<a:', '<draw:').replaceAll('</a:', '</draw:')
      .replaceAll('xmlns:r=', 'xmlns:link=').replaceAll(' r:', ' link:')
    : source)]))
}

/**
 * Replace one real XML part while preserving all other binary package bytes.
 * @param parts - The explicit mutable test package.
 * @param name - A known package entry.
 * @param replace - One focused transformation of its UTF-8 XML.
 */
export function replacePptxPart(parts: PptxFixtureParts, name: string, replace: (source: string) => string): void {
  const bytes = parts[name]
  if (!bytes) throw new Error(`Missing fixture part ${name}`)
  parts[name] = strToU8(replace(new TextDecoder().decode(bytes)))
}

/**
 * Compress the supplied parts with deflate, preserving their deliberately non-logical insertion order.
 * @param parts - Actual package entries, or a fresh complete two-slide package.
 * @returns Real zipped OOXML bytes passed to the actual worker.
 */
export function submittedPptxFixture(parts: PptxFixtureParts = pptxFixtureParts()): Uint8Array {
  return zipSync(parts, { level: 6 })
}
