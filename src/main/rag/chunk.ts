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
 * like any other text. A single line that alone exceeds `maxChars` (a giant
 * paragraph with no internal newline) is split at sentence boundaries, falling
 * back to a hard character split if even one sentence doesn't fit. Consecutive
 * chunks within the same section share a small tail overlap so a search hit
 * near a chunk boundary still carries the preceding sentence's context —
 * spans may therefore overlap; each chunk's [start, end) always exactly
 * brackets the source range its (trimmed) text was cut from.
 */

export interface Chunk {
  /** Heading path the chunk lives under, e.g. "Title > Section" (context). */
  heading: string
  /** Character offsets [start, end) into the source note. */
  start: number
  end: number
  /** The chunk's body text (no heading line). */
  text: string
}

const HEADING = /^(#{1,6})\s+(.*)$/
const FENCE = /^\s*```/

/** Default budget for a chunk's body text (heading is prepended separately at
 *  embed time — see `embedText` — so this leaves it headroom inside the small
 *  local embedding models' token windows, e.g. bge-small's 512 tokens). */
const DEFAULT_MAX_CHARS = 1000

/** Tail overlap between consecutive chunks split out of the same section, as a
 *  fraction of `maxChars` — enough for a boundary hit to keep some preceding
 *  context without materially inflating the index. */
const OVERLAP_RATIO = 0.1

/**
 * Offsets (relative to `line`) that split an overlong line into pieces each
 * within `maxChars`, breaking after sentence-ending punctuation where
 * possible. A single sentence that alone doesn't fit is hard-split at
 * `maxChars`. Pieces tile `[0, line.length)` exactly contiguously. Exported
 * for unit tests.
 */
export function splitLine(line: string, maxChars: number): { start: number; end: number }[] {
  if (line.length <= maxChars) return [{ start: 0, end: line.length }]

  // Sentence boundaries: punctuation + any trailing whitespace, so a piece
  // never starts with a stray space.
  const SENTENCE_END = /[.!?]+(?=[\s)\]"']|$)/g
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
  let segStart = 0
  for (const brk of breaks) {
    if (brk - segStart > maxChars) {
      // This sentence alone overflows: flush what's pending, then hard-split it.
      if (segStart > pieceStart) pieces.push({ start: pieceStart, end: segStart })
      let hs = segStart
      while (brk - hs > maxChars) {
        pieces.push({ start: hs, end: hs + maxChars })
        hs += maxChars
      }
      pieceStart = hs
    } else if (brk - pieceStart > maxChars) {
      // Adding this sentence would overflow the piece in progress: close it first.
      pieces.push({ start: pieceStart, end: segStart })
      pieceStart = segStart
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
  let inFence = false

  const bufNonEmpty = (): boolean =>
    bufStart !== -1 && content.slice(bufStart, bufEnd).trim().length > 0

  // Close the chunk in progress. `seedOverlap` carries a ~10%-of-maxChars tail
  // of it into the next chunk's start (same section only — a heading boundary
  // always passes `false`), so spans may overlap but each still exactly
  // brackets its own (trimmed) text.
  const flush = (seedOverlap: boolean): void => {
    if (bufStart === -1) return
    const text = content.slice(bufStart, bufEnd).trim()
    if (text) chunks.push({ heading, start: bufStart, end: bufEnd, text })
    if (seedOverlap && text && bufEnd - bufStart > overlapChars) {
      bufStart = Math.max(bufStart, bufEnd - overlapChars)
    } else {
      bufStart = -1
      bufEnd = -1
    }
  }

  // Note: a chunk that starts with a seeded overlap tail plus a full next atom
  // (itself already sized up to maxChars, e.g. from `splitLine`) can land
  // slightly past maxChars — a soft cap traded for boundary context, bounded
  // by the overlap budget rather than unbounded. maxChars carries enough
  // headroom below the embedding models' token windows that this is fine.
  const addAtom = (atomStart: number, atomEnd: number): void => {
    if (atomStart >= atomEnd) return
    if (bufStart !== -1 && bufNonEmpty() && atomEnd - bufStart > maxChars) flush(true)
    if (bufStart === -1) bufStart = atomStart
    bufEnd = atomEnd
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

    const pieces = line.length > maxChars ? splitLine(line, maxChars) : [{ start: 0, end: line.length }]
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
