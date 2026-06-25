/**
 * Automatic structure over a graph slice — pure and deterministic so it is
 * golden-tested and renders stably. `pageRank` gives "centres of gravity"
 * (importance via important inbound links → node size); `community` gives
 * clusters via deterministic label propagation (→ node colour). Both are O(n+e)
 * per iteration — fine for the slices the map shows; Louvain/Leiden is the noted
 * upgrade for the global view of large vaults.
 */

interface NodeLike {
  id: string
}
interface EdgeLike {
  source: string
  target: string
}

/** Directed PageRank (damping 0.85). Scores sum to ~1; hubs score highest. */
export function pageRank(
  nodes: NodeLike[],
  edges: EdgeLike[],
  opts: { damping?: number; iterations?: number } = {}
): Map<string, number> {
  const d = opts.damping ?? 0.85
  const iters = opts.iterations ?? 50
  const ids = nodes.map((n) => n.id)
  const n = ids.length
  if (n === 0) return new Map()
  const present = new Set(ids)
  const out = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const e of edges) {
    if (e.source !== e.target && present.has(e.source) && present.has(e.target)) {
      out.get(e.source)!.push(e.target)
    }
  }
  let pr = new Map<string, number>(ids.map((id) => [id, 1 / n]))
  for (let it = 0; it < iters; it++) {
    const next = new Map<string, number>(ids.map((id) => [id, (1 - d) / n]))
    let dangling = 0
    for (const id of ids) {
      const outs = out.get(id)!
      if (outs.length === 0) dangling += pr.get(id)!
      else {
        const share = (d * pr.get(id)!) / outs.length
        for (const t of outs) next.set(t, next.get(t)! + share)
      }
    }
    const danglingShare = (d * dangling) / n
    for (const id of ids) next.set(id, next.get(id)! + danglingShare)
    pr = next
  }
  return pr
}

/**
 * Community detection via deterministic label propagation. Each node adopts the
 * most common label among its (undirected) neighbours, processed in sorted order
 * with ties broken by smallest label, until stable. Returns a 0-based community
 * id per node.
 */
export function community(
  nodes: NodeLike[],
  edges: EdgeLike[],
  opts: { iterations?: number } = {}
): Map<string, number> {
  const iters = opts.iterations ?? 20
  const ids = nodes.map((n) => n.id)
  const present = new Set(ids)
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const e of edges) {
    if (e.source !== e.target && present.has(e.source) && present.has(e.target)) {
      adj.get(e.source)!.push(e.target)
      adj.get(e.target)!.push(e.source)
    }
  }
  const sorted = [...ids].sort()
  const label = new Map<string, string>(ids.map((id) => [id, id]))
  for (let it = 0; it < iters; it++) {
    let changed = false
    for (const id of sorted) {
      const neighbours = adj.get(id)!
      if (neighbours.length === 0) continue
      const counts = new Map<string, number>()
      for (const nb of neighbours) {
        const l = label.get(nb)!
        counts.set(l, (counts.get(l) ?? 0) + 1)
      }
      let best = label.get(id)!
      let bestCount = -1
      for (const [l, c] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (c > bestCount) {
          best = l
          bestCount = c
        }
      }
      if (best !== label.get(id)!) {
        label.set(id, best)
        changed = true
      }
    }
    if (!changed) break
  }
  // Renumber labels to 0-based ids, stable by first appearance in sorted order.
  const commId = new Map<string, number>()
  const result = new Map<string, number>()
  for (const id of sorted) {
    const l = label.get(id)!
    if (!commId.has(l)) commId.set(l, commId.size)
    result.set(id, commId.get(l)!)
  }
  return result
}

/**
 * Balanced minimum-cut bisection via Kernighan–Lin: split `ids` into two
 * roughly-equal halves minimising the number of edges that cross between them
 * (sizes differ by ≤ 1). Pure + deterministic — sorted-id initial split,
 * sorted iteration so the first max-gain pair (lexicographically smallest) wins
 * ties, no RNG — so it golden-tests and lays out the same graph identically each
 * time. Exact min-bisection is NP-hard; KL is the classic local-search
 * heuristic. Integer edge weights mean each applied pass lowers the cut by ≥ 1,
 * so it always converges.
 */
export function minCutBisect(ids: string[], edges: EdgeLike[]): [string[], string[]] {
  const sorted = [...ids].sort()
  const m = sorted.length
  if (m <= 1) return [sorted, []]

  const present = new Set(sorted)
  // Undirected adjacency weights among the given ids (parallel edges add up).
  const adj = new Map<string, Map<string, number>>(sorted.map((id) => [id, new Map()]))
  for (const e of edges) {
    if (e.source === e.target || !present.has(e.source) || !present.has(e.target)) continue
    const a = adj.get(e.source)!
    a.set(e.target, (a.get(e.target) ?? 0) + 1)
    const b = adj.get(e.target)!
    b.set(e.source, (b.get(e.source) ?? 0) + 1)
  }
  const w = (x: string, y: string): number => adj.get(x)?.get(y) ?? 0

  // Initial balanced partition by sorted id (0 = side A, 1 = side B).
  const half = Math.ceil(m / 2)
  const side = new Map<string, 0 | 1>()
  sorted.forEach((id, i) => side.set(id, i < half ? 0 : 1))

  for (;;) {
    // D[v] = external − internal edge weight for v's current side.
    const dsim = new Map<string, number>()
    for (const v of sorted) {
      let internal = 0
      let external = 0
      for (const [u, wt] of adj.get(v)!) {
        if (side.get(u) === side.get(v)) internal += wt
        else external += wt
      }
      dsim.set(v, external - internal)
    }

    const locked = new Set<string>()
    const swaps: { a: string; b: string; gain: number }[] = []
    const aPool = sorted.filter((id) => side.get(id) === 0)
    const bPool = sorted.filter((id) => side.get(id) === 1)
    const rounds = Math.min(aPool.length, bPool.length)

    for (let s = 0; s < rounds; s++) {
      // Best unlocked cross-pair by gain; sorted iteration → deterministic ties.
      let best: { a: string; b: string; gain: number } | null = null
      for (const a of aPool) {
        if (locked.has(a)) continue
        for (const b of bPool) {
          if (locked.has(b)) continue
          const gain = dsim.get(a)! + dsim.get(b)! - 2 * w(a, b)
          if (!best || gain > best.gain) best = { a, b, gain }
        }
      }
      if (!best) break
      locked.add(best.a)
      locked.add(best.b)
      swaps.push(best)
      // Update D for remaining unlocked nodes as if a↔b were swapped.
      for (const x of sorted) {
        if (locked.has(x)) continue
        const da = 2 * w(x, best.a)
        const db = 2 * w(x, best.b)
        dsim.set(x, dsim.get(x)! + (side.get(x) === 0 ? da - db : db - da))
      }
    }

    // Apply the swap prefix with the best cumulative gain (KL's hill-climb).
    let bestK = 0
    let bestSum = 0
    let sum = 0
    for (let k = 0; k < swaps.length; k++) {
      sum += swaps[k].gain
      if (sum > bestSum) {
        bestSum = sum
        bestK = k + 1
      }
    }
    if (bestSum <= 0) break // converged — no improving prefix
    for (let k = 0; k < bestK; k++) {
      side.set(swaps[k].a, 1)
      side.set(swaps[k].b, 0)
    }
  }

  return [sorted.filter((id) => side.get(id) === 0), sorted.filter((id) => side.get(id) === 1)]
}
