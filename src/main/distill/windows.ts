/**
 * Planning what the model reads, in order — the pure half of "read the whole
 * document".
 *
 * The old pipeline embedded every chunk, clustered them, and showed the model
 * four representatives per cluster: a fixed 96 passages of any document, chosen
 * as "the most typical passage per theme". A book was therefore sampled, and
 * the reported coverage was a chunk count rather than a share of the text.
 *
 * This module replaces that with the approach every published document-to-graph
 * pipeline uses (GraphRAG, Edge et al. 2024; LightRAG, Guo et al. 2024): read
 * every text unit, in document order, and let the merge afterwards do the
 * organising. Consecutive chunks are packed into WINDOWS as large as the
 * model's declared prompt budget allows, so a document costs one call per
 * window and nothing is skipped.
 *
 * Sampling survives only as the bounded-cost fallback: when a document needs
 * more windows than the user's call budget, windows are kept at an even stride
 * across the document (never "the most typical", which quietly biases the map
 * towards the middle of each theme) and `coverage` says exactly what share of
 * the text that was, by weight.
 *
 * Pure and dependency-free: no fs, no model, no clock. `weightOf`/`embedText`
 * come from the chunker so budgets here are in the same units the chunker
 * itself uses (a Latin character = 1, a CJK code point = 3).
 */

import { embedText, weightOf, type Chunk } from '../rag/chunk'

/** One model call's worth of source: the chunk ids it will be shown, in
 *  document order. */
export interface PlannedWindow {
  chunkIds: number[]
}

export interface WindowPlan {
  /** The windows that will actually be read, in document order. */
  windows: PlannedWindow[]
  /** Share (0..1) of the document's text — BY WEIGHT, counting each source
   *  range once — that those windows cover. 1 = the whole document is read. */
  coverage: number
  /** Windows the document needs in full, before any call-budget sampling.
   *  `totalWindows > windows.length` is exactly "this ran over budget". */
  totalWindows: number
}

export interface PlanOptions {
  /** Maximum weight of chunk text in one window. A single chunk heavier than
   *  this becomes its own (over-budget) window rather than being dropped. */
  windowWeight: number
  /** Hard ceiling on model calls, i.e. on windows kept. */
  maxCalls: number
  /** Weight to charge each chunk on top of its own text, for the prompt
   *  scaffolding around it (`[chunk 12 — Heading]` markers, blank lines). 0 by
   *  default; the orchestrator passes the real cost so the packed window plus
   *  the scaffolding still fits the declared budget. */
  perChunkOverhead?: number
}

/**
 * Weight of the union of these chunks' source ranges: overlapping ranges (the
 * chunker gives consecutive chunks of one section a small tail overlap) are
 * counted ONCE, so coverage can never be inflated by double-counting. Uses each
 * chunk's own text — `source.slice(start, end) === text` is guaranteed by the
 * chunker — so the source string is not needed here.
 */
export function unionWeight(chunks: Chunk[]): number {
  const sorted = [...chunks].sort((a, b) => a.start - b.start || a.end - b.end)
  let total = 0
  let covered = -1
  for (const c of sorted) {
    const from = Math.max(c.start, covered)
    if (from >= c.end) continue // fully inside a range already counted
    total += weightOf(c.text, from - c.start, c.text.length)
    covered = c.end
  }
  return total
}

/**
 * Share (0..1) of the document's text, by weight, that `kept` chunk ids cover.
 * Each source range counts once on both sides of the ratio, so overlapping
 * chunks neither inflate what was read nor what there was to read. An empty
 * document is trivially fully covered.
 */
export function coverageOf(chunks: Chunk[], kept: readonly number[]): number {
  const total = unionWeight(chunks)
  if (total === 0) return 1
  return unionWeight(kept.map((id) => chunks[id]).filter(Boolean)) / total
}

/**
 * `count` positions spread evenly over `total` slots, as centres of equal
 * buckets: for 10 windows kept 3, that is windows 1, 5 and 8 — the start,
 * middle and end of the document, not its first three windows. Deterministic
 * (no RNG), strictly increasing, and identical for the estimate and the run.
 */
export function evenStride(total: number, count: number): number[] {
  if (count >= total) return Array.from({ length: total }, (_, i) => i)
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push(Math.floor(((i + 0.5) * total) / count))
  return out
}

/**
 * Pack `chunks` into windows and report what the plan actually covers.
 *
 * Packing is strictly consecutive — a window is a contiguous run of the
 * document — so the model reads passages in the order the author wrote them and
 * the concept registry (`registry.ts`) accumulates in that order too.
 */
export function planWindows(chunks: Chunk[], opts: PlanOptions): WindowPlan {
  const limit = Math.max(1, opts.windowWeight)
  const maxCalls = Math.max(1, Math.floor(opts.maxCalls))
  const overhead = Math.max(0, opts.perChunkOverhead ?? 0)
  if (chunks.length === 0) return { windows: [], coverage: 1, totalWindows: 0 }

  const all: PlannedWindow[] = []
  let current: number[] = []
  let currentWeight = 0
  for (let id = 0; id < chunks.length; id++) {
    const w = weightOf(embedText(chunks[id])) + overhead
    // A chunk that cannot fit any window still gets read — on its own, so the
    // backend's own rejection (if any) costs one window and not its neighbours.
    if (current.length > 0 && currentWeight + w > limit) {
      all.push({ chunkIds: current })
      current = []
      currentWeight = 0
    }
    current.push(id)
    currentWeight += w
  }
  if (current.length > 0) all.push({ chunkIds: current })

  // Within budget every chunk is read, so coverage is 1 by construction — no
  // need to weigh the document to say so.
  if (all.length <= maxCalls) return { windows: all, coverage: 1, totalWindows: all.length }

  const windows = evenStride(all.length, maxCalls).map((i) => all[i])
  return {
    windows,
    coverage: coverageOf(
      chunks,
      windows.flatMap((w) => w.chunkIds)
    ),
    totalWindows: all.length
  }
}
