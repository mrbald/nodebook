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
    'evidence, no item. Write every title, summary, and link target in the SAME ' +
    'LANGUAGE as the source chunks — a Russian text yields Russian notes; never ' +
    'translate into English. (JSON keys and "kind"/"relation" values stay exactly ' +
    'as the schema spells them.) Return ONLY JSON in this exact shape:\n' +
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

/** Characters a copy of a quote routinely loses or normalizes — fancy
 *  punctuation an LLM plainifies, and the ligatures a PDF extractor leaves
 *  behind. Fold both sides to the same plain form before comparing. A
 *  multi-char target (the ellipsis glyph, a ligature) folds to its
 *  multi-character equivalent. */
const CHAR_FOLD: Record<string, string> = {
  '’': "'", // ' RIGHT SINGLE QUOTATION MARK
  '‘': "'", // ' LEFT SINGLE QUOTATION MARK
  '`': "'", // `
  '´': "'", // ´
  '“': '"', // " LEFT DOUBLE QUOTATION MARK
  '”': '"', // " RIGHT DOUBLE QUOTATION MARK
  '–': '-', // – EN DASH
  '—': '-', // — EM DASH
  '…': '...', // … HORIZONTAL ELLIPSIS
  // Typographic ligatures: PDF text keeps them, the model retypes the letters.
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl'
}

/** A hyphen a typesetter inserted to break a word across lines: hyphen (or a
 *  soft hyphen) immediately at a line end, then the next line's indent, then a
 *  lowercase letter. The whole run folds to nothing, so "consti-\ntution"
 *  matches a quote's "constitution". Sticky: matched at a given index only. */
const HYPHEN_BREAK = /[-\u00ad]\r?\n[ \t]*(?=\p{Ll})/uy

/** SOFT HYPHEN — invisible, and never typed back by a model copying a quote. */
const SOFT_HYPHEN = '\u00ad'

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
 * space (so reflowed line breaks still match — `\s` already covers NBSP and
 * the other Unicode spaces a PDF sprinkles in), line-end hyphenation and soft
 * hyphens disappear, fancy punctuation and ligatures fold to their plain
 * equivalent, and everything lower-cases. One-to-one with the *output*
 * string's characters (an expansion like `…` → `...` emits three entries, one
 * per output character), so `norm[i]` always identifies exactly which slice
 * of the original produced the i-th normalized character. A fold with no
 * output (a soft hyphen) emits no entry at all; a match spanning it still maps
 * back to a source range that includes it, since the entries around it keep
 * their own offsets.
 */
function foldChars(s: string): NormChar[] {
  const out: NormChar[] = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '-' || ch === SOFT_HYPHEN) {
      HYPHEN_BREAK.lastIndex = i
      if (HYPHEN_BREAK.test(s)) {
        i = HYPHEN_BREAK.lastIndex // the break folds to nothing: the word joins
        continue
      }
      if (ch === SOFT_HYPHEN) {
        i++
        continue
      }
    }
    if (/\s/.test(ch)) {
      let j = i + 1
      while (j < s.length && /\s/.test(s[j])) j++
      out.push({ ch: ' ', origStart: i, origEnd: j })
      i = j
      continue
    }
    const folded = CHAR_FOLD[ch] ?? ch.toLowerCase()
    for (const c of folded) out.push({ ch: c, origStart: i, origEnd: i + 1 })
    i++
  }
  return out
}

/** A folded haystack: its normalized characters and their joined string.
 *  Built once and reused for every quote checked against the same text — the
 *  whole-document fallback would otherwise re-fold the book per quote. */
interface Folded {
  chars: NormChar[]
  norm: string
}

function fold(s: string): Folded {
  const chars = foldChars(s)
  return { chars, norm: chars.map((c) => c.ch).join('') }
}

/** Up to `limit` occurrences of `quote` in an already-folded haystack, as
 *  EXACT offsets into the original text. Callers only ever need "none /
 *  exactly one / more than one", hence the default limit of 2. */
function locateAllIn(
  h: Folded,
  quote: string,
  limit = 2
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  const qNorm = fold(quote.trim()).norm
  if (!qNorm) return out
  let from = 0
  while (out.length < limit) {
    const at = h.norm.indexOf(qNorm, from)
    if (at < 0) break
    out.push({ start: h.chars[at].origStart, end: h.chars[at + qNorm.length - 1].origEnd })
    from = at + 1 // overlapping matches count too: err towards "ambiguous"
  }
  return out
}

/**
 * Find `quote` inside `haystack`, tolerating whitespace reflow, curly
 * quotes/dashes/ellipses vs. their plain equivalents, line-end hyphenation,
 * ligatures and case differences — all things text extraction or an LLM
 * changes when a quote is "copied". Always returns EXACT offsets into the
 * original (unnormalized) `haystack`, or null if the quote can't be located
 * anywhere — which is what fails grounding.
 */
export function locateQuote(
  haystack: string,
  quote: string
): { start: number; end: number } | null {
  const q = quote.trim()
  if (!q) return null
  const exact = haystack.indexOf(q)
  if (exact >= 0) return { start: exact, end: exact + q.length }
  return locateAllIn(fold(haystack), q, 1)[0] ?? null
}

/** Where grounding may look for a quote beyond the chunk the model cited.
 *  Both are optional: with neither, grounding is exactly the old cited-chunk
 *  check. Neither ever guesses — a fallback match counts only when it is the
 *  only one. */
export interface GroundOptions {
  /** The chunks shown to the model in the same call as `chunkId` (including it
   *  — it is skipped). A model that mislabels a quote almost always names
   *  another chunk from the same prompt. */
  windowOf?: (chunkId: number) => number[]
  /** The whole source text: the last resort, and the strictest test — the
   *  quote must occur exactly once in the entire document. */
  fullText?: string
}

export interface GroundingResult {
  notes: GroundedNote[]
  /** Titles of items dropped for having no locatable evidence — surfaced, not silent. */
  droppedTitles: string[]
  /** Why things were dropped: `noEvidence` counts ITEMS the model gave no
   *  quote at all; `notFound` and `ambiguous` count QUOTES that could not be
   *  located, or matched in more than one place. */
  dropped: { noEvidence: number; notFound: number; ambiguous: number }
  /** Quotes the fallback saved: found under a different passage than the model
   *  claimed, and re-attributed to the chunk that really holds them. */
  recovered: number
}

type Located =
  | { ok: true; chunkId: number; start: number; end: number; quote: string; recovered: boolean }
  | { ok: false; reason: 'notFound' | 'ambiguous' }

/**
 * Ground each item against the source: keep only evidence whose quote can be
 * located, resolved to an absolute source span. Items left with no evidence are
 * dropped and reported. This is the gate that makes the output trustworthy.
 *
 * Search order per quote — the cited chunk, then the other chunks of the same
 * call, then the whole document — with the rule that a fallback match counts
 * only when it is UNIQUE. A quote that turns up in two places is `ambiguous`
 * and dropped: guessing which passage a note cites is worse than dropping it.
 */
export function groundItems(
  items: ExtractedItem[],
  chunks: Map<number, ChunkProvenance>,
  opts: GroundOptions = {}
): GroundingResult {
  const notes: GroundedNote[] = []
  const droppedTitles: string[] = []
  const dropped = { noEvidence: 0, notFound: 0, ambiguous: 0 }
  let recovered = 0

  // Fold each haystack at most once per run: the document fold is O(text) and
  // would otherwise be repeated for every quote.
  const chunkFolds = new Map<number, Folded>()
  const foldedChunk = (id: number, text: string): Folded => {
    let f = chunkFolds.get(id)
    if (!f) chunkFolds.set(id, (f = fold(text)))
    return f
  }
  let fullFold: Folded | null = null
  const foldedFull = (): Folded | null => {
    if (!opts.fullText) return null
    if (!fullFold) fullFold = fold(opts.fullText)
    return fullFold
  }
  // Chunk spans in id order, for mapping a document offset back to a chunk.
  let spans: { id: number; start: number; end: number }[] | null = null
  const chunkHolding = (offset: number): ChunkProvenance & { id: number } | null => {
    if (!spans)
      spans = [...chunks.entries()]
        .map(([id, c]) => ({ id, start: c.start, end: c.start + c.text.length }))
        .sort((a, b) => a.id - b.id)
    const hit = spans.find((s) => offset >= s.start && offset < s.end)
    return hit ? { id: hit.id, ...(chunks.get(hit.id) as ChunkProvenance) } : null
  }

  const locate = (ev: Evidence): Located => {
    // 1. The chunk the model cited.
    const cited = chunks.get(ev.chunkId)
    if (cited) {
      const loc = locateQuote(cited.text, ev.quote)
      if (loc)
        return {
          ok: true,
          chunkId: ev.chunkId,
          start: cited.start + loc.start,
          end: cited.start + loc.end,
          quote: cited.text.slice(loc.start, loc.end),
          recovered: false
        }
    }

    // 2. The other chunks of the same call — accepted only if exactly one of
    //    them holds the quote, exactly once.
    let hit: { id: number; start: number; end: number } | null = null
    let ambiguous = false
    for (const id of new Set(opts.windowOf?.(ev.chunkId) ?? [])) {
      if (id === ev.chunkId) continue
      const c = chunks.get(id)
      if (!c) continue
      const found = locateAllIn(foldedChunk(id, c.text), ev.quote)
      if (found.length === 0) continue
      if (found.length > 1 || hit) {
        ambiguous = true
        break
      }
      hit = { id, ...found[0] }
    }
    if (hit && !ambiguous) {
      const c = chunks.get(hit.id) as ChunkProvenance
      return {
        ok: true,
        chunkId: hit.id,
        start: c.start + hit.start,
        end: c.start + hit.end,
        quote: c.text.slice(hit.start, hit.end),
        recovered: true
      }
    }

    // 3. The whole document — the strictest test, and the one that also
    //    resolves a quote straddling a chunk boundary.
    const full = foldedFull()
    if (!full) return { ok: false, reason: ambiguous ? 'ambiguous' : 'notFound' }
    const found = locateAllIn(full, ev.quote)
    if (found.length !== 1)
      return { ok: false, reason: found.length > 1 || ambiguous ? 'ambiguous' : 'notFound' }
    const owner = chunkHolding(found[0].start)
    if (!owner) return { ok: false, reason: 'notFound' }
    return {
      ok: true,
      chunkId: owner.id,
      start: found[0].start,
      end: found[0].end,
      quote: (opts.fullText as string).slice(found[0].start, found[0].end),
      recovered: true
    }
  }

  for (const item of items) {
    if (item.evidence.length === 0) {
      dropped.noEvidence++
      droppedTitles.push(item.title)
      continue
    }
    const citations: Citation[] = []
    for (const ev of item.evidence) {
      const loc = locate(ev)
      if (!loc.ok) {
        dropped[loc.reason]++
        continue
      }
      if (loc.recovered) recovered++
      const chunk = chunks.get(loc.chunkId)
      citations.push({
        file: chunk?.file ?? '',
        chunkId: loc.chunkId,
        start: loc.start,
        end: loc.end,
        quote: loc.quote
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
  return { notes, droppedTitles, dropped, recovered }
}
