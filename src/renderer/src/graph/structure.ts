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
