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
  // verbosity 0 = errors only: silences pdf.js's noisy per-font warnings (e.g.
  // "TT: undefined function") that are irrelevant to text extraction.
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise
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

/** Read an attribute off an XML start-tag, order-independent. */
function xmlAttr(tag: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`).exec(tag)
  return m ? m[1] : ''
}

/**
 * Extract an EPUB's text as markdown, one `## Section N` per spine chapter (=
 * provenance, like PDF's pages). EPUB is a zip of XHTML: unzip (fflate) → find
 * the OPF via `META-INF/container.xml` → walk the spine in reading order →
 * HTML→markdown (turndown). Both deps are pure-JS. Throws if nothing extractable.
 */
export async function epubToMarkdown(data: Uint8Array): Promise<string> {
  const { unzipSync, strFromU8 } = await import('fflate')
  const TurndownService = (await import('turndown')).default
  const files = unzipSync(data)
  const read = (p: string): string => (files[p] ? strFromU8(files[p]) : '')

  const container = read('META-INF/container.xml')
  const opfPath = xmlAttr(/<rootfile\b[^>]*>/.exec(container)?.[0] ?? '', 'full-path')
  if (!opfPath || !files[opfPath]) throw new Error('Not a valid EPUB (no OPF package found).')
  const opf = read(opfPath)
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''

  const manifest = new Map<string, string>()
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = xmlAttr(m[0], 'id')
    const href = xmlAttr(m[0], 'href')
    if (id && href) manifest.set(id, href.split('#')[0])
  }

  const td = new TurndownService({ headingStyle: 'atx' })
  const sections: string[] = []
  let n = 0
  for (const m of opf.matchAll(/<itemref\b[^>]*>/g)) {
    const href = manifest.get(xmlAttr(m[0], 'idref'))
    if (!href) continue
    const html = read(opfDir + href)
    if (!html) continue
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html
    const md = td.turndown(body).trim()
    if (md) sections.push(`## Section ${++n}\n\n${md}`)
  }

  const out = sections.join('\n\n')
  if (!out.trim()) throw new Error('No extractable text in this EPUB.')
  return out
}

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.text'])

/** Convert a document at `filePath` into the markdown the distill pipeline reads. */
export async function convertDocument(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.pdf') return pdfToMarkdown(new Uint8Array(readFileSync(filePath)))
  if (ext === '.epub') return epubToMarkdown(new Uint8Array(readFileSync(filePath)))
  if (TEXT_EXT.has(ext)) return readFileSync(filePath, 'utf8')
  throw new Error(`Unsupported document type "${ext}". Use PDF, EPUB, Markdown, or text.`)
}
