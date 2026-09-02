/**
 * Link integrity inside one distill run — how a `[[target]]` finds its note.
 * Pure and dependency-free; the orchestrator calls it through `emit.ts`.
 *
 * The model writes link targets as free text ("Factions", "the extended
 * republic"), and by the time notes are emitted those titles have moved twice:
 * `dedup()` absorbs near-duplicates into one surviving title, and `emitNotes()`
 * de-collides duplicate file names (`Book` → `Book 2`). A target written before
 * either step points at a note that no longer exists — a GHOST link, a dead end
 * in the map. This module closes that gap in one place:
 *
 *  1. **Alias** — follow dedup's {absorbed title → surviving title} map.
 *  2. **Name** — look the title up in {title → final note name}.
 *  3. **Normalize** — a target already spelled as a final name resolves to it.
 *  4. **Snap** — otherwise take the closest emitted name at trigram ≥ 0.82
 *     (highest wins, ties → shortest). Below that we do NOT guess: the link
 *     stays a ghost and is counted, so a bad number is visible rather than
 *     hidden behind a wrong edge.
 *
 * On top of that it adds **mention links**: if note A's own text names note B,
 * that is an edge the model simply forgot to write down. Deterministic, no
 * model call — a name is only linked when it is specific enough to be
 * unambiguous (two words, or one capitalised word of four letters or more) and
 * occurs word-bounded in A's summary or quotes.
 */

import { trigramSimilarity } from './dedup'
import type { Link } from './extract'

/** Trigram similarity at/above which an unresolved target snaps to a name. */
export const SNAP_THRESHOLD = 0.82
/** Most mention links added to one note (earliest occurrences win). */
export const MENTION_CAP = 8
/** The relation this module writes for a name found in a note's own text. */
export const MENTION_RELATION = 'mentions'

/** Longest note name, in UTF-8 bytes. A name is a file name, and every common
 *  filesystem stops at 255 bytes — a model's sentence-long "claim" title in
 *  Cyrillic or CJK gets there in far fewer characters than it looks, and the
 *  write that fails is the one at the very end of a paid run. Well under the
 *  limit, so the `Name 2` de-collision suffix always still fits. */
export const NAME_MAX_BYTES = 120

/** Cut `s` back to the last word boundary that fits in `max` UTF-8 bytes (or
 *  to a plain character cut when there is no space to break at). */
function capBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s
  let cut = ''
  for (const ch of s) {
    if (Buffer.byteLength(cut + ch, 'utf8') > max) break
    cut += ch
  }
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()
}

/**
 * Normalize a title into a safe note name: strip path- and wikilink-hostile
 * characters, collapse whitespace, and cap the length a file name can carry
 * (`NAME_MAX_BYTES`). Applied identically to note names and to link targets,
 * so a `[[target]]` can resolve to the note emitted for it.
 */
export function noteName(title: string): string {
  const n = capBytes(title.replace(/[\\/:*?"<>|#[\]]+/g, ' ').replace(/\s+/g, ' ').trim(), NAME_MAX_BYTES)
  return n || 'untitled'
}

/** One note as the linker sees it: what it is called, and what its text says. */
export interface LinkableNote {
  /** The title the model gave it — the key dedup's alias map speaks in. */
  title: string
  /** Its final note name (after de-collision) — how links address it. */
  name: string
  summary: string
  /** The note's quotes, whitespace-collapsed as they are rendered. */
  quotes: string[]
  links: Link[]
}

export interface LinkOptions {
  /** dedup's {absorbed title → surviving title} map. */
  aliases?: Map<string, string>
  /** Snap threshold (default `SNAP_THRESHOLD`). */
  snap?: number
  /** Add mention links (default true). */
  mentions?: boolean
  /** Mention cap per note (default `MENTION_CAP`). */
  mentionCap?: number
}

export interface LinkedNotes {
  /** Final links per note, parallel to the input. */
  links: Link[][]
  /** Total links written (every relation but `source::`, ghosts included). */
  edges: number
  /** Of those, how many still point at no emitted note. */
  ghostLinks: number
  /** Of those, how many this module added from a name found in the text. */
  mentions: number
  /** Connected components over the notes, links read as undirected. */
  components: number
}

/** Follow an alias chain to its end. Bounded, so a cyclic map can't hang. */
function followAlias(title: string, aliases: Map<string, string>): string {
  let cur = title
  for (let i = 0; i < 8; i++) {
    const next = aliases.get(cur)
    if (next === undefined || next === cur) break
    cur = next
  }
  return cur
}

/** Build the four-step target resolver (see the module header). Returns the
 *  emitted name a target resolves to, or null when it stays a ghost. */
function makeResolver(
  names: string[],
  nameOf: Map<string, string>,
  aliases: Map<string, string>,
  snap: number
): (target: string) => string | null {
  const nameSet = new Set(names)
  return (target: string): string | null => {
    const raw = target.trim()
    if (!raw) return null
    const aliased = followAlias(raw, aliases)
    const byTitle = nameOf.get(aliased) ?? nameOf.get(raw)
    if (byTitle) return byTitle
    const normalized = noteName(aliased)
    if (nameSet.has(normalized)) return normalized
    let best: string | null = null
    let bestScore = 0
    for (const name of names) {
      const score = trigramSimilarity(aliased, name)
      if (score < snap || score < bestScore) continue
      if (score > bestScore || name.length < (best as string).length) {
        best = name
        bestScore = score
      }
    }
    return best
  }
}

/** Resolve one link target against a run's emitted names. Exposed for tests
 *  and for callers that need the rule without the whole pass. */
export function resolveTarget(
  target: string,
  names: string[],
  opts: { nameOf?: Map<string, string>; aliases?: Map<string, string>; snap?: number } = {}
): string | null {
  return makeResolver(
    names,
    opts.nameOf ?? new Map(),
    opts.aliases ?? new Map(),
    opts.snap ?? SNAP_THRESHOLD
  )(target)
}

// --- Mention linking --------------------------------------------------------

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

/**
 * Whether a note name is specific enough to link on sight. Two or more words
 * ("Extended republic") name one thing; a single word only does when it reads
 * as a proper name — capitalised and at least four letters — so common words
 * like "Use" or "Power" don't wire every note to every other one.
 */
export function isMentionable(name: string): boolean {
  const tokens = name.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  if (tokens.length >= 2) return true
  const letters = [...tokens[0]].filter((ch) => /\p{L}/u.test(ch)).length
  return letters >= 4 && /^\p{Lu}/u.test(tokens[0])
}

/**
 * Index of the first case-insensitive, word-bounded occurrence of `needle` in
 * `hay`, or -1. The boundary test is Unicode-aware on purpose: JavaScript's
 * `\b` only knows ASCII word characters, so a regex would mis-handle a Russian
 * or Greek note name.
 */
export function findMention(hay: string, needle: string): number {
  if (!needle) return -1
  const h = hay.toLowerCase()
  const n = needle.toLowerCase()
  for (let from = 0; from <= h.length - n.length; ) {
    const i = h.indexOf(n, from)
    if (i < 0) return -1
    const before = i > 0 ? h[i - 1] : ''
    const after = i + n.length < h.length ? h[i + n.length] : ''
    if (!LETTER_OR_DIGIT.test(before) && !LETTER_OR_DIGIT.test(after)) return i
    from = i + 1
  }
  return -1
}

/** Mention links to add to note `i`: other notes named in its own text, in
 *  order of first occurrence, capped. Never itself, never a note it already
 *  links to. */
function mentionsFor(
  i: number,
  notes: LinkableNote[],
  links: Link[][],
  cap: number
): Link[] {
  const self = notes[i]
  const hay = [self.summary, ...self.quotes].join('\n')
  if (!hay.trim()) return []
  const already = new Set(links[i].map((l) => l.target))
  const hits: { at: number; name: string }[] = []
  for (let j = 0; j < notes.length; j++) {
    const name = notes[j].name
    if (j === i || name === self.name || already.has(name) || !isMentionable(name)) continue
    const at = findMention(hay, name)
    if (at >= 0) hits.push({ at, name })
  }
  // Earliest mention first; a tie goes to the shorter, then lower name, so the
  // cap always cuts the same way for the same input.
  hits.sort((a, b) => a.at - b.at || a.name.length - b.name.length || (a.name < b.name ? -1 : 1))
  const seen = new Set<string>()
  const out: Link[] = []
  for (const hit of hits) {
    if (seen.has(hit.name)) continue
    seen.add(hit.name)
    out.push({ relation: MENTION_RELATION, target: hit.name })
    if (out.length >= cap) break
  }
  return out
}

// --- Shape of the resulting graph -------------------------------------------

/** Connected components over `names`, joined by every link whose target is one
 *  of them (undirected; a ghost link joins nothing). */
export function countComponents(names: string[], links: Link[][]): number {
  if (names.length === 0) return 0
  const parent = new Map<string, string>(names.map((n) => [n, n]))
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root) as string
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  names.forEach((name, i) => {
    for (const link of links[i] ?? []) {
      if (!parent.has(link.target)) continue
      const a = find(name)
      const b = find(link.target)
      if (a !== b) parent.set(a, b)
    }
  })
  return new Set(names.map(find)).size
}

/**
 * Resolve every link of a run, then add mention links. The returned `links` are
 * what the notes should actually carry: targets remapped onto emitted names,
 * self-links dropped (the map skips them anyway), duplicates collapsed, and the
 * counts the run reports.
 */
export function linkNotes(notes: LinkableNote[], opts: LinkOptions = {}): LinkedNotes {
  const names = notes.map((n) => n.name)
  const nameOf = new Map<string, string>()
  for (const n of notes) if (!nameOf.has(n.title)) nameOf.set(n.title, n.name)
  const resolve = makeResolver(
    names,
    nameOf,
    opts.aliases ?? new Map(),
    opts.snap ?? SNAP_THRESHOLD
  )

  let ghostLinks = 0
  const links: Link[][] = notes.map((note) => {
    const out: Link[] = []
    const seen = new Set<string>()
    for (const link of note.links) {
      const resolved = resolve(link.target)
      // An unresolved target still gets written, as the ghost it is — a name
      // the document used that this run has no note for.
      const target = resolved ?? noteName(link.target)
      if (target === note.name) continue
      const key = `${link.relation} ${target}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!resolved) ghostLinks++
      out.push({ relation: link.relation, target })
    }
    return out
  })

  let mentions = 0
  if (opts.mentions ?? true) {
    const cap = opts.mentionCap ?? MENTION_CAP
    notes.forEach((_, i) => {
      const add = mentionsFor(i, notes, links, cap)
      links[i].push(...add)
      mentions += add.length
    })
  }

  return {
    links,
    edges: links.reduce((sum, ls) => sum + ls.length, 0),
    ghostLinks,
    mentions,
    components: countComponents(names, links)
  }
}
