/**
 * Merge near-duplicate notes within a distill run. Two clusters often surface the
 * same concept (e.g. one says "Faction", another "Factions"; or both extract the
 * same passage), and an unmerged map shows the same idea twice. Pure and
 * deterministic — golden-tested.
 *
 * Two signals fire a merge, either alone: near-identical TITLES (character-
 * trigram Jaccard) or heavily OVERLAPPING citation spans (the same source text).
 * The embedding-cosine signal the council favours needs vectors from the impure
 * layer, so it's an optional `similarity` hook the orchestrator can supply; the
 * pure core works (and tests) without it.
 */

import type { GroundedNote, Citation, Link } from './extract'

/** Character trigrams of a string (lowercased, whitespace-collapsed, space-padded). */
function trigrams(s: string): Set<string> {
  const t = ` ${s.toLowerCase().replace(/\s+/g, ' ').trim()} `
  const set = new Set<string>()
  for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3))
  return set
}

/** Trigram Jaccard similarity of two strings (0..1). Two empty strings → 1. */
export function trigramSimilarity(a: string, b: string): number {
  const A = trigrams(a)
  const B = trigrams(b)
  if (A.size === 0 && B.size === 0) return 1
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  const union = A.size + B.size - inter
  return union === 0 ? 0 : inter / union
}

/** Overlap of two citation spans as a fraction of the shorter span (0..1). */
function spanOverlapFrac(a: Citation, b: Citation): number {
  if (a.file !== b.file) return 0
  const ov = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
  const minLen = Math.min(a.end - a.start, b.end - b.start)
  return minLen > 0 ? ov / minLen : 0
}

/** Best span overlap across any pair of citations between two notes. */
function maxSpanOverlap(a: GroundedNote, b: GroundedNote): number {
  let m = 0
  for (const ca of a.citations) for (const cb of b.citations) m = Math.max(m, spanOverlapFrac(ca, cb))
  return m
}

export interface DedupOptions {
  /** Trigram-title similarity at/above which two notes merge. Default 0.82. */
  titleSim?: number
  /** Citation-span overlap at/above which two notes merge. Default 0.6. */
  spanOverlap?: number
  /** Optional extra signal (e.g. embedding cosine of title+summary). */
  similarity?: (a: GroundedNote, b: GroundedNote) => number
  /** Threshold for the optional `similarity` hook. Default 0.88. */
  similarityThreshold?: number
}

const citeKey = (c: Citation): string => `${c.file}:${c.start}-${c.end}`
const linkKey = (l: Link): string => `${l.relation}\u0000${l.target}`

function cloneNote(n: GroundedNote): GroundedNote {
  return {
    kind: n.kind,
    title: n.title,
    summary: n.summary,
    links: n.links.map((l) => ({ ...l })),
    citations: n.citations.map((c) => ({ ...c }))
  }
}

/** Title to keep on merge: better-grounded (more citations) wins; tie → shorter
 *  (sharper); tie → lexicographically smaller. Deterministic. */
function preferredTitle(a: GroundedNote, b: GroundedNote): string {
  if (a.citations.length !== b.citations.length)
    return a.citations.length > b.citations.length ? a.title : b.title
  if (a.title.length !== b.title.length) return a.title.length < b.title.length ? a.title : b.title
  return a.title <= b.title ? a.title : b.title
}

/** Fold `b` into the accumulator `a` in place: union citations + links, keep the
 *  sharper title and the longer summary. */
function mergeInto(a: GroundedNote, b: GroundedNote): void {
  a.title = preferredTitle(a, b)
  if (b.summary.length > a.summary.length) a.summary = b.summary
  const seenC = new Set(a.citations.map(citeKey))
  for (const c of b.citations)
    if (!seenC.has(citeKey(c))) {
      a.citations.push(c)
      seenC.add(citeKey(c))
    }
  const seenL = new Set(a.links.map(linkKey))
  for (const l of b.links)
    if (!seenL.has(linkKey(l))) {
      a.links.push(l)
      seenL.add(linkKey(l))
    }
}

/**
 * Merge near-duplicate notes. Greedy single pass: each note folds into the first
 * earlier note it matches, else stands on its own. Inputs are not mutated.
 *
 * Returns the merged notes, how many merges happened, and `aliases`: every
 * title that stopped existing here mapped to the title that survived in its
 * place. A merge silently invalidates links — another note may already point at
 * "Factions" when only "Faction" is left — so `emit.ts` threads this map
 * through `link.ts` and remaps those targets. Chains resolve themselves: the
 * map is built at the end, from each surviving note's FINAL title.
 */
export function dedup(
  notes: GroundedNote[],
  opts: DedupOptions = {}
): { notes: GroundedNote[]; merged: number; aliases: Map<string, string> } {
  const titleSim = opts.titleSim ?? 0.82
  const spanOverlap = opts.spanOverlap ?? 0.6
  const simThreshold = opts.similarityThreshold ?? 0.88

  const similar = (a: GroundedNote, b: GroundedNote): boolean =>
    trigramSimilarity(a.title, b.title) >= titleSim ||
    maxSpanOverlap(a, b) >= spanOverlap ||
    (opts.similarity ? opts.similarity(a, b) >= simThreshold : false)

  const result: GroundedNote[] = []
  /** Every input title folded into result[i], parallel to `result`. */
  const foldedTitles: string[][] = []
  let merged = 0
  for (const note of notes) {
    const clone = cloneNote(note)
    const at = result.findIndex((r) => similar(r, clone))
    if (at >= 0) {
      mergeInto(result[at], clone)
      foldedTitles[at].push(note.title)
      merged++
    } else {
      result.push(clone)
      foldedTitles.push([note.title])
    }
  }

  // A title that a surviving note still carries belongs to that note — never
  // alias it away, or a link would be redirected to the wrong one.
  const survivors = new Set(result.map((r) => r.title))
  const aliases = new Map<string, string>()
  result.forEach((r, i) => {
    for (const title of foldedTitles[i])
      if (!survivors.has(title) && !aliases.has(title)) aliases.set(title, r.title)
  })
  return { notes: result, merged, aliases }
}
