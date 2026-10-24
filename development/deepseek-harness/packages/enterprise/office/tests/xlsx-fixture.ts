/** Independent OOXML ZIP fixtures preserve numeric lexemes that JavaScript workbook writers would round. */
import { zipSync } from 'fflate'

/** Intentional real-package variations used by XLSX admission and parser regressions. */
export interface XlsxFixtureOptions {
  readonly sheet?: string
  readonly date1904?: boolean
  readonly contentType?: string
  readonly workbookRelations?: string
  readonly extra?: Readonly<Record<string, Uint8Array>>
}

/** Exact high-precision saved amount, authored separately from workbook decoding. */
export const submittedXlsxAmount = '9007199254740993.0012300'

/**
 * Build a compressed XLSX with out-of-order sheet ids, raw finance values, hidden cells and saved formula caches.
 * @param options - Explicit alternate XML or package features for focused invalid and resource cases.
 * @returns Actual Office Open XML spreadsheet bytes, never a fabricated parser result.
 */
export function submittedXlsxFixture(options: XlsxFixtureOptions = {}): Buffer {
  const bytes = (text: string) => new TextEncoder().encode(text)
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const relation = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
  const first = options.sheet ?? `<worksheet xmlns="${main}" xmlns:r="${relation.slice(0, -1)}">
<cols><col min="2" max="2" hidden="1"/></cols><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>${submittedXlsxAmount}</v></c>
<c r="C1"><v>1.2300E+05</v></c><c r="D1" s="1"><v>60.000000000000001</v></c></row>
<row r="2" hidden="1"><c r="A2"><f>1-1</f><v>0</v></c><c r="B2" t="b"><f>1=2</f><v>0</v></c>
<c r="C2"><f>WEBSERVICE("https://127.0.0.1:1/DO_NOT_FETCH")</f></c><c r="D2" t="str"><f>""</f><v/></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><r><t>中文🙂 </t></r><r><t>&amp;lt; 原值</t></r></is></c>
<c r="B3" t="str"><f>"literal"</f><v>&amp;lt;</v></c><c r="C3" t="e"><v>#DIV/0!</v></c><c r="D3"/></row>
</sheetData><mergeCells count="1"><mergeCell ref="A3:A1000000"/></mergeCells>
<hyperlinks><hyperlink ref="A1" r:id="link"/></hyperlinks></worksheet>`
  return Buffer.from(zipSync({
    '[Content_Types].xml': bytes(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="${options.contentType
  ?? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'}"/>
<Override PartName="/xl/worksheets/first.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/second.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`),
    '_rels/.rels': bytes(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="main" Type="${relation}officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': bytes(`<workbook xmlns="${main}" xmlns:r="${relation.slice(0, -1)}">
<workbookPr date1904="${options.date1904 ? 1 : 0}"/><sheets><sheet name="真实预算" sheetId="9" r:id="first"/>
<sheet name="隐藏明细" sheetId="2" state="veryHidden" r:id="second"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': bytes(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${options.workbookRelations ?? `<Relationship Id="second" Type="${relation}worksheet" Target="worksheets/second.xml"/>
<Relationship Id="first" Type="${relation}worksheet" Target="worksheets/first.xml"/>
<Relationship Id="styles" Type="${relation}styles" Target="styles.xml"/>
<Relationship Id="strings" Type="${relation}sharedStrings" Target="sharedStrings.xml"/>`}</Relationships>`),
    'xl/worksheets/second.xml': bytes(`<worksheet xmlns="${main}"><sheetData><row r="1048576">
<c r="XFD1048576"><v>-0.0000</v></c></row></sheetData></worksheet>`),
    'xl/worksheets/first.xml': bytes(first),
    'xl/worksheets/_rels/first.xml.rels': bytes(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="link" Type="${relation}hyperlink" Target="https://127.0.0.1:1/DO_NOT_FETCH" TargetMode="External"/></Relationships>`),
    'xl/sharedStrings.xml': bytes(`<sst xmlns="${main}" count="1" uniqueCount="1"><si><t>已保存账本</t></si></sst>`),
    'xl/styles.xml': bytes(`<styleSheet xmlns="${main}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`),
    ...options.extra,
  }, { level: 6 }))
}
