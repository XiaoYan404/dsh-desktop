/** Actual compressed PDF bytes with independent per-page content and exact object offsets. */
import { deflateSync } from 'node:zlib'

/**
 * Encode selectable page text in a complete PDF with binary Flate streams and an xref table.
 * @param pages - ASCII fixture text per page, independent of any expected parser output.
 * @returns Complete binary PDF bytes; no external resources or parser stubs.
 */
export function submittedPdfFixture(pages: readonly string[] = ['Actual binary PDF page one', 'Actual binary PDF page two']): Buffer {
  const objects: Buffer[] = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] >>`)]
  const font = 3 + pages.length * 2
  for (const text of pages) {
    const stream = deflateSync(Buffer.from(`BT /F1 12 Tf 10 90 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`))
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 100] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${objects.length + 2} 0 R >>`),
      Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from('\nendstream')]))
  }
  objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'))
  const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets = [0]
  let length = chunks[0]!.length
  for (const [index, object] of objects.entries()) {
    offsets.push(length)
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')])
    chunks.push(chunk)
    length += chunk.length
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`))
  return Buffer.concat(chunks)
}
