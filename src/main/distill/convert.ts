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

/** One text item as pdf.js hands it back: the string, whether a line ends
 *  after it, its font, and where it sits on the page. */
export interface TextItem {
  str: string
  hasEOL: boolean
  fontName: string
  /** `[a, b, c, d, x, y]` — x/y is the item's origin on the page, in points. */
  transform: number[]
  width: number
  /** The font size, for unrotated text. */
  height: number
}

/** The generic family pdf.js assigns a font from its descriptor flags. */
type FontStyles = Record<string, { fontFamily?: string } | undefined>

/** A printed line: its items in reading order, and whether every one of them
 *  is set in a fixed-pitch font. */
interface PdfLine {
  items: TextItem[]
  mono: boolean
}

/**
 * Above this share of the document's characters in a fixed-pitch font, the
 * monospace font IS the body text (a typewriter-style report, a LaTeX document
 * set in Courier) and says nothing about code — so code detection is switched
 * off and the whole document is read as prose.
 */
const MONO_BODY_SHARE = 0.8

/** Gap between two items on a line, as a share of the font size, above which
 *  they were separated by a space. A space is a quarter to a third of an em;
 *  kerning and hinting jitter are well under a tenth. */
const WORD_GAP = 0.15

/** Group a page's items into printed lines: an item's `hasEOL` closes its line. */
function groupLines(items: TextItem[], styles: FontStyles): PdfLine[] {
  const lines: PdfLine[] = []
  let current: TextItem[] = []
  const close = (): void => {
    const inked = current.filter((it) => it.str.trim())
    lines.push({
      items: current,
      mono: inked.length > 0 && inked.every((it) => styles[it.fontName]?.fontFamily === 'monospace')
    })
    current = []
  }
  for (const it of items) {
    current.push(it)
    if (it.hasEOL) close()
  }
  if (current.length) close()
  return lines
}

/**
 * A prose line's text. pdf.js splits a line into items at every font change
 * and inserts an item holding a space where it saw a word gap; joining every
 * item with a space on top of that (as this once did) doubled every gap it
 * had already found. Now the geometry decides: two items on one baseline are
 * separated by a space only when there is a visible gap between them (or one
 * of them already carries the whitespace), so a word split by a font change
 * (`un` + *happy*) stays one word. Whitespace runs collapse to one space.
 */
export function proseText(items: TextItem[]): string {
  let out = ''
  let prev: TextItem | null = null
  let first: TextItem | null = null
  for (const it of items) {
    if (!it.str) continue
    const sameLine = prev !== null && Math.abs(it.transform[5] - prev.transform[5]) < 1
    // An item printed exactly where the line started, spelling its opening
    // again, is the same ink twice — pdf.js hands a list bullet back both
    // inside the line's string and as an item of its own (usually last, with
    // the line break on it), and joining both puts a `•` in the middle of the
    // next word.
    if (first && sameLine && Math.abs(it.transform[4] - first.transform[4]) < 1 && first.str.startsWith(it.str))
      continue
    if (!first || !sameLine) first = it
    if (prev && out && !/\s$/.test(out) && !/^\s/.test(it.str)) {
      const gap = it.transform[4] - (prev.transform[4] + prev.width)
      const size = Math.max(it.height, prev.height)
      // Without geometry to go on (rotated text, a zero-width item) err
      // towards the space: a stray space costs less than two glued words.
      if (!sameLine || prev.width <= 0 || size <= 0 || gap > WORD_GAP * size) out += ' '
    }
    out += it.str
    prev = it
  }
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * A code line's text, re-laid on a character grid from the items' x positions:
 * the column of each item is its distance from the listing's left margin in
 * character widths, and a fixed-pitch font has exactly one. That restores the
 * indentation a listing's meaning depends on (a Python block, a continuation
 * prompt) and the alignment of its output, both of which the string items
 * alone have lost. `left` is the margin; `charWidth` the font's advance.
 */
export function codeText(items: TextItem[], left: number, charWidth: number): string {
  let out = ''
  for (const it of items) {
    if (!it.str.trim()) continue // gaps come back from the positions
    const col = Math.max(out.length, Math.round((it.transform[4] - left) / charWidth))
    out += ' '.repeat(col - out.length) + it.str
  }
  return out.replace(/\s+$/, '')
}

/** The advance width of the page's fixed-pitch font: each inked item's width
 *  per character, taken as the median so a stray item cannot skew it. */
function monoCharWidth(lines: PdfLine[]): number {
  const widths = lines
    .filter((l) => l.mono)
    .flatMap((l) => l.items.filter((it) => it.str.trim() && it.width > 0))
    .map((it) => it.width / it.str.length)
    .sort((a, b) => a - b)
  return widths.length ? widths[widths.length >> 1] : 0
}

/** Strip blank lines at either end of a page, keeping the indentation of the
 *  first real line — a page that opens with a code listing must keep its marker. */
function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '')
}

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
 *
 * One thing is decided here, because only the text layer knows it: which lines
 * are CODE. pdf.js tags every item with a generic font family from the font's
 * own flags, and a line set entirely in a fixed-pitch font is a listing. Those
 * lines are re-laid on a character grid from their positions and marked with a
 * four-space indent — markdown's own code-block syntax — so that `cleanPdf`
 * keeps them verbatim instead of reflowing them into a paragraph, the chunker
 * never mistakes a `# comment` in them for a heading, and the note renders them
 * as code. A document that is mostly monospace is prose set in a typewriter
 * face, not a listing; there the marking is switched off (`MONO_BODY_SHARE`).
 */
export async function pdfToMarkdown(data: Uint8Array): Promise<string> {
  // Lazy + the *legacy* build (node-friendly, no DOM globals); loaded only when
  // a PDF is actually distilled, so it never costs startup.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // verbosity 0 = errors only: silences pdf.js's noisy per-font warnings (e.g.
  // "TT: undefined function") that are irrelevant to text extraction.
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise
  const pages: PdfLine[][] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const tc = await page.getTextContent()
    const items = (tc.items as Partial<TextItem>[]).filter(
      (it): it is TextItem => typeof it.str === 'string'
    )
    pages.push(groupLines(items, tc.styles as FontStyles))
  }
  await doc.cleanup()

  let monoChars = 0
  let allChars = 0
  for (const lines of pages)
    for (const l of lines) {
      const n = l.items.reduce((s, it) => s + it.str.trim().length, 0)
      allChars += n
      if (l.mono) monoChars += n
    }
  const markCode = allChars > 0 && monoChars / allChars < MONO_BODY_SHARE

  const raw = pages.map((lines) => {
    const charWidth = markCode ? monoCharWidth(lines) : 0
    const left = Math.min(
      ...lines
        .filter((l) => l.mono)
        .map((l) => l.items.find((it) => it.str.trim())?.transform[4] ?? Infinity)
    )
    const text = lines
      .map((l) =>
        markCode && l.mono && charWidth > 0
          ? `    ${codeText(l.items, left, charWidth)}`
          : proseText(l.items)
      )
      .join('\n')
    return trimBlankLines(text.replace(/\n{3,}/g, '\n\n'))
  })
  // One entry per page in and out, so the heading keeps the REAL page number
  // even when a page cleans down to nothing.
  const cleaned = cleanPdf(raw)
    .map((text, i) => (text.trim() ? `## Page ${i + 1}\n\n${text}` : ''))
    .filter(Boolean)
  const md = cleaned.join('\n\n')
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
 * Resolve a zip-relative href against the directory of the document that wrote
 * it, and normalise `.`/`..` away — so every path in this module is spelled
 * one way and can be compared. `base` is a directory, with or without its
 * trailing slash; an absolute href (a leading `/`) is taken from the zip root.
 */
export function resolveHref(base: string, href: string): string {
  const from = href.startsWith('/') ? [] : base.replace(/[^/]*$/, '').split('/')
  const out: string[] = []
  for (const part of [...from, ...href.replace(/^\//, '').split('/')]) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/**
 * href → chapter title, from an EPUB's table of contents.
 *
 * Both TOC formats are read: EPUB 2's `toc.ncx` (`<navPoint>` = a `<text>`
 * label plus a `<content src="…">`) and EPUB 3's `nav.xhtml` (`<nav
 * epub:type="toc">` wrapping ordinary `<a href="…">` links). The fragment
 * (`chapter1.xhtml#part2`) is dropped: the spine is per FILE, so the first
 * title pointing into a file names it.
 *
 * A TOC's hrefs are relative to the TOC DOCUMENT, which is not always beside
 * the OPF — `OEBPS/nav/toc.xhtml` pointing at `../text/ch1.xhtml` is ordinary.
 * So each document's own path comes in with it (`ncxPath`, `navPath`, both
 * zip-relative), and every href is resolved against it. The keys are therefore
 * zip-relative paths, which is what the caller resolves the manifest's hrefs to
 * as well — before this, a nav in a subfolder simply named no chapter.
 *
 * Exported for tests; pure (it takes the two documents' text, not a zip).
 */
export function epubNavTitles(
  ncx: string,
  nav: string,
  paths: { ncxPath?: string; navPath?: string } = {}
): Map<string, string> {
  const titles = new Map<string, string>()
  const add = (base: string, href: string, title: string): void => {
    const file = resolveHref(base, href.split('#')[0].trim())
    if (file && title && !titles.has(file)) titles.set(file, title)
  }
  for (const point of ncx.matchAll(/<navPoint\b[\s\S]*?<\/navPoint>/g)) {
    const label = /<text\b[^>]*>([\s\S]*?)<\/text>/.exec(point[0])
    const content = /<content\b[^>]*>/.exec(point[0])
    if (label && content)
      add(paths.ncxPath ?? '', xmlAttr(content[0], 'src'), xmlText(label[1]))
  }
  const toc = /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(nav)
  if (toc) {
    for (const a of toc[1].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g))
      add(paths.navPath ?? '', xmlAttr(`<a${a[1]}>`, 'href'), xmlText(a[2]))
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
  // declare its TOC — reading one costs a map lookup, so try both. The TOC's
  // own path goes with it: its hrefs are relative to IT, not to the OPF.
  const ncxPath = resolveHref(opfDir, ncxHref || 'toc.ncx')
  const navPath = resolveHref(opfDir, navHref || 'nav.xhtml')
  const titles = epubNavTitles(read(ncxPath), read(navPath), { ncxPath, navPath })

  const sections: string[] = []
  let n = 0
  for (const m of opf.matchAll(/<itemref\b[^>]*>/g)) {
    const href = manifest.get(xmlAttr(m[0], 'idref'))
    if (!href) continue
    // The manifest's hrefs are relative to the OPF; the titles are keyed by
    // zip-relative path, so both sides are resolved the same way.
    const path = resolveHref(opfDir, href)
    const html = read(path)
    if (!html) continue
    const md = await htmlBodyToMarkdown(html)
    if (!md) continue
    n++
    sections.push(`## ${titles.get(path) ?? `Section ${n}`}\n\n${md}`)
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
