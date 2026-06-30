/**
 * Parse a distilled note's provenance from its frontmatter — the `source:` book
 * and the `cite:` list of `chunk` + `span: start-end` (character offsets into the
 * source). Pure, so it's unit-tested; the Sources panel renders what it returns
 * and clicking a citation opens the source note at that span.
 *
 * Provenance lives in frontmatter (single-colon YAML) precisely so `harvest()`
 * never turns it into a graph edge — see distill/emit.ts.
 */

export interface NoteCitation {
  /** Source note name (the book), without the `.md` extension. */
  source: string
  /** The chunk the quote came from (for reference / future use). */
  chunk: number
  /** Character offsets [start, end) into the source note. */
  start: number
  end: number
}

const CITE_RE = /-\s*chunk:\s*(\d+)\s*\n\s*span:\s*(\d+)\s*-\s*(\d+)/g

/** Citations declared in a note's frontmatter, in document order. */
export function parseCitations(content: string): NoteCitation[] {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content)
  if (!fm) return []
  const block = fm[1]
  const source = (/^source:\s*(.+)$/m.exec(block)?.[1] ?? '')
    .split(',')[0]
    .trim()
    .replace(/\.md$/i, '')
  const out: NoteCitation[] = []
  for (const m of block.matchAll(CITE_RE)) {
    const start = Number(m[2])
    const end = Number(m[3])
    if (end > start) out.push({ source, chunk: Number(m[1]), start, end })
  }
  return out
}
