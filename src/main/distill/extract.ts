/**
 * The extraction contract for "distill a document": turn a cluster's source
 * chunks into cited concept/claim/entity notes. Pure and dependency-free — the
 * model call itself lives in the orchestrator. Here we (1) build the extraction
 * prompt, (2) parse the model's JSON tolerantly, and (3) GROUND every item by
 * confirming its quote actually occurs in the cited chunk.
 *
 * Grounding is the anti-hallucination gate: "no evidence span, no item." An item
 * whose quotes can't be located in the source is dropped, not trusted — bad
 * notes with confident wording are exactly what makes a distilled map feel like
 * busywork instead of knowledge.
 */

export type ItemKind = 'concept' | 'claim' | 'entity'

export interface Evidence {
  /** The source chunk this quote was copied from. */
  chunkId: number
  /** A verbatim span from that chunk (extractive-first). */
  quote: string
}

export interface Link {
  relation: string
  target: string
}

/** A parsed-but-not-yet-grounded item from the model. */
export interface ExtractedItem {
  kind: ItemKind
  title: string
  summary: string
  evidence: Evidence[]
  links: Link[]
}

/** Provenance for one source chunk, so a quote resolves to an absolute span. */
export interface ChunkProvenance {
  file: string
  /** Character offset of the chunk's text within the source note. */
  start: number
  text: string
}

/** A resolved citation: where in the source a quote actually lives. */
export interface Citation {
  file: string
  chunkId: number
  /** Character offsets [start, end) into the source note. */
  start: number
  end: number
  /** The exact source text at that span (not the model's possibly-reflowed quote). */
  quote: string
}

/** An item that survived grounding, with its quotes resolved to source spans. */
export interface GroundedNote {
  kind: ItemKind
  title: string
  summary: string
  links: Link[]
  citations: Citation[]
}

/** One source chunk shown to the model, tagged with its id and heading context. */
export interface ClusterChunk {
  chunkId: number
  heading: string
  text: string
}

const KINDS = new Set<ItemKind>(['concept', 'claim', 'entity'])

const SCHEMA_HINT = `{
  "items": [
    {
      "kind": "concept" | "claim" | "entity",
      "title": "short noun phrase — becomes the note name",
      "summary": "1-3 sentences, only what the quotes support",
      "evidence": [ { "chunkId": <number>, "quote": "text copied verbatim from that chunk" } ],
      "links": [ { "relation": "about" | "supports" | "contrasts_with" | "part_of", "target": "another item's title" } ]
    }
  ]
}`

/**
 * Build the system+user prompt for one cluster. Extractive-first and explicit
 * about the grounding rule, so the model's own output is checkable against the
 * source. Pure: returns strings, runs no model.
 */
export function buildExtractionPrompt(chunks: ClusterChunk[]): { system: string; user: string } {
  const system =
    'You extract structured knowledge from source text into cited notes. Work ' +
    'EXTRACTIVELY: every claim must be backed by a verbatim quote copied from one ' +
    'of the provided chunks, tagged with that chunk id. Do not assert anything the ' +
    'chunks do not state. If you cannot quote support for a claim, omit it — no ' +
    'evidence, no item. Return ONLY JSON in this exact shape:\n' +
    SCHEMA_HINT
  const body = chunks
    .map((c) => `[chunk ${c.chunkId}${c.heading ? ` — ${c.heading}` : ''}]\n${c.text}`)
    .join('\n\n')
  const user =
    'Extract the key concepts, claims, and entities in these source chunks, and ' +
    'how they relate. Each item needs at least one evidence quote with its chunk ' +
    'id. Prefer a few well-supported items over many weak ones.\n\nSOURCE CHUNKS:\n\n' +
    body
  return { system, user }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function coerceItem(raw: unknown): ExtractedItem | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const title = asString(o.title)
  if (!title) return null
  const kind = (KINDS.has(o.kind as ItemKind) ? (o.kind as ItemKind) : 'concept')
  const summary = asString(o.summary)

  const evidence: Evidence[] = []
  if (Array.isArray(o.evidence)) {
    for (const e of o.evidence) {
      if (!e || typeof e !== 'object') continue
      const ev = e as Record<string, unknown>
      const chunkId = typeof ev.chunkId === 'number' ? ev.chunkId : Number(ev.chunkId)
      const quote = asString(ev.quote)
      if (Number.isFinite(chunkId) && quote) evidence.push({ chunkId, quote })
    }
  }

  const links: Link[] = []
  if (Array.isArray(o.links)) {
    for (const l of o.links) {
      if (!l || typeof l !== 'object') continue
      const lo = l as Record<string, unknown>
      const relation = asString(lo.relation)
      const target = asString(lo.target)
      if (relation && target) links.push({ relation, target })
    }
  }

  return { kind, title, summary, evidence, links }
}

/**
 * Parse the model's reply into items. Tolerant of ```json fences and surrounding
 * prose: we take the outermost {...}. `ok` is false when there is no parseable
 * JSON object at all — the caller can then retry once with a repair prompt.
 * `ok` true with items=[] means valid JSON that carried nothing usable.
 */
export function parseExtraction(raw: string): { ok: boolean; items: ExtractedItem[] } {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, items: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return { ok: false, items: [] }
  }
  const rawItems = (parsed as { items?: unknown } | null)?.items
  if (!Array.isArray(rawItems)) return { ok: false, items: [] }
  const items: ExtractedItem[] = []
  for (const it of rawItems) {
    const item = coerceItem(it)
    if (item) items.push(item)
  }
  return { ok: true, items }
}

/** Punctuation an LLM routinely normalizes away when it copies a quote — fold
 *  both sides to the same plain form before comparing. Multi-char targets
 *  (the ellipsis glyph) fold to their multi-character equivalent. */
const PUNCT_FOLD: Record<string, string> = {
  '’': "'", // ' RIGHT SINGLE QUOTATION MARK
  '‘': "'", // ' LEFT SINGLE QUOTATION MARK
  '`': "'", // `
  '´': "'", // ´
  '“': '"', // " LEFT DOUBLE QUOTATION MARK
  '”': '"', // " RIGHT DOUBLE QUOTATION MARK
  '–': '-', // – EN DASH
  '—': '-', // — EM DASH
  '…': '...' // … HORIZONTAL ELLIPSIS
}

/** One normalized character, remembering the exact original span it came
 *  from — so a match found in the normalized string maps back to exact
 *  offsets into the original. */
interface NormChar {
  ch: string
  origStart: number
  origEnd: number
}

/**
 * Fold `s` into normalized characters: whitespace runs collapse to a single
 * space (so reflowed line breaks still match), fancy punctuation folds to its
 * plain equivalent, and everything lower-cases. One-to-one with the *output*
 * string's characters (an expansion like `…` → `...` emits three entries, one
 * per output character), so `norm[i]` always identifies exactly which slice
 * of the original produced the i-th normalized character.
 */
function foldChars(s: string): NormChar[] {
  const out: NormChar[] = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (/\s/.test(ch)) {
      let j = i + 1
      while (j < s.length && /\s/.test(s[j])) j++
      out.push({ ch: ' ', origStart: i, origEnd: j })
      i = j
      continue
    }
    const folded = PUNCT_FOLD[ch] ?? ch.toLowerCase()
    for (const c of folded) out.push({ ch: c, origStart: i, origEnd: i + 1 })
    i++
  }
  return out
}

/**
 * Find `quote` inside `haystack`, tolerating whitespace reflow, curly
 * quotes/dashes/ellipses vs. their plain equivalents, and case differences —
 * all things an LLM normalizes when it "copies" a quote. Always returns EXACT
 * offsets into the original (unnormalized) `haystack`, or null if the quote
 * can't be located anywhere — which is what fails grounding.
 */
export function locateQuote(
  haystack: string,
  quote: string
): { start: number; end: number } | null {
  const q = quote.trim()
  if (!q) return null
  const exact = haystack.indexOf(q)
  if (exact >= 0) return { start: exact, end: exact + q.length }

  const hChars = foldChars(haystack)
  const hNorm = hChars.map((c) => c.ch).join('')
  const qNorm = foldChars(q)
    .map((c) => c.ch)
    .join('')
  if (!qNorm) return null

  const at = hNorm.indexOf(qNorm)
  if (at < 0) return null
  return { start: hChars[at].origStart, end: hChars[at + qNorm.length - 1].origEnd }
}

export interface GroundingResult {
  notes: GroundedNote[]
  /** Titles of items dropped for having no locatable evidence — surfaced, not silent. */
  droppedTitles: string[]
}

/**
 * Ground each item against its cited chunks: keep only evidence whose quote can
 * be located, resolved to an absolute source span. Items left with no evidence
 * are dropped and reported. This is the gate that makes the output trustworthy.
 */
export function groundItems(
  items: ExtractedItem[],
  chunks: Map<number, ChunkProvenance>
): GroundingResult {
  const notes: GroundedNote[] = []
  const droppedTitles: string[] = []
  for (const item of items) {
    const citations: Citation[] = []
    for (const ev of item.evidence) {
      const chunk = chunks.get(ev.chunkId)
      if (!chunk) continue
      const loc = locateQuote(chunk.text, ev.quote)
      if (!loc) continue
      citations.push({
        file: chunk.file,
        chunkId: ev.chunkId,
        start: chunk.start + loc.start,
        end: chunk.start + loc.end,
        quote: chunk.text.slice(loc.start, loc.end)
      })
    }
    if (citations.length === 0) {
      droppedTitles.push(item.title)
      continue
    }
    notes.push({
      kind: item.kind,
      title: item.title,
      summary: item.summary,
      links: item.links,
      citations
    })
  }
  return { notes, droppedTitles }
}
