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
 *
 * This module also holds the pure "Ask" citation-gating helpers: deciding which
 * `[[wikilink]]`s in a streamed answer are real citations (named in the
 * retrieved sources) vs. a hallucinated/misremembered name that must not render
 * as a clickable link.
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

// ---------------------------------------------------------------------------
// Self-healing citation spans — a source note can be edited after a distill
// run, so the recorded [start,end) can drift. If the quote no longer matches
// at that span, search the content for it before giving up.
// ---------------------------------------------------------------------------

/** Collapse whitespace runs to a single space and trim, for a reflow-tolerant
 *  equality check between the recorded span's text and its quote. */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Escape a string for literal use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Find `quote` inside `haystack`, tolerating whitespace reflow. Mirrors
 *  distill/extract.ts's `locateQuote`; duplicated because main and renderer
 *  don't share a module boundary (see tsconfig.node.json / tsconfig.web.json). */
function locateQuote(haystack: string, quote: string): { start: number; end: number } | null {
  const q = quote.trim()
  if (!q) return null
  const exact = haystack.indexOf(q)
  if (exact >= 0) return { start: exact, end: exact + q.length }
  const pattern = q.split(/\s+/).map(escapeRe).join('\\s+')
  const m = new RegExp(pattern, 'i').exec(haystack)
  return m ? { start: m.index, end: m.index + m[0].length } : null
}

export type CitationSpanResult =
  | { status: 'ok' | 'relocated' | 'unverified'; start: number; end: number }
  | { status: 'not-found' }

/**
 * Resolve where a citation's span actually is in the source note's current
 * `content`. A citation with no recorded quote is trusted as-is ('unverified'
 * — legacy behavior, from before quotes were captured). Otherwise: if the
 * text at [start,end) still matches the quote (whitespace-tolerant), it's
 * 'ok'; if the quote is found elsewhere, 'relocated' to that span; if it can't
 * be found anywhere, 'not-found' — the caller should open the note without a
 * selection and say so.
 */
export function resolveCitationSpan(content: string, c: NoteCitation): CitationSpanResult {
  if (c.quote === undefined) return { status: 'unverified', start: c.start, end: c.end }
  const at = content.slice(c.start, c.end)
  if (normalizeWs(at) === normalizeWs(c.quote)) return { status: 'ok', start: c.start, end: c.end }
  const loc = locateQuote(content, c.quote)
  return loc ? { status: 'relocated', start: loc.start, end: loc.end } : { status: 'not-found' }
}

// ---------------------------------------------------------------------------
// "Ask" answer citation gating — only a `[[wikilink]]` that names a retrieved
// source is a real citation; anything else must render as plain text so a
// hallucinated citation can't look identical to a real one.
// ---------------------------------------------------------------------------

/** A wikilink's target from its `[[inner]]` text — matches markdownRender.ts's
 *  wikilink rule exactly (target is before `|` display text and `#` anchor). */
function wikilinkTarget(inner: string): string {
  return inner.split('|')[0].split('#')[0].trim()
}

const WIKILINK_RE = /\[\[([^[\]]+)\]\]/g

/**
 * Rewrite an answer's `[[wikilink]]` syntax so only real citations stay
 * clickable: a target that exactly (case-sensitively) names one of `sources`
 * is left as wikilink syntax; anything else — a hallucinated or misremembered
 * name — is flattened to its plain display text, so `renderMarkdown` can't
 * turn it into a link.
 */
export function gateAnswerCitations(answer: string, sources: string[]): string {
  const known = new Set(sources)
  return answer.replace(WIKILINK_RE, (whole, inner: string) => {
    if (known.has(wikilinkTarget(inner))) return whole
    return inner.includes('|') ? inner.split('|')[1].trim() : wikilinkTarget(inner)
  })
}

/** Names from `sources` that `answer` actually cites via an exact,
 *  case-sensitive `[[wikilink]]` — the answer's real grounding, vs. merely
 *  having been retrieved as context. */
export function usedCitations(answer: string, sources: string[]): Set<string> {
  const known = new Set(sources)
  const used = new Set<string>()
  for (const m of answer.matchAll(WIKILINK_RE)) {
    const target = wikilinkTarget(m[1])
    if (known.has(target)) used.add(target)
  }
  return used
}
