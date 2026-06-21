/**
 * Split a Markdown note into embeddable chunks for semantic search ("talk to
 * docs"). Pure and dependency-free so it can be golden-tested in isolation and
 * run in a worker thread off the main event loop.
 *
 * Strategy: heading-aware packing. Body text accumulates under the current
 * heading path; a new heading or an over-length buffer flushes a chunk. The
 * heading is kept as metadata (not duplicated into the body) and is meant to be
 * prepended for context at embedding time. Offsets index back into the source.
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

export function chunkMarkdown(content: string, maxChars = 1600): Chunk[] {
  const chunks: Chunk[] = []
  const headingStack: string[] = [] // index = level - 1
  let heading = ''
  let buf = ''
  let bufStart = -1

  const flush = (end: number): void => {
    const text = buf.trim()
    if (text) chunks.push({ heading, start: bufStart, end, text })
    buf = ''
    bufStart = -1
  }

  let offset = 0
  for (const line of content.split('\n')) {
    const lineStart = offset
    offset += line.length + 1 // + the consumed '\n'

    const h = HEADING.exec(line)
    if (h) {
      flush(lineStart) // close the section before the heading
      const level = h[1].length
      headingStack.length = level - 1
      headingStack[level - 1] = h[2].trim()
      heading = headingStack.filter(Boolean).join(' > ')
      continue // heading is metadata, not body
    }

    // Flush before this line would overflow the chunk (keep the heading context).
    if (buf.trim() && buf.length + line.length + 1 > maxChars) flush(lineStart)
    if (bufStart === -1) bufStart = lineStart
    buf += line + '\n'
  }
  flush(content.length)
  return chunks
}

/** The text actually embedded for a chunk: its heading path + body for context. */
export function embedText(chunk: Chunk): string {
  return chunk.heading ? `${chunk.heading}\n\n${chunk.text}` : chunk.text
}
