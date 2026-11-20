/**
 * Parse a distilled note's provenance from its frontmatter — the `source:` book
 * and the `cite:` list of `chunk` + `span: start-end` (character offsets into the
 * source), the exact `quote` the run grounded on, and `where` a reader would say
 * that is ("Page 42", a chapter name) — the last two if the run recorded them
 * (see distill/emit.ts). Pure, so it's unit-tested; the Sources panel renders what
 * it returns and clicking a citation opens the source note at that span.
 *
 * Provenance lives in frontmatter (single-colon YAML) precisely so `harvest()`
 * never turns it into a graph edge — see distill/emit.ts.
 */

export interface NoteCitation {
  /** Source note name (the book), without the `.md` extension. */
  source: string
  /** The chunk the quote came from (for reference / future use). */
  chunk: number
  /** Character offsets [start, end) into the source note, as recorded by the
   *  run — may have drifted if the source was edited since; see
   *  `resolveCitationSpan`. */
  start: number
  end: number
  /** The exact source text this citation was grounded on. Absent for a run
   *  from before this field existed — the citation is still valid, just
   *  unverifiable against source drift (legacy behavior). */
  quote?: string
  /** Where a reader would say this is — "Page 42", or the chapter's name.
   *  Absent for a document with no headings, and for older runs. */
  where?: string
}

const CITE_RE =
  /-\s*chunk:\s*(\d+)\s*\n\s*span:\s*(\d+)\s*-\s*(\d+)(?:\s*\n\s*where:\s*("(?:[^"\\]|\\.)*"))?(?:\s*\n\s*quote:\s*("(?:[^"\\]|\\.)*"))?/g

/** A JSON-escaped YAML scalar, or undefined when it is missing or malformed —
 *  a bad one falls back to "not recorded", never to a thrown parse. */
function jsonScalar(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as string
  } catch {
    return undefined
  }
}

/** Citations declared in a note's frontmatter, in document order. */
export function parseCitations(content: string): NoteCitation[] {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content)
  if (!fm) return []
  const block = fm[1]
  // The whole line is ONE note name: a run distills a single document, and the
  // short human title may itself contain commas ("Options, Futures, and …").
  const source = (/^source:\s*(.+)$/m.exec(block)?.[1] ?? '').trim().replace(/\.md$/i, '')
  const out: NoteCitation[] = []
  for (const m of block.matchAll(CITE_RE)) {
    const start = Number(m[2])
    const end = Number(m[3])
    if (end <= start) continue
    // A malformed quote falls back to legacy (unverified) behaviour.
    const quote = jsonScalar(m[5])
    const where = jsonScalar(m[4])
    out.push({
      source,
      chunk: Number(m[1]),
      start,
      end,
      ...(quote !== undefined ? { quote } : {}),
      ...(where !== undefined ? { where } : {})
    })
  }
  return out
}

/** What a `kind: document` note says about the file it was converted from. */
export interface NoteDocument {
  /** The converted text's identity in the source store — what "Open original"
   *  is asked for. The renderer never handles the path itself. */
  hash?: string
  /** Where it came from, for display only. */
  path?: string
}

/**
 * The document a note IS, or null when the note is not a converted document.
 *
 * Only a `kind: document` note answers, so an ordinary note can never talk the
 * app into opening a file by writing `hash:` in its own frontmatter.
 */
export function parseDocumentNote(content: string): NoteDocument | null {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content)
  if (!fm || !/^kind:[ \t]*document[ \t]*$/m.test(fm[1])) return null
  const hash = /^hash:[ \t]*([0-9a-f]{40})[ \t]*$/m.exec(fm[1])?.[1]
  const path = jsonScalar(/^document:[ \t]*("(?:[^"\\]|\\.)*")[ \t]*$/m.exec(fm[1])?.[1])
  return { ...(hash ? { hash } : {}), ...(path ? { path } : {}) }
}
