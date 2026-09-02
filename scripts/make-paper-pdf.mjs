// Generate e2e/fixtures/distill/paper.pdf: a real, deterministic, multi-page
// PDF built from raw PDF objects (Helvetica, WinAnsiEncoding, one `BT … ET`
// text-showing block per line — no PDF-writing library, no new dependency).
// It exists so the distill eval has a real PDF fixture with the defects
// `convert.ts`'s pdf.js path passes straight through and that a future
// `cleanPdf` pass (see docs/distill-documents.md B7) has to fix:
//   - a running header line repeated on every page,
//   - a page-number footer on every page,
//   - a handful of words deliberately hyphenated across a line break
//     (e.g. "consid-" / "erations"), which — because each line is emitted as
//     its own text-showing operation with a plain vertical offset from the
//     previous one — pdf.js's own line-break heuristic marks with `hasEOL`,
//     so `pdfToMarkdown` reconstructs them as "consid-\nerations", exactly
//     the shape PDF cleanup has to detect and rejoin.
//
// Source prose: `e2e/fixtures/distill/paper-source.txt` (see the fixtures'
// SOURCE.md for provenance/licence). This script only lays it out on pages —
// it does not alter the words.
//
// Run: node scripts/make-paper-pdf.mjs (writes e2e/fixtures/distill/paper.pdf).
// Deterministic: same input file in, byte-identical PDF out.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = new URL('../e2e/fixtures/distill/paper-source.txt', import.meta.url)
const OUT = fileURLToPath(new URL('../e2e/fixtures/distill/paper.pdf', import.meta.url))

// --- Page geometry (Letter, points) ---------------------------------------
const PAGE_W = 612
const PAGE_H = 792
const MARGIN_X = 72
const FONT_SIZE = 10
const LEADING = 12.5 // line-to-line advance; ~1.25x — a dense single-spaced page
const HEADER_Y = 758
const BODY_TOP_Y = 738
const BODY_BOTTOM_Y = 66
const FOOTER_Y = 40
const MAX_CHARS_PER_LINE = 92 // plain char-count wrap; good enough at 10pt Helvetica
const RUNNING_HEADER = 'RELATIVITY: THE SPECIAL AND GENERAL THEORY'
// How many mid-paragraph words to hyphenate across a line break, spread
// deterministically through the document (see `hyphenateMidParagraph`).
const HYPHENATION_DEMOS = 8

// --- 1. Load + wrap the source text into page lines ------------------------

function loadParagraphs() {
  const text = readFileSync(SRC, 'utf8')
  return text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean)
}

/** Greedy word wrap at a character budget (no font metrics needed — pdf.js
 *  only cares about the text content and each line's position, not exact
 *  visual fit). Never splits a word except via `hyphenateMidParagraph`. */
function wrap(paragraph, maxChars) {
  const words = paragraph.split(/\s+/)
  const lines = []
  let cur = ''
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w
    if (candidate.length > maxChars && cur) {
      lines.push(cur)
      cur = w
    } else {
      cur = candidate
    }
  }
  if (cur) lines.push(cur)
  return lines
}

/** Force one clean mid-word line break near the middle of a wrapped
 *  paragraph, turning `lines[i]`'s last word into a `head-` / `tail` split
 *  across `lines[i]` and `lines[i+1]` — the hyphenated-line-break defect
 *  `cleanPdf` (docs/distill-documents.md B7) has to reverse. Only fires on a
 *  clean alphabetic word (no attached punctuation), so it never corrupts the
 *  text; a no-op is fine (some paragraphs just don't get a demo). */
function hyphenateMidParagraph(lines) {
  if (lines.length < 2) return { lines, hyphenated: false }
  const i = Math.floor(lines.length / 2)
  if (i >= lines.length - 1) return { lines, hyphenated: false }
  const words = lines[i].split(' ')
  const last = words[words.length - 1]
  if (!/^[A-Za-z]{7,}$/.test(last)) return { lines, hyphenated: false }
  const cut = Math.ceil(last.length / 2)
  const head = last.slice(0, cut)
  const tail = last.slice(cut)
  const out = [...lines]
  out[i] = [...words.slice(0, -1), `${head}-`].join(' ')
  out[i + 1] = `${tail} ${out[i + 1]}`
  return { lines: out, hyphenated: true }
}

/** Every wrapped line the document will show, in reading order, with a blank
 *  "line" (a paragraph gap) between paragraphs. Headings (`## …`, `PART …`,
 *  a lone-roman-numeral title) render as their own short line, same font —
 *  pdf.js only extracts text, so no bold/size distinction is needed for the
 *  fixture's purpose. */
function buildLines(paragraphs) {
  const out = []
  let demosLeft = HYPHENATION_DEMOS
  for (const p of paragraphs) {
    const clean = p.startsWith('## ') ? p.slice(3) : p
    let lines = wrap(clean, MAX_CHARS_PER_LINE)
    if (demosLeft > 0) {
      const r = hyphenateMidParagraph(lines)
      if (r.hyphenated) {
        lines = r.lines
        demosLeft--
      }
    }
    out.push(...lines)
    out.push('') // paragraph gap
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}

// --- 2. Paginate -------------------------------------------------------

const LINES_PER_PAGE = Math.floor((BODY_TOP_Y - BODY_BOTTOM_Y) / LEADING)

function paginate(lines) {
  const pages = []
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + LINES_PER_PAGE))
  }
  return pages
}

// --- 3. Raw PDF object writer ------------------------------------------

/** Escape a string for a PDF literal `(...)` — backslash, and the two
 *  parens that would otherwise unbalance the literal. Source text is plain
 *  ASCII (see paper-source.txt / SOURCE.md), so no encoding beyond this. */
function pdfString(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

function textOp(x, y, size, text) {
  if (!text) return ''
  return `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfString(text)}) Tj ET\n`
}

function pageContentStream(pageLines, pageNum) {
  let s = ''
  s += textOp(MARGIN_X, HEADER_Y, 9, RUNNING_HEADER)
  let y = BODY_TOP_Y
  for (const line of pageLines) {
    s += textOp(MARGIN_X, y, FONT_SIZE, line)
    y -= LEADING
  }
  const footer = `- ${pageNum} -`
  const footerX = PAGE_W / 2 - footer.length * 2.2 // rough visual centering
  s += textOp(footerX, FOOTER_Y, 9, footer)
  return s
}

function buildPdf(pages) {
  const objects = [] // 1-indexed by position: objects[0] is object 1, etc.
  const catalogNum = 1
  const pagesNum = 2
  const fontNum = 3
  const firstPageObj = 4 // each page uses 2 object numbers: page, then contents

  const pageNums = pages.map((_, i) => firstPageObj + i * 2)
  const kids = pageNums.map((n) => `${n} 0 R`).join(' ')

  objects[catalogNum - 1] =
    `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`
  objects[pagesNum - 1] =
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`
  objects[fontNum - 1] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'

  pages.forEach((pageLines, i) => {
    const pageObjNum = firstPageObj + i * 2
    const contentObjNum = pageObjNum + 1
    const stream = pageContentStream(pageLines, i + 1)
    const streamBytes = Buffer.byteLength(stream, 'latin1')
    objects[pageObjNum - 1] =
      `<< /Type /Page /Parent ${pagesNum} 0 R ` +
      `/MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontNum} 0 R >> >> ` +
      `/Contents ${contentObjNum} 0 R >>`
    objects[contentObjNum - 1] =
      `<< /Length ${streamBytes} >>\nstream\n${stream}endstream`
  })

  // --- Assemble the file, tracking each object's byte offset for the xref. ---
  let file = '%PDF-1.4\n'
  const offsets = [0] // offsets[0] unused (object numbers are 1-based)
  for (let n = 1; n <= objects.length; n++) {
    offsets[n] = Buffer.byteLength(file, 'latin1')
    file += `${n} 0 obj\n${objects[n - 1]}\nendobj\n`
  }

  const xrefOffset = Buffer.byteLength(file, 'latin1')
  const count = objects.length + 1
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`
  for (let n = 1; n <= objects.length; n++) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
  }
  file += xref
  file += `trailer\n<< /Size ${count} /Root ${catalogNum} 0 R >>\n`
  file += `startxref\n${xrefOffset}\n%%EOF\n`
  return file
}

// --- Run ---------------------------------------------------------------

const paragraphs = loadParagraphs()
const lines = buildLines(paragraphs)
const pages = paginate(lines)
const pdf = buildPdf(pages)
writeFileSync(OUT, pdf, 'latin1')
console.log(`wrote ${OUT} (${pages.length} pages, ${Buffer.byteLength(pdf, 'latin1')} bytes)`)
