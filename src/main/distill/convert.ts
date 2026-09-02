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
import { cleanPdf } from './cleanPdf'

/**
 * Extract a PDF's text as markdown — one `## Page N` section per page, so the
 * existing chunker carries the page in each chunk's heading path (that's the
 * provenance, for free). Throws when no text is extractable (a scanned PDF).
 *
 * What comes out of a PDF is lines painted at positions, not prose: a running
 * header on every page, a page-number footer, words cut in half at the line
 * break, one hard newline per printed line. `cleanPdf` puts the text back
 * together before the pipeline ever sees it — see that module for why each of
 * those defeats the model, the embedder and the quote matcher alike.
 */
export async function pdfToMarkdown(data: Uint8Array): Promise<string> {
  // Lazy + the *legacy* build (node-friendly, no DOM globals); loaded only when
  // a PDF is actually distilled, so it never costs startup.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // verbosity 0 = errors only: silences pdf.js's noisy per-font warnings (e.g.
  // "TT: undefined function") that are irrelevant to text extraction.
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise
  const raw: string[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const tc = await page.getTextContent()
    let text = ''
    for (const item of tc.items as Array<{ str?: string; hasEOL?: boolean }>) {
      if (typeof item.str !== 'string') continue
      text += item.str + (item.hasEOL ? '\n' : ' ')
    }
    raw.push(
      text
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    )
  }
  await doc.cleanup()
  // One entry per page in and out, so the heading keeps the REAL page number
  // even when a page cleans down to nothing.
  const pages = cleanPdf(raw)
    .map((text, i) => (text.trim() ? `## Page ${i + 1}\n\n${text}` : ''))
    .filter(Boolean)
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

/** HTML → markdown (turndown): body-only, scripts/styles/head dropped. The
 *  shared last leg of the EPUB, HTML, and DOCX converters. */
async function htmlBodyToMarkdown(html: string): Promise<string> {
  const TurndownService = (await import('turndown')).default
  const td = new TurndownService({ headingStyle: 'atx' })
  td.remove(['script', 'style', 'noscript'])
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html
  return td.turndown(body).trim()
}

/**
 * Convert an HTML file's text to markdown. Real headings survive (turndown
 * keeps h1-h6), so the chunker's heading paths give provenance for free —
 * no artificial `## Section N` needed.
 */
export async function htmlToMarkdown(html: string): Promise<string> {
  const md = await htmlBodyToMarkdown(html)
  if (!md) throw new Error('No extractable text in this HTML file.')
  return md
}

/**
 * Convert a Word document (.docx) to markdown: mammoth (pure JS) turns the
 * OOXML into clean HTML — mapping Word heading styles to h1-h6 — and turndown
 * takes it the rest of the way. Legacy binary .doc is rejected in
 * `convertDocument` (no dependable pure-JS reader exists for it).
 */
export async function docxToMarkdown(data: Uint8Array): Promise<string> {
  const mammoth = await import('mammoth')
  const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(data) })
  const md = await htmlBodyToMarkdown(html)
  if (!md) throw new Error('No extractable text in this Word document.')
  return md
}

/** Strip XML tags and decode the handful of entities a title can carry. */
function xmlText(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * href → chapter title, from an EPUB's table of contents.
 *
 * Both TOC formats are read: EPUB 2's `toc.ncx` (`<navPoint>` = a `<text>`
 * label plus a `<content src="…">`) and EPUB 3's `nav.xhtml` (`<nav
 * epub:type="toc">` wrapping ordinary `<a href="…">` links). The fragment
 * (`chapter1.xhtml#part2`) is dropped: the spine is per FILE, so the first
 * title pointing into a file names it. Paths are kept exactly as written, so
 * the caller resolves them against the same base as the manifest's.
 *
 * Exported for tests; pure (it takes the two documents' text, not a zip).
 */
export function epubNavTitles(ncx: string, nav: string): Map<string, string> {
  const titles = new Map<string, string>()
  const add = (href: string, title: string): void => {
    const file = href.split('#')[0].trim()
    if (file && title && !titles.has(file)) titles.set(file, title)
  }
  for (const point of ncx.matchAll(/<navPoint\b[\s\S]*?<\/navPoint>/g)) {
    const label = /<text\b[^>]*>([\s\S]*?)<\/text>/.exec(point[0])
    const content = /<content\b[^>]*>/.exec(point[0])
    if (label && content) add(xmlAttr(content[0], 'src'), xmlText(label[1]))
  }
  const toc = /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(nav)
  if (toc) {
    for (const a of toc[1].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g))
      add(xmlAttr(`<a${a[1]}>`, 'href'), xmlText(a[2]))
  }
  return titles
}

/**
 * Extract an EPUB's text as markdown, one `## <chapter title>` per spine
 * chapter (= provenance, like PDF's pages). EPUB is a zip of XHTML: unzip
 * (fflate) → find the OPF via `META-INF/container.xml` → walk the spine in
 * reading order → HTML→markdown (turndown). Both deps are pure-JS. Throws if
 * nothing extractable.
 *
 * The heading is the chapter's real name when the book's table of contents
 * gives one (`epubNavTitles`), because that name is what a citation reports as
 * its `where:` — "Chapter 4: The Flood" tells you where you are; "Section 7"
 * does not. Books with no usable TOC fall back to `## Section N`.
 */
export async function epubToMarkdown(data: Uint8Array): Promise<string> {
  const { unzipSync, strFromU8 } = await import('fflate')
  const files = unzipSync(data)
  const read = (p: string): string => (files[p] ? strFromU8(files[p]) : '')

  const container = read('META-INF/container.xml')
  const opfPath = xmlAttr(/<rootfile\b[^>]*>/.exec(container)?.[0] ?? '', 'full-path')
  if (!opfPath || !files[opfPath]) throw new Error('Not a valid EPUB (no OPF package found).')
  const opf = read(opfPath)
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''

  const manifest = new Map<string, string>()
  /** Manifest items that declare themselves a TOC — EPUB 2 `media-type` for the
   *  NCX, EPUB 3 `properties="nav"` for the navigation document. */
  let ncxHref = ''
  let navHref = ''
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = xmlAttr(m[0], 'id')
    const href = xmlAttr(m[0], 'href')
    if (!href) continue
    if (id) manifest.set(id, href.split('#')[0])
    if (/\bapplication\/x-dtbncx\+xml\b/.test(xmlAttr(m[0], 'media-type'))) ncxHref = href
    if (/\bnav\b/.test(xmlAttr(m[0], 'properties'))) navHref = href
  }
  // Fall back to the conventional file names, for books whose OPF doesn't
  // declare its TOC — reading one costs a map lookup, so try both.
  const titles = epubNavTitles(
    read(opfDir + (ncxHref || 'toc.ncx')),
    read(opfDir + (navHref || 'nav.xhtml'))
  )

  const sections: string[] = []
  let n = 0
  for (const m of opf.matchAll(/<itemref\b[^>]*>/g)) {
    const href = manifest.get(xmlAttr(m[0], 'idref'))
    if (!href) continue
    const html = read(opfDir + href)
    if (!html) continue
    const md = await htmlBodyToMarkdown(html)
    if (!md) continue
    n++
    sections.push(`## ${titles.get(href) ?? `Section ${n}`}\n\n${md}`)
  }

  const out = sections.join('\n\n')
  if (!out.trim()) throw new Error('No extractable text in this EPUB.')
  return out
}

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.text'])
const HTML_EXT = new Set(['.html', '.htm', '.xhtml'])

/** Convert a document at `filePath` into the markdown the distill pipeline reads. */
export async function convertDocument(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.pdf') return pdfToMarkdown(new Uint8Array(readFileSync(filePath)))
  if (ext === '.epub') return epubToMarkdown(new Uint8Array(readFileSync(filePath)))
  if (ext === '.docx') return docxToMarkdown(new Uint8Array(readFileSync(filePath)))
  if (HTML_EXT.has(ext)) return htmlToMarkdown(readFileSync(filePath, 'utf8'))
  if (TEXT_EXT.has(ext)) return readFileSync(filePath, 'utf8')
  if (ext === '.doc') {
    throw new Error(
      'Legacy .doc isn’t supported — open it in Word or LibreOffice and save as .docx first.'
    )
  }
  throw new Error(`Unsupported document type "${ext}". Use PDF, EPUB, Word (.docx), HTML, Markdown, or text.`)
}
