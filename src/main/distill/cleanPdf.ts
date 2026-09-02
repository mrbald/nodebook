/**
 * Clean the text a PDF extractor hands back, page by page — pure and
 * dependency-free, so it is unit-tested and knows nothing about pdf.js.
 *
 * A PDF has no paragraphs. It has *lines painted at positions*, so an extractor
 * gives back a running header on every page, a page-number footer, words cut in
 * half at a line break, and one hard newline per printed line. All four hurt the
 * distill pipeline in the same way: the model, the embedder and the quote
 * matcher all read text, and none of them reads it the way a printer laid it
 * out. A header repeated 300 times becomes the document's most "important"
 * phrase; `consid-\nerations` is a word no search will ever find; a hard
 * newline mid-sentence cuts chunks in the wrong place.
 *
 * So: drop the furniture, put the words back together, and put the paragraphs
 * back. Nothing here rewrites a word — every rule either deletes a line that
 * repeats like machinery, changes whitespace, or escapes a character that
 * markdown would otherwise read as structure.
 *
 * Two kinds of line are left exactly as they came. A line indented like a
 * markdown code block (four spaces or a tab) is a CODE LISTING — the converter
 * marks the lines it saw set in a fixed-pitch font that way (`convert.ts`), and
 * markdown reads the same indent as code. A listing is never furniture (an
 * `Out[3]:` prompt repeats on every page and is not a header), never joined
 * into a paragraph, and never de-hyphenated. The other is the `## Page N`
 * heading, which is NOT this module's business: it takes and returns one entry
 * per page, so the caller keeps the page provenance around it. That provenance
 * is what a citation's `where:` reports.
 */

/** A line that shows up on at least this share of the pages is furniture. */
const REPEAT_SHARE = 0.3

/** Below this many pages, "on 30% of pages" is not evidence of anything — a
 *  two-page document's every line is on 50% of its pages. */
const MIN_PAGES_FOR_REPEATS = 3

/** A line shorter than this share of its page's median line has ended its
 *  paragraph: it is the last line of one, a heading, or a caption. */
const SHORT_LINE_SHARE = 0.6

/** A code listing's line, by markdown's own rule for an indented code block. */
const CODE_LINE = /^(?: {4}|\t)/

/** A running header differs page to page only in its numbers ("Chapter 3",
 *  "- 12 -"), so digits are folded to `#` before lines are compared. */
function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim().replace(/\d+/g, '#')
}

/** A line that is only a page number, however it is decorated: `12`, `- 12 -`,
 *  `[12]`, `. 12 .`, `Page 12`. */
const BARE_NUMBER = /^[\s\-–—_.,:;()[\]|]*\d{1,4}[\s\-–—_.,:;()[\]|]*$/
const PAGE_LABEL = /^page\s+\d{1,4}$/i

/** A number standing at the very start or the very end of a line, behind
 *  nothing but decoration — where a header or footer prints the page number
 *  next to a chapter or section title: `102 | Chapter 4: NumPy Basics`,
 *  `4.2 Pseudorandom Numbers | 103`, `Chapter 3   12`. */
const EDGE_NUMBER_START = /^[\s\-–—_.,:;()[\]|]*(\d{1,4})(?![\p{L}\p{N}])/u
const EDGE_NUMBER_END = /(?<![\p{L}\p{N}.,])(\d{1,4})[\s\-–—_.,:;()[\]|]*$/u

/** A line that starts a block of its own: a list item, a quote, a heading. */
const BLOCK_START = /^(?:[-*+•]\s|>|#{1,6}\s|\d{1,3}[.)]\s)/

/** A paragraph opening with one of these would be read by markdown as a
 *  heading or a code fence — and by the chunker, which takes its heading path
 *  (the citation's `where:`) from `#` lines and stops reading headings inside a
 *  fence. PDF text has no markdown in it; an index entry for `#` or a line of
 *  backticks is just characters, so the marker is escaped. */
const MARKDOWN_OPENER = /^(#|```)/

/** The word before a line-ending hyphen, and the word starting the next line.
 *  The hyphen is whatever the typesetter used: ASCII, the Unicode hyphen
 *  (U+2010 — what InDesign-style layout writes at a line break) or a soft
 *  hyphen. */
const HYPHEN_END = /([\p{L}\p{N}]+)[-\u2010\u00ad]$/u
const WORD_START = /^([\p{L}\p{N}]+)/u

/** Words and hyphenated compounds, lowercased — the evidence de-hyphenation
 *  decides on. A compound contributes both itself and its parts. */
function vocabulary(text: string): Set<string> {
  const out = new Set<string>()
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+|[\p{L}\p{N}]+/gu) ??
    []) {
    out.add(token)
    if (token.includes('-')) for (const part of token.split('-')) out.add(part)
  }
  return out
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Should `left-` + `right` become one word?
 *
 * Evidence first: if the joined word appears somewhere else in the document,
 * the hyphen was the printer's. If the HYPHENATED form appears elsewhere, the
 * hyphen is the author's ("co-ordinates", "out-of-the-way") and stays. With no
 * evidence either way, two lowercase halves are a broken word — a capital on
 * either side usually means a real compound, so that keeps the hyphen.
 */
function joinsIntoWord(left: string, right: string, vocab: Set<string>): boolean {
  if (vocab.has(left + right)) return true
  if (vocab.has(`${left}-${right}`)) return false
  return /^\p{Ll}/u.test(left) && /^\p{Ll}/u.test(right)
}

/** The numbers a header or footer line could be printing as the page number. */
function edgeNumbers(line: string): number[] {
  const out: number[] = []
  const s = EDGE_NUMBER_START.exec(line)
  const e = EDGE_NUMBER_END.exec(line)
  if (s) out.push(Number(s[1]))
  if (e && (!s || e.index !== s.index)) out.push(Number(e[1]))
  return out
}

/** Index of the first and last non-blank prose line of a page — the only
 *  places a header or footer is printed. */
function edgeLines(lines: string[]): number[] {
  const inked = lines.map((l, i) => (l.trim() && !CODE_LINE.test(l) ? i : -1)).filter((i) => i >= 0)
  return inked.length ? [...new Set([inked[0], inked[inked.length - 1]])] : []
}

/**
 * The offset between the printed page number and the page's position in the
 * file, when the document has one — a book's front matter means page 118 of
 * the file prints "100". A running header that carries the chapter's or the
 * section's title changes every chapter, so it never repeats on 30 % of the
 * pages; what does repeat, on every page, is the arithmetic. The number at
 * the edge of the first or last line is read on every page, its offset from
 * the page index counted, and the most common offset wins if enough pages
 * agree. Null when they don't (no numbered furniture).
 */
function printedPageOffset(pages: string[][], repeatsOn: number): number | null {
  const votes = new Map<number, number>()
  pages.forEach((lines, i) => {
    const seen = new Set<number>()
    for (const j of edgeLines(lines)) for (const n of edgeNumbers(lines[j])) seen.add(n - (i + 1))
    for (const off of seen) votes.set(off, (votes.get(off) ?? 0) + 1)
  })
  let best: number | null = null
  let count = 0
  for (const [off, n] of votes) if (n > count) [best, count] = [off, n]
  return count >= repeatsOn ? best : null
}

/** Put one page's surviving lines back into paragraphs. A code listing's
 *  lines (see `CODE_LINE`) pass through verbatim, consecutive ones as one
 *  block; a prose paragraph that would open like markdown structure is
 *  escaped. */
function rebuildParagraphs(lines: string[], vocab: Set<string>): string {
  const shortAt =
    SHORT_LINE_SHARE *
    median(lines.filter((l) => !CODE_LINE.test(l)).map((l) => l.trim().length).filter((n) => n > 0))
  const paragraphs: string[] = []
  let current = ''
  let code: string[] = []
  const flush = (): void => {
    if (current.trim()) paragraphs.push(current.trim().replace(MARKDOWN_OPENER, '\\$1'))
    current = ''
  }
  const flushCode = (): void => {
    if (code.length) paragraphs.push(code.join('\n'))
    code = []
  }

  for (const raw of lines) {
    if (CODE_LINE.test(raw)) {
      flush()
      code.push(raw.replace(/\s+$/, ''))
      continue
    }
    flushCode()
    const line = raw.trim().replace(/\s+/g, ' ')
    // A blank line, an indent, or a list/quote/heading marker all say "this is
    // a new block" as plainly as the layout ever will.
    if (!line) {
      flush()
      continue
    }
    if (current && (/^[ \t]/.test(raw) || BLOCK_START.test(line))) flush()

    if (!current) {
      current = line
    } else {
      const cut = HYPHEN_END.exec(current)
      const next = WORD_START.exec(line)
      if (cut && next && joinsIntoWord(cut[1], next[1], vocab)) current = current.slice(0, -1) + line
      else if (cut) current += line // the hyphen is the author's: keep it, close it up
      else current += ` ${line}`
    }
    // The line that ends a paragraph is the one that didn't fill its measure.
    if (line.length < shortAt) flush()
  }
  flush()
  flushCode()
  return paragraphs.join('\n\n')
}

/**
 * Clean one document's extracted pages: drop running headers, footers and page
 * numbers, rejoin words split across a line break, and rebuild paragraphs.
 * One entry in, one entry out — an emptied page comes back as `''`.
 */
export function cleanPdf(pages: string[]): string[] {
  const lined = pages.map((p) => p.split('\n').map((l) => l.replace(/[ \t]+$/, '')))

  // 1. Furniture: lines that repeat across pages like machinery, anything
  //    that is only a page number, and the header or footer that prints the
  //    page number beside a title that changes with the chapter.
  const pageCount = new Map<string, number>()
  if (lined.length >= MIN_PAGES_FOR_REPEATS) {
    for (const lines of lined) {
      // A set per page: a line printed twice on ONE page is still one page.
      for (const norm of new Set(lines.filter((l) => !CODE_LINE.test(l)).map(normalizeLine)))
        if (norm) pageCount.set(norm, (pageCount.get(norm) ?? 0) + 1)
    }
  }
  const repeatsOn = Math.max(2, Math.ceil(lined.length * REPEAT_SHARE))
  const offset = lined.length >= MIN_PAGES_FOR_REPEATS ? printedPageOffset(lined, repeatsOn) : null
  const isFurniture = (line: string): boolean => {
    const trimmed = line.trim()
    if (!trimmed || CODE_LINE.test(line)) return false
    if (BARE_NUMBER.test(trimmed) || PAGE_LABEL.test(trimmed)) return true
    return (pageCount.get(normalizeLine(line)) ?? 0) >= repeatsOn
  }
  const kept = lined.map((lines, i) => {
    const printed = offset === null ? null : i + 1 + offset
    const edges = printed === null ? new Set<number>() : new Set(edgeLines(lines))
    return lines.filter(
      (l, j) => !isFurniture(l) && !(edges.has(j) && edgeNumbers(l).includes(printed as number))
    )
  })

  // 2. The document's own vocabulary, read once, decides every hyphen (below).
  const vocab = vocabulary(kept.map((lines) => lines.join('\n')).join('\n'))

  // 3. Words and paragraphs back together, per page.
  return kept.map((lines) => rebuildParagraphs(lines, vocab))
}
