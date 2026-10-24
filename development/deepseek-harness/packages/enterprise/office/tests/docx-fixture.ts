/** Deterministic real OOXML packages contain compressed Unicode paragraphs and table cells. */
import { zipSync } from 'fflate'

/** Fixture variations exercise package admission without substituting parser outcomes. */
export interface DocxFixtureOptions {
  readonly document?: string
  readonly relationshipTarget?: string
  readonly externalMain?: boolean
  readonly contentType?: string
  readonly extra?: Readonly<Record<string, Uint8Array>>
}

/** Selectable text and table expectations are authored independently of the parser. */
export const submittedDocxText = '真实 Word & <预算>🙂\n项目\t金额\n服务费\t1200\n合计 1200\n外部链接显示文字'

/**
 * Create an actual DOCX ZIP with content types, package relationship and main Word body.
 * @param options - Intentional format or package variations for focused fixtures.
 * @returns Compressed DOCX bytes, without filesystem or renderer dependencies.
 */
export function submittedDocxFixture(options: DocxFixtureOptions = {}): Buffer {
  const text = (value: string) => new TextEncoder().encode(value)
  const document = options.document ?? `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body><w:p><w:r><w:t>真实 Word &amp; &lt;预算&gt;🙂</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc>
<w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>服务费</w:t></w:r></w:p></w:tc>
<w:tc><w:p><w:r><w:t>1200</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:del><w:r><w:delText>DELETED_NOT_CURRENT_TEXT</w:delText></w:r></w:del>
<w:r><w:instrText>DO_NOT_EXECUTE_FIELD_CODE</w:instrText><w:t>合计 </w:t></w:r>
<w:ins><w:r><w:t>1200</w:t></w:r></w:ins></w:p>
<w:p><w:hyperlink r:id="external"><w:r><w:t>外部链接显示文字</w:t></w:r></w:hyperlink></w:p>
<w:sectPr/></w:body></w:document>`
  return Buffer.from(zipSync({
    '[Content_Types].xml': text(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="${options.contentType
  ?? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'}"/></Types>`),
    '_rels/.rels': text(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
Target="${options.relationshipTarget ?? 'word/document.xml'}"${options.externalMain ? ' TargetMode="External"' : ''}/></Relationships>`),
    'word/document.xml': text(document),
    ...options.extra,
  }, { level: 6 }))
}
