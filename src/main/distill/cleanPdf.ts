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
 * repeats like machinery, or changes whitespace.
 *
 * The `## Page N` headings are NOT this module's business: it takes and returns
 * one entry per page, so the caller keeps the page provenance around it. That
 * provenance is what a citation's `where:` reports.
 */

/** A line that shows up on at least this share of the pages is furniture. */
const REPEAT_SHARE = 0.3

/** Below this many pages, "on 30% of pages" is not evidence of anything — a
 *  two-page document's every line is on 50% of its pages. */
const MIN_PAGES_FOR_REPEATS = 3

/** A line shorter than this share of its page's median line has ended its
 *  paragraph: it is the last line of one, a heading, or a caption. */
const SHORT_LINE_SHARE = 0.6

/** A running header differs page to page only in its numbers ("Chapter 3",
 *  "- 12 -"), so digits are folded to `#` before lines are compared. */
function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim().replace(/\d+/g, '#')
}

/** A line that is only a page number, however it is decorated: `12`, `- 12 -`,
 *  `[12]`, `. 12 .`, `Page 12`. */
const BARE_NUMBER = /^[\s\-–—_.,:;()[\]|]*\d{1,4}[\s\-–—_.,:;()[\]|]*$/
const PAGE_LABEL = /^page\s+\d{1,4}$/i

/** A line that starts a block of its own: a list item, a quote, a heading. */
const BLOCK_START = /^(?:[-*+•]\s|>|#{1,6}\s|\d{1,3}[.)]\s)/

/** The word before a line-ending hyphen, and the word starting the next line. */
const HYPHEN_END = /([\p{L}\p{N}]+)-$/u
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

/** Put one page's surviving lines back into paragraphs. */
function rebuildParagraphs(lines: string[], vocab: Set<string>): string {
  const shortAt =
    SHORT_LINE_SHARE * median(lines.map((l) => l.trim().length).filter((n) => n > 0))
  const paragraphs: string[] = []
  let current = ''
  const flush = (): void => {
    if (current.trim()) paragraphs.push(current.trim())
    current = ''
  }

  for (const raw of lines) {
    const line = raw.trim()
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
  return paragraphs.join('\n\n')
}

/**
 * Clean one document's extracted pages: drop running headers, footers and page
 * numbers, rejoin words split across a line break, and rebuild paragraphs.
 * One entry in, one entry out — an emptied page comes back as `''`.
 */
export function cleanPdf(pages: string[]): string[] {
  const lined = pages.map((p) => p.split('\n').map((l) => l.replace(/[ \t]+$/, '')))

  // 1. Furniture: lines that repeat across pages like machinery, and anything
  //    that is only a page number.
  const pageCount = new Map<string, number>()
  if (lined.length >= MIN_PAGES_FOR_REPEATS) {
    for (const lines of lined) {
      // A set per page: a line printed twice on ONE page is still one page.
      for (const norm of new Set(lines.map(normalizeLine)))
        if (norm) pageCount.set(norm, (pageCount.get(norm) ?? 0) + 1)
    }
  }
  const repeatsOn = Math.max(2, Math.ceil(lined.length * REPEAT_SHARE))
  const isFurniture = (line: string): boolean => {
    const trimmed = line.trim()
    if (!trimmed) return false
    if (BARE_NUMBER.test(trimmed) || PAGE_LABEL.test(trimmed)) return true
    return (pageCount.get(normalizeLine(line)) ?? 0) >= repeatsOn
  }
  const kept = lined.map((lines) => lines.filter((l) => !isFurniture(l)))

  // 2. The document's own vocabulary, read once, decides every hyphen (below).
  const vocab = vocabulary(kept.map((lines) => lines.join('\n')).join('\n'))

  // 3. Words and paragraphs back together, per page.
  return kept.map((lines) => rebuildParagraphs(lines, vocab))
}
