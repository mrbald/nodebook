/**
 * Document → markdown conversion for "distill". Turns a picked file into the
 * markdown the distill pipeline already understands; the messy, format-specific
 * step lives here so everything downstream stays format-agnostic.
 *
 * Pure-JS converters only — no native build, no Python (the lean-installer
 * discipline). pdf.js extracts PDF text with no canvas, so it runs in the main
 * process and unit-tests in node. A scanned PDF (no text layer) fails loudly so
 * the user re-digitizes it first, rather than getting a silent empty run.
 */

import { readFileSync } from 'fs'
import { extname } from 'path'

/**
 * Extract a PDF's text as markdown — one `## Page N` section per page, so the
 * existing chunker carries the page in each chunk's heading path (that's the
 * provenance, for free). Throws when no text is extractable (a scanned PDF).
 */
export async function pdfToMarkdown(data: Uint8Array): Promise<string> {
  // Lazy + the *legacy* build (node-friendly, no DOM globals); loaded only when
  // a PDF is actually distilled, so it never costs startup.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data }).promise
  const pages: string[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const tc = await page.getTextContent()
    let text = ''
    for (const item of tc.items as Array<{ str?: string; hasEOL?: boolean }>) {
      if (typeof item.str !== 'string') continue
      text += item.str + (item.hasEOL ? '\n' : ' ')
    }
    text = text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (text) pages.push(`## Page ${p}\n\n${text}`)
  }
  await doc.cleanup()
  const md = pages.join('\n\n')
  if (!md.trim()) {
    throw new Error('No extractable text — this PDF looks scanned. Re-digitize (OCR) it first.')
  }
  return md
}

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.text'])

/** Convert a document at `filePath` into the markdown the distill pipeline reads. */
export async function convertDocument(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.pdf') return pdfToMarkdown(new Uint8Array(readFileSync(filePath)))
  if (TEXT_EXT.has(ext)) return readFileSync(filePath, 'utf8')
  throw new Error(`Unsupported document type "${ext}". Use PDF, Markdown, or text.`)
}
