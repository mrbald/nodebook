/**
 * "Looks like the same idea under another name" — candidates for `same_as`
 * at merge time, found by meaning rather than by name.
 *
 * The merge plan (`mergePlan.ts`) can only ask about a NAME clash. A run's
 * "Split-apply-combine" and your "Group-by pattern" never clash, so the map
 * would keep two dots for one idea. This module proposes the pair; the user
 * decides, exactly as for a clash — a tick writes `same_as::`, nothing else
 * does.
 *
 * The rule is mutual nearest neighbour, not a score cutoff: a vault note is
 * proposed for a run note when it is that run note's closest vault note AND
 * the run note is that vault note's closest run note. Identity is one-to-one,
 * so at most one candidate per note on either side; and "closest both ways"
 * means the same thing for every embedding model, where a raw cosine cutoff
 * would not. `minScore` is only a floor — the vault's own "related" threshold
 * — so a tiny vault does not propose its nearest unrelated note.
 *
 * Pure: vectors in, name pairs out. The caller embeds the run's notes the way
 * the vault index embeds its own (chunk → `embedText` → mean, see
 * `noteVector`), so both sides are comparable.
 */

export interface NoteVec {
  /** The note's id on its side — a vault path, or a staged note's name. */
  id: string
  /** L2-normalised, so a dot product is cosine similarity. */
  vec: Float32Array
}

/** The mean of a note's chunk vectors, L2-normalised — the same centroid the
 *  vault store keeps per note. `null` for a note with no vectors. */
export function noteVector(chunks: Float32Array[]): Float32Array | null {
  const first = chunks.find((c) => c.length > 0)
  if (!first) return null
  const dims = first.length
  const sum = new Float32Array(dims)
  let n = 0
  for (const c of chunks) {
    if (c.length !== dims) continue
    for (let i = 0; i < dims; i++) sum[i] += c[i]
    n++
  }
  if (n === 0) return null
  let norm = 0
  for (let i = 0; i < dims; i++) {
    sum[i] /= n
    norm += sum[i] * sum[i]
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dims; i++) sum[i] /= norm
  return sum
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** The index of the closest vector in `others` (ties → the first), or -1 when
 *  nothing reaches `minScore` or has the same width. */
function nearest(v: Float32Array, others: NoteVec[], minScore: number): number {
  let best = -1
  let bestScore = minScore
  for (let i = 0; i < others.length; i++) {
    const o = others[i].vec
    if (o.length !== v.length) continue
    const s = dot(v, o)
    if (s > bestScore || (s === bestScore && best < 0 && s >= minScore)) {
      best = i
      bestScore = s
    }
  }
  return best
}

/**
 * Run note id → vault note id, for every mutual nearest pair at or above
 * `minScore`. Deterministic: ties resolve to the earlier entry on each side.
 */
export function sameAsCandidates(
  run: NoteVec[],
  vault: NoteVec[],
  minScore: number
): Map<string, string> {
  const out = new Map<string, string>()
  if (run.length === 0 || vault.length === 0) return out
  for (let r = 0; r < run.length; r++) {
    const v = nearest(run[r].vec, vault, minScore)
    if (v < 0) continue
    if (nearest(vault[v].vec, run, minScore) !== r) continue
    out.set(run[r].id, vault[v].id)
  }
  return out
}
