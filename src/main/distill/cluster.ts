/**
 * Pure, deterministic k-means over chunk embedding vectors — the first step of
 * "distill a document". Grouping a book's chunks into K semantic clusters is
 * what bounds the LLM extraction cost: each cluster's *representative* chunks go
 * to the model once, instead of the whole book on repeat.
 *
 * Deterministic by construction (golden-testable, and re-running the same book
 * yields the same map): no RNG. Initialization is furthest-first (Gonzalez) with
 * ties broken by smallest id; assignment ties break to the lowest cluster index;
 * points are processed in id order. The inputs are L2-normalized embeddings, so
 * squared-Euclidean nearest-centroid is monotonic with cosine similarity.
 */

export interface Point {
  /** Stable chunk id (matches the `chunks.id` column). */
  id: number
  /** The chunk's embedding (L2-normalized). */
  vec: Float32Array
}

export interface Cluster {
  /** Every chunk id in this cluster, ascending. */
  memberIds: number[]
  /** The members nearest the centroid (ascending) — what the LLM is shown. */
  representativeIds: number[]
}

/**
 * How many clusters for `n` chunks: roughly one per `perCluster` chunks, clamped
 * to [min, max] and never more than `n`. The cap is the LLM budget — one
 * extraction call per cluster — so a 300-page book stays bounded.
 */
export function chooseK(
  n: number,
  opts: { perCluster?: number; min?: number; max?: number } = {}
): number {
  const perCluster = opts.perCluster ?? 8
  const min = opts.min ?? 4
  const max = opts.max ?? 24
  if (n <= 0) return 0
  const target = Math.ceil(n / perCluster)
  return Math.min(n, Math.max(min, Math.min(max, target)))
}

/** Squared Euclidean distance (no sqrt — only comparisons matter). */
function dist2(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    s += d * d
  }
  return s
}

/**
 * Cluster `points` into (at most) `k` groups. Returns a partition: every input
 * id appears in exactly one cluster's `memberIds`. `repCount` caps how many
 * centroid-nearest representatives each cluster reports.
 */
export function kmeans(
  points: Point[],
  k: number,
  opts: { maxIters?: number; repCount?: number } = {}
): Cluster[] {
  const maxIters = opts.maxIters ?? 20
  const repCount = opts.repCount ?? 4
  const pts = [...points].sort((a, b) => a.id - b.id)
  const n = pts.length
  if (n === 0 || k <= 0) return []
  const K = Math.min(k, n)
  const dim = pts[0].vec.length

  // --- Furthest-first (Gonzalez) seeding: c0 is the smallest id, then each new
  // centroid is the point furthest from all chosen ones (ties → smallest id). ---
  const centroids: Float32Array[] = [Float32Array.from(pts[0].vec)]
  const nearest = pts.map((p) => dist2(p.vec, centroids[0]))
  while (centroids.length < K) {
    let far = 0
    let farD = -1
    for (let i = 0; i < n; i++) {
      if (nearest[i] > farD) {
        farD = nearest[i]
        far = i
      }
    }
    const c = Float32Array.from(pts[far].vec)
    centroids.push(c)
    for (let i = 0; i < n; i++) nearest[i] = Math.min(nearest[i], dist2(pts[i].vec, c))
  }

  // --- Lloyd iterations: assign to nearest centroid, recompute centroid means,
  // re-seed any emptied cluster so K clusters stay alive. ---
  const assign = new Array<number>(n).fill(0)
  for (let it = 0; it < maxIters; it++) {
    let changed = false
    for (let i = 0; i < n; i++) {
      let best = 0
      let bestD = dist2(pts[i].vec, centroids[0])
      for (let c = 1; c < K; c++) {
        const d = dist2(pts[i].vec, centroids[c])
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
      if (best !== assign[i]) {
        assign[i] = best
        changed = true
      }
    }

    const sums = Array.from({ length: K }, () => new Float64Array(dim))
    const counts = new Array<number>(K).fill(0)
    for (let i = 0; i < n; i++) {
      counts[assign[i]]++
      const v = pts[i].vec
      const s = sums[assign[i]]
      for (let d = 0; d < dim; d++) s[d] += v[d]
    }
    for (let c = 0; c < K; c++) {
      if (counts[c] === 0) continue
      const cen = centroids[c]
      const s = sums[c]
      for (let d = 0; d < dim; d++) cen[d] = s[d] / counts[c]
    }
    // Empty cluster → re-seed to the worst-served point (furthest from its own
    // centroid). After stealing it, its distance to the new centroid is 0, so a
    // second empty cluster won't grab the same point. Deterministic, bounded.
    for (let c = 0; c < K; c++) {
      if (counts[c] > 0) continue
      let worst = 0
      let worstD = -1
      for (let i = 0; i < n; i++) {
        const d = dist2(pts[i].vec, centroids[assign[i]])
        if (d > worstD) {
          worstD = d
          worst = i
        }
      }
      centroids[c] = Float32Array.from(pts[worst].vec)
      assign[worst] = c
      changed = true
    }

    if (!changed) break
  }

  // --- Emit: members + the `repCount` members nearest each centroid. ---
  const vecById = new Map(pts.map((p) => [p.id, p.vec]))
  const members: number[][] = Array.from({ length: K }, () => [])
  for (let i = 0; i < n; i++) members[assign[i]].push(pts[i].id)

  const clusters: Cluster[] = []
  for (let c = 0; c < K; c++) {
    const ids = members[c]
    if (ids.length === 0) continue
    const representativeIds = [...ids]
      .map((id) => ({ id, d: dist2(vecById.get(id)!, centroids[c]) }))
      .sort((x, y) => (x.d !== y.d ? x.d - y.d : x.id - y.id))
      .slice(0, repCount)
      .map((r) => r.id)
      .sort((a, b) => a - b)
    clusters.push({ memberIds: [...ids].sort((a, b) => a - b), representativeIds })
  }
  // Stable order: by smallest member id.
  return clusters.sort((a, b) => a.memberIds[0] - b.memberIds[0])
}
