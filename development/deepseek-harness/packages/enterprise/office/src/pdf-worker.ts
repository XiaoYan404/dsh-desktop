/** Static isolate source prevents Host bundlers and test import rewrites from altering the worker's imports. */

/** PDF.js text-only entry; input bytes and resource limits come exclusively from the authority. */
export const officePdfWorkerSource = String.raw`
import { parentPort, workerData as input } from 'node:worker_threads'
const pdfjs = await import(input.moduleUrl)
async function extract() {
  const loading = pdfjs.getDocument({ data: input.data, isEvalSupported: false, useSystemFonts: false,
    disableFontFace: true, useWorkerFetch: false, useWasm: false, maxImageSize: 0,
    disableAutoFetch: true, disableStream: true, stopAtErrors: true, verbosity: 0 })
  try {
    const document = await loading.promise
    if (document.numPages > input.maxPages) {
      parentPort.postMessage({ ok: false, code: 'context_too_large' })
      return
    }
    if (input.pageNumber > document.numPages) {
      parentPort.postMessage({ ok: false, code: 'invalid_input' })
      return
    }
    const page = await document.getPage(input.pageNumber)
    const reader = page.streamTextContent({ includeMarkedContent: false }).getReader()
    let text = ''
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        for (const item of chunk.value.items) {
          if (!('str' in item)) continue
          const separator = item.hasEOL ? '\n' : ' '
          if (text.length + item.str.length + separator.length > input.maxPageCharacters) {
            parentPort.postMessage({ ok: false, code: 'context_too_large' })
            return
          }
          text += item.str + separator
        }
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    parentPort.postMessage({ ok: true, pageCount: document.numPages, text: text.trimEnd() })
  } catch {
    // PDF parser details may contain document data; only stable failure identities cross the isolate.
    parentPort.postMessage({ ok: false, code: 'invalid_input' })
  } finally {
    await loading.destroy()
  }
}
await extract()
`
