/**
 * Split a Markdown note into embeddable chunks for semantic search ("talk to
 * docs"). Pure and dependency-free so it can be golden-tested in isolation and
 * run in a worker thread off the main event loop.
 *
 * Strategy: heading-aware packing. Body text accumulates under the current
 * heading path; a new heading or an over-length buffer flushes a chunk. The
 * heading is kept as metadata (not duplicated into the body) and is meant to be
 * prepended for context at embedding time. Offsets index back into the source.
 *
 * Fenced code blocks (``` … ```) are tracked so a `#` line inside one is never
 * mistaken for a heading — the fence's content still flows into the chunk body
 * like any other text. A single line that alone exceeds the budget (a giant
 * paragraph with no internal newline) is split at sentence boundaries, falling
 * back to a hard split if even one sentence doesn't fit. Consecutive chunks
 * within the same section share a small tail overlap so a search hit near a
 * chunk boundary still carries the preceding sentence's context — spans may
 * therefore overlap; `content.slice(chunk.start, chunk.end) === chunk.text`
 * holds for every chunk, so an offset measured inside a chunk's text is an
 * offset into the source (distilled citations depend on this).
 *
 * Budgets are measured in token-cost units, not characters (`weightOf`): a CJK
 * code point counts 3× a Latin one, because CJK runs ≈1 token per character
 * through multilingual sentencepiece vocabularies while Latin runs ≈3-4
 * characters per token. For pure-Latin text weight == length, so English
 * chunking is unchanged; Chinese/Japanese/Korean text packs ~330 characters
 * per default chunk instead of overflowing the embedding model's 512-token
 * window and silently losing its tail. Offsets remain plain char offsets.
 */

export interface Chunk {
  /** Heading path the chunk lives under, e.g. "Title > Section" (context). */
  heading: string
  /** Character offsets [start, end) into the source note; the span holds
   *  exactly `text` — `source.slice(start, end) === text`. */
  start: number
  end: number
  /** The chunk's body text (no heading line). */
  text: string
}

const HEADING = /^(#{1,6})\s+(.*)$/
const FENCE = /^\s*```/

/** Default budget for a chunk's body text, in token-cost units (see
 *  `weightOf`) — a Latin character costs 1 unit, so for English text this is
 *  the familiar ~1000 chars ≈ 250 tokens. The heading is prepended separately
 *  at embed time — see `embedText` — so this leaves headroom inside the local
 *  embedding models' 512-token windows (e.g. multilingual-e5). */
const DEFAULT_MAX_CHARS = 1000

/** Tail overlap between consecutive chunks split out of the same section, as a
 *  fraction of `maxChars` — enough for a boundary hit to keep some preceding
 *  context without materially inflating the index. */
const OVERLAP_RATIO = 0.1

/** CJK scripts pack roughly a token per character in multilingual
 *  sentencepiece vocabularies, vs ~3-4 characters per token for Latin — a
 *  1000-CHAR Chinese chunk would blow far past a 512-token window and get
 *  silently truncated by the tokenizer. Weighing these code points 3× keeps
 *  the same numeric budget honest across scripts. */
const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u

/**
 * Pure: the token-cost weight of `text[start, end)` — its length with CJK
 * code points counted 3× (see `CJK`). Pure Latin text therefore weighs exactly
 * its length, which keeps every budget decision in this file byte-identical to
 * the old plain-`length` behavior for English notes. Walks by code point so an
 * astral-plane ideograph is one (heavy) unit, not two lone surrogates.
 * Exported for unit tests.
 */
export function weightOf(text: string, start = 0, end = text.length): number {
  let w = 0
  for (let i = start; i < end; ) {
    const cp = text.codePointAt(i) as number
    const wide = cp > 0xffff
    w += CJK.test(String.fromCodePoint(cp)) ? 3 : 1
    i += wide ? 2 : 1
  }
  return w
}

/** The index in `[start, end)` after consuming at most `budget` weight —
 *  always at least one code point, so callers make progress, and never inside
 *  a surrogate pair. */
function advanceByWeight(text: string, start: number, end: number, budget: number): number {
  let w = 0
  let i = start
  while (i < end) {
    const cp = text.codePointAt(i) as number
    const cw = CJK.test(String.fromCodePoint(cp)) ? 3 : 1
    if (w + cw > budget && i > start) return i
    w += cw
    i += cp > 0xffff ? 2 : 1
  }
  return end
}

/** The start of the heaviest tail of `text[start, end)` that still fits
 *  `budget` weight — the seeded-overlap counterpart of `advanceByWeight`.
 *  Returns `start` when the whole range fits. */
function overlapStart(text: string, start: number, end: number, budget: number): number {
  let w = 0
  let i = end
  while (i > start) {
    let j = i - 1
    const c = text.charCodeAt(j)
    if (c >= 0xdc00 && c <= 0xdfff && j > start) j-- // don't split a surrogate pair
    w += weightOf(text, j, i)
    if (w > budget) return i
    i = j
  }
  return start
}

/**
 * Offsets (relative to `line`) that split an overlong line into pieces each
 * within `maxChars` weight (see `weightOf`), breaking after sentence-ending
 * punctuation where possible. A single sentence that alone doesn't fit is
 * hard-split at the weight budget (never inside a surrogate pair — CJK
 * sentences are the common case here, since ~330 ideographs already exhaust a
 * 1000-unit budget). Pieces tile `[0, line.length)` exactly contiguously.
 * Exported for unit tests.
 */
export function splitLine(line: string, maxChars: number): { start: number; end: number }[] {
  if (weightOf(line) <= maxChars) return [{ start: 0, end: line.length }]

  // Sentence boundaries: punctuation + any trailing whitespace, so a piece
  // never starts with a stray space. The CJK full stop 。(and its friends in
  // U+3000-303F) counts too — Chinese/Japanese prose rarely uses ASCII '.'.
  const SENTENCE_END = /[.!?。！？]+(?=[\s)\]"']|$)|[。！？]/g
  const breaks: number[] = []
  let m: RegExpExecArray | null
  while ((m = SENTENCE_END.exec(line))) {
    let end = m.index + m[0].length
    while (end < line.length && /\s/.test(line[end])) end++
    breaks.push(end)
  }
  if (breaks[breaks.length - 1] !== line.length) breaks.push(line.length)

  const pieces: { start: number; end: number }[] = []
  let pieceStart = 0
  let pieceWeight = 0
  let segStart = 0
  for (const brk of breaks) {
    const segWeight = weightOf(line, segStart, brk)
    if (segWeight > maxChars) {
      // This sentence alone overflows: flush what's pending, then hard-split it.
      if (segStart > pieceStart) pieces.push({ start: pieceStart, end: segStart })
      let hs = segStart
      for (;;) {
        const cut = advanceByWeight(line, hs, brk, maxChars)
        if (cut >= brk) break
        pieces.push({ start: hs, end: cut })
        hs = cut
      }
      pieceStart = hs
      pieceWeight = weightOf(line, hs, brk)
    } else if (pieceWeight + segWeight > maxChars) {
      // Adding this sentence would overflow the piece in progress: close it first.
      pieces.push({ start: pieceStart, end: segStart })
      pieceStart = segStart
      pieceWeight = segWeight
    } else {
      pieceWeight += segWeight
    }
    segStart = brk
  }
  if (pieceStart < line.length) pieces.push({ start: pieceStart, end: line.length })
  return pieces
}

export function chunkMarkdown(content: string, maxChars = DEFAULT_MAX_CHARS): Chunk[] {
  const overlapChars = Math.round(maxChars * OVERLAP_RATIO)
  const chunks: Chunk[] = []
  const headingStack: string[] = [] // index = level - 1
  let heading = ''
  let bufStart = -1
  let bufEnd = -1
  // Weight of content[bufStart, bufEnd), kept incrementally — atoms tile the
  // buffer contiguously, so one add per atom instead of re-scanning the buffer.
  let bufWeight = 0
  let inFence = false

  const bufNonEmpty = (): boolean =>
    bufStart !== -1 && content.slice(bufStart, bufEnd).trim().length > 0

  // Close the chunk in progress. `seedOverlap` carries a ~10%-of-maxChars tail
  // of it (by weight) into the next chunk's start (same section only — a
  // heading boundary always passes `false`), so spans may overlap but each
  // still slices back to exactly its own text.
  const flush = (seedOverlap: boolean): void => {
    if (bufStart === -1) return
    const raw = content.slice(bufStart, bufEnd)
    const text = raw.trim()
    if (text) {
      // Report the TRIMMED span, so `content.slice(start, end) === text`
      // exactly: a citation offset measured inside `text` is then a correct
      // offset into the source. The buffer keeps its untrimmed bounds — the
      // overlap tail is cut from those, unchanged.
      const lead = raw.length - raw.trimStart().length
      const trail = raw.length - raw.trimEnd().length
      chunks.push({ heading, start: bufStart + lead, end: bufEnd - trail, text })
    }
    const tail = seedOverlap && text ? overlapStart(content, bufStart, bufEnd, overlapChars) : bufStart
    if (tail > bufStart) {
      bufStart = tail
      bufWeight = weightOf(content, bufStart, bufEnd)
    } else {
      bufStart = -1
      bufEnd = -1
      bufWeight = 0
    }
  }

  // Note: a chunk that starts with a seeded overlap tail plus a full next atom
  // (itself already sized up to maxChars, e.g. from `splitLine`) can land
  // slightly past maxChars — a soft cap traded for boundary context, bounded
  // by the overlap budget rather than unbounded. maxChars carries enough
  // headroom below the embedding models' token windows that this is fine.
  const addAtom = (atomStart: number, atomEnd: number): void => {
    if (atomStart >= atomEnd) return
    const atomWeight = weightOf(content, atomStart, atomEnd)
    if (bufStart !== -1 && bufNonEmpty() && bufWeight + atomWeight > maxChars) flush(true)
    if (bufStart === -1) {
      bufStart = atomStart
      bufWeight = 0
    }
    bufEnd = atomEnd
    bufWeight += atomWeight
  }

  let offset = 0
  for (const line of content.split('\n')) {
    const lineStart = offset
    const lineEnd = Math.min(offset + line.length + 1, content.length) // + the consumed '\n'
    offset += line.length + 1

    const isFenceDelim = FENCE.test(line)
    const h = !inFence ? HEADING.exec(line) : null
    if (isFenceDelim) inFence = !inFence

    if (h) {
      flush(false) // close the section before the heading — never overlaps across one
      const level = h[1].length
      headingStack.length = level - 1
      headingStack[level - 1] = h[2].trim()
      heading = headingStack.filter(Boolean).join(' > ')
      continue // heading is metadata, not body
    }

    // Gate on weight, not length: a 600-char single-line Chinese paragraph is
    // under the char count but ~3× over the token budget. The length check is
    // just a cheap pre-filter (weight ≥ length always) saving a scan of the
    // many short lines.
    const pieces =
      line.length * 3 > maxChars && weightOf(line) > maxChars
        ? splitLine(line, maxChars)
        : [{ start: 0, end: line.length }]
    pieces.forEach((p, i) => {
      const isLast = i === pieces.length - 1
      addAtom(lineStart + p.start, isLast ? lineEnd : lineStart + p.end)
    })
  }
  flush(false)
  return chunks
}

/** The text actually embedded for a chunk: its heading path + body for context. */
export function embedText(chunk: Chunk): string {
  return chunk.heading ? `${chunk.heading}\n\n${chunk.text}` : chunk.text
}
