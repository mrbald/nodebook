import type { Point } from './layout'

/**
 * A focus-centric radial layout (TheBrain-style): the focus note sits at the
 * centre and the rest are ringed by their hop-distance from it. Pure and
 * deterministic (BFS order + id-sorted angles, no RNG), so it is golden-testable
 * and renders the same graph the same way every time. With no focus (the global
 * map) the highest-degree node anchors the centre; nodes with no path to the
 * centre land on an outer ring.
 */
export function radialLayout(
  nodes: { id: string; focus?: boolean }[],
  edges: { source: string; target: string }[],
  opts: { width?: number; height?: number } = {}
): Map<string, Point> {
  const W = opts.width ?? 800
  const H = opts.height ?? 600
  const cx = W / 2
  const cy = H / 2
  const pos = new Map<string, Point>()
  const n = nodes.length
  if (n === 0) return pos
  if (n === 1) {
    pos.set(nodes[0].id, { x: cx, y: cy })
    return pos
  }

  const ids = nodes.map((d) => d.id)
  const present = new Set(ids)
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const e of edges) {
    if (present.has(e.source) && present.has(e.target)) {
      adj.get(e.source)!.push(e.target)
      adj.get(e.target)!.push(e.source)
    }
  }

  // Centre: the focus note, else the highest-degree node (id-tiebroken).
  const center =
    nodes.find((d) => d.focus)?.id ??
    [...ids].sort((a, b) => adj.get(b)!.length - adj.get(a)!.length || a.localeCompare(b))[0]

  // BFS hop-distance from the centre.
  const dist = new Map<string, number>([[center, 0]])
  let frontier = [center]
  while (frontier.length) {
    const next: string[] = []
    for (const u of frontier) {
      for (const v of adj.get(u)!) {
        if (!dist.has(v)) {
          dist.set(v, dist.get(u)! + 1)
          next.push(v)
        }
      }
    }
    frontier = next
  }
  // Anything not reachable from the centre rings just beyond the connected part.
  const maxConnected = Math.max(0, ...[...dist.values()])
  for (const id of ids) if (!dist.has(id)) dist.set(id, maxConnected + 1)

  const rings = new Map<number, string[]>()
  for (const id of ids) {
    const d = dist.get(id)!
    const ring = rings.get(d)
    if (ring) ring.push(id)
    else rings.set(d, [id])
  }
  const maxRing = Math.max(...rings.keys())
  const ringGap = (Math.min(W, H) * 0.42) / Math.max(1, maxRing)

  for (const [d, ringIds] of rings) {
    if (d === 0) {
      pos.set(center, { x: cx, y: cy })
      continue
    }
    const sorted = [...ringIds].sort()
    const r = d * ringGap
    sorted.forEach((id, i) => {
      const a = (2 * Math.PI * i) / sorted.length - Math.PI / 2 // start at the top
      pos.set(id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r })
    })
  }
  return pos
}
